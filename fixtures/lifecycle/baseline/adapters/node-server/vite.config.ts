// SSR server 用 adapter config (plan.md B-1 C0 Playwright 基盤用)。
//
// base (client build) の後に `vite build -c adapters/node-server/vite.config.ts`
// で server bundle (dist/server) を作る。SSG render はしない
// (beta.43 の SSG は `<Link>` の QRL 解決で Q14 になる。QWK-002 は framework 待ち)。
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeServerAdapter } from '@qwik.dev/router/adapters/node-server/vite';
import { extendConfig } from '@qwik.dev/router/vite';
import baseConfig from '../../vite.config.ts';

const here: string = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot: string = path.resolve(here, '..', '..');

export default extendConfig(baseConfig, () => ({
  build: {
    ssr: true,
    rolldownOptions: {
      input: ['src/entry.node-server.tsx'],
    },
  },
  // adapter build の client 成果物も dist/ に寄せる。server bundle (server/) が
  // 参照する chunk 名と静的配信が一致し、二重 build の hash 乖離が問題にならない
  // (base build の同名でない chunk は orphan として残るが無害)。
  // C0 基盤では `pnpm exec vite build` (base) → 本 config の buildApp の順で実行する。
  environments: {
    client: {
      build: {
        outDir: path.resolve(fixtureRoot, 'dist'),
      },
    },
  },
  plugins: [nodeServerAdapter({ name: 'node-server' })],
}));
