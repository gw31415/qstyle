import { StaticAtom } from "@qstyle/core";
import { UnoGenerator, UserConfig, UserConfig as UserConfig$1 } from "unocss";
import { UtilityAdapter, UtilityAdapterFactory, UtilityCssNode } from "@qstyle/compiler";
export * from "@unocss/vite";
//#region src/tokenize.d.ts
export declare function tokenizeClassAttr(attrValue: string): string[];
//#endregion
//#region src/plugin.d.ts
/**
 * `@unocss/vite` との入れ替え用引数。`VitePluginConfig` と構造互換
 * (inline config は `uno.config.ts` に merge され、文字列は config path。
 * 未知キーも受け付ける)。vite 固有の出力制御キーは宣言するが無視する。
 * `import type` を持たないのは tsdown の DTS バンドルが vite 系の型を
 * 束ねられないため。`@unocss/vite` のキー追加時はここに足す。
 */
interface QstyleUnoOptions extends UserConfig$1 {
  readonly inspector?: boolean | undefined;
  readonly mode?: "global" | "per-module" | "vue-scoped" | "dist-chunk" | "shadow-dom" | undefined;
  readonly transformCSS?: boolean | "pre" | "post" | undefined;
  readonly postcss?: boolean | undefined;
  readonly hmrTopLevelAwait?: boolean | undefined;
  readonly fetchMode?: "cors" | "navigate" | "no-cors" | "same-origin" | undefined;
  readonly checkImport?: boolean | undefined;
  /**
   * true の場合、互換モード (従来動作): 解決した class を残し、
   * verbatim CSS も原文 selector のまま出す。
   * 未指定/false (既定) の削減モードでは、解決した token を転送物から消す
   * (静的 class は `css` prop か短縮 alias へ、動的 class・class 参照 const は
   * 短縮 alias へ)。実行時に utility class 名を参照するコード
   * (`querySelector('.flex')` 等) との非互換はルールとして許容する。
   */
  readonly preserveClass?: boolean | undefined;
  readonly [key: string]: unknown;
}
/**
 * 最小の Vite plugin 形状 (構造的)。`vite` への依存 (型含む) を持たないため、
 * `import type` もしない。Vite は構造で受け付ける。
 */
interface QstyleUnoPlugin {
  readonly name: "qstyle:unocss";
  readonly enforce: "pre";
  configResolved(config: {
    root?: string;
  }): void;
  configureServer(server: {
    middlewares: {
      use(handler: (req: unknown, res: unknown, next: () => void) => void): void;
    };
  }): void;
  resolveId(id: string): string | null;
  load(id: string): string | null;
  transform(code: string, id: string): Promise<{
    code: string;
    map: null;
  } | null>;
}
/**
 * utility token → 短縮 alias (`qu_<hash8>`)。token の純関数のため
 * module をまたいで同一 token は同一 alias になり、cache 効率が落ちない。
 * `q_` / `qd_` (qstyle 本体) とは prefix が異なり衝突しない。
 */
export declare function aliasForUtilityToken(token: string): string;
interface CodeRange {
  readonly start: number;
  readonly end: number;
}
/**
 * 動的 `class={` / `className={` の式範囲 (brace 内側) を集める。
 * 中の文字列リテラルは class 用途のため削減モードの書換対象になる。
 */
export declare function findDynamicClassExprs(code: string): CodeRange[];
/**
 * module 全体の文字列リテラルから候補 token を集める (verbatim 用)。
 * class 属性・コメント・`from '...'` 指定子は除く。template は `${}` 内を除く。
 * Tailwind と同じく生テキスト走査のため、過剰検出は unmatched 切り捨てで吸収する。
 */
export declare function collectLiteralTokens(code: string, exclude: readonly [number, number][]): string[];
/** collectLiteralTokens の位置付き版。動的 occurrence の有無判定に使う。 */
export declare function collectLiteralSpans(code: string, exclude: readonly [number, number][]): {
  token: string;
  start: number;
  end: number;
}[];
/**
 * `@unocss/vite` の差し替え用 default export。import 元だけ変えれば移行できる
 * (`import UnoCSS from '@unocss/vite'` → `import UnoCSS from '@qstyle/unocss'`)。
 * 引数は同じ物を受け付ける (inline config は `uno.config.ts` に merge され、
 * 文字列は config path)。vite 固有の出力制御 (`mode` 等) は qstyle 配管が
 * 担うため無視する。
 */
