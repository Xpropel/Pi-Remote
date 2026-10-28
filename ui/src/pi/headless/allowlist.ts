/**
 * 变体 v2 的**共享逻辑白名单**与独立性守卫规则（P2.5；brief「用户新增硬性要求」§3/§4）。
 *
 * 背景：用户要求两套变体「完全使用各自版本的 UI 组件，不要复用任何 cursor 版本的 UI」。
 * 本文件只放**纯常量 + 纯函数**（不 import 任何模块），所以 node --test 能直接加载（test/pi-ui-independence.test.mjs），
 * 两套变体线也可以直接 import 白名单做自查；测试与文档共用同一份口径，避免各写一套。
 *
 * 允许复用的只有「逻辑」：@/relay/** 数据层与纯函数、@/pi/model/** 纯函数、白名单内的 @/pi/hooks/** 纯行为 hook、
 * @/pi/headless/**（本次新抽的无视觉根/视口），以及 `@/pi/containers/types`、`@/components/pi/shared/viewport` 的**仅类型** import。
 * 禁止：@/components/pi/**、@/components/kit/**、@/pi/containers/** 的值 import、cursor 的 CSS/--cw-* token/类名、
 * 变体之间互相 import、import variants/index.ts。
 */

/** 需要守独立性的两套变体（cursor 是基准，不受这些规则约束） */
export const PI_UI_INDEPENDENCE_VARIANTS = ["claude", "codex"] as const
export type PiUiIndependenceVariant = (typeof PI_UI_INDEPENDENCE_VARIANTS)[number]

/** 变体入口组件（相对 repo 根；v2 必须自己实现根 DOM，经 @/pi/headless 拿布局语义） */
export const PI_VARIANT_ENTRIES: Record<PiUiIndependenceVariant, string> = {
  claude: "ui/src/pi/variants/claude/ClaudeApp.tsx",
  codex: "ui/src/pi/variants/codex/CodexApp.tsx",
}

/** 变体可以直接 import 的**模块前缀**（值 import / 类型 import 都行） */
export const PI_VARIANT_ALLOWED_IMPORT_PREFIXES = ["@/pi/headless", "@/pi/model/", "@/relay"] as const

/** 额外允许的精确模块（变体契约类型） */
export const PI_VARIANT_ALLOWED_EXACT_IMPORTS = ["@/pi/variants/types"] as const

/**
 * P10「使用活动」：变体设置页挂载点。只放行**精确模块**，禁止整目录通配
 * （`@/pi/usage/../cursor...` 这类借道仍会被拒绝；使用活动页自身保持自包含，不 import cursor 组件/--cw-*）。
 */
export const PI_VARIANT_ALLOWED_USAGE_MODULES = ["@/pi/usage", "@/pi/usage/UsageActivityPage"] as const

/**
 * P13 设置页 v2（三套桌面 / 三套手机共用）：只放行**精确入口**，禁止整目录通配。
 * 设置页是独立系统，自带 `[data-pi-settings]` 样式作用域、六套 --st-* 令牌与 mobile 独立壳；
 * 变体只传 p（含 style / theme），不 import 任何 cursor 部件。
 */
export const PI_VARIANT_ALLOWED_SETTINGS_MODULES = ["@/pi/settings", "@/pi/settings/mobile"] as const

/**
 * 允许的 @/pi/hooks/** 白名单（已审计：无 JSX、无 className、无 @/components 依赖、无 cursor DOM 依赖）。
 * 不在表里的 hook（usePiUiState / usePiTheme / useLegacyStyle / usePiDevice / usePiShellShortcuts…）由 entry 层负责，
 * 变体不要 import（usePiShellShortcuts 依赖 cursor 的 PiLayerProvider 上下文，属于禁止项）。
 */
export const PI_VARIANT_ALLOWED_HOOKS = [
  "@/pi/hooks/useNow",
  "@/pi/hooks/usePiPhoneNav",
  "@/pi/hooks/usePiStickToBottom",
  "@/pi/hooks/usePiShortcuts",
  "@/pi/hooks/useTranscriptStick",
  "@/pi/hooks/useHighlightLines",
  "@/pi/hooks/useReducedMotion",
] as const

