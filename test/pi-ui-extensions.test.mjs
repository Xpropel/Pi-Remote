// P4.1 能力 / 扩展契约层测试（纯函数 + 静态扫描；node --test 直接加载 TS）。
// 覆盖：台账 34 项覆盖与映射、builtin/extension 默认状态、provider 注册/解析/合并/校验、禁用态契约、
// 稳定选择器契约、平台记忆 prefs（Q1/Q2）、运行位置（Q3）、mock 注入与旁路、文档锚点、allowlist 收窄与守卫负例。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  PI_UI_BUILTIN_CAPABILITIES,
  PI_UI_CAPABILITIES,
  PI_UI_CAPABILITY_CONTRACT_IDS,
  PI_UI_CAPABILITY_PROVIDER_IDS,
  PI_UI_CAPABILITY_GROUPS,
  PI_UI_EXTENSION_CAPABILITIES,
  PI_UI_EXTENSION_DOC_PATH,
  piUiCapabilityAnchors,
  piUiCapabilityMetaOf,
} from "../ui/src/pi/extensions/capabilities.ts"
import { PI_UI_DISABLED_COPY } from "../ui/src/pi/extensions/disabled.ts"
import {
  PI_UI_CAPABILITY_INVENTORY_MAP,
  PI_UI_CONTRACT_EXTRAS,
  PI_UI_INVENTORY_CAPABILITY_MAP,
  PI_UI_INVENTORY_MAPPING,
  PI_UI_LEDGER_CAPABILITIES,
  PI_UI_LEGACY_CAPABILITY_ALIASES,
  PI_UI_SURFACE_CANDIDATES,
  piUiContractIdOfInventoryId,
  piUiInventoryCoverage,
} from "../ui/src/pi/extensions/inventory-map.ts"
import {
  PI_UI_WORKSPACE_PREF_FIELDS,
  PI_UI_PREFS_KEY,
  PI_UI_PLATFORM_TABS,
  PI_UI_RUN_LOCATIONS,
  PI_UI_WORKSPACE_PREFS_DEFAULTS,
  mergePiUiWorkspacePrefs,
  piUiPlatformOf,
  piUiRunLocationOf,
  piUiWorkspacePrefsOf,
  readPiUiWorkspacePrefs,
  resolvePiUiPlatformSelection,
  writePiUiWorkspacePrefs,
  PI_UI_GIT_WORKTREE_CAPABILITY,
} from "../ui/src/pi/extensions/platform-prefs.ts"
import {
  PiUiExtensionError,
  piUiCapabilities,
  piUiCapabilitiesOf,
  piUiCapabilityStatusOf,
  piUiExtensionBindingOf,
  piUiExtensionProblems,
  piUiExtensionProviders,
  piUiExtensionSnapshot,
  registerPiUiExtension,
  resetPiUiExtensions,
  subscribePiUiExtensions,
  unregisterPiUiExtension,
} from "../ui/src/pi/extensions/registry.ts"
import { PI_UI_STABLE_SELECTORS, PI_UI_STABLE_SELECTOR_ATTRIBUTES, piUiCapabilityAttrs, piUiReadyAttr, piUiSurfaceAttrs } from "../ui/src/pi/extensions/selectors.ts"
import { PI_UI_CAPABILITY_IDS } from "../ui/src/pi/extensions/types.ts"
import { PI_UI_DEMO_FIXTURES, piUiMockFixtureOf } from "../ui/src/pi/extensions/mock/fixtures.ts"
import { PI_UI_DEMO_FLAG_KEY, parsePiUiMockCaps, piUiMockOptionsFromSearch, piUiMockOptionsFromStorage, resolvePiUiMockOptions } from "../ui/src/pi/extensions/mock/options.ts"
import { createPiUiMockProvider, PI_UI_DEMO_PROVIDER_ID, piUiMockProvides } from "../ui/src/pi/extensions/mock/provider.ts"
import { installPiUiExtensionMock, installPiUiExtensionMockIfRequested, uninstallPiUiExtensionMock } from "../ui/src/pi/extensions/mock/index.ts"
import { DEFAULT_PI_PREFS, migratePiPrefs } from "../ui/src/pi/model/prefs.ts"
import { PI_VARIANT_ALLOWED_EXTENSION_MODULES, PI_VARIANT_FORBIDDEN_EXTENSION_MODULES, piVariantImportVerdict } from "../ui/src/pi/headless/allowlist.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXT = path.join(ROOT, "ui/src/pi/extensions")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
const req = (capability) => ({ getData: () => PI_UI_DEMO_FIXTURES[capability] })
const codeFiles = (dir) => fs.readdirSync(dir, { recursive: true }).filter((n) => typeof n === "string" && /\.(ts|tsx)$/.test(n))

/* ------------------------------------------------------------------ 台账 / 能力清单 */

