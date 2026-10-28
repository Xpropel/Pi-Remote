import { useEffect, useMemo, useState } from "react"
import { Archive, Check, ChevronLeft, CircleCheck, GitPullRequest, Pencil, RotateCcw, Square } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import type { PiUiPullRequest } from "@/pi/extensions"
import { CodexBadge, CodexCapabilityBadge, CodexDisabledNote, CodexExtensionNotice } from "../primitives/CodexCapability"
import { CodexButton } from "../primitives/primitives"
import { useCodexCapability } from "../logic/capability"

type PrState = "open" | "merged" | "closed" | "archived"
type PrRow = PiUiPullRequest
const FILTERS: { key: PrState | "all"; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "open", label: "打开" },
  { key: "merged", label: "已合并" },
  { key: "closed", label: "已关闭" },
  { key: "archived", label: "已归档" },
]
const STATE_TEXT: Record<PiUiPullRequest["state"], string> = { open: "打开", draft: "草稿", merged: "已合并", closed: "已关闭", archived: "已归档" }
const FILTER_OF = (state: PiUiPullRequest["state"]): PrState => (state === "draft" ? "open" : state)

/** 生产禁用态下的参考行（无 provider 时仍展示完整界面；数据为示例，不参与交互） */
const REFERENCE_ROWS: PrRow[] = [
  { id: "ref-128", number: 128, title: "修复手机键盘收起时的视口跳动", repo: "pi-remote", author: "你", state: "open", reviewState: "pending", updatedAt: 0 },
  { id: "ref-127", number: 127, title: "relay 重连后恢复待发消息", repo: "pi-remote", author: "你", state: "merged", reviewState: "approved", updatedAt: 0 },
  { id: "ref-126", number: 126, title: "整理 README 的配对步骤", repo: "pi-remote", author: "你", state: "closed", reviewState: "commented", updatedAt: 0 },
]

/**
 * PR 页（CX-PAGE-06/07，台账 §4.4 / X-图16）：列表（全部/打开/已合并/已关闭/已归档）+ 详情（元信息/评审状态/Checks/文件）。
 * 能力 `pr-review`：生产无 provider → 全部动作禁用 + 扩展接入文档#cap-pr-review；dev mock 注入 → 合并/关闭/归档/重开
 * 分别走契约 `actions.mergePr/closePr/archivePr/reopenPr` 并联动的状态；评审动作 approve/requestChanges 同步接入。
 */
