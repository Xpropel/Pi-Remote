/**
 * r-s1 会话的编辑记录与由它推出的数字：流内 diff 卡、改动视图、tray"改动 +N −M"、git diff --stat 的输出都从这里算。
 */
import {
  CONVERSATION_PATCH,
  CONVERSATION_PATH,
  KEYBOARD_TEST_CONTENT,
  KEYBOARD_TEST_PATH,
  VIEWPORT_PATH,
  VIEWPORT_V0,
  VIEWPORT_V1,
  VIEWPORT_V2,
} from "@/pi/dev/fixtures/gallery/bFiles"
import { contentToRows, hunksToRows, parsePatch, unifiedPatch } from "@/components/pi/conversation/patch"
import type { DiffRow } from "@/components/kit"
import type { PiEditRecord } from "@/components/pi/shared/types"

/** 第一次编辑（更早的回合）：加 focused 判定 */
export const EDIT_VIEWPORT_1 = unifiedPatch(VIEWPORT_PATH, VIEWPORT_V0, VIEWPORT_V1)
/** 第二次编辑（CONVO_DONE 这一回合）：收起判定改成两步 */
export const EDIT_VIEWPORT_2 = unifiedPatch(VIEWPORT_PATH, VIEWPORT_V1, VIEWPORT_V2)

/** 本会话的 edit / write 记录（按先后） */
export const EDIT_RECORDS: PiEditRecord[] = [
  { toolCallId: "toolu_01W3n8", tool: "write", path: KEYBOARD_TEST_PATH, patch: "" },
  { toolCallId: "toolu_01Kp2q", tool: "edit", path: VIEWPORT_PATH, patch: EDIT_VIEWPORT_1 },
  { toolCallId: "toolu_01Rz7c", tool: "edit", path: CONVERSATION_PATH, patch: CONVERSATION_PATCH },
  { toolCallId: "toolu_01Hd5v", tool: "edit", path: VIEWPORT_PATH, patch: EDIT_VIEWPORT_2 },
]

export interface ChangedFile {
  path: string
  added: number
  removed: number
  isNew: boolean
  /** 本会话里编辑了几次 */
  edits: number
  /** 改动视图里的 unified diff（含"N 行未改动"折叠条） */
  rows: DiffRow[]
}

/** 改动视图的文件行（按路径排序；同一文件多次编辑合成一份，与 git 的口径不同：只看本会话的编辑记录） */
export const CHANGED_FILES: ChangedFile[] = (() => {
  const viewport = parsePatch(unifiedPatch(VIEWPORT_PATH, VIEWPORT_V0, VIEWPORT_V2))
  const conversation = parsePatch(CONVERSATION_PATCH)
  const testRows = contentToRows(KEYBOARD_TEST_CONTENT)
  const files: ChangedFile[] = [
    {
      path: VIEWPORT_PATH,
      added: viewport.added,
      removed: viewport.removed,
      isNew: false,
      edits: EDIT_RECORDS.filter((r) => r.path === VIEWPORT_PATH).length,
      rows: hunksToRows(viewport.hunks, undefined, VIEWPORT_V2.length),
    },
    {
      path: CONVERSATION_PATH,
      added: conversation.added,
      removed: conversation.removed,
      isNew: false,
      edits: 1,
      rows: hunksToRows(conversation.hunks),
    },
    { path: KEYBOARD_TEST_PATH, added: testRows.length, removed: 0, isNew: true, edits: 1, rows: testRows },
  ]
  return files
})()

export const CHANGES_TOTAL = CHANGED_FILES.reduce(
  (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
  { added: 0, removed: 0 },
)

/** `git diff --stat` 的输出（与上面的数字同源；会话开始时工作区是干净的） */
export const GIT_DIFF_STAT = (() => {
  const sorted = [...CHANGED_FILES].sort((a, b) => a.path.localeCompare(b.path))
  const w = Math.max(...sorted.map((f) => f.path.length))
  const nw = Math.max(...sorted.map((f) => String(f.added + f.removed).length))
  const lines = sorted.map(
    (f) => ` ${f.path.padEnd(w)} | ${String(f.added + f.removed).padStart(nw)} ${"+".repeat(f.added)}${"-".repeat(f.removed)}`,
  )
  lines.push(
    ` ${sorted.length} files changed, ${CHANGES_TOTAL.added} insertions(+), ${CHANGES_TOTAL.removed} deletions(-)`,
  )
  return lines.join("\n")
})()

/** read 读到的内容（v1，带不带行号由工具决定；这里给原文） */
export const VIEWPORT_V1_TEXT = VIEWPORT_V1.join("\n") + "\n"
export const VIEWPORT_V2_TEXT = VIEWPORT_V2.join("\n") + "\n"
