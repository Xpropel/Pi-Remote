/**
 * c 区的界面文案、选项表和小工具（P3.3 从 c/mock.ts 拆出：这些是界面口径，不是 mock）。
 */
import type { CHostMessage } from "./types"

/** 投递方式文案（E04；协议术语 steer / follow_up 不上界面） */
export const DELIVERY_LABEL: Record<"steer" | "follow_up", string> = {
  steer: "插入当前回合",
  follow_up: "等这轮结束",
}

export const THEME_OPTIONS = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
]
export const FONT_OPTIONS = [
  { value: "small", label: "小" },
  { value: "standard", label: "标准" },
  { value: "large", label: "大" },
]
export const DENSITY_OPTIONS = [
  { value: "compact", label: "精简" },
  { value: "balanced", label: "平衡" },
  { value: "detailed", label: "详细" },
]

export function mentionLabel(path: string): string {
  const parts = path.trim().split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

export function mentionDir(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return i > 0 ? path.slice(0, i + 1) : ""
}

/** filterMentionFiles 的排序：文件名开头 > 文件名包含 > 路径包含；同档保持入参顺序；不区分大小写；上限 8 */
export function filterMentions(pool: readonly string[], query: string, exclude: readonly string[] = []): string[] {
  const q = query.toLowerCase()
  const tiers: string[][] = [[], [], []]
  for (const path of pool) {
    if (exclude.includes(path)) continue
    const name = mentionLabel(path).toLowerCase()
    if (name.startsWith(q)) tiers[0]!.push(path)
    else if (name.includes(q)) tiers[1]!.push(path)
    else if (path.toLowerCase().includes(q)) tiers[2]!.push(path)
  }
  return tiers.flat().slice(0, 8)
}

/** 队列消息的正文（只取 text 块；产品里同一口径） */
export function hostMessageText(m: CHostMessage): string {
  if (typeof m.content === "string") return m.content
  return m.content
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("")
}

/** "40 秒前" / "3 分钟前"（排队面板的行内时间） */
export function agoText(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s} 秒前`
  return `${Math.floor(s / 60)} 分钟前`
}
