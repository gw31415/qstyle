import { defineConfig } from 'vite';
import { qwikVite } from '@qwik.dev/core/optimizer';
import { qwikCity } from '@qwik.dev/router/vite';
import { qstyleNative } from '../../packages/vite/src/native-plugin.ts';
import { parseStyleCss } from '../../packages/compiler/dist/index.mjs';

// Optional adapter integration lane; the default remains a handwritten Qwik
// control for the native style contract.
const foundationRule = { ...parseStyleCss('&{--native-foundation:rgb(17,34,51);}').rules[0]!,
  selector: { alternatives: [[{ kind: 'text' as const, text: ':root' }]] },
};

export default defineConfig({
  plugins: [qwikCity(), ...(process.env.QSTYLE_ADAPTER_FOUNDATION ? [qstyleNative({ utilities: {
    name: 'adapter-foundation-contract',
    async create() { return { watchFiles: [], async resolve(requests) { return {
      foundation: [{ kind: 'global-rule', rule: foundationRule }],
      states: requests.map((request) => ({ id: request.id,
        nodes: request.tokens.includes('adapter-route-only') ? parseStyleCss('&{padding-top:23px;}').rules.map((rule) => ({ kind: 'local' as const, token: 'adapter-route-only', rule })) : [],
        consumedTokens: request.tokens.filter((token) => token === 'adapter-route-only'),
        retainedTokens: request.tokens.filter((token) => token !== 'adapter-route-only'),
      })),
    }; } }; },
  } })] : []), qwikVite({ entryStrategy: { type: 'segment' } })],
});
