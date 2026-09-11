import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import { NativeIdentityRegistry, NativeStyleError, canonicalGlobal, canonicalStyleSelector, canonicalStyleWrappers, definitionSlotName, nativeProperty, nativeSlotUnit, nativeStaticValue, serializeNativeGlobal } from "@qstyle/core";
import { isExpression } from "@babel/types";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import valueParser from "postcss-value-parser";
import MagicString from "magic-string";

//#region src/parse.ts
function sourceSpan(file, node) {
	return {
		file,
		start: node.start ?? 0,
		end: node.end ?? node.start ?? 0
	};
}
/** Parsing never recovers to a partial AST: all syntax must be accounted for. */
function parseStyleModule(code, file) {
	let ast;
	try {
		ast = parse(code, {
			sourceType: "module",
			sourceFilename: file,
			plugins: /\.[jt]sx(?:$|\?)/.test(file) ? ["typescript", "jsx"] : ["typescript"],
			errorRecovery: false,
			createImportExpressions: true
		});
	} catch (error) {
		const details = error;
		throw new NativeStyleError({
			code: "QS1101",
			message: `Cannot parse style module: ${details.message}`,
			source: {
				file,
				start: details.pos ?? 0,
				end: (details.pos ?? 0) + 1
			}
		});
	}
	let program;
	traverse(ast, { Program(path) {
		program = path;
		path.stop();
	} });
	if (!program) throw new NativeStyleError({
		code: "QS1101",
		message: `No program in ${file}.`
	});
	return {
		file,
		code,
		ast,
		program
	};
}

//#endregion
//#region src/bindings.ts
/** Resolve lexical imports, including namespace access, without matching spelling alone. */
function resolveImportedBinding(path) {
	if (path.isIdentifier()) {
		const binding = path.scope.getBinding(path.node.name);
		if (!binding || !binding.path.parentPath?.isImportDeclaration()) return void 0;
		const source = binding.path.parentPath.node.source.value;
		if (binding.path.isImportSpecifier()) {
			const imported = binding.path.node.imported;
			return {
				source,
				imported: imported.type === "Identifier" ? imported.name : imported.value,
				binding
			};
		}
		if (binding.path.isImportDefaultSpecifier()) return {
			source,
			imported: "default",
			binding
		};
		if (binding.path.isImportNamespaceSpecifier()) return {
			source,
			imported: "*",
			binding
		};
	}
	if (path.isMemberExpression() && !path.node.computed) {
		const object = resolveImportedBinding(path.get("object"));
		if (object?.imported === "*" && path.node.property.type === "Identifier") return {
			...object,
			imported: path.node.property.name
		};
	}
}
function isCssMacro(path) {
	const imported = resolveImportedBinding(path);
	return imported?.source === "@qstyle/qwik" && imported.imported === "css";
}
function isQwikComponent(path) {
	const imported = resolveImportedBinding(path);
	return imported?.source === "@qwik.dev/core" && imported.imported === "component$";
}
function findComponentOwner(path, module) {
	for (let cursor = path; cursor; cursor = cursor.parentPath) {
		if (!cursor.isArrowFunctionExpression() && !cursor.isFunctionExpression()) continue;
		const parent = cursor.parentPath;
		if (parent?.isCallExpression() && isQwikComponent(parent.get("callee"))) {
			if (cursor.node.async || cursor.node.generator) throw new NativeStyleError({
				code: "QS1103",
				message: "A style owner must be a synchronous Qwik component callback.",
				source: sourceSpan(module.file, cursor.node)
			});
			return {
				id: `${module.file}#component:${parent.node.start}`,
				callback: cursor,
				source: sourceSpan(module.file, parent.node)
			};
		}
		if (parent?.isCallExpression()) {
			const callee = parent.get("callee");
			if (callee.isMemberExpression() && !callee.node.computed && callee.node.property.type === "Identifier" && callee.node.property.name === "map" && !cursor.node.async && !cursor.node.generator) continue;
		}
		throw new NativeStyleError({
			code: "QS1103",
			message: "Move styled JSX returned by an arbitrary function into an explicit component$ boundary.",
			source: sourceSpan(module.file, cursor.node)
		});
	}
	throw new NativeStyleError({
		code: "QS1103",
		message: "Styled JSX requires a component$ render owner.",
		source: sourceSpan(module.file, path.node)
	});
}
function collectCssPropSites(module) {
	const sites = [];
	module.program.traverse({ JSXAttribute(attribute) {
		if (attribute.node.name.type !== "JSXIdentifier" || attribute.node.name.name !== "css") return;
		const opening = attribute.parentPath;
		if (!opening.isJSXOpeningElement()) return;
		const tag = opening.node.name;
		if (tag.type !== "JSXIdentifier" || !/^[a-z]/.test(tag.name)) throw new NativeStyleError({
			code: "QS1103",
			message: "Apply css to a DOM element, not a component or Slot.",
			source: sourceSpan(module.file, opening.node)
		});
		const value = attribute.get("value");
		if (!value.isJSXExpressionContainer()) throw new NativeStyleError({
			code: "QS1102",
			message: "The css prop requires a style expression.",
			source: sourceSpan(module.file, attribute.node)
		});
		const expression = value.get("expression");
		if (!expression.isExpression()) throw new NativeStyleError({
			code: "QS1102",
			message: "The css prop cannot be empty.",
			source: sourceSpan(module.file, attribute.node)
		});
		sites.push({
			id: `${module.file}#css:${attribute.node.start}`,
			owner: findComponentOwner(attribute, module),
			attribute,
			opening,
			expression,
			source: sourceSpan(module.file, attribute.node)
		});
	} });
	return sites;
}
/** Compiler-only handles cannot escape into QRL captures or arbitrary runtime APIs. */
function validateAuthoringUses(module) {
	const checked = /* @__PURE__ */ new Set();
	const failUse = (path) => {
		throw new NativeStyleError({
			code: "QS1102",
			message: "A compile-time style handle escapes into runtime code.",
			source: sourceSpan(module.file, path.node),
			fixHint: "Use the handle directly in css or another static style composition."
		});
	};
	const acceptedContext = (reference) => {
		for (let path = reference; path; path = path.parentPath) {
			if (path.isJSXAttribute()) return path.node.name.type === "JSXIdentifier" && path.node.name.name === "css";
			if (path.isCallExpression()) return isCssMacro(path.get("callee"));
			if (path.isTaggedTemplateExpression()) return isCssMacro(path.get("tag"));
			if (path.isMemberExpression() || path.isObjectProperty() || path.isAssignmentExpression() || path.isUpdateExpression() || path.isFunction()) return false;
			if (path.isTSTypeQuery()) return true;
			if (path.isVariableDeclarator()) {
				if (path.node.id.type !== "Identifier") return false;
				const binding = path.scope.getBinding(path.node.id.name);
				if (!binding || binding.kind !== "const" || !binding.constant) return false;
				inspect(binding);
				return true;
			}
			if (path.isExportSpecifier() || path.isExportNamedDeclaration()) return module.file.endsWith(".qstyle.ts");
		}
		return false;
	};
	const inspect = (binding) => {
		if (checked.has(binding)) return;
		checked.add(binding);
		if (binding.kind !== "const" || !binding.constant) failUse(binding.path);
		if (binding.path.parentPath?.parentPath?.isExportNamedDeclaration() && !module.file.endsWith(".qstyle.ts")) failUse(binding.path);
		for (const reference of binding.referencePaths) if (!acceptedContext(reference)) failUse(reference);
	};
	const inspectMacro = (path) => {
		const parent = path.parentPath;
		if (parent?.isVariableDeclarator() && parent.node.id.type === "Identifier") {
			const binding = parent.scope.getBinding(parent.node.id.name);
			if (!binding) return failUse(path);
			inspect(binding);
		} else if (parent?.isExpressionStatement()) {} else if (!acceptedContext(parent ?? path)) failUse(path);
	};
	module.program.traverse({
		CallExpression(path) {
			if (isCssMacro(path.get("callee"))) inspectMacro(path);
		},
		TaggedTemplateExpression(path) {
			if (isCssMacro(path.get("tag"))) inspectMacro(path);
		}
	});
}

