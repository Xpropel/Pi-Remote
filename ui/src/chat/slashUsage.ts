/**
 * P3-5 slash「常用」使用计数：只存命令名 → { count, at }，落本机 localStorage。
 *
 * 隐私与体积口径（ROUND3-PLAN R3-4 定版）：
 *  - 计数 API 只接受命令名，**没有任何参数入参**——/name 的新名字、/follow 的
 *    排队正文这类参数内容在结构上就进不了存储，不是靠调用方自觉过滤；
 *  - 命令名归一为「去斜杠、小写、无空白」：带空白的串一律拒绝记账，
 *    万一调用方误把整行草稿传进来也只会记空账，不会把参数片段存下去；
 *  - 条数上限 + 最久未用淘汰，长期使用也不会把存储撑大。
 *
 * 存储读写照 drafts.ts 的安全封装范式：全部吞异常，隐私模式 / 配额满 /
 * 存储被禁时静默降级（常用组不出现，菜单其余功能不受影响）。
 */

export type SlashUsageEntry = { count: number; at: number }
export type SlashUsageTable = Record<string, SlashUsageEntry>

export const SLASH_USAGE_STORAGE_KEY = "pi_remote_slash_usage_v1"
/** 计数变化的同页广播名（与 prefs 的 "pi-style" 同法）：storage 事件只跨标签页
 * 触发，同页的多个 composer 实例靠这个事件重读计数（第 3 轮代码审 B-4）。 */
export const SLASH_USAGE_EVENT = "pi-slash-usage"
/** 计数表最多保留的命令名数；超限按 at 最久未用淘汰。 */
export const SLASH_USAGE_MAX_ENTRIES = 64
/** 「常用」分组最多列出的条数（菜单一屏的量级，其余命令仍在下方分组里）。 */
export const SLASH_FREQUENT_LIMIT = 5

/** 命令名归一：去前导斜杠、去首尾空白、小写。含空白 / 为空 / 非字符串 → ""（不记账）。 */
export function normalizeSlashName(name: unknown): string {
  if (typeof name !== "string") return ""
  const clean = name.trim().replace(/^\/+/, "").toLowerCase()
  if (!clean || /\s/.test(clean)) return ""
  return clean
}

/** 防御式解析存储原文：形状不对的条目逐条丢弃，不让脏数据毒化整表。 */
export function parseSlashUsage(raw: string | null): SlashUsageTable {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const table: SlashUsageTable = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const name = normalizeSlashName(key)
    if (!name || name !== key) continue
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const rec = value as Record<string, unknown>
    const count = typeof rec.count === "number" && Number.isFinite(rec.count) ? Math.floor(rec.count) : 0
    const at = typeof rec.at === "number" && Number.isFinite(rec.at) ? rec.at : 0
    if (count <= 0) continue
    table[name] = { count, at }
  }
  return table
}

export function serializeSlashUsage(table: SlashUsageTable): string {
  return JSON.stringify(table)
}

/** 记一次使用：返回新表（不改入参）。名归一失败 → 原样返回（记空账）。超上限淘汰 at 最小者。 */
export function recordSlashUsage(table: SlashUsageTable, name: unknown, now: number): SlashUsageTable {
  const key = normalizeSlashName(name)
  if (!key) return table
  const next: SlashUsageTable = { ...table }
  const prev = next[key]
  next[key] = { count: (prev ? prev.count : 0) + 1, at: now }
  const keys = Object.keys(next)
  if (keys.length > SLASH_USAGE_MAX_ENTRIES) {
    keys
      .sort((a, b) => (next[a]!.at - next[b]!.at) || (next[a]!.count - next[b]!.count))
      .slice(0, keys.length - SLASH_USAGE_MAX_ENTRIES)
      .forEach((victim) => delete next[victim])
  }
  return next
}

/** 常用排序：计数降序，同计数按最近使用（at 降序），再同按名升序保证确定。 */
export function frequentSlashNames(table: SlashUsageTable, limit: number = SLASH_FREQUENT_LIMIT): string[] {
  return Object.entries(table)
    .sort(([nameA, a], [nameB, b]) => b.count - a.count || b.at - a.at || (nameA < nameB ? -1 : nameA > nameB ? 1 : 0))
    .slice(0, Math.max(0, limit))
    .map(([name]) => name)
}

export type SlashUsageStore = {
  get(key: string): string | null
  set(key: string, value: string): boolean
  remove(key: string): void
}

function browserStore(): SlashUsageStore {
  return {
    get(key) {
      try {
        return window.localStorage.getItem(key)
      } catch {
        return null
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value)
        return true
      } catch {
        return false
      }
    },
    remove(key) {
      try {
        window.localStorage.removeItem(key)
      } catch {}
    },
  }
}

let defaultStore: SlashUsageStore | null = null
function store(): SlashUsageStore {
  if (!defaultStore) defaultStore = browserStore()
  return defaultStore
}

export function loadSlashUsage(from: SlashUsageStore = store()): SlashUsageTable {
  try {
    return parseSlashUsage(from.get(SLASH_USAGE_STORAGE_KEY))
  } catch {
    return {}
  }
}

export function saveSlashUsage(table: SlashUsageTable, to: SlashUsageStore = store()): void {
  try {
    to.set(SLASH_USAGE_STORAGE_KEY, serializeSlashUsage(table))
  } catch {
    /* 存储不可用就只活在内存里 */
  }
}

/** 记账后广播变化：同页其他 composer 实例据此重读（storage 事件负责跨标签页）。 */
function announceSlashUsageChanged() {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(SLASH_USAGE_EVENT))
  } catch {
    /* 广播失败不影响记账本身 */
  }
}

/**
 * 执行成功回执点的唯一记账入口：读 → 记 → 存 → 广播，返回新表供 UI 即时刷新常用组。
 * 只收命令名——参数在任何情况下都不会、也不能传进来。
 */
export function noteSlashCommandUsed(name: unknown, from: SlashUsageStore = store(), now: number = Date.now()): SlashUsageTable {
  const next = recordSlashUsage(loadSlashUsage(from), name, now)
  saveSlashUsage(next, from)
  announceSlashUsageChanged()
  return next
}
