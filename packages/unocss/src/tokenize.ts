// class 属性値の空白 split。caller 側で Set 化する (重複は保持する)。
export function tokenizeClassAttr(attrValue: string): string[] {
  const value: string = attrValue.trim();
  if (value === '') return [];
  return value.split(/\s+/);
}
