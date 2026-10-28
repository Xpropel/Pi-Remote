/**
* 长会话历史补拉（R2-5 / P3-7）纯逻辑：回包整形、条目→消息转换、分支链切窗、
* 指纹对齐、分页切片。不依赖 React / DOM；命令 I/O 在 useRelay 的 loadEarlierHistory 里。
*
*
* 扩展 cmdGetEntries 的 since 是官方语义“命中只返回其后条目”，是向新取页，
* 撑不起直接往旧翻页；且 UI 转录只持有消息、不持有 entry id，没法直接报游标。
* 本模块改走与既有命令面完全兼容的尾窗方案（协议 / 扩展 / relay 零改动）：
* 1. get_entries({limit}) 返回尾窗 entries + total（全量条数）：窗口起点下标
* = total - entries.length，与回包原子自洽；条目只在尾部追加，下标永不漂移；
* 2. 条目自带 id / parentId：从 leaf（或已知游标）沿 parentId 回溯即得窗口内的
* 活动分支链，侧支条目自动排除，补拉严格沿 pi 当前分支往旧走
* （与扩展 mirrorMessages 的分支口径一致）；
* 3. 首个游标靠“转录头部指纹序列”在分支链里对齐发现（findAnchor）；
* 之后每页以 (entryId, 扁平下标) 为游标，按下标精确算 limit 切下一窗。
* 分页分界永远落在“会产生转录条目的条目”上：toolResult 等非可见条目只作为
* 其所属助手条目的后续出现在同一片里，不会把工具卡劈成孤儿。
*/
import { textOf, type AgentMessage, type Item } from "./transcript.ts"

/** 每页最多补这么多条可见条目（消息）；窗口按条目数另算（见 useRelay）。 */
export const HISTORY_PAGE_MESSAGES = 60
/** 分页窗的初始条目数与上限（扁平条目计，含非可见条目）。 */
export const HISTORY_WINDOW_START = 384
export const HISTORY_WINDOW_MAX = 16384
/** 首个游标发现窗的初始条目数。 */
export const HISTORY_DISCOVERY_START = 512

export type RawEntry = {
id?: unknown
parentId?: unknown
type?: unknown
timestamp?: unknown
message?: { role?: unknown; content?: unknown; command?: unknown; summary?: unknown; [key: string]: unknown}
content?: unknown
customType?: unknown
display?: unknown
details?: unknown
summary?: unknown
fromId?: unknown
tokensBefore?: unknown
[key: string]: unknown
}

export type EntriesResult = {
entries: RawEntry[]
total: number
leafId: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
return!!value && typeof value === "object" &&!Array.isArray(value)
}

/** get_entries 回包整形：形状不对返回 null（调用方按失败处理），不猜字段。 */
export function parseEntriesResult(data: unknown): EntriesResult | null {
if (!isRecord(data) ||!Array.isArray(data.entries)) return null
const total = typeof data.total === "number" && Number.isFinite(data.total)? data.total: data.entries.length
return {
entries: data.entries as RawEntry[],
total,
leafId: typeof data.leafId === "string" && data.leafId? data.leafId: null,
}
}

export function entryIdOf(entry: RawEntry | undefined | null): string {
return entry && typeof entry.id === "string"? entry.id: ""
}

function parentIdOf(entry: RawEntry): string {
return typeof entry.parentId === "string" && entry.parentId? entry.parentId: ""
}

/** 条目时间戳 → 毫秒（与扩展 entryTime 同口径：数字原样、字符串 Date 解析、无效 0）。 */
function entryTimeMs(value: unknown): number {
const n = typeof value === "number"? value: typeof value === "string"? Date.parse(value): NaN
return Number.isFinite(n)? n: 0
}

/**
* 条目 → 镜像消息：与扩展 mirrorMessages 逐条同口径（message 原样；
* custom_message → custom；branch_summary → branchSummary；compaction → compactionSummary；
* system 不进镜像）。图片可寻址字段扩展已在 shrinkEntryDeep 时写进条目，这里原样透传。
*/
export function entriesToMessages(entries: RawEntry[]): AgentMessage[] {
const out: AgentMessage[] = []
for (const e of entries) {
if (!e || typeof e!== "object") continue
if (e.type === "message") {
const m = e.message
if (isRecord(m) && typeof m.role === "string" && m.role!== "system") out.push(m as AgentMessage)
} else if (e.type === "custom_message") {
out.push({
role: "custom",
customType: typeof e.customType === "string"? e.customType: undefined,
content: e.content?? [],
display: typeof e.display === "boolean"? e.display: undefined,
details: e.details,
timestamp: entryTimeMs(e.timestamp),
})
} else if (e.type === "branch_summary" && e.summary) {
out.push({
role: "branchSummary",
summary: e.summary as string,
fromId: typeof e.fromId === "string"? e.fromId: undefined,
timestamp: entryTimeMs(e.timestamp),
})
} else if (e.type === "compaction") {
out.push({
role: "compactionSummary",
summary: typeof e.summary === "string"? e.summary: undefined,
tokensBefore: typeof e.tokensBefore === "number"? e.tokensBefore: undefined,
timestamp: entryTimeMs(e.timestamp),
})
} else if (!e.type && typeof (e as { role?: unknown}).role === "string" && (e as { role?: string}).role!== "system") {
out.push(e as unknown as AgentMessage)
}
}
return out
}

