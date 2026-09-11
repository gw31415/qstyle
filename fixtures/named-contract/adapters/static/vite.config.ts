import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ssgAdapter } from '@qwik.dev/router/adapters/static/vite';
import { extendConfig } from '@qwik.dev/router/vite';
import baseConfig from '../../vite.config.ts';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default extendConfig(baseConfig, () => ({
  build: {
    // Qwik's optimizer owns the client public directory. The SSG runner moves
    // this staging directory to dist-ssg after the adapter finishes so the
    // existing Node build in dist can be restored unchanged.
    outDir: path.resolve(fixtureRoot, 'dist'),
    ssr: true,
    rolldownOptions: {
      input: [path.resolve(fixtureRoot, 'src/entry.ssr.tsx')],
    },
  },
  environments: {
    client: {
      build: {
        outDir: path.resolve(fixtureRoot, 'dist'),
      },
    },
    ssr: {
      build: {
        outDir: path.resolve(fixtureRoot, 'server-ssg'),
      },
    },
  },
  plugins: [
    ssgAdapter({
      origin: 'https://named-contract.example',
      maxWorkers: 1,
    }),
  ],
}));
