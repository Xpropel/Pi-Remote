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

test("写桥白名单：14 键齐全且不重复；页面映射函数覆盖全部键", () => {
  assert.equal(write.SETTINGS_WRITE_KEYS.length, 14)
  assert.equal(new Set(write.SETTINGS_WRITE_KEYS).size, 14)
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
      "enableInstallTelemetry",
      "enableSkillCommands",
      "followUpMode",
      "hideThinkingBlock",
      "images.autoResize",
      "images.blockImages",
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
  assert.match(HOOK_SOURCE, /runCommand\("settings_set", settingsSetArgs\(patch\)\)/)
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
  // 模型页：默认模型成对、压缩三键；新会话仍只读且写明原因。
  assert.match(DESKTOP_PAGES.ModelPage, /defaultModelPatch\(choice\.provider, choice\.modelId\)/)
  assert.match(DESKTOP_PAGES.ModelPage, /tokenBudgetPatch\("reserveTokens"/)
  assert.match(DESKTOP_PAGES.ModelPage, /tokenBudgetPatch\("keepRecentTokens"/)
  assert.match(DESKTOP_PAGES.ModelPage, /没有新会话默认模式 \/ 自动生成标题字段/)
  assert.match(DESKTOP_PAGES.ModelPage, /SETTINGS_WRITE_REMAINING_READONLY_NOTE/)
  // 扩展页：只有总闸可写，清单写入仍标只读。
  assert.match(DESKTOP_PAGES.ExtensionsPage, /资源清单写入未开放|写桥白名单只有总闸/)
  // 审批页：默认信任可写，四个预留组仍不可写。
  assert.match(DESKTOP_PAGES.ApprovalPage, /写桥只开放了「项目信任默认」/)
  assert.ok((DESKTOP_PAGES.ApprovalPage.match(/status="reserved"/g) ?? []).length >= 4)
})

test("手机五页：同样接线、同样不写 localStorage、同样标未开放原因", () => {
  const expected = {
    GeneralPage: ["useSettingsWriter", "steeringModePatch", "followUpModePatch", "autoResizeImagesPatch", "MobileSettingsWriteNote"],
    ModelPage: ["useSettingsWriter", "defaultModelPatch", "defaultThinkingLevelPatch", "hideThinkingBlockPatch", "compactionEnabledPatch", "tokenBudgetPatch", "MobileSettingsWriteNote"],
    PrivacyPage: ["useSettingsWriter", "installTelemetryPatch", "blockImagesPatch", "MobileSettingsWriteNote"],
    ExtensionsPage: ["useSettingsWriter", "skillCommandsPatch", "MobileSettingsWriteNote"],
    ApprovalPage: ["useSettingsWriter", "defaultProjectTrustPatch", "MobileSettingsWriteNote"],
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
  assert.match(MOBILE_PAGES.ModelPage, /没有新会话默认模式 \/ 自动生成标题字段/)
  assert.match(MOBILE_PAGES.ExtensionsPage, /写桥白名单只有技能总闸/)
  assert.match(MOBILE_PAGES.ApprovalPage, /没有对应的 pi 设置字段/)
})