export declare function UnoCSS(options?: QstyleUnoOptions | string): QstyleUnoPlugin;
//#endregion
//#region src/resolve.d.ts
interface UnoGlobals {
  readonly theme: string;
  readonly properties: string;
  readonly base: string;
  readonly keyframes: string;
}
interface UnoResolveResult {
  /** 1 要素分・競合解決済み・unocss 出力順の atoms。verbatim 時は空。 */
  readonly atoms: readonly StaticAtom[];
  /**
   * atom 化不能だった matched token の原文 rules (出力順)。空でなければ
   * 要素全体が verbatim (class は書き換えない)。unocss 出力と同一 cascade。
   */
  readonly verbatimCss: string;
  /** engine に未知の token (入力順)。CSS はどこにも無いため残してよい。 */
  readonly unmatched: readonly string[];
  /** theme / properties / base / keyframes 層 (global asset 用)。 */
  readonly globals: UnoGlobals;
}
interface UnoResolver {
  resolve(tokens: readonly string[], opts?: ResolveOptions): Promise<UnoResolveResult>;
}
interface ResolveOptions {
  /**
   * true の場合 atom 化せず、matched token の原文 rules をすべて verbatim で
   * 返す (関連付け先の要素が無いリテラル走査用)。
   */
  readonly verbatimOnly?: boolean | undefined;
  /**
   * verbatim CSS の selector 書き換え表 (token → 短縮 alias)。
   * 削減モードで JS 側の token を alias に置換した場合に渡す。
   * matched token の参照のみ書き換え、unmatched (engine 未知・user CSS) は
   * 原文のまま残す。atom 化 path には影響しない。
   */
  readonly aliases?: ReadonlyMap<string, string> | undefined;
}
/** `uno.config.ts` を UnoCSS 自身の loader で読む (`@unocss/vite` と同一意味論)。
 * 文字列は config path、object は inline config (file に merge される) として渡す。 */
export declare function loadUnoConfig(cwd: string, configOrPath?: string | UserConfig$1): Promise<UserConfig$1>;
/** user config から resolver を作る。同一 token 集合は memo 化する。 */
export declare function createUnoResolver(config: UserConfig$1): Promise<UnoResolver>;
/**
 * 2 declarations を独立 emit すると cascade が壊れる可能性があるか
 * (docs/unocss.md §2.8)。同一 longhand を覆う場合のみ true。
 * `mt-2` + `ml-4`、`text-lg` + `leading-6`、`transition-property` +
 * `transition-duration` は独立なので false。
 */
export declare function orderRiskProperty(pa: string, pb: string): boolean;
//#endregion
//#region src/parse.d.ts
interface RawDecl {
  readonly prop: string;
  readonly value: string;
}
interface CssWrapper {
  readonly kind: "media" | "supports" | "container" | "layer";
  readonly prelude: string;
}
interface RawRule {
  readonly selectors: readonly string[];
  /** `@property` / `@keyframes` 等の非 declaration rule。decls は空。 */
  readonly opaqueAt: string | null;
  readonly decls: readonly RawDecl[];
  readonly wrappers: readonly CssWrapper[];
  /** source 内の byte 範囲 (verbatim 切り出し用)。 */
  readonly start: number;
  readonly end: number;
}
/**
 * CSS-text を top-level rule 列へ。block を持たない文 (`@charset` 等) は捨てる。
 * 未知 at-rule block は opaque として保持する (caller が globals へ回せる)。
 */
export declare function parseCssRules(cssText: string): RawRule[];
//#endregion
//#region src/native-config.d.ts
interface NativeUnoOptions {
  readonly configFile?: string;
}
/** Build adapter factory. No Vite plugin, JSX rewrite or independent CSS emitter is created. */
export declare function unocss(options?: NativeUnoOptions): UtilityAdapterFactory;
//#endregion
//#region src/native-adapter.d.ts
type NativeUnoNode = UtilityCssNode;
type NativeUnoAdapter = UtilityAdapter;
/** Parse every output node; unsupported generator syntax is never a verbatim fallback. */
export declare function parseNativeUnoCss(css: string, tokens: ReadonlySet<string>): readonly NativeUnoNode[];
/** One generator per adapter; token sets are resolved together in official generator order. */
export declare function createNativeUnoAdapter(config: UserConfig$1): Promise<NativeUnoAdapter>;
//#endregion
export { type CssWrapper, type NativeUnoAdapter, type NativeUnoOptions, type QstyleUnoOptions, type QstyleUnoPlugin, type RawDecl, type RawRule, UnoCSS as default, type UnoGenerator, type UnoGlobals, type UnoResolveResult, type UnoResolver, type UserConfig };
//# sourceMappingURL=index.d.mts.map