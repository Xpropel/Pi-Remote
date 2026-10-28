/** a/session-search：查询「键盘」；标题匹配走本地过滤，正文匹配是 search_session_bodies 在 MacBook Pro 上的回包（扫完 13 个文件）。 */
import { BASE, commandTable, NOTES, PI_REMOTE } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const S = 1000
const H = 3600 * S

/** search_session_bodies 回包（BodySearchPage 形状；replica a/mock.ts A_BODY_SEARCH） */
export const BODY_SEARCH_PAGE = {
  query: "键盘",
  results: [
    {
      session: "/Users/dev/.pi/agent/sessions/--Users-dev-code-pi-remote--/2026-10-24T02-21-07_a83d0c52.jsonl", id: "r-s2",
      title: "relay 重启后提示结果未知",
      cwd: PI_REMOTE,
      mtime: MOCK_NOW - 20 * S,
      matchCount: 1,
      snippets: [{ text: "…键盘收起后重连横幅…", entryId: "e-41" }],
    },
    {
      session: "/Users/dev/.pi/agent/sessions/--Users-dev-code-notes-app--/2026-10-24T05-03-44_6a1f8c3d.jsonl", id: "r-s5",
      title: "日记页加离线缓存",
      cwd: NOTES,
      mtime: MOCK_NOW - 5 * H,
      matchCount: 2,
      snippets: [
        { text: "…iOS 键盘弹出时工具栏…", entryId: "e-12" },
        { text: "…键盘遮住了保存按钮…", entryId: "e-19" },
      ],
    },
  ],
  truncated: false,
  scannedFiles: 13,
  totalFiles: 13,
}

const fixture: PiLiveFixture = {
  id: "session-search",
  now: MOCK_NOW,
  note: "查询词「键盘」是搜索框的本地状态，不在 relay 里（#/live 的 seeds-a.ts 给 ui.search）；容器按它调 searchSessions 和 searchSessionBodies。",
  relay: {
    ...BASE,
    searchSessionBodies: async () => BODY_SEARCH_PAGE,
    runCommand: commandTable({ get_git_branch: { branch: "main", repoRoot: PI_REMOTE, detached: false } }),
  },
}
export default fixture
