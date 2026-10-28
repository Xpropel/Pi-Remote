import { useState } from "react"
import { Activity, ChevronRight, FileText, FolderOpen, GitBranch, Package, Server, Terminal, X } from "lucide-react"
import type { PiContainerProps } from "@/pi/containers/types"
import { useGitBranch } from "../model/logic"
import { sessionHeadOf, useRailData } from "../model/view"
import { ClaudeContextRing, ClaudeIconButton, ClaudeMark } from "../primitives/ClaudePrimitives"
import { linkSummaryOf } from "../model/view"
import { ClaudeChangesPanel } from "./ClaudeChangesPanel"
import { ClaudeFilePanel } from "./ClaudeFilePanel"
import { ClaudeTerminalPanel } from "./ClaudeTerminalPanel"
import { usePiUiCapabilities, type PiUiCapability } from "@/pi/extensions"
import { ClaudeArtifactsPanel } from "../overlays/ClaudeArtifactsPanel"
import { claudeCapabilityAttrs } from "../model/capabilityAttrs"

/**
 * Claude v2 自有 session rail（C-11 / §1.5：320px、卡片一列、卡间距 12、S2 卡 + 双环 + 10 圆角，可开关）。
 * ≥4 张卡：环境（设备/分支/目录）、上下文（百分比）、变更（+N −N）、任务/产出、服务器。点卡切右栏面板（改动 / 文件 / 终端）。
 */