//#endregion
//#region src/evaluate.ts
const literal = (value) => ({
	kind: "literal",
	value
});
function isLiteral(value) {
	return value.kind === "literal";
}
function isStructural(value) {
	return value.kind === "object" || value.kind === "array";
}
function isRuntime(value) {
	return value.kind === "runtime";
}
function isTruthy(value) {
	if (isLiteral(value)) return Boolean(value.value);
	if (isStructural(value)) return value.effects.length === 0 ? true : void 0;
}
function propertyKey(value) {
	if (!isLiteral(value)) return void 0;
	if (typeof value.value === "symbol" || typeof value.value === "bigint") return void 0;
	return String(value.value);
}
function primitiveString(value) {
	if (!isLiteral(value)) return void 0;
	if (typeof value.value === "symbol" || typeof value.value === "bigint") return void 0;
	return String(value.value);
}
function effectsOf(value) {
	if (isRuntime(value)) return [value];
	if (isStructural(value)) return value.effects;
	return [];
}
function nodeRange(code, node) {
	const extra = node.extra;
	const start = extra?.parenthesized === true && extra.parenStart !== void 0 ? extra.parenStart : node.start ?? 0;
	let end = node.end ?? start;
	if (extra?.parenthesized === true) while (code[end] === ")") end += 1;
	return {
		start,
		end
	};
}
function isPropertyNameNode(node) {
	return node.type === "Identifier" || node.type === "StringLiteral" || node.type === "NumericLiteral";
}
function isExpressionPath(path) {
	return path.node !== null && isExpression(path.node);
}
function asNodePath(path) {
	return path;
}
/**
* Evaluate the small, side-effect-free subset needed by style declarations.
* Unknown expressions are retained as source-bearing runtime values; this
* evaluator never invokes user code or Babel's general-purpose evaluator.
*/
var StaticEvaluator = class {
	module;
	options;
	resolvingBindings = /* @__PURE__ */ new Set();
	resolvedImports = /* @__PURE__ */ new Map();
	constructor(module, options) {
		this.module = module;
		this.options = options;
	}
	evaluate(path) {
		return this.evaluateExpression(path);
	}
	runtime(path) {
		if (path.node === null || !isExpression(path.node)) {
			const source = path.node === null ? void 0 : sourceSpan(this.module.file, path.node);
			throw new NativeStyleError({
				code: "QS1102",
				message: "Expected an expression while preserving a runtime style value.",
				...source === void 0 ? {} : { source }
			});
		}
		const range = nodeRange(this.module.code, path.node);
		return {
			kind: "runtime",
			node: path.node,
			code: this.module.code.slice(range.start, range.end),
			source: sourceSpan(this.module.file, path.node)
		};
	}
	evaluateExpression(path) {
		const node = path.node;
		switch (node.type) {
			case "StringLiteral": return literal(node.value);
			case "NumericLiteral": return this.staticNumber(path, node.value);
			case "BooleanLiteral": return literal(node.value);
			case "NullLiteral": return literal(null);
			case "Identifier": return this.evaluateIdentifier(path);
			case "UnaryExpression": return this.evaluateUnary(path);
			case "BinaryExpression": return this.evaluateBinary(path);
			case "LogicalExpression": return this.evaluateLogical(path);
			case "ConditionalExpression": return this.evaluateConditional(path);
			case "TemplateLiteral": return this.evaluateTemplate(path);
			case "ArrayExpression": return this.evaluateArray(path);
			case "ObjectExpression": return this.evaluateObject(path);
			case "MemberExpression":
			case "OptionalMemberExpression": return this.evaluateMember(path);
			case "ParenthesizedExpression": return this.evaluateWrapped(path, "expression");
			case "TSAsExpression":
			case "TSSatisfiesExpression":
			case "TSTypeAssertion":
			case "TSNonNullExpression":
			case "TypeCastExpression": return this.evaluateWrapped(path, "expression");
			case "SequenceExpression": return this.evaluateSequence(path);
			default: return this.runtime(path);
		}
	}
	evaluateWrapped(path, key) {
		const child = this.child(path, key);
		return child !== void 0 && isExpressionPath(child) ? this.evaluateExpression(child) : this.runtime(path);
	}
	evaluateIdentifier(path) {
		const binding = path.scope.getBinding(path.node.name);
		if (binding === void 0) {
			if (path.node.name === "undefined") return literal(void 0);
			if (path.node.name === "NaN") return this.staticNumber(path, NaN);
			if (path.node.name === "Infinity") return this.staticNumber(path, Number.POSITIVE_INFINITY);
			return this.runtime(path);
		}
		if (!binding.constant || binding.kind !== "const" && binding.kind !== "module") return this.runtime(path);
		const declaration = binding.path.node;
		if (declaration.start != null && path.node.start != null && declaration.start > path.node.start) {
			if (this.referencesResolvingBinding(binding)) throw new NativeStyleError({
				code: "QS1102",
				message: `Cyclic static style binding involving ${JSON.stringify(path.node.name)}.`,
				source: sourceSpan(this.module.file, path.node)
			});
			return this.runtime(path);
		}
		if (binding.kind === "module" || declaration.type === "ImportSpecifier" || declaration.type === "ImportDefaultSpecifier" || declaration.type === "ImportNamespaceSpecifier") return this.evaluateImport(path, binding);
		if (declaration.type !== "VariableDeclarator") return this.runtime(path);
		if (this.resolvingBindings.has(binding)) throw new NativeStyleError({
			code: "QS1102",
			message: `Cyclic static style binding involving ${JSON.stringify(path.node.name)}.`,
			source: sourceSpan(this.module.file, path.node)
		});
		const initPath = this.child(binding.path, "init");
		if (initPath === void 0 || !isExpressionPath(initPath)) return this.runtime(path);
		this.resolvingBindings.add(binding);
		let resolved;
		try {
			resolved = this.evaluateExpression(initPath);
		} finally {
			this.resolvingBindings.delete(binding);
		}
		if (isRuntime(resolved) || isStructural(resolved) && resolved.effects.length !== 0 && !this.options.allowStoredStructuralValues) return this.runtime(path);
		if (isStructural(resolved) && (this.hasStructuralEscape(binding, path) || this.hasStructuralStorage(path, resolved))) return this.runtime(path);
		if (declaration.id.type === "Identifier") return resolved;
		const idPath = this.child(binding.path, "id");
		if (idPath === void 0) return this.runtime(path);
		const lookup = this.findPattern(idPath, binding.identifier);
		if (lookup === void 0) return this.runtime(path);
		return this.readPatternValue(resolved, lookup, path);
	}
	evaluateImport(path, binding) {
		const declaration = binding.path.parentPath?.node;
		if (declaration === void 0 || declaration.type !== "ImportDeclaration") return this.runtime(path);
		const specifier = binding.path.node;
		let imported;
		if (specifier.type === "ImportSpecifier") imported = typeof specifier.imported === "string" ? specifier.imported : specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
		else if (specifier.type === "ImportDefaultSpecifier") imported = "default";
		else if (specifier.type === "ImportNamespaceSpecifier") imported = "*";
		else return this.runtime(path);
		if (specifier.type === "ImportSpecifier" && specifier.importKind !== void 0 && specifier.importKind !== "value") return this.runtime(path);
		if (declaration.importKind !== void 0 && declaration.importKind !== "value") return this.runtime(path);
		const source = declaration.source.value;
		if (this.options.resolveImport === void 0) return this.runtime(path);
		const cacheKey = `${source}\u0000${imported}`;
		if (this.resolvedImports.has(cacheKey)) {
			const cached = this.resolvedImports.get(cacheKey);
			return cached === void 0 ? this.runtime(path) : cached;
		}
		const value = this.options.resolveImport(source, imported);
		this.resolvedImports.set(cacheKey, value);
		return value === void 0 ? this.runtime(path) : value;
	}
	staticNumber(path, value) {
		if (!Number.isFinite(value)) {
			const source = path.node === null ? void 0 : sourceSpan(this.module.file, path.node);
			throw new NativeStyleError({
				code: "QS1102",
				message: "A statically evaluated CSS number must be finite.",
				...source === void 0 ? {} : { source }
			});
		}
		return literal(value);
	}
	evaluateUnary(path) {
		if (path.node.operator === "delete") return this.runtime(path);
		const argument = this.child(path, "argument");
		if (argument === void 0 || !isExpressionPath(argument)) return this.runtime(path);
		const value = this.evaluateExpression(argument);
		if (!isLiteral(value)) return this.runtime(path);
		const operand = value.value;
		let result;
		switch (path.node.operator) {
			case "+":
				result = Number(operand);
				break;
			case "-":
				result = -Number(operand);
				break;
			case "!":
				result = !operand;
				break;
			case "~":
				result = ~Number(operand);
				break;
			case "typeof":
				result = typeof operand;
				break;
			case "void":
				result = void 0;
				break;
			default: return this.runtime(path);
		}
		return typeof result === "number" ? this.staticNumber(path, result) : literal(result);
	}
	evaluateBinary(path) {
		const leftPath = this.child(path, "left");
		const rightPath = this.child(path, "right");
		if (leftPath === void 0 || rightPath === void 0 || !isExpressionPath(leftPath) || !isExpressionPath(rightPath)) return this.runtime(path);
		const left = this.evaluateExpression(leftPath);
		const right = this.evaluateExpression(rightPath);
		if (!isLiteral(left) || !isLiteral(right)) return this.runtime(path);
		const a = left.value;
		const b = right.value;
		let result;
		try {
			switch (path.node.operator) {
				case "+":
					result = a + b;
					break;
				case "-":
					result = a - b;
					break;
				case "*":
					result = a * b;
					break;
				case "/":
					result = a / b;
					break;
				case "%":
					result = a % b;
					break;
				case "**":
					result = a ** b;
					break;
				case "<":
					result = a < b;
					break;
				case "<=":
					result = a <= b;
					break;
				case ">":
					result = a > b;
					break;
				case ">=":
					result = a >= b;
					break;
				case "==":
					result = a == b;
					break;
				case "!=":
					result = a != b;
					break;
				case "===":
					result = a === b;
					break;
				case "!==":
					result = a !== b;
					break;
				case "|":
					result = a | b;
					break;
				case "&":
					result = a & b;
					break;
				case "^":
					result = a ^ b;
					break;
				case "<<":
					result = a << b;
					break;
				case ">>":
					result = a >> b;
					break;
				case ">>>":
					result = a >>> b;
					break;
				default: return this.runtime(path);
			}
		} catch {
			return this.runtime(path);
		}
		return typeof result === "number" ? this.staticNumber(path, result) : literal(result);
	}
	evaluateLogical(path) {
		const leftPath = this.child(path, "left");
		const rightPath = this.child(path, "right");
		if (leftPath === void 0 || rightPath === void 0 || !isExpressionPath(leftPath) || !isExpressionPath(rightPath)) return this.runtime(path);
		const left = this.evaluateExpression(leftPath);
		const truthy = isTruthy(left);
		if (truthy === void 0 || isStructural(left) && left.effects.length !== 0) return this.runtime(path);
		if (!(path.node.operator === "&&" ? truthy : path.node.operator === "||" ? !truthy : isLiteral(left) && (left.value === null || left.value === void 0))) return left;
		const right = this.evaluateExpression(rightPath);
		return isRuntime(right) ? this.runtime(path) : right;
	}
	evaluateConditional(path) {
		const testPath = this.child(path, "test");
		const consequentPath = this.child(path, "consequent");
		const alternatePath = this.child(path, "alternate");
		if (testPath === void 0 || consequentPath === void 0 || alternatePath === void 0 || !isExpressionPath(testPath) || !isExpressionPath(consequentPath) || !isExpressionPath(alternatePath)) return this.runtime(path);
		const test = this.evaluateExpression(testPath);
		const truthy = isTruthy(test);
		if (truthy === void 0 || isStructural(test) && test.effects.length !== 0) return this.runtime(path);
		const selected = this.evaluateExpression(truthy ? consequentPath : alternatePath);
		return isRuntime(selected) ? this.runtime(path) : selected;
	}
	evaluateTemplate(path) {
		const expressions = path.get("expressions");
		const pieces = [];
		for (let index = 0; index < path.node.quasis.length; index += 1) {
			pieces.push(path.node.quasis[index]?.value.cooked ?? path.node.quasis[index]?.value.raw ?? "");
			const expression = expressions[index];
			if (expression === void 0) continue;
			if (!isExpressionPath(expression)) return this.runtime(path);
			const text = primitiveString(this.evaluateExpression(expression));
			if (text === void 0) return this.runtime(path);
			pieces.push(text);
		}
		return literal(pieces.join(""));
	}
	evaluateSequence(path) {
		const expressions = path.get("expressions");
		let result = literal(void 0);
		for (const expression of expressions) {
			if (!isExpressionPath(expression)) return this.runtime(path);
			result = this.evaluateExpression(expression);
			if (isRuntime(result) || isStructural(result) && result.effects.length !== 0) return this.runtime(path);
		}
		return result;
	}
	evaluateArray(path) {
		const elements = path.get("elements");
		const items = [];
		const effects = [];
		for (const element of elements) {
			if (element.node === null) {
				items.push(literal(void 0));
				continue;
			}
			if (element.node.type === "SpreadElement") {
				const argument = this.child(element, "argument");
				if (argument === void 0 || !isExpressionPath(argument)) return this.runtime(path);
				const spread = this.evaluateExpression(argument);
				if (isRuntime(spread)) return this.runtime(path);
				if (spread.kind === "array") {
					items.push(...spread.items);
					effects.push(...spread.effects);
					continue;
				}
				if (isLiteral(spread) && typeof spread.value === "string") {
					items.push(...Array.from(spread.value, (character) => literal(character)));
					continue;
				}
				return this.runtime(path);
			}
			if (!isExpressionPath(element)) return this.runtime(path);
			const value = this.evaluateExpression(element);
			items.push(value);
			effects.push(...effectsOf(value));
		}
		return {
			kind: "array",
			items,
			effects
		};
	}
	evaluateObject(path) {
		const entries = [];
		const positions = /* @__PURE__ */ new Map();
		const effects = [];
		const properties = path.get("properties");
		for (const property of properties) {
			if (property.node === null) return this.runtime(path);
			if (property.node.type === "SpreadElement") {
				const argument = this.child(property, "argument");
				if (argument === void 0 || !isExpressionPath(argument)) return this.runtime(path);
				const spread = this.evaluateExpression(argument);
				if (isRuntime(spread)) return this.runtime(path);
				effects.push(...effectsOf(spread));
				const spreadEntries = this.objectEntries(spread);
				if (spreadEntries === void 0) continue;
				for (const [key, value] of spreadEntries) this.setEntry(entries, positions, key, value);
				continue;
			}
			if (property.node.type !== "ObjectProperty") return this.runtime(path);
			const key = this.evaluateObjectKey(property);
			if (key === void 0) return this.runtime(path);
			const valuePath = this.child(property, "value");
			if (valuePath === void 0 || !isExpressionPath(valuePath)) return this.runtime(path);
			const value = this.evaluateExpression(valuePath);
			effects.push(...effectsOf(value));
			this.setEntry(entries, positions, key, value);
		}
		return {
			kind: "object",
			entries,
			effects
		};
	}
	evaluateObjectKey(property) {
		const node = property.node;
		if (node === null || node.type !== "ObjectProperty") return void 0;
		if (!node.computed) return isPropertyNameNode(node.key) ? node.key.type === "Identifier" ? node.key.name : String(node.key.value) : void 0;
		const keyPath = this.child(property, "key");
		if (keyPath === void 0 || !isExpressionPath(keyPath)) return void 0;
		return propertyKey(this.evaluateExpression(keyPath));
	}
	setEntry(entries, positions, key, value) {
		const position = positions.get(key);
		if (position === void 0) {
			positions.set(key, entries.length);
			entries.push([key, value]);
		} else entries[position] = [key, value];
	}
	objectEntries(value) {
		if (value.kind === "object") return value.entries;
		if (value.kind === "array") return value.items.map((item, index) => [String(index), item]);
		if (value.kind === "literal") {
			if (value.value === null || value.value === void 0 || typeof value.value !== "string") return [];
			return [...value.value].map((character, index) => [String(index), literal(character)]);
		}
	}
	evaluateMember(path) {
		const objectPath = this.child(path, "object");
		if (objectPath === void 0 || !isExpressionPath(objectPath)) return this.runtime(path);
		const object = this.evaluateExpression(objectPath);
		if (isRuntime(object)) return this.runtime(path);
		if (isStructural(object) && object.effects.length !== 0) return this.runtime(path);
		let key;
		if (path.node.computed) {
			const propertyPath = this.child(path, "property");
			if (propertyPath === void 0 || !isExpressionPath(propertyPath)) return this.runtime(path);
			key = propertyKey(this.evaluateExpression(propertyPath));
		} else {
			const property = path.node.property;
			key = property.type === "Identifier" ? property.name : void 0;
		}
		if (key === void 0) return this.runtime(path);
		return this.readMember(object, key, path);
	}
	readMember(object, key, path) {
		if (object.kind === "object") {
			const entry = object.entries.find(([entryKey]) => entryKey === key);
			if (entry !== void 0) return entry[1];
			if (key === "toString" || key === "constructor" || key === "__proto__") return this.runtime(path);
			return literal(void 0);
		}
		if (object.kind === "array") {
			if (key === "length") return literal(object.items.length);
			if (/^(?:0|[1-9][0-9]*)$/.test(key)) {
				const index = Number(key);
				return object.items[index] ?? literal(void 0);
			}
			return this.runtime(path);
		}
		if (object.kind !== "literal") return this.runtime(path);
		if (typeof object.value === "string") {
			if (key === "length") return literal(object.value.length);
			if (/^(?:0|[1-9][0-9]*)$/.test(key)) return literal(object.value[Number(key)]);
		}
		return this.runtime(path);
	}
	findPattern(path, target) {
		if (path.node === null) return void 0;
		switch (path.node.type) {
			case "Identifier": return path.node === target ? { segments: [] } : void 0;
			case "AssignmentPattern": {
				const left = this.child(path, "left");
				const result = left === void 0 ? void 0 : this.findPattern(left, target);
				if (result === void 0) return void 0;
				const right = this.child(path, "right");
				return right !== void 0 && isExpressionPath(right) ? {
					...result,
					defaultPath: right
				} : result;
			}
			case "ObjectPattern": {
				const properties = path.get("properties");
				for (const property of properties) {
					if (property.node?.type !== "ObjectProperty") continue;
					const key = this.evaluateObjectKey(property);
					if (key === void 0) continue;
					const value = this.child(property, "value");
					if (value === void 0) continue;
					const result = this.findPattern(value, target);
					if (result !== void 0) return {
						...result,
						segments: [["object", key], ...result.segments]
					};
				}
				return;
			}
			case "ArrayPattern": {
				const elements = path.get("elements");
				for (let index = 0; index < elements.length; index += 1) {
					const element = elements[index];
					if (element === void 0 || element.node === null || element.node.type === "RestElement") continue;
					const result = this.findPattern(element, target);
					if (result !== void 0) return {
						...result,
						segments: [["array", index], ...result.segments]
					};
				}
				return;
			}
			case "TSAsExpression":
			case "TSSatisfiesExpression":
			case "TSTypeAssertion":
			case "TSNonNullExpression": return this.findPattern(this.child(path, "expression") ?? path, target);
			default: return;
		}
	}
	readPatternValue(value, lookup, usePath) {
		if (isStructural(value) && value.effects.length !== 0) return this.runtime(usePath);
		let result = value;
		for (const segment of lookup.segments) {
			const [kind, key] = segment;
			if (kind === "object") {
				if (result.kind !== "object") return this.runtime(usePath);
				result = result.entries.find(([entryKey]) => entryKey === key)?.[1] ?? literal(void 0);
			} else {
				if (result.kind !== "array") return this.runtime(usePath);
				result = result.items[Number(key)] ?? literal(void 0);
			}
			if (isRuntime(result)) return this.runtime(usePath);
		}
		if (isLiteral(result) && result.value === void 0 && lookup.defaultPath !== void 0) return this.evaluateExpression(lookup.defaultPath);
		return result;
	}
	referencesResolvingBinding(binding) {
		for (const active of this.resolvingBindings) {
			const name = active.identifier.name;
			if (binding.referencePaths.some((reference) => reference.scope.getBinding(name) === active)) return true;
		}
		return false;
	}
	/**
	* `const` makes the binding immutable, but it does not freeze an object. A
	* structural constant is only safe to project when all other references are
	* reads or static spreads. Passing it to a call, assigning through it, or
	* storing it in another binding can change what a later member read observes.
	*/
	hasStructuralEscape(binding, current) {
		return binding.referencePaths.some((reference) => reference.node !== current.node && this.referenceEscapes(reference));
	}
	/**
	* A structural value read as another binding's initializer is an alias. A
	* const binding cannot freeze that object, so projecting the initializer at
	* a later style site could observe a mutation or a different alias. Member
	* reads that end in a primitive remain safe (`const color = palette.color`).
	*/
	hasStructuralStorage(path, resolved) {
		let value = resolved;
		let expression = path;
		while (true) {
			const parent = expression.parentPath;
			if (parent === null) break;
			if ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) && parent.node.object === expression.node) {
				const key = parent.node.computed ? (() => {
					const property = this.child(parent, "property");
					return property !== void 0 && isExpressionPath(property) ? propertyKey(this.evaluateExpression(property)) : void 0;
				})() : parent.node.property.type === "Identifier" ? parent.node.property.name : void 0;
				if (key === void 0) return false;
				value = this.readMember(value, key, parent);
				expression = parent;
				continue;
			}
			if (parent.isTSAsExpression() || parent.isTSSatisfiesExpression() || parent.isTSTypeAssertion() || parent.isTSNonNullExpression() || parent.isTypeCastExpression() || parent.isParenthesizedExpression()) {
				expression = parent;
				continue;
			}
			break;
		}
		if (!isStructural(value)) return false;
		const parent = expression.parentPath;
		if (parent?.isObjectProperty() && parent.node.value === expression.node) return true;
		if (parent?.isArrayExpression()) return true;
		return parent?.isVariableDeclarator() === true && parent.node.init === expression.node;
	}
	referenceEscapes(reference) {
		let parent = reference.parentPath;
		if (parent === null) return true;
		while (parent.isTSAsExpression() || parent.isTSSatisfiesExpression() || parent.isTSTypeAssertion() || parent.isTSNonNullExpression() || parent.isTypeCastExpression()) {
			parent = parent.parentPath;
			if (parent === null) return true;
		}
		if (parent.isSpreadElement() && parent.node.argument === reference.node) {
			const container = parent.parentPath?.node;
			return container?.type !== "ObjectExpression" && container?.type !== "ArrayExpression";
		}
		if (parent.isConditionalExpression() && parent.node.test === reference.node) return false;
		if (parent.isLogicalExpression() && parent.node.left === reference.node) return false;
		if (parent.isUnaryExpression() && parent.node.argument === reference.node && (parent.node.operator === "!" || parent.node.operator === "typeof" || parent.node.operator === "void")) return false;
		if ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) && parent.node.object === reference.node) {
			let expression = parent;
			let outer = expression.parentPath;
			while (outer !== null && (outer.isMemberExpression() || outer.isOptionalMemberExpression()) && outer.node.object === expression.node) {
				expression = outer;
				outer = outer.parentPath;
			}
			if (outer === null) return false;
			if (outer.isAssignmentExpression() && outer.node.left === expression.node) return true;
			if (outer.isUpdateExpression()) return true;
			if (outer.isUnaryExpression() && outer.node.operator === "delete") return true;
			if (outer.isCallExpression() || outer.isOptionalCallExpression() || outer.isNewExpression() || outer.isTaggedTemplateExpression()) return true;
			if (outer.isObjectProperty() && outer.node.value === expression.node) return true;
			if (outer.isArrayExpression()) return true;
			return false;
		}
		return true;
	}
	child(path, key) {
		if (path.node === null) return void 0;
		const child = asNodePath(path).get(key);
		return Array.isArray(child) ? void 0 : child;
	}
};
/** Evaluate a style expression without executing arbitrary JavaScript. */
function evaluateStatic(path, module, options = {}) {
	const program = module.program;
	if (program.scope.crawling === false) program.scope.crawl();
	return new StaticEvaluator(module, options).evaluate(path);
}

