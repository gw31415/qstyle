export default {
  preflights: [{ getCSS: () => ':root{--contract-foundation:rgb(20, 40, 60)}' }],
  rules: [
    ['contract-pad', { padding: '8px' }],
    ['contract-round', { 'border-radius': '12px' }],
    ['contract-square', { 'border-radius': '0px' }],
    ['contract-red', { color: 'red' }],
    ['contract-lazy', { 'outline-width': '3px', 'outline-style': 'solid' }],
  ],
};