export function CodexPullRequests({ p, onOpenSession }: { p: VariantAppProps; onOpenSession: (id: string) => void }) {
  const cap = useCodexCapability("pr-review")
  const [filter, setFilter] = useState<PrState | "all">("all")
  const [stateOverrides, setStateOverrides] = useState<Record<string, PiUiPullRequest["state"]>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const providerRows = cap.data?.pullRequests
  const baseRows: PrRow[] = cap.interactive && providerRows && providerRows.length > 0 ? providerRows : REFERENCE_ROWS
  const rows = useMemo(
    () => baseRows.map((pr) => ({ ...pr, state: stateOverrides[pr.id] ?? pr.state })).filter((pr) => filter === "all" || FILTER_OF(pr.state) === filter),
    [baseRows, stateOverrides, filter],
  )
  const selected = rows.find((pr) => pr.id === selectedId) ?? rows[0] ?? null
  const actions = cap.actions
  // PR 状态事件订阅：pr:merged / pr:closed / pr:archived / pr:reopened 驱动本地状态（不必等下一次数据快照）
  useEffect(() => {
    const off = cap.binding?.onEvent?.((event) => {
      const payload = event as unknown as { type?: string; prId?: string }
      if (!payload.prId || !payload.type) return
      const next =
        payload.type === "pr:merged" ? "merged" : payload.type === "pr:closed" ? "closed" : payload.type === "pr:archived" ? "archived" : payload.type === "pr:reopened" ? "open" : null
      if (next) setStateOverrides((cur) => ({ ...cur, [payload.prId as string]: next }))
    })
    return () => off?.()
  }, [cap.binding])
  const interactive = cap.interactive
  const setState = (pr: PrRow, state: PiUiPullRequest["state"]) => setStateOverrides((cur) => ({ ...cur, [pr.id]: state }))
  const explain = (what: string) => p.relay.notify(`本机 pi 未提供 PR 能力（${what}）${cap.view ? `；${cap.view.reason}（见 ${cap.view.docsPath}）` : ""}`, "warn")
  const openSession = (title: string) => {
    const hit = Object.values(p.relay.sessionsByDevice)
      .flat()
      .find((s) => s.name === title)
    if (hit) onOpenSession(hit.id)
    else p.relay.notify("这个 PR 对应的会话不在这台设备上（示例数据）", "warn")
  }
  const disabledOf = (action?: (...args: never[]) => void) => (!interactive || !action ? " disabled" : "")
  return (
    <div className="cx-local-page" data-page="prs" data-pi-ui-part="page" data-p4-surface="CX-PAGE-06" data-capability-state={cap.status} data-p4-ready="">
      <header className="cx-local-head">
        <div className="cx-local-title">
          <GitPullRequest aria-hidden size={16} strokeWidth={1.75} />
          <h1>代码审查（PR）</h1>
          <CodexCapabilityBadge label={cap.simulated ? "模拟演示" : "可接入"} view={cap.view} />
          {cap.simulated ? <CodexBadge tone="warn">模拟演示</CodexBadge> : null}
        </div>
        <p className="cx-local-sub">从会话里发起代码审查、看 checks、合并或关闭；PR 能力需扩展接入。</p>
        <div className="cx-local-toolbar">
          <div className="cx-scope-chips" role="tablist" aria-label="PR 筛选">
            {FILTERS.map((item) => (
              <button key={item.key} type="button" role="tab" aria-selected={filter === item.key} className="cx-scope-chip" data-active={filter === item.key ? "" : undefined} onClick={() => setFilter(item.key)}>
                {item.label}
              </button>
            ))}
          </div>
          <span className="cx-local-count">
            {rows.length} 个 PR · {rows.filter((pr) => pr.state === "open" || pr.state === "draft").length} 个打开
          </span>
        </div>
      </header>
      <div className="cx-local-scroll cx-pr-scroll">
        <div className="cx-ext-notice-wrap">
          <CodexExtensionNotice view={cap.view} mock={cap.simulated} />
        </div>
        <div className="cx-pr-body">
          <ul className="cx-pr-list">
            {rows.map((pr) => (
              <li key={pr.id}>
                <button
                  type="button"
                  className="cx-pr-row"
                  data-active={selected?.id === pr.id ? "" : undefined}
                  data-p4-action="select-pr"
                  onClick={() => setSelectedId(pr.id)}
                >
                  <GitPullRequest aria-hidden size={14} strokeWidth={1.5} className="cx-pr-icon" data-state={pr.state} />
                  <span className="cx-pr-row-main">
                    <span className="cx-pr-title">
                      {pr.title} <span className="cx-pr-num">#{pr.number}</span>
                    </span>
                    <span className="cx-pr-meta">
                      <code>{pr.repo}</code> · {pr.author ?? "—"} · {pr.reviewState ?? "—"}
                    </span>
                  </span>
                  <CodexBadge tone={pr.state === "open" ? "ok" : "neutral"}>{STATE_TEXT[pr.state]}</CodexBadge>
                </button>
              </li>
            ))}
            {rows.length === 0 ? <p className="cx-panel-empty-note">这个筛选下没有 PR</p> : null}
          </ul>
          <section className="cx-pr-detail" data-p4-surface="CX-PAGE-07">
            {selected ? (
              <>
                <div className="cx-pr-detail-head">
                  <button type="button" className="cx-ghost-icon cx-pr-back" aria-label="返回列表" onClick={() => setSelectedId(null)}>
                    <ChevronLeft aria-hidden size={15} strokeWidth={1.5} />
                  </button>
                  <div className="cx-pr-detail-title">
                    <h2>
                      {selected.title} <span className="cx-pr-num">#{selected.number}</span>
                    </h2>
                    <p className="cx-pr-detail-meta">
                      <CodexBadge tone={selected.state === "open" ? "ok" : "neutral"}>{STATE_TEXT[selected.state]}</CodexBadge>
                      <span>
                        <code>{selected.repo}</code>
                      </span>
                      <span>{selected.author ?? "—"}</span>
                      <span>评审：{selected.reviewState ?? "—"}</span>
                    </p>
                  </div>
                  <div className="cx-pr-detail-actions">
                    <CodexButton kind="ghost" data-p4-action="pr-open-chat" onClick={() => openSession(selected.title)}>
                      打开会话
                    </CodexButton>
                    <CodexButton
                      kind="outline"
                      data-p4-action="pr-request-changes"
                      data-capability-state={cap.status}
                      data-pi-capability-disabled={disabledOf(actions?.requestChanges) ? "" : undefined}
                      disabled={!interactive || !actions?.requestChanges}
                      title={interactive && actions?.requestChanges ? "dev mock：请求修改" : "provider 未暴露评审动作"}
                      onClick={() => actions?.requestChanges?.(selected.id, "请补充测试")}
                    >
                      请求修改
                    </CodexButton>
                    <CodexButton
                      kind="outline"
                      data-p4-action="pr-approve"
                      data-capability-state={cap.status}
                      data-pi-capability-disabled={disabledOf(actions?.approve) ? "" : undefined}
                      disabled={!interactive || !actions?.approve}
                      title={interactive && actions?.approve ? "dev mock：批准" : "provider 未暴露评审动作"}
                      onClick={() => actions?.approve?.(selected.id)}
                    >
                      批准
                    </CodexButton>
                    {(selected.state === "open" || selected.state === "draft") ? (
                      <>
                        <CodexButton
                          kind="outline"
                          data-p4-action="pr-close"
                          data-capability-state={cap.status}
                          data-pi-capability-disabled={disabledOf(actions?.closePr) ? "" : undefined}
                          disabled={!interactive || !actions?.closePr}
                          title={interactive && actions?.closePr ? "dev mock：关闭 PR" : "本机 pi 未提供 PR 能力；接入扩展后可用"}
                          onClick={() => {
                            if (!interactive || !actions?.closePr) return explain("关闭")
                            actions.closePr(selected.id)
                            setState(selected, "closed")
                          }}
                        >
                          <Square aria-hidden size={12} strokeWidth={1.75} />
                          关闭
                        </CodexButton>
                        <CodexButton
                          kind="primary"
                          data-p4-action="pr-merge"
                          data-capability-state={cap.status}
                          data-pi-capability-disabled={disabledOf(actions?.mergePr) ? "" : undefined}
                          disabled={!interactive || !actions?.mergePr}
                          title={interactive && actions?.mergePr ? "dev mock：合并 PR" : "本机 pi 未提供 PR 能力；接入扩展后可用"}
                          onClick={() => {
                            if (!interactive || !actions?.mergePr) return explain("合并")
                            actions.mergePr(selected.id, "merge")
                            setState(selected, "merged")
                          }}
                        >
                          <Check aria-hidden size={13} strokeWidth={2} />
                          合并
                        </CodexButton>
                      </>
                    ) : (
                      <CodexButton
                        kind="outline"
                        data-p4-action="pr-reopen"
                        data-capability-state={cap.status}
                        data-pi-capability-disabled={disabledOf(actions?.reopenPr) ? "" : undefined}
                        disabled={!interactive || !actions?.reopenPr}
                        title={interactive && actions?.reopenPr ? "dev mock：重新打开 PR" : "provider 未暴露重开动作"}
                        onClick={() => {
                          if (!interactive || !actions?.reopenPr) return explain("重开")
                          actions.reopenPr(selected.id)
                          setState(selected, "open")
                        }}
                      >
                        <RotateCcw aria-hidden size={12} strokeWidth={1.75} />
                        重开
                      </CodexButton>
                    )}
                  </div>
                </div>
                <div className="cx-pr-detail-grid">
                  <div className="cx-pr-detail-main">
                    <section className="cx-pr-section">
                      <h3>描述</h3>
                      <p className="cx-prose">来自能力 provider 的 PR 元信息；真实 provider 可返回描述 / 评论 / checks。</p>
                    </section>
                    <section className="cx-pr-section">
                      <h3>改动</h3>
                      <ul className="cx-pr-files">
                        <li>
                          <Pencil aria-hidden size={12} strokeWidth={1.5} />
                          <span>{selected.repo}</span>
                          <span>—</span>
                        </li>
                      </ul>
                    </section>
                  </div>
                  <aside className="cx-pr-detail-side">
                    <section className="cx-pr-section">
                      <h3>检查项</h3>
                      <ul className="cx-pr-check-list">
                        <li data-status={selected.reviewState === "approved" ? "ok" : "pending"}>
                          <CircleCheck aria-hidden size={12} strokeWidth={1.75} />
                          <span>review</span>
                          <span className="cx-pr-check-state">{selected.reviewState ?? "pending"}</span>
                        </li>
                      </ul>
                    </section>
                    <section className="cx-pr-section">
                      <h3>归档</h3>
                      <CodexButton
                        kind="outline"
                        data-p4-action="pr-archive"
                        data-capability-state={cap.status}
                        data-pi-capability-disabled={disabledOf(actions?.archivePr) ? "" : undefined}
                        disabled={!interactive || !actions?.archivePr || selected.state === "archived"}
                        title={interactive && actions?.archivePr ? "dev mock：归档 PR 与会话" : "provider 未暴露归档动作"}
                        onClick={() => {
                          if (!interactive || !actions?.archivePr) return explain("归档")
                          actions.archivePr(selected.id)
                          setState(selected, "archived")
                        }}
                      >
                        <Archive aria-hidden size={12} strokeWidth={1.75} />
                        归档
                      </CodexButton>
                      <CodexDisabledNote>归档 = 关闭 PR 并移出活动列表；需要 provider 回写状态。</CodexDisabledNote>
                    </section>
                  </aside>
                </div>
              </>
            ) : (
              <p className="cx-panel-empty-note">选一个 PR 查看详情</p>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
