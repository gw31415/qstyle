#!/usr/bin/env node
// baseline cousin (`baseline/`) の generator (旧 plan.md C0.1)。
// qstyle OFF 時と意味的に同一の CSS を `useStyles$` ではなく素朴な global CSS +
// class で再現する。Gate P0.1 (OFF/ON の getComputedStyle 一致) の差分対象。
//
// 対応する fixture 側の記法 (これ以外が出たら throw して generator を止める):
// - `css={{...}}` flat static object (string/number 値のみ)
// - `css={sharedBox}` (shared.tsx の module-scope `css({...})` static のみ)
// - dyn-box の `width: width.value` (member 式) は inline `style` に落とす
// - 既存 class 属性との併用は無い (assert する)
//
// 出力: baseline/src/** (+ baseline.css)、baseline 側の build は
// baseline/scripts/build.mjs (= 本 script のある dir の build.mjs の copy)。
// baseline/vite.config.ts 等の静的 file は手管理 (qstyle 抜きの対応物)。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, '..');
const srcDir = path.join(fixtureRoot, 'src');
const baselineSrc = path.join(fixtureRoot, 'baseline', 'src');

const UNITLESS = new Set([
  'opacity',
  'z-index',
  'zIndex',
  'font-weight',
  'fontWeight',
  'line-height',
  'lineHeight',
  'flex',
  'flex-grow',
  'flexGrow',
  'flex-shrink',
  'flexShrink',
  'order',
]);

function fail(message) {
  throw new Error(`gen-baseline: ${message}`);
}

function kebab(prop) {
  return prop.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

function cssValue(prop, value) {
  const text = value.trim();
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    return UNITLESS.has(prop) ? text : `${text}px`;
  }
  // var() 等の関数形は verbatim (interpolation 混じりは別途 fail)。
  if (/^[a-zA-Z-]+\(.*\)$/.test(text)) {
    if (text.includes('${')) fail(`interpolation in ${text}`);
    return text;
  }
  fail(`unsupported value ${text} for ${prop}`);
}

/** `{...}` の balanced scan。open は `{` の位置。閉じの exclusive index を返す。 */
function matchBrace(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote !== null) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** flat object literal 本体 (`{` `}` 除く) を [prop, value] 列にする。
 * 値は static scalar のほか 1 段 nested object (`&:hover` 等) を受け付ける。 */
function parseFlatObject(body) {
  const entries = [];
  // top-level comma で分割 (brace depth 考慮。string 内は無視)。
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote !== null) {
      current += ch;
      if (ch === '\\') {
        current += body[i + 1] ?? '';
        i++;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  for (const part of parts) {
    if (part.trim() === '') continue;
    // quote/brace 外の最初の `:` で分割する (`:where()` 内の colon 対策)。
    let colon = -1;
    let depth = 0;
    let quote = null;
    for (let i = 0; i < part.length; i++) {
      const ch = part[i];
      if (quote !== null) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === ':' && depth === 0) {
        colon = i;
        break;
      }
    }
    if (colon < 0) fail(`cannot parse declaration ${part.trim()}`);
    const prop = part.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
    const value = part.slice(colon + 1).trim();
    if (prop === '' || value === '') fail(`empty declaration in ${part.trim()}`);
    entries.push([prop, value]);
  }
  return entries;
}

/** nested key (`&:where(.g-on)` 等) を class 付き selector にする。`&` 始まりのみ対応。 */
function expandNestedKey(cls, key) {
  if (!key.startsWith('&')) fail(`non-& nested key ${key}`);
  return `.${cls}${key.slice(1)}`;
}