/**
 * 变体允许 import 的 `@/pi/extensions/**` **精确模块**（P4.1 收窄；整前缀会放过 mock/dev）：
 * 能力契约层（能力元数据/类型/注册表/禁用态/hook/选择器/映射/平台 prefs）可被两线消费；
 * mock 与 dev 注入模块**禁止**（mock 只由 dev/gallery/PiApp 入口显式 import 安装）。
 */
export const PI_VARIANT_ALLOWED_EXTENSION_MODULES = [
  "@/pi/extensions",
  "@/pi/extensions/index",
  "@/pi/extensions/types",
  "@/pi/extensions/capabilities",
  "@/pi/extensions/registry",
  "@/pi/extensions/disabled",
  "@/pi/extensions/usePiUiCapabilities",
  "@/pi/extensions/selectors",
  "@/pi/extensions/inventory-map",
  "@/pi/extensions/platform-prefs",
] as const

/**
 * P11 共享侧栏/移动导航（三套 UI 共用，Lead 批准）：只放行**精确模块**，禁止整目录通配。
 * 变体只传 style/theme/data；共享组件自包含（不 import cursor 组件/变体私有样式/--cw-*）。
 */
export const PI_VARIANT_ALLOWED_SIDEBAR_MODULES = [
  "@/pi/sidebar",
  "@/pi/sidebar/index",
  "@/pi/sidebar/types",
  "@/pi/sidebar/model",
  "@/pi/sidebar/storage",
  "@/pi/sidebar/gallery",
  "@/pi/sidebar/UnifiedSidebar",
  "@/pi/sidebar/SidebarSections",
  "@/pi/sidebar/SidebarSessionRow",
  "@/pi/sidebar/SidebarDeviceMenu",
  "@/pi/sidebar/SidebarHoverCard",
  "@/pi/sidebar/SidebarIdentity",
] as const

/** P11 移动导航共享壳（codex-dev 实现；三套手机壳共用） */
export const PI_VARIANT_ALLOWED_MOBILE_MODULES = [
  "@/pi/mobile",
  "@/pi/mobile/types",
  "@/pi/mobile/MobileNavShell",
  "@/pi/mobile/DrawerNav",
  "@/pi/mobile/ListHome",
  "@/pi/mobile/MobileSessionPage",
  "@/pi/mobile/MobileLongPressCard",
  "@/pi/mobile/MobileNavSetting",
  "@/pi/mobile/MobileSettingsPicker",
] as const

/** 变体禁止 import 的扩展模块（mock/dev 注入只属于入口层；前缀匹配） */
export const PI_VARIANT_FORBIDDEN_EXTENSION_MODULES = ["@/pi/extensions/mock", "@/pi/extensions/dev"] as const

/** 只允许 `import type` 的模块（值 import = 违规） */
export const PI_VARIANT_TYPE_ONLY_IMPORTS = ["@/pi/containers/types", "@/components/pi/shared/viewport"] as const

/** 禁止的 import 前缀（v2 静态扫描指标 = 0 处） */
export const PI_VARIANT_FORBIDDEN_IMPORT_PREFIXES = [
  "@/components/pi/",
  "@/components/kit/",
  "@/chat/",
  "@/shell/",
  "@/mobile/",
  "@/style/",
  "@/lib/",
  "@/pi/containers/",
  // 开发画廊目录也禁止进产品变体；不写完整路径，避免 pi-structure 的「产品目录不出现开发画廊路径」grep 误报
  "@/pi/dev",
  "@/pi/styles/",
  "@/pi/variants/index",
] as const

/** 变体源码里禁止出现的 cursor 专有字符串（token / 类名前缀）；命中即违规，0 处指标 */
export const PI_VARIANT_FORBIDDEN_TOKENS = ["--cw-"] as const