describe("台账对齐：40 契约 ⟷ 37 台账行双向齐全（P1-①）", () => {
  test("契约 40 个能力 ID 唯一；台账 A.1 37 行 + A.2 3 extra 全部双向有落点，无静默缺口", () => {
    const cov = piUiInventoryCoverage()
    assert.deepEqual(cov, {
      inventory: 37,
      mappedInventory: 37,
      missingInventory: [],
      contract: 40,
      mappedContract: 40,
      missingContract: [],
      candidates: 3,
      extras: 3,
    })
    assert.equal(PI_UI_CAPABILITY_IDS.length, 40)
    assert.equal(new Set(PI_UI_CAPABILITY_IDS).size, 40)
    assert.equal(PI_UI_CAPABILITIES.length, 40)
    assert.deepEqual(PI_UI_CAPABILITIES.map((c) => c.id), [...PI_UI_CAPABILITY_IDS])
    assert.equal(PI_UI_INVENTORY_CAPABILITY_MAP.length, 37, "A.1 = 34 语义 + 3 candidate")
    assert.equal(PI_UI_INVENTORY_MAPPING.length, 40, "A.1 37 + A.2 3")
    assert.equal(Object.keys(PI_UI_CAPABILITY_INVENTORY_MAP).length, 40, "反向映射覆盖全部 40")
    for (const id of PI_UI_LEDGER_CAPABILITIES) {
      assert.ok(PI_UI_CAPABILITY_IDS.includes(id), `台账能力缺契约：${id}`)
      assert.deepEqual(PI_UI_CAPABILITY_INVENTORY_MAP[id], [id], `台账 ${id} 反向落点`)
    }
    for (const row of PI_UI_SURFACE_CANDIDATES) assert.deepEqual(PI_UI_CAPABILITY_INVENTORY_MAP[row.contractId], [row.inventoryId])
    for (const row of PI_UI_CONTRACT_EXTRAS) assert.deepEqual(PI_UI_CAPABILITY_INVENTORY_MAP[row.contractId], ["(none)"])
  })

  test("candidate 三项独立（不并入）：ID/契约/台账连边", () => {
    for (const contractId of ["subagent-orchestration", "git-stage", "thread-fork-feedback"]) {
      assert.ok(PI_UI_CAPABILITY_IDS.includes(contractId), contractId)
      assert.ok(PI_UI_CAPABILITIES.some((c) => c.id === contractId), contractId)
    }
    assert.deepEqual(PI_UI_SURFACE_CANDIDATES.map((r) => [r.inventoryId, r.contractId]), [
      ["CL-CODE-25", "subagent-orchestration"],
      ["CX-PANEL-05", "git-stage"],
      ["CX-THREAD-07", "thread-fork-feedback"],
    ])
    for (const row of PI_UI_SURFACE_CANDIDATES) assert.equal(piUiContractIdOfInventoryId(row.inventoryId), row.contractId)
    // git-stage 与 git-commit 独立：暂存动作在 git-stage；git-commit 数据契约只有 repos
    assert.equal(piUiCapabilityMetaOf("git-commit").id, "git-commit")
    assert.equal(piUiCapabilityMetaOf("git-stage").id, "git-stage")
    // thread-fork-feedback 子状态：fork=available（Pi 现有）/ feedback=simulated（缺失）
    const fixture = PI_UI_DEMO_FIXTURES["thread-fork-feedback"]
    assert.equal(fixture.fork.available, true)
    assert.equal(fixture.feedback.enabled, true, "mock 下 feedback 演示开启")
  })

  test("旧稿别名只是开发期兼容；台账/契约 ID 逐字一致（pane-workspace / pane-dock-drag / subagents-panel）", () => {
    assert.equal(piUiContractIdOfInventoryId("workspace-panes"), "pane-workspace")
    assert.equal(piUiContractIdOfInventoryId("drag-dock"), "pane-dock-drag")
    assert.equal(piUiContractIdOfInventoryId("subagent-panel"), "subagents-panel")
    for (const contractId of Object.values(PI_UI_LEGACY_CAPABILITY_ALIASES)) assert.ok(PI_UI_CAPABILITY_IDS.includes(contractId))
    assert.ok(!PI_UI_CAPABILITY_IDS.includes("workspace-panes"))
    assert.ok(!PI_UI_CAPABILITY_IDS.includes("drag-dock"))
    assert.ok(!PI_UI_CAPABILITY_IDS.includes("subagent-panel"))
  })

  test("默认状态按真实能力：builtin available（不要求 provider），extension unavailable", () => {
    assert.deepEqual([...PI_UI_BUILTIN_CAPABILITIES].sort(), [
      "background-tasks",
      "context-usage",
      "density-modes",
      "device-platform-tabs",
      "file-preview",
      "mcp-tools",
      "model-menu",
      "work-mode",
      "workspace-modes",
    ].sort())
    for (const id of PI_UI_BUILTIN_CAPABILITIES) {
      const meta = piUiCapabilityMetaOf(id)
      assert.equal(meta.source, "builtin", id)
      assert.equal(meta.defaultStatus, "available", id)
    }
    for (const id of PI_UI_EXTENSION_CAPABILITIES) {
      const meta = piUiCapabilityMetaOf(id)
      assert.equal(meta.source, "extension", id)
      assert.equal(meta.defaultStatus, "unavailable", id)
    }
    // Lead 语义裁决
    assert.equal(piUiCapabilityMetaOf("worktree").defaultStatus, "unavailable", "git worktree → 禁用入口")
    assert.equal(piUiCapabilityMetaOf("work-mode").defaultStatus, "available", "Codex 三段运行位置 = 纯 UI 状态")
    assert.equal(piUiCapabilityMetaOf("workspace-modes").defaultStatus, "available", "Claude 三态 = 纯 UI 状态")
    for (const id of ["density-modes", "background-tasks", "mcp-tools"]) assert.equal(piUiCapabilityMetaOf(id).defaultStatus, "available")
  })

  test("唯一清单常量：ids.length === metas.length；provider-backed 与 contract-only 分区覆盖全部 ID（全项目计数唯一口径）", () => {
    assert.equal(PI_UI_CAPABILITY_IDS.length, PI_UI_CAPABILITIES.length)
    assert.equal(PI_UI_CAPABILITY_PROVIDER_IDS.length + PI_UI_CAPABILITY_CONTRACT_IDS.length, PI_UI_CAPABILITY_IDS.length)
    // 交集为空、并集 = 全量
    const provider = new Set(PI_UI_CAPABILITY_PROVIDER_IDS)
    assert.deepEqual(PI_UI_CAPABILITY_CONTRACT_IDS.filter((id) => provider.has(id)), [])
    assert.deepEqual([...PI_UI_CAPABILITY_PROVIDER_IDS, ...PI_UI_CAPABILITY_CONTRACT_IDS].sort(), [...PI_UI_CAPABILITY_IDS].sort())
    // providerBacked 与 source 一致（extension → true；builtin → false）
    for (const meta of PI_UI_CAPABILITIES) assert.equal(meta.providerBacked, meta.source === "extension", meta.id)
    assert.deepEqual([...PI_UI_CAPABILITY_CONTRACT_IDS].sort(), [...PI_UI_BUILTIN_CAPABILITIES].sort())
    // 不再手写数量：以常量为准（此处只断言与 meta 派生一致，不写死 40）
    assert.equal(PI_UI_CAPABILITY_PROVIDER_IDS.length, PI_UI_CAPABILITIES.filter((m) => m.providerBacked).length)
  })

  test("元数据/锚点完整；默认 unavailable 的能力都有未提供原因", () => {
    const groups = new Set(PI_UI_CAPABILITY_GROUPS.map((g) => g.id))
    for (const c of PI_UI_CAPABILITIES) {
      assert.ok(c.label && c.description, c.id)
      assert.ok(groups.has(c.group), c.id)
      assert.equal(c.docAnchor, `#cap-${c.id}`)
      if (c.defaultStatus === "unavailable") assert.ok(c.unavailableReason.length > 0, c.id)
    }
    assert.equal(new Set(piUiCapabilityAnchors()).size, 40)
  })
})

