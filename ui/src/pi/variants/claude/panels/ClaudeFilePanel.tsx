import { useState } from "react"
import { FileText, FolderOpen } from "lucide-react"
import type { PiContainerProps } from "@/pi/containers/types"
import { changesOfSession } from "@/pi/model/changes"
import { baseName } from "../model/format"
import { ClaudeButton, ClaudeField } from "../primitives/ClaudePrimitives"

/**
 * 右栏「文件」面板：从本会话改动过的文件里选一个，用 get_file 读源码预览（只读）。
 * 数据：@/pi/model/changes 纯函数 + relay.getFile；渲染自写。
 */
export function ClaudeFilePanel({ p }: { p: PiContainerProps }) {
  const items = p.relay.roomId ? p.relay.transcript.items : null
  const changes = changesOfSession(items)
  const [path, setPath] = useState("")
  const [text, setText] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const open = (target: string) => {
    const next = target.trim()
    if (!next) return
    setPath(next)
    setLoading(true)
    setError("")
    void p.relay.getFile(next).then(
      (reply) => {
        const data = reply as { text?: string; encoding?: string; truncated?: boolean } | null
        const body = data?.text ?? ""
        setText(body)
        setLoading(false)
        if (data?.truncated) setError("文件较大，只显示了一部分")
      },
      (e: unknown) => {
        setLoading(false)
        setError(e instanceof Error ? e.message : "读取文件失败")
      },
    )
  }
  return (
    <div className="claude-filepane">
      <div className="claude-filepane-form">
        <ClaudeField label="文件路径（相对会话工作目录）" value={path} placeholder="/abs/path 或 ./file.ts" onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && open(path)} />
        <ClaudeButton kind="primary" disabled={!path.trim() || loading} onClick={() => open(path)}>
          {loading ? "读取中…" : "打开"}
        </ClaudeButton>
      </div>
      {changes && changes.files.length > 0 ? (
        <div className="claude-filepane-recent">
          <p className="claude-pane-caption">本会话改动过的文件</p>
          {changes.files.map((file) => (
            <button key={file.path} type="button" className="claude-changes-row" onClick={() => open(file.path)}>
              <FileText size={13} strokeWidth={1.5} aria-hidden />
              <span className="claude-changes-name">{baseName(file.path)}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="claude-pane-empty">
          <FolderOpen size={16} strokeWidth={1.5} aria-hidden /> 还没有改动的文件
        </p>
      )}
      {error ? <p className="claude-pane-error">{error}</p> : null}
      {text ? <pre className="claude-filepane-code">{text}</pre> : null}
    </div>
  )
}
