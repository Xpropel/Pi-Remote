import { useState } from "react"
import { Puzzle } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import type { PiUiSkill } from "@/pi/extensions"
import { useCodexCapability } from "../logic/capability"
import { CodexBadge, CodexExtensionNotice } from "../primitives/CodexCapability"
import { CodexButton } from "../primitives/primitives"

/** Skills 管理页（CX-PAGE-09 / [X-§9.1]）：列表/启停/调用入口；`skills` 能力门控（生产禁用+契约说明，mock 可启停）。 */
export function CodexSkills({ p }: { p: VariantAppProps }) {
  const cap = useCodexCapability("skills")
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const rows: PiUiSkill[] = cap.data?.skills ?? []
  const interactive = cap.interactive
  return (
    <div className="cx-local-page" data-page="skills" data-pi-ui-part="page" data-p4-surface="CX-PAGE-09" data-capability-state={cap.status} data-p4-ready="">
      <header className="cx-local-head">
        <div className="cx-local-title">
          <Puzzle aria-hidden size={16} strokeWidth={1.75} />
          <h1>技能</h1>
          <CodexBadge tone={cap.simulated ? "warn" : "neutral"}>{cap.simulated ? "模拟演示" : "可接入"}</CodexBadge>
        </div>
        <p className="cx-local-sub">可复用技能包：浏览、启停、从斜杠命令调用。本机 pi 默认没有技能市场。</p>
        <div className="cx-local-toolbar">
          <span className="cx-local-count">{rows.length} 个 skills</span>
          <CodexButton kind="outline" disabled={!interactive} data-p4-action="skill-import" title={cap.view?.reason}>
            安装 Skill…
          </CodexButton>
        </div>
      </header>
      <div className="cx-local-scroll">
        <div className="cx-ext-notice-wrap">
          <CodexExtensionNotice view={cap.view} mock={cap.simulated} />
        </div>
        <ul className="cx-skill-list">
          {rows.map((skill) => {
            const enabled = overrides[skill.id] ?? skill.enabled
            return (
              <li className="cx-skill" key={skill.id} data-enabled={enabled ? "" : undefined}>
                <div className="cx-skill-main">
                  <div className="cx-skill-head">
                    <span className="cx-skill-name">{skill.name}</span>
                    <CodexBadge>{skill.source}</CodexBadge>
                    <span className="cx-skill-state">{enabled ? "已启用" : "已停用"}</span>
                  </div>
                  <p className="cx-skill-desc">{skill.description ?? "（无描述）"}</p>
                </div>
                <CodexButton
                  kind="outline"
                  data-p4-action={enabled ? "skill-disable" : "skill-enable"}
                  data-capability-state={cap.status}
                  data-pi-capability-disabled={interactive ? undefined : ""}
                  disabled={!interactive}
                  title={interactive ? "dev mock：启停 skill" : cap.view?.reason}
                  onClick={() => {
                    if (!interactive) {
                      p.relay.notify(`Skills：${cap.view?.reason ?? "本机 pi 未提供"}${cap.view ? `（见 ${cap.view.docsPath}）` : ""}`, "warn")
                      return
                    }
                    cap.actions?.toggleSkill?.(skill.id, !enabled)
                    setOverrides((cur) => ({ ...cur, [skill.id]: !enabled }))
                  }}
                >
                  {enabled ? "停用" : "启用"}
                </CodexButton>
              </li>
            )
          })}
          {rows.length === 0 ? <p className="cx-panel-empty-note">没有可用的 skills（provider 未提供）</p> : null}
        </ul>
      </div>
    </div>
  )
}