export function ClaudeStatusRail({ p, onClose }: { p: PiContainerProps; onClose: () => void }) {
  const { relay, act } = p
  const data = useRailData(p)
  const head = sessionHeadOf(relay)
  const link = linkSummaryOf(relay)
  const branch = useGitBranch(relay, relay.roomId !== "")
  const caps = usePiUiCapabilities()
  const [contextOpen, setContextOpen] = useState(false)
  const [artifactsOpen, setArtifactsOpen] = useState(false)
  const contextUsage = caps.dataOf("context-usage")?.usage
  const artStatus = caps.statusOf("artifacts")
  const artView = artStatus === "unavailable" ? caps.disabledOf("artifacts") : null
  return (
    <aside data-pi-ui-part="rail" className="claude-rail" data-p4-surface="CL-SHELL-07" data-p4-pane="status-rail">
      <div className="claude-rail-head">
        <span className="claude-rail-title">会话状态</span>
        <div className="claude-rail-actions">
          <ClaudeIconButton label="改动" icon={<FileText size={15} strokeWidth={1.5} />} className="claude-iconbtn" onClick={() => act.setPane("changes")} />
          <ClaudeIconButton label="终端" icon={<Terminal size={15} strokeWidth={1.5} />} className="claude-iconbtn" onClick={() => act.setPane("terminal")} />
          <ClaudeIconButton label="文件" icon={<FolderOpen size={15} strokeWidth={1.5} />} className="claude-iconbtn" onClick={() => act.setPane("file")} />
          <ClaudeIconButton
            label="产出物"
            icon={<Package size={15} strokeWidth={1.5} />}
            className="claude-iconbtn"
            data-p4-action="open-artifacts"
            {...claudeCapabilityAttrs("artifacts", artStatus)}
            disabled={artView != null}
            title={artView ? `${artView.title}：${artView.reason}（${artView.docsPath}）` : "产出物库"}
            onClick={() => { if (artView == null) setArtifactsOpen(true) }}
          />
          <ClaudeIconButton label="关闭状态卡" icon={<X size={15} strokeWidth={1.5} />} className="claude-iconbtn" onClick={onClose} />
        </div>
      </div>
      <div className="claude-rail-cards" data-p4-surface="CL-CODE-11">
        <section className="claude-card" data-pi-ui-part="panel">
          <h2 className="claude-card-title">环境</h2>
          <p className="claude-card-row">
            <Server size={14} strokeWidth={1.5} className="claude-card-icon" aria-hidden />
            <span className="claude-card-value">{data.deviceLine}</span>
          </p>
          {branch ? (
            <p className="claude-card-row">
              <GitBranch size={14} strokeWidth={1.5} className="claude-card-icon" aria-hidden />
              <span className="claude-card-value claude-mono">{branch}</span>
            </p>
          ) : null}
          {head.cwd ? <p className="claude-card-sub claude-mono">{head.cwd}</p> : null}
        </section>

        <section className="claude-card">
          <h2 className="claude-card-title">
            上下文
            <button type="button" className="claude-card-link" data-p4-action="rail-context-detail" onClick={() => setContextOpen((v) => !v)} title="按类别细分（模拟演示）">
              细分
            </button>
          </h2>
          <p className="claude-card-row">
            <ClaudeContextRing percent={data.contextPercent} size={26} />
            <span className="claude-card-value">{data.context.label || "还没有用量"}</span>
          </p>
        </section>

        <section className="claude-card">
          <h2 className="claude-card-title">变更</h2>
          {data.changes ? (
            <p className="claude-card-row">
              <span className="claude-diffstat">
                <span className="claude-diffstat-add">+{data.changes.added}</span>
                <span className="claude-diffstat-del">−{data.changes.removed}</span>
              </span>
              <span className="claude-card-sub">{data.changes.files} 个文件</span>
            </p>
          ) : (
            <p className="claude-card-empty">这个会话还没有改动</p>
          )}
          <button type="button" className="claude-card-link" onClick={() => act.setPane("changes")}>
            查看改动
            <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </section>

        <section className="claude-card">
          <h2 className="claude-card-title">
            任务 / 产出
            {data.tasks.total > 0 ? <span className="claude-card-badge">{data.tasks.done}/{data.tasks.total}</span> : null}
          </h2>
          {data.tasks.total > 0 ? (
            <>
              {data.tasks.active ? <p className="claude-card-sub">{data.tasks.active}</p> : null}
              <button type="button" className="claude-card-link" onClick={() => act.setPane("file")}>
                打开文件面板
                <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
              </button>
            </>
          ) : (
            <p className="claude-card-empty">没有进行中的任务</p>
          )}
          <div className="claude-card-links">
            <button type="button" className="claude-card-link" onClick={() => act.setPane("terminal")}>
              终端
            </button>
            <button type="button" className="claude-card-link" onClick={() => act.setPane("file")}>
              文件
            </button>
          </div>
          {contextOpen ? (
            <div className="claude-context-detail" data-p4-surface="CL-CODE-11" data-capability-state={caps.statusOf("context-usage")}>
              <p className="claude-card-sub">已用 {contextUsage?.tokensUsed ?? "—"} / {contextUsage?.contextWindow ?? "—"} tok · {contextUsage?.percent ?? "—"}%（模拟演示）</p>
            </div>
          ) : null}
        </section>

        <section className="claude-card">
          <h2 className="claude-card-title">服务器</h2>
          <p className="claude-card-row" data-link={link.kind}>
            <Activity size={14} strokeWidth={1.5} className="claude-card-icon" aria-hidden />
            <span className="claude-card-value">{link.text}</span>
          </p>
          {link.kind !== "ok" ? (
            <button type="button" className="claude-card-link" onClick={relay.reconnectNow}>
              重新连接
            </button>
          ) : null}
        </section>
        <ClaudeRailExtras />
      </div>
      {artifactsOpen ? <ClaudeArtifactsPanel onClose={() => setArtifactsOpen(false)} /> : null}
    </aside>
  )
}

/**
 * P4 W3-A / CL-SHELL-07 extra + CL-CODE-11：session rail 扩展卡。
 * artifacts / background-tasks / workspace-connectors / session-rail-extra：mock simulated 时显示真实列表数据，
 * 生产 unavailable 时显式禁用行（原因 + docsPath），不再留空。
 */
