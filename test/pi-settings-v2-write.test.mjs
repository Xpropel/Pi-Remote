// Pi-Remote 设置页 v2 · settings_set 写桥接入契约测试。
// 纯 Node：纯函数直接 import .ts，页面用静态守卫（不加载 tsx / React）。
// 覆盖：14 键映射、成对模型、get_settings 解析、applied 乐观覆盖、保存调用、
//       失败分类与回滚口径、重启提示、只读原因、缺键默认值、待重启 overlay。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const write = await import("../ui/src/pi/settings/pages/settingsWrite.ts")

const PAGE = (name) => stripComments(read(`ui/src/pi/settings/pages/${name}`))
const MOBILE = (name) => stripComments(read(`ui/src/pi/settings/mobile/pages/${name}`))

const DESKTOP_PAGES = {
  GeneralPage: PAGE("GeneralPage.tsx"),
  ModelPage: PAGE("ModelPage.tsx"),
  PrivacyPage: PAGE("PrivacyPage.tsx"),
  ExtensionsPage: PAGE("ExtensionsPage.tsx"),
  ApprovalPage: PAGE("ApprovalPage.tsx"),
}
const MOBILE_PAGES = {
  GeneralPage: MOBILE("GeneralPage.tsx"),
  ModelPage: MOBILE("ModelPage.tsx"),
  PrivacyPage: MOBILE("PrivacyPage.tsx"),
  ExtensionsPage: MOBILE("ExtensionsPage.tsx"),
  ApprovalPage: MOBILE("ApprovalPage.tsx"),
}
const HOOK_SOURCE = read("ui/src/pi/settings/pages/settingsWriteHooks.ts")

/* ------------------------------------------------------------------ */
/* 14 键映射                                                           */
/* ------------------------------------------------------------------ */

test("写桥白名单：21 键齐全且不重复；页面映射函数覆盖全部键", () => {
  assert.equal(write.SETTINGS_WRITE_KEYS.length, 21)
  assert.equal(new Set(write.SETTINGS_WRITE_KEYS).size, 21)
  assert.deepEqual(
    [...write.SETTINGS_WRITE_KEYS].sort(),
    [
      "compaction.enabled",
      "compaction.keepRecentTokens",
      "compaction.reserveTokens",
      "defaultModel",
      "defaultProjectTrust",
      "defaultProvider",
      "defaultThinkingLevel",
      "defaultTools",
      "enableInstallTelemetry",
      "enableSkillCommands",
      "enabledModels",
      "extensions",
      "followUpMode",
      "hideThinkingBlock",
      "images.autoResize",
      "images.blockImages",
      "modelThinkingLevels",
      "packages",
      "prompts",
      "skills",
      "steeringMode",
    ],
  )

  const patches = [
    write.steeringModePatch("all"),
    write.followUpModePatch("all"),
    write.compactionEnabledPatch(false),
    write.tokenBudgetPatch("reserveTokens", 16384),
    write.tokenBudgetPatch("keepRecentTokens", 20000),
    write.hideThinkingBlockPatch(true),
    write.defaultProjectTrustPatch("always"),
    write.installTelemetryPatch(false),
    write.skillCommandsPatch(false),
    write.blockImagesPatch(true),
    write.autoResizeImagesPatch(false),
    write.defaultThinkingLevelPatch("xhigh"),
    write.defaultModelPatch(" stepfun ", " step-5-preview "),
    write.enabledModelsPatch(["openai/gpt-5"]),
    write.defaultToolsPatch(["read", "bash"]),
    write.modelThinkingLevelsPatch({ "openai/gpt-5": "high" }),
    write.skillsPatch(["/path/to/skill"]),
    write.promptsPatch(["/path/to/prompt.md"]),
    write.extensionsPatch(["/path/to/ext.ts"]),
    write.packagesPatch(["npm:pkg"]),
  ].filter(Boolean)
  const keys = patches.flatMap((patch) => Object.keys(write.flattenSettingsPatch(patch)))
  for (const key of write.SETTINGS_WRITE_KEYS) assert.ok(keys.includes(key), `映射缺少 ${key}`)
})

test("写桥映射：投递 / 图片 / 开关 / 压缩 / 信任 / 思考等级", () => {
  assert.deepEqual(write.steeringModePatch("all"), { steeringMode: "all" })
  assert.deepEqual(write.followUpModePatch("one-at-a-time"), { followUpMode: "one-at-a-time" })
  assert.equal(write.steeringModePatch("together"), null, "无效投递模式不发请求")
  assert.deepEqual(write.autoResizeImagesPatch(false), { images: { autoResize: false } })
  assert.deepEqual(write.blockImagesPatch(true), { images: { blockImages: true } })
  assert.deepEqual(write.hideThinkingBlockPatch(true), { hideThinkingBlock: true })
  assert.deepEqual(write.compactionEnabledPatch(false), { compaction: { enabled: false } })
  assert.deepEqual(write.installTelemetryPatch(false), { enableInstallTelemetry: false })
  assert.deepEqual(write.skillCommandsPatch(false), { enableSkillCommands: false })
  assert.deepEqual(write.defaultProjectTrustPatch("never"), { defaultProjectTrust: "never" })
  assert.equal(write.defaultProjectTrustPatch("trusted"), null)
  for (const level of write.SETTINGS_THINKING_LEVELS) {
    assert.deepEqual(write.defaultThinkingLevelPatch(level), { defaultThinkingLevel: level })
  }
  assert.equal(write.defaultThinkingLevelPatch("nope"), null)
  assert.equal(write.defaultThinkingLevelPatch(""), null)
})

