/**
 * a 区画廊 mock（P3.3 从 components/pi/shell/mock.ts 搬来；引用 ./shared 的 id 与 MOCK_NOW）。形状照 ui/src 的真实类型：
 * - 正文搜索：shell/searchModel.ts 的 BodySearchPage / BodySearchHit
 * - 配对：pair_create 回包（显示用的 formatPairCode / pairCommands / attachCommand 在 components/pi/shell/pairing.ts）
 * - 通知：chat/noticeCore（level / title / body / actions）
 */
import { MOCK_NOW, MOCK_SESSIONS, type PiMockSession } from "./shared"

const s = 1000
const m = 60 * s

/* ---------------- 搜索（session-search） ---------------- */

export const A_SEARCH_QUERY = "键盘"

/** 标题匹配：本地过滤（标题 / 首条消息包含查询词），顺序同列表 */
export function aTitleMatches(query: string = A_SEARCH_QUERY): PiMockSession[] {
  return MOCK_SESSIONS.filter((x) => x.title.includes(query) || (x.firstMessage ?? "").includes(query)).sort(
    (a, b) => Number(b.online) - Number(a.online) || b.updatedAt - a.updatedAt,
  )
}

/** search_session_bodies 回包（BodySearchPage）。在 MacBook Pro 上搜，扫完 13 个会话文件 */
export interface ABodySearchHit {
  session: string
  id: string
  title: string
  cwd: string
  mtime: number
  matchCount: number
  snippets: { text: string; entryId?: string }[]
}
export interface ABodySearchPage {
  query: string
  results: ABodySearchHit[]
  truncated: boolean
  scannedFiles: number
  totalFiles: number
}

export const A_BODY_SEARCH: ABodySearchPage = {
  query: A_SEARCH_QUERY,
  results: [
    {
      session: "/Users/dev/.pi/agent/sessions/--Users-dev-code-pi-remote--/2026-10-24T02-21-07_a83d0c52.jsonl",
      id: "r-s2",
      title: "relay 重启后提示结果未知",
      cwd: "/Users/dev/code/pi-remote",
      mtime: MOCK_NOW - 20 * s,
      matchCount: 1,
      snippets: [{ text: "…键盘收起后重连横幅…", entryId: "e-41" }],
    },
    {
      session: "/Users/dev/.pi/agent/sessions/--Users-dev-code-notes-app--/2026-10-24T05-03-44_6a1f8c3d.jsonl",
      id: "r-s5",
      title: "日记页加离线缓存",
      cwd: "/Users/dev/code/notes-app",
      mtime: MOCK_NOW - 5 * 60 * m,
      matchCount: 2,
      snippets: [{ text: "…iOS 键盘弹出时工具栏…", entryId: "e-12" }, { text: "…键盘遮住了保存按钮…", entryId: "e-19" }],
    },
  ],
  truncated: false,
  scannedFiles: 13,
  totalFiles: 13,
}

/* ---------------- 配对（device-pairing） ---------------- */

/** pair_create 回包：8 位码（formatPairCode 显示成 XXXX-XXXX），10 分钟有效，此刻剩 9:12 */
export const A_PAIR = { code: "K7Q4MX2P", expiresAt: MOCK_NOW + 9 * m + 12 * s }

/* ---------------- 断线与 outbox（reconnecting） ---------------- */

/** 本页 outbox（§1.12，待用户确认 5）：离线时发的一条，按会话存 localStorage，带 cid */
export const A_OUTBOX = [{ cid: "w1k2c9f0", roomId: "r-s1", text: "顺便看看横屏的时候是不是也跳", at: MOCK_NOW - 20 * s }]

/* ---------------- 通知（background-alerts） ---------------- */

/** 从后台回来：relay 重启过（boot 变了），一条有副作用的命令结果未知；后面还排着 2 条 */
export const A_NOTICE = {
  level: "warning" as const,
  title: "刚才的操作结果未知",
  body: "服务器重启过，「压缩上下文」可能没有执行。请先看看会话再操作。",
  actions: [{ label: "查看会话", primary: true }, { label: "知道了" }],
  count: 2,
}
