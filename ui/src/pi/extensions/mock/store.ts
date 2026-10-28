/**
 * 有状态 mock store（P4.2 M1）：provider-backed 能力的 deterministc 数据 + 可变状态 + 动作 + 订阅 + 事件。
 *
 * 目的：让两套变体里所有 Pi 缺失能力在 dev/gallery/e2e 下**完整可交互**（simulated），而生产默认无 provider（禁用态）。
 * 约束：
 * - 只覆盖 `PI_UI_CAPABILITY_PROVIDER_IDS`（31 项 provider-backed）；9 项 contract-only（builtin）不注入（硬规则 2）。
 * - 全部数据来自 `./fixtures.ts` 的深拷贝；动作只改内存态，**无随机、无 Date.now、无网络**（事件时间 = PI_UI_DEMO_NOW + 序号）。
 * - 每次动作 clone 后替换快照并通知订阅者（React `useSyncExternalStore` 语义：引用变化才重渲染）。
 * - 事件流给 mock model / e2e 断言用；事件名用 `<capability>:<verb>`，payload 只放稳定数据。
 */
import { PI_UI_CAPABILITY_PROVIDER_IDS } from "../capabilities.ts"
import type {
  PiUiCapability,
  PiUiCapabilityActions,
  PiUiCapabilityData,
  PiUiCapabilityDataMap,
  PiUiCapabilityProvider,
  PiUiExtensionEvent,
} from "../types.ts"
import { PI_UI_DEMO_FIXTURES, PI_UI_DEMO_NOW, piUiDemoFixtureClone } from "./fixtures.ts"

/** provider-backed 能力（= 需要 mock 注入的 31 项；唯一事实来自契约常量） */
export const PI_UI_DEMO_PROVIDER_CAPABILITIES: readonly PiUiCapability[] = PI_UI_CAPABILITY_PROVIDER_IDS

/** 每项能力的事件名 / 动作样本（测试与 e2e driver 共用；避免各写一份） */
export const PI_UI_DEMO_ACTION_SAMPLES: ReadonlyArray<{ capability: PiUiCapability; action: string; args: readonly unknown[] }> = [
  { capability: "pane-workspace", action: "openPane", args: ["pane-demo-browser"] },
  { capability: "pane-dock-drag", action: "applyLayout", args: ["layout-demo-run"] },
  { capability: "artifacts", action: "openArtifact", args: ["art-demo-deck"] },
  { capability: "browser-pane", action: "activateTab", args: ["tab-demo-pr"] },
  { capability: "plan-pane", action: "updateStep", args: ["plan-demo-p4", "step-demo-2", "completed"] },
  { capability: "side-chat", action: "sendMessage", args: ["side-demo-thread-1", "再解释一下 diff"] },
  { capability: "subagents-panel", action: "cancelAgent", args: ["agent-demo-explorer"] },
  { capability: "automations", action: "runNow", args: ["auto-demo-pr"] },
  { capability: "pr-review", action: "approve", args: ["pr-demo-42"] },
  { capability: "git-commit", action: "commit", args: ["~/code/pi-remote", "P4.2 mock M1"] },
  { capability: "plugins", action: "setPluginEnabled", args: ["plugin-demo-docs", true] },
  { capability: "connectors", action: "connect", args: ["connector-demo-slack"] },
  { capability: "skills", action: "toggleSkill", args: ["skill-demo-doc", true] },
  { capability: "permission-tiers", action: "selectTier", args: ["tier-demo-plan"] },
  { capability: "suggestions", action: "pickSuggestion", args: ["sug-demo-1"] },
  { capability: "code-review-comments", action: "resolveThread", args: ["thread-demo-1"] },
  { capability: "file-editor", action: "saveFile", args: ["test/pi-ui-mock.test.mjs", "// saved by mock\n"] },
  { capability: "worktree", action: "createWorktree", args: ["~/code/pi-remote", "feat/mock-b1"] },
  { capability: "multi-tab", action: "selectTab", args: ["tab-demo-2"] },
  { capability: "theme-custom", action: "applyTheme", args: [{ accent: "#2b7fd4" }] },
  { capability: "session-pin", action: "togglePin", args: ["r-s4"] },
  { capability: "terminal-interactive", action: "sendInput", args: ["term-demo-1", "npm test"] },
  { capability: "dictation", action: "start", args: [] },
  { capability: "workspace-connectors", action: "disconnect", args: ["conn-demo-github"] },
  { capability: "device-code-login", action: "startDeviceCodeLogin", args: [] },
  { capability: "subagent-orchestration", action: "openCanvas", args: [] },
  { capability: "git-stage", action: "stage", args: ["~/code/pi-remote", ["ui/src/pi/extensions/mock/store.ts"]] },
  { capability: "thread-fork-feedback", action: "sendFeedback", args: ["good"] },
  { capability: "session-rail-extra", action: "activateEntry", args: ["rail-demo-artifacts"] },
  { capability: "notifications", action: "updateRule", args: ["rule-demo-automation", { enabled: true }] },
  { capability: "terminal-panes", action: "createTerminal", args: [] },
]