test("写桥映射：defaultProvider + defaultModel 成对；非负安全整数；空补丁不合法", () => {
  assert.deepEqual(write.defaultModelPatch("stepfun", "step-5-preview"), {
    defaultProvider: "stepfun",
    defaultModel: "step-5-preview",
  })
  assert.deepEqual(write.defaultModelPatch(" stepfun ", " step-5-preview "), {
    defaultProvider: "stepfun",
    defaultModel: "step-5-preview",
  })
  assert.equal(write.defaultModelPatch("stepfun", ""), null, "只给 provider → 不发（扩展会 bad_args）")
  assert.equal(write.defaultModelPatch("", "step-5-preview"), null)
  assert.equal(write.defaultModelPatch("stepfun", "x".repeat(201)), null)
  assert.equal(write.defaultModelPatch("step\nfun", "model"), null, "控制字符不发")

  assert.deepEqual(write.tokenBudgetPatch("reserveTokens", 0), { compaction: { reserveTokens: 0 } })
  assert.deepEqual(write.tokenBudgetPatch("keepRecentTokens", 20000), { compaction: { keepRecentTokens: 20000 } })
  assert.equal(write.tokenBudgetPatch("reserveTokens", -1), null)
  assert.equal(write.tokenBudgetPatch("reserveTokens", 1.5), null)
  assert.equal(write.tokenBudgetPatch("reserveTokens", Number.MAX_SAFE_INTEGER + 1), null)
  assert.equal(write.tokenBudgetPatch("reserveTokens", "16384"), null)

  assert.deepEqual(write.settingsSetArgs({ steeringMode: "all" }), { patch: { steeringMode: "all" } })
})

/* ------------------------------------------------------------------ */
/* get_settings 解析 / applied 乐观覆盖                                */
/* ------------------------------------------------------------------ */

test("get_settings 解析：{settings} 与裸对象；点号路径；读不到回 null", () => {
  const wrapped = {
    settings: {
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      hideThinkingBlock: true,
      defaultProvider: "stepfun",
      defaultModel: "step-5-preview",
      defaultThinkingLevel: "max",
      defaultProjectTrust: "always",
      enableInstallTelemetry: false,
      enableSkillCommands: false,
      images: { blockImages: true, autoResize: false },
      compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 20000 },
    },
  }
  assert.equal(write.settingsDocumentOf(wrapped).steeringMode, "all")
  assert.equal(write.settingsValueOf(wrapped, "images.blockImages"), true)
  assert.equal(write.settingsValueOf(wrapped, "compaction.reserveTokens"), 16384)
  assert.equal(write.settingsValueOf(wrapped, "images.nope"), undefined)
  assert.deepEqual(write.settingsDocumentOf(wrapped.settings), wrapped.settings, "裸设置对象也吃")
  assert.deepEqual(write.settingsDocumentOf(null), {})
  assert.deepEqual(write.settingsDocumentOf("nope"), {})
  assert.equal(write.isSettingsDocumentResponse(wrapped), true)
  assert.equal(write.isSettingsDocumentResponse({}), true)
  assert.equal(write.isSettingsDocumentResponse({ settings: {} }), true)
  assert.equal(write.isSettingsDocumentResponse(undefined), false, "空回包不能说成读到了空设置")
  assert.equal(write.isSettingsDocumentResponse(null), false)
  assert.equal(write.isSettingsDocumentResponse({ settings: [] }), false)

  assert.equal(write.effectiveSettingsBoolOf(wrapped, {}, "images.autoResize"), false)
  assert.equal(write.effectiveSettingsIntOf(wrapped, {}, "compaction.keepRecentTokens"), 20000)
  assert.equal(write.effectiveSettingsDeliveryModeOf(wrapped, {}, "steeringMode"), "all")
  // F6: with no explicit value anywhere, the effective default is pi's own
  // "one-at-a-time" -- the radios must render it as selected instead of
  // showing nothing selected.
  assert.equal(write.effectiveSettingsDeliveryModeOf({ settings: {} }, {}, "steeringMode"), "one-at-a-time")
  assert.equal(write.effectiveSettingsDeliveryModeOf({ settings: {} }, {}, "followUpMode"), "one-at-a-time")
  assert.equal(write.effectiveSettingsDeliveryModeOf(null, {}, "steeringMode"), "one-at-a-time")
  assert.equal(write.effectiveSettingsDeliveryModeOf({ settings: { followUpMode: "bogus" } }, {}, "followUpMode"), "one-at-a-time")
  assert.equal(write.SETTINGS_DELIVERY_MODE_DEFAULT, "one-at-a-time")
  assert.equal(write.effectiveProjectTrustOf(wrapped, {}), "always")
  assert.equal(write.effectiveSettingsBoolOf(wrapped, {}, "missing"), null)
  assert.equal(write.effectiveSettingsIntOf(wrapped, {}, "compaction.reserveTokens"), 16384)
})

test("applied 乐观覆盖：写成功后不回读旧 get_settings；嵌套 patch 摊平", () => {
  const data = { settings: { steeringMode: "one-at-a-time", images: { autoResize: true }, compaction: { enabled: true } } }
  const applied = write.flattenSettingsPatch({ images: { autoResize: false }, compaction: { enabled: false } })
  assert.deepEqual(applied, { "images.autoResize": false, "compaction.enabled": false })
  const next = write.mergeSettingsApplied({}, applied)
  assert.equal(write.effectiveSettingsBoolOf(data, next, "images.autoResize"), false)
  assert.equal(write.effectiveSettingsBoolOf(data, next, "compaction.enabled"), false)
  assert.equal(write.settingsValueOf(data, "images.autoResize"), true, "源数据不被改写")

  // 页面先捕获 optimistic 快照；失败时 hook 直接 setOptimistic(before) 回滚。
  const before = write.mergeSettingsApplied({}, { steeringMode: "all" })
  const optimistic = write.mergeSettingsApplied(before, write.flattenSettingsPatch(write.steeringModePatch("one-at-a-time")))
  assert.equal(optimistic.steeringMode, "one-at-a-time")
  assert.equal(before.steeringMode, "all", "before 快照保持原值")
  assert.match(HOOK_SOURCE, /setOptimistic\(before\)/, "写失败必须回到保存前快照")
})

