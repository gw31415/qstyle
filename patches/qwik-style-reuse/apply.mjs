#!/usr/bin/env node
/**
 * Apply the narrowly scoped native style reuse candidate to an untouched
 * @qwik.dev/core 2.0.0-beta.43 package copy.
 *
 * This is deliberately a source-copy patcher rather than a dependency
 * override. It refuses a different package version or different upstream
 * bytes, then writes a disposable candidate package to --output.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchServerHead, patchServerHeadProd } from './server-head.mjs';

const EXPECTED_VERSION = '2.0.0-beta.43';
const EXPECTED_DIST = {
  'server.prod.mjs': {
    bytes: 145954,
    sha256: '72ac5db5535e0c33015a5148db339e2632c8157e15d988220a1c5c451e971976',
  },
  'server.mjs': {
    bytes: 153734,
    sha256: '799cc441edff3e11d13a1044547efaf9a3943941e39c93a47b9d5727909f523e',
  },
  'core.mjs': {
    bytes: 683099,
    sha256: '2d4a32fd08055c2dc861216a21685fc1c7d193d730be55d3067c1384ee359a4e',
  },
  'core.prod.mjs': {
    bytes: 306593,
    sha256: '694db92f1bc46da08743eed96516ca1c1e4a67ec4f9ad172beb308d281510104',
  },
  'core.min.mjs': {
    bytes: 145870,
    sha256: '8ecad51bf7f89da6db2bffb0dc751b87bc196d98c2e4191b9a8fc3cce902d024',
  },
};

const readUtf8 = (file) => readFileSync(file, 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function replaceOnce(source, expected, replacement, label) {
  const first = source.indexOf(expected);
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`Qwik style reuse patch anchor mismatch: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + expected.length);
}

function assertBaseline(sourceRoot) {
  const packageJsonPath = resolve(sourceRoot, 'package.json');
  const packageJson = JSON.parse(readUtf8(packageJsonPath));
  if (packageJson.version !== EXPECTED_VERSION) {
    throw new Error(`expected @qwik.dev/core ${EXPECTED_VERSION}, got ${String(packageJson.version)}`);
  }
  for (const [name, expected] of Object.entries(EXPECTED_DIST)) {
    const file = resolve(sourceRoot, 'dist', name);
    if (!existsSync(file)) throw new Error(`missing @qwik.dev/core dist file: ${file}`);
    const bytes = readFileSync(file);
    const digest = sha256(bytes);
    if (bytes.length !== expected.bytes || digest !== expected.sha256) {
      throw new Error(
        `baseline mismatch for dist/${name}: bytes=${bytes.length} sha256=${digest}; `
          + `expected bytes=${expected.bytes} sha256=${expected.sha256}`,
      );
    }
  }
}

const CORE_HELPERS = String.raw`

// Native style reuse candidate. Keep this guard in Qwik's style owner so an
// existing SSR style is known before resolving the CSS QRL. This is intentionally
// internal to this exact Qwik build; application code does not call these helpers.
const nativeStyleResolutions = new WeakMap();
const nativeEnsureStyleIds = (container) => {
    if (container.$styleIds$ == null) {
        container.$styleIds$ = new Set();
        const styleElements = container.document.querySelectorAll(QStyleSelector);
        for (let i = 0; i < styleElements.length; i++) {
            container.$styleIds$.add(styleElements[i].getAttribute(QStyle));
        }
    }
    return container.$styleIds$;
};
const nativeHasStyle = (container, styleId, host, scoped) => {
    if (container.document == null) {
        return false;
    }
    if (scoped) {
        const scopedStyleIdsString = container.getHostProp(host, QScopedStyle);
        const scopedStyleIds = new Set(convertScopedStyleIdsToArray(scopedStyleIdsString));
        scopedStyleIds.add(styleId);
        container.setHostProp(host, QScopedStyle, convertStyleIdsToString(scopedStyleIds));
    }
    const styleIds = nativeEnsureStyleIds(container);
    const styleElements = container.document.querySelectorAll(QStyleSelector);
    for (let i = 0; i < styleElements.length; i++) {
        if (styleElements[i].getAttribute(QStyle) === styleId) {
            styleIds.add(styleId);
            return true;
        }
    }
    // Reconcile the Set if another operation removed the style node.
    styleIds.delete(styleId);
    return false;
};
const nativeResolveStyle = (container, styleQrl, styleId, transform, host, scoped) => {
    let pendingById = nativeStyleResolutions.get(container);
    if (pendingById == null) {
        pendingById = new Map();
        nativeStyleResolutions.set(container, pendingById);
    }
    let entry = pendingById.get(styleId);
    if (entry == null) {
        entry = { promise: styleQrl.resolve(), pending: 0 };
        pendingById.set(styleId, entry);
    }
    entry.pending++;
    const finish = () => {
        entry.pending--;
        if (entry.pending === 0 && pendingById.get(styleId) === entry) {
            pendingById.delete(styleId);
        }
    };
    return entry.promise.then(
        (value) => {
            try {
                container.$appendStyle$(transform(value, styleId), styleId, host, scoped);
            }
            finally {
                finish();
            }
        },
        (error) => {
            finish();
            throw error;
        },
    );
};
`;

const CORE_MJS_APPEND = String.raw`    $appendStyle$(content, styleId, host, scoped) {
        if (scoped) {
            const scopedStyleIdsString = this.getHostProp(host, QScopedStyle);
            const scopedStyleIds = new Set(convertScopedStyleIdsToArray(scopedStyleIdsString));
            scopedStyleIds.add(styleId);
            this.setHostProp(host, QScopedStyle, convertStyleIdsToString(scopedStyleIds));
        }
        if (this.$styleIds$ == null) {
            this.$styleIds$ = new Set();
            const styleElements = this.document.querySelectorAll(QStyleSelector);
            for (let i = 0; i < styleElements.length; i++) {
                const style = styleElements[i];
                this.$styleIds$.add(style.getAttribute(QStyle));
            }
        }
        if (!this.$styleIds$.has(styleId)) {
            this.$styleIds$.add(styleId);
            const styleElement = this.document.createElement('style');
            styleElement.setAttribute(QStyle, styleId);
            styleElement.textContent = content;
            this.document.head.appendChild(styleElement);
        }
    }
`;
const CORE_MJS_APPEND_PATCHED = String.raw`    $appendStyle$(content, styleId, host, scoped) {
        if (!nativeHasStyle(this, styleId, host, scoped)) {
            this.$styleIds$.add(styleId);
            const styleElement = this.document.createElement('style');
            styleElement.setAttribute(QStyle, styleId);
            styleElement.textContent = content;
            this.document.head.appendChild(styleElement);
        }
    }
`;

const CORE_MJS_USE = String.raw`    const styleId = styleKey(styleQrl, i);
    const host = iCtx.$hostElement$;
    set(liveUpdate && doc ? [styleId, doc.__hmrT] : styleId);
    if (styleQrl.resolved) {
        iCtx.$container$.$appendStyle$(transform(styleQrl.resolved, styleId), styleId, host, scoped);
    }
    else {
        throw styleQrl
            .resolve()
            .then((val) => iCtx.$container$.$appendStyle$(transform(val, styleId), styleId, host, scoped));
    }
    return styleId;
`;
const CORE_MJS_USE_PATCHED = String.raw`    const styleId = styleKey(styleQrl, i);
    const host = iCtx.$hostElement$;
    set(liveUpdate && doc ? [styleId, doc.__hmrT] : styleId);
    if (!liveUpdate && nativeHasStyle(iCtx.$container$, styleId, host, scoped)) {
        return styleId;
    }
    if (styleQrl.resolved) {
        iCtx.$container$.$appendStyle$(transform(styleQrl.resolved, styleId), styleId, host, scoped);
    }
    else {
        let pending;
        try {
            pending = nativeResolveStyle(iCtx.$container$, styleQrl, styleId, transform, host, scoped);
        }
        catch (error) {
            set(undefined);
            throw error;
        }
        throw pending.catch((error) => {
            set(undefined);
            throw error;
        });
    }
    return styleId;
`;

const CORE_PROD_HELPERS = String.raw`

// Native style reuse candidate. This guard lives in Qwik's style owner and is
// intentionally not an application runtime or a private API consumed by app code.
const nativeStyleResolutions = new WeakMap();
const nativeEnsureStyleIds = (container) => {
    if (container.Ze == null) {
        container.Ze = new Set;
        const styleElements = container.document.querySelectorAll(Sr);
        for (let i = 0; i < styleElements.length; i++) {
            container.Ze.add(styleElements[i].getAttribute(Er));
        }
    }
    return container.Ze;
};
const nativeHasStyle = (container, styleId, host, scoped) => {
    if (container.document == null) {
        return false;
    }
    if (scoped) {
        const scopedStyleIdsString = container.getHostProp(host, Rr);
        const scopedStyleIds = new Set(scopedStyleIdsString?.split(" ") ?? null);
        scopedStyleIds.add(styleId);
        container.setHostProp(host, Rr, Array.from(scopedStyleIds).join(" "));
    }
    const styleIds = nativeEnsureStyleIds(container);
    const styleElements = container.document.querySelectorAll(Sr);
    for (let i = 0; i < styleElements.length; i++) {
        if (styleElements[i].getAttribute(Er) === styleId) {
            styleIds.add(styleId);
            return true;
        }
    }
    styleIds.delete(styleId);
    return false;
};
const nativeResolveStyle = (container, styleQrl, styleId, transform, host, scoped) => {
    let pendingById = nativeStyleResolutions.get(container);
    if (pendingById == null) {
        pendingById = new Map;
        nativeStyleResolutions.set(container, pendingById);
    }
    let entry = pendingById.get(styleId);
    if (entry == null) {
        entry = { promise: styleQrl.resolve(), pending: 0 };
        pendingById.set(styleId, entry);
    }
    entry.pending++;
    const finish = () => {
        entry.pending--;
        if (entry.pending === 0 && pendingById.get(styleId) === entry) {
            pendingById.delete(styleId);
        }
    };
    return entry.promise.then(
        (value) => {
            try {
                container.er(transform(value, styleId), styleId, host, scoped);
            }
            finally {
                finish();
            }
        },
        (error) => {
            finish();
            throw error;
        },
    );
};
`;

const CORE_PROD_APPEND = String.raw`    er(t, n, e, s) {
        if (s) {
            const t = this.getHostProp(e, Rr);
            const s = new Set(function o(t) {
                return t?.split(" ") ?? null;
            }(t));
            s.add(n);
            this.setHostProp(e, Rr, function r(t) {
                return Array.from(t).join(" ");
            }(s));
        }
        if (this.Ze == null) {
            this.Ze = new Set;
            const t = this.document.querySelectorAll(Sr);
            for (let n = 0; n < t.length; n++) {
                const e = t[n];
                this.Ze.add(e.getAttribute(Er));
            }
        }
        if (!this.Ze.has(n)) {
            this.Ze.add(n);
            const e = this.document.createElement("style");
            e.setAttribute(Er, n);
            e.textContent = t;
            this.document.head.appendChild(e);
        }
    }
`;
const CORE_PROD_APPEND_PATCHED = String.raw`    er(t, n, e, s) {
        if (!nativeHasStyle(this, n, e, s)) {
            this.Ze.add(n);
            const e = this.document.createElement("style");
            e.setAttribute(Er, n);
            e.textContent = t;
            this.document.head.appendChild(e);
        }
    }
`;

const CORE_PROD_USE = `const Jh = (t, n, e) => {
    let {val: s, set: o, iCtx: r, i} = tl();
    if (s) {
        return s;
    }
    const c = ((t, n) => \`\${mi(t.ot)}-\${n}\`)(t, i);
    const l = r._;
    o(c);
    if (!t.resolved) {
        throw t.resolve().then(t => r.$.er(n(t, c), c, l, e));
    }
    r.$.er(n(t.resolved, c), c, l, e);
    return c;
};
`;
const CORE_PROD_USE_PATCHED = `const Jh = (t, n, e) => {
    let {val: s, set: o, iCtx: r, i} = tl();
    if (s) {
        return s;
    }
    const c = ((t, n) => \`\${mi(t.ot)}-\${n}\`)(t, i);
    const l = r._;
    o(c);
    if (nativeHasStyle(r.$, c, l, e)) {
        return c;
    }
    if (!t.resolved) {
        let pending;
        try {
            pending = nativeResolveStyle(r.$, t, c, n, l, e);
        }
        catch (error) {
            o(void 0);
            throw error;
        }
        throw pending.catch((error) => {
            o(void 0);
            throw error;
        });
    }
    r.$.er(n(t.resolved, c), c, l, e);
    return c;
};
`;

const CORE_MIN_HELPERS = String.raw`nativeStyleResolutions=new WeakMap,nativeEnsureStyleIds=t=>{if(null==t.Ze){t.Ze=new Set;const n=t.document.querySelectorAll(Sr);for(let e=0;e<n.length;e++)t.Ze.add(n[e].getAttribute(Er))}return t.Ze},nativeHasStyle=(t,n,e,r)=>{if(null==t.document)return!1;if(r){const r=t.getHostProp(e,Rr),i=new Set(r?.split(" ")??null);i.add(n),t.setHostProp(e,Rr,Array.from(i).join(" "))}const i=nativeEnsureStyleIds(t),s=t.document.querySelectorAll(Sr);for(let t=0;t<s.length;t++)if(s[t].getAttribute(Er)===n)return i.add(n),!0;return i.delete(n),!1},nativeResolveStyle=(t,n,e,r,i,s)=>{let o=nativeStyleResolutions.get(t);null==o&&(o=new Map,nativeStyleResolutions.set(t,o));let l=o.get(e);null==l&&(l={promise:n.resolve(),pending:0},o.set(e,l)),l.pending++;const u=()=>{l.pending--,0===l.pending&&o.get(e)===l&&o.delete(e)};return l.promise.then(n=>{try{t.er(r(n,e),e,i,s)}finally{u()}},t=>(u(),Promise.reject(t)))},`;
const CORE_MIN_APPEND =
  'er(t,n,e,r){if(r){const t=this.getHostProp(e,Rr),r=new Set((t=>t?.split(" ")??null)(t));r.add(n),this.setHostProp(e,Rr,(t=>Array.from(t).join(" "))(r))}if(null==this.Ze){this.Ze=new Set;const t=this.document.querySelectorAll(Sr);for(let n=0;n<t.length;n++){const e=t[n];this.Ze.add(e.getAttribute(Er))}}if(!this.Ze.has(n)){this.Ze.add(n);const e=this.document.createElement("style");e.setAttribute(Er,n),e.textContent=t,this.document.head.appendChild(e)}}';
const CORE_MIN_APPEND_PATCHED =
  'er(t,n,e,r){if(!nativeHasStyle(this,n,e,r)){this.Ze.add(n);const i=this.document.createElement("style");i.setAttribute(Er,n),i.textContent=t,this.document.head.appendChild(i)}}';
const CORE_MIN_USE =
  'Jh=(t,n,e)=>{let{val:r,set:i,iCtx:s,i:o}=tl();if(r)return r;const l=(u=o,`${mi(t.ot)}-${u}`);var u;const c=s._;if(i(l),!t.resolved)throw t.resolve().then(t=>s.$.er(n(t,l),l,c,e));return s.$.er(n(t.resolved,l),l,c,e),l},Yh=';
const CORE_MIN_USE_PATCHED =
  'Jh=(t,n,e)=>{let{val:r,set:i,iCtx:s,i:o}=tl();if(r)return r;const l=(u=o,`${mi(t.ot)}-${u}`);var u;const c=s._;if(i(l),nativeHasStyle(s.$,l,c,e))return l;if(!t.resolved){let nativePending;try{nativePending=nativeResolveStyle(s.$,t,l,n,c,e)}catch(nativeError){i(void 0);throw nativeError}throw nativePending.catch(nativeError=>{i(void 0);throw nativeError})}return s.$.er(n(t.resolved,l),l,c,e),l},Yh=';

function patchCoreMjs(source) {
  source = replaceOnce(source, CORE_MJS_APPEND, CORE_MJS_APPEND_PATCHED, 'core.mjs appendStyle');
  source = source.replace('const _useStyles = (styleQrl, transform, scoped) => {', CORE_HELPERS + 'const _useStyles = (styleQrl, transform, scoped) => {');
  source = replaceOnce(source, CORE_MJS_USE, CORE_MJS_USE_PATCHED, 'core.mjs useStyles');
  return source;
}

function patchCoreProd(source) {
  source = replaceOnce(source, CORE_PROD_APPEND, CORE_PROD_APPEND_PATCHED, 'core.prod.mjs appendStyle');
  source = source.replace('const Jh = (t, n, e) => {', CORE_PROD_HELPERS + 'const Jh = (t, n, e) => {');
  source = replaceOnce(source, CORE_PROD_USE, CORE_PROD_USE_PATCHED, 'core.prod.mjs useStyles');
  return source;
}

function patchCoreMin(source) {
  source = replaceOnce(source, CORE_MIN_APPEND, CORE_MIN_APPEND_PATCHED, 'core.min.mjs appendStyle');
  source = replaceOnce(source, CORE_MIN_USE, CORE_MIN_HELPERS + CORE_MIN_USE_PATCHED, 'core.min.mjs useStyles');
  return source;
}

export function patchQwikCore({ sourceRoot, outputRoot }) {
  const source = resolve(sourceRoot);
  const output = resolve(outputRoot);
  assertBaseline(source);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(dirname(output), { recursive: true });
  cpSync(source, output, { recursive: true, dereference: true });

  const files = {
    'server.prod.mjs': (source) => patchServerHeadProd(source, replaceOnce),
    'server.mjs': (source) => patchServerHead(source, replaceOnce),
    'core.mjs': patchCoreMjs,
    'core.prod.mjs': patchCoreProd,
    'core.min.mjs': patchCoreMin,
  };
  for (const [name, patch] of Object.entries(files)) {
    const file = resolve(output, 'dist', name);
    const original = readUtf8(file);
    const patched = patch(original);
    writeFileSync(file, patched);
  }
  return { sourceRoot: source, outputRoot: output, version: EXPECTED_VERSION };
}

function parseArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const sourceRoot = parseArg('--source') ?? resolve(repoRoot, 'packages/qwik/node_modules/@qwik.dev/core');
  const outputRoot = parseArg('--output');
  if (!outputRoot || !isAbsolute(outputRoot)) {
    throw new Error('usage: apply.mjs --output /absolute/path [--source /absolute/core/package]');
  }
  console.log(JSON.stringify(patchQwikCore({ sourceRoot, outputRoot })));
}
