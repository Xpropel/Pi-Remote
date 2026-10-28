/**
 * P3-4 @提及（路径引用注入）的纯逻辑层 + FileViewer 查看记录。
 *
 * 定版边界（ROUND2-PLAN R2-3 / §4-D3 实测结论，2026-10-22）：
 *  - pi v1.3.0 不展开消息正文内的 `@path`——展开只发生在启动时对 CLI
 *    位置参数的处理（processFileArguments）；经扩展 sendUserMessage 投递的
 *    文本里 `@path` 只是普通文字。实测：pi -p 投递内嵌 @文件 的消息，
 *    session 落盘原文中引用原样保留、文件内容零出现。
 *  - 所以本包的格式不依赖任何展开：发送时在正文之后逐行追加 `@<路径>`
 *    独立引用行（pi 编辑器原生惯用记号），由模型按路径自行读取。
 *  - 呈现红线：chip 与文案只许称“引用”，不许称“附件”——文件内容没有
 *    被上传，引用行之外的任何暗示都算冒充真附件。
 *
 * 候选只来自本会话：transcript 工具入参里出现过的文件路径 + FileViewer
 * 实际读取成功过的文件（下方 noteViewedFile 登记）。绝不扫描目录、
 * 不虚构全盘文件（一期零协议；list_files 二期已按计划砍掉）。
 */
import type { Item } from "../../relay/transcript"

/** 一个待发引用 chip：path 是发送时写进引用行的原文，label 是文件名部分。 */
export type MentionFile = { path: string; label: string }

/** 输入条最多同时挂的引用个数（与图片的 MAX_PENDING_IMAGES 同量级口径）。 */
export const MAX_PENDING_FILES = 10
/** 下拉一次最多列出的候选数。 */
export const MENTION_MENU_LIMIT = 8
/** FileViewer 查看记录的保留上限（最近优先）。 */
const VIEWED_FILES_MAX = 20

/** 路径的文件名部分（兼容 Windows 分隔符）；取不到时回退原串。 */
export function mentionLabel(path: string): string {
  const clean = path.trim()
  const parts = clean.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || clean
}

export type MentionTrigger = {
  /** `@` 在文本中的下标；选中候选时删掉 [start, cursor) 这段。 */
  start: number
  /** `@` 与光标之间的查询串（不含 `@`，不含空白）。 */
  query: string
}

/**
 * 解析光标前的未闭合 `@token`：从光标往前找最近的 `@`，它与光标之间
 * 不许有空白（有空白说明 token 已闭合/已说完）。`@` 的前置字符决定是否
 * 触发：行首、空白、或非 ASCII 字符（中文正文常把 @ 直接跟在汉字后，
 * 中文不靠空格分词）都算词界；ASCII 字母/数字紧贴在前按邮箱型正文处理，
 * 不触发，避免写邮件地址时误弹。
 * 刚打下 `@`（query 为空）也是合法触发（列全部候选）。
 */
export function parseMentionTrigger(text: string, cursor: number): MentionTrigger | null {
  const end = Math.max(0, Math.min(cursor, text.length))
  const upto = text.slice(0, end)
  const at = upto.lastIndexOf("@")
  if (at < 0) return null
  const query = upto.slice(at + 1)
  if (/\s/.test(query)) return null
  if (at > 0) {
    const prev = upto[at - 1]
    if (!/\s/.test(prev) && prev.charCodeAt(0) < 128) return null
  }
  return { start: at, query }
}

/**
 * 候选过滤与排序：文件名开头命中 > 文件名包含 > 路径包含；
 * 同档保持入参顺序（入参已按最近优先排好）。不区分大小写。
 */
export function filterMentionFiles(
  files: readonly MentionFile[],
  query: string,
  limit: number = MENTION_MENU_LIMIT,
): MentionFile[] {
  const q = query.trim().toLowerCase()
  if (!q) return files.slice(0, Math.max(0, limit))
  const scored: { file: MentionFile; rank: number; index: number }[] = []
  files.forEach((file, index) => {
    const label = file.label.toLowerCase()
    const path = file.path.toLowerCase()
    let rank = -1
    if (label.startsWith(q)) rank = 0
    else if (label.includes(q)) rank = 1
    else if (path.includes(q)) rank = 2
    if (rank >= 0) scored.push({ file, rank, index })
  })
  scored.sort((a, b) => a.rank - b.rank || a.index - b.index)
  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.file)
}

/** 与 toolDisplay 的路径键口径一致：工具入参里承载文件路径的键。 */
const PATH_KEYS = ["path", "file_path", "filePath", "file", "target"] as const

/**
 * 像不像一个具体文件路径：要有路径分隔符或文件扩展名；排除 URL、glob
 * （* 不是具体文件）、带空白的串（命令片段/句子不是路径）。
 */