/* ------------------------------------------------------------------ 注册表 / 默认状态 / provider */

describe("扩展注册表与 provider 契约", () => {
  test("无 provider：builtin available；extension unavailable + 禁用态契约（扩展接入文档 锚点）", () => {
    resetPiUiExtensions()
    assert.deepEqual(piUiExtensionProviders(), [])
    const caps = piUiCapabilities()
    for (const id of PI_UI_BUILTIN_CAPABILITIES) {
      assert.equal(caps.statusOf(id), "available", id)
      assert.equal(caps.disabledOf(id), null, id)
    }
    for (const id of PI_UI_EXTENSION_CAPABILITIES) {
      assert.equal(caps.statusOf(id), "unavailable", id)
      const disabled = caps.disabledOf(id)
      assert.ok(disabled, id)
      assert.equal(disabled.title, PI_UI_DISABLED_COPY.unavailableTitle)
      assert.equal(disabled.simulated, false)
      assert.equal(disabled.docsPath, `${PI_UI_EXTENSION_DOC_PATH}#cap-${id}`)
    }
    assert.equal(caps.list().length, 40)
  })

  test("provider 注册/解析/覆盖：available / simulated / 最后注册优先 / 同 id 覆盖", () => {
    resetPiUiExtensions()
    registerPiUiExtension({ id: "ext-artifacts", capabilities: { artifacts: req("artifacts") } })
    let caps = piUiCapabilities()
    assert.equal(caps.statusOf("artifacts"), "available")
    assert.equal(caps.disabledOf("artifacts"), null)
    assert.deepEqual(caps.dataOf("artifacts"), PI_UI_DEMO_FIXTURES.artifacts)
    registerPiUiExtension({ id: "ext-2", capabilities: { artifacts: { getData: () => ({ artifacts: [] }), mode: "simulated" }, skills: req("skills") } })
    caps = piUiCapabilities()
    assert.equal(caps.statusOf("artifacts"), "simulated", "最后注册者优先")
    assert.equal(caps.bindingOf("artifacts").providerId, "ext-2")
    assert.equal(caps.disabledOf("artifacts").simulated, true)
    assert.equal(caps.statusOf("skills"), "available")
    registerPiUiExtension({ id: "ext-artifacts", capabilities: { artifacts: req("artifacts") } })
    assert.equal(piUiCapabilityStatusOf("artifacts"), "available", "同 id 覆盖/最后注册者优先")
    resetPiUiExtensions()
  })

  test("订阅通知：register/unregister 触发；快照稳定；取消订阅生效", () => {
    resetPiUiExtensions()
    let calls = 0
    const off = subscribePiUiExtensions(() => (calls += 1))
    const before = piUiExtensionSnapshot()
    assert.equal(piUiExtensionSnapshot(), before)
    registerPiUiExtension({ id: "ext-s", capabilities: { plugins: req("plugins") } })
    assert.equal(calls, 1)
    assert.equal(piUiExtensionSnapshot().version, before.version + 1)
    unregisterPiUiExtension("ext-s")
    assert.equal(calls, 2)
    off()
    const settled = calls
    registerPiUiExtension({ id: "ext-s2", capabilities: { plugins: req("plugins") } })
    assert.equal(calls, settled)
    resetPiUiExtensions()
  })

  test("provider 校验：合法无问题；缺 id/未知能力/getData/mode 错误逐项报；注册非法抛错", () => {
    assert.deepEqual(piUiExtensionProblems({ id: "ok", capabilities: { artifacts: req("artifacts") } }), [])
    const bad = piUiExtensionProblems({ capabilities: { artifacts: { getData: 1 }, unknown: { getData: () => ({}) } } })
    assert.ok(bad.some((p) => /provider\.id/.test(p)))
    assert.ok(bad.some((p) => /未知能力 id/.test(p)))
    assert.ok(bad.some((p) => /getData/.test(p)))
    assert.ok(piUiExtensionProblems({ id: "m", capabilities: { artifacts: { getData: () => ({}), mode: "unavailable" } } }).some((p) => /mode 只能是/.test(p)))
    resetPiUiExtensions()
    assert.throws(() => registerPiUiExtension({ id: "", capabilities: {} }), PiUiExtensionError)
    assert.equal(piUiExtensionProviders().length, 0)
  })

  test("binding 暴露 subscribe / onEvent；无实现的 provider 是空函数", () => {
    resetPiUiExtensions()
    let subscribed = 0
    let evented = 0
    registerPiUiExtension({
      id: "ext-events",
      capabilities: {
        automations: {
          getData: () => ({ automations: [] }),
          subscribe: (listener) => { subscribed += 1; listener(); return () => {} },
          onEvent: (listener) => { evented += 1; listener({ capability: "automations", type: "run", at: 1 }); return () => {} },
        },
      },
    })
    const binding = piUiExtensionBindingOf("automations")
    binding.subscribe(() => {})
    binding.onEvent(() => {})
    assert.deepEqual([subscribed, evented], [1, 1])
    resetPiUiExtensions()
    registerPiUiExtension({ id: "plain", capabilities: { plugins: req("plugins") } })
    assert.equal(typeof piUiExtensionBindingOf("plugins").subscribe(() => {}), "function")
    resetPiUiExtensions()
  })
})