/** cursor 组件名（import 扫描之外的兜底：变体源码不应引用这些标识符） */
export const PI_VARIANT_CURSOR_COMPONENT_NAMES = [
  "PiRoot",
  "PiSidebar",
  "PiTopBar",
  "PiComposer",
  "PiComposerDock",
  "PiSettingsPage",
  "PiTranscript",
  "PiApprovalCard",
  "PiCommandPalette",
  "PiTray",
  "PiDialog",
  "PiSheet",
  "PiMark",
  "PiButton",
  "PiSpinner",
  "PiEmptyComposer",
  "PiDisplayOptions",
  "PiFolderPicker",
  "PiNewSession",
  "PiDesktopShell",
  "PiLayerProvider",
  "PiStaticProvider",
] as const

/** 变体 CSS 禁止的全局选择器（行首出现即违规：样式必须挂在 [data-pi-ui="<id>"] 作用域下） */
export const PI_VARIANT_FORBIDDEN_GLOBAL_SELECTORS = [":root", "html", "body", "*"] as const

export interface PiVariantImportCheck {
  /** `import type` / `export type`（只取类型） */
  typeOnly?: boolean
  /** 相对 import 是否落在变体自己的目录里（测试按解析后的路径判断） */
  ownDir?: boolean
}

export type PiVariantImportVerdict = { ok: true } | { ok: false; reason: string }

/**
 * 变体源码里的一条 import 是否允许（纯函数；测试与变体线自查共用）。
 * - spec：源码里的 import specifier（`@/...`、`./...` 或包名）
 * - 返回 ok:false 时 reason 是给 v2 修复用的中文原因。
 */
