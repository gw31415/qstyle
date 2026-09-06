// README「css prop の型 (consumer 側設定)」と同じ augmentation。
// fixture の JSX で css prop を型付けするためだけのもの (build には影響しない)。
import type { CssProp } from '@qstyle/qwik';

declare module '@qwik.dev/core/internal' {
  interface HTMLElementAttrs {
    css?: CssProp;
  }
}
