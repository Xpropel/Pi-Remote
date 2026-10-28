// P4.2 mock 工装（task-19）单测：
// 1. 契约常量门禁：mock 注入清单 == arch `PI_UI_CAPABILITY_PROVIDER_IDS`（唯一事实，不手写数量）；
// 2. fixtures 覆盖 / 确定性 / sentinel（生产排除 grep 用）；
// 3. 有状态 store：动作 / 订阅 / 事件 / reset 确定性；
// 4. provider：只注入 provider-backed，contract-only（builtin）不冒充注入；无刷新解锁语义（registry 订阅）；
// 5. mock model：5 场景时间线确定、可重复；
// 6. 隔离：生产入口 / 两变体 import 闭包不得到达 `@/pi/extensions/mock`（画廊入口允许）。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { PI_UI_CAPABILITY_IDS } from "../ui/src/pi/extensions/types.ts"
import { PI_UI_STABLE_SELECTOR_ATTRIBUTES } from "../ui/src/pi/extensions/selectors.ts"
import { P4_SCENARIOS, p4ActiveScenarios, p4PendingScenarios, p4ScenarioOf, p4ScenarioProblems, p4VariantOfSurface } from "../ui/src/pi/dev/p4/scenarios.ts"
import {
  PI_UI_CAPABILITY_CONTRACT_IDS,
  PI_UI_CAPABILITY_PROVIDER_IDS,
  PI_UI_EXTENSION_DOC_PATH,
  PI_UI_CAPABILITIES,
} from "../ui/src/pi/extensions/capabilities.ts"
import { piUiCapabilities, piUiCapabilityStatusOf, resetPiUiExtensions } from "../ui/src/pi/extensions/registry.ts"
import { PI_UI_DEMO_FLAG_KEY } from "../ui/src/pi/extensions/mock/options.ts"
import { applyPiUiDemoModelStep, applyPiUiDemoModelStepList } from "../ui/src/pi/extensions/mock/model/apply.ts"
import {
  PI_UI_DEMO_CONTRACT_FIXTURES,
  PI_UI_DEMO_FIXTURES,
  PI_UI_DEMO_NOW,
  PI_UI_DEMO_PROVIDER_FIXTURES,
  PI_UI_DEMO_SENTINELS,
  piUiDemoFixtureClone,
} from "../ui/src/pi/extensions/mock/fixtures.ts"
import {
  createPiUiDemoStore,
  PI_UI_DEMO_ACTION_SAMPLES,
  PI_UI_DEMO_PROVIDER_CAPABILITIES,
} from "../ui/src/pi/extensions/mock/store.ts"
import {
  createPiUiMockProvider,
  piUiDemoStore,
  piUiMockProviderCaps,
  PI_UI_DEMO_PROVIDER_ID,
} from "../ui/src/pi/extensions/mock/provider.ts"
import {
  installPiUiExtensionMock,
  installPiUiExtensionMockIfRequested,
  uninstallPiUiExtensionMock,
} from "../ui/src/pi/extensions/mock/index.ts"
import {
  PI_UI_DEMO_MODEL_SCENARIOS,
  piUiDemoModelScenarioIds,
  piUiDemoModelScenarioOf,
} from "../ui/src/pi/extensions/mock/model/scenarios.ts"
import {
  PiUiDemoTurnRunner,
  piUiDemoScenarioDurationMs,
  piUiDemoScenarioEvents,
  piUiDemoScenarioTimeline,
  piUiDemoStepDurationMs,
} from "../ui/src/pi/extensions/mock/model/runner.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SRC = path.join(ROOT, "ui/src")
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/")

/* ------------------------------------------------------------------ 1. 契约常量门禁 */

