// qwik city (v2) の entry.ssr に、qstyle の SSG bake 復元を 1 つ足したもの。
//
// @qstyle/vite (css-asset backend) は build process 内の generateBundle で
// `globalThis.__QSTYLE_ROUTES__` に route manifest を設定するが、qwik city の
// SSG (ssgAdapter) は page render を spawn した child process で実行するため、
// この global が render process に届かない。SSG environment の build も同じ
// plugin を通るため同 outDir に `qstyle.routes.json` が emit されており、
// module 読み込み時 (render より前) にそれを読んで globalThis へ復元する
// (plugin の in-process 連携と同一内容・同一 shape)。読めない環境 (dev 等) は
// client 側の useQstyleRouteStyles (二段構え) に任せる。
import { createRenderer } from '@qwik.dev/router';
import Root from './root';

function readManifestEnv(): unknown | undefined {
  try {
    // SSG worker は child process のため build.mjs が env 経由で渡す。
    const fromEnv: unknown = (globalThis as { process?: { env?: unknown } }).process?.env;
    const json: unknown =
      typeof fromEnv === 'object' && fromEnv !== null
        ? (fromEnv as Record<string, unknown>)['QSTYLE_ROUTES_JSON']
        : undefined;
    if (typeof json === 'string' && json.length > 0) {
      return JSON.parse(json) as unknown;
    }
  } catch {
    // 不正 JSON は無視して file 復元に進む。
  }
  return undefined;
}

try {
  const g = globalThis as { __QSTYLE_ROUTES__?: unknown };
  if (g.__QSTYLE_ROUTES__ === undefined) {
    const fromEnv: unknown | undefined = readManifestEnv();
    if (fromEnv !== undefined) {
      g.__QSTYLE_ROUTES__ = fromEnv;
    } else {
      const { readFileSync } = await import('node:fs');
      const manifestUrl = new URL('./qstyle.routes.json', import.meta.url);
      g.__QSTYLE_ROUTES__ = JSON.parse(readFileSync(manifestUrl, 'utf8'));
    }
  }
} catch {
  // manifest が無ければ何もしない (QstyleLinks は null を返し client が補完する)
}

export default createRenderer((opts) => {
  return { jsx: <Root />, options: opts };
});
