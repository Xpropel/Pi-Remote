import { useMemo, useState } from "react"
import { FileText, Search } from "../icons/CodexIcons"

/** 文件树 + Filter files（[X-图10③]：右边文件树点文件联动 diff；这里渲染排序后的文件行 + 过滤框） */
export function CodexFileTree({ paths, activePath, onPick }: { paths: readonly string[]; activePath: string | null; onPick: (path: string) => void }) {
  const [filter, setFilter] = useState("")
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? paths.filter((p) => p.toLowerCase().includes(q)) : paths
  }, [paths, filter])
  return (
    <div className="cx-file-tree">
      <label className="cx-panel-filter">
        <Search aria-hidden size={13} strokeWidth={1.5} />
        <input type="search" value={filter} placeholder="过滤文件…" aria-label="过滤文件" onChange={(event) => setFilter(event.target.value)} />
      </label>
      <ul className="cx-file-tree-list">
        {shown.map((path) => (
          <li key={path}>
            <button type="button" className="cx-file-tree-row" data-active={activePath === path ? "" : undefined} onClick={() => onPick(path)}>
              <FileText aria-hidden size={12} strokeWidth={1.5} />
              <span className="cx-file-tree-path">{path}</span>
              <span className="cx-file-tree-mark" aria-hidden>
                M
              </span>
            </button>
          </li>
        ))}
      </ul>
      {shown.length === 0 ? <p className="cx-panel-empty-note">没有匹配的文件</p> : null}
    </div>
  )
}
