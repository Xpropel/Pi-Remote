// Pi-Remote 设置页 v2 · 第二阶段三页（通用补强 / 模型与会话 / 审批与执行）契约测试。
// 纯 Node：纯函数直接 import .ts，页面用静态文案守卫（不加载 tsx）。
// 守卫：设计册 §3/§4/§5 的逐条文案、●/◐/◌ 状态形态、真实命令接线、
//       页面不写 localStorage / 不写字面色值 / 不再用占位组件。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/g

const modelData = await import("../ui/src/pi/settings/pages/modelData.ts")
const approvalData = await import("../ui/src/pi/settings/pages/approvalData.ts")

const PAGES = {
  general: read("ui/src/pi/settings/pages/GeneralPage.tsx"),
  model: read("ui/src/pi/settings/pages/ModelPage.tsx"),
  approval: read("ui/src/pi/settings/pages/ApprovalPage.tsx"),
}
const MODEL_DATA_SOURCE = read("ui/src/pi/settings/pages/modelData.ts")
const APPROVAL_DATA_SOURCE = read("ui/src/pi/settings/pages/approvalData.ts")

/* ------------------------------------------------------------------ */
/* §4 模型与会话                                                        */
/* ------------------------------------------------------------------ */

test("模型页：默认思考等级七档文案与映射（不写死档位，只做中文标签）", () => {
  assert.deepEqual([...modelData.MODEL_THINKING_LEVELS], ["off", "minimal", "low", "medium", "high", "xhigh", "max"])
  assert.equal(modelData.MODEL_THINKING_LEVELS_COPY, "共七档：关 / 最小 / 低 / 中 / 高 / 超高 / 最高")
  assert.deepEqual(modelData.MODEL_THINKING_LEVEL_LABELS, {
    off: "关",
    minimal: "最小",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高",
    max: "最高",
  })
  for (const level of modelData.MODEL_THINKING_LEVELS) {
    assert.equal(modelData.thinkingLevelLabelOf(level), modelData.MODEL_THINKING_LEVEL_LABELS[level])
  }
  assert.equal(modelData.thinkingLevelLabelOf("max"), "最高")
  assert.equal(modelData.thinkingLevelLabelOf("nope"), null)
  assert.equal(modelData.thinkingLevelLabelOf(undefined), null)
})

test("模型页：get_settings 解析（默认模型 / 默认思考 / hideThinkingBlock / compaction / 每模型档位）", () => {
  const empty = modelData.modelSettingsOf(undefined)
  assert.deepEqual(empty, {
    defaultModel: null,
    defaultProvider: null,
    defaultThinkingLevel: null,
    showThinking: true,
    reserveTokens: null,
    keepRecentTokens: null,
    modelThinkingLevels: {},
  })

  const view = modelData.modelSettingsOf({
    settings: {
      defaultModel: "step-5-preview",
      defaultProvider: "stepfun",
      defaultThinkingLevel: "max",
      hideThinkingBlock: true,
      modelThinkingLevels: { "stepfun/step-5-preview": "max", "stepfun/step-3.7-flash": "high", "stepfun/bad": "nope" },
      compaction: { reserveTokens: 16384, keepRecentTokens: 20000 },
    },
  })
  assert.equal(view.defaultModel, "step-5-preview")
  assert.equal(view.defaultProvider, "stepfun")
  assert.equal(view.defaultThinkingLevel, "最高")
  assert.equal(view.showThinking, false, "hideThinkingBlock=true → 显示思考过程关")
  assert.equal(view.reserveTokens, 16384)
  assert.equal(view.keepRecentTokens, 20000)
  assert.deepEqual(view.modelThinkingLevels, { "stepfun/step-5-preview": "最高", "stepfun/step-3.7-flash": "高" })

  // 裸设置对象也吃；坏类型不冒充
  const bare = modelData.modelSettingsOf({ defaultThinkingLevel: "medium", compaction: { reserveTokens: -1 } })
  assert.equal(bare.defaultThinkingLevel, "中")
  assert.equal(bare.reserveTokens, null)
  assert.equal(bare.showThinking, true)
})