export function piVariantImportVerdict(spec: string, check: PiVariantImportCheck = {}): PiVariantImportVerdict {
  const typeOnly = check.typeOnly === true
  // 1) 变体自己目录里的相对 import（自己的组件 / 自己的 CSS）——由调用方解析路径后传 ownDir
  if (check.ownDir) return { ok: true }
  // 2) 样式：相对 import 只能指向变体自己目录（由 ownDir 判定）；npm 包自带的字体 / 样式入口（如 @fontsource-*）属于第三方资源，放行。
  //    路径别名 / 别处的 CSS 一律禁止——cursor 的样式表不允许进变体。
  if (/\.css($|\?)/.test(spec) && (spec.startsWith(".") || spec.startsWith("@/"))) {
    return { ok: false, reason: "样式文件必须放在变体自己目录里，用相对 import 引入" }
  }
  // 3) 裸包名：react / 框架 / 纯逻辑第三方库（样式类库不在此列，需自写样式）
  if (!spec.startsWith(".") && !spec.startsWith("@/")) return { ok: true }
  // 4) @/ 别名：先看精确白名单
  if (spec === "@/pi/variants/types" || (PI_VARIANT_ALLOWED_EXACT_IMPORTS as readonly string[]).includes(spec)) return { ok: true }
  if (spec === "@/pi/headless" || spec.startsWith("@/pi/headless/")) return { ok: true }
  // P10：使用活动共享页/契约——精确白名单；其余 @/pi/usage/** 子模块与借道路径一律拒绝
  if ((PI_VARIANT_ALLOWED_USAGE_MODULES as readonly string[]).includes(spec)) return { ok: true }
  if (spec === "@/pi/usage" || spec.startsWith("@/pi/usage/")) {
    return { ok: false, reason: `使用活动只允许精确模块（见 PI_VARIANT_ALLOWED_USAGE_MODULES）：${spec}` }
  }
  // P13：设置页 v2 独立系统——只放行两个宿主入口；页面内部由设置页自己 import，变体不得借道
  if ((PI_VARIANT_ALLOWED_SETTINGS_MODULES as readonly string[]).includes(spec)) return { ok: true }
  if (spec === "@/pi/settings" || spec.startsWith("@/pi/settings/")) {
    return { ok: false, reason: `设置页只允许精确入口（见 PI_VARIANT_ALLOWED_SETTINGS_MODULES）：${spec}` }
  }
  // P11：统一侧栏/移动导航——只放行精确模块；未登记子模块与借道路径都拒绝（不开整目录）
  if ((PI_VARIANT_ALLOWED_SIDEBAR_MODULES as readonly string[]).includes(spec)) return { ok: true }
  if ((PI_VARIANT_ALLOWED_MOBILE_MODULES as readonly string[]).includes(spec)) return { ok: true }
  if (spec === "@/pi/sidebar" || spec.startsWith("@/pi/sidebar/")) {
    return { ok: false, reason: `P11 侧栏只允许精确模块（见 PI_VARIANT_ALLOWED_SIDEBAR_MODULES）：${spec}` }
  }
  if (spec === "@/pi/mobile" || spec.startsWith("@/pi/mobile/")) {
    return { ok: false, reason: `P11 移动导航只允许精确模块（见 PI_VARIANT_ALLOWED_MOBILE_MODULES）：${spec}` }
  }
  // P4.1：UI 扩展能力层——只放行精确的契约模块；mock/dev 显式禁止（整前缀不放行）
  if ((PI_VARIANT_FORBIDDEN_EXTENSION_MODULES as readonly string[]).some((prefix) => spec === prefix || spec.startsWith(`${prefix}/`))) {
    return { ok: false, reason: "变体禁止 import @/pi/extensions/mock|dev（mock 由 dev/gallery/入口显式安装，不进变体）" }
  }
  if ((PI_VARIANT_ALLOWED_EXTENSION_MODULES as readonly string[]).includes(spec)) return { ok: true }
  if (spec === "@/pi/extensions" || spec.startsWith("@/pi/extensions/")) {
    return { ok: false, reason: `扩展能力层只允许契约模块（见 PI_VARIANT_ALLOWED_EXTENSION_MODULES）：${spec}` }
  }
  if (spec.startsWith("@/pi/model/")) return { ok: true }
  if (spec === "@/relay" || spec.startsWith("@/relay/")) return { ok: true }
  if ((PI_VARIANT_ALLOWED_HOOKS as readonly string[]).includes(spec)) return { ok: true }
  if ((PI_VARIANT_TYPE_ONLY_IMPORTS as readonly string[]).includes(spec)) {
    return typeOnly ? { ok: true } : { ok: false, reason: `${spec} 只允许 import type（类型契约，不引入 cursor 实现）` }
  }
  // 5) 注册表 / 变体间 import 先给专门原因（@/pi/variants/index 也命中下面的禁令前缀）
  if (spec.startsWith("@/pi/variants/")) return { ok: false, reason: "变体之间 / 注册表禁止 import（入口层负责注册）" }
  // 6) 明确禁止 / 需要原因的类别
  for (const prefix of PI_VARIANT_FORBIDDEN_IMPORT_PREFIXES) {
    if (spec === prefix || spec.startsWith(prefix)) return { ok: false, reason: `禁止 import cursor 版本 UI / 旧界面 / 非白名单模块：${prefix}` }
  }
  if (spec.startsWith("@/pi/hooks/")) return { ok: false, reason: `hook 不在白名单：${spec}（见 PI_VARIANT_ALLOWED_HOOKS）` }
  if (spec.startsWith("@/pi/containers/")) return { ok: false, reason: "containers 的值 import 禁止（只有 @/pi/containers/types 可 import type）" }
  if (spec.startsWith(".")) return { ok: false, reason: "相对 import 只能指向变体自己目录（越出目录 = 复用别处实现）" }
  return { ok: false, reason: `不在变体白名单内：${spec}` }
}

/* ------------------------------------------------------------------------------------------------
 * 细化白名单（P2.5 补充；Lead 追加要求 1–2 + independence-checklist §3）
 * 目标：两套变体 v2 只靠这份清单就能判断「哪些能 import、哪些要移植」；结构测试逐条核对模块存在性与纯度。
 * ---------------------------------------------------------------------------------------------- */

/**
 * `@/pi/headless/types.ts` 允许 re-export 类型的源模块（checklist D3）。
 * 变体从 `@/pi/headless` 取这些类型；**不要**直接 import 下面的 cursor 模块（会被守卫拦）。
 */
