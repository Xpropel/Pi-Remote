/**
 * 桌面输入框的提示词历史。只从正文里的用户消息推导，不写 localStorage。
 *
 * 按原顺序收集：普通对象、kind 为 user、text 为字符串。trim 后的空串丢掉。
 * 和已经留下的最后一条整段相同就丢掉，更早的重复留下。不要改大小写，也不要改中间的空白。
 * 留下的超过 100 条时只保留最后 100 条，再倒过来，下标 0 是最新的一条。
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function promptHistoryFromItems(items: unknown): string[] {
  if (!Array.isArray(items)) return []
  const kept: string[] = []
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    if (!isPlainObject(item)) continue
    if (item.kind !== "user" || typeof item.text !== "string") continue
    const text = item.text.trim()
    if (!text) continue
    if (kept.length > 0 && kept[kept.length - 1] === text) continue
    kept.push(text)
  }
  const start = kept.length > 100 ? kept.length - 100 : 0
  const newestFirst: string[] = []
  for (let i = kept.length - 1; i >= start; i -= 1) newestFirst.push(kept[i])
  return newestFirst
}

export type RecallStep = { index: number; savedDraft: string | null; text: string }

/** older 往更早一档（index + 1），newer 往更新一档（index - 1）。-1 是走进历史之前的草稿。 */
export function recallPrompt(history: unknown, index: unknown, savedDraft: unknown, current: unknown, direction: unknown): RecallStep | null {
  const list = Array.isArray(history) ? history : []
  if (list.length === 0 || (direction !== "older" && direction !== "newer")) return null
  const at = typeof index === "number" && Number.isInteger(index) ? index : -1
  const next = direction === "older" ? at + 1 : at - 1
  if (next < -1 || next >= list.length) return null
  if (next === -1) {
    return { index: -1, savedDraft: null, text: typeof savedDraft === "string" ? savedDraft : "" }
  }
  const raw = list[next]
  const text = typeof raw === "string" ? raw : ""
  const draft = at === -1 ? (typeof current === "string" ? current : null) : (typeof savedDraft === "string" ? savedDraft : null)
  return { index: next, savedDraft: draft, text }
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isBrowsing(browsing: unknown): boolean {
  return browsing === true
}

export function shouldRecallOlder(browsing: unknown, value: unknown, selectionStart: unknown, selectionEnd: unknown): boolean {
  const text = asText(value)
  const single = !text.includes("\n")
  const looking = isBrowsing(browsing)
  if (!finiteNumber(selectionStart) || !finiteNumber(selectionEnd)) return looking && single
  if (looking && single) return true
  return selectionStart === 0 && selectionEnd === 0
}

export function shouldRecallNewer(browsing: unknown, value: unknown, selectionStart: unknown, selectionEnd: unknown): boolean {
  const text = asText(value)
  const single = !text.includes("\n")
  const looking = isBrowsing(browsing)
  if (!looking) return false
  if (!finiteNumber(selectionStart) || !finiteNumber(selectionEnd)) return single
  if (single) return true
  return selectionStart === text.length && selectionEnd === text.length
}
