import { useState } from "react"
import { Copy, Ellipsis } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import { useCodexCapability } from "../logic/capability"
import { copyToClipboard, roomDevice, roomTitle } from "../logic/view"

/**
 * 线程头（[X-图1] / CX-THREAD-06）：标题 + 设备 + ⋯ 菜单 + Open / Commit（首发动作）。
 * Open 走 `file-editor` 能力、Commit 走 `git-commit` 能力：生产无 provider 时禁用并解释（DOC/74 锚点）；
 * dev mock 注入后可点（动作由扩展 provider 承接）。呈现自写。
 */
export function CodexThreadHead({ p }: { p: VariantAppProps }) {
  const { relay } = p
  const fileEditor = useCodexCapability("file-editor")
  const gitCommit = useCodexCapability("git-commit")
  const [menuOpen, setMenuOpen] = useState(false)
  const title = roomTitle(relay)
  const device = roomDevice(relay)
  const explain = (cap: ReturnType<typeof useCodexCapability>, what: string) => {
    relay.notify(cap.view ? `${what}：${cap.view.reason}（见 ${cap.view.docsPath}）` : `${what} 由已注入的扩展 provider 处理`, cap.view ? "warn" : undefined)
  }
  return (
    <div className="cx-thread-head" data-p4-surface="CX-THREAD-06" data-p4-ready="">
      <div className="cx-thread-head-main">
        <span className="cx-thread-head-title" title={title}>
          {title}
        </span>
        {device ? <span className="cx-thread-head-device">{device}</span> : null}
      </div>
      <div className="cx-thread-head-actions">
        <button
          type="button"
          className="cx-thread-action"
          data-p4-action="open-editor"
          data-capability-state={fileEditor.status}
          data-pi-capability-disabled={!fileEditor.interactive ? "" : undefined}
          title={fileEditor.interactive ? "在设备上打开（扩展）" : "在设备上打开（需扩展）"}
          onClick={() => explain(fileEditor, "在设备上打开")}
        >
          打开
        </button>
        <button
          type="button"
          className="cx-thread-action"
          data-p4-action="commit"
          data-capability-state={gitCommit.status}
          data-pi-capability-disabled={!gitCommit.interactive ? "" : undefined}
          title={gitCommit.interactive ? "在设备上提交（扩展）" : "在设备上提交（需扩展）"}
          onClick={() => explain(gitCommit, "在设备上提交")}
        >
          提交
        </button>
        <button type="button" className="cx-ghost-icon" aria-label="会话菜单" aria-expanded={menuOpen} data-p4-action="thread-menu" onClick={() => setMenuOpen((open) => !open)}>
          <Ellipsis aria-hidden size={15} strokeWidth={1.5} />
        </button>
        {menuOpen ? (
          <div className="cx-thread-head-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="cx-menu-row"
              onClick={() => {
                setMenuOpen(false)
                if (relay.roomId) void copyToClipboard(relay, relay.roomId, "已复制会话 ID")
              }}
            >
              <Copy aria-hidden size={12} strokeWidth={1.5} />
              <span className="cx-menu-label">复制会话 ID</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="cx-menu-row"
              onClick={() => {
                setMenuOpen(false)
                const cwd = relay.rooms.find((room) => room.id === relay.roomId)?.cwd
                if (cwd) void copyToClipboard(relay, cwd, "已复制工作目录")
              }}
            >
              <Copy aria-hidden size={12} strokeWidth={1.5} />
              <span className="cx-menu-label">复制工作目录</span>
            </button>
            <p className="cx-menu-note">分叉 / 归档 / 多标签需要扩展后可用。</p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
