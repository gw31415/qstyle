// README「css prop の型 (consumer 側設定)」と同じ augmentation。
// fixture の JSX で css prop を型付けするためだけのもの (build には影響しない)。
import type { CssProp } from '@qstyle/qwik';

declare module '@qwik.dev/core/internal' {
  interface HTMLElementAttrs {
    css?: CssProp;
  }
  // SVG 要素 (`<svg>` / `<path>` 等) は HTMLElementAttrs を経由しないため別途必要。
  interface SVGAttributes<T extends Element = Element> {
    css?: CssProp;
  }
}
