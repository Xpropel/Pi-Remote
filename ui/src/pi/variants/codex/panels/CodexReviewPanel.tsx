import { useMemo, useState } from "react"
import { Check, GitCommitHorizontal, Monitor, Square, SquareTerminal, X } from "../icons/CodexIcons"
import type { Item } from "@/relay/transcript"
import type { VariantAppProps } from "@/pi/variants/types"
import { changesViewOf } from "@/pi/model/changesView"
import { useCodexCapability } from "../logic/capability"
import { CodexCapabilityBadge, CodexExtensionNotice } from "../primitives/CodexCapability"
import { CodexIconButton } from "../primitives/primitives"
import { codexFoldDiffRows } from "../model/fold"
import { CodexChangesList } from "./CodexChangesList"
import { CodexFileTree } from "./CodexFileTree"
import { CodexFileView } from "./CodexFileView"
import { CodexTerminalView } from "./CodexTerminalView"
import { CodexBrowserPanel } from "./CodexBrowserPanel"
import { CodexSideChat } from "./CodexSideChat"
import { CodexSubagentsPanel } from "./CodexSubagentsPanel"
import { CodexOrchestrationPanel } from "./CodexOrchestrationPanel"

export type CodexPanelTab = "preview" | "files" | "changes"
type Scope = "turn" | "session" | "all" | "uncommitted" | "branch" | "staged" | "unstaged"
type ViewMode = "review" | "browser" | "sidechat" | "subagents" | "orchestration"
const TAB_LABEL: Record<CodexPanelTab, string> = { preview: "预览", files: "文件", changes: "改动" }
const STATUS_OF_TAB: Record<CodexPanelTab, string> = { preview: "Preview", files: "Files", changes: "Changes" }

const SCOPES: { key: Scope; label: string; capability?: "git-commit" | "git-stage"; extended?: boolean }[] = [
  { key: "turn", label: "本回合" },
  { key: "session", label: "本会话" },
  { key: "all", label: "全部改动" },
  { key: "uncommitted", label: "未提交改动", capability: "git-stage", extended: true },
  { key: "branch", label: "Git 分支改动", capability: "git-commit", extended: true },
  { key: "staged", label: "已暂存", capability: "git-stage", extended: true },
  { key: "unstaged", label: "未暂存", capability: "git-stage", extended: true },
]

function itemsOfScope(items: readonly Item[], scope: Scope): readonly Item[] {
  if (scope !== "turn") return items
  for (let i = items.length - 1; i >= 0; i -= 1) if (items[i].kind === "user") return items.slice(i)
  return items
}

/**
 * Codex Review 右栏（[X-§5][X-图7④][X-图10] / X-11，CX-PANEL-01~11）：
 * - 页签 Preview / Files / Changes；工具切换菜单（Review/Files/Terminal/Browser/Side chat + 快捷键）；
 * - 范围 chips：本回合/本会话/全部改动为 Pi 真实数据；Uncommitted / All branch changes / Staged / Unstaged 走
 *   `git-stage`/`git-commit` 能力（生产禁用 + 契约文档锚点，mock 注入后可点）；
 * - Commit or push / Create PR 走 `git-commit` 能力；Stage/Revert 浮动条走 `git-stage`；
 * - Browser / Side chat 面板分别走 `browser-pane` / `side-chat` 能力。
 */
