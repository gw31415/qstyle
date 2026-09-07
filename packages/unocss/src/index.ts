// @qstyle/unocss — Tailwind 方式 class の解決 (UnoCSS 内蔵・完全置換)。
// engine (user config 駆動) を内蔵し、atom 化と verbatim fallback を返す。
// 値の焼き込みはしない。theme 定義は globals に同梱する。
// qstyle 本体より前に置く Vite plugin (`UnoCSS()`) を出す。
// 本体はこの plugin の存在を知らない。
// `@unocss/vite` との入れ替え用に、本家の公開値をそのまま出す。
// default だけは置換本体 (`UnoCSS`) が取る。
export { tokenizeClassAttr } from './tokenize.js';
export { collectLiteralSpans, collectLiteralTokens, findDynamicClassExprs } from './plugin.js';
export { aliasForUtilityToken } from './plugin.js';
export { createUnoResolver, loadUnoConfig, orderRiskProperty } from './resolve.js';
export type { UnoGlobals, UnoResolveResult, UnoResolver } from './resolve.js';
export type { UnoGenerator, UserConfig } from 'unocss';
export { UnoCSS, UnoCSS as default } from './plugin.js';
export type { QstyleUnoOptions, QstyleUnoPlugin } from './plugin.js';
// tooling 用の CSS rule parser (differential test 等)。
export { parseCssRules } from './parse.js';
export type { CssWrapper, RawDecl, RawRule } from './parse.js';
// ponytail: 本家の公開値は透過的にそのまま横流しする (確認も列挙もしない)。
// `default` は `export *` に含まれないため置換本体が取る。
export * from '@unocss/vite';