function ClaudeRailExtras() {
  const caps = usePiUiCapabilities()
  const rows: { capability: PiUiCapability; title: string; items: { id: string; label: string; meta?: string }[] }[] = [
    { capability: "artifacts", title: "产出物", items: (caps.dataOf("artifacts")?.artifacts ?? []).map((item) => ({ id: item.id, label: item.title, meta: item.kind })) },
    { capability: "background-tasks", title: "后台任务", items: (caps.dataOf("background-tasks")?.tasks ?? []).map((item) => ({ id: item.id, label: item.title, meta: item.status })) },
    { capability: "workspace-connectors", title: "扩展连接", items: (caps.dataOf("workspace-connectors")?.connectors ?? []).map((item) => ({ id: item.id, label: item.name, meta: item.status })) },
    { capability: "session-rail-extra", title: "扩展", items: (caps.dataOf("session-rail-extra")?.entries ?? []).map((item) => ({ id: item.id, label: item.label, meta: item.badge })) },
    { capability: "code-review-comments", title: "审查结果", items: (caps.dataOf("code-review-comments")?.threads ?? []).map((thread) => ({ id: thread.id, label: thread.path, meta: `${thread.comments.length} 条评论` })) },
  ]
  return (
    <>
      {rows.map((row) => {
        const status = caps.statusOf(row.capability)
        const view = status === "unavailable" ? caps.disabledOf(row.capability) : null
        return (
          <section key={row.capability} className="claude-card" data-pi-ui-part="panel" data-p4-surface="CL-SHELL-07" {...claudeCapabilityAttrs(row.capability, status)}>
            <h2 className="claude-card-title">{row.title}</h2>
            {row.items.length > 0 ? (
              row.items.slice(0, 4).map((item) => (
                <p key={item.id} className="claude-card-row" data-p4-row="">
                  <span className="claude-card-value">{item.label}</span>
                  {item.meta ? <span className="claude-card-sub">{item.meta}</span> : null}
                </p>
              ))
            ) : (
              <p className="claude-card-empty">{view ? `${view.title}：${view.reason}（${view.docsPath}）` : "暂无数据"}</p>
            )}
          </section>
        )
      })}
    </>
  )
}

/** 右栏（改动 / 文件 / 终端）的容器：pane 有值时替代 rail */
export function ClaudePaneColumn({ p, onClose }: { p: PiContainerProps; onClose: () => void }) {
  const { ui, act } = p
  const pane = ui.pane
  if (!pane) return null
  const title = pane === "changes" ? "改动" : pane === "file" ? "文件" : "终端"
  return (
    <aside data-claude-pane="" data-pi-ui-part="panel" className="claude-pane" data-p4-surface="CL-SHELL-07" data-p4-pane="status">
      <div className="claude-pane-head">
        <div className="claude-pane-tabs" role="tablist" aria-label="右栏视图">
          {(["changes", "file", "terminal"] as const).map((id) => (
            <button key={id} type="button" role="tab" aria-selected={pane === id} data-active={pane === id ? "" : undefined} className="claude-pane-tab" onClick={() => act.setPane(id)}>
              {id === "changes" ? "改动" : id === "file" ? "文件" : "终端"}
            </button>
          ))}
        </div>
        <ClaudeIconButton label={`关闭${title}面板`} icon={<X size={15} strokeWidth={1.5} />} className="claude-iconbtn" onClick={onClose} />
      </div>
      {pane === "changes" ? <ClaudeChangesPanel p={p} /> : pane === "file" ? <ClaudeFilePanel p={p} /> : <ClaudeTerminalPanel p={p} />}
    </aside>
  )
}

/** 手机：状态卡一行（点开 sheet 由 phone shell 控制；这里只给 rail 数据的一个摘要行） */
export function ClaudePhoneStatusBar({ p, onOpen }: { p: PiContainerProps; onOpen: () => void }) {
  const data = useRailData(p)
  const parts: string[] = []
  if (data.contextPercent != null) parts.push(`上下文 ${Math.round(data.contextPercent * 100)}%`)
  if (data.changes) parts.push(`变更 +${data.changes.added} −${data.changes.removed}`)
  if (data.tasks.total > 0) parts.push(`任务 ${data.tasks.done}/${data.tasks.total}`)
  if (parts.length === 0) parts.push(data.deviceLine)
  return (
    <button type="button" className="claude-phone-statusbar" data-pi-ui-part="statusline" onClick={onOpen}>
      <ClaudeMark size={11} />
      <span className="claude-phone-statusbar-text">{parts.join(" · ")}</span>
      <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
    </button>
  )
}