/* ------------------------------------------------------------------ 稳定选择器 / 禁用态 */

describe("稳定选择器契约（P2-④ / Lead P2-①）", () => {
  test("六个稳定属性齐全且精确（data-p4-surface/action/row/pane、data-pi-capability-disabled、data-p4-ready）", () => {
    assert.deepEqual(PI_UI_STABLE_SELECTORS, {
      surface: "data-p4-surface",
      action: "data-p4-action",
      row: "data-p4-row",
      pane: "data-p4-pane",
      capability: "data-pi-capability",
      capabilityState: "data-capability-state",
      disabled: "data-pi-capability-disabled",
      ready: "data-p4-ready",
    })
    for (const required of ["data-p4-surface", "data-p4-action", "data-p4-row", "data-p4-pane", "data-pi-capability-disabled", "data-p4-ready"]) {
      assert.ok(PI_UI_STABLE_SELECTOR_ATTRIBUTES.includes(required), required)
    }
  })

  test("helper 输出：surface 属性 / 能力状态属性（非 available 自动 disabled）/ 就绪标记", () => {
    assert.deepEqual(piUiSurfaceAttrs({ surface: "CL-CODE-02", action: "artifacts.open", row: "r1", pane: "pane-changes" }), {
      "data-p4-surface": "CL-CODE-02",
      "data-p4-action": "artifacts.open",
      "data-p4-row": "r1",
      "data-p4-pane": "pane-changes",
    })
    assert.deepEqual(piUiCapabilityAttrs("artifacts", "available"), { "data-pi-capability": "artifacts", "data-capability-state": "available" })
    assert.deepEqual(piUiCapabilityAttrs("artifacts", "unavailable"), {
      "data-pi-capability": "artifacts",
      "data-capability-state": "unavailable",
      "data-pi-capability-disabled": "",
    })
    assert.equal(piUiCapabilityAttrs("artifacts", "simulated")["data-pi-capability-disabled"], "")
    assert.deepEqual(piUiReadyAttr(true), { "data-p4-ready": "" })
    assert.deepEqual(piUiReadyAttr(false), {})
  })
})