describe("mock 契约门禁（唯一事实 = arch 常量）", () => {
  test("mock 注入清单 == PI_UI_CAPABILITY_PROVIDER_IDS（不手写数量）", () => {
    assert.deepEqual([...PI_UI_DEMO_PROVIDER_CAPABILITIES], [...PI_UI_CAPABILITY_PROVIDER_IDS])
    assert.equal(PI_UI_DEMO_PROVIDER_CAPABILITIES.length, PI_UI_CAPABILITY_PROVIDER_IDS.length)
  })

  test("provider-backed + contract-only 恰好覆盖全部契约能力，且无重复", () => {
    const all = [...PI_UI_CAPABILITY_PROVIDER_IDS, ...PI_UI_CAPABILITY_CONTRACT_IDS]
    assert.equal(new Set(all).size, all.length, "provider-backed / contract-only 有重复")
    assert.deepEqual([...all].sort(), [...PI_UI_CAPABILITY_IDS].sort())
  })

  test("契约里不再出现旧 alias ID（workspace-panes/drag-dock/subagent-panel）", () => {
    for (const alias of ["workspace-panes", "drag-dock", "subagent-panel"]) assert.equal(PI_UI_CAPABILITY_IDS.includes(alias), false, alias)
    assert.ok(PI_UI_CAPABILITY_IDS.includes("pane-workspace"))
    assert.ok(PI_UI_CAPABILITY_IDS.includes("pane-dock-drag"))
    assert.ok(PI_UI_CAPABILITY_IDS.includes("subagents-panel"))
  })

  test("3 个 candidate + 3 个契约扩展 ID 都在（按台账 A.1/A.2/A.3）", () => {
    for (const id of ["subagent-orchestration", "git-stage", "thread-fork-feedback"]) assert.ok(PI_UI_CAPABILITY_IDS.includes(id), id)
    for (const id of ["session-rail-extra", "notifications", "terminal-panes"]) assert.ok(PI_UI_CAPABILITY_IDS.includes(id), id)
  })

  test("每个能力都有元数据 + docAnchor（DOC/74）", () => {
    assert.equal(PI_UI_CAPABILITIES.length, PI_UI_CAPABILITY_IDS.length)
    for (const meta of PI_UI_CAPABILITIES) {
      assert.equal(meta.docAnchor, `#cap-${meta.id}`)
      assert.equal(meta.source === "builtin", !meta.providerBacked)
    }
    assert.match(PI_UI_EXTENSION_DOC_PATH, /^DOC\/74-/)
  })
})

/* ------------------------------------------------------------------ 2. fixtures */