test("缺键默认：pi schema 默认值可显示、可写，显式值优先", () => {
  const empty = { settings: {} }
  assert.equal(write.effectiveSettingsBoolOf(empty, {}, "enableSkillCommands"), true)
  assert.equal(write.effectiveSettingsBoolOf(empty, {}, "hideThinkingBlock"), false)
  assert.equal(write.effectiveSettingsBoolOf(empty, {}, "images.autoResize"), true)
  assert.equal(write.effectiveSettingsBoolOf(empty, {}, "enableInstallTelemetry"), true)
  assert.equal(write.effectiveSettingsBoolOf(empty, {}, "compaction.enabled"), true)
  assert.equal(write.effectiveSettingsIntOf(empty, {}, "compaction.reserveTokens"), 16384)
  assert.equal(write.effectiveSettingsIntOf(empty, {}, "compaction.keepRecentTokens"), 20000)

  // 缺键 ≠ 不可写：页面用 `value === null` 做 disabled 判断，这五项必须非 null。
  for (const path of [
    "enableSkillCommands",
    "hideThinkingBlock",
    "images.autoResize",
    "enableInstallTelemetry",
    "compaction.enabled",
    "compaction.reserveTokens",
    "compaction.keepRecentTokens",
  ]) {
    assert.notEqual(write.settingsDefaultValueOf(path), undefined, `${path} 缺默认值`)
    assert.notEqual(write.effectiveSettingsValue(empty, {}, path), undefined, `${path} 缺键仍是未知`)
  }
  // 技能总闸默认开 → Extensions 页有可写项；关闭时仍只 patch 该键。
  assert.equal(write.effectiveSettingsBoolOf(empty, {}, "enableSkillCommands"), true)
  assert.deepEqual(write.skillCommandsPatch(false), { enableSkillCommands: false })

  // 显式值（包括 false / 0）优先于默认值，不被默认值覆盖。
  const explicit = {
    settings: {
      enableSkillCommands: false,
      hideThinkingBlock: true,
      images: { autoResize: false },
      enableInstallTelemetry: false,
      compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
    },
  }
  assert.equal(write.effectiveSettingsBoolOf(explicit, {}, "enableSkillCommands"), false)
  assert.equal(write.effectiveSettingsBoolOf(explicit, {}, "hideThinkingBlock"), true)
  assert.equal(write.effectiveSettingsBoolOf(explicit, {}, "images.autoResize"), false)
  assert.equal(write.effectiveSettingsBoolOf(explicit, {}, "enableInstallTelemetry"), false)
  assert.equal(write.effectiveSettingsBoolOf(explicit, {}, "compaction.enabled"), false)
  assert.equal(write.effectiveSettingsIntOf(explicit, {}, "compaction.reserveTokens"), 0)
  assert.equal(write.effectiveSettingsIntOf(explicit, {}, "compaction.keepRecentTokens"), 0)

  // 没有默认值的键仍保持「未知」（不凭空造值）。
  assert.equal(write.effectiveSettingsBoolOf(empty, {}, "images.blockImages"), null)
  assert.equal(write.effectiveSettingsBoolOf(empty, {}, "missing"), null)
  assert.equal(write.settingsValueOf(empty, "enableSkillCommands"), undefined, "默认值只作用于显示，不改源数据")
})

test("overlay 回读：写成功持久化，重进页面优先显示已写入值", () => {
  const target = write.settingsOverlayTargetKey({ deviceId: "Mac", roomId: "pi-remote-e2e" })
  // 设置文件是设备级全局文件：同一设备换房间仍是同一个 overlay 目标；换设备隔离。
  assert.equal(
    target,
    write.settingsOverlayTargetKey({ deviceId: "Mac", roomId: "another-session" }),
    "同设备不同房间共享设备设置 overlay",
  )
  assert.notEqual(target, write.settingsOverlayTargetKey({ deviceId: "Other", roomId: "pi-remote-e2e" }))
  assert.notEqual(
    write.settingsOverlayTargetKey({ roomId: "r1" }),
    write.settingsOverlayTargetKey({ roomId: "r2" }),
    "没有设备时按房间隔离",
  )
  const written = { "images.blockImages": false, enableSkillCommands: false, "compaction.reserveTokens": 0 }
  const book = write.recordSettingsOverlayApplied({}, target, written, { writtenAt: 1234 })
  assert.deepEqual(write.settingsOverlayAppliedOf(book, target), written)

  // 模拟 localStorage 序列化 / 反序列化（离开页面再回来）。
  const restored = write.settingsOverlayBookOf(write.settingsOverlayEnvelopeOf(book))
  assert.deepEqual(restored, book)
  assert.deepEqual(write.settingsOverlayAppliedOf(restored, target), written)

  // 运行中的 pi 回读旧值，但页面读值 overlay 优先。
  const stale = { settings: { images: { blockImages: true }, enableSkillCommands: true, compaction: { reserveTokens: 16384 } } }
  const applied = write.settingsOverlayAppliedOf(restored, target)
  assert.equal(write.effectiveSettingsBoolOf(stale, applied, "images.blockImages"), false)
  assert.equal(write.effectiveSettingsBoolOf(stale, applied, "enableSkillCommands"), false)
  assert.equal(write.effectiveSettingsIntOf(stale, applied, "compaction.reserveTokens"), 0)
  // 没写过的键仍读 get_settings。
  assert.equal(write.effectiveSettingsBoolOf(stale, applied, "images.autoResize"), true)

  // 只接受写桥白名单里的合法值；坏 JSON / 脏键不显示。
  assert.deepEqual(
    write.settingsOverlayBookOf(JSON.stringify({ v: 1, entries: { [target]: { applied: { evil: true } } } })),
    {},
  )
  assert.deepEqual(write.settingsOverlayBookOf("not json"), {})
  assert.deepEqual(write.settingsOverlayBookOf(null), {})
  assert.deepEqual(
    write.settingsOverlayBookOf('{"v":1,"entries":{"__proto__":{"applied":{"enableSkillCommands":false}}}}'),
    {},
    "不让脏目标键污染对象原型",
  )
  assert.deepEqual(
    write.recordSettingsOverlayApplied({}, target, { "images.blockImages": "no", "compaction.reserveTokens": -1 }),
    {},
  )
})