export const PI_VARIANT_TYPE_EXPORT_SOURCES = [
  "@/components/pi/shared/types",
  "@/pi/containers/types",
  "@/relay/useRelay",
  "@/relay/transcript",
  "@/relay/attention",
  "@/pi/model/transcriptView",
  "@/pi/model/transcriptWindow",
  "@/pi/model/diffRows",
  "@/pi/model/changesView",
  "@/pi/model/composerButton",
  "@/pi/model/composerView",
  "@/pi/model/settingsView",
  "@/pi/model/tray",
  "@/pi/model/dialogCard",
  "@/pi/model/approvalReceipt",
  "@/pi/model/sidebarGroups",
  "@/pi/model/highlight",
  "@/pi/model/models",
  "@/pi/model/rowMarker",
] as const

/**
 * 变体可以直接 import 的 `@/pi/model/**` 模块（全部审计为纯函数：无 JSX / 无 className / 无 cursor 组件依赖）。
 * 约定：只 import 纯函数与类型；视图模型 → 变体自己的 JSX，样式 → 变体自己的 CSS。
 */
export const PI_VARIANT_ALLOWED_MODEL_MODULES = [
  "@/pi/model/approvalAnnounce",
  "@/pi/model/approvalReceipt",
  "@/pi/model/boot",
  "@/pi/model/changes",
  "@/pi/model/changesView",
  "@/pi/model/composerButton",
  "@/pi/model/composerInput",
  "@/pi/model/composerReason",
  "@/pi/model/composerView",
  "@/pi/model/costNote",
  "@/pi/model/dialogCard",
  "@/pi/model/dialogsData",
  "@/pi/model/diffRows",
  "@/pi/model/filePayload",
  "@/pi/model/folderBrowser",
  "@/pi/model/highlight",
  "@/pi/model/highlightMatch",
  "@/pi/model/hostDiag",
  "@/pi/model/layers",
  "@/pi/model/legacyStyle",
  "@/pi/model/models",
  "@/pi/model/newSession",
  "@/pi/model/outbox",
  "@/pi/model/palette",
  "@/pi/model/phoneDock",
  "@/pi/model/phoneRoute",
  "@/pi/model/prefs",
  "@/pi/model/promptRecall",
  "@/pi/model/receipts",
  "@/pi/model/rowMarker",
  "@/pi/model/serverName",
  "@/pi/model/sessionInfo",
  "@/pi/model/sessionMenu",
  "@/pi/model/settingsHost",
  "@/pi/model/settingsView",
  "@/pi/model/shortcuts",
  "@/pi/model/sidebarGroups",
  "@/pi/model/sidebarSource",
  "@/pi/model/slashBuiltins",
  "@/pi/model/slashMenu",
  "@/pi/model/toolWeight",
  "@/pi/model/transcriptView",
  "@/pi/model/transcriptWindow",
  "@/pi/model/tray",
  "@/pi/model/turnError",
] as const

/**
 * 变体可以直接 import 的 `@/relay/**` 模块（数据层 / 纯逻辑与类型；UI 状态与 hooks 由 entry 层负责）。
 * `useRelay` 只允许取类型与纯函数（`Relay` 类型、`roomTitle` 等），不要在变体里调用 `useRelay()`（entry 只调一次）。
 */
export const PI_VARIANT_ALLOWED_RELAY_MODULES = [
  "@/relay/attention",
  "@/relay/bodySearch",
  "@/relay/commands",
  "@/relay/compactionResult",
  "@/relay/composerFacts",
  "@/relay/contextUsage",
  "@/relay/deletedSessions",
  "@/relay/devices",
  "@/relay/drafts",
  "@/relay/history",
  "@/relay/lazySession",
  "@/relay/presence",
  "@/relay/protocol",
  "@/relay/remoteQueue",
  "@/relay/sessionArchive",
  "@/relay/sessionRemoved",
  "@/relay/sync",
  "@/relay/transcript",
  "@/relay/useRelay",
] as const