/** static scalar / var() 等の関数値か (dynamic 判定用)。 */
function isStaticValue(value) {
  const text = value.trim();
  if (/^(['"].*['"]|-?\d+(\.\d+)?)$/.test(text)) return true;
  return /^[a-zA-Z-]+\(.*\)$/.test(text) && !text.includes('${');
}

function listTsx(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsx(full));
    else if (entry.isFile() && entry.name.endsWith('.tsx')) out.push(full);
  }
  return out.sort();
}

const rules = [];
let classCounter = 0;
const newClass = () => `qb-${classCounter++}`;

/** shared.tsx の `css({...})` literal を抜く。 */
function resolveSharedBox() {
  const shared = fs.readFileSync(path.join(srcDir, 'components', 'shared.tsx'), 'utf8');
  const m = /const sharedBox = css\(\{/.exec(shared);
  if (m === null) fail('sharedBox definition not found');
  const open = m.index + m[0].length - 1;
  const close = matchBrace(shared, open);
  if (close < 0) fail('sharedBox literal unbalanced');
  return shared.slice(open + 1, close - 1);
}

const sharedBody = resolveSharedBox();

function convertFile(relPath) {
  let src = fs.readFileSync(path.join(srcDir, relPath), 'utf8');
  // shared.tsx: handle 定義と css import を消す (利用側は class 化する)。
  if (relPath === path.join('components', 'shared.tsx')) {
    src = src.replace(/import \{ css \} from '@qstyle\/qwik';\n/, '');
    const m = /export const sharedBox = css\(\{/.exec(src);
    if (m === null) fail('sharedBox export not found');
    const open = m.index + m[0].length - 1;
    const close = matchBrace(src, open);
    if (close < 0) fail('sharedBox export unbalanced');
    // `export const sharedBox = css({...});` 全体を消す (末尾 `;` まで)。
    const semi = src.indexOf(';', close);
    src = src.slice(0, m.index) + src.slice(semi < 0 ? close : semi + 1);
  }
  // `css={sharedBox}` → class。
  if (src.includes('css={sharedBox}')) {
    const cls = newClass();
    rules.push([cls, parseFlatObject(sharedBody), []]);
    src = src.replaceAll('css={sharedBox}', `class="${cls}"`);
  }
  // `css={{...}}` → class (+ dyn-box の width は inline style)。
  for (;;) {
    const marker = 'css={{';
    const at = src.indexOf(marker);
    if (at < 0) break;
    const open = at + 'css={'.length;
    const close = matchBrace(src, open);
    if (close < 0) fail(`css literal unbalanced in ${relPath}`);
    // css={{ の直後に `}` が来るか (object scanner (a) 相当の形のみ対応)。
    const body = src.slice(open + 1, close - 1);
    const entries = parseFlatObject(body);
    // tag に既存 class/className があれば merge する (g-where 用)。
    const tagStart = src.lastIndexOf('<', at);
    const head = src.slice(tagStart, at);
    const classAttr = /class(Name)?\s*=\s*(["'])(.*?)\2/.exec(head);
    const dynamics = entries.filter(
      ([, value]) => !isStaticValue(value) && !value.trim().startsWith('{'),
    );
    if (dynamics.length > 1) fail(`multiple dynamics in ${relPath}: ${dynamics.map(([p]) => p)}`);
    const dynamic = dynamics[0];
    const nested = entries.filter(([, value]) => value.trim().startsWith('{'));
    if (nested.length > 0 && dynamic !== undefined) {
      fail(`nested + dynamic mix in ${relPath}`);
    }
    const statics = entries.filter(
      ([p]) => dynamic === undefined || p !== dynamic[0],
    );
    const nestedStatics = [];
    for (const [key, value] of nested) {
      const inner = value.trim();
      const innerBody = inner.slice(1, inner.lastIndexOf('}'));
      for (const [iprop, ivalue] of parseFlatObject(innerBody)) {
        if (!isStaticValue(ivalue)) fail(`nested dynamic ${ivalue} in ${relPath}`);
        nestedStatics.push([key, iprop, ivalue]);
      }
    }
    const cls = newClass();
    rules.push([cls, statics, nestedStatics]);
    let stylePart = '';
    if (dynamic !== undefined) {
      // member 式のみ inline style に落とす (fixture は width.value のみ)。
      if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(dynamic[1].trim())) {
        fail(`unsupported dynamic ${dynamic[1]} in ${relPath}`);
      }
      stylePart = ` style={{ ${dynamic[0]}: ${dynamic[1].trim()} }}`;
    }
    if (classAttr !== null) {
      // 既存 class がある場合は merge する。css span 削除を先に行い
      // (head より後ろのため head offset に影響しない)、次に head を置換する。
      const withoutCss = src.slice(0, at) + src.slice(close + 1);
      const keyword = classAttr[1] === 'Name' ? 'className' : 'class';
      const mergedAttr = `${keyword}=${classAttr[2]}${classAttr[3]} ${cls}${classAttr[2]}${stylePart}`;
      const headEnd = tagStart + head.length;
      const newHead = withoutCss.slice(tagStart, headEnd).replace(classAttr[0], mergedAttr);
      src = withoutCss.slice(0, tagStart) + newHead + withoutCss.slice(headEnd);
    } else {
      src = src.slice(0, at) + `class="${cls}"${stylePart}` + src.slice(close + 1);
    }
  }
  if (src.includes('css={{') || src.includes('css={') || src.includes('sharedBox')) {
    fail(`unconverted css usage remains in ${relPath}`);
  }
  return src;
}

fs.rmSync(path.join(fixtureRoot, 'baseline', 'src'), { recursive: true, force: true });
for (const full of listTsx(srcDir)) {
  const rel = path.relative(srcDir, full);
  const out = path.join(baselineSrc, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, convertFile(rel));
}
// 非 tsx は verbatim copy (css / entry / d.ts)。
for (const rel of ['components/legacy-global.css', 'components/legacy-a.css', 'components/legacy-b.css']) {
  const out = path.join(baselineSrc, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(path.join(srcDir, rel), out);
}
for (const rel of ['entry.ssr.tsx', 'entry.node-server.tsx', 'qstyle.d.ts']) {
  fs.copyFileSync(path.join(srcDir, rel), path.join(baselineSrc, rel));
}
// root に baseline.css を読ませる。
{
  const rootPath = path.join(baselineSrc, 'root.tsx');
  let root = fs.readFileSync(rootPath, 'utf8');
  if (!root.includes('baseline.css')) {
    root = `import './baseline.css';\n${root}`;
  }
  fs.writeFileSync(rootPath, root);
}
let css = '/* baseline global (gen-baseline.mjs). qstyle OFF 時の意味的等価物。 */\n';
for (const [cls, entries, nestedEntries] of rules) {
  css += `.${cls} {\n`;
  for (const [prop, value] of entries) {
    // dynamic は baseline.css に書かない (inline style 側)。
    if (isStaticValue(value)) {
      css += `  ${kebab(prop)}: ${cssValue(prop, value)};\n`;
    }
  }
  css += '}\n';
  for (const [key, iprop, ivalue] of nestedEntries ?? []) {
    css += `${expandNestedKey(cls, key)} {\n  ${kebab(iprop)}: ${cssValue(iprop, ivalue)};\n}\n`;
  }
}
fs.writeFileSync(path.join(baselineSrc, 'baseline.css'), css);
console.log(`baseline: ${rules.length} classes`);