test("overlay 收敛：运行中旧值保留，get_settings 新值 / 默认值 / 版本变化后清除", () => {
  const target = write.settingsOverlayTargetKey({ deviceId: "Mac" })
  const stillOld = { settings: { enableSkillCommands: true, hideThinkingBlock: false } }
  let book = write.recordSettingsOverlayApplied({}, target, { enableSkillCommands: false })
  let result = write.reconcileSettingsOverlay({ book, target, data: stillOld })
  assert.deepEqual(result.pending, ["enableSkillCommands"], "运行中的 pi 仍是旧值 → 保留 overlay")
  assert.deepEqual(result.cleared, [])
  assert.equal(result.book, book, "没有变化时不制造新引用")

  // 重启 pi 后 get_settings 返回新值 → 该键收敛清除。
  result = write.reconcileSettingsOverlay({ book, target, data: { settings: { enableSkillCommands: false } } })
  assert.deepEqual(result.cleared, ["enableSkillCommands"])
  assert.deepEqual(result.pending, [])
  assert.deepEqual(result.book, {}, "全部收敛后删掉该目标的 overlay")

  // 写入值恰好等于 pi 默认值、get_settings 缺键 → 也视为已生效。
  book = write.recordSettingsOverlayApplied({}, target, { enableSkillCommands: true, hideThinkingBlock: false })
  result = write.reconcileSettingsOverlay({ book, target, data: { settings: {} } })
  assert.deepEqual(result.cleared.sort(), ["enableSkillCommands", "hideThinkingBlock"])

  // 非默认值 + get_settings 缺键 → 仍待重启（不能把缺键误判成已收敛）。
  book = write.recordSettingsOverlayApplied({}, target, { enableSkillCommands: false })
  result = write.reconcileSettingsOverlay({ book, target, data: { settings: {} } })
  assert.deepEqual(result.pending, ["enableSkillCommands"])

  // 部分收敛：只保留未收敛的键。
  book = write.recordSettingsOverlayApplied({}, target, { enableSkillCommands: false, hideThinkingBlock: true })
  result = write.reconcileSettingsOverlay({
    book,
    target,
    data: { settings: { enableSkillCommands: false, hideThinkingBlock: false } },
  })
  assert.deepEqual(result.cleared, ["enableSkillCommands"])
  assert.deepEqual(result.pending, ["hideThinkingBlock"])
  assert.deepEqual(result.book[target].applied, { hideThinkingBlock: true })

  // 扩展 / pi 版本变化 → 整条作废。
  book = write.recordSettingsOverlayApplied({}, target, { enableSkillCommands: false }, { hostVersion: "pi:1.3.0|ext:4.0.0" })
  result = write.reconcileSettingsOverlay({
    book,
    target,
    data: stillOld,
    hostVersion: "pi:1.3.0|ext:4.0.1",
  })
  assert.equal(result.versionChanged, true)
  assert.deepEqual(result.cleared, ["enableSkillCommands"])
  assert.deepEqual(result.book, {})

  // 同版本：保留 pending 并记下版本，供下次比较。
  result = write.reconcileSettingsOverlay({
    book,
    target,
    data: stillOld,
    hostVersion: "pi:1.3.0|ext:4.0.0",
  })
  assert.equal(result.versionChanged, false)
  assert.deepEqual(result.pending, ["enableSkillCommands"])
  assert.equal(result.book[target].hostVersion, "pi:1.3.0|ext:4.0.0")

  assert.equal(write.settingsHostVersionOf({ piVersion: "1.3.0", extensionVersion: "4.0.0" }), "pi:1.3.0|ext:4.0.0")
  assert.equal(write.settingsHostVersionOf({}), "")
  assert.equal(write.settingsReadErrorOf({ settings: {}, error: "boom" }), "boom")
  assert.equal(write.settingsReadErrorOf({ settings: {} }), "")
})

/* ------------------------------------------------------------------ */
/* 成功回包 / 失败码                                                   */
/* ------------------------------------------------------------------ */

test("settings_set 成功回包：applied 点号扁平、restartRequired、reloadHint；坏回包不冒充成功", () => {
  const result = write.settingsSetResultOf({
    ok: true,
    applied: { steeringMode: "all", "compaction.reserveTokens": 16384 },
    restartRequired: true,
    restartReason: "运行中的 pi 从内存读取设置",
    reloadHint: "重启 pi 后生效。在本机 TUI 执行 /reload 会重载设置与扩展。",
  })
  assert.deepEqual(result, {
    ok: true,
    applied: { steeringMode: "all", "compaction.reserveTokens": 16384 },
    restartRequired: true,
    restartReason: "运行中的 pi 从内存读取设置",
    reloadHint: "重启 pi 后生效。在本机 TUI 执行 /reload 会重载设置与扩展。",
  })
  assert.equal(write.SETTINGS_WRITE_OK_TEXT, "已保存，重启 pi 后生效")
  assert.match(write.SETTINGS_WRITE_RELOAD_FALLBACK, /重启 pi 后生效/)
  assert.match(write.SETTINGS_WRITE_RELOAD_FALLBACK, /\/reload/)

  // 嵌套 applied 也兼容；缺 restartReason / reloadHint 不编造。
  assert.deepEqual(write.settingsSetResultOf({ ok: true, applied: { compaction: { enabled: false } } }).applied, {
    "compaction.enabled": false,
  })
  const minimal = write.settingsSetResultOf({ ok: true })
  assert.equal(minimal.restartRequired, false)
  assert.equal(minimal.restartReason, "")
  assert.equal(minimal.reloadHint, "")

  for (const bad of [null, undefined, {}, { ok: false }, { ok: "true" }, "ok", []]) {
    assert.equal(write.settingsSetResultOf(bad), null, `坏回包不能当成功：${JSON.stringify(bad)}`)
  }
})