/* ------------------------------------------------------------------ pane-workspace kind 扩展（mock M2e） */

describe("pane-workspace kind：tasks / subagent 入契约（去运行时 cast）", () => {
  test("PiUiPaneDescriptor.kind 覆盖 tasks/subagent；mock fixtures 无 cast；DOC74 #cap-pane-workspace 同步", () => {
    const types = read("ui/src/pi/extensions/types.ts")
    assert.match(types, /kind: "changes" \| "files" \| "terminal" \| "browser" \| "plan" \| "side-chat" \| "tasks" \| "subagent" \| "custom"/)
    const fixtures = read("ui/src/pi/extensions/mock/fixtures.ts")
    assert.doesNotMatch(fixtures, /as unknown as PiUiPaneDescriptor\["kind"\]/, "kind cast 应已移除")
    const kinds = (PI_UI_DEMO_FIXTURES["pane-workspace"].panes || []).map((pane) => pane.kind)
    for (const expected of ["tasks", "subagent"]) assert.ok(kinds.includes(expected), `fixtures 缺 ${expected} pane`)
    assert.equal(PI_UI_CAPABILITY_IDS.length, 40, "能力计数不变")
  })
})

/* ------------------------------------------------------------------ pr-review 动作扩展（Codex refit 缺口） */

describe("pr-review 契约扩展：merge / close / archive / reopen（能力数不变）", () => {
  test("动作/状态/事件类型齐备；fixtures 覆盖 archived/closed；DOC74 #cap-pr-review 同步", () => {
    const types = read("ui/src/pi/extensions/types.ts")
    for (const action of ["mergePr", "closePr", "archivePr", "reopenPr"]) assert.ok(types.includes(`${action}?`), `缺动作 ${action}`)
    assert.match(types, /state: "open" \| "draft" \| "merged" \| "closed" \| "archived"/)
    assert.match(types, /PiUiPrReviewEventType/)
    for (const eventType of ["pr:merged", "pr:closed", "pr:archived", "pr:reopened"]) assert.ok(types.includes(eventType), eventType)
    const prs = PI_UI_DEMO_FIXTURES["pr-review"].pullRequests
    assert.ok(prs.some((pr) => pr.state === "archived"), "fixtures 需要 archived PR")
    assert.ok(prs.some((pr) => pr.state === "closed"), "fixtures 需要 closed PR")
    // 同一 capability 扩展动作 → 能力计数不变
    assert.equal(PI_UI_CAPABILITY_IDS.length, 40)
    assert.equal(PI_UI_CAPABILITIES.length, 40)
  })
})

/* ------------------------------------------------------------------ 平台记忆 prefs（Q1/Q2）/ 运行位置（Q3） */

