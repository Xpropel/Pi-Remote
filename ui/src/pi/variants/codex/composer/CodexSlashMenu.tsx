import { useCodexCapability } from "../logic/capability"
import type { VariantAppProps } from "@/pi/variants/types"

type Group = { title: string; rows: { key: string; label: string; desc: string; capability?: string }[] }
const BUILTIN: Group = {
  title: "Pi 现有命令",
  rows: [
    { key: "/review", label: "审查改动", desc: "在右栏打开本会话改动" },
    { key: "/model", label: "模型", desc: "切换模型 / 思考级别" },
    { key: "/compact", label: "压缩上下文", desc: "把上下文收紧（22% full 类标注留待接入）" },
    { key: "/status", label: "状态", desc: "会话与连接状态" },
  ],
}

/**
 * `/` 命令菜单（CX-COMP-06 / [X-§4]）：Pi 现有命令 + 参考设计的扩展命令分组
 * （Code review / Fork / Goal / MCP / Model / Plan mode…）。扩展命令按契约能力门控：
 * 生产无 provider → 行禁用 + 解释；mock 注入 → 可点（填入或提示 provider 处理）。
 */
export function CodexSlashMenu({ p, query, onPick }: { p: VariantAppProps; query: string; onPick: (text: string) => void }) {
  const codeReview = useCodexCapability("code-review-comments")
  const fork = useCodexCapability("thread-fork-feedback")
  const plan = useCodexCapability("plan-pane")
  const mcp = useCodexCapability("mcp-tools")
  const skills = useCodexCapability("skills")
  const extension: Group = {
    title: "扩展命令",
    rows: [
      { key: "/review-comments", label: "评论", desc: "行内评论 / 攒批提交（需扩展）", capability: codeReview.status },
      { key: "/fork", label: "分叉", desc: "从当前消息分叉（需扩展）", capability: fork.status },
      { key: "/plan", label: "计划", desc: "可编辑步骤的计划（需扩展）", capability: plan.status },
      { key: "/mcp", label: "MCP 工具", desc: "MCP server / tool 列表（需扩展）", capability: mcp.status },
      { key: "/skills", label: "技能", desc: "可复用技能包（需扩展）", capability: skills.status },
    ],
  }
  const q = query.replace(/^\//, "").toLowerCase()
  const groups = [BUILTIN, extension]
    .map((group) => ({ ...group, rows: group.rows.filter((row) => !q || row.key.includes(q) || row.label.toLowerCase().includes(q)) }))
    .filter((group) => group.rows.length > 0)
  if (groups.length === 0) return null
  const explain = (row: { label: string }, cap: ReturnType<typeof useCodexCapability>) =>
    p.relay.notify(`${row.label}：${cap.view?.reason ?? "扩展未接入"}${cap.view ? `（见 ${cap.view.docsPath}）` : ""}`, "warn")
  const capOf = (key: string) =>
    key.startsWith("/review-comments") ? codeReview : key === "/fork" ? fork : key === "/plan" ? plan : key === "/mcp" ? mcp : key === "/skills" ? skills : null
  return (
    <div className="cx-composer-pop cx-composer-pop-slash" role="menu" aria-label="斜杠命令" data-p4-surface="CX-COMP-06" data-p4-ready="">
      {groups.map((group) => (
        <div className="cx-slash-group" key={group.title}>
          <div className="cx-slash-group-title">{group.title}</div>
          {group.rows.map((row) => {
            const cap = capOf(row.key)
            const disabled = !!cap
            return (
              <button
                key={row.key}
                type="button"
                role="menuitem"
                className="cx-pop-row"
                data-p4-action="slash-command"
                data-capability-state={cap?.status}
                data-pi-capability-disabled={disabled ? "" : undefined}
                title={disabled ? cap?.view?.reason : undefined}
                onClick={() => {
                  if (disabled) {
                    explain(row, cap)
                    return
                  }
                  onPick(row.key)
                }}
              >
                <span className="cx-pop-row-main">{row.label}</span>
                <span className="cx-pop-row-desc">
                  {row.key} · {row.desc}
                  {cap && !cap.interactive ? " · 可接入" : ""}
                </span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