type DemoState = Record<string, unknown>
type EventListener<K extends PiUiCapability = PiUiCapability> = (event: PiUiExtensionEvent<K>) => void

/** 深拷贝（fixtures 全部是纯 JSON 数据） */
function cloneData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export interface PiUiDemoStore {
  /** 注入的 provider（id / name 由 provider.ts 决定；store 只造能力实现） */
  readonly capabilities: { [K in PiUiCapability]?: PiUiCapabilityProvider<K> }
  readonly caps: readonly PiUiCapability[]
  snapshotOf<K extends PiUiCapability>(capability: K): PiUiCapabilityData<K>
  actionsOf<K extends PiUiCapability>(capability: K): PiUiCapabilityActions<K>
  subscribe(capability: PiUiCapability, listener: () => void): () => void
  onEvent<K extends PiUiCapability>(capability: K, listener: EventListener<K>): () => void
  eventsOf(capability?: PiUiCapability): readonly PiUiExtensionEvent[]
  /** mock model 副作用直发事件（不属于能力动作契约） */
  emitDemo(capability: PiUiCapability, type: string, payload?: unknown): void
  /** e2e / 测试按名派发动作；动作不存在返回 false（不抛错） */
  dispatch(capability: PiUiCapability, action: string, ...args: unknown[]): boolean
  reset(): void
}

/**
 * 建一个有状态 mock store。
 * @param caps 要注入的能力（默认全部 31 项 provider-backed；非 provider-backed 自动忽略）
 */