describe("fixtures 覆盖 / 确定性 / sentinel", () => {
  test("全部 40 项能力都有确定性 fixture", () => {
    for (const id of PI_UI_CAPABILITY_IDS) assert.ok(PI_UI_DEMO_FIXTURES[id] != null, `fixtures 缺 ${id}`)
  })

  test("provider fixtures 只含 provider-backed；contract fixtures 只含 builtin", () => {
    assert.deepEqual(Object.keys(PI_UI_DEMO_PROVIDER_FIXTURES).sort(), [...PI_UI_CAPABILITY_PROVIDER_IDS].sort())
    assert.deepEqual(Object.keys(PI_UI_DEMO_CONTRACT_FIXTURES).sort(), [...PI_UI_CAPABILITY_CONTRACT_IDS].sort())
  })

  test("确定性：深拷贝等于原 fixture；两次拷贝 JSON 完全一致", () => {
    const a = piUiDemoFixtureClone()
    const b = piUiDemoFixtureClone()
    assert.deepEqual(a, PI_UI_DEMO_FIXTURES)
    assert.equal(JSON.stringify(a), JSON.stringify(b))
    assert.equal(PI_UI_DEMO_NOW, Date.UTC(2026, 9, 26, 12, 0, 0))
  })

  test("fixtures 规模满足演示（plan §13.4 最低量）", () => {
    assert.ok(PI_UI_DEMO_FIXTURES["pane-workspace"].panes.length >= 8)
    assert.ok(PI_UI_DEMO_FIXTURES.artifacts.artifacts.length >= 3)
    assert.ok(PI_UI_DEMO_FIXTURES["browser-pane"].tabs.length >= 3)
    assert.ok(PI_UI_DEMO_FIXTURES["plan-pane"].plan.steps.length >= 4)
    assert.ok(PI_UI_DEMO_FIXTURES["side-chat"].threads.length >= 2)
    assert.ok(PI_UI_DEMO_FIXTURES["subagents-panel"].agents.length >= 3)
    assert.ok(PI_UI_DEMO_FIXTURES.automations.automations.length >= 3)
    assert.ok(PI_UI_DEMO_FIXTURES["pr-review"].pullRequests.length >= 3)
    assert.ok(PI_UI_DEMO_FIXTURES.plugins.plugins.length >= 3)
    assert.ok(PI_UI_DEMO_FIXTURES.connectors.connectors.length >= 3)
    assert.ok(PI_UI_DEMO_FIXTURES.skills.skills.length >= 4)
    assert.ok(PI_UI_DEMO_FIXTURES["permission-tiers"].tiers.length >= 5)
    assert.ok(PI_UI_DEMO_FIXTURES["code-review-comments"].threads.length >= 2)
    assert.ok(PI_UI_DEMO_FIXTURES["file-editor"].files.length >= 3)
    assert.ok(PI_UI_DEMO_FIXTURES["terminal-panes"].terminals.length >= 3)
  })

  test("sentinel 串唯一且可用于生产包 grep", () => {
    assert.ok(PI_UI_DEMO_SENTINELS.length >= 6)
    assert.equal(new Set(PI_UI_DEMO_SENTINELS).size, PI_UI_DEMO_SENTINELS.length)
    // sentinel 必须出现在 mock 模块会打进 bundle 的字符串里（fixtures 数据 / provider id / flag key）
    const corpus = JSON.stringify(PI_UI_DEMO_FIXTURES) + PI_UI_DEMO_PROVIDER_ID + PI_UI_DEMO_FLAG_KEY
    for (const sentinel of PI_UI_DEMO_SENTINELS) assert.ok(corpus.includes(sentinel), `sentinel 不在 mock 可打包字符串里：${sentinel}`)
  })
})

/* ------------------------------------------------------------------ 3. 有状态 store */