describe("平台记忆 prefs（Q1/Q2）与运行位置（Q3）", () => {
  test("prefs 字段预留：默认 all/{}；校验回退；合并保留其他字段与 v", () => {
    assert.equal(PI_UI_PREFS_KEY, "pi_remote_pi_prefs", "复用现有偏好键")
    assert.deepEqual(PI_UI_PLATFORM_TABS, ["all", "macos", "windows", "linux"])
    assert.deepEqual(PI_UI_WORKSPACE_PREF_FIELDS, ["uiPlatformTab", "deviceByPlatform"])
    assert.deepEqual(piUiWorkspacePrefsOf(null), { uiPlatformTab: "all", deviceByPlatform: {} })
    for (const bad of ["x", "all", 1, []]) assert.equal(piUiWorkspacePrefsOf({ uiPlatformTab: bad }).uiPlatformTab, "all", String(bad))
    assert.deepEqual(piUiWorkspacePrefsOf({ uiPlatformTab: "macos", deviceByPlatform: { macos: "d-mbp", windows: 3, linux: "", evil: "x" } }), {
      uiPlatformTab: "macos",
      deviceByPlatform: { macos: "d-mbp" },
    })
    const merged = mergePiUiWorkspacePrefs('{"v":1,"theme":"dark","uiPlatformTab":"windows","deviceByPlatform":{"windows":"d-win"},"junk":1}', {
      uiPlatformTab: "linux",
      deviceByPlatform: { linux: "d-lin" },
    })
    assert.deepEqual(merged, {
      v: 1,
      theme: "dark",
      uiPlatformTab: "linux",
      deviceByPlatform: { windows: "d-win", linux: "d-lin" },
      junk: 1,
    })
  })

  test("读写 storage（与现有 prefs 同键合并写回；坏数据/异常不抛）", () => {
    const store = new Map()
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
    assert.deepEqual(readPiUiWorkspacePrefs(storage), PI_UI_WORKSPACE_PREFS_DEFAULTS)
    store.set(PI_UI_PREFS_KEY, '{"v":1,"theme":"dark","uiPlatformTab":"windows","deviceByPlatform":{"windows":"d-win"}}')
    assert.deepEqual(readPiUiWorkspacePrefs(storage), { uiPlatformTab: "windows", deviceByPlatform: { windows: "d-win" } })
    const written = writePiUiWorkspacePrefs(storage, { uiPlatformTab: "macos", deviceByPlatform: { macos: "d-mbp" } })
    assert.deepEqual(written, { uiPlatformTab: "macos", deviceByPlatform: { windows: "d-win", macos: "d-mbp" } })
    const raw = JSON.parse(store.get(PI_UI_PREFS_KEY))
    assert.equal(raw.v, 1, "保留版本号")
    assert.equal(raw.theme, "dark", "保留其他偏好字段")
    assert.deepEqual(readPiUiWorkspacePrefs({ getItem: () => "not json" }), PI_UI_WORKSPACE_PREFS_DEFAULTS)
    assert.deepEqual(readPiUiWorkspacePrefs(null), PI_UI_WORKSPACE_PREFS_DEFAULTS)
  })

  test("平台映射：darwin/mac/macos→macos；win32/windows→windows；linux→linux；未知 null", () => {
    for (const raw of ["darwin", "mac", "macOS", "macosx"]) assert.equal(piUiPlatformOf(raw), "macos", raw)
    for (const raw of ["win32", "Windows", "win"]) assert.equal(piUiPlatformOf(raw), "windows", raw)
    assert.equal(piUiPlatformOf("linux"), "linux")
    assert.equal(piUiPlatformOf(null), null)
    assert.equal(piUiPlatformOf("freebsd"), null)
  })

  test("Q2 平台标签 = 筛平台 + 平台内选设备（单设备自动、无设备禁用+配对、与粗筛交集、记忆优先）", () => {
    const devices = [
      { id: "d-mbp", platform: "darwin", online: true },
      { id: "d-studio", platform: "darwin", online: true },
      { id: "d-win", platform: "win32", online: true },
      { id: "d-lin", platform: "linux", online: false },
    ]
    // all：不按平台细分（粗筛照旧）
    const all = resolvePiUiPlatformSelection({ tab: "all", devices })
    assert.deepEqual([all.platform, all.eligibleDeviceIds, all.selectedDeviceId, all.disabledReason], [null, ["d-mbp", "d-studio", "d-win", "d-lin"], "d-mbp", null])
    // 单设备平台：自动选中
    const win = resolvePiUiPlatformSelection({ tab: "windows", devices })
    assert.deepEqual([win.selectedDeviceId, win.autoSelected, win.disabledReason, win.showPairingEntry], ["d-win", true, null, false])
    // 多设备平台：记忆设备优先；记忆失效时用当前选择
    const mac = resolvePiUiPlatformSelection({ tab: "macos", devices, deviceByPlatform: { macos: "d-studio" }, selectedDeviceId: "d-mbp" })
    assert.deepEqual([mac.selectedDeviceId, mac.rememberedDeviceId, mac.autoSelected], ["d-studio", "d-studio", false])
    const macFallback = resolvePiUiPlatformSelection({ tab: "macos", devices, deviceByPlatform: { macos: "gone" }, selectedDeviceId: "d-mbp" })
    assert.equal(macFallback.selectedDeviceId, "d-mbp")
    assert.equal(macFallback.autoSelected, false)
    // 粗筛 ∩ 平台筛：粗筛 mac 设备后 windows 平台无候选 → 禁用 + 配对入口
    const none = resolvePiUiPlatformSelection({ tab: "windows", devices, coarseDeviceFilter: "d-mbp" })
    assert.deepEqual([none.eligibleDeviceIds, none.selectedDeviceId, none.showPairingEntry], [[], null, true])
    assert.match(none.disabledReason, /暂时没有已配对设备|暂无已配对设备/)
    // 未知平台设备不进候选
    const unknown = resolvePiUiPlatformSelection({ tab: "linux", devices: [{ id: "x", platform: "freebsd" }] })
    assert.deepEqual(unknown.eligibleDeviceIds, [])
    assert.equal(unknown.showPairingEntry, true)
  })

  test("Q3 运行位置：Local/Worktree/Cloud → 当前设备/指定文件夹/远端设备（纯 UI available）；git worktree 是独立禁用能力", () => {
    assert.deepEqual(PI_UI_RUN_LOCATIONS.map((o) => o.id), ["local", "folder", "remote"])
    for (const option of PI_UI_RUN_LOCATIONS) assert.equal(option.status, "available")
    assert.deepEqual([piUiRunLocationOf("Local"), piUiRunLocationOf("Worktree"), piUiRunLocationOf("Cloud")], ["local", "folder", "remote"])
    assert.equal(PI_UI_GIT_WORKTREE_CAPABILITY, "worktree")
    assert.equal(piUiCapabilityMetaOf("worktree").defaultStatus, "unavailable")
    assert.equal(piUiCapabilityMetaOf("worktree").source, "extension")
  })
})

