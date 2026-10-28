import { useState } from "react"
import { usePiUiCapabilities } from "@/pi/extensions"
import { ClaudeBadge, ClaudeButton, ClaudeSheet } from "../primitives/ClaudePrimitives"
import { claudeCapabilityAttrs } from "../model/capabilityAttrs"

/**
 * P4 W3-B / CL-CHAT-07/08：Artifacts 面板 + 库（Preview / Code 两看法）。
 * 能力 `artifacts`：simulated（mock）下列表可选、Preview/Code 切换、打开动作回执；生产 unavailable 整卡禁用 + 原因 + docsPath。
 */
export function ClaudeArtifactsPanel({ onClose }: { onClose: () => void }) {
  const caps = usePiUiCapabilities()
  const status = caps.statusOf("artifacts")
  const view = status === "unavailable" ? caps.disabledOf("artifacts") : null
  const artifacts = caps.dataOf("artifacts")?.artifacts ?? []
  const [activeId, setActiveId] = useState<string | null>(null)
  const [mode, setMode] = useState<"preview" | "code">("preview")
  const [query, setQuery] = useState("")
  const [receipt, setReceipt] = useState<string | null>(null)
  const active = artifacts.find((item) => item.id === activeId) ?? artifacts[0] ?? null
  const openArtifact = () => {
    if (!active) return
    caps.actionsOf("artifacts")?.openArtifact?.(active.id)
    setReceipt(`已打开「${active.title}」（${status === "simulated" ? "模拟演示 · 非真实" : "已接入"}）`)
  }
  return (
    <ClaudeSheet
      title="产出物"
      subtitle={status === "simulated" ? "模拟演示 · 非真实数据" : view ? "未接入" : "已接入"}
      onClose={onClose}
      footer={
        <ClaudeButton kind="outline" className="claude-btn-sm" onClick={onClose}>
          关闭
        </ClaudeButton>
      }
    >
      <div data-p4-surface="CL-CHAT-07" data-p4-ready="" {...claudeCapabilityAttrs("artifacts", status)}>
        {view ? (
          <p className="claude-dialog-hint">
            {view.title}：{view.reason}；接入后即可浏览产物 → {view.docsPath}
          </p>
        ) : (
          <div className="claude-artifacts">
            <div className="claude-artifacts-list" data-p4-surface="CL-CHAT-08">
              <input className="claude-input" placeholder="搜索所有对话的产物…" aria-label="搜索产物" data-p4-action="artifact-search" value={query} onChange={(event) => setQuery(event.target.value)} />
              {artifacts.length === 0 ? <p className="claude-list-empty">还没有产物。</p> : null}
              {artifacts.filter((item) => item.title.toLowerCase().includes(query.toLowerCase())).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="claude-list-row claude-list-row-click"
                  data-p4-row=""
                  data-active={active?.id === item.id ? "" : undefined}
                  data-p4-action="artifact-select"
                  onClick={() => setActiveId(item.id)}
                >
                  <div className="claude-row-body">
                    <span className="claude-row-label">{item.title}</span>
                    <span className="claude-row-hint">{item.kind}</span>
                  </div>
                  <ClaudeBadge>{item.kind}</ClaudeBadge>
                </button>
              ))}
            </div>
            {active ? (
              <div className="claude-artifacts-preview">
                {receipt ? (
                  <p className="claude-dialog-hint" role="status">
                    {receipt}
                  </p>
                ) : null}
                <div className="claude-artifacts-toolbar">
                  <div className="claude-segment claude-segment-sm" role="radiogroup" aria-label="产物看法">
                    <button type="button" role="radio" aria-checked={mode === "preview"} data-active={mode === "preview" ? "" : undefined} className="claude-segment-item" data-p4-action="artifact-mode" onClick={() => setMode("preview")}>
                      Preview
                    </button>
                    <button type="button" role="radio" aria-checked={mode === "code"} data-active={mode === "code" ? "" : undefined} className="claude-segment-item" data-p4-action="artifact-mode" onClick={() => setMode("code")}>
                      Code
                    </button>
                  </div>
                  <ClaudeButton kind="primary" className="claude-btn-sm" data-p4-action="artifact-open" onClick={openArtifact}>
                    打开产物
                  </ClaudeButton>
                </div>
                {mode === "code" ? (
                  <pre className="claude-artifacts-code" data-p4-action="artifact-content">{active.content ?? "（无内联内容）"}</pre>
                ) : (
                  <div className="claude-artifacts-previewbody" data-p4-action="artifact-content">
                    {active.content ?? (active.url ? <a href={active.url}>{active.url}</a> : "（该产物没有可预览内容）")}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </ClaudeSheet>
  )
}