/**
* 这条条目会在转录里产生一个可见条目吗（与 appendSettled 的落点对齐）：
* toolResult 只给已有工具卡补结果、不自成条目；custom 且 display=false 被跳过；
* system 不进镜像。分页计数与指纹序列都按这个口径。
*/
export function isItemEntry(entry: RawEntry): boolean {
if (!entry || typeof entry!== "object") return false
if (entry.type === "message") {
const m = entry.message
if (!isRecord(m) || typeof m.role!== "string" || m.role === "system") return false
return m.role!== "toolResult"
}
if (entry.type === "custom_message") return entry.display!== false
if (entry.type === "branch_summary") return!!entry.summary
if (entry.type === "compaction") return true
if (!entry.type && typeof (entry as { role?: unknown}).role === "string") {
const role = (entry as { role?: string}).role
return role!== "system" && role!== "toolResult"
}
return false
}

/* ---------------- 指纹（对齐用，不是身份） ---------------- */

export type Fingerprint = { kind: string; text: string}

const FP_TEXT_MAX = 80

function fpText(text: string): string {
return text.replace(/\s+/g, " ").trim().slice(0, FP_TEXT_MAX)
}

/** 助手消息指纹文本：正文 + 工具名（纯工具调用的消息正文为空，靠工具名序列区分）。 */
function assistantFpText(content: unknown): string {
const tools: string[] = []
if (Array.isArray(content)) {
for (const block of content) {
if (isRecord(block) && block.type === "toolCall" && typeof block.name === "string" && block.name) tools.push(block.name)
}
}
return fpText(textOf(content) + "\u0001" + tools.join(","))
}

export function entryFingerprint(entry: RawEntry): Fingerprint | null {
if (!isItemEntry(entry)) return null
if (entry.type === "custom_message") return { kind: "custom", text: fpText(textOf(entry.content))}
if (entry.type === "branch_summary" || entry.type === "compaction") {
return { kind: "summary", text: fpText(typeof entry.summary === "string"? entry.summary: "")}
}
const m = (entry.type === "message"? entry.message: entry) as RawEntry["message"]
if (!isRecord(m)) return null
const role = typeof m.role === "string"? m.role: ""
if (role === "user") return { kind: "user", text: fpText(textOf(m.content))}
if (role === "assistant") return { kind: "assistant", text: assistantFpText(m.content)}
if (role === "bashExecution") return { kind: "bash", text: fpText(typeof m.command === "string"? m.command: "")}
if (role === "branchSummary" || role === "compactionSummary") {
return { kind: "summary", text: fpText(typeof m.summary === "string"? m.summary: "")}
}
return { kind: "custom", text: fpText(textOf(m.content) || (typeof m.summary === "string"? m.summary: ""))}
}

export function itemFingerprint(item: Item): Fingerprint | null {
switch (item.kind) {
case "user":
return { kind: "user", text: fpText(item.text)}
case "assistant": {
const texts: string[] = []
const tools: string[] = []
for (const block of item.blocks) {
if (block.kind === "text") texts.push(block.text)
else if (block.kind === "tool") tools.push(block.name)
}
return { kind: "assistant", text: fpText(texts.join("\n") + "\u0001" + tools.join(","))}
}
case "bash":
return { kind: "bash", text: fpText(item.command)}
case "summary":
return { kind: "summary", text: fpText(item.text)}
case "custom":
return { kind: "custom", text: fpText(item.text)}
}
}

/**
* 转录头部指纹序列（发现首个游标用）：从第一条起最多 10 条；
* 遇到乐观气泡（echo）/ live 气泡就停（它们不是历史对齐面）；
* patchTool 的孤儿工具卡（key 前缀 t）不对应独立条目，跳过不计。
*/
export function headFingerprints(items: Item[]): Fingerprint[] {
const out: Fingerprint[] = []
for (const item of items) {
if (out.length >= 10) break
if (item.kind === "assistant" && item.live) break
if (item.kind === "user" && item.echo!== undefined) break
if (item.key.startsWith("t")) continue
const fp = itemFingerprint(item)
if (fp) out.push(fp)
}
return out
}

/* ---------------- 分支链与切窗 ---------------- */

export type ChainEntry = { entry: RawEntry; id: string; index: number}

/** 窗口在全量条目里的起始下标（与回包原子自洽）。 */
export function windowStartOf(result: EntriesResult): number {
return Math.max(0, result.total - result.entries.length)
}