//#endregion
//#region src/css.ts
/** Decoded fixed class names, counted independently of declaration/rule count. */
function selectorClassNames(selector) {
	const names = /* @__PURE__ */ new Set();
	const text = selector.alternatives.map((parts) => parts.map((part) => part.kind === "text" ? part.text : "&").join("")).join(",");
	selectorParser().astSync(text).walkClasses((node) => {
		names.add(node.value);
	});
	return [...names].sort();
}
const SUBJECT_SELECTOR = Object.freeze({ alternatives: Object.freeze([Object.freeze([{ kind: "subject" }])]) });
const KEYFRAME_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const LAYER_NAME = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/;
function sourceSpan$1(context, node, fallbackIndex = 0) {
	const start = node.source?.start?.offset ?? fallbackIndex;
	const end = node.source?.end?.offset ?? start + 1;
	const absoluteStart = context.offset + start;
	const absoluteEnd = context.offset + Math.max(end, start + 1);
	return {
		file: context.file,
		start: absoluteStart,
		end: absoluteEnd
	};
}
function offsetSpan(context, index, width = 1) {
	const start = context.offset + Math.max(0, Math.min(index, context.length));
	return {
		file: context.file,
		start,
		end: start + Math.max(1, width)
	};
}
function syntaxError(context, message, node, index) {
	throw new NativeStyleError({
		code: "QS1101",
		message,
		source: node === void 0 ? offsetSpan(context, index ?? 0) : sourceSpan$1(context, node, index ?? 0)
	});
}
function rethrowWithSource(error, context, node, message) {
	if (error instanceof NativeStyleError) throw new NativeStyleError({
		...error.diagnostic,
		source: error.diagnostic.source ?? sourceSpan$1(context, node)
	});
	syntaxError(context, message ?? (error instanceof Error ? error.message : String(error)), node);
}
function validateValueSyntax(context, value, node, label) {
	if (value.trim().length === 0) syntaxError(context, `${label} cannot be empty.`, node);
	try {
		const parsed = valueParser(value);
		let malformed = false;
		parsed.walk((token) => {
			if ("unclosed" in token && token.unclosed === true) malformed = true;
		});
		if (malformed) syntaxError(context, `Malformed ${label}.`, node);
	} catch (error) {
		if (error instanceof NativeStyleError) throw error;
		rethrowWithSource(error, context, node, `Malformed ${label}.`);
	}
}
function parseDeclaration(context, node, label) {
	if (node.value.trim().length === 0) syntaxError(context, `${label} has an empty value.`, node);
	let property;
	try {
		property = nativeProperty(node.prop);
	} catch (error) {
		rethrowWithSource(error, context, node, `Invalid CSS property ${JSON.stringify(node.prop)}.`);
	}
	const value = node.raws.value?.raw ?? node.value;
	validateValueSyntax(context, value, node, `${label} value`);
	return {
		property,
		value: {
			kind: "static",
			css: value
		},
		important: node.important === true
	};
}
function parseSelector(context, text, node) {
	let root;
	try {
		root = selectorParser().astSync(text, { lossless: true });
	} catch (error) {
		rethrowWithSource(error, context, node, "Malformed nested selector.");
	}
	if (root.trailingComma === true) syntaxError(context, "A nested selector cannot end with a comma.", node);
	if (root.nodes.length === 0) syntaxError(context, "A nested selector cannot be empty.", node);
	const alternatives = [];
	for (const selector of root.nodes) {
		const serialized = selector.toString();
		if (selector.nodes.length === 0 || serialized.trim().length === 0) syntaxError(context, "A nested selector cannot contain an empty alternative.", node);
		const nestingOffsets = [];
		selector.walkNesting((nesting) => {
			const local = nesting.sourceIndex - selector.sourceIndex;
			if (local >= 0 && local < serialized.length) nestingOffsets.push(local);
		});
		if (nestingOffsets.length === 0) syntaxError(context, "Nested selector structure must contain a structural &.", node);
		nestingOffsets.sort((a, b) => a - b);
		const parts = [];
		let cursor = 0;
		for (const offset of nestingOffsets) {
			if (offset < cursor) continue;
			if (offset > cursor) parts.push({
				kind: "text",
				text: serialized.slice(cursor, offset)
			});
			parts.push({ kind: "subject" });
			cursor = offset + 1;
		}
		if (cursor < serialized.length) parts.push({
			kind: "text",
			text: serialized.slice(cursor)
		});
		alternatives.push(parts);
	}
	return { alternatives };
}
function selectorText(node) {
	return node.raws.selector?.raw ?? node.selector;
}
/** Replace every structural child `&` with a parent alternative. */
function composeSelector(parent, child) {
	const alternatives = [];
	for (const childAlternative of child.alternatives) {
		let variants = [[]];
		for (const part of childAlternative) {
			if (part.kind === "text") {
				for (const variant of variants) variant.push(part);
				continue;
			}
			const next = [];
			for (const variant of variants) for (const parentAlternative of parent.alternatives) next.push([...variant, ...parentAlternative]);
			variants = next;
		}
		alternatives.push(...variants);
	}
	return { alternatives };
}
function groupSource(context, declarations) {
	const first = declarations[0];
	const last = declarations[declarations.length - 1];
	if (first === void 0 || last === void 0) return void 0;
	const start = first.source?.start?.offset ?? 0;
	const end = last.source?.end?.offset ?? start + 1;
	return {
		file: context.file,
		start: context.offset + start,
		end: context.offset + Math.max(end, start + 1)
	};
}
function buildRule(context, selector, wrappers, declarations) {
	const source = groupSource(context, declarations);
	return {
		selector,
		wrappers: [...wrappers],
		declarations: declarations.map((declaration) => parseDeclaration(context, declaration, "Style declaration")),
		dependencies: [],
		...source === void 0 ? {} : { source }
	};
}
function isLayerName(context, params, node) {
	const name = params.trim();
	return name.length > 0 && LAYER_NAME.test(name);
}
function rawAtRuleParams(node) {
	return node.raws.params?.raw ?? node.params;
}
function parseWrapper(context, node) {
	const kind = node.name.toLowerCase();
	const params = rawAtRuleParams(node).trim();
	if (kind === "layer") {
		if (!isLayerName(context, params, node)) syntaxError(context, "Only named @layer blocks are supported.", node);
		return {
			kind: "layer",
			name: params
		};
	}
	if (params.length === 0) syntaxError(context, `@${kind} requires a condition.`, node);
	validateValueSyntax(context, params, node, `@${kind} condition`);
	if (kind === "media" || kind === "supports" || kind === "container") return {
		kind,
		params
	};
	syntaxError(context, `Unsupported at-rule @${node.name}.`, node);
}
function parseKeyframeName(context, node) {
	const name = rawAtRuleParams(node).trim();
	validateValueSyntax(context, name, node, "@keyframes name");
	if (!KEYFRAME_NAME.test(name)) syntaxError(context, "@keyframes requires one identifier name.", node);
	return name;
}
function validFrameSelector(context, selector, node) {
	validateValueSyntax(context, selector, node, "keyframe selector");
	const parts = selector.split(",");
	if (parts.length === 0 || parts.some((part) => {
		const value = part.trim();
		return !/^(?:from|to|\d+(?:\.\d+)?%)$/i.test(value);
	})) syntaxError(context, `Unsupported keyframe selector ${JSON.stringify(selector)}.`, node);
	return selector.trim();
}
function parseKeyframes(context, node, wrappers = []) {
	const sourceName = parseKeyframeName(context, node);
	if (node.nodes === void 0 || node.nodes.length === 0) syntaxError(context, "@keyframes cannot be empty.", node);
	const frames = [];
	for (const child of node.nodes) {
		if (child.type === "comment") continue;
		if (child.type !== "rule") syntaxError(context, "@keyframes may contain only frame rules.", child);
		const frame = child;
		const declarations = [];
		for (const frameChild of frame.nodes ?? []) {
			if (frameChild.type === "comment") continue;
			if (frameChild.type !== "decl") syntaxError(context, "Keyframe frames may contain only declarations.", frameChild);
			declarations.push(frameChild);
		}
		if (declarations.length === 0) syntaxError(context, "A keyframe frame cannot be empty.", frame);
		frames.push({
			selector: validFrameSelector(context, frame.selector, frame),
			declarations: declarations.map((declaration) => parseDeclaration(context, declaration, "Keyframe declaration"))
		});
	}
	if (frames.length === 0) syntaxError(context, "@keyframes cannot be empty.", node);
	return {
		kind: "keyframes",
		sourceName,
		frames,
		...wrappers.length > 0 ? { wrappers: [...wrappers] } : {},
		source: sourceSpan$1(context, node)
	};
}
function parseGlobal(context, node, wrappers = []) {
	const kind = node.name.toLowerCase();
	if (node.nodes === void 0 || node.nodes.length === 0) syntaxError(context, `@${node.name} cannot be empty.`, node);
	if (kind === "keyframes") return parseKeyframes(context, node, wrappers);
	if (kind !== "font-face" && kind !== "property") syntaxError(context, `Unsupported at-rule @${node.name}.`, node);
	let name = "";
	if (kind === "property") {
		const params = rawAtRuleParams(node).trim();
		if (params.length === 0) syntaxError(context, "@property requires a custom property name.", node);
		try {
			name = nativeProperty(params);
		} catch (error) {
			rethrowWithSource(error, context, node, "Invalid @property custom property name.");
		}
		if (!name.startsWith("--")) syntaxError(context, "@property requires a custom property name.", node);
	} else if (rawAtRuleParams(node).trim().length !== 0) syntaxError(context, "@font-face does not accept a prelude.", node);
	const declarations = [];
	for (const child of node.nodes) {
		if (child.type === "comment") continue;
		if (child.type !== "decl") syntaxError(context, `@${kind} may contain only declarations.`, child);
		declarations.push(child);
	}
	if (declarations.length === 0) syntaxError(context, `@${kind} cannot be empty.`, node);
	return {
		kind,
		name,
		declarations: declarations.map((declaration) => parseDeclaration(context, declaration, `@${kind} declaration`)),
		...wrappers.length > 0 ? { wrappers: [...wrappers] } : {},
		source: sourceSpan$1(context, node)
	};
}
function walkContainer(context, nodes, state, rules, globals) {
	let declarations = [];
	const flush = () => {
		if (declarations.length > 0) {
			rules.push(buildRule(context, state.selector, state.wrappers, declarations));
			declarations = [];
		}
	};
	for (const child of nodes) {
		if (child.type === "comment") continue;
		if (child.type === "decl") {
			declarations.push(child);
			continue;
		}
		flush();
		if (child.type === "rule") {
			const nested = child;
			const parsed = parseSelector(context, selectorText(nested), nested);
			walkContainer(context, nested.nodes ?? [], {
				selector: composeSelector(state.selector, parsed),
				wrappers: state.wrappers,
				rootScope: false
			}, rules, globals);
			continue;
		}
		if (child.type === "atrule") {
			const atRule = child;
			const name = atRule.name.toLowerCase();
			if (name === "import" || name === "scope") syntaxError(context, `Unsupported at-rule @${atRule.name}.`, atRule);
			if (name === "font-face" || name === "property" || name === "keyframes") {
				if (!state.rootScope || state.selector !== SUBJECT_SELECTOR) syntaxError(context, `@${atRule.name} is only supported at the style root or a stylesheet wrapper.`, atRule);
				globals.push(parseGlobal(context, atRule, state.wrappers));
				continue;
			}
			if (name === "media" || name === "supports" || name === "container" || name === "layer") {
				if (atRule.nodes === void 0) syntaxError(context, `@${atRule.name} requires a block.`, atRule);
				const wrapper = parseWrapper(context, atRule);
				walkContainer(context, atRule.nodes, {
					selector: state.selector,
					wrappers: [...state.wrappers, wrapper],
					rootScope: state.rootScope
				}, rules, globals);
				continue;
			}
			syntaxError(context, `Unsupported at-rule @${atRule.name}.`, atRule);
		}
		syntaxError(context, "Unsupported CSS node.", child);
	}
	flush();
}
/**
* Parse a declaration/nesting CSS body for one local style handle.
* Top-level declarations use an implicit `&` subject; all explicit nested
* selectors must contain structural ampersands and are flattened into IR.
*/
function parseStyleCss(text, options = {}) {
	const context = {
		file: options.file ?? "<inline>",
		offset: options.offset ?? 0,
		length: text.length
	};
	let root;
	try {
		root = postcss.parse(text, { from: context.file });
	} catch (error) {
		const details = error;
		const index = details.input?.offset ?? 0;
		syntaxError(context, `Cannot parse CSS: ${details.reason ?? details.message}`, void 0, index);
	}
	const rules = [];
	const globals = [];
	walkContainer(context, root.nodes, {
		selector: SUBJECT_SELECTOR,
		wrappers: [],
		rootScope: true
	}, rules, globals);
	return {
		rules,
		globals
	};
}

