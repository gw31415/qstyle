export function h(
  tag: string,
  props: Record<string, unknown> | null,
  ...children: unknown[]
): unknown {
  return { tag, props, children };
}

export function Fragment(props: Record<string, unknown> | null): unknown {
  return props;
}