/* ------------------------------------------------------------------ prefs 集成（Q1） */

describe("prefs 集成（Q1：uiPlatformTab / deviceByPlatform）", () => {
  test("默认偏好带 all / {}；旧 prefs 无字段 = 默认（迁移兼容）；合法值保留、非法回退；cursor 不变", () => {
    assert.equal(DEFAULT_PI_PREFS.uiPlatformTab, "all")
    assert.deepEqual(DEFAULT_PI_PREFS.deviceByPlatform, {})
    const legacy = migratePiPrefs(JSON.stringify({ v: 1, theme: "dark", density: "compact" }))
    assert.deepEqual([legacy.uiPlatformTab, legacy.deviceByPlatform], ["all", {}])
    const stored = migratePiPrefs(JSON.stringify({ v: 1, ui: "claude", uiPlatformTab: "macos", deviceByPlatform: { macos: "d-mbp", windows: 3, bad: "x" } }))
    assert.deepEqual([stored.ui, stored.uiPlatformTab, stored.deviceByPlatform], ["claude", "macos", { macos: "d-mbp" }])
    const bad = migratePiPrefs(JSON.stringify({ v: 1, uiPlatformTab: "bsd", deviceByPlatform: "nope" }))
    assert.deepEqual([bad.uiPlatformTab, bad.deviceByPlatform], ["all", {}])
    // cursor 字段不受影响（旧键 / 新键其它字段照旧）
    assert.equal(migratePiPrefs(null, JSON.stringify({ completionSound: true })).completionSound, true)
    assert.equal(migratePiPrefs(null).ui, "cursor")
  })
})

/* ------------------------------------------------------------------ mock 注入 */

describe("mock 注入（dev / gallery 旁路）", () => {
  test("?caps= 解析 / localStorage flag / URL 优先", () => {
    assert.deepEqual(parsePiUiMockCaps("all"), [...PI_UI_CAPABILITY_IDS])
    assert.deepEqual(parsePiUiMockCaps("artifacts, browser-pane"), ["artifacts", "browser-pane"])
    assert.deepEqual(parsePiUiMockCaps("artifacts,nope,,"), ["artifacts"])
    assert.equal(parsePiUiMockCaps("nope"), null)
    assert.deepEqual(piUiMockOptionsFromSearch("?caps=artifacts"), { caps: ["artifacts"], mode: "simulated", source: "url" })
    assert.equal(piUiMockOptionsFromSearch("?ui=claude"), null)
    const storage = { getItem: (k) => (k === PI_UI_DEMO_FLAG_KEY ? "browser-pane" : null) }
    assert.deepEqual(piUiMockOptionsFromStorage(storage), { caps: ["browser-pane"], mode: "simulated", source: "storage" })
    assert.deepEqual(resolvePiUiMockOptions({ search: "?caps=artifacts", storage }), { caps: ["artifacts"], mode: "simulated", source: "url" })
  })

  test("fixtures 覆盖全部契约能力；mock provider 只提供请求项、deterministic、simulated", () => {
    for (const id of PI_UI_CAPABILITY_IDS) assert.ok(PI_UI_DEMO_FIXTURES[id] != null, `mock fixtures 缺 ${id}`)
    const options = { caps: ["artifacts", "browser-pane", "git-stage"], mode: "simulated", source: "url" }
    const provider = createPiUiMockProvider(options)
    assert.equal(provider.id, PI_UI_DEMO_PROVIDER_ID)
    assert.deepEqual(Object.keys(provider.capabilities).sort(), ["artifacts", "browser-pane", "git-stage"])
    assert.deepEqual(provider.capabilities.artifacts.getData(), PI_UI_DEMO_FIXTURES.artifacts)
    assert.deepEqual(provider.capabilities.artifacts.getData(), provider.capabilities.artifacts.getData())
    assert.equal(piUiMockProvides(options, "artifacts"), true)
    assert.equal(piUiMockProvides(options, "plugins"), false)
    resetPiUiExtensions()
    registerPiUiExtension(provider)
    assert.equal(piUiCapabilities().statusOf("artifacts"), "simulated")
    unregisterPiUiExtension(PI_UI_DEMO_PROVIDER_ID)
    assert.equal(piUiCapabilityStatusOf("artifacts"), "unavailable")
  })

  test("显式 install（生产构建/静态 gallery 可用）+ 自动 install force 旁路 + 卸载", () => {
    resetPiUiExtensions()
    installPiUiExtensionMock({ caps: ["artifacts", "worktree", "git-stage"], mode: "simulated", source: "url" })
    assert.equal(piUiCapabilities().statusOf("artifacts"), "simulated")
    assert.equal(piUiCapabilities().statusOf("worktree"), "simulated", "候选/缺失能力也能被 mock 解锁演示")
    uninstallPiUiExtensionMock()
    assert.equal(piUiCapabilityStatusOf("artifacts"), "unavailable")
    // IfRequested：node 环境 DEV 非 true，不带 force 应为 false；force + 注入 search 能装上（PI_GALLERY 静态 build 旁路）
    assert.equal(installPiUiExtensionMockIfRequested({ search: "?caps=artifacts" }), false)
    assert.equal(installPiUiExtensionMockIfRequested({ force: true, search: "?caps=artifacts", storage: null }), true)
    assert.equal(piUiCapabilityStatusOf("artifacts"), "simulated")
    uninstallPiUiExtensionMock()
    assert.equal(piUiCapabilityStatusOf("artifacts"), "unavailable")
    resetPiUiExtensions()
  })
})