//#endregion
//#region src/lower.ts
/** Read an already evaluated spread object instead of replaying its initializer. */
function lowerStoredStyleExpression(path, module, stored) {
	const snapshot = (value, access) => {
		if (value.kind === "literal") return value;
		if (value.kind === "runtime") return {
			...value,
			code: access
		};
		if (value.kind === "array") return {
			...value,
			effects: [],
			items: value.items.map((item, index) => snapshot(item, `${access}[${index}]`))
		};
		return {
			...value,
			effects: [],
			entries: value.entries.map(([key, item]) => [key, snapshot(item, `${access}[${JSON.stringify(key)}]`)])
		};
	};
	const lower = (value) => {
		if (value.kind === "literal" && (value.value == null || typeof value.value === "boolean")) return EMPTY_STYLE;
		if (value.kind === "array") return {
			kind: "sequence",
			items: value.items.map(lower)
		};
		if (value.kind === "object") return {
			kind: "style",
			value: lowerObject(value, module, path.node)
		};
		return fail$1(module, path.node, "Stored spread CSS must have a statically known object or array shape.");
	};
	return lower(snapshot(evaluateStatic(path, module), stored));
}
const EMPTY_STYLE = Object.freeze({
	kind: "sequence",
	items: Object.freeze([])
});
/**
* Identify an initializer that is made out of compiler-owned style handles.
*
* `evaluateStatic` deliberately treats a css macro call as a runtime
* expression because it must never execute calls.  A reusable handle still
* needs to recurse through that call, so identifier lowering uses this small
* syntax check to distinguish an opaque compiler handle from an unsafe raw
* object alias.  The evaluator remains the authority for all structural
* const safety checks.
*/
function hasStyleHandleSource(path, seen = /* @__PURE__ */ new Set()) {
	if (path.isTSAsExpression() || path.isTSSatisfiesExpression() || path.isTSNonNullExpression() || path.isTSTypeAssertion() || path.isTypeCastExpression() || path.isParenthesizedExpression()) {
		const expression = path.get("expression");
		return expression.isExpression() && hasStyleHandleSource(expression, seen);
	}
	if (path.isCallExpression() && isCssMacro(path.get("callee"))) return true;
	if (path.isTaggedTemplateExpression() && isCssMacro(path.get("tag"))) return true;
	if (path.isArrayExpression()) return path.get("elements").some((item) => {
		if (!item.node) return false;
		const expression = item.isSpreadElement() ? item.get("argument") : item;
		return expression.isExpression() && hasStyleHandleSource(expression, seen);
	});
	if (path.isConditionalExpression()) {
		const consequent = path.get("consequent");
		const alternate = path.get("alternate");
		return consequent.isExpression() && hasStyleHandleSource(consequent, seen) || alternate.isExpression() && hasStyleHandleSource(alternate, seen);
	}
	if (path.isLogicalExpression()) {
		const left = path.get("left");
		const right = path.get("right");
		return left.isExpression() && hasStyleHandleSource(left, seen) || right.isExpression() && hasStyleHandleSource(right, seen);
	}
	if (!path.isIdentifier()) return false;
	const binding = path.scope.getBinding(path.node.name);
	if (!binding) return false;
	if (binding.path.isImportSpecifier() || binding.path.isImportDefaultSpecifier() || binding.path.isImportNamespaceSpecifier()) return true;
	if (binding.kind !== "const" || !binding.constant || !binding.path.isVariableDeclarator() || seen.has(binding)) return false;
	const init = binding.path.get("init");
	if (!init.isExpression()) return false;
	const next = new Set(seen);
	next.add(binding);
	return hasStyleHandleSource(init, next);
}
function fail$1(module, node, message) {
	throw new NativeStyleError({
		code: "QS1102",
		message,
		source: sourceSpan(module.file, node)
	});
}
function runtime(path, module) {
	return {
		kind: "runtime",
		node: path.node,
		code: module.code.slice(path.node.start ?? 0, path.node.end ?? 0),
		source: sourceSpan(module.file, path.node)
	};
}
function finishCss(css, inputs, placeholders, module, node, staticNumbers = /* @__PURE__ */ new Map()) {
	const hasToken = (text) => [...placeholders.keys()].some((token) => text.includes(token));
	if (placeholders.size || staticNumbers.size) {
		let syntax;
		try {
			syntax = postcss.parse(css);
		} catch (error) {
			throw new NativeStyleError({
				code: "QS1101",
				message: `Malformed template CSS: ${String(error)}`,
				source: sourceSpan(module.file, node)
			});
		}
		syntax.walk((entry) => {
			if (entry.type === "rule" && hasToken(entry.selector) || entry.type === "atrule" && hasToken(`${entry.name} ${entry.params}`) || entry.type === "decl" && hasToken(entry.prop)) fail$1(module, node, "Runtime selector, property, and at-rule structure is not supported.");
			const replaceNumbers = (text) => {
				for (const [token, value] of staticNumbers) text = text.split(token).join(String(value));
				return text;
			};
			if (entry.type === "decl") {
				const number = staticNumbers.get(entry.value);
				if (number !== void 0) {
					const formatted = nativeStaticValue(entry.prop, number);
					if (formatted.kind === "static") entry.value = formatted.css;
				} else entry.value = replaceNumbers(entry.value);
			} else if (entry.type === "rule") entry.selector = replaceNumbers(entry.selector);
			else if (entry.type === "atrule") entry.params = replaceNumbers(entry.params);
		});
		css = syntax.toString();
	}
	const parsed = parseStyleCss(css, {
		file: module.file,
		offset: node.start ?? 0
	});
	const bindings = [];
	let slotIndex = 0;
	const splitValue = (text) => {
		const parts = [];
		let cursor = 0;
		while (cursor < text.length) {
			let next = -1;
			let matched;
			for (const token of placeholders.keys()) {
				const at = text.indexOf(token, cursor);
				if (at >= 0 && (next < 0 || at < next)) {
					next = at;
					matched = token;
				}
			}
			if (matched === void 0) {
				parts.push(text.slice(cursor));
				break;
			}
			if (next > cursor) parts.push(text.slice(cursor, next));
			parts.push({ input: placeholders.get(matched) });
			cursor = next + matched.length;
		}
		return parts;
	};
	const rules = parsed.rules.map((rule) => {
		if (hasToken(JSON.stringify([rule.selector, rule.wrappers]))) fail$1(module, node, "Runtime selector and at-rule structure is not supported.");
		const declarations = rule.declarations.map((declaration) => {
			if (hasToken(declaration.property)) fail$1(module, node, "Runtime CSS property names are not supported.");
			if (declaration.value.kind !== "static" || !hasToken(declaration.value.css)) return declaration;
			const parts = splitValue(declaration.value.css);
			const pureInput = parts.length === 1 && typeof parts[0] !== "string";
			const lowered = {
				...declaration,
				value: {
					kind: "slot",
					index: slotIndex++,
					unit: pureInput ? nativeSlotUnit(declaration.property) : "raw"
				}
			};
			bindings.push({
				definition: {
					selector: rule.selector,
					wrappers: rule.wrappers,
					declaration: lowered,
					dependencies: rule.dependencies
				},
				parts
			});
			return lowered;
		});
		return {
			...rule,
			declarations
		};
	});
	if (parsed.globals.some((global) => hasToken(JSON.stringify(global)))) fail$1(module, node, "Global styles and keyframes must be static.");
	return {
		rules,
		globals: parsed.globals,
		inputs,
		bindings
	};
}
function inputCollector(module) {
	let prefix = "__qstyle_input_";
	while (module.code.includes(prefix)) prefix += "_";
	const inputs = [];
	const placeholders = /* @__PURE__ */ new Map();
	const indexes = /* @__PURE__ */ new Map();
	const register = (expression) => {
		let index = indexes.get(expression.node);
		if (index === void 0) {
			index = inputs.length;
			indexes.set(expression.node, index);
			inputs.push(expression);
		}
		const token = `${prefix}${index}__`;
		placeholders.set(token, index);
		return token;
	};
	return {
		inputs,
		placeholders,
		register
	};
}
function lowerObject(value, module, node) {
	const collector = inputCollector(module);
	const serializeObject = (object) => {
		if (object.kind !== "object") fail$1(module, node, "A style structure must be a statically known object.");
		for (const effect of object.effects) collector.register(effect);
		let css = "";
		for (const [key, entry] of object.entries) {
			if (entry.kind === "literal" && (entry.value == null || typeof entry.value === "boolean")) continue;
			if (entry.kind === "object") {
				css += `${key}{${serializeObject(entry)}}`;
				continue;
			}
			if (key.startsWith("@") || key.includes("&")) fail$1(module, node, "Nested style structure must be static.");
			const property = nativeProperty(key);
			if (entry.kind === "runtime") {
				css += `${property}:${collector.register(entry)};`;
				continue;
			}
			if (entry.kind !== "literal" || typeof entry.value !== "string" && typeof entry.value !== "number") fail$1(module, node, `Unsupported value for ${property}.`);
			const staticValue = nativeStaticValue(property, entry.value);
			if (staticValue.kind === "static") {
				let parsedValue;
				try {
					parsedValue = postcss.parse(`&{${property}:${staticValue.css};}`);
				} catch {
					fail$1(module, node, `Malformed object value for ${property}.`);
				}
				const rule = parsedValue.first;
				const parsed = rule?.type === "rule" ? rule.first : void 0;
				if (parsedValue.nodes.length !== 1 || rule?.type !== "rule" || rule.nodes.length !== 1 || parsed?.type !== "decl" || parsed.prop !== property) fail$1(module, node, `Object value for ${property} must contain exactly one declaration value.`);
				if ((parsed.raws.value?.raw ?? parsed.value) + (parsed.important ? parsed.raws.important ?? " !important" : "") !== staticValue.css) fail$1(module, node, `Object value for ${property} contains trailing CSS syntax.`);
			}
			css += `${property}:${staticValue.kind === "static" ? staticValue.css : ""};`;
		}
		return css;
	};
	return finishCss(serializeObject(value), collector.inputs, collector.placeholders, module, node);
}
function lowerTemplate(path, module) {
	const collector = inputCollector(module);
	const staticNumbers = /* @__PURE__ */ new Map();
	let numberPrefix = "__qstyle_number_";
	while (module.code.includes(numberPrefix)) numberPrefix += "_";
	const quasi = path.get("quasi");
	const expressions = quasi.get("expressions");
	let css = "";
	for (let index = 0; index < quasi.node.quasis.length; index++) {
		css += quasi.node.quasis[index].value.cooked ?? quasi.node.quasis[index].value.raw;
		const expression = expressions[index];
		if (!expression) continue;
		if (!expression.isExpression()) fail$1(module, expression.node, "Template styles require value expressions.");
		const evaluated = evaluateStatic(expression, module);
		if (evaluated.kind === "literal" && typeof evaluated.value === "number") {
			if (!Number.isFinite(evaluated.value)) fail$1(module, expression.node, "A static CSS number must be finite.");
			const token = `${numberPrefix}${staticNumbers.size}__`;
			staticNumbers.set(token, evaluated.value);
			css += token;
		} else if (evaluated.kind === "literal" && typeof evaluated.value === "string") css += evaluated.value;
		else if (evaluated.kind === "runtime") css += collector.register(evaluated);
		else fail$1(module, expression.node, "Template interpolation must be a string or number value.");
	}
	return finishCss(css, collector.inputs, collector.placeholders, module, path.node, staticNumbers);
}
/** Resolve finite shape choices without executing application code during the build. */
function lowerStyleExpression(path, module, options = {}) {
	const visiting = /* @__PURE__ */ new Set();
	const lower = (current) => {
		if (visiting.has(current.node)) fail$1(module, current.node, "Cyclic style handle reference.");
		visiting.add(current.node);
		try {
			if (current.isTSAsExpression() || current.isTSSatisfiesExpression() || current.isTSNonNullExpression()) return lower(current.get("expression"));
			if (current.isCallExpression() && isCssMacro(current.get("callee"))) {
				const args = current.get("arguments");
				if (args.length !== 1 || !args[0].isExpression()) fail$1(module, current.node, "css() requires one statically shaped style argument.");
				return lower(args[0]);
			}
			if (current.isTaggedTemplateExpression() && isCssMacro(current.get("tag"))) return {
				kind: "style",
				value: lowerTemplate(current, module)
			};
			if (current.isArrayExpression()) {
				const items = [];
				for (const item of current.get("elements")) {
					if (!item.node) continue;
					if (item.isSpreadElement()) {
						const spread = lower(item.get("argument"));
						if (spread.kind !== "sequence") fail$1(module, item.node, "Style array spreads must resolve to a static array.");
						items.push(...spread.items);
					} else if (item.isExpression()) items.push(lower(item));
					else fail$1(module, current.node, "Unsupported style array item.");
				}
				return {
					kind: "sequence",
					items
				};
			}
			if (current.isConditionalExpression()) {
				const test = current.get("test");
				const evaluated = evaluateStatic(test, module);
				if (evaluated.kind === "literal") return lower(evaluated.value ? current.get("consequent") : current.get("alternate"));
				return {
					kind: "choice",
					test: runtime(test, module),
					consequent: lower(current.get("consequent")),
					alternate: lower(current.get("alternate"))
				};
			}
			if (current.isLogicalExpression() && current.node.operator === "&&") {
				const test = current.get("left");
				const evaluated = evaluateStatic(test, module);
				if (evaluated.kind === "literal") return evaluated.value ? lower(current.get("right")) : EMPTY_STYLE;
				return {
					kind: "choice",
					test: runtime(test, module),
					consequent: lower(current.get("right")),
					alternate: EMPTY_STYLE
				};
			}
			if (current.isIdentifier()) {
				const binding = current.scope.getBinding(current.node.name);
				if (binding?.kind === "const" && binding.constant && binding.path.isVariableDeclarator()) {
					const init = binding.path.get("init");
					if (init.isExpression()) {
						if (evaluateStatic(current, module).kind === "runtime" && !hasStyleHandleSource(init)) fail$1(module, current.node, "A reusable style handle must be a statically known value.");
						const resolved = lower(init);
						const containsRuntime = (expression) => expression.kind === "choice" || (expression.kind === "style" ? expression.value.inputs.length > 0 : expression.items.some(containsRuntime));
						if (containsRuntime(resolved)) fail$1(module, current.node, "A reusable style handle must be static; put dynamic values and choices directly in the css prop.");
						return resolved;
					}
				}
				if (binding?.path.isImportSpecifier() && binding.path.parentPath?.isImportDeclaration()) {
					const imported = binding.path.node.imported;
					const resolved = options.resolveImport?.(binding.path.parentPath.node.source.value, imported.type === "Identifier" ? imported.name : imported.value);
					if (resolved) return resolved;
					fail$1(module, current.node, "Cannot resolve the imported compile-time style handle.");
				}
			}
			const value = evaluateStatic(current, module);
			if (value.kind === "literal" && (value.value == null || typeof value.value === "boolean")) return EMPTY_STYLE;
			if (value.kind === "object") return {
				kind: "style",
				value: lowerObject(value, module, current.node)
			};
			fail$1(module, current.node, "Style shape must be a static object, template, handle, array, or finite conditional choice.");
		} finally {
			visiting.delete(current.node);
		}
	};
	return lower(path);
}

//#endregion
//#region src/compose.ts
/**
* css array entries are authoring contributions: a later contribution replaces
* the same property/condition/importance. Fallback sequences inside that final
* contribution remain ordered and intact. Different conditions never replace
* each other merely because their property names match.
*/
function composeRuleContributions(earlier, later) {
	const key = (rule, property, important) => JSON.stringify([
		canonicalStyleSelector(rule.selector),
		canonicalStyleWrappers(rule.wrappers),
		property,
		important
	]);
	const replaced = new Set(later.flatMap((rule) => rule.declarations.map((declaration) => key(rule, declaration.property, declaration.important))));
	return [...earlier.map((rule) => ({
		...rule,
		declarations: rule.declarations.filter((declaration) => !replaced.has(key(rule, declaration.property, declaration.important)))
	})).filter((rule) => rule.declarations.length), ...later];
}
/** Enumerate complete style choices. This is independent of runtime predicate values. */
function planStyleSite(expression, id, ownerId, maxStates = 256) {
	const check = (count) => {
		if (!Number.isSafeInteger(count) || count > maxStates) throw new NativeStyleError({
			code: "QS1602",
			message: `Style site ${id} exceeds the exact state limit (${maxStates}).`
		});
	};
	const enumerate = (current) => {
		if (current.kind === "style") return [{
			rules: current.value.rules,
			globals: current.value.globals
		}];
		if (current.kind === "choice") {
			const left = enumerate(current.consequent);
			const right = enumerate(current.alternate);
			check(left.length + right.length);
			return [...left, ...right];
		}
		let combined = [{
			rules: [],
			globals: []
		}];
		for (const item of current.items) {
			const next = enumerate(item);
			check(combined.length * next.length);
			combined = combined.flatMap((before) => next.map((after) => ({
				rules: composeRuleContributions(before.rules, after.rules),
				globals: [...before.globals, ...after.globals]
			})));
		}
		return combined;
	};
	const alternatives = enumerate(expression);
	return {
		id,
		ownerId,
		expression,
		alternatives,
		states: alternatives.map((alternative, index) => ({
			id: `${id}/state:${index}`,
			rules: alternative.rules,
			demand: {
				id: `${id}/state:${index}`,
				owner: ownerId,
				renderPath: id,
				styleState: String(index),
				lazyBoundary: ownerId,
				predicate: `choice(${id})=${index}`
			}
		}))
	};
}
function stateCount(expression) {
	if (expression.kind === "style") return 1;
	if (expression.kind === "choice") return stateCount(expression.consequent) + stateCount(expression.alternate);
	return expression.items.reduce((count, item) => count * stateCount(item), 1);
}
/**
* Only plain value/branch expressions survive. No style IR, registry or helper
* module is emitted. Each source expression executes once at its attribute site.
*/
function emitStyleEvaluation(plan, prefix, identities = new NativeIdentityRegistry(), dev = false) {
	let ordinal = 0;
	const fresh = (suffix) => `${prefix}_${suffix}${ordinal++}`;
	const slots = fresh("slots");
	const state = fresh("state");
	const lines = [`const ${slots}={};`];
	const emitBinding = (binding, inputs, output) => {
		const slot = definitionSlotName(binding.definition, identities);
		if (!slot) throw new NativeStyleError({
			code: "QS1102",
			message: "A dynamic binding has no matching CSS slot."
		});
		const variables = [...new Set(binding.parts.filter((part) => typeof part !== "string").map((part) => inputs[part.input]))];
		if (variables.some((variable) => !variable)) throw new NativeStyleError({
			code: "QS1102",
			message: "A slot references a missing expression input."
		});
		const valid = variables.map((variable) => `(typeof ${variable}==="string"||(typeof ${variable}==="number"&&Number.isFinite(${variable})))`).join("&&") || "true";
		let value;
		if (binding.parts.length === 1 && typeof binding.parts[0] !== "string") {
			const input = inputs[binding.parts[0].input];
			const schema = binding.definition.declaration.value;
			value = schema.kind === "slot" && schema.unit === "length" ? `(typeof ${input}==="number"?${input}+"px":${input})` : `String(${input})`;
		} else value = "\"\"" + binding.parts.map((part) => `+${typeof part === "string" ? JSON.stringify(part) : `String(${inputs[part.input]})`}`).join("");
		output.push(`${slots}[${JSON.stringify(slot)}]=(${valid})?${value}:undefined;`);
		if (dev) {
			const invalid = variables.map((variable) => `(${variable}!=null&&typeof ${variable}!=="boolean"&&!(typeof ${variable}==="string"||(typeof ${variable}==="number"&&Number.isFinite(${variable}))))`).join("||");
			if (invalid) output.push(`if(${invalid})console.error("[qstyle QS1102] Invalid dynamic value for ${binding.definition.declaration.property}.");`);
		}
	};
	const emit = (current, output) => {
		if (current.kind === "style") {
			const inputs = current.value.inputs.map((input) => {
				const name = fresh("value");
				output.push(`const ${name}=(${input.code});`);
				return name;
			});
			for (const binding of current.value.bindings) emitBinding(binding, inputs, output);
			return "0";
		}
		if (current.kind === "choice") {
			const result = fresh("choice");
			const consequent = [];
			const alternate = [];
			const left = emit(current.consequent, consequent);
			const right = emit(current.alternate, alternate);
			output.push(`let ${result};if(${current.test.code}){${consequent.join("")}${result}=${left};}else{${alternate.join("")}${result}=${stateCount(current.consequent)}+(${right});}`);
			return result;
		}
		let result = "0";
		for (const item of current.items) {
			const selected = emit(item, output);
			result = `((${result})*${stateCount(item)}+(${selected}))`;
		}
		return result;
	};
	const selected = emit(plan.expression, lines);
	lines.push(`const ${state}=${selected};`);
	return {
		code: lines.join("\n"),
		state,
		slots
	};
}

