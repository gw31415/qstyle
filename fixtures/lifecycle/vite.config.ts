// lifecycle fixture — plan.md B-1 (browser 実機検証) の被験 app (qwik city)。
//
// 3 route (`/`, `/about`, `/item/[id]`) + lazy component + dynamic signal +
// 共有 component + legacy hooks (useStyles$ / useStylesScoped$) を持つ最小 app。
// backend: 'css-asset' (chunk planner が content-hash 付き CSS asset を直接 emit)。
//
// - route ファイルは Qwik City 規約の `index.tsx` 形 (flat の `about.tsx` や
//   `[id].tsx` は route として認識されない)。同名 basename の区別は plugin 側の
//   root 相対 moduleKey が行うため、routes option は root 相対 path で書く。
// - layout.tsx は全 route で描画されるため、全 route の module list に含める。
// - lazy component (lazy-panel.tsx / lazy-inner.tsx) は意図的に route manifest に
//   含めない (QWK-005: 初期 HTML/network に lazy の CSS asset が含れないこと)。
//   それらの unit は lazy chunk の ensureModuleStyles が直前に読み込む。
// - `<QstyleLinks prefetch="hover" />` は root.tsx の <head> 内に置く
//   (links.tsx は @qwik.dev/router の useLocation に依存するため qwik city plugin が
//   必須。head 内に置くことで QWK-017 (link が body より前) を直接検証できる)。
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { qwikVite } from '@qwik.dev/core/optimizer';
import { qwikCity } from '@qwik.dev/router/vite';
import { ssgAdapter } from '@qwik.dev/router/adapters/ssg/vite';
import { qstyle } from '../../packages/vite/src/index.ts';

const here: string = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    qwikCity(),
    // QSTYLE_OFF=1 で qstyle plugin を外す (resume 切り分け等の対照実験用)。
    ...(process.env.QSTYLE_OFF === '1'
      ? []
      : [
          qstyle({
            backend: 'css-asset',
            routes: {
              '/': [
                '/src/routes/index.tsx',
                '/src/routes/layout.tsx',
                '/src/components/shared.tsx',
                '/src/components/dyn-box.tsx',
                '/src/components/legacy.tsx',
              ],
              '/about': [
                '/src/routes/about/index.tsx',
                '/src/routes/layout.tsx',
                '/src/components/shared.tsx',
              ],
              '/item/[id]': [
                '/src/routes/item/[id]/index.tsx',
                '/src/routes/layout.tsx',
                '/src/components/shared.tsx',
              ],
            },
          }),
        ]),
    qwikVite(),
    // SSG (QWK-002 link bake 用。QSTYLE_OFF=1 の対照 build でも render する)。
    ssgAdapter({ origin: 'http://127.0.0.1:4173' }),
  ],
  resolve: {
    alias: {
      // workspace root に @qstyle が link されていないため packages/qwik を直参照する。
      // links は `.qwik.mjs` で指す (app build の optimizer が transform して
      // QRL symbol を q-manifest に登録する。素の `.mjs` では SSR/SSG で Q14)。
      // client / prefetch も dist に揃えて runtime copy を 1 系列に保つ。
      '@qstyle/qwik/client': path.resolve(here, '../../packages/qwik/dist/client.mjs'),
      '@qstyle/qwik/links': path.resolve(here, '../../packages/qwik/dist/links.qwik.mjs'),
      '@qstyle/qwik/prefetch': path.resolve(here, '../../packages/qwik/dist/prefetch.mjs'),
      '@qstyle/qwik': path.resolve(here, '../../packages/qwik/dist/index.mjs'),
    },
  },
});