describe("有状态 mock store：动作 / 订阅 / 事件 / reset", () => {
  test("store 覆盖 provider-backed 全集，初始数据 == fixtures", () => {
    const store = createPiUiDemoStore()
    assert.deepEqual([...store.caps], [...PI_UI_CAPABILITY_PROVIDER_IDS])
    assert.deepEqual(Object.keys(store.capabilities).sort(), [...PI_UI_CAPABILITY_PROVIDER_IDS].sort())
    for (const id of PI_UI_CAPABILITY_PROVIDER_IDS) assert.deepEqual(store.snapshotOf(id), PI_UI_DEMO_FIXTURES[id], id)
  })

  test("每项能力都有动作，且 ACTION_SAMPLES 覆盖全部 provider-backed 能力", () => {
    const store = createPiUiDemoStore()
    for (const id of PI_UI_CAPABILITY_PROVIDER_IDS) {
      const actions = store.actionsOf(id)
      assert.ok(actions && Object.keys(actions).length > 0, `${id} 缺动作`)
    }
    assert.deepEqual(new Set(PI_UI_DEMO_ACTION_SAMPLES.map((sample) => sample.capability)).size, PI_UI_CAPABILITY_PROVIDER_IDS.length)
  })

  test("每个 sample 动作可派发、改态/发事件、并通知订阅者（无刷新解锁的数据基础）", () => {
    const store = createPiUiDemoStore()
    for (const sample of PI_UI_DEMO_ACTION_SAMPLES) {
      let notified = 0
      const unsubscribe = store.subscribe(sample.capability, () => {
        notified += 1
      })
      const before = JSON.stringify(store.snapshotOf(sample.capability))
      const beforeEvents = store.eventsOf(sample.capability).length
      const ok = store.dispatch(sample.capability, sample.action, ...sample.args)
      assert.equal(ok, true, `${sample.capability}.${sample.action} 无法派发`)
      const changed = JSON.stringify(store.snapshotOf(sample.capability)) !== before
      const emitted = store.eventsOf(sample.capability).length > beforeEvents
      assert.ok(changed || emitted, `${sample.capability}.${sample.action} 既没改态也没发事件`)
      assert.ok(notified >= 1 || emitted, `${sample.capability}.${sample.action} 未通知订阅者`)
      unsubscribe()
    }
  })

  test("未知动作返回 false 不抛错；事件时间戳确定（PI_UI_DEMO_NOW + 序号）", () => {
    const store = createPiUiDemoStore(["artifacts"])
    assert.equal(store.dispatch("artifacts", "noSuchAction"), false)
    store.dispatch("artifacts", "openArtifact", "art-demo-deck")
    store.dispatch("artifacts", "revealArtifact", "art-demo-report")
    const events = store.eventsOf("artifacts")
    assert.equal(events.length, 2)
    assert.equal(events[0].type, "artifact:opened")
    assert.ok(events[0].at > PI_UI_DEMO_NOW)
    assert.ok(events[1].at > events[0].at)
  })

  test("同序列两次执行确定性一致；reset 恢复初始快照", () => {
    const run = () => {
      const store = createPiUiDemoStore()
      for (const sample of PI_UI_DEMO_ACTION_SAMPLES) store.dispatch(sample.capability, sample.action, ...sample.args)
      return {
        data: JSON.stringify(PI_UI_CAPABILITY_PROVIDER_IDS.map((id) => store.snapshotOf(id))),
        events: store.eventsOf().map((event) => `${event.capability}:${event.type}@${event.at}`).join("|"),
      }
    }
    const first = run()
    const second = run()
    assert.equal(first.data, second.data)
    assert.equal(first.events, second.events)
    const store = createPiUiDemoStore()
    store.dispatch("plugins", "toggle", "plugin-demo-lint", false)
    store.reset()
    assert.deepEqual(store.snapshotOf("plugins"), PI_UI_DEMO_FIXTURES.plugins)
  })
})

  test("pr-review 状态机动作（3c47af6）：merge / close / archive / reopen + 事件", () => {
    const store = createPiUiDemoStore(["pr-review"])
    const stateOf = (prId) => store.snapshotOf("pr-review").pullRequests.find((pr) => pr.id === prId).state
    assert.ok(store.snapshotOf("pr-review").pullRequests.some((pr) => pr.state === "archived"), "fixtures 需要 archived PR")
    assert.ok(store.snapshotOf("pr-review").pullRequests.some((pr) => pr.state === "closed"), "fixtures 需要 closed PR")
    assert.equal(store.dispatch("pr-review", "mergePr", "pr-demo-42", "squash"), true)
    assert.equal(stateOf("pr-demo-42"), "merged")
    assert.equal(store.dispatch("pr-review", "closePr", "pr-demo-43"), true)
    assert.equal(stateOf("pr-demo-43"), "closed")
    assert.equal(store.dispatch("pr-review", "archivePr", "pr-demo-43"), true)
    assert.equal(stateOf("pr-demo-43"), "archived")
    assert.equal(store.dispatch("pr-review", "reopenPr", "pr-demo-43"), true)
    assert.equal(stateOf("pr-demo-43"), "open")
    assert.deepEqual(store.eventsOf("pr-review").map((event) => event.type), ["pr:merged", "pr:closed", "pr:archived", "pr:reopened"])
  })

/* ------------------------------------------------------------------ 4. provider 注入口径 */

