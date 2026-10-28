import { useMemo, useState } from "react"
import { FileText } from "lucide-react"
import type { PiContainerProps } from "@/pi/containers/types"
import { changesOfSession } from "@/pi/model/changes"
import { baseName } from "../model/format"
import { ClaudeDiffCard } from "../thread/ClaudeDiffCard"

/**
 * 右栏「改动」面板（C-11 / [C-图4]）：本会话 edit/write 的工具记录汇总（不是 git 状态）。
 * 数据：@/pi/model/changes 纯函数；渲染自写（文件列表 + 选中文件的 diff 卡）。
 */
export function ClaudeChangesPanel({ p }: { p: PiContainerProps }) {
  const items = p.relay.roomId ? p.relay.transcript.items : null
  const changes = useMemo(() => changesOfSession(items), [items])
  const [selected, setSelected] = useState<string | null>(null)
  if (!changes) return <p className="claude-pane-empty">这个会话还没有改动</p>
  const current = changes.files.find((f) => f.path === selected) ?? changes.files[0]
  return (
    <div className="claude-changes">
      <div className="claude-changes-head">
        <span className="claude-diffstat">
          <span className="claude-diffstat-add">+{changes.added}</span>
          <span className="claude-diffstat-del">−{changes.removed}</span>
        </span>
        <span className="claude-changes-count">{changes.files.length} 个文件</span>
      </div>
      <div className="claude-changes-list">
        {changes.files.map((file) => (
          <button key={file.path} type="button" className="claude-changes-row" data-active={file.path === current.path ? "" : undefined} onClick={() => setSelected(file.path)}>
            <FileText size={13} strokeWidth={1.5} aria-hidden />
            <span className="claude-changes-name">{baseName(file.path)}</span>
            <span className="claude-diffstat">
              <span className="claude-diffstat-add">+{file.added}</span>
              <span className="claude-diffstat-del">−{file.removed}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="claude-changes-diff">
        <ClaudeDiffCard file={baseName(current.path)} added={current.added} removed={current.removed} rows={current.rows} truncated={current.truncated} />
      </div>
    </div>
  )
}