/** 白名单 hooks 的可用导出（无样式纯行为；hook 模块均为 .ts，无 JSX / className / kit 依赖） */
export const PI_VARIANT_ALLOWED_HOOK_EXPORTS: Record<string, readonly string[]> = {
  "@/pi/hooks/useNow": ["PiNowProvider", "useNow"],
  "@/pi/hooks/usePiPhoneNav": ["PHONE_UNAVAILABLE_MS", "PiPhoneNav", "usePiPhoneNav"],
  "@/pi/hooks/usePiStickToBottom": ["PI_KEYBOARD_STICK_PX", "PiStickToBottom", "usePiStickToBottom"],
  "@/pi/hooks/usePiShortcuts": ["PiShortcutHandlers", "UsePiShortcutsOptions", "isEditableTarget", "focusKindOf", "usePiShortcuts"],
  "@/pi/hooks/useTranscriptStick": ["PiTranscriptStick", "piTranscriptStick", "useTranscriptStick"],
  "@/pi/hooks/useHighlightLines": ["useHighlightLines"],
  "@/pi/hooks/useReducedMotion": ["REDUCED_MOTION_QUERY", "PAGE_TRANSITION_MS", "PiMotion", "motionOf", "readReducedMotion", "usePiMotion", "useReducedMotion"],
}

/**
 * 可用的第三方 headless 逻辑库（框架 / 解析 / 渲染逻辑；**样式全部自写**，这些库不提供 cursor 样式）。
 * 裸包名 import 在守卫里默认放行，这份清单用于文档与「不要引样式类库」的显式约定。
 */
export const PI_VARIANT_ALLOWED_THIRD_PARTY = [
  "react",
  "react-dom",
  "lucide-react",
  "react-markdown",
  "remark-gfm",
  "remark-breaks",
  "shiki",
  "use-stick-to-bottom",
  "@fontsource-variable/newsreader",
  "@fontsource-variable/inter",
  "@fontsource-variable/geist",
  "@fontsource/jetbrains-mono",
  "@fontsource/noto-sans-sc",
] as const

/**
 * 重逻辑裁决（Lead 追加要求 2；对应 independence-checklist §3.2 / D2）：
 * 这些模块在 cursor 模块图里（`@/chat/**`、`@/shell/**`、`@/components/ui/**`），**禁止变体直接 import**；
 * 现阶段明确裁决 = **允许各线把用到的函数移植进 `variants/<id>/model/ported/`**（文件头注明来源与日期，行为不改），
 * 避免两线依赖 cursor 实现；等 P3 后行为稳定，再把两线共用的实现上移到 `@/pi/headless/logic/**`（预留前缀已白名单）。
 */
export const PI_VARIANT_PORTING_REQUIRED = [
  { module: "@/chat/slashParse", lines: 341, use: "斜杠命令解析（两套 composer）" },
  { module: "@/chat/composer/mention", lines: 213, use: "@ 文件提及过滤" },
  { module: "@/chat/capsules/terminalModel", lines: 865, use: "终端卡保留期 / 排序 / 行数（必须，否则终端行为漂移）" },
  { module: "@/chat/capsules/workingModel", lines: 0, use: "运行中状态措辞（Worked for / running line）" },
  { module: "@/chat/composerMachine", lines: 497, use: "发送 / 排队 / 确认状态机" },
  { module: "@/components/ui/streaming-markdown-core", lines: 183, use: "流式 markdown 稳定前缀切分（否则流式渲染易抖）" },
  { module: "@/chat/slashUsage", lines: 159, use: "斜杠命令使用统计" },
  { module: "@/chat/treeFlatten", lines: 104, use: "会话树扁平化" },
  { module: "@/chat/composer/sound", lines: 167, use: "提示音（可移植或走 relay 配置）" },
  { module: "@/shell/deviceStripModel", lines: 0, use: "手机设备条模型" },
  { module: "@/shell/filePreview", lines: 0, use: "文件预览判断" },
  { module: "@/conversation/messageActionsModel", lines: 0, use: "消息操作条模型" },
] as const

/** 预留：未来共享重逻辑上移到这里（`@/pi/headless` 前缀已放行；变体 import `@/pi/headless/logic/...` 即合法） */
export const PI_VARIANT_HEADLESS_LOGIC_PREFIX = "@/pi/headless/logic/"