/**
* 窗口内的活动分支链：从 fromId 沿 parentId 回溯到窗口边缘为止（正序返回，末尾即 fromId）。
* fromId 不在窗口里返回空数组。侧支条目不在链上，自动排除。
*/
export function chainInWindow(result: EntriesResult, fromId: string): ChainEntry[] {
if (!fromId) return []
const start = windowStartOf(result)
const byId = new Map<string, ChainEntry>()
result.entries.forEach((entry, i) => {
const id = entryIdOf(entry)
if (id) byId.set(id, { entry, id, index: start + i})
})
const chain: ChainEntry[] = []
const seen = new Set<string>()
let cur = byId.get(fromId)
while (cur &&!seen.has(cur.id)) {
seen.add(cur.id)
chain.push(cur)
const parent = parentIdOf(cur.entry)
cur = parent? byId.get(parent): undefined
}
chain.reverse()
return chain
}

export type AnchorHit = { id: string; index: number; chainPos: number}

/**
* 在分支链里找“转录头部”的对齐点：头部指纹序列应在链的可见条目指纹序列里连续命中，
* 命中段的第一条即 UI 当前最早一条所对应的条目（首个游标）。
* 取连续命中最长的候选；并列时取最靠后的一处：游标偏新最多让下一页带回一两条
* 已加载消息（看得见的重复），游标偏旧会在历史中间留下看不见的洞——取前者。
* 命中不足 2 条（转录总共只有 1 条时为 1 条）视为没找到。
*/
export function findAnchor(chain: ChainEntry[], head: Fingerprint[]): AnchorHit | null {
if (!head.length ||!chain.length) return null
const seg: { pos: number; fp: Fingerprint}[] = []
chain.forEach((ce, pos) => {
const fp = entryFingerprint(ce.entry)
if (fp) seg.push({ pos, fp})
})
if (!seg.length) return null
const same = (a: Fingerprint, b: Fingerprint) => a.kind === b.kind && a.text === b.text
let best: { segAt: number; run: number} | null = null
for (let s = 0; s < seg.length; s += 1) {
if (!same(seg[s].fp, head[0])) continue
let run = 0
while (s + run < seg.length && run < head.length && same(seg[s + run].fp, head[run])) run += 1
if (!best || run > best.run || (run === best.run && s > best.segAt)) best = { segAt: s, run}
}
const need = Math.min(2, head.length)
if (!best || best.run < need) return null
const pos = seg[best.segAt].pos
return { id: chain[pos].id, index: chain[pos].index, chainPos: pos}
}

export type HistorySlice = {
/** 本片转换出的消息（正序，严格位于游标之前）；窗口不够大时可能为空。 */
messages: AgentMessage[]
/** 本片最旧的条目 = 下一页的游标；片为空时为 null。 */
oldest: ChainEntry | null
/** 本片之上再无更早条目（已到分支根部）。 */
reachedRoot: boolean
/** 本片因窗口边缘被截断（更早的链还在窗口外）：想要满页时调用方应扩窗重切。 */
windowBounded: boolean
/** 本片含有的可见条目数。 */
itemCount: number
}

/**
* 从分支链上切下游标之前的一片：最多 pageSize 个可见条目，分界落在可见条目上
* （保证 toolResult 不脱离其助手条目成为孤儿卡）。chain 必须以游标结尾
* （即 chainInWindow(result, cursorId) 的结果）。
*/
export function slicePageBefore(chain: ChainEntry[], cursorId: string, pageSize: number): HistorySlice {
const pos = chain.findIndex((ce) => ce.id === cursorId)
if (pos < 0) return { messages: [], oldest: null, reachedRoot: false, windowBounded: true, itemCount: 0}
if (pos === 0) {
const root =!parentIdOf(chain[0].entry)
return { messages: [], oldest: null, reachedRoot: root, windowBounded:!root, itemCount: 0}
}
const visibleAt: number[] = []
for (let i = 0; i < pos; i += 1) if (isItemEntry(chain[i].entry)) visibleAt.push(i)
if (!visibleAt.length) {
// 窗内游标之前全是非可见条目：本窗定不了分界，交给调用方扩窗
const bounded =!!parentIdOf(chain[0].entry)
return { messages: [], oldest: null, reachedRoot:!bounded, windowBounded: bounded, itemCount: 0}
}
const take = Math.min(pageSize, visibleAt.length)
const from = visibleAt[visibleAt.length - take]
const slice = chain.slice(from, pos)
const rootAtStart = from === 0 &&!parentIdOf(chain[0].entry)
return {
messages: entriesToMessages(slice.map((ce) => ce.entry)),
oldest: chain[from],
reachedRoot: rootAtStart,
windowBounded: from === 0 &&!!parentIdOf(chain[0].entry) && take < pageSize,
itemCount: take,
}
}
