import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ssgAdapter } from '@qwik.dev/router/adapters/static/vite';
import { extendConfig } from '@qwik.dev/router/vite';
import baseConfig from '../../vite.config.ts';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default extendConfig(baseConfig, () => ({
  build: {
    ssr: true,
    rolldownOptions: { input: [path.join(fixtureRoot, 'src/entry.ssr.tsx')] },
  },
  environments: { client: { build: { outDir: path.join(fixtureRoot, 'dist') } } },
  plugins: [ssgAdapter({ origin: 'https://native-contract.example', maxWorkers: 1 })],
}));
