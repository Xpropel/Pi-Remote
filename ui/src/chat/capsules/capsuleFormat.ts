/** 胶囊层共用的格式化：纯函数，不依赖 React / DOM，Node 测试可直接 import。 */

/** 行高级计时：与 PromptWaiting 同一口径（m:ss；≥1h 为 h:mm:ss）。 */
export function formatCapsuleElapsed(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, "0")
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/** 窄屏紧凑态的数字：<380px 两个胶囊并存时封顶 99+，单胶囊永远显示全文案。 */
export function compactCapsuleCount(count: number): string {
  const safe = Math.max(0, Math.floor(count))
  return safe > 99 ? "99+" : String(safe)
}

/** 英文单复数：1 terminal / 2 terminals。 */
export function terminalWord(count: number): string {
  return count === 1 ? "terminal" : "terminals"
}

/**
 * 命令首行中段省略：保留头尾、丢中间，宽度可控；原文仍放在 title / 展开区。
 * 首行本身超过 max 才截，未超过原样返回。
 */
export function middleEllipsis(value: string, max = 72): string {
  const text = value.replace(/\s+/g, " ").trim()
  if (text.length <= max) return text
  if (max <= 1) return "…"
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/** 命令的多行注记：首行之外还有几行。 */
export function extraCommandLines(command: string): number {
  if (!command) return 0
  const lines = command.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n")
  return Math.max(0, lines.length - 1)
}