test("失败分类：旧扩展 unknown_command → 需更新扩展；离线 / bad_args / internal / 结果未知", () => {
  const unsupported = write.settingsFailureOf(Object.assign(new Error("未知命令：settings_set"), { code: "unknown_command" }))
  assert.equal(unsupported.kind, "unsupported")
  assert.match(unsupported.text, /需更新扩展/)
  assert.equal(write.settingsFailureOf(Object.assign(new Error("x"), { code: "unsupported" })).kind, "unsupported")
  assert.equal(write.settingsFailureOf(Object.assign(new Error("x"), { code: "unknown_type" })).kind, "unsupported")

  for (const code of ["device_offline", "room_offline", "no_room", "not_loaded"]) {
    const failure = write.settingsFailureOf(Object.assign(new Error("x"), { code }))
    assert.equal(failure.kind, "offline")
    assert.equal(failure.text, "需设备在线")
  }

  const badArgs = write.settingsFailureOf(Object.assign(new Error("bad"), { code: "bad_args" }))
  assert.equal(badArgs.kind, "bad_args")
  assert.match(badArgs.text, /未写入/)
  const internal = write.settingsFailureOf(Object.assign(new Error("disk"), { code: "internal" }))
  assert.equal(internal.kind, "internal")
  assert.match(internal.text, /未修改/)
  const unknown = write.settingsFailureOf(Object.assign(new Error("lost"), { code: "result_unknown" }))
  assert.equal(unknown.kind, "unknown_result")
  assert.match(unknown.text, /重启 pi 后确认/)

  const plain = write.settingsFailureOf(new Error("网络断了"))
  assert.equal(plain.kind, "error")
  assert.equal(plain.text, "网络断了")
  assert.equal(write.settingsFailureOf(null).kind, "error")
  assert.equal(write.settingsFailureOf(null).text, "保存失败")
})

test("只读原因：离线 / 读失败 / 扩展不支持 / 正在读取；能写时无提示", () => {
  assert.equal(write.settingsReadOnlyHintOf({ ready: false, phase: "idle" }), "需设备在线")
  assert.equal(write.settingsReadOnlyHintOf({ ready: true, phase: "loading" }), "正在读取设备设置…")
  assert.equal(
    write.settingsReadOnlyHintOf({
      ready: true,
      phase: "error",
      failure: write.settingsFailureOf(Object.assign(new Error("x"), { code: "unknown_command" })),
    }),
    write.SETTINGS_WRITE_UNSUPPORTED_TEXT,
  )
  assert.equal(
    write.settingsReadOnlyHintOf({
      ready: true,
      phase: "error",
      failure: write.settingsFailureOf(Object.assign(new Error("x"), { code: "device_offline" })),
    }),
    "需设备在线",
  )
  assert.equal(write.settingsReadOnlyHintOf({ ready: true, phase: "error" }), write.SETTINGS_WRITE_READ_FAILED_TEXT)
  assert.equal(write.settingsReadOnlyHintOf({ ready: true, phase: "ready" }), null)
  assert.equal(
    write.settingsReadOnlyHintOf({ ready: true, phase: "ready", unsupported: true }),
    write.SETTINGS_WRITE_UNSUPPORTED_TEXT,
  )
})

/* ------------------------------------------------------------------ */
/* 保存调用 / 页面接线                                                  */
/* ------------------------------------------------------------------ */

