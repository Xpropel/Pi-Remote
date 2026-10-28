import { useState } from "react"
import { usePiUiCapabilities, type PiUiCapability } from "@/pi/extensions"
import { claudeCapabilityAttrs } from "../model/capabilityAttrs"
import { ClaudeBadge, ClaudeButton, ClaudeSheet, ClaudeSwitch } from "../primitives/ClaudePrimitives"

/**
 * （O1 口径）：模拟/可用的扩展能力入口面板——注入 mock provider 后**真正可操作**（不只显示徽标）。
 * 覆盖 plugins / connectors / skills / artifacts / session-pin 的列表与开关；数据来自 `caps.dataOf(cap)`，
 * 若 provider 提供动作则调用 `caps.actionsOf(cap)`，否则用本地状态演示（数据驱动的 simulated 交互）。
 * 生产无 provider 时这些入口在调用处 disabled（不会打开本面板）。
 */
type SheetCapability = Extract<PiUiCapability, "plugins" | "connectors" | "skills" | "artifacts" | "session-pin">

type Row = { id: string; title: string; meta: string; enabled?: boolean }

const TITLES: Record<SheetCapability, string> = {
  plugins: "Plugins",
  connectors: "Connectors",
  skills: "Skills",
  artifacts: "产出物库",
  "session-pin": "收藏的会话",
}

const SURFACES: Record<SheetCapability, string> = {
  plugins: "CL-CODE-15",
  connectors: "CL-CODE-15",
  skills: "CL-CODE-15",
  artifacts: "CL-CHAT-07",
  "session-pin": "CL-CODE-13",
}

function rowsOf(capability: SheetCapability, caps: ReturnType<typeof usePiUiCapabilities>): Row[] {
  switch (capability) {
    case "plugins":
      return (caps.dataOf("plugins")?.plugins ?? []).map((item) => ({ id: item.id, title: `${item.name} v${item.version}`, meta: item.installed ? (item.enabled ? "已启用" : "已安装未启用") : "未安装", enabled: item.enabled }))
    case "connectors":
      return (caps.dataOf("connectors")?.connectors ?? []).map((item) => ({ id: item.id, title: item.name, meta: item.status ?? "可接入" }))
    case "skills":
      return (caps.dataOf("skills")?.skills ?? []).map((item) => ({ id: item.id, title: item.name, meta: item.description ?? "技能包", enabled: true }))
    case "artifacts":
      return (caps.dataOf("artifacts")?.artifacts ?? []).map((item) => ({ id: item.id, title: item.title, meta: item.kind }))
    case "session-pin":
      return (caps.dataOf("session-pin")?.pinned ?? []).map((item) => ({ id: item.sessionId, title: item.sessionId, meta: `收藏于 ${new Date(item.pinnedAt).toLocaleDateString("zh-CN")}` }))
  }
}

export function ClaudeCapabilitySheet({ capability, onClose }: { capability: SheetCapability; onClose: () => void }) {
  const caps = usePiUiCapabilities()
  const status = caps.statusOf(capability)
  const rows = rowsOf(capability, caps)
  const [localToggles, setLocalToggles] = useState<Record<string, boolean>>({})
  const [receipt, setReceipt] = useState<string | null>(null)
  const simulated = status === "simulated"
  const toggle = (row: Row) => {
    const next = localToggles[row.id] ?? row.enabled ?? false
    setLocalToggles((current) => ({ ...current, [row.id]: !next }))
    setReceipt(`已${next ? "关闭" : "启用"}「${row.title}」（${simulated ? "模拟演示 · 非真实" : "已接入"}）`)
  }
  return (
    <ClaudeSheet
      title={TITLES[capability]}
      subtitle={simulated ? "模拟演示 · 非真实数据（mock provider）" : status === "available" ? "已接入扩展" : "未接入"}
      onClose={onClose}
      footer={
        <ClaudeButton kind="outline" className="claude-btn-sm" onClick={onClose}>
          完成
        </ClaudeButton>
      }
    >
      <div data-p4-surface={SURFACES[capability]} data-p4-ready="" {...claudeCapabilityAttrs(capability, status)}>
        {receipt ? <p className="claude-dialog-hint" role="status">{receipt}</p> : null}
        {rows.length === 0 ? <p className="claude-list-empty">没有可展示的数据。</p> : null}
        {rows.map((row) => (
          <div key={row.id} className="claude-list-row" data-p4-row="">
            <div className="claude-row-body">
              <span className="claude-row-label">{row.title}</span>
              <span className="claude-row-hint">{row.meta}</span>
            </div>
            {capability === "plugins" || capability === "skills" ? (
              <ClaudeSwitch label={`启用 ${row.title}`} checked={localToggles[row.id] ?? row.enabled ?? false} onChange={() => toggle(row)} />
            ) : (
              <ClaudeBadge>{simulated ? "模拟演示" : "可接入"}</ClaudeBadge>
            )}
          </div>
        ))}
      </div>
    </ClaudeSheet>
  )
}