//#endregion
//#region src/class-values.ts
/** Finite class strings are proved without running predicates or user functions. */
function analyzeClassValues(expression, module, maxStates = 256) {
	const seen = /* @__PURE__ */ new Set();
	const fail = (path, message) => {
		throw new NativeStyleError({
			code: "QS1102",
			message,
			source: sourceSpan(module.file, path.node)
		});
	};
	const bounded = (values) => {
		const unique = [...new Set(values)];
		if (unique.length > maxStates) throw new NativeStyleError({
			code: "QS1602",
			message: `Class expression exceeds the exact state limit (${maxStates}).`,
			source: sourceSpan(module.file, expression.node)
		});
		return unique;
	};
	const valuesOf = (path) => {
		const evaluated = evaluateStatic(path, module);
		if (evaluated.kind === "literal") return [evaluated.value];
		if (path.isTSAsExpression() || path.isTSSatisfiesExpression() || path.isTSNonNullExpression() || path.isTSTypeAssertion() || path.isTypeCastExpression() || path.isParenthesizedExpression()) return valuesOf(path.get("expression"));
		if (path.isIdentifier()) {
			const binding = path.scope.getBinding(path.node.name);
			if (binding?.kind === "const" && binding.constant && binding.path.isVariableDeclarator() && !seen.has(binding)) {
				const init = binding.path.get("init");
				if (init.isExpression()) {
					seen.add(binding);
					try {
						return valuesOf(init);
					} finally {
						seen.delete(binding);
					}
				}
			}
		}
		if (path.isConditionalExpression()) {
			const test = evaluateStatic(path.get("test"), module);
			if (test.kind === "literal") return valuesOf(test.value ? path.get("consequent") : path.get("alternate"));
			return bounded([...valuesOf(path.get("consequent")), ...valuesOf(path.get("alternate"))]);
		}
		if (path.isLogicalExpression()) {
			const left = path.get("left");
			const right = path.get("right");
			const evaluatedLeft = evaluateStatic(left, module);
			if (evaluatedLeft.kind === "literal") return (path.node.operator === "&&" ? Boolean(evaluatedLeft.value) : path.node.operator === "??" ? evaluatedLeft.value == null : !evaluatedLeft.value) ? valuesOf(right) : [evaluatedLeft.value];
			if (path.node.operator === "&&") return bounded([
				false,
				0,
				"",
				null,
				void 0,
				NaN,
				...valuesOf(right)
			]);
			const leftValues = valuesOf(left);
			const chooseRight = (value) => path.node.operator === "??" ? value == null : !value;
			return bounded([...leftValues.filter((value) => !chooseRight(value)), ...leftValues.some(chooseRight) ? valuesOf(right) : []]);
		}
		if (path.isTemplateLiteral()) {
			let values = [path.node.quasis[0].value.cooked ?? path.node.quasis[0].value.raw];
			const expressions = path.get("expressions");
			for (let index = 0; index < expressions.length; index++) {
				const part = expressions[index];
				if (!part.isExpression()) fail(path, "Unsupported class template expression.");
				const next = valuesOf(part);
				const suffix = path.node.quasis[index + 1].value.cooked ?? path.node.quasis[index + 1].value.raw;
				values = bounded(values.flatMap((before) => next.map((after) => `${String(before)}${String(after)}${suffix}`)));
			}
			return values;
		}
		if (path.isBinaryExpression({ operator: "+" })) {
			const left = path.get("left");
			if (!left.isExpression()) fail(path, "Unsupported class concatenation.");
			const a = valuesOf(left);
			const b = valuesOf(path.get("right"));
			return bounded(a.flatMap((before) => b.map((after) => typeof before === "string" || typeof after === "string" ? String(before) + String(after) : Number(before) + Number(after))));
		}
		return fail(path, "Class values must be finite strings, conditionals or templates; unknown utility construction is unsupported.");
	};
	const values = [...new Set(valuesOf(expression).map((value) => typeof value === "string" ? value.trim() : ""))];
	const runtime = evaluateStatic(expression, module).kind === "literal" ? void 0 : {
		kind: "runtime",
		node: expression.node,
		code: module.code.slice(expression.node.start, expression.node.end),
		source: sourceSpan(module.file, expression.node)
	};
	return {
		values,
		tokens: values.map((value) => [...new Set(value.split(/\s+/).filter(Boolean))]),
		...runtime ? { runtime } : {}
	};
}

