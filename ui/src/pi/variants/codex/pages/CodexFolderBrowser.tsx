import { useCallback, useEffect, useState } from "react"
import { FolderClosed } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import { breadcrumbOf, BROWSE_REASON, type DirEntry, type FolderCrumb } from "@/pi/model/folderBrowser"
import { CodexButton, CodexCentered, CodexDialog, CodexSpinner } from "../primitives/primitives"

type DirList = { path: string; root: string; parent: string | null; entries: DirEntry[]; truncated: boolean }

/**
 * Codex 文件夹浏览器（P9 C 行为等价 / X-09）：面包屑 + 条目列表 + 隐藏开关 + 上翻；错误码文案原样显示；
 * 行为复用 @/pi/model/folderBrowser（breadcrumbOf / filterFolders / BROWSE_REASON），目录数据走 relay.listDirs。
 * 呈现 100% 自写（不 import PiFolderBrowser）。
 */
export function CodexFolderBrowser({
  p,
  deviceId,
  scopeLabel,
  initialPath,
  open,
  onOpenChange,
  onPick,
}: {
  p: VariantAppProps
  deviceId: string
  scopeLabel: string
  initialPath: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (path: string) => void
}) {
  const [state, setState] = useState<DirList | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const load = useCallback(
    async (path?: string, hidden = false) => {
      setLoading(true)
      setError(null)
      try {
        const result = await p.relay.listDirs(deviceId, path ?? initialPath ?? undefined, hidden)
        setState(result as DirList)
        setTruncated(result.truncated)
      } catch (e) {
        const code = (e as { code?: string }).code
        const message = e instanceof Error ? e.message : ""
        setError((code && (BROWSE_REASON as Record<string, string>)[code]) || message || "读取目录失败")
      } finally {
        setLoading(false)
      }
    },
    [p.relay, deviceId, initialPath],
  )
  useEffect(() => {
    if (open && state == null) void load()
  }, [open, state, load])
  if (!open) return null
  const crumbs: FolderCrumb[] = state ? breadcrumbOf(state.path, state.root) : []
  return (
    <CodexDialog
      title="打开文件夹"
      subtitle={scopeLabel}
      onClose={() => onOpenChange(false)}
      width={560}
      footer={
        <>
          <CodexButton kind="ghost" onClick={() => onOpenChange(false)}>
            取消
          </CodexButton>
          <CodexButton kind="primary" disabled={!state} onClick={() => state && onPick(state.path)}>
            选择这个文件夹
          </CodexButton>
        </>
      }
    >
      <div className="cx-folder">
        <div className="cx-folder-bar">
          <button type="button" className="cx-folder-up" disabled={!state?.parent} onClick={() => state?.parent && void load(state.parent, showHidden)}>
            ↑ 上一级
          </button>
          <div className="cx-folder-crumbs">
            {crumbs.map((crumb, index) => (
              <span key={crumb.path}>
                {index > 0 ? <span className="cx-folder-sep">/</span> : null}
                <button type="button" className="cx-folder-crumb" onClick={() => void load(crumb.path, showHidden)}>
                  {crumb.label || crumb.path}
                </button>
              </span>
            ))}
          </div>
          <label className="cx-folder-hidden">
            <input type="checkbox" checked={showHidden} onChange={(event) => { setShowHidden(event.target.checked); void load(state?.path, event.target.checked) }} />
            显示隐藏
          </label>
        </div>
        <div className="cx-folder-list">
          {loading ? (
            <div className="cx-folder-loading">
              <CodexSpinner size={14} /> 正在读取目录…
            </div>
          ) : error ? (
            <CodexCentered
              title="读取失败"
              body={
                <>
                  {error} ·{" "}
                  <button type="button" className="cx-inline-link" onClick={() => void load(state?.path, showHidden)}>
                    重试
                  </button>
                </>
              }
            />
          ) : state && state.entries.length === 0 ? (
            <CodexCentered title="这个目录下没有子目录" />
          ) : (
            (state?.entries ?? []).map((entry) => (
              <button key={entry.path} type="button" className="cx-folder-row" onClick={() => void load(entry.path, showHidden)}>
                <FolderClosed aria-hidden size={14} strokeWidth={1.5} />
                <span>{entry.name}</span>
              </button>
            ))
          )}
          {truncated ? <p className="cx-panel-fault">目录太大，只显示前面一段</p> : null}
        </div>
        <p className="cx-folder-note">{state ? state.path : ""}</p>
      </div>
    </CodexDialog>
  )
}
