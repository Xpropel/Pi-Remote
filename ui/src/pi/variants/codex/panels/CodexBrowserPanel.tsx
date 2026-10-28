import { useState } from "react"
import { Monitor, X } from "../icons/CodexIcons"
import { CodexCapabilityBadge, CodexDisabledNote } from "../primitives/CodexCapability"
import { useCodexCapability } from "../logic/capability"

/**
 * Browser 面板（CX-PANEL-07 / [X-图6③][X-§5]）：地址栏 + 标签页 + 页面画布 + 点选评论入口。
 * 能力 `browser-pane`：生产无 provider → 完整 UI 但禁用（地址栏只读、按钮 disabled、DOC/74 说明）；
 * dev mock 注入 → 标签/打开/关闭走契约 actions（openUrl/activateTab/closeTab）并联动状态。
 */
export function CodexBrowserPanel({ onClose }: { onClose?: () => void }) {
  const cap = useCodexCapability("browser-pane")
  const tabs = cap.data?.tabs ?? []
  const activeId = cap.data?.activeTabId ?? tabs[0]?.id ?? null
  const active = tabs.find((tab) => tab.id === activeId) ?? null
  const [draft, setDraft] = useState("")
  const disabled = !cap.interactive
  return (
    <section className="cx-browser" data-p4-surface="CX-PANEL-07" data-capability-state={cap.status} data-p4-ready="">
      <header className="cx-browser-head">
        <div className="cx-browser-tabs" role="tablist" aria-label="浏览器标签页">
          {tabs.length > 0 ? (
            tabs.map((tab) => (
              <span className="cx-browser-tab" data-active={tab.id === activeId ? "" : undefined} key={tab.id} role="tab" aria-selected={tab.id === activeId}>
                <button type="button" className="cx-browser-tab-main" disabled={disabled} data-p4-action="browser-activate-tab" onClick={() => cap.actions?.activateTab?.(tab.id)}>
                  <Monitor aria-hidden size={11} strokeWidth={1.5} />
                  {tab.title}
                  {tab.openedBy === "agent" ? <span className="cx-badge">agent</span> : null}
                </button>
                <button type="button" className="cx-browser-tab-close" aria-label={`关闭 ${tab.title}`} disabled={disabled} data-p4-action="browser-close-tab" onClick={() => cap.actions?.closeTab?.(tab.id)}>
                  <X aria-hidden size={10} strokeWidth={2} />
                </button>
              </span>
            ))
          ) : (
            <span className="cx-browser-tab cx-browser-tab-empty" role="tab" aria-selected>
              新标签页
            </span>
          )}
        </div>
        <div className="cx-browser-actions">
          <CodexCapabilityBadge label={cap.simulated ? "模拟演示" : "可接入"} view={cap.view} />
          {onClose ? (
            <button type="button" className="cx-ghost-icon" aria-label="关闭浏览器面板" onClick={onClose}>
              <X aria-hidden size={14} strokeWidth={1.5} />
            </button>
          ) : null}
        </div>
      </header>
      <div className="cx-browser-bar">
        <input
          className="cx-browser-url"
          value={draft}
          disabled={disabled}
          readOnly={disabled}
          placeholder={active?.url ?? "输入网址或本地服务地址…"}
          aria-label="地址栏"
          data-p4-action="browser-open-url"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && draft.trim() && !disabled) cap.actions?.openUrl?.(draft.trim())
          }}
        />
      </div>
      <div className="cx-browser-canvas">
        {active ? (
          <div className="cx-browser-mock">
            <div className="cx-browser-mock-bar">{active.title}</div>
            <div className="cx-browser-mock-body">
              <p>模拟页面：{active.url}</p>
              <p>接入设备端扩展后可渲染真实页面；点选评论还需要评论扩展。</p>
            </div>
          </div>
        ) : (
          <div className="cx-browser-empty">
            <Monitor aria-hidden size={22} strokeWidth={1.5} />
            <p>设备端浏览器未接入</p>
            <p className="cx-browser-empty-hint">本机 pi 没有设备端浏览器能力；接入设备端扩展后这里会打开真实页面。</p>
          </div>
        )}
      </div>
      <CodexDisabledNote>地址栏与标签页动作在扩展接入后启用；页面内容与评论能力独立接入。</CodexDisabledNote>
    </section>
  )
}