//#endregion
//#region src/transform.ts
/** The graph supplies a head reached from a verified application render entry. */
function attachUtilityFoundation(analysis, opening) {
	return {
		...analysis,
		foundation: {
			opening,
			demandId: `${analysis.module.file}#foundation`
		}
	};
}
function hasRuntime(expression) {
	return expression.kind === "choice" || (expression.kind === "style" ? expression.value.inputs.length > 0 : expression.items.some(hasRuntime));
}
/**
* Return the source expression for each final own key of a statically known
* object.  `evaluateStatic` proves that a spread has a fixed shape; this
* companion keeps the source path needed to lower a `css` value from that
* spread without evaluating application code during the build.
*/
function staticSpreadEntries(path, module, seen = /* @__PURE__ */ new Set()) {
	if (seen.has(path.node)) return void 0;
	seen.add(path.node);
	try {
		if (path.isTSAsExpression() || path.isTSSatisfiesExpression() || path.isTSNonNullExpression() || path.isTypeCastExpression() || path.isParenthesizedExpression()) {
			const expression = path.get("expression");
			return expression.isExpression() ? staticSpreadEntries(expression, module, seen) : void 0;
		}
		if (path.isIdentifier()) {
			const binding = path.scope.getBinding(path.node.name);
			if (!binding?.constant || binding.kind !== "const" || !binding.path.isVariableDeclarator()) return void 0;
			const init = binding.path.get("init");
			return init.isExpression() ? staticSpreadEntries(init, module, seen) : void 0;
		}
		if (path.isConditionalExpression()) {
			const test = evaluateStatic(path.get("test"), module);
			if (test.kind !== "literal") return void 0;
			const branch = test.value ? path.get("consequent") : path.get("alternate");
			return branch.isExpression() ? staticSpreadEntries(branch, module, seen) : void 0;
		}
		if (path.isLogicalExpression()) {
			const left = evaluateStatic(path.get("left"), module);
			if (left.kind !== "literal") return void 0;
			if (!(path.node.operator === "&&" ? Boolean(left.value) : !left.value)) return staticSpreadEntries(path.get("left"), module, seen);
			return staticSpreadEntries(path.get("right"), module, seen);
		}
		if (!path.isObjectExpression()) return void 0;
		const byKey = /* @__PURE__ */ new Map();
		const properties = path.get("properties");
		const keyOf = (property) => {
			if (!property.node.computed) {
				const key = property.node.key;
				if (key.type === "Identifier") return key.name;
				if (key.type === "StringLiteral" || key.type === "NumericLiteral") return String(key.value);
				return;
			}
			const key = property.get("key");
			if (!key.isExpression()) return void 0;
			const evaluated = evaluateStatic(key, module);
			if (evaluated.kind !== "literal") return void 0;
			return String(evaluated.value);
		};
		for (const property of properties) {
			if (property.isSpreadElement()) {
				const argument = property.get("argument");
				if (!argument.isExpression()) return void 0;
				const nested = staticSpreadEntries(argument, module, seen);
				if (!nested) return void 0;
				for (const entry of nested) byKey.set(entry.key, entry.value);
				continue;
			}
			if (!property.isObjectProperty()) return void 0;
			const key = keyOf(property);
			const value = property.get("value");
			if (key === void 0 || !value.isExpression()) return void 0;
			byKey.set(key, value);
		}
		return [...byKey].map(([key, value]) => ({
			key,
			value
		}));
	} finally {
		seen.delete(path.node);
	}
}
function isStyleTarget(opening) {
	const tag = opening.node.name;
	return tag.type === "JSXIdentifier" && /^[a-z]/.test(tag.name);
}
function knownSpread(argument, module) {
	if (evaluateStatic(argument, module, { allowStoredStructuralValues: true }).kind !== "object") throw new NativeStyleError({
		code: "QS1102",
		message: "JSX spread keys must be statically known.",
		source: sourceSpan(module.file, argument.node)
	});
	const entries = staticSpreadEntries(argument, module);
	if (!entries) throw new NativeStyleError({
		code: "QS1102",
		message: "JSX spread keys must be statically known.",
		source: sourceSpan(module.file, argument.node)
	});
	return entries;
}
function collectStyleSites(module, utilities = false) {
	const explicit = collectCssPropSites(module);
	const byAttribute = /* @__PURE__ */ new Map();
	for (const site of explicit) byAttribute.set(site.attribute.node, site);
	const sites = [];
	module.program.traverse({ JSXOpeningElement(opening) {
		const occurrences = [];
		let owner;
		let classExpression;
		let hasClass = false;
		const hasCssAttribute = opening.get("attributes").some((attribute) => attribute.isJSXAttribute() && attribute.node.name.type === "JSXIdentifier" && attribute.node.name.name === "css");
		for (const attribute of opening.get("attributes")) {
			if (attribute.isJSXAttribute()) {
				if (utilities && isStyleTarget(opening) && attribute.node.name.type === "JSXIdentifier" && ["class", "className"].includes(attribute.node.name.name)) {
					hasClass = true;
					const value = attribute.get("value");
					const expression = value.isJSXExpressionContainer() ? value.get("expression") : value;
					classExpression = expression.isExpression() ? expression : void 0;
				}
				const site = byAttribute.get(attribute.node);
				if (!site) continue;
				occurrences.push({
					node: attribute.node,
					expression: site.expression
				});
				owner ??= site.owner;
				continue;
			}
			const argument = attribute.get("argument");
			if (!argument.isExpression()) {
				if (owner) throw new NativeStyleError({
					code: "QS1102",
					message: "JSX spread keys must be statically known.",
					source: sourceSpan(module.file, attribute.node)
				});
				continue;
			}
			if (evaluateStatic(argument, module, { allowStoredStructuralValues: true }).kind !== "object") {
				if (owner || hasCssAttribute || isStyleTarget(opening)) throw new NativeStyleError({
					code: "QS1102",
					message: "JSX spread keys must be statically known.",
					source: sourceSpan(module.file, attribute.node)
				});
				continue;
			}
			const entries = knownSpread(argument, module);
			if (utilities && isStyleTarget(opening)) {
				for (const entry of entries) if (entry.key === "class" || entry.key === "className") {
					hasClass = true;
					classExpression = entry.value;
				}
			}
			const css = entries.find((entry) => entry.key === "css");
			if (!css) continue;
			if (!isStyleTarget(opening)) throw new NativeStyleError({
				code: "QS1103",
				message: "Apply css to a DOM element, not a component or Slot.",
				source: sourceSpan(module.file, opening.node)
			});
			occurrences.push({
				node: attribute.node,
				expression: css.value
			});
			owner ??= findComponentOwner(opening, module);
		}
		if (!occurrences.length && !hasClass) return;
		sites.push({
			id: `${module.file}#element:${sites.length}`,
			owner: owner ?? findComponentOwner(opening, module),
			opening,
			occurrences,
			...classExpression ? { classExpression } : {}
		});
	} });
	return sites;
}
function isMacroReference(path) {
	const parent = path.parentPath;
	if (parent?.isCallExpression() && parent.node.callee === path.node) return true;
	if (parent?.isTaggedTemplateExpression() && parent.node.tag === path.node) return true;
	if (parent?.isMemberExpression() && !parent.node.computed && parent.node.object === path.node && parent.node.property.type === "Identifier" && parent.node.property.name === "css") {
		const outer = parent.parentPath;
		return outer?.isCallExpression() && outer.node.callee === parent.node || outer?.isTaggedTemplateExpression() && outer.node.tag === parent.node;
	}
	return false;
}
/** A macro binding is callable only at a directly recognized css site. */
function validateCssMacroEscapes(module) {
	const checked = /* @__PURE__ */ new Set();
	const fail = (path) => {
		throw new NativeStyleError({
			code: "QS1102",
			message: "The css macro binding escapes into runtime code.",
			source: sourceSpan(module.file, path.node),
			fixHint: "Call css directly in a compile-time style expression."
		});
	};
	const inspect = (binding) => {
		if (checked.has(binding)) return;
		checked.add(binding);
		for (const reference of binding.referencePaths) if (!isMacroReference(reference)) fail(reference);
	};
	module.program.traverse({ ImportDeclaration(path) {
		if (path.node.source.value !== "@qstyle/qwik") return;
		for (const specifier of path.get("specifiers")) {
			const local = specifier.node.local;
			const binding = path.scope.getBinding(local.name);
			if (!binding) continue;
			if (specifier.isImportSpecifier()) {
				const imported = specifier.node.imported;
				if ((imported.type === "Identifier" ? imported.name : imported.value) === "css") inspect(binding);
			} else if (specifier.isImportNamespaceSpecifier()) inspect(binding);
		}
	} });
}
/** The same analysis is retained from whole-graph discovery through final emission. */
function analyzeStyleModule(code, file, options = {}) {
	const module = parseStyleModule(code, file);
	validateCssMacroEscapes(module);
	validateAuthoringUses(module);
	const owners = /* @__PURE__ */ new Map();
	const sites = collectStyleSites(module, options.utilities).map((source) => {
		let owner = owners.get(source.owner.callback.node);
		if (!owner) {
			owner = `${file}#owner:${owners.size}`;
			owners.set(source.owner.callback.node, owner);
		}
		const last = source.occurrences[source.occurrences.length - 1];
		const expression = last ? lowerStyleExpression(last.expression, module, options) : {
			kind: "sequence",
			items: []
		};
		return {
			source,
			plan: planStyleSite(expression, source.id, owner),
			...options.utilities ? { classValues: source.classExpression ? analyzeClassValues(source.classExpression, module) : {
				values: [""],
				tokens: [[]]
			} } : {}
		};
	});
	const macros = [];
	const collect = (path) => {
		const occurrence = sites.flatMap((site) => site.source.occurrences).find((candidate) => path.node.start >= candidate.node.start && path.node.end <= candidate.node.end);
		if (occurrence) {
			const isExplicit = occurrence.node.type === "JSXAttribute";
			const finalOccurrence = sites.some((site) => site.source.occurrences[site.source.occurrences.length - 1]?.node === occurrence.node);
			if (isExplicit && finalOccurrence) return;
			if (!macros.some((outer) => path.node.start >= outer.node.start && path.node.end <= outer.node.end)) macros.push(path);
			return;
		}
		if (hasRuntime(lowerStyleExpression(path, module, options))) throw new NativeStyleError({
			code: "QS1102",
			message: "A reusable or unused css macro must be entirely static.",
			source: sourceSpan(file, path.node)
		});
		if (!macros.some((outer) => path.node.start >= outer.node.start && path.node.end <= outer.node.end)) macros.push(path);
	};
	module.program.traverse({
		CallExpression(path) {
			if (isCssMacro(path.get("callee"))) collect(path);
		},
		TaggedTemplateExpression(path) {
			if (isCssMacro(path.get("tag"))) collect(path);
		}
	});
	return {
		module,
		sites,
		macros
	};
}
function utilityRequests(analysis) {
	return analysis.sites.flatMap((site) => site.classValues?.tokens.map((tokens, index) => ({
		id: `${site.plan.id}/class:${index}`,
		tokens
	})) ?? []);
}
/** Utility order is the adapter order; CSS contributions follow it regardless of JSX attribute order. */
function composeUtilityStates(analysis, resolved, maxStates = 256) {
	return {
		...analysis,
		sites: analysis.sites.map((site) => {
			if (!site.classValues) return site;
			const cssPlan = site.cssPlan ?? site.plan;
			const utilities = site.classValues.values.map((_, index) => {
				const id = `${cssPlan.id}/class:${index}`;
				const state = resolved.get(id);
				if (!state) throw new NativeStyleError({
					code: "QS1401",
					message: `Missing utility resolution for ${id}.`
				});
				return state;
			});
			if (utilities.length * cssPlan.states.length > maxStates) throw new NativeStyleError({
				code: "QS1602",
				message: `Style site ${cssPlan.id} exceeds the exact combined class/CSS state limit (${maxStates}).`
			});
			const alternatives = utilities.flatMap((utility) => cssPlan.alternatives.map((css) => ({
				rules: composeRuleContributions(utility.nodes.flatMap((node) => node.kind === "local" ? [node.rule] : []), css.rules),
				globals: [...utility.nodes.flatMap((node) => node.kind === "global" ? [{
					...node.value,
					wrappers: node.wrappers
				}] : []), ...css.globals]
			})));
			const states = alternatives.map((alternative, index) => ({
				id: `${cssPlan.id}/state:${index}`,
				rules: alternative.rules,
				demand: {
					...cssPlan.states[index % cssPlan.states.length].demand,
					id: `${cssPlan.id}/state:${index}`,
					styleState: String(index),
					predicate: `choice(${cssPlan.id})=${index}`
				}
			}));
			return {
				...site,
				cssPlan,
				utilities,
				plan: {
					...cssPlan,
					alternatives,
					states
				}
			};
		})
	};
}
/** Fixed selectors and statements retain the same render demand as their utility state. */
function utilityAuxiliaryNodes(site, stateIndex) {
	return (site.utilities?.[Math.floor(stateIndex / (site.cssPlan?.states.length ?? 1))])?.nodes.filter((node) => node.kind === "global-rule" || node.kind === "layer-order") ?? [];
}
/** Emit ordinary TSX for the Qwik optimizer, preserving attribute evaluation order. */
function emitStyleModule(analysis, program, options = {}) {
	const { module } = analysis;
	const edits = new MagicString(module.code);
	let prefix = "__qstyle";
	while (module.code.includes(prefix)) prefix += "_";
	let ordinal = 0;
	const fresh = (kind) => `${prefix}_${kind}${ordinal++}`;
	const packNames = /* @__PURE__ */ new Map();
	const packName = (pack) => {
		let name = packNames.get(pack);
		if (!name) {
			name = fresh("Pack");
			packNames.set(pack, name);
		}
		return name;
	};
	const fail = (node, message) => {
		throw new NativeStyleError({
			code: "QS1102",
			message,
			source: sourceSpan(module.file, node)
		});
	};
	const read = (node) => module.code.slice(node.start, node.end);
	const readGenerated = (node, extraReplacements = []) => {
		const start = node.start;
		const end = node.end;
		const replacements = [...analysis.macros.map((macro) => ({
			node: macro.node,
			text: "void 0"
		})), ...extraReplacements].filter(({ node: candidate }) => candidate.start >= start && candidate.end <= end).sort((left, right) => left.node.start - right.node.start);
		if (!replacements.length) return read(node);
		let cursor = start;
		let generated = "";
		for (const replacement of replacements) {
			const replacementStart = replacement.node.start;
			const replacementEnd = replacement.node.end;
			if (replacementStart < cursor) continue;
			generated += module.code.slice(cursor, replacementStart);
			generated += replacement.text;
			cursor = replacementEnd;
		}
		return generated + module.code.slice(cursor, end);
	};
	const checkStyle = (path) => {
		const value = evaluateStatic(path, module);
		if (value.kind === "literal" && (value.value == null || typeof value.value === "string")) {
			if (typeof value.value === "string" && /--qstyle-/.test(value.value)) fail(path.node, "The --qstyle- variable namespace is reserved.");
			return;
		}
		if (value.kind === "object") {
			for (const [key] of value.entries) if (key.startsWith("--qstyle-")) fail(path.node, "The --qstyle- variable namespace is reserved.");
			return;
		}
		fail(path.node, "The explicit style attribute must have statically known keys or a static CSS string.");
	};
	for (const { source, plan, cssPlan = plan, classValues, utilities } of analysis.sites) {
		const element = source.opening.parentPath;
		if (!element.isJSXElement()) fail(source.opening.node, "Expected a JSX element style owner.");
		const body = [];
		const attributes = [];
		let explicitClass;
		let explicitStyle;
		const evaluation = emitStyleEvaluation(cssPlan, fresh("eval"), void 0, options.dev);
		let evaluationState = evaluation.state;
		let evaluationSlots = evaluation.slots;
		const occurrences = new Map(source.occurrences.map((occurrence) => [occurrence.node, occurrence]));
		const finalOccurrence = source.occurrences[source.occurrences.length - 1];
		let evaluationInserted = false;
		for (const attribute of source.opening.get("attributes")) {
			if (attribute.isJSXSpreadAttribute()) {
				const argument = attribute.get("argument");
				if (!argument.isExpression()) fail(attribute.node, "JSX spread keys must be statically known.");
				const entries = knownSpread(argument, module);
				const name = fresh("spread");
				const occurrence = occurrences.get(attribute.node);
				let spreadReplacements = [];
				if (occurrence && occurrence.node === finalOccurrence?.node && occurrence.expression.node.start >= argument.node.start && occurrence.expression.node.end <= argument.node.end) {
					const result = fresh("result");
					const runEvaluation = `(()=>{${evaluation.code}return {state:${evaluation.state},slots:${evaluation.slots}};})()`;
					body.push(`let ${result};`);
					spreadReplacements = [{
						node: occurrence.expression.node,
						text: `(${result}=${runEvaluation},void 0)`
					}];
					evaluationState = `${result}.state`;
					evaluationSlots = `${result}.slots`;
					evaluationInserted = true;
				}
				body.push(`const ${name}={...(${readGenerated(argument.node, spreadReplacements)})};`);
				if (occurrence && occurrence.node === finalOccurrence?.node && !evaluationInserted) {
					const stored = planStyleSite(lowerStoredStyleExpression(occurrence.expression, module, `${name}.css`), cssPlan.id, cssPlan.ownerId);
					const captured = emitStyleEvaluation(stored, fresh("eval"), void 0, options.dev);
					body.push(captured.code);
					evaluationState = captured.state;
					evaluationSlots = captured.slots;
					evaluationInserted = true;
				}
				const compilerKeys = /* @__PURE__ */ new Set([
					"css",
					"style",
					"class",
					"className"
				]);
				for (const entry of entries) {
					const access = `${name}[${JSON.stringify(entry.key)}]`;
					if (entry.key === "style") {
						checkStyle(entry.value);
						explicitStyle = access;
					} else if (entry.key === "class" || entry.key === "className") explicitClass = access;
				}
				if (occurrence && occurrence.node === finalOccurrence?.node && !evaluationInserted) {
					body.push(evaluation.code);
					evaluationInserted = true;
				}
				if (entries.some((entry) => !compilerKeys.has(entry.key))) {
					const rest = fresh("spread");
					const removals = entries.filter((entry) => compilerKeys.has(entry.key)).map((entry) => `delete ${rest}[${JSON.stringify(entry.key)}];`).join("");
					body.push(`const ${rest}={...${name}};${removals}`);
					attributes.push(` {...${rest}}`);
				}
				continue;
			}
			const occurrence = occurrences.get(attribute.node);
			if (occurrence) {
				if (occurrence.node === finalOccurrence?.node) {
					if (!evaluationInserted) {
						body.push(evaluation.code);
						evaluationInserted = true;
					}
				} else {
					const discarded = fresh("discard");
					body.push(`const ${discarded}=(${readGenerated(occurrence.expression.node)});`);
				}
				continue;
			}
			if (!attribute.isJSXAttribute()) fail(source.opening.node, "Unsupported JSX attribute.");
			const key = read(attribute.node.name);
			const value = attribute.get("value");
			let expression;
			if (!value.node) expression = "true";
			else if (value.isStringLiteral()) {
				if (key === "style" && /--qstyle-/.test(value.node.value)) fail(value.node, "The --qstyle- variable namespace is reserved.");
				expression = JSON.stringify(value.node.value);
			} else if (value.isJSXExpressionContainer() && value.get("expression").isExpression()) {
				const path = value.get("expression");
				if (key === "style") checkStyle(path);
				expression = read(path.node);
			} else fail(attribute.node, "Unsupported JSX attribute value.");
			const name = fresh("attr");
			body.push(`const ${name}=(${expression});`);
			if (key === "class" || key === "className") explicitClass = name;
			else if (key === "style") explicitStyle = name;
			else attributes.push(` ${key}={${name}}`);
		}
		if (!evaluationInserted) body.push(evaluation.code);
		if (classValues) {
			if (!utilities) fail(source.opening.node, "Utility states must be resolved before module emission.");
			const index = fresh("classIndex");
			const normalized = explicitClass ? `(typeof ${explicitClass}==="string"?${explicitClass}.trim():"")` : "\"\"";
			body.push(`const ${index}=${JSON.stringify(classValues.values)}.indexOf(${normalized});`);
			body.push(`if(${index}<0)throw new Error("[qstyle QS1102] Class value is outside the proven finite set.");`);
			const combined = fresh("state");
			body.push(`const ${combined}=${index}*${cssPlan.states.length}+${evaluationState};`);
			evaluationState = combined;
			const retained = fresh("class");
			body.push(`const ${retained}=${JSON.stringify(utilities.map((utility) => utility.retainedTokens.join(" ")))}[${index}];`);
			explicitClass = retained;
		}
		const classChoices = plan.states.map((state) => {
			const classes = program.classesByState.get(state.id);
			if (!classes) fail(source.opening.node, `Missing frozen class assignment for ${state.id}.`);
			return classes.join(" ");
		});
		const generatedClass = classChoices.length === 1 ? JSON.stringify(classChoices[0]) : `${JSON.stringify(classChoices)}[${evaluationState}]`;
		attributes.push(` class={${explicitClass ? `[${explicitClass},${generatedClass}]` : generatedClass}}`);
		let style = evaluationSlots;
		if (explicitStyle) {
			const names = /* @__PURE__ */ new Set();
			const collectSlots = (expression) => {
				if (expression.kind === "style") for (const binding of expression.value.bindings) {
					const name = definitionSlotName(binding.definition, new NativeIdentityRegistry());
					if (name) names.add(name);
				}
				else if (expression.kind === "sequence") expression.items.forEach(collectSlots);
				else {
					collectSlots(expression.consequent);
					collectSlots(expression.alternate);
				}
			};
			collectSlots(cssPlan.expression);
			const serialized = [...names].map((name) => `(${evaluationSlots}[${JSON.stringify(name)}]===undefined?"":${JSON.stringify(name + ":")}+${evaluationSlots}[${JSON.stringify(name)}]+";")`).join("+") || "\"\"";
			style = `(typeof ${explicitStyle}==="string"?(${serialized})+${explicitStyle}:{...${evaluationSlots},...${explicitStyle}})`;
		}
		attributes.push(` style={${style}}`);
		const allPacks = /* @__PURE__ */ new Map();
		plan.states.forEach((state, index) => {
			const packs = program.packsByDemand.get(state.demand.id);
			if (!packs) fail(source.opening.node, `Missing frozen pack demand for ${state.id}.`);
			for (const pack of packs) {
				const cases = allPacks.get(pack) ?? [];
				cases.push(index);
				allPacks.set(pack, cases);
			}
		});
		const owners = [...allPacks].map(([pack, cases]) => {
			const jsx = `<${packName(pack)}/>`;
			return cases.length === plan.states.length ? jsx : `{(${cases.map((index) => `${evaluationState}===${index}`).join("||")})?${jsx}:null}`;
		}).join("");
		const child = element.parentPath?.isJSXElement() || element.parentPath?.isJSXFragment();
		let literalClass = "";
		let hasLiteralClass = false;
		const literalAttributes = [];
		if (source.opening.get("attributes").every((attribute) => {
			if (!attribute.isJSXAttribute()) return false;
			if (occurrences.has(attribute.node)) return true;
			const key = read(attribute.node.name);
			const value = attribute.get("value");
			if (key === "style") return false;
			if (key === "class" || key === "className") {
				if (!value.isStringLiteral()) return false;
				hasLiteralClass = true;
				literalClass = value.node.value;
				return true;
			}
			if (value.node && !value.isStringLiteral()) return false;
			literalAttributes.push(` ${read(attribute.node)}`);
			return true;
		}) && source.occurrences.length <= 1 && plan.states.length === 1 && !hasRuntime(cssPlan.expression) && (!classValues || classValues.values.length === 1)) {
			const classes = [classValues ? utilities[0].retainedTokens.join(" ") : literalClass, classChoices[0]].filter(Boolean).join(" ");
			if (classes || hasLiteralClass) literalAttributes.push(` class={${JSON.stringify(classes)}}`);
			if (owners) edits.appendLeft(element.node.start, `${child ? "" : "<>"}${owners}`);
			edits.overwrite(source.opening.node.start, source.opening.node.end, `<${read(source.opening.node.name)}${literalAttributes.join("")}${source.opening.node.selfClosing ? "/>" : ">"}`);
			if (owners && !child) edits.appendRight(element.node.end, "</>");
			continue;
		}
		edits.appendLeft(element.node.start, `${child ? "{" : ""}(()=>{${body.join("\n")}return <>${owners}`);
		edits.overwrite(source.opening.node.start, source.opening.node.end, `<${read(source.opening.node.name)}${attributes.join("")}${source.opening.node.selfClosing ? "/>" : ">"}`);
		edits.appendRight(element.node.end, `</>;})()${child ? "}" : ""}`);
	}
	for (const macro of analysis.macros) edits.overwrite(macro.node.start, macro.node.end, "void 0");
	if (analysis.foundation) {
		const { opening, demandId } = analysis.foundation;
		const packs = program.packsByDemand.get(demandId);
		if (!packs) fail(opening.node, `Missing utility foundation demand ${demandId}.`);
		const owners = packs.map((pack) => `<${packName(pack)}/>`).join("");
		if (opening.node.selfClosing) edits.overwrite(opening.node.end - 2, opening.node.end, `>${owners}</head>`);
		else edits.appendLeft(opening.node.end, owners);
	}
	const imports = [...packNames].map(([pack, name]) => `import { StylePack as ${name} } from ${JSON.stringify(options.packModule?.(pack) ?? `virtual:qstyle-native:${pack}.tsx`)};`).join("\n");
	if (imports) edits.prepend(imports + "\n");
	return {
		code: edits.toString(),
		map: edits.generateMap({
			source: module.file,
			includeContent: true,
			hires: true
		})
	};
}