describe("provider：只注入 provider-backed，contract-only 不冒充", () => {
  test("?caps=all → provider 能力 == PI_UI_CAPABILITY_PROVIDER_IDS（不含 builtin）", () => {
    const provider = createPiUiMockProvider({ caps: [...PI_UI_CAPABILITY_IDS], mode: "simulated", source: "url" })
    assert.equal(provider.id, PI_UI_DEMO_PROVIDER_ID)
    assert.deepEqual(Object.keys(provider.capabilities).sort(), [...PI_UI_CAPABILITY_PROVIDER_IDS].sort())
    for (const contractOnly of PI_UI_CAPABILITY_CONTRACT_IDS) assert.equal(provider.capabilities[contractOnly], undefined, contractOnly)
  })

  test("混入 builtin 的 caps 会被过滤（例如 device-platform-tabs 不注入）", () => {
    assert.deepEqual(piUiMockProviderCaps({ caps: ["artifacts", "device-platform-tabs", "bitnet"], mode: "simulated", source: "url" }), ["artifacts"])
  })

  test("安装 → 解锁（simulated）；builtin 保持 available；卸载 → 回落 unavailable", () => {
    resetPiUiExtensions()
    const install = installPiUiExtensionMock({ caps: [...PI_UI_CAPABILITY_IDS], mode: "simulated", source: "url" })
    assert.equal(install, true)
    for (const id of PI_UI_CAPABILITY_PROVIDER_IDS) assert.equal(piUiCapabilityStatusOf(id), "simulated", id)
    for (const id of PI_UI_CAPABILITY_CONTRACT_IDS) assert.equal(piUiCapabilityStatusOf(id), "available", id)
    assert.equal(piUiCapabilityStatusOf("device-platform-tabs"), "available", "contract-only 不能被 mock 覆盖成 simulated")
    assert.ok(piUiDemoStore() != null)
    uninstallPiUiExtensionMock()
    assert.equal(piUiCapabilityStatusOf("artifacts"), "unavailable")
    assert.equal(piUiDemoStore(), null)
    resetPiUiExtensions()
  })

  test("只请求 builtin 能力：不注册空 provider（避免 registry 抛错）", () => {
    resetPiUiExtensions()
    assert.equal(installPiUiExtensionMock({ caps: ["device-platform-tabs", "workspace-modes"], mode: "simulated", source: "url" }), false)
    assert.equal(piUiCapabilityStatusOf("device-platform-tabs"), "available")
    resetPiUiExtensions()
  })

  test("无刷新解锁语义：同一 registry 上 install/uninstall，能力视图状态即时变化", () => {
    resetPiUiExtensions()
    const before = piUiCapabilities().statusOf("artifacts")
    assert.equal(before, "unavailable")
    installPiUiExtensionMock({ caps: ["artifacts"], mode: "simulated", source: "url" })
    const after = piUiCapabilities()
    assert.equal(after.statusOf("artifacts"), "simulated")
    assert.deepEqual(after.dataOf("artifacts"), PI_UI_DEMO_FIXTURES.artifacts)
    assert.ok(after.disabledOf("artifacts")?.simulated)
    uninstallPiUiExtensionMock()
    assert.equal(piUiCapabilities().statusOf("artifacts"), "unavailable")
    resetPiUiExtensions()
  })

  test("静态画廊 force install 旁路（不依赖 import.meta.env.DEV）", () => {
    resetPiUiExtensions()
    assert.equal(installPiUiExtensionMockIfRequested({ force: true, search: "?caps=artifacts,browser-pane", storage: null }), true)
    assert.equal(piUiCapabilityStatusOf("artifacts"), "simulated")
    assert.equal(piUiCapabilityStatusOf("browser-pane"), "simulated")
    uninstallPiUiExtensionMock()
    assert.equal(installPiUiExtensionMockIfRequested({ search: "?caps=artifacts", storage: null }), false)
    resetPiUiExtensions()
  })
})

/* ------------------------------------------------------------------ 5. mock model */

