import { Monitor } from "../icons/CodexIcons"
import { useCodexCapability } from "../logic/capability"
import { CodexCapabilityBadge, CodexDisabledNote, CodexExtensionNotice } from "../primitives/CodexCapability"

/**
 * 多代理编排画布（CX-ORCH-01 / [C-图15 下]）：成员节点 + 委派连线 + 结果状态。
 * 能力 `subagent-orchestration`：生产 unavailable → 完整画布骨架 + 禁用说明；mock 注入 → 节点/当前状态可查看。
 */
export function CodexOrchestrationPanel({ onClose }: { onClose?: () => void }) {
  const cap = useCodexCapability("subagent-orchestration")
  const nodes = cap.data?.nodes ?? []
  const edges = cap.data?.edges ?? []
  return (
    <section className="cx-orch" data-p4-surface="CX-ORCH-01" data-capability-state={cap.status} data-p4-ready="">
      <header className="cx-orch-head">
        <Monitor aria-hidden size={13} strokeWidth={1.5} />
        <span className="cx-orch-title">Subagent orchestration</span>
        <CodexCapabilityBadge label={cap.simulated ? "模拟演示" : "可接入"} view={cap.view} />
        {onClose ? (
          <button type="button" className="cx-ghost-icon" aria-label="关闭编排画布" onClick={onClose}>
            ×
          </button>
        ) : null}
      </header>
      <div className="cx-orch-canvas">
        {nodes.length === 0 ? (
          <div className="cx-orch-empty">
            <Monitor aria-hidden size={22} strokeWidth={1.5} />
            <p>编排画布未接入</p>
            <p className="cx-orch-empty-hint">本机 pi 只提供子 agent 的只读事件；成员委派 / 结果编排由 subagent-orchestration 扩展提供。</p>
          </div>
        ) : (
          <ol className="cx-orch-nodes">
            {nodes.map((node) => (
              <li className="cx-orch-node" data-status={node.status ?? "idle"} key={node.agentId}>
                <span className="cx-orch-node-name">{node.label}</span>
                <span className="cx-orch-node-state">{node.status ?? "idle"}</span>
                <span className="cx-orch-node-col">col {node.column ?? 0}</span>
              </li>
            ))}
          </ol>
        )}
        {edges.length > 0 ? <p className="cx-orch-edges">{edges.length} 条委派连线</p> : null}
      </div>
      <div className="cx-orch-foot">
        <CodexExtensionNotice view={cap.view} mock={cap.simulated} />
        <CodexDisabledNote>接入扩展后节点会实时更新。</CodexDisabledNote>
      </div>
    </section>
  )
}
