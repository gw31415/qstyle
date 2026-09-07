import { defineConfig, presetWind4 } from 'unocss';
import type { UserConfig } from 'unocss';

// plugin.test.ts 用 fixture。標準名のため自動発見される。
const config: UserConfig = defineConfig({ presets: [presetWind4()] });
export default config;