describe("mock model：场景时间线确定可重复", () => {
  test("5 个场景 + id 唯一 + 每个都含 done 收尾", () => {
    assert.ok(PI_UI_DEMO_MODEL_SCENARIOS.length >= 5)
    assert.deepEqual(piUiDemoModelScenarioIds(), ["tool-approval-stream", "cowork-plan", "review-flow", "automation-run", "error-recovery"])
    for (const scenario of PI_UI_DEMO_MODEL_SCENARIOS) {
      assert.equal(new Set(scenario.steps.map((step) => step.kind)).has("done"), true, scenario.id)
      assert.ok(piUiDemoScenarioDurationMs(scenario) > 0)
    }
  })

  test("时间线单调递增；runToEnd 事件数与步骤数一致且确定", () => {
    for (const scenario of PI_UI_DEMO_MODEL_SCENARIOS) {
      const timeline = piUiDemoScenarioTimeline(scenario)
      for (let i = 1; i < timeline.length; i += 1) assert.ok(timeline[i].startMs > timeline[i - 1].startMs, scenario.id)
      const first = piUiDemoScenarioEvents(scenario.id)
      const second = piUiDemoScenarioEvents(scenario.id)
      assert.equal(first.length, scenario.steps.length)
      assert.equal(first.map((event) => event.stepIndex).join(","), scenario.steps.map((_, i) => i).join(","))
      assert.equal(first.map((event) => `${event.kind}@${event.at}`).join("|"), second.map((event) => `${event.kind}@${event.at}`).join("|"))
    }
  })

  test("默认流程含工具 / 审批 / 流式文本；advanceTo 分段幂等；reset 可重跑", () => {
    const runner = new PiUiDemoTurnRunner("tool-approval-stream")
    const kinds = runner.scenario.steps.map((step) => step.kind)
    for (const kind of ["tool", "approval", "text", "done"]) assert.ok(kinds.includes(kind), kind)
    const half = runner.advanceTo(runner.durationMs / 2)
    assert.ok(half.length > 0)
    assert.deepEqual(runner.advanceTo(runner.durationMs / 2), [])
    const rest = runner.advanceTo(runner.durationMs)
    assert.equal(half.length + rest.length, runner.scenario.steps.length)
    runner.reset()
    assert.equal(runner.emitted.length, 0)
    assert.equal(runner.runToEnd().length, runner.scenario.steps.length)
    // 每个步骤时长是确定的纯函数
    for (const step of runner.scenario.steps) assert.equal(piUiDemoStepDurationMs(step), piUiDemoStepDurationMs(step))
  })

  test("未知场景回退默认流程（画廊参数容错）", () => {
    assert.equal(piUiDemoModelScenarioOf("no-such-scenario").id, "tool-approval-stream")
    assert.equal(piUiDemoModelScenarioOf(null).id, "tool-approval-stream")
  })
})

/* ------------------------------------------------------------------ 5b. P4 场景表 / 驱动契约 */

