/**
 * 子元素的 data-cw-id：根节点 data-cw-id + 后缀（例："um-1" → "um-1-undo"）。
 * 帧页面的 interactions 用它点中组件内部的按钮，不需要额外的 props。
 */
export function subId(rootProps: object, suffix: string): string | undefined {
  const id = (rootProps as Record<string, unknown>)["data-cw-id"]
  return typeof id === "string" && id ? `${id}-${suffix}` : undefined
}