/** 优先上移到 headless/logic 的两线共用重逻辑（P3 后做；现在各线移植） */
export const PI_VARIANT_HEADLESS_LOGIC_CANDIDATES = [
  "streaming-markdown-core",
  "slashParse",
  "terminalModel",
  "composerMachine",
] as const

/* ------------------------------------------------------------------------------------------------
 * DOM 归因 / 变体私有状态规则（P2.5 final：守卫转硬 + P3 DOM 脚本共用；checklist §0.1/§6）
 * 变体只能输出 data-pi-ui / data-pi-ui-part / data-<id>-*；cursor 的结构标记一律禁止。
 * ---------------------------------------------------------------------------------------------- */

/** 变体源码 / 渲染 DOM 里禁止出现的 cursor 结构标记（checklist §6 清单；data-pi-theme 由 headless 统一写，不在禁止表） */
export const PI_VARIANT_FORBIDDEN_DOM_MARKERS = [
  "data-pi-part",
  "data-pi-shell",
  "data-pi-main",
  "data-pi-row",
  "data-pi-root",
  "data-pi-dock",
  "data-pi-slot",
  "data-pi-sidebar",
  "data-pi-topbar",
  "data-pi-marker",
  "data-pi-scroller",
  "data-pi-phone-nav",
  "data-pi-opening",
  "data-pi-boot",
  "data-pi-ready",
  "data-pi-stage",
  "data-pi-live",
  "data-pi-page",
  "data-pi-autofocus",
  "data-pi-focus-fallback",
  "data-pi-row-key",
  "data-pi-primary",
  "data-pi-mode",
  "data-pi-session-more",
] as const

/** 变体允许输出的 DOM 标记（自己画 DOM 时只允许这些；其余用 data-<id>-*） */
export const PI_VARIANT_ALLOWED_DOM_MARKERS = ["data-pi-ui", "data-pi-ui-part"] as const

/** 变体禁止直接用的浏览器存储 API（偏好/状态只能经 entry 传下来的 act / props） */
export const PI_VARIANT_FORBIDDEN_STORAGE_APIS = ["localStorage", "sessionStorage", "indexedDB"] as const

/** 变体禁止的 cursor 类名 / Tailwind 任意值前缀（文本扫描口径：--cw- 已在 PI_VARIANT_FORBIDDEN_TOKENS） */
export const PI_VARIANT_FORBIDDEN_CLASS_PREFIXES = ["data-slot=\"pi-", "data-slot='pi-"] as const

/* ------------------------------------------------------------------------------------------------
 * CI 加固（终审 3 条可绕过：side-effect CSS / CSS @import / cursor 类名与 Tailwind 工具类注入）
 * ---------------------------------------------------------------------------------------------- */

/** 变体自有 class 前缀（claude / codex 各自的 UI 命名空间；DOM 归因与 class 扫描共用） */
export const PI_VARIANT_OWN_CLASS_PREFIX: Record<PiUiIndependenceVariant, string> = { claude: "claude-", codex: "cx-" }

/** cursor 组件类名约定前缀（变体 className 里出现即违规） */
export const PI_VARIANT_CURSOR_CLASS_PREFIXES = ["cw-", "pi-"] as const

/** 允许的通用工具类白名单（「完全自写样式」口径下唯一放行的非自有 class；可后续按需加） */
export const PI_VARIANT_ALLOWED_UTILITY_CLASSES = ["sr-only"] as const

/**
 * Tailwind 工具类识别（启发式）：「完全自写样式」要求变体用自有 class + 自己的 CSS；
 * 出现 Tailwind 工具类（flex / p-2 / text-sm / bg-… / after:absolute / text-(length:…) 等）即违规。
 * 只用于扫描 className / cx() / cn() 表达式里的字符串 token，不扫 UI 文案。
 */