test("保存调用：唯一入口是 settings_set + { patch }，成功后显示重启提示", () => {
  assert.match(HOOK_SOURCE, /settingsRunCommand\(relayRef\.current, "settings_set", settingsSetArgs\(patch\)\)/)
  assert.match(HOOK_SOURCE, /setFeedback\(\{[\s\S]*SETTINGS_WRITE_OK_TEXT/)
  assert.match(HOOK_SOURCE, /result\.reloadHint \|\| SETTINGS_WRITE_RELOAD_FALLBACK/)
  assert.match(HOOK_SOURCE, /settingsSetResultOf\(data\)/)
  assert.match(HOOK_SOURCE, /settingsFailureOf\(error\)/)
  assert.match(HOOK_SOURCE, /useSettingsDocument/)
  assert.match(HOOK_SOURCE, /run\("get_settings"\)/)
  // 重进页面后：overlay 非空时显示「已写入待重启」，不是静默旧值。
  assert.match(HOOK_SOURCE, /writer\.pendingRestart \? SETTINGS_WRITE_PENDING_RESTART_TEXT : null/)
  // overlay 只写独立键；本机偏好（SETTINGS_STORAGE_KEY）仍归 SettingsContext。
  assert.match(HOOK_SOURCE, /SETTINGS_OVERLAY_STORAGE_KEY/)
  assert.doesNotMatch(stripComments(HOOK_SOURCE), /SETTINGS_STORAGE_KEY/, "设备设置不能写本机偏好")
  // bad_args / 离线等失败路径绝不把乐观值写进 overlay。
  const catchStart = HOOK_SOURCE.indexOf("} catch (error: unknown)")
  const catchEnd = HOOK_SOURCE.indexOf("} finally", catchStart)
  assert.ok(catchStart > 0 && catchEnd > catchStart, "找不到写失败分支")
  assert.doesNotMatch(
    HOOK_SOURCE.slice(catchStart, catchEnd),
    /commitOverlayApplied|recordSettingsOverlayApplied/,
    "写失败不能写 overlay",
  )
})

test("桌面五页：可写项都走 useSettingsWriter；不再拿 get_state 冒充设置值", () => {
  const expected = {
    GeneralPage: ["useSettingsWriter", "steeringModePatch", "followUpModePatch", "autoResizeImagesPatch", "SettingsWriteNote"],
    ModelPage: [
      "useSettingsWriter",
      "defaultModelPatch",
      "defaultThinkingLevelPatch",
      "hideThinkingBlockPatch",
      "compactionEnabledPatch",
      "tokenBudgetPatch",
      "SettingsWriteNote",
    ],
    PrivacyPage: ["useSettingsWriter", "installTelemetryPatch", "blockImagesPatch", "SettingsWriteNote"],
    ExtensionsPage: ["useSettingsWriter", "skillCommandsPatch", "SettingsWriteNote"],
    ApprovalPage: ["useSettingsWriter", "defaultProjectTrustPatch", "SettingsWriteNote"],
  }
  for (const [name, needles] of Object.entries(expected)) {
    const source = DESKTOP_PAGES[name]
    for (const needle of needles) assert.ok(source.includes(needle), `${name} 缺 ${needle}`)
    assert.match(source, /useSettingsDocument/, `${name} 值必须从 get_settings 读`)
    assert.doesNotMatch(
      source,
      /setPref\("(steeringMode|followUpMode|enableInstallTelemetry|enableSkillCommands|defaultProjectTrust|defaultModel|defaultThinkingLevel|hideThinkingBlock|compaction)/,
      `${name} 不得把设备设置写进本机偏好`,
    )
  }
  assert.doesNotMatch(DESKTOP_PAGES.GeneralPage, /get_state/, "投递值已改读 get_settings，不用当前会话状态冒充")
  assert.doesNotMatch(DESKTOP_PAGES.ModelPage, /get_state/, "自动压缩已改读 compaction.enabled")
  assert.doesNotMatch(DESKTOP_PAGES.PrivacyPage, /runCommand\("get_settings"\)/, "读取统一走 useSettingsDocument")
  assert.doesNotMatch(DESKTOP_PAGES.ExtensionsPage, /runCommand\("get_settings"\)/)
  // 项目信任的「当前项目状态」仍来自 get_state；默认策略来自 get_settings。
  assert.match(DESKTOP_PAGES.ApprovalPage, /get_state/)
})

test("桌面五页：保存中禁用、成功 / 失败反馈、未开放项标原因", () => {
  for (const [name, source] of Object.entries(DESKTOP_PAGES)) {
    assert.match(source, /writer\.saving !== null/, `${name} 保存中必须禁用`)
    assert.match(source, /writeDisabled|trustWriteDisabled/, `${name} 需要统一禁用态`)
  }
  // 模型页：默认模型成对、压缩三键、新会话两项写本机偏好。
  assert.match(DESKTOP_PAGES.ModelPage, /defaultModelPatch\(choice\.provider, choice\.modelId\)/)
  assert.match(DESKTOP_PAGES.ModelPage, /tokenBudgetPatch\("reserveTokens"/)
  assert.match(DESKTOP_PAGES.ModelPage, /tokenBudgetPatch\("keepRecentTokens"/)
  assert.match(DESKTOP_PAGES.ModelPage, /act\.setPref\("newSessionMode"/)
  assert.match(DESKTOP_PAGES.ModelPage, /act\.setPref\("newSessionAutoTitle"/)
  assert.doesNotMatch(DESKTOP_PAGES.ModelPage, /SETTINGS_WRITE_REMAINING_READONLY_NOTE/, "已移除底部冗余只读注释")
  // 扩展页：技能斜杠总闸、skills/prompts/extensions/packages 写桥与 MCP 增删改启停均已接入。
  assert.match(DESKTOP_PAGES.ExtensionsPage, /skillsPatch/)
  assert.match(DESKTOP_PAGES.ExtensionsPage, /promptsPatch/)
  assert.match(DESKTOP_PAGES.ExtensionsPage, /extensionsPatch/)
  assert.match(DESKTOP_PAGES.ExtensionsPage, /packagesPatch/)
  assert.equal((DESKTOP_PAGES.ExtensionsPage.match(/status="bridge"/g) ?? []).length, 0)
  // 审批页：策略与工具已接入读写，已移除死预留开关。
  assert.match(DESKTOP_PAGES.ApprovalPage, /defaultProjectTrustPatch/)
  assert.match(DESKTOP_PAGES.ApprovalPage, /approvalScope/)
  assert.equal((DESKTOP_PAGES.ApprovalPage.match(/status="reserved"/g) ?? []).length, 0)
})

test("手机五页：同样接线、同样写桥与预留边界清楚", () => {
  const expected = {
    GeneralPage: ["useSettingsWriter", "steeringModePatch", "followUpModePatch", "autoResizeImagesPatch", "MobileSettingsWriteNote"],
    ModelPage: ["useSettingsWriter", "defaultModelPatch", "defaultThinkingLevelPatch", "hideThinkingBlockPatch", "compactionEnabledPatch", "tokenBudgetPatch", "MobileSettingsWriteNote"],
    PrivacyPage: ["useSettingsWriter", "installTelemetryPatch", "blockImagesPatch", "MobileSettingsWriteNote"],
    ExtensionsPage: ["useSettingsWriter", "skillCommandsPatch", "skillsPatch", "promptsPatch", "extensionsPatch", "packagesPatch", "MobileSettingsWriteNote"],
    ApprovalPage: ["useSettingsWriter", "defaultProjectTrustPatch", "defaultToolsPatch", "MobileSettingsWriteNote"],
  }
  for (const [name, needles] of Object.entries(expected)) {
    const source = MOBILE_PAGES[name]
    for (const needle of needles) assert.ok(source.includes(needle), `手机 ${name} 缺 ${needle}`)
    assert.match(source, /useSettingsDocument/, `手机 ${name} 值必须从 get_settings 读`)
    assert.doesNotMatch(
      source,
      /setPref\("(steeringMode|followUpMode|enableInstallTelemetry|enableSkillCommands|defaultProjectTrust|defaultModel|defaultThinkingLevel|hideThinkingBlock|compaction)/,
      `手机 ${name} 不得把设备设置写进本机偏好`,
    )
    if (name !== "ApprovalPage") assert.doesNotMatch(source, /get_state/, `手机 ${name} 不再用 get_state 冒充设置值`)
  }
  assert.match(MOBILE_PAGES.ModelPage, /act\.setPref\("newSessionMode"/)
  assert.match(MOBILE_PAGES.ModelPage, /act\.setPref\("newSessionAutoTitle"/)
  assert.equal((MOBILE_PAGES.ExtensionsPage.match(/status="bridge"/g) ?? []).length, 0)
  assert.equal((MOBILE_PAGES.ApprovalPage.match(/status="reserved"/g) ?? []).length, 0)
})

/* ------------------------------------------------------------------ */
/* 新增写桥字段、设备直连路由与页面纯逻辑单元测试                         */
/* ------------------------------------------------------------------ */

const modelData = await import("../ui/src/pi/settings/pages/modelData.ts")
const approvalData = await import("../ui/src/pi/settings/pages/approvalData.ts")
const deviceBehavior = await import("../ui/src/pi/settings/pages/deviceBehavior.ts")
const extensionsLogic = await import("../ui/src/pi/settings/pages/extensionsLogic.ts")

test("新增写桥映射：enabledModels / defaultTools / modelThinkingLevels 校验与读取覆盖", () => {
  assert.deepEqual(write.enabledModelsPatch(["openai/gpt-5", " openai/gpt-5 "]), { enabledModels: ["openai/gpt-5"] })
  assert.deepEqual(write.enabledModelsPatch(null), { enabledModels: null })
  assert.equal(write.enabledModelsPatch(["bad\nline"]), null, "含控制字符拒绝生成 patch")

  assert.deepEqual(write.defaultToolsPatch(["read", "bash", "read"]), { defaultTools: ["read", "bash"] })
  assert.deepEqual(write.defaultToolsPatch(null), { defaultTools: null })
  assert.equal(write.defaultToolsPatch([""]), null, "空工具名拒绝生成 patch")

  assert.deepEqual(write.modelThinkingLevelsPatch({ "openai/gpt-5": "xhigh", "empty/model": null }), {
    modelThinkingLevels: { "openai/gpt-5": "xhigh" },
  })
  assert.deepEqual(write.modelThinkingLevelsPatch(null), { modelThinkingLevels: null })
  assert.equal(
    write.modelThinkingLevelsPatch(JSON.parse('{"__proto__":"high"}')),
    null,
    "原型污染键拒绝生成 patch",
  )
  assert.equal(write.modelThinkingLevelsPatch({ "openai/gpt-5": "ultra" }), null, "非法思考档位拒绝生成 patch")

  const doc = {
    settings: {
      enabledModels: ["openai/gpt-5"],
      defaultTools: ["read", "grep"],
      modelThinkingLevels: { "openai/gpt-5": "medium" },
    },
  }
  assert.deepEqual(write.effectiveSettingsArrayOf(doc, {}, "enabledModels"), ["openai/gpt-5"])
  assert.deepEqual(write.effectiveSettingsArrayOf(doc, { enabledModels: ["custom/a"] }, "enabledModels"), ["custom/a"])
  assert.deepEqual(write.effectiveSettingsArrayOf(doc, {}, "defaultTools"), ["read", "grep"])
  assert.deepEqual(write.effectiveModelThinkingLevelsOf(doc, { modelThinkingLevels: { "custom/a": "high" } }), {
    "custom/a": "high",
  })
})

test("设备直连路由：settingsCommandsReady 与 settingsRunCommand（房间 / 零房间设备直连 / 防休眠直连）", async () => {
  const calls = []
  const relayWithRoom = {
    authed: true,
    browserOnline: true,
    online: true,
    roomId: "r1",
    selectedDeviceId: "dev1",
    devices: [{ id: "dev1", online: true }],
    rooms: [{ id: "r1", deviceId: "dev1" }],
    runCommand: async (command, args) => {
      calls.push(["room", command, args])
      return { via: "room", command }
    },
    runDeviceCommand: async (deviceId, command, args) => {
      calls.push(["device", deviceId, command, args])
      return { via: "device", deviceId, command }
    },
  }
  assert.equal(write.settingsCommandsReady(relayWithRoom), true)
  await write.settingsRunCommand(relayWithRoom, "get_settings")
  await write.settingsRunCommand(relayWithRoom, "set_prevent_sleep", { enabled: true })
  assert.deepEqual(calls[0], ["room", "get_settings", undefined])
  assert.deepEqual(calls[1], ["device", "dev1", "set_prevent_sleep", { enabled: true }])

  calls.length = 0
  const relayDeviceOnly = {
    authed: true,
    browserOnline: true,
    online: false,
    roomId: null,
    selectedDeviceId: "dev2",
    devices: [{ id: "dev2", online: true }],
    rooms: [],
    runCommand: async () => {
      throw new Error("should not route to room when room is absent")
    },
    runDeviceCommand: async (deviceId, command, args) => {
      calls.push(["device", deviceId, command, args])
      return { ok: true }
    },
  }
  assert.equal(write.settingsCommandsReady(relayDeviceOnly), true)
  await write.settingsRunCommand(relayDeviceOnly, "get_models_config")
  assert.deepEqual(calls, [["device", "dev2", "get_models_config", undefined]])

  const relayOffline = {
    authed: true,
    browserOnline: true,
    online: false,
    roomId: null,
    selectedDeviceId: "dev3",
    devices: [{ id: "dev3", online: false }],
    runDeviceCommand: async () => ({}),
  }
  assert.equal(write.settingsCommandsReady(relayOffline), false)
  await assert.rejects(() => write.settingsRunCommand(relayOffline, "get_settings"), { code: "device_offline" })
})

test("modelData：modelsConfigOf / providerRowsOf 自定义合并 / toggledEnabledModelsOf", () => {
  const cfg = modelData.modelsConfigOf({
    providers: [
      {
        id: "custom-proxy",
        name: "My Proxy",
        baseUrl: "https://proxy.example.com/v1/",
        inModelsJson: true,
        inAuthJson: false,
        hasApiKey: true,
        apiKeyHint: "sk-***",
        models: [{ id: "deepseek-v4", reasoning: true, contextWindow: 128000 }],
      },
    ],
  })
  assert.equal(cfg.length, 1)
  assert.equal(cfg[0].id, "custom-proxy")
  assert.equal(cfg[0].models[0].id, "deepseek-v4")

  const rows = modelData.providerRowsOf(
    { providers: [] },
    { models: [], available: [] },
    { "custom-proxy/deepseek-v4": "高" },
    {
      providers: [
        {
          id: "custom-proxy",
          name: "My Proxy",
          baseUrl: "https://proxy.example.com/v1/",
          inModelsJson: true,
          inAuthJson: true,
          hasApiKey: true,
          models: [
            { id: "deepseek-v4", reasoning: true },
            { id: "qwen-coder", reasoning: false },
          ],
        },
      ],
    },
    ["custom-proxy/deepseek-v4"],
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].state, "connected")
  assert.equal(rows[0].endpoint, "proxy.example.com/v1")
  assert.equal(rows[0].models[0].enabled, true)
  assert.equal(rows[0].models[0].thinking, "高")
  assert.equal(rows[0].models[1].enabled, false)

  assert.deepEqual(
    modelData.toggledEnabledModelsOf(rows, null, "custom-proxy/qwen-coder", true),
    ["custom-proxy/deepseek-v4", "custom-proxy/qwen-coder"],
  )
  assert.deepEqual(
    modelData.toggledEnabledModelsOf(rows, ["custom-proxy/deepseek-v4", "qwen-coder"], "custom-proxy/qwen-coder", false),
    ["custom-proxy/deepseek-v4"],
  )
})

test("approvalData：approvalDefaultToolRowsOf 默认 6 工具与自定义配置", () => {
  const defaults = approvalData.approvalDefaultToolRowsOf(null)
  assert.deepEqual(defaults.enabled, ["read", "bash", "edit", "write", "grep", "ls"])
  assert.equal(defaults.rows.find((r) => r.id === "read")?.enabled, true)
  assert.equal(defaults.rows.find((r) => r.id === "codemode")?.enabled, false)

  const custom = approvalData.approvalDefaultToolRowsOf(["read", "codemode"])
  assert.equal(custom.rows.find((r) => r.id === "read")?.enabled, true)
  assert.equal(custom.rows.find((r) => r.id === "bash")?.enabled, false)
  assert.equal(custom.rows.find((r) => r.id === "codemode")?.enabled, true)
})

test("deviceBehavior：parsePreventSleepData 与 preventSleepViewOf 状态推导", () => {
  assert.equal(deviceBehavior.parsePreventSleepData(null), null)
  const parsed = deviceBehavior.parsePreventSleepData({
    supported: true,
    enabled: true,
    active: true,
    tool: " caffeinate ",
  })
  assert.deepEqual(parsed, { supported: true, enabled: true, active: true, tool: "caffeinate" })

  const activeView = deviceBehavior.preventSleepViewOf({
    ready: true,
    phase: "ready",
    state: parsed,
    saving: false,
  })
  assert.equal(activeView.checked, true)
  assert.equal(activeView.disabled, false)
  assert.match(activeView.description, /caffeinate/)

  const unsupportedView = deviceBehavior.preventSleepViewOf({
    ready: true,
    phase: "ready",
    state: { supported: false, enabled: false, active: false, tool: null },
    saving: false,
  })
  assert.equal(unsupportedView.disabled, true)
  assert.match(unsupportedView.description, /暂不支持/)

  const offlineView = deviceBehavior.preventSleepViewOf({
    ready: false,
    phase: "idle",
    state: null,
    saving: false,
  })
  assert.equal(offlineView.disabled, true)
  assert.match(offlineView.description, /需默认设备在线后读写/)
})

test("extensionsLogic：splitCommandArgs 与 formatCommandArgs 引号及转义往返", () => {
  const parsed = extensionsLogic.splitCommandArgs(`--root "/path/with spaces" --label 'a b' --quote "hi \\"mcp\\"" ""`)
  assert.deepEqual(parsed, ["--root", "/path/with spaces", "--label", "a b", "--quote", 'hi "mcp"', ""])
  const formatted = extensionsLogic.formatCommandArgs(parsed)
  assert.deepEqual(extensionsLogic.splitCommandArgs(formatted), parsed)
  assert.equal(extensionsLogic.formatCommandArgs([]), "")
})
