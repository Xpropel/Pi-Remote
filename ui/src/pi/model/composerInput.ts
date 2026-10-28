/**
 * composer 输入框与命令面板的纯逻辑（P4 c 线：PLAN 4.1 / 4.2 / 4.5；design E08 E09 G01、§1.10、§4.7）。
 * 不依赖 React / DOM，node --test 直接加载（test/pi-p4-c.test.mjs）。React 接线在 components/pi/composer/useComposerAssist.ts。
 *
 * - composerTriggerOf：输入内容 + 光标 → 该弹斜杠菜单还是 @ 菜单（或都不弹）。
 * - slashMenuGroups：斜杠菜单的分组（空查询 = 浏览分组；有查询 = 前缀匹配、平铺不分组）。
 * - nextOptionIndex：↑↓ / Home / End 在可选行之间移动（跳过禁用行、到头绕回）。
 * - removeMentionQuery：选中 @ 候选时从草稿里去掉 "@查询"。
 * - paletteKeysOf / paletteCommandDisabled / paletteMatches：命令面板的键帽（单一来源 PI_SHORTCUT_KEYS）、离线禁用、过滤。
 * - turnEndAnnouncement：回合结束时状态区播报一次的文字。
 */
import { MAX_PENDING_FILES, parseMentionTrigger } from "../../chat/composer/mention.ts"
import { PI_SHORTCUT_KEYS, type PiModShortcut, type PiPlatform } from "./shortcuts.ts"

/* ======================= 斜杠 / @ 触发 ======================= */

export type PiComposerTrigger = { kind: "slash"; query: string } | { kind: "mention"; start: number; query: string }

export interface PiComposerTriggerOptions {
  /** 有没有斜杠菜单（没给命令表时不弹） */
  slash?: boolean
  /** 有没有 @ 菜单（没给候选池时不弹） */
  mention?: boolean
  /** 已经挂上的引用数：满 MAX_PENDING_FILES（10）个时不再弹 @ 候选（design mention-menu states） */
  mentionCount?: number
}

/**
 * 输入框内容 + 光标位置 → 该弹哪个菜单：
 *   - 斜杠：整段输入以 / 开头、还在打命令名（没出现空白）（slashParse.ts 的口径：只认开头的 /；和光标位置无关，整段就是命令名）；
 *   - @：光标前未闭合的 @token（chat/composer/mention.ts parseMentionTrigger：行首 / 空白 / 非 ASCII 之后的 @ 才算）。
 * 斜杠优先；都不是返回 null。
 */
export function composerTriggerOf(draft: string, caret: number, options: PiComposerTriggerOptions = {}): PiComposerTrigger | null {
  const { slash = true, mention = true, mentionCount = 0 } = options
  if (slash) {
    const m = /^\/([^\s]*)$/.exec(draft)
    if (m) return { kind: "slash", query: m[1] ?? "" }
  }
  if (mention && mentionCount < MAX_PENDING_FILES) {
    const t = parseMentionTrigger(draft, caret)
    if (t) return { kind: "mention", start: t.start, query: t.query }
  }
  return null
}

/** 菜单的"签名"：同一个触发、同一个查询 = 同一个菜单（选中行在签名变化时回到第一行；Esc 关掉后签名不变就不再弹） */
export function triggerSignature(trigger: PiComposerTrigger | null): string {
  if (!trigger) return ""
  return trigger.kind === "slash" ? `/${trigger.query}` : `@${trigger.start}:${trigger.query}`
}

/* ======================= 斜杠菜单的分组 ======================= */

export interface PiSlashRowLike {
  key: string
  /** 命令名，带 /（"/compact"） */
  name: string
}

/**
 * 斜杠菜单显示哪些行（design slash-menu：空查询分组浏览 常用 / 内置 / 本机资源；"/co" → /compact、/copy、/clone、/commands 平铺不分组）。
 * 有查询时按命令名前缀匹配（不区分大小写，不含 /），保持浏览顺序、同 key 去重，组名为空串（菜单不画组名）；没有匹配返回 []。
 */
