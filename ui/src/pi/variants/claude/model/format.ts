/**
 * 变体自带的展示格式化（不依赖 cursor 的 shared/format）。
 * 口径与产品一致：短相对时间 / 全称相对时间 / 用时 / 时钟 / 字节 / token / 模型短名。
 */

export function relativeShort(at: number | null | undefined, now: number): string {
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return ""
  const diff = Math.max(0, now - at)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return "刚刚"
  if (min < 60) return `${min}m`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}h`
  return `${Math.floor(hour / 24)}d`
}

export function relativeLong(at: number | null | undefined, now: number): string {
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return ""
  const diff = Math.max(0, now - at)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return "刚刚"
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  return formatDate(at, now)
}

export function formatDate(at: number, now: number): string {
  const d = new Date(at)
  const n = new Date(now)
  const sameYear = d.getFullYear() === n.getFullYear()
  const md = `${d.getMonth() + 1} 月 ${d.getDate()} 日`
  return sameYear ? md : `${d.getFullYear()} 年 ${md}`
}

export function formatClock(at: number | null | undefined): string {
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return ""
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

export function durationText(ms: number, zero = false): string {
  if (!Number.isFinite(ms) || ms < 0) return ""
  const total = Math.floor(ms / 1000)
  if (total <= 0 && !zero) return ""
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function bytesText(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function tokensText(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return ""
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

/** 模型短名：去掉 "Claude " 前缀与 provider（同 spec 的 "Sonnet 4.5 · medium" 口径） */
export function modelShortName(name: string | null | undefined): string {
  const raw = (name || "").trim()
  if (!raw) return ""
  return raw.replace(/^Claude\s+/i, "").replace(/\s+/g, " ")
}

export function baseName(path: string | null | undefined): string {
  const p = String(path || "").replace(/\\/g, "/").replace(/\/+$/, "")
  if (!p) return ""
  const idx = p.lastIndexOf("/")
  return idx >= 0 ? p.slice(idx + 1) : p
}

export function shortId(id: string, head = 4, tail = 3): string {
  if (!id) return ""
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`
}