export function CodexReviewPanel({ p, phone = false, onClose, onOpenTerminal }: { p: VariantAppProps; phone?: boolean; onClose?: () => void; onOpenTerminal?: () => void }) {
  const { relay } = p
  const gitStage = useCodexCapability("git-stage")
  const gitCommit = useCodexCapability("git-commit")
  const [tab, setTab] = useState<CodexPanelTab>("changes")
  const [scope, setScope] = useState<Scope>("session")
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>("review")
  const [toolsOpen, setToolsOpen] = useState(false)
  const items: readonly Item[] = relay.roomId ? relay.transcript.items : EMPTY
  const scoped = useMemo(() => itemsOfScope(items, scope), [items, scope])
  const changes = useMemo(() => changesViewOf(scoped), [scoped])
  const files = useMemo(
    () => (changes?.files ?? []).map((f) => ({ path: f.path, added: f.added, removed: f.removed, rows: codexFoldDiffRows(f.rows) })),
    [changes],
  )
  const activePath = openPath ?? files[0]?.path ?? null
  const total = { added: changes?.added ?? 0, removed: changes?.removed ?? 0 }
  const repoPath = gitCommit.data?.repos?.[0]?.repoPath ?? null
  const explain = (what: string) => relay.notify(`${what}：本机 pi 未提供对应能力${gitStage.view ? `（见 ${gitStage.view.docsPath}）` : ""}`, "warn")
  const commitNow = (push: boolean) => {
    if (!gitCommit.interactive || !gitCommit.actions?.commit || !repoPath) return explain("Commit")
    gitCommit.actions.commit(repoPath, "Codex UI commit")
    if (push) gitCommit.actions.push?.(repoPath)
  }
  const createPr = () => {
    if (!gitCommit.interactive || !gitCommit.actions?.createPr || !repoPath) return explain("Create PR")
    gitCommit.actions.createPr(repoPath)
  }
  const scopeChips = SCOPES.map((item) => {
    const cap = item.capability === "git-stage" ? gitStage : item.capability === "git-commit" ? gitCommit : null
    // audit CX-PANEL-04：git 范围（未提交/分支/暂存）没有数据源，任一状态都禁用+解释；只有本回合/本会话/全部改动可用
    const disabled = item.extended === true && !cap?.interactive
    return { ...item, disabled, cap }
  })
  return (
    <section className="cx-panel" data-variant={phone ? "phone" : "desktop"} data-pi-ui-part="panel" aria-label="审查面板" data-p4-surface="CX-PANEL-01" data-p4-ready="">
      <header className="cx-panel-head">
        <div className="cx-panel-tabs" role="tablist" aria-label="面板">
          {(Object.keys(TAB_LABEL) as CodexPanelTab[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key && viewMode === "review"}
              className="cx-panel-tab"
              data-active={tab === key && viewMode === "review" ? "" : undefined}
              data-p4-action={`panel-tab-${key}`}
              onClick={() => {
                setViewMode("review")
                setTab(key)
              }}
            >
              {TAB_LABEL[key]}
            </button>
          ))}
        </div>
        <div className="cx-panel-head-actions">
          <button type="button" className="cx-panel-action" data-p4-action="panel-tools" aria-expanded={toolsOpen} onClick={() => setToolsOpen((open) => !open)}>
            <SquareTerminal aria-hidden size={13} strokeWidth={1.5} />
            工具
          </button>
          <button type="button" className="cx-panel-action cx-panel-action-primary" data-p4-action="commit-or-push" data-capability-state={gitCommit.status} data-pi-capability-disabled={gitCommit.interactive ? undefined : ""} disabled={!gitCommit.interactive} title={gitCommit.interactive ? "provider 提交链路" : gitCommit.view?.reason} onClick={() => commitNow(true)}>
            <GitCommitHorizontal aria-hidden size={13} strokeWidth={1.5} />
            提交与推送（需扩展）
          </button>
          <button type="button" className="cx-panel-action" data-p4-action="create-pr" data-capability-state={gitCommit.status} data-pi-capability-disabled={gitCommit.interactive ? undefined : ""} disabled={!gitCommit.interactive} title={gitCommit.interactive ? "provider 创建 PR" : gitCommit.view?.reason} onClick={createPr}>
            创建 PR（需扩展）
          </button>
          {onClose ? (
            <CodexIconButton label="关闭审查面板" onClick={onClose}>
              <X aria-hidden size={15} strokeWidth={1.5} />
            </CodexIconButton>
          ) : null}
        </div>
        {toolsOpen ? (
          <div className="cx-panel-tools" role="menu" data-p4-surface="CX-PANEL-06" data-p4-ready="">
            <button type="button" role="menuitem" className="cx-menu-row" data-p4-action="tool-review" onClick={() => { setToolsOpen(false); setViewMode("review"); setTab("changes") }}>
              <Check aria-hidden size={12} strokeWidth={1.75} />
              <span className="cx-menu-label">审查</span>
              <span className="cx-menu-kbd">Ctrl+Shift+G</span>
            </button>
            <button type="button" role="menuitem" className="cx-menu-row" data-p4-action="tool-files" onClick={() => { setToolsOpen(false); setViewMode("review"); setTab("files") }}>
              <Check aria-hidden size={12} strokeWidth={1.75} />
              <span className="cx-menu-label">文件</span>
              <span className="cx-menu-kbd">Ctrl+P</span>
            </button>
            <button type="button" role="menuitem" className="cx-menu-row" data-p4-action="tool-terminal" onClick={() => { setToolsOpen(false); onOpenTerminal?.() }}>
              <SquareTerminal aria-hidden size={12} strokeWidth={1.5} />
              <span className="cx-menu-label">设备端终端（只读）</span>
              <span className="cx-menu-kbd">Ctrl+T</span>
            </button>
            <button type="button" role="menuitem" className="cx-menu-row" data-p4-action="tool-browser" onClick={() => { setToolsOpen(false); setViewMode("browser") }}>
              <Monitor aria-hidden size={12} strokeWidth={1.5} />
              <span className="cx-menu-label">设备端浏览器（需扩展）</span>
              <span className="cx-menu-kbd">Ctrl+Shift+B</span>
            </button>
            <button type="button" role="menuitem" className="cx-menu-row" data-p4-action="tool-sidechat" onClick={() => { setToolsOpen(false); setViewMode("sidechat") }}>
              <Check aria-hidden size={12} strokeWidth={1.75} />
              <span className="cx-menu-label">侧聊（需扩展）</span>
            </button>
            <button type="button" role="menuitem" className="cx-menu-row" data-p4-action="tool-subagents" onClick={() => { setToolsOpen(false); setViewMode("subagents") }}>
              <Check aria-hidden size={12} strokeWidth={1.75} />
              <span className="cx-menu-label">子 agent（只读）</span>
            </button>
            <button type="button" role="menuitem" className="cx-menu-row" data-p4-action="tool-orchestration" onClick={() => { setToolsOpen(false); setViewMode("orchestration") }}>
              <Check aria-hidden size={12} strokeWidth={1.75} />
              <span className="cx-menu-label">多代理编排（需扩展）</span>
            </button>
          </div>
        ) : null}
      </header>
      {viewMode === "browser" ? (
        <div className="cx-panel-body">
          <CodexBrowserPanel onClose={() => setViewMode("review")} />
        </div>
      ) : viewMode === "sidechat" ? (
        <div className="cx-panel-body">
          <CodexSideChat onClose={() => setViewMode("review")} />
        </div>
      ) : viewMode === "subagents" ? (
        <div className="cx-panel-body">
          <CodexSubagentsPanel p={p} />
        </div>
      ) : viewMode === "orchestration" ? (
        <div className="cx-panel-body">
          <CodexOrchestrationPanel onClose={() => setViewMode("review")} />
        </div>
      ) : (
        <>
          {tab === "changes" ? (
            <div className="cx-panel-review-bar" data-p4-surface="CX-PANEL-04" data-p4-ready="">
              <div className="cx-scope-chips" role="radiogroup" aria-label="审查范围">
                {scopeChips.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    role="radio"
                    aria-checked={scope === item.key}
                    aria-disabled={item.disabled || undefined}
                    className="cx-scope-chip"
                    data-active={scope === item.key ? "" : undefined}
                    data-p4-action={`scope-${item.key}`}
                    data-capability-state={item.cap?.status}
                    data-pi-capability-disabled={item.disabled ? "" : undefined}
                    title={item.disabled ? item.cap?.view?.reason : undefined}
                    onClick={() => {
                      if (item.disabled) {
                        relay.notify(`「${item.label}」需要 git 扩展接入：${item.cap?.view?.reason ?? "未接入"}（见 ${item.cap?.view?.docsPath ?? "DOC/74"}）`, "warn")
                        return
                      }
                      setScope(item.key)
                    }}
                  >
                    {item.label}
                  </button>
                ))}
                <span className="cx-scope-stat">
                  <span className="cx-add">+{total.added}</span>
                  <span className="cx-del">−{total.removed}</span>
                </span>
              </div>
              <div className="cx-stage-bar" data-p4-surface="CX-PANEL-05" data-capability-state={gitStage.status} data-p4-ready="">
                <span className="cx-stage-group">本会话改动 · {files.length} 个文件（来自编辑记录，不是 git 暂存区）</span>
                <button type="button" className="cx-panel-action" data-p4-action="stage-all" disabled title="全部暂存需要 git 扩展" onClick={() => relay.notify("全部暂存需要 git 扩展接入", "warn")}>
                  全部暂存
                </button>
                <button type="button" className="cx-panel-action" data-p4-action="revert-all" disabled title="全部还原需要 git 扩展" onClick={() => relay.notify("全部还原需要 git 扩展接入", "warn")}>
                  全部还原
                </button>
              </div>
              {!gitStage.interactive ? (
                <div className="cx-panel-cap-note">
                  <CodexExtensionNotice view={gitStage.view} mock={gitStage.simulated} />
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="cx-panel-body">
            {tab === "changes" ? (
              <div className="cx-review-body">
                <div className="cx-review-main">
                  <div className="cx-changes-head" data-p4-surface="CX-PANEL-03" data-p4-ready="">
                    <span className="cx-changes-count">{files.length} 个文件改动</span>
                    <span className="cx-scope-stat">
                      <span className="cx-add">+{total.added}</span> <span className="cx-del">−{total.removed}</span>
                    </span>
                    <span className="cx-changes-note">根据本会话的编辑记录，不是 git 状态</span>
                  </div>
                  <CodexChangesList files={files} />
                  {(changes?.truncated ?? false) ? <p className="cx-panel-fault">有的改动太长（超过 200k 字），只显示了前面一段</p> : null}
                </div>
                <aside className="cx-review-tree">
                  <CodexFileTree paths={files.map((f) => f.path)} activePath={activePath} onPick={setOpenPath} />
                </aside>
              </div>
            ) : tab === "preview" ? (
              <CodexTerminalView p={p} />
            ) : (
              <CodexFileView p={p} path={openPath} onOpen={setOpenPath} />
            )}
          </div>
        </>
      )}
      <footer className="cx-panel-foot">
        <span className="cx-panel-foot-note">范围：本回合 = 最后一条用户消息之后的编辑记录</span>
        <button type="button" className="cx-panel-foot-link" onClick={() => { setViewMode("review"); setTab("changes") }}>
          改动视图
        </button>
      </footer>
    </section>
  )
}
const EMPTY: readonly Item[] = []
export { STATUS_OF_TAB, CodexCapabilityBadge, Square }
