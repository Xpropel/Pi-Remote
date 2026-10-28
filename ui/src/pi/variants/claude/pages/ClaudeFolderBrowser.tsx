import { useEffect, useState } from "react"
import { ArrowUp, Eye, EyeOff, Folder, X } from "lucide-react"
import type { Device, DirEntry, DirListResult } from "@/relay/devices"
import { breadcrumbOf, emptyFolderBrowserState, folderErrorText, middleEllipsis, type FolderBrowserState } from "@/pi/model/folderBrowser"
import { ClaudeButton, ClaudeDialog, ClaudeIconButton, ClaudeSheet, ClaudeSpinner } from "../primitives/ClaudePrimitives"
import { cx } from "../model/cx"

/**
 * Claude v2 自有文件夹浏览器（P9 C：只列这台设备允许浏览范围内的目录；退 / 进 / 选中三动作、隐藏开关、错误码文案逐字）。
 * 数据：relay.listDirs（list_dirs 命令）+ @/pi/model/folderBrowser 纯函数（面包屑 / 错误文案 / 空状态）。
 */
export function ClaudeFolderBrowser({
  open,
  variant,
  device,
  listDirs,
  initialPath,
  scopeLabel,
  onClose,
  onPick,
}: {
  open: boolean
  variant: "desktop" | "phone"
  device: Device
  listDirs: (deviceId: string, path?: string, showHidden?: boolean) => Promise<DirListResult>
  initialPath: string | null
  scopeLabel: string
  onClose: () => void
  onPick: (path: string) => void
}) {
  const [state, setState] = useState<FolderBrowserState>(() => emptyFolderBrowserState({ path: initialPath ?? "", loading: true }))
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    if (!open) return
    let alive = true
    setState((cur) => ({ ...cur, loading: true, error: null }))
    void listDirs(device.id, state.path || initialPath || "", state.showHidden).then(
      (result) => {
        if (!alive) return
        setState((cur) => ({ ...cur, path: result.path, root: result.root, parent: result.parent, entries: result.entries, truncated: result.truncated, loading: false, error: null }))
      },
      (error: unknown) => {
        if (!alive) return
        const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : ""
        setState((cur) => ({ ...cur, loading: false, error: folderErrorText(code, error instanceof Error ? error.message : "") }))
      },
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reloadKey, state.path, state.showHidden])
  const go = (path: string) => setState((cur) => ({ ...cur, path, loading: true, error: null }))
  const crumbs = breadcrumbOf(state.path, state.root)
  const title = `选择文件夹 · ${scopeLabel}`
  const body = (
    <div className="claude-folderbrowser">
      <div className="claude-folderbrowser-crumbs">
        {crumbs.map((crumb, i) => (
          <span key={crumb.path} className="claude-folderbrowser-crumb">
            {i > 0 ? <span className="claude-folderbrowser-sep">/</span> : null}
            <button type="button" className="claude-link-btn" onClick={() => go(crumb.path)}>
              {crumb.label}
            </button>
          </span>
        ))}
        <span className="claude-folderbrowser-spacer" />
        <ClaudeIconButton
          label={state.showHidden ? "隐藏隐藏文件夹" : "显示隐藏文件夹"}
          icon={state.showHidden ? <EyeOff size={15} strokeWidth={1.5} /> : <Eye size={15} strokeWidth={1.5} />}
          className="claude-iconbtn"
          onClick={() => setState((cur) => ({ ...cur, showHidden: !cur.showHidden }))}
        />
        <ClaudeIconButton label="上一级" icon={<ArrowUp size={15} strokeWidth={1.5} />} className="claude-iconbtn" disabled={state.parent == null} onClick={() => state.parent && go(state.parent)} />
      </div>
      <p className="claude-folderbrowser-path" title={state.path}>
        {middleEllipsis(state.path)}
      </p>
      {state.loading ? (
        <div className="claude-folderbrowser-center">
          <ClaudeSpinner label="正在读取文件夹" />
        </div>
      ) : state.error ? (
        <div className="claude-folderbrowser-center">
          <p className="claude-folderbrowser-error">{state.error}</p>
          <ClaudeButton
            kind="outline"
            onClick={() => {
              setState((cur) => ({ ...cur, error: null }))
              setReloadKey((k) => k + 1)
            }}
          >
            重试
          </ClaudeButton>
        </div>
      ) : state.entries.length === 0 ? (
        <p className="claude-folderbrowser-center claude-folderbrowser-error">这个文件夹里没有子文件夹</p>
      ) : (
        <div className="claude-folderbrowser-list">
          {state.entries.map((entry) => (
            <FolderRow key={entry.path} entry={entry} onOpen={() => go(entry.path)} onPick={() => onPick(entry.path)} />
          ))}
          {state.truncated ? <p className="claude-folderbrowser-note">只列了前 500 个文件夹</p> : null}
        </div>
      )}
      <footer className="claude-folderbrowser-foot">
        <span className="claude-folderbrowser-hint">选中的文件夹会成为新会话的工作目录</span>
        <ClaudeButton kind="outline" onClick={onClose}>
          取消
        </ClaudeButton>
        <ClaudeButton kind="primary" disabled={!state.path} onClick={() => onPick(state.path)}>
          选择这个文件夹
        </ClaudeButton>
      </footer>
    </div>
  )
  if (!open) return null
  if (variant === "phone") {
    return (
      <ClaudeSheet title={title} onClose={onClose}>
        {body}
      </ClaudeSheet>
    )
  }
  return (
    <ClaudeDialog title={title} onClose={onClose} width={560}>
      {body}
    </ClaudeDialog>
  )
}

function FolderRow({ entry, onOpen, onPick }: { entry: DirEntry; onOpen: () => void; onPick: () => void }) {
  return (
    <div className="claude-folderrow">
      <button type="button" className="claude-folderrow-main" onClick={onOpen}>
        <Folder size={16} strokeWidth={1.5} aria-hidden className="claude-folderrow-icon" />
        <span className="claude-folderrow-name">{entry.name}</span>
      </button>
      <button type="button" className="claude-link-btn" onClick={onPick}>
        选它
      </button>
    </div>
  )
}

export { X as ClaudeFolderBrowserX }
void cx