test("模型页：供应商卡（登录状态 / 接口地址 / 模型可用 / 每模型思考 / 未知名状）", () => {
  const providers = modelData.providerRowsOf(
    {
      providers: [
        { id: "stepfun", displayName: "StepFun", configured: true, authSource: "models_json_key" },
        { id: "anthropic", configured: false },
        { id: "ghost" },
      ],
    },
    {
      models: [
        { provider: "stepfun", id: "step-5-preview", baseUrl: "https://api.stepfun.com/v1/" },
        { provider: "stepfun", modelId: "step-3.7-flash", baseUrl: "https://api.stepfun.com/v1" },
        { provider: "anthropic", id: "claude-sonnet-4-5" },
        { provider: "extra", id: "mystery" },
      ],
      available: [{ provider: "stepfun", id: "step-5-preview" }],
    },
    { "stepfun/step-5-preview": "最高" },
  )

  assert.deepEqual(providers.map((provider) => provider.id), ["stepfun", "anthropic", "ghost", "extra"])
  assert.deepEqual(providers.map((provider) => provider.state), ["connected", "disconnected", "unknown", "unknown"])
  assert.equal(providers[0].name, "StepFun")
  assert.equal(providers[0].endpoint, "api.stepfun.com/v1", "接口地址去掉协议与尾斜杠")
  assert.deepEqual(
    providers[0].models.map((model) => [model.label, model.thinking, model.enabled]),
    [
      ["step-5-preview", "最高", true],
      ["step-3.7-flash", null, false],
    ],
  )
  assert.equal(providers[1].name, "anthropic", "没有 displayName 用 id，不编名字")
  assert.equal(providers[1].endpoint, null)
  assert.equal(providers[3].name, "extra", "只出现在模型清单里的供应商也列出")
  assert.equal(providers[3].models[0].enabled, false, "给了认证可用清单时，不在清单里的模型算不可用")
  assert.equal(modelData.providerModelOverflowOf(providers[0]), 0)
  assert.equal(modelData.providerModelOverflowOf({ models: new Array(5).fill(null) }), 2)
  assert.equal(modelData.endpointLabelOf("api.stepfun.com/v1/"), "api.stepfun.com/v1")
  assert.equal(modelData.endpointLabelOf(""), null)

  // 回包根本没有 available 字段（老扩展）时不谎报不可用
  const noAvailability = modelData.providerRowsOf(null, { models: [{ provider: "stepfun", id: "step-5-preview" }] })
  assert.equal(noAvailability[0].models[0].enabled, true)
  assert.equal(noAvailability[0].state, "unknown")
})

test("模型页：数值与压缩开关（千分位 / 缺字段回 null）", () => {
  assert.equal(modelData.tokenCountLabel(16384), "16,384")
  assert.equal(modelData.tokenCountLabel(20000), "20,000")
  assert.equal(modelData.tokenCountLabel(1234567), "1,234,567")
  assert.equal(modelData.tokenCountLabel(0), "0")
  assert.equal(modelData.tokenCountLabel(null), "—")
  assert.equal(modelData.autoCompactionOf({ autoCompactionEnabled: false }), false)
  assert.equal(modelData.autoCompactionOf({ autoCompactionEnabled: true }), true)
  assert.equal(modelData.autoCompactionOf({}), null)
  assert.equal(modelData.autoCompactionOf(null), null)
  assert.deepEqual(modelData.MODEL_COMPACTION_DEFAULTS, { reserveTokens: 16384, keepRecentTokens: 20000 })
  assert.deepEqual(
    modelData.MODEL_NEW_SESSION_MODES.map((mode) => [mode.value, mode.label]),
    [
      ["agent", "Agent"],
      ["ask", "仅提问"],
    ],
  )
  assert.equal(modelData.MODEL_NEW_SESSION_DEFAULT, "agent")
})

