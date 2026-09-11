import { presetWind4 } from '../../packages/unocss/node_modules/@unocss/preset-wind4/dist/index.mjs';
import contract from './uno.config';

export default { ...contract, presets: [presetWind4()], outputToCssLayers: true, safelist: ['underline'] };
