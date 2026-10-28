import { useState } from "react"
import { FileText } from "../icons/CodexIcons"
import { CodexCaret, CodexDiffRows } from "../thread/CodexDiffCard"

export type ChangeFile = { path: string; added: number; removed: number; rows: ReturnType<typeof import("../model/fold").codexFoldDiffRows> }

/** 逐文件 diff 列表（[X-图10②][X-图2④]：文件名 + ± + 展开行红绿 + N 行未改动） */
export function CodexChangesList({ files, emptyText }: { files: readonly { path: string; added: number; removed: number; rows: ReturnType<typeof import("../model/fold").codexFoldDiffRows> }[]; emptyText?: string }) {
  const [openPath, setOpenPath] = useState<string | null>(files[0]?.path ?? null)
  if (files.length === 0) return <p className="cx-panel-empty-note">{emptyText ?? "这个会话还没有编辑文件"}</p>
  return (
    <div className="cx-changes">
      {files.map((file) => {
        const open = openPath === file.path
        return (
          <div className="cx-file" key={file.path} data-open={open ? "" : undefined}>
            <button type="button" className="cx-file-head" onClick={() => setOpenPath(open ? null : file.path)} aria-expanded={open}>
              <CodexCaret open={open} />
              <FileText aria-hidden size={13} strokeWidth={1.5} className="cx-file-icon" />
              <span className="cx-file-path">{file.path}</span>
              <span className="cx-file-stat">
                <span className="cx-add">+{file.added}</span> <span className="cx-del">−{file.removed}</span>
              </span>
            </button>
            {open ? <CodexDiffRows rows={file.rows as never} /> : null}
          </div>
        )
      })}
    </div>
  )
}