//#endregion
//#region src/global.ts
/** CSS-wide names and animation keywords which cannot be disambiguated in a shorthand. */
const ANIMATION_KEYWORDS = /* @__PURE__ */ new Set([
	"normal",
	"reverse",
	"alternate",
	"alternate-reverse",
	"none",
	"forwards",
	"backwards",
	"both",
	"running",
	"paused",
	"infinite",
	"initial",
	"inherit",
	"unset",
	"revert",
	"revert-layer",
	"ease",
	"ease-in",
	"ease-out",
	"ease-in-out",
	"linear",
	"step-start",
	"step-end"
]);
function sourceOf(global) {
	return global.source;
}
function fail(code, message, source, related) {
	throw new NativeStyleError({
		code,
		message,
		...source ? { source } : {},
		...related?.length ? { related } : {}
	});
}
function sourceNameOf(global) {
	if (global.kind !== "keyframes") return void 0;
	const named = global;
	return typeof named.sourceName === "string" ? named.sourceName : void 0;
}
function isPropertyGlobal(global) {
	return global.kind === "property";
}
function rawGlobalError(error, global) {
	if (error instanceof NativeStyleError) {
		const source = error.diagnostic.source ?? sourceOf(global);
		throw new NativeStyleError({
			...error.diagnostic,
			...source ? { source } : {}
		});
	}
	throw error;
}
function isUnclosedNode(node) {
	return "unclosed" in node && node.unclosed === true;
}
function parseValue(value, source, label) {
	const parsed = valueParser(value);
	let malformed = false;
	parsed.walk((node) => {
		if (isUnclosedNode(node)) malformed = true;
	});
	if (malformed) fail("QS1101", `Malformed ${label}.`, source);
	return parsed;
}
function isTrivia(node) {
	return node.type === "space" || node.type === "comment";
}
function splitTopLevel(nodes) {
	const segments = [[]];
	for (const node of nodes) if (node.type === "div" && node.value === ",") segments.push([]);
	else segments[segments.length - 1].push(node);
	return segments;
}
function meaningful(nodes) {
	return nodes.filter((node) => !isTrivia(node));
}
function rewriteAnimationName(value, keyframes, source) {
	const parsed = parseValue(value, source, "animation-name value");
	const dependencies = /* @__PURE__ */ new Set();
	for (const segment of splitTopLevel(parsed.nodes)) {
		const tokens = meaningful(segment);
		if (tokens.length === 0) fail("QS1102", "animation-name cannot contain an empty item.", source);
		if (tokens.length !== 1) fail("QS1102", "animation-name contains an ambiguous or unsupported item.", source);
		const token = tokens[0];
		if (token.type !== "word" && token.type !== "string") continue;
		const id = keyframes.get(token.value);
		if (id === void 0 || token.type === "word" && ANIMATION_KEYWORDS.has(token.value.toLowerCase())) continue;
		token.value = id;
		dependencies.add(id);
	}
	return {
		value: valueParser.stringify(parsed.nodes),
		dependencies: [...dependencies]
	};
}
function rewriteAnimationShorthand(value, keyframes, source) {
	const parsed = parseValue(value, source, "animation value");
	const dependencies = /* @__PURE__ */ new Set();
	for (const segment of splitTopLevel(parsed.nodes)) {
		const candidates = meaningful(segment).filter((node) => (node.type === "word" || node.type === "string") && keyframes.has(node.value));
		if (candidates.length > 1) fail("QS1102", "animation contains more than one possible keyframe name.", source);
		const candidate = candidates[0];
		if (candidate === void 0) continue;
		if (candidate.type === "word" && ANIMATION_KEYWORDS.has(candidate.value.toLowerCase())) fail("QS1102", `Keyframe name ${JSON.stringify(candidate.value)} is ambiguous in animation shorthand.`, source);
		const id = keyframes.get(candidate.value);
		candidate.value = id;
		dependencies.add(id);
	}
	return {
		value: valueParser.stringify(parsed.nodes),
		dependencies: [...dependencies]
	};
}
function firstVarName(node) {
	if (node.value.toLowerCase() !== "var") return void 0;
	const first = meaningful(splitTopLevel(node.nodes)[0] ?? [])[0];
	return first?.type === "word" ? first.value : void 0;
}
function collectVariableReferences(value, properties, source) {
	const parsed = parseValue(value, source, "declaration value");
	const dependencies = /* @__PURE__ */ new Set();
	parsed.walk((node) => {
		if (node.type !== "function") return;
		const name = firstVarName(node);
		if (name !== void 0) {
			const id = properties.get(name);
			if (id !== void 0) dependencies.add(id);
		}
	});
	return [...dependencies];
}
function globalIdentity(global, identities) {
	const canonical = canonicalGlobal(global);
	const namespace = global.kind === "keyframes" ? "keyframes" : "global";
	const digest = identities.identify(namespace, canonical, sourceOf(global));
	return {
		namespace,
		canonical,
		id: global.kind === "keyframes" ? `qk1_${digest}` : digest
	};
}
function registerGlobals(globals, identities) {
	const payloads = [];
	const byCanonical = /* @__PURE__ */ new Map();
	const keyframeNames = /* @__PURE__ */ new Map();
	const propertyNames = /* @__PURE__ */ new Map();
	const keyframes = /* @__PURE__ */ new Map();
	const properties = /* @__PURE__ */ new Map();
	const fontFaceIds = [];
	for (const global of globals) {
		const identity = globalIdentity(global, identities);
		const source = sourceOf(global);
		const priorName = sourceNameOf(global);
		if (priorName !== void 0) {
			const previous = keyframeNames.get(priorName);
			if (previous !== void 0 && previous.canonical !== identity.canonical) fail("QS1601", `Conflicting @keyframes definitions for source name ${JSON.stringify(priorName)}.`, sourceOf(global), previous.source ? [previous.source] : void 0);
			keyframeNames.set(priorName, {
				canonical: identity.canonical,
				id: identity.id,
				...source ? { source } : {}
			});
			keyframes.set(priorName, identity.id);
		}
		if (isPropertyGlobal(global)) {
			const previous = propertyNames.get(global.name);
			if (previous !== void 0 && previous.canonical !== identity.canonical) fail("QS1601", `Conflicting @property definitions for ${JSON.stringify(global.name)}.`, sourceOf(global), previous.source ? [previous.source] : void 0);
			propertyNames.set(global.name, {
				canonical: identity.canonical,
				id: identity.id,
				...source ? { source } : {}
			});
			properties.set(global.name, identity.id);
		}
		if (!byCanonical.has(`${identity.namespace}:${identity.canonical}`)) {
			let css;
			try {
				css = serializeNativeGlobal(global, identities, global.kind === "keyframes" ? identity.id : void 0);
			} catch (error) {
				rawGlobalError(error, global);
			}
			const payload = {
				id: identity.id,
				kind: global.kind,
				css,
				...source ? { source } : {}
			};
			byCanonical.set(`${identity.namespace}:${identity.canonical}`, payload);
			payloads.push(payload);
			if (global.kind === "font-face") fontFaceIds.push(identity.id);
		} else if (global.kind === "font-face") {
			const index = payloads.findIndex((payload) => payload.id === identity.id);
			if (index >= 0) payloads.push(...payloads.splice(index, 1));
			if (!fontFaceIds.includes(identity.id)) fontFaceIds.push(identity.id);
		}
	}
	return {
		payloads,
		keyframes,
		properties,
		fontFaceIds
	};
}
function rewriteRule(rule, keyframes, properties, fontFaceIds) {
	const dependencies = new Set(rule.dependencies);
	const declarations = [];
	for (const declaration of rule.declarations) {
		if (declaration.value.kind !== "static") {
			if (declaration.property === "animation" || declaration.property === "animation-name") fail("QS1102", `Dynamic ${declaration.property} cannot be resolved to a static keyframe identity.`, rule.source);
			declarations.push(declaration);
			continue;
		}
		let value = declaration.value.css;
		if (declaration.property === "animation-name") {
			const rewritten = rewriteAnimationName(value, keyframes, rule.source);
			value = rewritten.value;
			rewritten.dependencies.forEach((id) => dependencies.add(id));
		} else if (declaration.property === "animation") {
			const rewritten = rewriteAnimationShorthand(value, keyframes, rule.source);
			value = rewritten.value;
			rewritten.dependencies.forEach((id) => dependencies.add(id));
		}
		collectVariableReferences(value, properties, rule.source).forEach((id) => dependencies.add(id));
		if (declaration.property.startsWith("--")) {
			const id = properties.get(declaration.property);
			if (id !== void 0) dependencies.add(id);
		}
		if (declaration.property === "font" || declaration.property === "font-family") fontFaceIds.forEach((id) => dependencies.add(id));
		declarations.push(value === declaration.value.css ? declaration : {
			...declaration,
			value: {
				kind: "static",
				css: value
			}
		});
	}
	return {
		...rule,
		declarations,
		dependencies: [...dependencies]
	};
}
/** Canonicalize static globals, rename keyframes, and attach global dependencies to rules. */
function resolveStyleGlobals(rules, globals, identities = new NativeIdentityRegistry()) {
	const registered = registerGlobals(globals, identities);
	return {
		rules: rules.map((rule) => rewriteRule(rule, registered.keyframes, registered.properties, registered.fontFaceIds)),
		globals: registered.payloads
	};
}

//#endregion
//#region src/document-root.ts
/** Resolve the document head reachable from one statically known module export. */
function resolveDocumentEntry(module, exportName = "default") {
	const resolvingBindings = /* @__PURE__ */ new Set();
	const resolvingCallables = /* @__PURE__ */ new Set();
	const reject = (node, message) => {
		throw new NativeStyleError({
			code: "QS1103",
			message,
			source: sourceSpan(module.file, node)
		});
	};
	const unwrap = (input) => {
		let path = input;
		for (;;) {
			if (!path.isParenthesizedExpression() && !path.isTSAsExpression() && !path.isTSSatisfiesExpression() && !path.isTSTypeAssertion() && !path.isTSNonNullExpression() && !path.isTypeCastExpression()) return path;
			const child = path.get("expression");
			if (!child || Array.isArray(child) || !child.isExpression()) return path;
			path = child;
		}
	};
	const expressionArgument = (call, index) => {
		const argument = call.get("arguments")[index];
		return argument && argument.isExpression() ? argument : void 0;
	};
	const objectKey = (property) => {
		const key = property.node.key;
		if (property.node.computed) {
			if (key.type === "StringLiteral" || key.type === "NumericLiteral") return String(key.value);
			return;
		}
		if (key.type === "Identifier") return key.name;
		if (key.type === "StringLiteral" || key.type === "NumericLiteral") return String(key.value);
	};
	const importedTarget = (input, seen = /* @__PURE__ */ new Set()) => {
		const path = unwrap(input);
		const direct = resolveImportedBinding(path);
		if (direct) return {
			source: direct.source,
			imported: direct.imported
		};
		if (!path.isIdentifier()) return void 0;
		const binding = path.scope.getBinding(path.node.name);
		if (!binding || binding.kind !== "const" || !binding.constant || !binding.path.isVariableDeclarator() || seen.has(binding)) return void 0;
		const init = binding.path.get("init");
		if (!init.isExpression()) return void 0;
		const next = new Set(seen);
		next.add(binding);
		return importedTarget(init, next);
	};
	const callableReturn = (callable) => {
		const body = callable.get("body");
		if (!body.isBlockStatement()) return body.isExpression() ? body : void 0;
		const direct = body.get("body").filter((statement) => statement.isReturnStatement());
		const returns = [];
		body.traverse({
			Function(path) {
				path.skip();
			},
			Class(path) {
				path.skip();
			},
			ReturnStatement(path) {
				returns.push(path);
			}
		});
		if (direct.length !== 1) {
			if (returns.length > 0) reject(callable.node, "A document entry must have one unconditional top-level return.");
			return;
		}
		if (returns.length !== 1) reject(callable.node, "A document entry cannot return from a conditional or loop.");
		const argument = direct[0].get("argument");
		return argument && argument.isExpression() ? argument : void 0;
	};
	const scanJsxExpression = (input, result, conditional) => {
		const path = unwrap(input);
		if (path.isJSXElement() || path.isJSXFragment()) {
			scanJsx(path, result, conditional);
			return;
		}
		if (path.isConditionalExpression()) {
			const consequent = path.get("consequent");
			const alternate = path.get("alternate");
			if (consequent.isExpression()) scanJsxExpression(consequent, result, true);
			if (alternate.isExpression()) scanJsxExpression(alternate, result, true);
			return;
		}
		if (path.isLogicalExpression()) {
			const left = path.get("left");
			const right = path.get("right");
			if (left.isExpression()) scanJsxExpression(left, result, true);
			if (right.isExpression()) scanJsxExpression(right, result, true);
			return;
		}
		if (path.isArrayExpression()) {
			for (const element of path.get("elements")) if (element.node && element.isExpression()) scanJsxExpression(element, result, true);
		}
	};
	function scanJsx(path, result, conditional) {
		if (path.isJSXElement()) {
			const opening = path.get("openingElement");
			const name = opening.node.name;
			if (name.type === "JSXIdentifier" && name.name === "head") {
				if (conditional) result.conditionalHead = true;
				else result.heads.push(opening);
				return;
			}
			if (name.type === "JSXIdentifier" && !/^[a-z]/.test(name.name) || name.type === "JSXMemberExpression") {
				if (conditional) result.conditionalComponent = true;
				else result.components.push(path);
			} else if (name.type !== "JSXIdentifier" || name.name !== "html") return;
			for (const child of path.get("children")) if (child.isJSXElement() || child.isJSXFragment()) scanJsx(child, result, conditional);
			else if (child.isJSXExpressionContainer()) {
				const expression = child.get("expression");
				if (expression.isExpression()) scanJsxExpression(expression, result, conditional);
			}
			return;
		}
		for (const child of path.get("children")) if (child.isJSXElement() || child.isJSXFragment()) scanJsx(child, result, conditional);
		else if (child.isJSXExpressionContainer()) {
			const expression = child.get("expression");
			if (expression.isExpression()) scanJsxExpression(expression, result, conditional);
		}
	}
	function resolveJsxComponent(element) {
		const name = element.get("openingElement").get("name");
		if (!name.isJSXIdentifier()) return void 0;
		const binding = name.scope.getBinding(name.node.name);
		return binding ? resolveBinding(binding) : void 0;
	}
	function resolveJsx(path) {
		const scan = {
			heads: [],
			components: [],
			conditionalHead: false,
			conditionalComponent: false
		};
		scanJsx(path, scan, false);
		if (scan.conditionalHead) reject(path.node, "A document head must be unconditional.");
		if (scan.conditionalComponent) reject(path.node, "A document root component must be unconditional.");
		if (scan.heads.length > 1) reject(path.node, "A document entry must contain one document head.");
		if (scan.heads.length === 1) return {
			kind: "head",
			opening: scan.heads[0]
		};
		if (scan.components.length > 1) reject(path.node, "A document entry has multiple unresolved component roots.");
		return scan.components.length === 1 ? resolveJsxComponent(scan.components[0]) : void 0;
	}
	/**
	* Resolve a value that is already rendered JSX. Function definitions and
	* component$ factories are deliberately excluded here: they are definitions
	* which may be resolved when they are exported, but returning one from a
	* document callable does not render it.
	*/
	function resolveRenderedValue(input, seen = /* @__PURE__ */ new Set()) {
		const path = unwrap(input);
		if (path.isJSXElement() || path.isJSXFragment()) return resolveJsx(path);
		if (path.isIdentifier()) {
			const binding = path.scope.getBinding(path.node.name);
			if (!binding || binding.kind !== "const" || !binding.constant || !binding.path.isVariableDeclarator() || seen.has(binding)) return;
			const init = binding.path.get("init");
			if (!init.isExpression()) return void 0;
			const next = new Set(seen);
			next.add(binding);
			return resolveRenderedValue(init, next);
		}
		if (path.isCallExpression() && isPublicRender(importedTarget(path.get("callee")))) {
			const argument = expressionArgument(path, 0);
			return argument ? resolveRenderedValue(argument) : void 0;
		}
	}
	function resolveRendererObject(input, seen = /* @__PURE__ */ new Set(), field = "jsx") {
		const path = unwrap(input);
		if (path.isIdentifier()) {
			const binding = path.scope.getBinding(path.node.name);
			if (!binding || binding.kind !== "const" || !binding.constant || !binding.path.isVariableDeclarator() || seen.has(binding)) return void 0;
			if (binding.path.parentPath?.parentPath?.isExportNamedDeclaration() || binding.referencePaths.some((reference) => reference.node !== path.node)) reject(path.node, `A renderer options alias cannot escape or be mutated before resolving ${field}.`);
			const init = binding.path.get("init");
			if (!init.isExpression()) return void 0;
			const next = new Set(seen);
			next.add(binding);
			return resolveRendererObject(init, next, field);
		}
		if (!path.isObjectExpression()) return void 0;
		let jsx;
		for (const property of path.get("properties")) {
			if (property.isSpreadElement()) {
				if (jsx) reject(property.node, `A renderer result cannot have an unknown spread after ${field}.`);
				continue;
			}
			if (!property.isObjectProperty() && !property.isObjectMethod()) return void 0;
			const key = objectKey(property);
			if (key === void 0) {
				if (jsx) reject(property.node, `A renderer result cannot have an unknown computed property after ${field}.`);
				continue;
			}
			if (key !== field) continue;
			if (!property.isObjectProperty()) return void 0;
			const value = property.get("value");
			if (!value.isExpression()) return void 0;
			jsx = value;
		}
		return jsx ? field === "render" ? resolveNode(jsx) : resolveRenderedValue(jsx) : void 0;
	}
	function resolveRendererCallback(input, seen = /* @__PURE__ */ new Set()) {
		const path = unwrap(input);
		if (path.isIdentifier()) {
			const binding = path.scope.getBinding(path.node.name);
			if (!binding || binding.kind !== "const" || !binding.constant || !binding.path.isVariableDeclarator() || seen.has(binding)) return void 0;
			const init = binding.path.get("init");
			if (!init.isExpression()) return void 0;
			const next = new Set(seen);
			next.add(binding);
			return resolveRendererCallback(init, next);
		}
		if (!path.isArrowFunctionExpression() && !path.isFunctionExpression()) return void 0;
		const callable = path;
		if (callable.node.async || callable.node.generator) reject(callable.node, "A createRenderer callback must be synchronous.");
		const returned = callableReturn(callable);
		return returned ? resolveRendererObject(returned) : void 0;
	}
	function isPublicRender(target) {
		return target?.source === "@qwik.dev/core/server" && (target.imported === "renderToString" || target.imported === "renderToStream");
	}
	function isMiddlewareFactory(target) {
		if (target?.source === "@qwik.dev/router/ssg" && target.imported === "startWorker") return true;
		return !!target && /^@qwik\.dev\/router\/middleware\/[^/]+$/.test(target.source) && (target.imported === "createQwikRouter" || target.imported === "createQwikCity");
	}
	function resolveCall(path) {
		const target = importedTarget(path.get("callee"));
		const argument = expressionArgument(path, 0);
		if (target?.source === "@qwik.dev/core" && target.imported === "component$") {
			if (!argument) return void 0;
			const callback = unwrap(argument);
			if (!callback.isArrowFunctionExpression() && !callback.isFunctionExpression()) return void 0;
			const callable = callback;
			if (callable.node.async || callable.node.generator) reject(callable.node, "A document root component must be synchronous.");
			const returned = callableReturn(callable);
			return returned ? resolveRenderedValue(returned) : void 0;
		}
		if (isPublicRender(target)) return argument ? resolveRenderedValue(argument) : void 0;
		if (target?.source === "@qwik.dev/router" && target.imported === "createRenderer") return argument ? resolveRendererCallback(argument) : void 0;
		if (isMiddlewareFactory(target)) return argument ? resolveRendererObject(argument, /* @__PURE__ */ new Set(), "render") : void 0;
	}
	function resolveCallable(path) {
		if (resolvingCallables.has(path.node)) return void 0;
		resolvingCallables.add(path.node);
		try {
			let returned = callableReturn(path);
			if (!returned) return void 0;
			let candidate = unwrap(returned);
			if (path.node.async && candidate.isAwaitExpression()) {
				const argument = candidate.get("argument");
				if (argument.isExpression()) candidate = unwrap(argument);
			}
			if (path.node.generator || path.node.async && !candidate.isCallExpression()) reject(path.node, "A document entry must be synchronous or return a public Qwik render call.");
			return resolveRenderedValue(candidate);
		} finally {
			resolvingCallables.delete(path.node);
		}
	}
	function resolveBinding(binding) {
		const importPath = binding.path;
		if (importPath.isImportSpecifier() || importPath.isImportDefaultSpecifier() || importPath.isImportNamespaceSpecifier()) {
			const declaration = importPath.parentPath;
			if (!declaration?.isImportDeclaration()) return void 0;
			const imported = importPath.isImportSpecifier() ? importPath.node.imported.type === "Identifier" ? importPath.node.imported.name : importPath.node.imported.value : importPath.isImportDefaultSpecifier() ? "default" : "*";
			return {
				kind: "reference",
				source: declaration.node.source.value,
				imported
			};
		}
		if (resolvingBindings.has(binding)) return void 0;
		if (importPath.isFunctionDeclaration()) {
			if (!binding.constant) reject(importPath.node, "Document entry aliases must be immutable local bindings.");
			return resolveCallable(importPath);
		}
		if (!binding.constant || binding.kind !== "const" || !importPath.isVariableDeclarator()) reject(importPath.node, "Document entry aliases must be immutable local bindings.");
		resolvingBindings.add(binding);
		try {
			const init = importPath.get("init");
			return init.isExpression() ? resolveNode(init) : void 0;
		} finally {
			resolvingBindings.delete(binding);
		}
	}
	function resolveNode(input) {
		const path = unwrap(input);
		if (path.isJSXElement() || path.isJSXFragment()) return resolveJsx(path);
		if (path.isFunctionDeclaration() || path.isFunctionExpression() || path.isArrowFunctionExpression()) return resolveCallable(path);
		if (path.isCallExpression()) return resolveCall(path);
		if (path.isIdentifier()) {
			const binding = path.scope.getBinding(path.node.name);
			return binding ? resolveBinding(binding) : void 0;
		}
	}
	function resolveExportDeclaration(declaration, name) {
		const id = declaration.isFunctionDeclaration() ? declaration.node.id : declaration.isVariableDeclaration() ? declaration.get("declarations").find((variable) => variable.node.id.type === "Identifier" && variable.node.id.name === name)?.node.id : void 0;
		if (!id) return void 0;
		const binding = declaration.scope.getBinding(id.name);
		return binding ? resolveBinding(binding) : void 0;
	}
	function exportLabel(node) {
		return node.type === "Identifier" ? node.name : node.value;
	}
	for (const statement of module.program.get("body")) {
		if (statement.isExportDefaultDeclaration()) {
			const declaration = statement.get("declaration");
			if (exportName !== "default") continue;
			if (declaration.isExpression() && !declaration.isObjectExpression()) return resolveNode(declaration);
			if (declaration.isFunctionDeclaration()) return declaration.node.id ? resolveExportDeclaration(declaration, declaration.node.id.name) : resolveNode(declaration);
			continue;
		}
		if (!statement.isExportNamedDeclaration()) continue;
		const declaration = statement.get("declaration");
		if (declaration?.isFunctionDeclaration() && declaration.node.id?.name === exportName) return resolveExportDeclaration(declaration, exportName);
		if (declaration?.isVariableDeclaration()) for (const variable of declaration.get("declarations")) {
			if (variable.node.id.type !== "Identifier" || variable.node.id.name !== exportName) continue;
			return resolveExportDeclaration(declaration, exportName);
		}
		for (const specifier of statement.get("specifiers")) {
			if (!specifier.isExportSpecifier() || exportLabel(specifier.node.exported) !== exportName) continue;
			const source = statement.node.source?.value;
			const imported = exportLabel(specifier.node.local);
			if (source) return {
				kind: "reference",
				source,
				imported
			};
			const local = specifier.get("local");
			return local.isExpression() ? resolveNode(local) : void 0;
		}
		if (exportName !== "default" && statement.isExportNamedDeclaration() && statement.node.source && statement.node.specifiers.length === 0) return {
			kind: "reference",
			source: statement.node.source.value,
			imported: exportName
		};
	}
	if (exportName !== "default") return void 0;
	const middleware = [];
	module.program.traverse({
		Function(path) {
			path.skip();
		},
		Class(path) {
			path.skip();
		},
		CallExpression(path) {
			if (!isMiddlewareFactory(importedTarget(path.get("callee")))) return;
			for (let parent = path.parentPath; parent && !parent.isProgram(); parent = parent.parentPath) if (parent.isConditionalExpression() || parent.isLogicalExpression() || parent.isIfStatement() || parent.isSwitchStatement() || parent.isLoop() || parent.isTryStatement()) reject(path.node, "A middleware document renderer must be constructed unconditionally at module scope.");
			const argument = expressionArgument(path, 0);
			const result = argument ? resolveRendererObject(argument, /* @__PURE__ */ new Set(), "render") : void 0;
			if (result) middleware.push(result);
			else reject(path.node, "Cannot prove the static render binding of the Qwik middleware factory.");
		}
	});
	const unique = /* @__PURE__ */ new Map();
	for (const result of middleware) unique.set(result.kind === "head" ? result.opening.node : JSON.stringify([result.source, result.imported]), result);
	if (unique.size > 1) reject(module.program.node, "An adapter input must declare one statically known middleware document renderer.");
	if (unique.size === 1) return unique.values().next().value;
}

