/**
 * 展示用格式化（design §6.3 模块 format.ts）。纯函数，屏幕和 mock 共用；所有相对时间都按传入的 now 算，不读系统时钟。
 */

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** 行尾相对时间（待用户确认 9）：刚刚 / 5m / 5h / 1d / 10/21。未来时间按"刚刚"。 */
export function piRelativeTime(ts: number, now: number): string {
  const diff = now - ts
  if (diff < MIN) return "刚刚"
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * 人话相对时间（同 ui/src/relay/devices.ts relativeTime）：刚刚 / 5 分钟前 / 3 小时前 / 1 天前 / 10 月 21 日。
 * 也是会话行可访问名里的"时间全称"（v1.3 §12.3-3）：分档与 piRelativeTime 相同，"38m" 读作 "38 分钟前"。
 */
export function piAgo(ts: number | null | undefined, now: number): string {
  const at = Number(ts) || 0
  if (!at) return ""
  const diff = now - at
  if (diff < MIN) return "刚刚"
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`
  const d = new Date(at)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/**
 * 时长："42s" / "2m 14s" / "5h 12m"（秒以下按 1s）；整点省掉零的第二个单位："21h"、"3m"（v1.2 M-09）。
 * opts.zero：从 0 起算的计时（流里的"用时"、运行中、已等），0 写 "0s"（原 b/format.ts bDuration，P3.2 并入）
 */
export function piDuration(ms: number, opts?: { zero?: boolean }): string {
  const s = Math.max(opts?.zero ? 0 : 1, Math.round(ms / SEC))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

/** 倒计时 "9:12"（分:秒） */
export function piClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / SEC))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** 字节："96 KB" / "2.4 MB" / "512 B" */
export function piBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) {
    const kb = n / 1024
    return `${kb >= 100 ? Math.round(kb) : Math.round(kb * 10) / 10} KB`
  }
  return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`
}

/** token 数："29.6k" / "1.20M" / "812" */
export function piTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k >= 100 ? Math.round(k * 10) / 10 : Math.round(k * 10) / 10}k`
  }
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** 百分点（pi 的 contextUsage.percent，100 = 满）："30.9" / "0.6" / "34"：最多一位小数（design session-info「上下文 30.9%」） */
export function piPercent(points: number): string {
  return String(Math.round(points * 10) / 10)
}
/** 目录名（cwd 的最后一段；Windows 路径也认） */
export function piBaseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** 长 id 的短写："5c1e…a07" */
export function piShortId(id: string, head = 4, tail = 3): string {
  if (id.length <= head + tail + 1) return id
  return `${id.slice(0, head)}…${id.slice(-tail)}`
}

/** 思考时长："6 秒"、"1 分 12 秒"（原 b/format.ts bThinkSeconds） */
export function piThinkSeconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / SEC))
  if (s < 60) return `${s} 秒`
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

/** 模型短名（回复操作行）："claude-sonnet-4-5" → "sonnet-4.5"（原 b/format.ts bModelShort） */
export function piModelShort(modelId: string): string {
  const id = modelId.replace(/^claude-/, "")
  return id.replace(/-(\d+)-(\d+)$/, "-$1.$2")
}
