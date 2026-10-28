import { ChevronDown, Folder, Plus } from "lucide-react"
import type { PiContainerProps } from "@/pi/containers/types"
import type { ClaudeListRow, ClaudeSidebarModel } from "../model/view"
import { ClaudeSessionRow } from "./ClaudeSessionRow"
import { relativeShort } from "../model/format"
import { useNow } from "../primitives/useClaude"
import { setNewSessionSeed } from "../model/newSessionSeed"

/**
 * 分组（[C-图12②③]）：组头 = 设备/目录名 + 「+」在目录里新建；组内会话行；「更多 N」/「收起」。
 */
export function ClaudeSessionGroup({
  p,
  group,
  density,
  onOpenRow,
}: {
  p: PiContainerProps
  group: ClaudeSidebarModel["groups"][number]
  density: "compact" | "comfortable"
  onOpenRow: (row: ClaudeListRow) => void
}) {
  const { act } = p
  const now = useNow(30_000)
  const openNew = () => {
    setNewSessionSeed({ deviceId: group.deviceId, folder: group.cwd })
    act.newSession()
  }
  return (
    <section className="claude-group" data-claude-offline={group.offline ? "" : undefined}>
      <header className="claude-group-head">
        <span className="claude-group-label">{group.label || "未命名目录"}</span>
        {group.offline ? <span className="claude-group-offline">未连接</span> : null}
        <button type="button" className="claude-group-new" aria-label={`在 ${group.label || "这个目录"} 新建会话`} onClick={openNew}>
          <Plus size={13} strokeWidth={2} aria-hidden />
        </button>
      </header>
      {group.folderOnly ? (
        <button type="button" className="claude-row claude-row-folder" onClick={openNew}>
          <Folder size={14} strokeWidth={1.5} aria-hidden className="claude-row-icon" />
          <span className="claude-row-title">打开这个文件夹…</span>
        </button>
      ) : (
        group.rows.map((row) => {
          const listRow: ClaudeListRow = {
            id: row.id,
            title: row.title,
            marker: row.marker,
            time: row.at != null ? relativeShort(row.at, now) : "",
            deviceId: row.deviceId,
            dimmed: row.dimmed,
            platform: row.platform,
            trailingText: row.trailingText,
            trailingTone: row.trailingTone,
          }
          return <ClaudeSessionRow key={row.id} p={p} row={listRow} density={density} onOpen={() => onOpenRow(listRow)} />
        })
      )}
      {group.more != null && group.more > 0 ? (
        <button type="button" className="claude-group-more" onClick={() => act.toggleExpanded(group.key)}>
          <ChevronDown size={12} strokeWidth={1.75} aria-hidden /> 更多 {group.more}
        </button>
      ) : null}
      {group.expanded ? (
        <button type="button" className="claude-group-more" onClick={() => act.toggleExpanded(group.key)}>
          收起
        </button>
      ) : null}
    </section>
  )
}