describe("P4 场景画廊表（#/p4/<surface>）", () => {
  test("场景表自检无问题（surface ID / 变体 / 能力 / 选择器 / fixture / pending 原因）", () => {
    assert.deepEqual(p4ScenarioProblems(), [])
    assert.ok(P4_SCENARIOS.length >= 20, "场景表规模过小")
  })

  test("surface 唯一、变体与 ID 前缀一致、能力 id 合法", () => {
    const surfaces = new Set()
    for (const scenario of P4_SCENARIOS) {
      assert.equal(surfaces.has(scenario.surface), false, scenario.surface)
      surfaces.add(scenario.surface)
      assert.equal(p4VariantOfSurface(scenario.surface), scenario.variant)
      if (scenario.capability) assert.ok(PI_UI_CAPABILITY_IDS.includes(scenario.capability), scenario.surface)
    }
  })

  test("驱动步骤只用稳定选择器（PI_UI_STABLE_SELECTOR_ATTRIBUTES）", () => {
    const allowed = PI_UI_STABLE_SELECTOR_ATTRIBUTES.map((attr) => `[${attr}`)
    for (const scenario of P4_SCENARIOS) {
      for (const step of scenario.steps) {
        if ("click" in step) assert.ok(allowed.some((prefix) => step.click.startsWith(prefix)), `${scenario.surface} 非稳定选择器 ${step.click}`)
        if ("waitFor" in step) assert.ok(allowed.some((prefix) => step.waitFor.startsWith(prefix)), `${scenario.surface} 非稳定选择器 ${step.waitFor}`)
      }
    }
  })

  test("active / pending 分组覆盖全表；pending 都有原因（e2e 据此 SKIP）", () => {
    assert.equal(p4ActiveScenarios().length + p4PendingScenarios().length, P4_SCENARIOS.length)
    for (const scenario of p4PendingScenarios()) assert.ok(scenario.pending && scenario.pending.trim().length > 0, scenario.surface)
    for (const scenario of p4ActiveScenarios()) assert.equal(scenario.pending, undefined)
  })

  test("未知 surface 返回 null（P4Route 报 data-p4-error）", () => {
    assert.equal(p4ScenarioOf("nope"), null)
    assert.equal(p4ScenarioOf(P4_SCENARIOS[0].surface)?.surface, P4_SCENARIOS[0].surface)
  })
})

/* ------------------------------------------------------------------ 5c. mock model → provider 副作用 */

describe("mock model 全流程副作用（apply）", () => {
  const scenarioOf = (id) => PI_UI_DEMO_MODEL_SCENARIOS.find((scenario) => scenario.id === id)

  test("每个场景的步骤都能应用到 store：事件数 == 步骤数，deterministic", () => {
    for (const scenario of PI_UI_DEMO_MODEL_SCENARIOS) {
      const run = () => {
        const store = createPiUiDemoStore()
        const results = applyPiUiDemoModelStepList(store, scenario.steps)
        return { results, events: store.eventsOf().map((event) => `${event.capability}:${event.type}`) }
      }
      const first = run()
      const second = run()
      // plan 步会触发 4 次 updateStep + 1 次 model:plan；其余步 1 个事件 → 每步至少 1
      assert.ok(first.events.length >= scenario.steps.length, scenario.id)
      assert.deepEqual(first.events, second.events, scenario.id)
      for (const result of first.results) assert.ok(result.events >= 1, `${scenario.id} 每步应至少产出 1 个事件（${result.kind}）`)
    }
  })

  test("cowork-plan：plan-pane 步骤被真实更新 + artifacts 事件", () => {
    const store = createPiUiDemoStore()
    for (const step of scenarioOf("cowork-plan").steps) applyPiUiDemoModelStep(store, step)
    const plan = store.snapshotOf("plan-pane").plan
    assert.ok(plan.steps.some((step) => step.status === "in_progress"))
    assert.ok(plan.steps.some((step) => step.status === "completed"))
    const types = store.eventsOf("plan-pane").map((event) => event.type)
    assert.ok(types.includes("plan:step-updated"))
    assert.ok(store.eventsOf("artifacts").some((event) => event.type === "artifact:created"))
  })

  test("tool-approval-stream：审批事件；error-recovery：错误事件 + 工具事件", () => {
    const approvalStore = createPiUiDemoStore()
    for (const step of scenarioOf("tool-approval-stream").steps) applyPiUiDemoModelStep(approvalStore, step)
    assert.ok(approvalStore.eventsOf("permission-tiers").some((event) => event.type === "model:approval"))
    assert.ok(approvalStore.eventsOf("session-rail-extra").some((event) => event.type === "model:tool"))
    const errorStore = createPiUiDemoStore()
    for (const step of scenarioOf("error-recovery").steps) applyPiUiDemoModelStep(errorStore, step)
    assert.ok(errorStore.eventsOf("background-tasks").some((event) => event.type === "model:error"))
    assert.ok(errorStore.eventsOf("session-rail-extra").some((event) => event.type === "model:tool"))
  })

  test("done 步骤发 model:done（供 e2e 等 data-p4-model-status=done）", () => {
    const store = createPiUiDemoStore()
    for (const step of scenarioOf("review-flow").steps) applyPiUiDemoModelStep(store, step)
    assert.ok(store.eventsOf("session-rail-extra").some((event) => event.type === "model:done"))
  })
})