/* ------------------------------------------------------------------ allowlist 收窄 / 守卫负例 / 文档 */

describe("allowlist 收窄与守卫负例（P1-②）", () => {
  test("变体只允许精确契约模块；mock/dev 禁止；未知扩展子模块禁止", () => {
    for (const module of PI_VARIANT_ALLOWED_EXTENSION_MODULES) assert.equal(piVariantImportVerdict(module).ok, true, module)
    for (const forbidden of PI_VARIANT_FORBIDDEN_EXTENSION_MODULES) {
      assert.equal(piVariantImportVerdict(forbidden).ok, false, forbidden)
      assert.equal(piVariantImportVerdict(`${forbidden}/index`).ok, false, `${forbidden}/index`)
      assert.equal(piVariantImportVerdict(forbidden === "@/pi/extensions/mock" ? "@/pi/extensions/mock/provider" : `${forbidden}/x`).ok, false)
    }
    assert.equal(piVariantImportVerdict("@/pi/extensions/fixtures").ok, false, "未登记扩展模块不放行")
    assert.equal(piVariantImportVerdict("@/pi/extensions/mock").ok, false)
    assert.equal(piVariantImportVerdict("@/pi/extensions/mock/provider").ok, false)
  })

  test("守卫负例：变体源码不得 import @/pi/extensions/mock|dev（静态扫描两变体目录）", () => {
    const variantDirs = ["claude", "codex"].map((id) => path.join(ROOT, `ui/src/pi/variants/${id}`))
    const hits = []
    for (const dir of variantDirs) {
      for (const name of fs.readdirSync(dir, { recursive: true })) {
        if (typeof name !== "string" || !/\.(ts|tsx)$/.test(name)) continue
        const src = fs.readFileSync(path.join(dir, name), "utf8")
        for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) if (/^@\/pi\/extensions\/(mock|dev)(\/|$)/.test(m[1])) hits.push(`${dir}/${name} → ${m[1]}`)
      }
    }
    assert.deepEqual(hits, [])
  })

  test("extensions 契约层不依赖 relay / cursor UI / 样式；index 不静态引 mock", () => {
    for (const name of codeFiles(EXT)) {
      if (name.startsWith("mock/")) continue
      const src = stripComments(fs.readFileSync(path.join(EXT, name), "utf8"))
      assert.doesNotMatch(src, /from "@\/relay/, name)
      assert.doesNotMatch(src, /from "@\/components/, name)
      assert.doesNotMatch(src, /className|--cw-/, name)
    }
    const indexCode = stripComments(read("ui/src/pi/extensions/index.ts"))
    assert.doesNotMatch(indexCode, /mock/, "index 代码不得引用 mock")
    assert.doesNotMatch(read("ui/src/pi/main.tsx"), /extensions\/mock/)
    assert.doesNotMatch(read("ui/src/pi/PiApp.tsx"), /extensions\/mock/)
  })


})