export function createPiUiDemoStore(caps: readonly PiUiCapability[] = PI_UI_DEMO_PROVIDER_CAPABILITIES): PiUiDemoStore {
  const selected = [...new Set(caps)].filter((capability) => (PI_UI_DEMO_PROVIDER_CAPABILITIES as readonly string[]).includes(capability))
  let state: DemoState = {}
  let clock = 0
  let events: PiUiExtensionEvent[] = []
  const listeners = new Map<PiUiCapability, Set<() => void>>()
  const eventListeners = new Map<PiUiCapability, Set<EventListener>>()

  const at = () => PI_UI_DEMO_NOW + clock * 250

  function seed(): void {
    const all = piUiDemoFixtureClone() as { [K in PiUiCapability]?: PiUiCapabilityDataMap[K] }
    state = {}
    for (const capability of selected) state[capability] = cloneData(all[capability])
    clock = 0
    events = []
  }
  seed()

  function snapshotOf<K extends PiUiCapability>(capability: K): PiUiCapabilityData<K> {
    const data = state[capability]
    if (data === undefined) throw new Error(`mock store 没有 ${capability} 的初始数据（fixtures 缺口？）`)
    return data as PiUiCapabilityData<K>
  }

  function notify(capability: PiUiCapability): void {
    const set = listeners.get(capability)
    if (!set) return
    for (const listener of [...set]) listener()
  }

  function emit<K extends PiUiCapability>(capability: K, type: string, payload?: unknown): void {
    clock += 1
    const event: PiUiExtensionEvent<K> = { capability, type, payload, at: at() }
    events.push(event as PiUiExtensionEvent)
    const set = eventListeners.get(capability)
    if (set) for (const listener of [...set]) listener(event)
  }

  /** clone → 改 → 替换快照 → 通知（引用变化 = useSyncExternalStore 正确更新） */
  function update<K extends PiUiCapability>(capability: K, mutate: (data: PiUiCapabilityData<K>) => PiUiCapabilityData<K>): void {
    const next = mutate(cloneData(snapshotOf(capability)))
    state[capability] = next
    clock += 1
    notify(capability)
  }

  /* ---------------------------------------------------------------- 动作实现 */

  function buildActions<K extends PiUiCapability>(capability: K): PiUiCapabilityActions<K> {
    const map = actionsFor(capability as PiUiCapability) as PiUiCapabilityActions<K> | undefined
    return (map ?? {}) as PiUiCapabilityActions<K>
  }

  function actionsFor(capability: PiUiCapability): PiUiCapabilityActions<PiUiCapability> | undefined {
    switch (capability) {
      case "pane-workspace":
        return {
          openPane: (paneId: string) => {
            update("pane-workspace", (data) => {
              if (data.panes.some((pane) => pane.id === paneId)) return data
              const catalog = (PI_UI_DEMO_FIXTURES["pane-workspace"]?.panes ?? []) as PiUiCapabilityDataMap["pane-workspace"]["panes"]
              const found = catalog.find((pane) => pane.id === paneId)
              return { panes: [...data.panes, cloneData(found ?? { id: paneId, title: paneId, kind: "custom" as const })] }
            })
            emit("pane-workspace", "pane:opened", { paneId })
          },
          closePane: (paneId: string) => {
            update("pane-workspace", (data) => ({ panes: data.panes.filter((pane) => pane.id !== paneId) }))
            emit("pane-workspace", "pane:closed", { paneId })
          },
          focusPane: (paneId: string) => emit("pane-workspace", "pane:focused", { paneId }),
        }
      case "pane-dock-drag":
        return {
          applyLayout: (layoutId: string) => {
            const layouts = snapshotOf("pane-dock-drag").layouts
            if (!layouts.some((layout) => layout.id === layoutId)) return
            update("pane-dock-drag", (data) => ({ ...data, activeLayoutId: layoutId }))
            emit("pane-dock-drag", "layout:applied", { layoutId })
          },
          saveLayout: (layout) => {
            update("pane-dock-drag", (data) => ({ layouts: [...data.layouts.filter((item) => item.id !== layout.id), cloneData(layout)], activeLayoutId: layout.id }))
            emit("pane-dock-drag", "layout:saved", { layoutId: layout.id })
          },
          resetLayout: () => {
            const layouts = snapshotOf("pane-dock-drag").layouts
            update("pane-dock-drag", (data) => ({ ...data, activeLayoutId: layouts[0]?.id }))
            emit("pane-dock-drag", "layout:reset")
          },
        }
      case "artifacts":
        return {
          openArtifact: (artifactId: string) => emit("artifacts", "artifact:opened", { artifactId }),
          revealArtifact: (artifactId: string) => emit("artifacts", "artifact:revealed", { artifactId }),
        }
      case "browser-pane":
        return {
          openUrl: (url: string) => {
            update("browser-pane", (data) => {
              const existing = data.tabs.find((tab) => tab.url === url)
              if (existing) return { ...data, activeTabId: existing.id }
              const id = `tab-demo-auto-${data.tabs.length + 1}`
              const title = url.replace(/^https?:\/\//, "").split("/")[0] || url
              return { tabs: [...data.tabs, { id, title, url, openedBy: "user" as const }], activeTabId: id }
            })
            emit("browser-pane", "browser:opened", { url })
          },
          closeTab: (tabId: string) => {
            update("browser-pane", (data) => {
              const tabs = data.tabs.filter((tab) => tab.id !== tabId)
              return { tabs, activeTabId: data.activeTabId === tabId ? tabs[0]?.id : data.activeTabId }
            })
            emit("browser-pane", "browser:closed", { tabId })
          },
          activateTab: (tabId: string) => {
            update("browser-pane", (data) => (data.tabs.some((tab) => tab.id === tabId) ? { ...data, activeTabId: tabId } : data))
            emit("browser-pane", "browser:activated", { tabId })
          },
        }
      case "plan-pane":
        return {
          updateStep: (planId: string, stepId: string, status) => {
            update("plan-pane", (data) => {
              if (data.plan.id !== planId) return data
              const steps = data.plan.steps.map((step) => (step.id === stepId ? { ...step, status } : step))
              return { plan: { ...data.plan, steps, updatedAt: at() } }
            })
            emit("plan-pane", "plan:step-updated", { planId, stepId, status })
          },
        }
      case "side-chat":
        return {
          sendMessage: (threadId, text) => {
            const trimmed = text.trim()
            if (!trimmed) return
            const existing = threadId ?? snapshotOf("side-chat").threads[0]?.id ?? null
            update("side-chat", (data) => {
              const target = data.threads.find((thread) => thread.id === existing) ?? data.threads[0]
              if (!target) return data
              const seq = target.messages.length + 1
              const userMessage = { id: `side-demo-u-${seq}`, role: "user" as const, text: trimmed, at: at() }
              const reply = {
                id: `side-demo-a-${seq + 1}`,
                role: "assistant" as const,
                text: `（演示回复）已记录：「${trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed}」。这份侧聊不会写回主线程。`,
                at: at() + 250,
              }
              return { threads: data.threads.map((thread) => (thread.id === target.id ? { ...thread, messages: [...thread.messages, userMessage, reply], updatedAt: at() } : thread)) }
            })
            emit("side-chat", "side-chat:message", { threadId: existing, text: trimmed })
          },
          createThread: (title) => {
            const seq = snapshotOf("side-chat").threads.length + 1
            const id = `side-demo-thread-${seq}`
            update("side-chat", (data) => ({ threads: [...data.threads, { id, title: title?.trim() || `侧聊 ${seq}`, messages: [], updatedAt: at() }] }))
            emit("side-chat", "side-chat:thread-created", { threadId: id })
          },
        }
      case "subagents-panel":
        return {
          focusAgent: (agentId: string) => emit("subagents-panel", "agent:focused", { agentId }),
          cancelAgent: (agentId: string) => {
            update("subagents-panel", (data) => ({
              agents: data.agents.map((agent) => (agent.id === agentId && agent.status === "running" ? { ...agent, status: "failed" as const, finishedAt: at() } : agent)),
            }))
            emit("subagents-panel", "agent:cancelled", { agentId })
          },
        }
      case "automations":
        return {
          runNow: (automationId: string) => {
            update("automations", (data) => ({
              automations: data.automations.map((automation) =>
                automation.id === automationId ? { ...automation, lastResult: "success" as const, lastRunAt: at() } : automation,
              ),
            }))
            emit("automations", "automation:ran", { automationId, lastResult: "success" })
          },
          toggle: (automationId: string, enabled: boolean) => {
            update("automations", (data) => ({
              automations: data.automations.map((automation) => (automation.id === automationId ? { ...automation, enabled } : automation)),
            }))
            emit("automations", "automation:toggled", { automationId, enabled })
          },
        }
      case "pr-review":
        return {
          openPr: (prId: string) => emit("pr-review", "pr:opened", { prId }),
          approve: (prId: string) => {
            update("pr-review", (data) => ({ pullRequests: data.pullRequests.map((pr) => (pr.id === prId ? { ...pr, reviewState: "approved" as const } : pr)) }))
            emit("pr-review", "pr:approved", { prId })
          },
          requestChanges: (prId: string, comment: string) => {
            update("pr-review", (data) => ({ pullRequests: data.pullRequests.map((pr) => (pr.id === prId ? { ...pr, reviewState: "changes_requested" as const } : pr)) }))
            emit("pr-review", "pr:changes-requested", { prId, comment })
          },
          // 3c47af6 契约扩展：merge / close / archive / reopen（state 机 + 事件）
          mergePr: (prId: string, method?: "merge" | "squash" | "rebase") => {
            update("pr-review", (data) => ({
              pullRequests: data.pullRequests.map((pr) => (pr.id === prId ? { ...pr, state: "merged" as const, reviewState: "approved" as const } : pr)),
            }))
            emit("pr-review", "pr:merged", { prId, method: method ?? "merge" })
          },
          closePr: (prId: string) => {
            update("pr-review", (data) => ({ pullRequests: data.pullRequests.map((pr) => (pr.id === prId ? { ...pr, state: "closed" as const } : pr)) }))
            emit("pr-review", "pr:closed", { prId })
          },
          archivePr: (prId: string) => {
            update("pr-review", (data) => ({ pullRequests: data.pullRequests.map((pr) => (pr.id === prId ? { ...pr, state: "archived" as const } : pr)) }))
            emit("pr-review", "pr:archived", { prId })
          },
          reopenPr: (prId: string) => {
            update("pr-review", (data) => ({ pullRequests: data.pullRequests.map((pr) => (pr.id === prId ? { ...pr, state: "open" as const } : pr)) }))
            emit("pr-review", "pr:reopened", { prId })
          },
        }
      case "git-commit":
        return {
          commit: (repoPath: string, message: string) => {
            update("git-commit", (data) => ({
              repos: data.repos.map((repo) => (repo.repoPath === repoPath ? { ...repo, staged: [], canCommit: false } : repo)),
            }))
            emit("git-commit", "git:committed", { repoPath, message })
          },
          push: (repoPath: string) => emit("git-commit", "git:pushed", { repoPath }),
          createPr: (repoPath: string) => emit("git-commit", "git:pr-created", { repoPath }),
        }
      case "plugins":
        return {
          installPlugin: (pluginId: string) => {
            update("plugins", (data) => ({ plugins: data.plugins.map((plugin) => (plugin.id === pluginId ? { ...plugin, installed: true } : plugin)) }))
            emit("plugins", "plugin:installed", { pluginId })
          },
          setPluginEnabled: (pluginId: string, enabled: boolean) => {
            update("plugins", (data) => ({
              plugins: data.plugins.map((plugin) => (plugin.id === pluginId && plugin.installed ? { ...plugin, enabled } : plugin)),
            }))
            emit("plugins", "plugin:enabled-changed", { pluginId, enabled })
          },
        }
      case "connectors":
        return {
          connect: (connectorId: string) => {
            update("connectors", (data) => ({
              connectors: data.connectors.map((connector) => (connector.id === connectorId ? { ...connector, status: "connected" as const, lastSyncAt: at() } : connector)),
            }))
            emit("connectors", "connector:connected", { connectorId })
          },
          disconnect: (connectorId: string) => {
            update("connectors", (data) => ({
              connectors: data.connectors.map((connector) => (connector.id === connectorId ? { ...connector, status: "disconnected" as const } : connector)),
            }))
            emit("connectors", "connector:disconnected", { connectorId })
          },
        }
      case "skills":
        return {
          toggleSkill: (skillId: string, enabled: boolean) => {
            update("skills", (data) => ({ skills: data.skills.map((skill) => (skill.id === skillId ? { ...skill, enabled } : skill)) }))
            emit("skills", "skill:toggled", { skillId, enabled })
          },
        }
      case "permission-tiers":
        return {
          selectTier: (tierId: string) => {
            if (!snapshotOf("permission-tiers").tiers.some((tier) => tier.id === tierId)) return
            update("permission-tiers", (data) => ({ ...data, currentTierId: tierId }))
            emit("permission-tiers", "permission:tier-changed", { tierId })
          },
        }
      case "suggestions":
        return {
          pickSuggestion: (suggestionId: string) => emit("suggestions", "suggestion:picked", { suggestionId }),
        }
      case "code-review-comments":
        return {
          resolveThread: (threadId: string) => {
            update("code-review-comments", (data) => ({
              threads: data.threads.map((thread) =>
                thread.id === threadId ? { ...thread, resolved: true, comments: thread.comments.map((comment) => ({ ...comment, resolved: true })) } : thread,
              ),
            }))
            emit("code-review-comments", "comment:resolved", { threadId })
          },
          reply: (threadId: string, body: string) => {
            const trimmed = body.trim()
            if (!trimmed) return
            update("code-review-comments", (data) => ({
              threads: data.threads.map((thread) => {
                if (thread.id !== threadId) return thread
                const comment = { id: `c-demo-${thread.comments.length + 10}`, body: trimmed, author: "mock-engineer", createdAt: at(), resolved: false, path: thread.path, line: thread.line }
                return { ...thread, comments: [...thread.comments, comment] }
              }),
            }))
            emit("code-review-comments", "comment:replied", { threadId })
          },
        }
      case "file-editor":
        return {
          openFile: (path: string) => {
            if (!snapshotOf("file-editor").files.some((file) => file.path === path)) return
            update("file-editor", (data) => ({ ...data, activeFileId: path }))
            emit("file-editor", "file:opened", { path })
          },
          saveFile: (path: string, content: string) => {
            update("file-editor", (data) => ({
              files: data.files.map((file) => (file.path === path ? { ...file, content, dirty: false, updatedAt: at() } : file)),
            }))
            emit("file-editor", "file:saved", { path })
          },
        }
      case "worktree":
        return {
          createWorktree: (repoPath: string, branch: string) => {
            const seq = snapshotOf("worktree").worktrees.length + 1
            const id = `wt-demo-${seq}`
            update("worktree", (data) => ({ worktrees: [...data.worktrees, { id, path: `${repoPath}-wt/${seq}`, branch, repoPath, status: "clean" as const }] }))
            emit("worktree", "worktree:created", { worktreeId: id, branch })
          },
          openWorktree: (worktreeId: string) => emit("worktree", "worktree:opened", { worktreeId }),
        }
      case "multi-tab":
        return {
          selectTab: (tabId: string) => {
            if (!snapshotOf("multi-tab").tabs.some((tab) => tab.id === tabId)) return
            update("multi-tab", (data) => ({ ...data, activeTabId: tabId }))
            emit("multi-tab", "tab:selected", { tabId })
          },
          closeTab: (tabId: string) => {
            update("multi-tab", (data) => {
              const tabs = data.tabs.filter((tab) => tab.id !== tabId)
              return { tabs, activeTabId: data.activeTabId === tabId ? tabs[0]?.id : data.activeTabId }
            })
            emit("multi-tab", "tab:closed", { tabId })
          },
        }
      case "theme-custom":
        return {
          applyTheme: (patch) => {
            update("theme-custom", (data) => ({ customization: { ...data.customization, ...cloneData(patch) } }))
            emit("theme-custom", "theme:applied", patch)
          },
          resetTheme: () => {
            update("theme-custom", (data) => ({ customization: cloneData(PI_UI_DEMO_FIXTURES["theme-custom"]?.customization ?? data.customization) }))
            emit("theme-custom", "theme:reset")
          },
        }
      case "session-pin":
        return {
          togglePin: (sessionId: string) => {
            update("session-pin", (data) => {
              const pinned = data.pinned.some((item) => item.sessionId === sessionId)
              return { pinned: pinned ? data.pinned.filter((item) => item.sessionId !== sessionId) : [...data.pinned, { sessionId, pinnedAt: at() }] }
            })
            emit("session-pin", "session:pin-toggled", { sessionId })
          },
        }
      case "terminal-interactive":
        return {
          sendInput: (terminalId: string, input: string) => {
            update("terminal-interactive", (data) => {
              if (!data.terminal || data.terminal.terminalId !== terminalId) return data
              return { terminal: { ...data.terminal, recentLines: [...(data.terminal.recentLines ?? []), `$ ${input}`] } }
            })
            emit("terminal-interactive", "terminal:input", { terminalId, input })
          },
        }
      case "dictation":
        return {
          start: () => {
            update("dictation", (data) => ({ dictation: { ...data.dictation, listening: true } }))
            emit("dictation", "dictation:started")
          },
          stop: () => {
            update("dictation", (data) => ({ dictation: { ...data.dictation, listening: false, transcript: "请把 P4 的 mock 双态截图补齐" } }))
            emit("dictation", "dictation:stopped")
          },
        }
      case "workspace-connectors":
        return {
          connect: (connectorId: string) => {
            const id = connectorId.startsWith("conn-demo-") ? connectorId : `conn-demo-${connectorId}`
            update("workspace-connectors", (data) => ({
              connectors: data.connectors.map((connector) => (connector.id === id ? { ...connector, status: "connected" as const, detail: "已连接（演示）" } : connector)),
            }))
            emit("workspace-connectors", "connector:connected", { connectorId: id })
          },
          disconnect: (connectorId: string) => {
            update("workspace-connectors", (data) => ({
              connectors: data.connectors.map((connector) => (connector.id === connectorId ? { ...connector, status: "disconnected" as const, detail: "已断开" } : connector)),
            }))
            emit("workspace-connectors", "connector:disconnected", { connectorId })
          },
        }
      case "device-code-login":
        return {
          startDeviceCodeLogin: () => {
            update("device-code-login", () => ({ login: cloneData(PI_UI_DEMO_FIXTURES["device-code-login"]?.login ?? null) }))
            emit("device-code-login", "device-code:started")
          },
          cancel: () => {
            update("device-code-login", () => ({ login: null }))
            emit("device-code-login", "device-code:cancelled")
          },
        }
      case "subagent-orchestration":
        return {
          focusNode: (agentId: string) => emit("subagent-orchestration", "canvas:node-focused", { agentId }),
          openCanvas: () => emit("subagent-orchestration", "canvas:opened"),
        }
      case "git-stage":
        return {
          stage: (repoPath: string, paths: string[]) => {
            update("git-stage", (data) => ({
              states: data.states.map((item) =>
                item.repoPath === repoPath
                  ? { ...item, staged: [...new Set([...item.staged, ...paths])], unstaged: item.unstaged.filter((path) => !paths.includes(path)) }
                  : item,
              ),
            }))
            emit("git-stage", "git:staged", { repoPath, paths })
          },
          unstage: (repoPath: string, paths: string[]) => {
            update("git-stage", (data) => ({
              states: data.states.map((item) =>
                item.repoPath === repoPath
                  ? { ...item, staged: item.staged.filter((path) => !paths.includes(path)), unstaged: [...new Set([...item.unstaged, ...paths])] }
                  : item,
              ),
            }))
            emit("git-stage", "git:unstaged", { repoPath, paths })
          },
          revert: (repoPath: string, paths: string[]) => {
            update("git-stage", (data) => ({
              states: data.states.map((item) => (item.repoPath === repoPath ? { ...item, unstaged: item.unstaged.filter((path) => !paths.includes(path)) } : item)),
            }))
            emit("git-stage", "git:reverted", { repoPath, paths })
          },
        }
      case "thread-fork-feedback":
        return {
          forkThread: (branchId: string) => emit("thread-fork-feedback", "thread:forked", { branchId }),
          sendFeedback: (vote) => {
            update("thread-fork-feedback", (data) => ({ ...data, feedback: { ...data.feedback, lastVote: vote } }))
            emit("thread-fork-feedback", "thread:feedback", { vote })
          },
        }
      case "session-rail-extra":
        return {
          activateEntry: (entryId: string) => emit("session-rail-extra", "rail:activated", { entryId }),
        }
      case "notifications":
        return {
          updateRule: (ruleId: string, patch) => {
            update("notifications", (data) => ({
              rules: data.rules.map((rule) => (rule.id === ruleId ? { ...rule, ...cloneData(patch) } : rule)),
            }))
            emit("notifications", "notifications:rule-updated", { ruleId })
          },
        }
      case "terminal-panes":
        return {
          createTerminal: () => {
            const seq = snapshotOf("terminal-panes").terminals.length + 1
            const id = `term-demo-${seq}`
            update("terminal-panes", (data) => ({ terminals: [...data.terminals, { id, title: `zsh ${seq}`, status: "running" as const, cwd: "~/code/pi-remote" }] }))
            emit("terminal-panes", "terminal:created", { terminalId: id })
          },
          killTerminal: (terminalId: string) => {
            update("terminal-panes", (data) => ({ terminals: data.terminals.map((terminal) => (terminal.id === terminalId ? { ...terminal, status: "exited" as const, exitCode: 0 } : terminal)) }))
            emit("terminal-panes", "terminal:killed", { terminalId })
          },
          focusTerminal: (terminalId: string) => emit("terminal-panes", "terminal:focused", { terminalId }),
        }
      default:
        return undefined
    }
  }

  /* ---------------------------------------------------------------- provider 能力实现 */

  const capabilities: Partial<Record<PiUiCapability, PiUiCapabilityProvider>> = {}
  for (const capability of selected) {
    const impl: PiUiCapabilityProvider = {
      mode: "simulated",
      getData: () => snapshotOf(capability) as PiUiCapabilityData<PiUiCapability>,
      subscribe: (listener: () => void) => {
        const set = listeners.get(capability) ?? new Set<() => void>()
        listeners.set(capability, set)
        set.add(listener)
        return () => {
          set.delete(listener)
        }
      },
      getActions: () => buildActions(capability),
      onEvent: (listener: EventListener) => {
        const set = eventListeners.get(capability) ?? new Set<EventListener>()
        eventListeners.set(capability, set)
        set.add(listener)
        return () => {
          set.delete(listener)
        }
      },
    }
    capabilities[capability] = impl
  }

  const store: PiUiDemoStore = {
    capabilities: capabilities as { [K in PiUiCapability]?: PiUiCapabilityProvider<K> },
    caps: selected,
    snapshotOf,
    actionsOf: buildActions,
    subscribe: (capability, listener) => {
      const set = listeners.get(capability) ?? new Set<() => void>()
      listeners.set(capability, set)
      set.add(listener)
      return () => {
        set.delete(listener)
      }
    },
    onEvent: (capability, listener) => {
      const set = eventListeners.get(capability) ?? new Set<EventListener>()
      eventListeners.set(capability, set)
      set.add(listener as EventListener)
      return () => {
        set.delete(listener as EventListener)
      }
    },
    eventsOf: (capability) => (capability ? events.filter((event) => event.capability === capability) : events),
    emitDemo: (capability, type, payload) => emit(capability, type, payload),
    dispatch: (capability, action, ...args) => {
      const actions = actionsFor(capability) as Record<string, ((...input: unknown[]) => void) | undefined> | undefined
      const fn = actions?.[action]
      if (typeof fn !== "function") return false
      fn(...args)
      return true
    },
    reset: () => {
      seed()
      for (const capability of selected) notify(capability)
    },
  }
  return store
}