test("模型页：设计册 §4 文案逐条在场，◐ 只读 / 刷新接真实命令", () => {
  const source = stripComments(PAGES.model)
  assert.match(source, /data-settings-page="model"/)
  assert.match(source, /<SettingsPageTitle title="模型与会话" \/>/)

  const copy = [
    "默认模型",
    "默认思考等级",
    "显示思考过程",
    "供应商",
    "添加模型",
    "手动填入模型名",
    "添加供应商",
    "填入名称、接口地址与 API 密钥；支持 OpenAI 兼容端点",
    "刷新模型目录",
    "重新向 pi 读取模型清单",
    "上下文压缩",
    "自动压缩长对话",
    "对话太长时自动把旧消息总结成摘要，腾出空间",
    "给回复预留",
    "近期原文保留",
    "新会话",
    "默认模式",
    "新会话自动生成标题",
    "按首条消息内容命名",
  ]
  for (const text of copy) assert.ok(source.includes(text), `模型页缺文案：${text}`)
  assert.doesNotMatch(source, /官方目录拉取|联网下载/, "刷新只向 pi 重发清单，不声称联网下载")

  // 默认思考等级行下的七档说明引用同一个常量（不复制粘贴第二份文案）
  assert.match(source, /MODEL_THINKING_LEVELS_COPY/)
  assert.match(source, /MODEL_NEW_SESSION_MODES/)
  assert.match(source, /tokenBudgetPatch/)
  assert.match(source, /compactionEnabledPatch/)
  assert.match(MODEL_DATA_SOURCE, /共七档：关 \/ 最小 \/ 低 \/ 中 \/ 高 \/ 超高 \/ 最高/)

  // 可写项（默认模型 / 思考 / 压缩三项）走 settings_set；供应商 / 新会话仍标 ◐ 只读。
  const bridge = (source.match(/status="bridge"/g) ?? []).length
  assert.ok(bridge >= 5, `模型页剩下的只读项都要标状态（实际 ${bridge}）`)
  assert.doesNotMatch(source, /status="reserved"/, "给回复预留 / 近期原文保留已可写，不再是设计预留")
  assert.match(source, /useSettingsDocument/)
  assert.match(source, /useSettingsWriter/)
  assert.match(source, /defaultModelPatch/)
  assert.match(source, /defaultThinkingLevelPatch/)
  assert.match(source, /hideThinkingBlockPatch/)
  assert.doesNotMatch(source, /act\.setPref\(/, "模型页没有 ○ 本机项，不应写本机偏好")
  assert.doesNotMatch(source, /localStorage/, "页面不得直接读写存储")

  // 刷新模型目录：真实重发 get_available_models；loading / error / ready=false 都有状态
  const refreshRow = source.match(/刷新模型目录[\s\S]{0,260}?\/>/)?.[0] ?? ""
  assert.match(refreshRow, /modelsQuery\.reload\(\)/, "刷新必须重发 modelsQuery")
  assert.doesNotMatch(refreshRow, /status="reserved"/, "刷新不再是设计预留")
  assert.match(refreshRow, /disabled=\{!refreshReady \|\| modelsLoading\}/, "未就绪 / 设备离线 / 读取中禁用")
  assert.match(source, /setLastModels\(\{ room: roomKey, data: modelsQuery\.data \}\)/, "成功回包要留同一会话的快照")
  assert.match(source, /lastModelsData/, "loading / error 时用快照兜底")
  assert.match(source, /仍显示上次读取的清单/, "失败要保留旧数据并提示")
  assert.match(source, /正在读取模型清单/, "loading 要有正在读取文案")

  // 真实命令（附录 A）：get_settings 统一走 useSettingsDocument，仍读供应商 / 模型目录。
  for (const command of ["get_provider_auth", "get_available_models"]) {
    assert.ok(source.includes(command), `模型页没有接 ${command}`)
  }
  assert.match(source, /useSettingsDocument/)
  assert.match(source, /settings_set|useSettingsWriter/)
  assert.match(source, /commandsReady/)
  assert.doesNotMatch(source, /set_active_tools|set_model|set_thinking_level/, "模型页不写当前会话模型 / 工具")
  assert.match(source, /SettingsStatusDot/)
  assert.match(source, /SettingsSwitch/)
  assert.match(source, /SettingsRadioGroup/)
  assert.doesNotMatch(source, /SettingsPlaceholder/, "占位组件应已退场")
})

/* ------------------------------------------------------------------ */
/* §5 审批与执行                                                        */
/* ------------------------------------------------------------------ */

test("审批页：口径框与四组预留文案逐字来自设计册 §5", () => {
  assert.match(approvalData.APPROVAL_BRIEF, /pi 没有 Codex 式权限档位/)
  assert.match(approvalData.APPROVAL_BRIEF, /设计预留/)
  assert.match(approvalData.APPROVAL_BRIEF, /tool_call 权限门 \+ 项目信任/)

  assert.deepEqual(
    approvalData.APPROVAL_ASK_OPTIONS.map((option) => [option.label, option.description]),
    [
      ["逐项询问", "命令与工具调用先经你确认"],
      ["名单内自动通过", "免审名单里的命令直接执行，其余仍询问"],
      ["永不询问", "全部直接执行"],
    ],
  )
  assert.equal(approvalData.APPROVAL_ASK_OPTIONS[2].note, "风险高，仅建议在可信环境开启")
  assert.equal(approvalData.APPROVAL_ASK_DEFAULT, "ask")

  assert.deepEqual(
    approvalData.APPROVAL_TRUST_OPTIONS.map((option) => option.label),
    ["打开新项目时先询问", "总是信任", "从不信任"],
  )
  assert.equal(approvalData.APPROVAL_TRUST_NOTE, "项目级配置、扩展与 MCP 服务器都要信任后才加载。")

  assert.deepEqual(
    approvalData.APPROVAL_SCOPE_OPTIONS.map((option) => [option.label, option.description]),
    [
      ["仅查看", "只能读取，不能改动"],
      ["工作区内可改", "可改当前工作区内的文件"],
      ["完全访问", "可改设备上任意文件"],
    ],
  )
  assert.equal(approvalData.APPROVAL_SCOPE_OPTIONS[2].note, "需先在下方解锁")
  assert.equal(approvalData.APPROVAL_SCOPE_DEFAULT, "workspace")
  assert.equal(approvalData.APPROVAL_NETWORK_LABEL, "允许联网")
  assert.equal(approvalData.APPROVAL_NETWORK_DESCRIPTION, "沙盒内命令可访问网络")
  assert.deepEqual(approvalData.APPROVAL_SEARCH_OPTIONS.map((option) => option.label), ["实时", "缓存"])
  assert.equal(approvalData.APPROVAL_SEARCH_DEFAULT, "live")
  assert.equal(approvalData.APPROVAL_UNLOCK_LABEL, "允许「完全访问」与「永不询问」")
  assert.equal(approvalData.APPROVAL_UNLOCK_DESCRIPTION, "打开后上面两组的高危档位才可选，防误触")
  assert.deepEqual([...approvalData.APPROVAL_ALLOWLIST], ["git status", "cat *", "npm run test"])
  assert.equal(approvalData.APPROVAL_ALLOWLIST_NOTE, "名单内命令按上方策略自动通过，仍会记录在会话里。")
  assert.match(approvalData.APPROVAL_TOOLS_NOTE, /只作用于当前会话/)
  assert.match(approvalData.APPROVAL_TOOLS_NOTE, /关掉的工具不会递到模型手里，与上面的「能碰什么」是两回事/)
})

test("审批页：项目信任只读（get_state.projectTrusted），缺字段不猜", () => {
  assert.equal(approvalData.projectTrustOf({ projectTrusted: true }), "trusted")
  assert.equal(approvalData.projectTrustOf({ projectTrusted: false }), "untrusted")
  assert.equal(approvalData.projectTrustOf({}), "unknown")
  assert.equal(approvalData.projectTrustOf(null), "unknown")
  assert.equal(approvalData.projectTrustOf("trusted"), "unknown")
  assert.deepEqual(approvalData.APPROVAL_TRUST_STATE_LABELS, { trusted: "已信任", untrusted: "未信任", unknown: "未知" })
  assert.equal(approvalData.APPROVAL_TRUST_DEFAULT, "ask")
})

test("审批页：可用工具映射真实工具名，切换只动这一项（保留设计稿外工具）", () => {
  const registry = [
    { name: "read" },
    { name: "bash" },
    { name: "edit" },
    { name: "write" },
    { name: "grep" },
    { name: "find" },
    { name: "ls" },
    { name: "codemode" },
    { name: "tool_search" },
    { name: "extension_tool" },
  ]
  const view = approvalData.approvalToolRowsOf({ tools: ["read", "bash", "extension_tool"] }, { tools: registry })
  assert.deepEqual(
    view.rows.map((row) => [row.label, row.toolName, row.enabled]),
    [
      ["读取文件", "read", true],
      ["运行命令", "bash", true],
      ["编辑文件", "edit", false],
      ["写入文件", "write", false],
      ["搜索文件", "grep", false],
      ["文件列表", "ls", false],
      ["脚本工具", "codemode", false],
      ["工具搜索", "tool_search", false],
    ],
  )
  assert.equal(view.rows[6].mono, true)
  assert.equal(view.rows[6].note, "默认关")
  assert.equal(view.rows[7].note, "默认关")
  assert.deepEqual(view.enabled, ["read", "bash", "extension_tool"], "设计稿八行之外的工具原样保留")

  // 只增删这一项：extension_tool / find 不动
  assert.deepEqual(approvalData.toggledToolSet(view.enabled, "edit", true), ["read", "bash", "extension_tool", "edit"])
  assert.deepEqual(approvalData.toggledToolSet(view.enabled, "read", false), ["bash", "extension_tool"])
  assert.deepEqual(approvalData.toggledToolSet(view.enabled, "read", true), view.enabled, "已经开着的工具不重复加入")

  // 注册表没有的工具：该行不可用，不拿别的工具顶替
  const partial = approvalData.approvalToolRowsOf({ tools: ["read"] }, { tools: [{ name: "read" }] })
  assert.deepEqual(partial.rows[0], {
    id: "read",
    label: "读取文件",
    toolName: "read",
    displayName: "read",
    available: true,
    enabled: true,
    mono: false,
    note: null,
  })
  assert.equal(partial.rows[1].available, false)
  assert.equal(partial.rows[1].toolName, null)
  assert.equal(partial.rows[1].displayName, "bash", "未注册也保留设计稿里的工具名（不拿别的顶替）")
  assert.equal(partial.rows[1].enabled, false)
  assert.equal(partial.rows[6].displayName, "codemode", "「脚本工具 codemode」在离线时也成立")

  // set_active_tools 回包（数组缺失 / 空数组都要分清）
  assert.deepEqual(approvalData.toolsFromResponse({ tools: ["read", "edit"] }, ["read"]), ["read", "edit"])
  assert.deepEqual(approvalData.toolsFromResponse({ tools: [] }, ["read"]), [], "空数组 = 全部关掉，是合法值")
  assert.deepEqual(approvalData.toolsFromResponse({}, ["read", "bash"]), ["read", "bash"])
})

test("审批页：五组 + 可用工具逐条在场，◌ 组级预留 / ◐ 只读 / ● 真实写桥", () => {
  const source = stripComments(PAGES.approval)
  assert.match(source, /data-settings-page="approval"/)
  assert.match(source, /<SettingsPageTitle title="审批与执行" \/>/)

  assert.match(source, /APPROVAL_BRIEF/, "口径框必须呈现")
  assert.match(source, /role="note"/)
  for (const label of ["何时询问", "项目信任", "能碰什么", "高危解锁", "免审命令名单", "可用工具"]) {
    assert.ok(source.includes(label), `审批页缺分组：${label}`)
  }
  for (const copy of ["允许联网", "网页搜索", "添加命令", "默认关"]) {
    assert.ok(source.includes(copy) || APPROVAL_DATA_SOURCE.includes(copy), `审批页缺文案：${copy}`)
  }
  assert.match(source, /APPROVAL_ASK_OPTIONS/)
  assert.match(source, /APPROVAL_TRUST_OPTIONS/)
  assert.match(source, /APPROVAL_SCOPE_OPTIONS/)
  assert.match(source, /APPROVAL_ALLOWLIST/)
  assert.match(source, /APPROVAL_TOOLS_NOTE/)
  assert.match(source, /APPROVAL_TRUST_NOTE/)

  const reservedGroups = (source.match(/status="reserved"/g) ?? []).length
  assert.ok(reservedGroups >= 4, `四组 ◌ 预留都要标状态（实际 ${reservedGroups}）`)
  // 项目信任默认已接 settings_set；当前项目状态仍只读，权限档位仍是 ◌。
  assert.match(source, /useSettingsWriter/)
  assert.match(source, /defaultProjectTrustPatch/)
  assert.match(source, /effectiveProjectTrustOf/)
  assert.doesNotMatch(source, /APPROVAL_TRUST_DEFAULT/, "不再把默认值当成主机真实值")

  // ● 可用工具接真实现成能力：读两条、写一条，改完即存（没有保存按钮）
  for (const command of ["get_active_tools", "get_all_tools", "get_state"]) {
    assert.ok(source.includes(command), `审批页没有接 ${command}`)
  }
  assert.match(source, /set_active_tools/)
  assert.match(source, /toggledToolSet/)
  assert.match(source, /toolsFromResponse/)
  assert.match(source, /act\.notify/)
  assert.doesNotMatch(source, /保存按钮|取消<\/button>|确定<\/button>/)
  assert.doesNotMatch(source, /localStorage/, "页面不得直接读写存储")
  assert.doesNotMatch(source, /act\.setPref\(/, "审批页没有 ○ 本机项")

  // 预留组不伪造可写控件：没有任何 onChange 接进预留组（开关一律 disabled）
  assert.match(source, /checked=\{false\} disabled/)
  assert.match(source, /<SettingsActionRow title="添加命令" disabled \/>/)
  assert.doesNotMatch(source, /SettingsPlaceholder/)
})

/* ------------------------------------------------------------------ */
/* §3 通用：补强校对                                                    */
/* ------------------------------------------------------------------ */

test("通用页：设计册 §3 文案齐全，○ 即时写本机、◐ 只读、● 接 relay", () => {
  const source = stripComments(PAGES.general)
  for (const copy of [
    "启动与导航",
    "打开时进入",
    "上次会话",
    "会话列表",
    "侧边栏常驻搜索框",
    "关闭时用功能键唤出搜索",
    "界面语言",
    "发送与会话",
    "发送消息",
    "Enter 发送",
    "Ctrl + Enter 发送",
    "生成时自动滚到底部",
    "已完成会话自动归档",
    "不自动",
    "7 天后",
    "30 天后",
    "插话消息投递",
    "生成时排队的插话，怎么递给模型",
    "收尾消息投递",
    "发送图片前自动缩小",
    "语音输入",
    "麦克风",
    "语音转文字",
    "听写快捷键",
    "中转服务器",
    "连接状态",
    "服务器地址",
    "断线后自动重连",
    "连接诊断",
    "重新配对",
  ]) {
    assert.ok(source.includes(copy), `通用页缺文案：${copy}`)
  }

  // ○ 本机项：即时写偏好（setPref），且经 hooks 持久化
  assert.ok((source.match(/act\.setPref\(/g) ?? []).length >= 8, "○ 本机项都要即时写偏好")
  assert.match(source, /useSettingsLocalState|prefs\./)
  assert.doesNotMatch(source, /localStorage/, "页面不得直接读写存储，持久化在 SettingsContext")

  // 麦克风补强：浏览器侧列真实输入设备
  assert.match(source, /enumerateDevices/)
  assert.match(source, /audioinput/)
  assert.match(source, /devicechange/)
  assert.match(source, /micDevice/)

  // 连接诊断仍是 ◐；三项设备设置改走 settings_set。
  assert.ok((source.match(/status="bridge"/g) ?? []).length >= 1)
  assert.match(source, /useSettingsDocument/)
  assert.match(source, /useSettingsWriter/)
  assert.match(source, /steeringModePatch/)
  assert.match(source, /followUpModePatch/)
  assert.match(source, /autoResizeImagesPatch/)
  assert.match(source, /relay\.authed/)
  assert.match(source, /act\.openPairing/)
  assert.match(source, /serverDisplayName/)
  assert.doesNotMatch(source, /SettingsPlaceholder/)
})

/* ------------------------------------------------------------------ */
/* 三页共同口径                                                        */
/* ------------------------------------------------------------------ */

test("三页共同口径：作用域内、无字面色、无浮层残留、标对页 id", () => {
  for (const [page, source] of Object.entries(PAGES)) {
    const clean = stripComments(source)
    assert.match(clean, new RegExp(`data-settings-page="${page}"`), `${page} 缺页标记`)
    assert.deepEqual(clean.match(COLOR_RE) ?? [], [], `${page} 不得写死颜色（只用 --st-*）`)
    assert.doesNotMatch(clean, /from "\.\.\/\.\.\/settings\//, `${page} 不应绕过 barrel`)
    assert.doesNotMatch(clean, /SettingsPlaceholder/, `${page} 仍是占位组件`)
    assert.match(clean, /useSettings\(\)/, `${page} 必须从设置上下文取宿主能力`)
    assert.match(clean, /<SettingsGroup|<ApprovalGroup/, `${page} 必须有分组卡片结构`)
  }
  // 模型页 / 审批页不得写本机偏好；通用页是唯一允许写本机偏好的一页
  assert.doesNotMatch(stripComments(PAGES.model), /act\.setPref\(/)
  assert.doesNotMatch(stripComments(PAGES.approval), /act\.setPref\(/)
})

test("文案常量集中：模型 / 审批的设计文案集中在可测的 data 模块里", () => {
  assert.match(MODEL_DATA_SOURCE, /MODEL_THINKING_LEVELS_COPY/)
  assert.match(MODEL_DATA_SOURCE, /MODEL_COMPACTION_DEFAULTS/)
  assert.match(MODEL_DATA_SOURCE, /MODEL_PROVIDER_MODEL_LIMIT = 3/)
  assert.match(APPROVAL_DATA_SOURCE, /APPROVAL_BRIEF/)
  assert.match(APPROVAL_DATA_SOURCE, /APPROVAL_TOOL_SPECS/)
  assert.doesNotMatch(MODEL_DATA_SOURCE, COLOR_RE)
  assert.doesNotMatch(APPROVAL_DATA_SOURCE, COLOR_RE)
})