/* ------------------------------------------------------------------ 6. 隔离：mock 不进生产 / 变体 */

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s+(?!type\b)(?:[^"'`;]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g
const EXTS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]

function readText(file) {
  return fs.readFileSync(file, "utf8")
}

function resolveImport(from, spec) {
  const base = spec.startsWith("@/") ? path.join(SRC, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null
  if (!base) return null
  for (const ext of EXTS) {
    const file = base + ext
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file
  }
  return null
}

function importClosure(entries) {
  const parent = new Map(entries.map((entry) => [entry, null]))
  const queue = [...entries]
  while (queue.length) {
    const file = queue.shift()
    if (!/\.(ts|tsx)$/.test(file)) continue
    const src = readText(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
    for (const match of src.matchAll(IMPORT_RE)) {
      const target = resolveImport(file, match[1] || match[2])
      if (target && !parent.has(target)) {
        parent.set(target, file)
        queue.push(target)
      }
    }
  }
  return parent
}

describe("隔离：生产入口 / 变体 import 闭包不得到达 mock", () => {
  const MOCK_DIR = "ui/src/pi/extensions/mock/"

  test("生产入口闭包（main.tsx / PiApp / 两变体）不含 extensions/mock", () => {
    const entries = [
      path.join(SRC, "pi/main.tsx"),
      path.join(SRC, "pi/PiApp.tsx"),
      path.join(SRC, "pi/variants/claude/ClaudeApp.tsx"),
      path.join(SRC, "pi/variants/codex/CodexApp.tsx"),
    ].filter((file) => fs.existsSync(file))
    assert.ok(entries.length >= 3)
    const closure = importClosure(entries)
    const leaks = [...closure.keys()].filter((file) => rel(file).startsWith(MOCK_DIR))
    assert.deepEqual(leaks.map(rel), [], "生产/变体 import 闭包到达了 extensions/mock")
  })

  test("变体源码不 import @/pi/extensions/mock|dev（allowlist 负例的静态复证）", () => {
    const hits = []
    for (const variant of ["claude", "codex"]) {
      const dir = path.join(SRC, `pi/variants/${variant}`)
      if (!fs.existsSync(dir)) continue
      for (const name of fs.readdirSync(dir, { recursive: true })) {
        if (typeof name !== "string" || !/\.(ts|tsx)$/.test(name)) continue
        const src = readText(path.join(dir, name))
        for (const match of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
          if (/^@\/pi\/extensions\/(mock|dev)(\/|$)/.test(match[1])) hits.push(`${variant}/${name} → ${match[1]}`)
        }
      }
    }
    assert.deepEqual(hits, [])
  })

  test("mock 模块不 import cursor UI / relay / 样式（保持可整体摇掉）", () => {
    const mockDir = path.join(SRC, "pi/extensions/mock")
    const bad = []
    for (const name of fs.readdirSync(mockDir, { recursive: true })) {
      if (typeof name !== "string" || !/\.(ts|tsx)$/.test(name)) continue
      const src = readText(path.join(mockDir, name)).replace(/\/\*[\s\S]*?\*\//g, "")
      if (/from "@\/components\//.test(src)) bad.push(`${name} → @/components`)
      if (/from "@\/relay/.test(src)) bad.push(`${name} → @/relay`)
      if (/\.css["']/.test(src)) bad.push(`${name} → css`)
    }
    assert.deepEqual(bad, [])
  })

  test("package.json 已注册本测试（门禁自检）", () => {
    const pkg = JSON.parse(readText(path.join(ROOT, "package.json")))
    assert.match(pkg.scripts.test, /test\/pi-ui-mock\.test\.mjs/)
  })
})