function looksLikeFilePath(value: string): boolean {
  if (!value || value.length > 300 || /\s/.test(value)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false
  if (value.includes("*")) return false
  return value.includes("/") || value.includes("\\") || /\.[A-Za-z0-9]{1,12}$/.test(value)
}

/**
 * 从本会话 transcript 收集出现过的文件路径（最近出现的排前面、去重）。
 * 只认工具块入参里的路径键——bash 命令文本、工具输出、用户正文都不解析，
 * 宁可少列也不虚构。
 */
export function collectTranscriptFiles(items: readonly Item[]): MentionFile[] {
  const seen = new Set<string>()
  const out: MentionFile[] = []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind !== "assistant") continue
    for (const block of item.blocks) {
      if (block.kind !== "tool" || !block.input) continue
      for (const key of PATH_KEYS) {
        const raw = block.input[key]
        if (typeof raw !== "string") continue
        const path = raw.trim()
        if (!looksLikeFilePath(path) || seen.has(path)) continue
        seen.add(path)
        out.push({ path, label: mentionLabel(path) })
      }
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* FileViewer 查看记录：只有真正读取成功的文件才登记（见 FileViewer）。  */
/* 按会话（roomId）分槽（第 2 轮审查 B-4）：A 会话看过的相对路径按 B 会话  */
/* 的 cwd 解析可能指向另一个文件，绝不许跨房推荐。登记走环境房槽（由     */
/* ComposerCard 按当前 roomId 同步），读取由调用方显式报房。              */
/* ------------------------------------------------------------------ */

/** 查看记录最多保留几个房槽（超出淘汰最久未用的房，防长挂多房无限增长）。 */
const VIEWED_ROOMS_MAX = 8

const viewedByRoom = new Map<string, string[]>()
/** 环境房槽：FileViewer 登记时不带房号，落到这里指明的房（ComposerCard 按 roomId 同步）。 */
let viewedRoomKey = ""

/** 同步环境房槽（进入/切换会话时调用）；之后 noteViewedFile 的无房号登记都归这一房。 */
export function setViewedRoomKey(roomKey: string): void {
  viewedRoomKey = roomKey || ""
}

function viewedSlot(roomKey: string | undefined): string[] {
  const key = roomKey === undefined ? viewedRoomKey : roomKey || ""
  let slot = viewedByRoom.get(key)
  if (!slot) {
    slot = []
    viewedByRoom.set(key, slot)
    if (viewedByRoom.size > VIEWED_ROOMS_MAX) {
      // Map 按插入序：删最先插入的房槽（当前房刚被访问，不会被淘汰）
      for (const oldest of viewedByRoom.keys()) {
        if (oldest !== key) {
          viewedByRoom.delete(oldest)
          break
        }
      }
    }
  }
  return slot
}

/** 登记一个在 FileViewer 里成功读到的文件（重复登记只刷新次序）。
 * roomKey 省略时归环境房槽（见 setViewedRoomKey）。 */
export function noteViewedFile(path: string, roomKey?: string): void {
  const clean = path.trim()
  if (!clean) return
  const slot = viewedSlot(roomKey)
  const at = slot.indexOf(clean)
  if (at >= 0) slot.splice(at, 1)
  slot.unshift(clean)
  if (slot.length > VIEWED_FILES_MAX) slot.length = VIEWED_FILES_MAX
}

/** 某房已查看文件（最近查看的排前面）。roomKey 省略时读环境房槽。 */
export function viewedMentionFiles(roomKey?: string): MentionFile[] {
  const key = roomKey === undefined ? viewedRoomKey : roomKey || ""
  return (viewedByRoom.get(key) ?? []).map((path) => ({ path, label: mentionLabel(path) }))
}

/** 候选池整体上限（第 2 轮审查 B-5）：合并后统一截断，不只靠单一来源自觉。 */
export const MENTION_CANDIDATE_MAX = 20

/** 多个候选来源合并：先到先得、按 path 去重（靠前的来源优先），合并后整体截断到上限。 */
export function mergeMentionCandidates(...lists: readonly (readonly MentionFile[])[]): MentionFile[] {
  const seen = new Set<string>()
  const out: MentionFile[] = []
  for (const list of lists) {
    for (const file of list) {
      if (!file.path || seen.has(file.path)) continue
      seen.add(file.path)
      out.push(file)
      if (out.length >= MENTION_CANDIDATE_MAX) return out
    }
  }
  return out
}

/**
 * 定版展开格式：正文之后空一行，逐行一条 `@<路径>` 引用行；
 * 正文为空时只有引用行（不留开头空行）。无引用时原文返回。
 */
export function expandMentionText(body: string, files: readonly MentionFile[]): string {
  if (!files.length) return body
  const lines = files.map((file) => `@${file.path}`)
  return body ? `${body}\n\n${lines.join("\n")}` : lines.join("\n")
}
