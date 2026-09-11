import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeServerAdapter } from '@qwik.dev/router/adapters/node-server/vite';
import { extendConfig } from '@qwik.dev/router/vite';
import baseConfig from '../../vite.config';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, '..', '..');

export default extendConfig(baseConfig, () => ({
  build: {
    ssr: true,
    rolldownOptions: {
      input: [path.resolve(fixtureRoot, 'src/entry.node-server.tsx')],
    },
  },
  environments: {
    client: {
      build: {
        outDir: path.resolve(fixtureRoot, 'dist'),
      },
    },
  },
  plugins: [nodeServerAdapter({ name: 'node-server' })],
}));
