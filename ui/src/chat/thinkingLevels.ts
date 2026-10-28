/** 思考级别的解析与显示名。只认 pi 实际返回的 levels，不维护固定档位表。 */

const DISPLAY: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
}

/** get_available_thinking_levels 的返回：{ levels: string[] } 或 { levels: {id|name|level}[] }。 */
export function parseThinkingLevels(data: unknown): string[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return []
  const levels = (data as { levels?: unknown }).levels
  if (!Array.isArray(levels)) return []
  const out: string[] = []
  for (const item of levels) {
    let name = ""
    if (typeof item === "string") {
      name = item
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const row = item as Record<string, unknown>
      name = typeof row.id === "string" ? row.id : typeof row.name === "string" ? row.name : typeof row.level === "string" ? row.level : ""
    }
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

/** 显示名规范化；未知值原样返回，不猜档位。 */
export function thinkingLevelLabel(level: string): string {
  return DISPLAY[level.trim().toLowerCase()] ?? level
}

/** 当前值必须真的在可用列表里，否则返回 null（不伪造档位）。返回列表中的原值，发送时用它。 */
export function currentThinkingLevel(levels: string[], current: string): string | null {
  if (!current) return null
  const key = current.trim().toLowerCase()
  return levels.find((level) => level.trim().toLowerCase() === key) ?? null
}