export function slashMenuGroups<R extends PiSlashRowLike>(groups: readonly { title: string; rows: readonly R[] }[], query: string): { title: string; rows: R[] }[] {
  const q = query.toLowerCase()
  if (!q) return groups.filter((g) => g.rows.length > 0).map((g) => ({ title: g.title, rows: [...g.rows] }))
  const seen = new Set<string>()
  const rows: R[] = []
  for (const g of groups) {
    for (const r of g.rows) {
      if (seen.has(r.key)) continue
      if (r.name.replace(/^\//, "").toLowerCase().startsWith(q)) {
        seen.add(r.key)
        rows.push(r)
      }
    }
  }
  return rows.length > 0 ? [{ title: "", rows }] : []
}

/* ======================= ↑↓ 选中行 ======================= */

export type PiListKey = "ArrowDown" | "ArrowUp" | "Home" | "End"

/**
 * 列表里的选中行怎么动（aria-activedescendant 的宿主用）：只停在 enabled 的行；↓ / ↑ 到头绕回；Home / End 到第一个 / 最后一个可选行。
 * current 不是可选行（-1 或禁用行）时，↓ / Home 到第一个可选行，↑ / End 到最后一个。没有可选行返回 -1。
 */
export function nextOptionIndex(enabled: readonly boolean[], current: number, key: PiListKey): number {
  const ok = enabled.map((e, i) => (e ? i : -1)).filter((i) => i >= 0)
  if (ok.length === 0) return -1
  const first = ok[0]!
  const last = ok[ok.length - 1]!
  if (key === "Home") return first
  if (key === "End") return last
  const at = ok.indexOf(current)
  if (at < 0) return key === "ArrowDown" ? first : last
  if (key === "ArrowDown") return ok[(at + 1) % ok.length]!
  return ok[(at - 1 + ok.length) % ok.length]!
}

/** 有效的选中行：wanted 是可选行就用它，否则第一个可选行（没有就 -1） */
export function activeOptionIndex(enabled: readonly boolean[], wanted: number): number {
  if (wanted >= 0 && wanted < enabled.length && enabled[wanted]) return wanted
  return enabled.findIndex((e) => e)
}

/* ======================= @ 引用 ======================= */

/** 选中 @ 候选：从草稿里删掉 [start, caret) 这段 "@查询"，光标落在原来 @ 的位置 */
export function removeMentionQuery(draft: string, start: number, caret: number): { draft: string; caret: number } {
  const s = Math.max(0, Math.min(start, draft.length))
  const e = Math.max(s, Math.min(caret, draft.length))
  return { draft: draft.slice(0, s) + draft.slice(e), caret: s }
}

/* ======================= 命令面板 ======================= */

/** 命令面板里哪些命令带快捷键（其余命令不写键帽，design G01：只写浏览器里真能触发的键） */
const PALETTE_SHORTCUT: Readonly<Record<string, PiModShortcut>> = {
  new: "new-session",
  sidebar: "toggle-sidebar",
  pane: "toggle-pane",
  settings: "settings",
}

/**
 * 命令面板行尾的键帽：取 shortcuts.ts 的 PI_SHORTCUT_KEYS（键位与文案只有一个来源）。
 * mac 拆成单字（"⇧⌘O" → ⇧ ⌘ O），其他平台按 "+" 拆（"Ctrl+Shift+O" → Ctrl Shift O）。没有快捷键的命令返回 undefined。
 */
export function paletteKeysOf(commandKey: string, platform: PiPlatform): string[] | undefined {
  const action = PALETTE_SHORTCUT[commandKey]
  if (!action) return undefined
  const text = PI_SHORTCUT_KEYS[action][platform]
  return platform === "mac" ? Array.from(text) : text.split("+")
}

/** 离线时命令行禁用（design command-palette states）：设置、切换侧栏、开关右 pane 不需要连接，照常可用 */
export function paletteCommandDisabled(commandKey: string, offline: boolean): boolean {
  return offline && commandKey !== "settings" && commandKey !== "sidebar" && commandKey !== "pane"
}

/** 命令面板的过滤：查询为空全留；否则文字里包含查询（不区分大小写，查询两头空白去掉） */
export function paletteMatches(query: string, ...texts: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return texts.some((t) => t != null && t.toLowerCase().includes(q))
}

/* ======================= 回合结束播报 ======================= */

/** 回合结束播报的两句（design §4.7：状态区一个常驻、视觉隐藏的 polite 区，回合结束时读一次） */
export const TURN_DONE_TEXT = "回合已完成"
export const TURN_ERROR_TEXT = "这一轮出错了"

/**
 * 回合从"在跑"变成"不在跑"时返回要播报的一句（error 时"这一轮出错了"，否则"回合已完成"）；
 * 回合开始时返回 ""（清空，下一次同样的句子也能再读）；其余时刻返回 null（保持原文不动）。
 */
export function turnEndAnnouncement(wasRunning: boolean | null, running: boolean, error = false): string | null {
  if (wasRunning === null) return null
  if (wasRunning && !running) return error ? TURN_ERROR_TEXT : TURN_DONE_TEXT
  if (!wasRunning && running) return ""
  return null
}
