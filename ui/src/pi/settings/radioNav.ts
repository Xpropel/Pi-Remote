/**
 * 设置页 v2 · radiogroup 方向键（WAI-ARIA radio 惯例）。
 *
 * ← / ↑ 上一个、→ / ↓ 下一个；循环并跳过 disabled 选项。
 * 选中与焦点一起移动；Space 仍走原生 button 的点击（不在这里消费）。
 * 纯函数便于 Node 契约测试，组件只负责把结果 focus / onChange。
 */

export type RadioArrowStep = -1 | 0 | 1

export function radioArrowStep(key: string): RadioArrowStep {
  if (key === "ArrowRight" || key === "ArrowDown") return 1
  if (key === "ArrowLeft" || key === "ArrowUp") return -1
  return 0
}

/**
 * 从 current 出发按 step 循环找下一个可用项；current=-1 表示当前没有选中值。
 * 返回 -1 表示没有可用项。
 */
export function nextEnabledOptionIndex(
  options: readonly { disabled?: boolean }[],
  current: number,
  step: Exclude<RadioArrowStep, 0>,
): number {
  const count = options.length
  if (count === 0) return -1
  let index = current
  for (let i = 0; i < count; i += 1) {
    if (index < 0) index = step === 1 ? 0 : count - 1
    else index = (index + step + count) % count
    if (!options[index]?.disabled) return index
  }
  return -1
}