//#endregion
//#region src/style-imports.ts
/** Replace only runtime named style imports; all other Qwik bindings retain their source. */
function rewriteStyleImports(code, file, replacement, generatedPack = false, serverReplacement) {
	const parsed = parseStyleModule(code, file);
	const output = new MagicString(code);
	let changed = false;
	if (generatedPack) {
		const hooks = [];
		parsed.program.traverse({ CallExpression(path) {
			if (path.node.callee.type !== "Identifier" || path.node.callee.name !== "useStyles$") return;
			const binding = path.scope.getBinding("useStyles$");
			if (binding?.path.node.type !== "ImportSpecifier" || binding.path.parent.type !== "ImportDeclaration" || binding.path.parent.source.value !== "@qwik.dev/core") return;
			const args = path.node.arguments;
			if (args.length !== 1 || args[0]?.type !== "StringLiteral") throw new Error("Generated StylePack requires one literal useStyles$ argument.");
			hooks.push(args[0].end);
		} });
		if (hooks.length !== 1) throw new Error("Generated StylePack requires exactly one useStyles$ hook.");
		output.appendLeft(hooks[0], ",true");
	}
	parsed.program.traverse({ ImportDeclaration(path) {
		const node = path.node;
		const server = node.source.value === "@qwik.dev/core/server" && serverReplacement;
		if (!server && node.source.value !== "@qwik.dev/core" || node.importKind === "type") return;
		const selected = node.specifiers.filter((item) => item.type === "ImportSpecifier" && item.importKind !== "type" && (server ? ["renderToString", "renderToStream"] : ["useStyles$", "useStylesScoped$"]).includes(item.imported.type === "Identifier" ? item.imported.name : item.imported.value));
		if (!selected.length) return;
		const retained = node.specifiers.filter((item) => !selected.includes(item));
		const importText = (items, source) => {
			const normal = items.filter((item) => item.type !== "ImportSpecifier").map((item) => code.slice(item.start, item.end));
			const named = items.filter((item) => item.type === "ImportSpecifier").map((item) => code.slice(item.start, item.end));
			if (named.length) normal.push(`{${named.join(",")}}`);
			return `import ${normal.join(",")} from ${JSON.stringify(source)}${code.slice(node.source.end, node.end)}`;
		};
		output.overwrite(node.start, node.end, `${retained.length ? importText(retained, node.source.value) + "\n" : ""}${importText(selected, server || replacement)}`);
		changed = true;
	} });
	if (!changed) return;
	return {
		code: output.toString(),
		map: output.generateMap({
			hires: true,
			source: file,
			includeContent: true
		})
	};
}

//#endregion
//#region src/style-retry.ts
function importedNamedBinding(path, source, imported) {
	if (!path.isIdentifier()) return void 0;
	const binding = path.scope.getBinding(path.node.name);
	if (!binding || !binding.path.isImportSpecifier()) return void 0;
	const specifier = binding.path;
	const declaration = specifier.parentPath;
	if (!declaration?.isImportDeclaration() || declaration.node.source.value !== source) return void 0;
	if (declaration.node.importKind === "type" || specifier.node.importKind === "type") return void 0;
	if ((specifier.node.imported.type === "Identifier" ? specifier.node.imported.name : specifier.node.imported.value) !== imported) return void 0;
	return {
		binding,
		declaration,
		specifier,
		local: specifier.node.local.name
	};
}
function dynamicImportFromArrow(arrow) {
	if (arrow.node.async || arrow.node.params.length !== 0) return void 0;
	const body = arrow.get("body");
	if (body.isImportExpression() && body.node.source.type === "StringLiteral") return body;
	if (!body.isBlockStatement() || body.node.body.length !== 1) return void 0;
	const statement = body.get("body.0");
	if (!statement.isReturnStatement() || !statement.node.argument) return void 0;
	const argument = statement.get("argument");
	if (argument.isImportExpression() && argument.node.source.type === "StringLiteral") return argument;
}
function candidateForMarkedHook(call, hookImport) {
	const args = call.node.arguments;
	if (args.length !== 2 || args[1]?.type !== "BooleanLiteral" || args[1].value !== true) return "malformed";
	const qrlArgument = args[0];
	if (!qrlArgument || qrlArgument.type !== "Identifier") return "malformed";
	const qrlBinding = call.scope.getBinding(qrlArgument.name);
	if (!qrlBinding?.path.isVariableDeclarator() || !qrlBinding.constant) return void 0;
	const declarator = qrlBinding.path;
	if (!declarator.node.id || declarator.node.id.type !== "Identifier" || !declarator.node.init) return void 0;
	if (!declarator.node.init || declarator.node.init.type !== "CallExpression") return void 0;
	const init = declarator.get("init");
	if (!init.isCallExpression()) return void 0;
	const callee = init.get("callee");
	if (!callee.isIdentifier()) return void 0;
	if (!importedNamedBinding(callee, "@qwik.dev/core", "qrl")) return void 0;
	const firstArgument = init.get("arguments.0");
	if (!firstArgument || Array.isArray(firstArgument) || !firstArgument.isArrowFunctionExpression()) return "malformed";
	const dynamicImport = dynamicImportFromArrow(firstArgument);
	if (!dynamicImport) return "malformed";
	return {
		dependency: dynamicImport.node.source.value,
		dynamicImport,
		hookImport
	};
}
function allBindingNames(program) {
	const names = /* @__PURE__ */ new Set();
	program.traverse({
		ReferencedIdentifier(path) {
			names.add(path.node.name);
		},
		Scope(path) {
			for (const name of Object.keys(path.scope.bindings)) names.add(name);
		}
	});
	return names;
}
function localNameForRetry(candidate, program, runtime) {
	let existing;
	program.traverse({ ImportSpecifier(path) {
		if (existing || path.node.importKind === "type") return;
		const declaration = path.parentPath;
		if (!declaration?.isImportDeclaration() || declaration.node.source.value !== runtime || declaration.node.importKind === "type") return;
		if ((path.node.imported.type === "Identifier" ? path.node.imported.name : path.node.imported.value) !== "retryStyleImport") return;
		const binding = path.scope.getBinding(path.node.local.name);
		if (binding) existing = {
			binding,
			declaration,
			specifier: path,
			local: path.node.local.name
		};
	} });
	if (existing && candidate.dynamicImport.scope.getBinding(existing.local) === existing.binding) return {
		local: existing.local,
		addImport: false
	};
	const names = allBindingNames(program);
	let local = "retryStyleImport";
	let suffix = 1;
	while (names.has(local) || candidate.dynamicImport.scope.getBinding(local)) local = `retryStyleImport_${suffix++}`;
	return {
		local,
		addImport: true
	};
}
function addRetryImport(output, candidate, local, runtime) {
	const importedText = local === "retryStyleImport" ? local : `retryStyleImport as ${local}`;
	const lastNamed = [...candidate.hookImport.declaration.node.specifiers].reverse().find((specifier) => specifier.type === "ImportSpecifier");
	if (lastNamed?.end != null) {
		output.appendLeft(lastNamed.end, `, ${importedText}`);
		return;
	}
	output.appendLeft(candidate.hookImport.declaration.node.start ?? 0, `import { ${importedText} } from ${JSON.stringify(runtime)};\n`);
}
/**
* Recognize and prepare the generated StylePack owner used for CSS import retry.
*
* The marker is the second `true` argument to an imported `useStylesQrl` call.
* Every other hook shape is ignored, while a marked but malformed hook causes
* this function to return no plan rather than guessing at authored code.
*/
function planStyleImportRetry(code, file, runtime) {
	const module = parseStyleModule(code, file);
	const hookImports = [];
	module.program.traverse({ ImportSpecifier(path) {
		const declaration = path.parentPath;
		if (!declaration?.isImportDeclaration() || declaration.node.source.value !== runtime || declaration.node.importKind === "type" || path.node.importKind === "type") return;
		if ((path.node.imported.type === "Identifier" ? path.node.imported.name : path.node.imported.value) !== "useStylesQrl") return;
		const binding = path.scope.getBinding(path.node.local.name);
		if (binding) hookImports.push({
			binding,
			declaration,
			specifier: path,
			local: path.node.local.name
		});
	} });
	if (!hookImports.length) return void 0;
	const marked = [];
	let malformed = false;
	module.program.traverse({ CallExpression(path) {
		if (path.node.callee.type !== "Identifier") return;
		const hookBinding = path.scope.getBinding(path.node.callee.name);
		const hookImport = hookImports.find((item) => item.binding === hookBinding);
		if (!hookImport) return;
		const args = path.node.arguments;
		if (args[1]?.type !== "BooleanLiteral" || args[1].value !== true) return;
		const candidate = candidateForMarkedHook(path, hookImport);
		if (candidate === "malformed") malformed = true;
		else if (candidate) marked.push(candidate);
	} });
	if (malformed) throw new Error("Generated StylePack has a malformed marked useStylesQrl hook.");
	if (marked.length > 1) throw new Error("Generated StylePack requires exactly one marked useStylesQrl hook.");
	if (marked.length === 0) return void 0;
	const candidate = marked[0];
	const names = localNameForRetry(candidate, module.program, runtime);
	return {
		dependency: candidate.dependency,
		render(urlExpression) {
			const output = new MagicString(code);
			const importStart = candidate.dynamicImport.node.start;
			const importEnd = candidate.dynamicImport.node.end;
			if (importStart == null || importEnd == null) return {
				code: output.toString(),
				map: output.generateMap({
					hires: true,
					source: file,
					includeContent: true
				})
			};
			const originalImport = code.slice(importStart, importEnd);
			output.overwrite(importStart, importEnd, `${names.local}(()=>${originalImport}, ${urlExpression})`);
			if (names.addImport) addRetryImport(output, candidate, names.local, runtime);
			return {
				code: output.toString(),
				map: output.generateMap({
					hires: true,
					source: file,
					includeContent: true
				})
			};
		}
	};
}

//#endregion
export { analyzeClassValues, analyzeStyleModule, attachUtilityFoundation, collectCssPropSites, composeUtilityStates, emitStyleEvaluation, emitStyleModule, evaluateStatic, findComponentOwner, isCssMacro, isQwikComponent, lowerStyleExpression, parseStyleCss, parseStyleModule, planStyleImportRetry, planStyleSite, resolveDocumentEntry, resolveImportedBinding, resolveStyleGlobals, rewriteStyleImports, selectorClassNames, sourceSpan, utilityAuxiliaryNodes, utilityRequests, validateAuthoringUses };
//# sourceMappingURL=index.mjs.map