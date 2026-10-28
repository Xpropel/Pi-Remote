import { useState } from "react"
import { Database, Plus } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import type { PiUiConnector } from "@/pi/extensions"
import { useCodexCapability } from "../logic/capability"
import { CodexBadge, CodexCapabilityBadge, CodexExtensionNotice } from "../primitives/CodexCapability"
import { CodexButton } from "../primitives/primitives"

/** Connectors 页（[C-§2][X-§4]；CX-CONNECTORS-01）：连接外部服务（GitHub/Slack…）；`connectors` 能力门控。 */
export function CodexConnectors({ p }: { p: VariantAppProps }) {
  const cap = useCodexCapability("connectors")
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const rows: PiUiConnector[] = cap.data?.connectors ?? []
  const interactive = cap.interactive
  return (
    <div className="cx-local-page" data-page="connectors" data-pi-ui-part="page" data-p4-surface="CX-CONNECTORS-01" data-capability-state={cap.status} data-p4-ready="">
      <header className="cx-local-head">
        <div className="cx-local-title">
          <Database aria-hidden size={16} strokeWidth={1.75} />
          <h1>连接</h1>
          <CodexCapabilityBadge label={cap.simulated ? "模拟演示" : "可接入"} view={cap.view} />
        </div>
        <p className="cx-local-sub">把外部服务接进会话（GitHub / Slack / 其它）。本机 pi 默认没有连接器通道。</p>
        <div className="cx-local-toolbar">
          <span className="cx-local-count">{rows.length} 个连接器</span>
          <CodexButton kind="primary" disabled={!interactive} data-p4-action="connector-add" title={cap.view?.reason}>
            <Plus aria-hidden size={12} strokeWidth={2} />
            添加连接器
          </CodexButton>
        </div>
      </header>
      <div className="cx-local-scroll">
        <div className="cx-ext-notice-wrap">
          <CodexExtensionNotice view={cap.view} mock={cap.simulated} />
        </div>
        <ul className="cx-connector-list">
          {rows.map((row) => {
            const status = overrides[row.id] ?? row.status
            const connected = status === "connected"
            return (
              <li className="cx-connector" key={row.id} data-state={status}>
                <div className="cx-connector-main">
                  <div className="cx-connector-head">
                    <span className="cx-connector-name">{row.name}</span>
                    <CodexBadge>{row.kind}</CodexBadge>
                    <span className="cx-connector-state">{connected ? "已连接" : status === "error" ? "错误" : "未连接"}</span>
                  </div>
                  <p className="cx-connector-desc">{row.account ? `账号：${row.account}` : "（无账号信息）"}</p>
                </div>
                <CodexButton
                  kind="outline"
                  data-p4-action={connected ? "connector-disconnect" : "connector-connect"}
                  data-capability-state={cap.status}
                  data-pi-capability-disabled={interactive ? undefined : ""}
                  disabled={!interactive}
                  title={interactive ? "dev mock：连接/断开" : cap.view?.reason}
                  onClick={() => {
                    if (!interactive) {
                      p.relay.notify(`Connectors：${cap.view?.reason ?? "本机 pi 未提供"}${cap.view ? `（见 ${cap.view.docsPath}）` : ""}`, "warn")
                      return
                    }
                    if (connected) cap.actions?.disconnect?.(row.id)
                    else cap.actions?.connect?.(row.id)
                    setOverrides((cur) => ({ ...cur, [row.id]: connected ? "disconnected" : "connected" }))
                  }}
                >
                  {connected ? "断开" : "连接"}
                </CodexButton>
              </li>
            )
          })}
          {rows.length === 0 ? <p className="cx-panel-empty-note">没有连接器（provider 未提供）</p> : null}
        </ul>
      </div>
    </div>
  )
}