export function isTailwindUtilityClass(token: string): boolean {
  if (!token || token.includes("$")) return false
  // Tailwind 变体前缀（hover: / after: / group-hover: / data-[state=open]: …）先剥掉再判基础类
  let base = token
  for (;;) {
    const prefixed = base.match(/^(?:[a-z-]+|group-[a-z-]+|peer-[a-z-]+|data-\[[^\]]*\]|aria-\[[^\]]*\]|supports-\[[^\]]*\]):(.*)$/)
    if (!prefixed) break
    base = prefixed[1]
  }
  const roots =
    /^(?:-?(?:flex|grid|inline|block|contents|flow-root|table|isolate|fixed|absolute|relative|sticky|static|visible|invisible|collapse|hidden|overflow|overscroll|items|justify|content|self|place|gap|space|p[xytrbl]?|m[xytrbl]?|w|h|min|max|size|basis|grow|shrink|order|col|row|auto|text|font|leading|tracking|line|decoration|underline|overline|no-underline|uppercase|lowercase|capitalize|normal-case|truncate|whitespace|break|bg|from|via|to|border|rounded|divide|outline|ring|shadow|opacity|mix|blur|brightness|contrast|grayscale|invert|sepia|drop-shadow|backdrop|transform|origin|translate|rotate|skew|scale|transition|duration|ease|delay|animate|cursor|select|resize|scroll|snap|touch|pointer-events|appearance|accent|caret|fill|stroke|aspect|object|z|inset|top|right|bottom|left|float|clear|isolation|prose|not-sr-only|sr-only|group|peer|container|columns|box)(?:$|[-:/\[!(]))/
  return roots.test(base)
}

export type PiVariantClassVerdict = "own" | "allowed-utility" | "neutral" | "cursor-prefix" | "tailwind-utility"

/**
 * 变体 className 里的一个 class token 归类（纯函数；测试与变体线自查共用）：
 * - own：以变体自有前缀开头（claude- / cx-）；
 * - allowed-utility：白名单通用类（sr-only）；
 * - cursor-prefix：`cw-*` / `pi-*`（cursor 组件类名约定）→ 违规；
 * - tailwind-utility：Tailwind 工具类 → 违规（完全自写样式口径）；
 * - neutral：变体自定义的状态修饰词（如 `completed` / `primary`）或动态模板静态片段，放行。
 */
export function classifyVariantClassToken(token: string, id: PiUiIndependenceVariant): PiVariantClassVerdict {
  if (!token) return "neutral"
  if (token.startsWith(PI_VARIANT_OWN_CLASS_PREFIX[id])) return "own"
  if ((PI_VARIANT_ALLOWED_UTILITY_CLASSES as readonly string[]).includes(token)) return "allowed-utility"
  if ((PI_VARIANT_CURSOR_CLASS_PREFIXES as readonly string[]).some((prefix) => token.startsWith(prefix))) return "cursor-prefix"
  if (isTailwindUtilityClass(token)) return "tailwind-utility"
  return "neutral"
}

export type PiVariantCssImportVerdict = { ok: true } | { ok: false; reason: string }

/**
 * 变体样式入口（TSX 的 side-effect `import "./x.css"` 与 CSS 里的 `@import`）是否允许：
 * 只允许「解析后落在变体自己目录内」的相对样式；npm 包自带样式入口（@fontsource-*）属于第三方字体资源，放行；
 * `@/components/pi/**` 等路径别名、绝对路径、url(http…) 一律禁止。
 * 注意：调用方负责把 spec 解析成 target 后传 ownDir（测试 / scanner 已实现）。
 */
export function variantCssImportVerdict(spec: string, ownDir: boolean): PiVariantCssImportVerdict {
  if (ownDir) return { ok: true }
  if (!spec.startsWith(".") && !spec.startsWith("@/") && !spec.startsWith("/") && !/^[a-z]+:/i.test(spec)) {
    // 裸包名：只允许字体类第三方样式入口（与「字体可复用、cursor 样式不可复用」一致）
    return /^@fontsource[-/]/.test(spec) ? { ok: true } : { ok: false, reason: `第三方样式入口需在允许清单（目前只放行 @fontsource-*）：${spec}` }
  }
  return { ok: false, reason: `样式只能相对 import 变体自己目录内的文件（禁止 cursor / 绝对路径 / 网络样式）：${spec}` }
}
