# 74 · UI 变体扩展能力接口与接入文档（完整版 v1.3）

> **文档版本**：1.3（对应契约 1.2；最后核对：2026-10-26，**最终 HEAD `df41a6d`**；本版：术语/内部话术收口、能力描述按最终元数据同步、映射章节补实现位置、示例严格 `tsc --strict` 复验通过）
> **适用范围**：Pi-Remote 的**两套新 UI 变体**（Claude 风格 / Codex 风格）在 Cursor 风格界面之外新增的界面/功能面，其中一部分是 **Pi 目前没有的数据能力**——UI 已按参考设计做全，生产环境默认禁用，接入扩展（provider）后启用。
> **读者**：项目负责人、扩展开发者、两套 UI 的实现/验证线。
> **事实来源（以代码为准）**：`ui/src/pi/extensions/**`（能力 ID/数据契约/注册 API/禁用态/选择器/平台偏好/mock 注入）、`DOC/71-protocol-v4.md`（协议层，与本文的能力 ID 是两件事）、`full-parity-inventory.md`（117 个界面/功能点清单，维护用文档）。
> **红线**：本文只描述前端扩展契约，**不改 relay/协议、不承诺插件市场**；示例数据均为假数据。
>
> ⚠️ **最重要的一句话：生产部署的网页当前默认没有这些能力的数据源，因此对应 UI 是禁用态；要让它们可用，必须接入一个 provider（当前等价于自编译前端注册，见 §3.6）。** 开发/验收环境可用 mock（`?caps=`）完整演示（§3.5）。

## 0. 怎么读这份文档

| 你是谁 | 建议路径 |
|---|---|
| **项目负责人 / 产品** | §1 总览（哪些能力 Pi 没有、为什么禁用）→ §2 状态与禁用态 → §6 映射关系（设备平台标签、运行位置、工作模式）→ §7 版本策略 |
| **扩展开发者（要补能力）** | §1.3 术语 → §3 快速开始（注册最小 provider）→ §4 对应能力卡片（数据契约/动作/错误）→ §8 完整示例（产出物/计划任务/PR） |
| **两套 UI 实现线** | §2（状态/禁用态/选择器）→ §4 每张卡片的「落位/API/启用前后差异」→ §6 映射 |
| **验证 / 终审** | §3.3 三步验证 → §2.8 稳定选择器 → §4 每卡片「mock 验证」→ 附录 A 能力速查 |

章节目录：

| 章 | 内容 | 锚点 |
|---|---|---|
| 1 | 总览：能力清单（40 项）、为什么禁用、术语 | `#overview` `#capability-list` |
| 2 | 能力状态语义、禁用态/模拟态契约、稳定选择器 | `#capability-status` `#disabled` |
| 3 | 快速开始：注册 provider、验证解锁、mock 注入 | `#quickstart` |
| 4 | 能力目录与数据契约（40 张卡片） | `#cap-<id>` × 40 |
| 5 | 接入实现建议（数据从哪来、探测/降级、安全/性能） | `#integration` |
| 6 | 与既有功能的关系：设备平台标签、工作模式、运行位置 | `#device-platform` `#cowork` `#codex-runtime` |
| 7 | 接口版本与兼容策略 | `#versioning` |
| 8 | 完整示例：产出物 / 计划任务 / PR | `#examples` |
| 9 | FAQ 与排错 | `#faq` |
| 附录 A–D | 能力速查+能力对照 / 术语 / 选择器与错误 / 变更记录 | `#appendix-a` |

---

## 1. 总览

### 1.1 一句话

Pi-Remote 现有三套可切换的界面：Cursor 风格（现有）、Claude 风格、Codex 风格。两套新界面按参考 app 的设计文档把**每一屏、每个功能**都做了出来；其中 31 项功能面 需要 Pi 当前没有的数据能力（产出物、Browser、Plan、PR、计划任务、扩展、连接器…）。规则是：

> **UI 完整做出来 → 生产默认禁用并解释原因 → 接入扩展（或 dev/mock）后启用。**

### 1.2 两层架构：皮肤层与能力层

```
┌────────────────────────────────────────────────────────────┐
│ 皮肤层（三套 UI，各自自包含、互不 import）                    │
│   cursor 风格（现有）  │  Claude 变体  │  Codex 变体          │
└──────────────┬─────────────────────┬───────────────────────┘
               │  都读同一份能力状态  │
┌──────────────▼─────────────────────▼───────────────────────┐
│ 能力层（共享契约 @/pi/extensions，与皮肤无关）                │
│  40 个能力 ID + 状态（available / unavailable / simulated）  │
│  provider 注册表（生产默认空 → 扩展类能力全禁用）             │
│  数据/动作契约 + 禁用态契约 + 稳定选择器 + mock 注入           │
└────────────────────────────────────────────────────────────┘
```

- **能力层不依赖皮肤**：注册一次 provider，切三套 UI 都生效；切换 UI 变体不影响能力状态。
- **皮肤层不依赖数据来源**：变体只消费「能力状态 + 数据契约 + 禁用态契约」，不关心数据从哪来。
- **参考设计的专属视觉**属于皮肤层，各自实现；能力层只管数据与状态。

### 1.3 术语表

| 术语 | 含义 | 不是什么 |
|---|---|---|
| **能力（capability）** | 一项需要状态化门的 UI 功能面，用稳定 ID 标识（如 `artifacts`） | 不是 UI 组件；不是协议帧 |
| **能力状态** | `available`（可用）/ `unavailable`（禁用态）/ `simulated`（模拟演示） | 不是「加载中」或「空数据」 |
| **provider** | 某项能力的数据源实现：`getData` + 可选 `subscribe`/`getActions`/`onEvent` | 不是 UI 组件；不返回 JSX/样式 |
| **扩展（extension）** | 一个 provider 的打包身份（`id`/`name`/能力集合）；注册/注销即接入/移除 | 不是 pi 的进程内扩展（那是数据来源之一，见 §5） |
| **builtin 能力** | 9 项 Pi 现有数据/UI 直供的能力（默认 `available`） | 不是「不需要 UI」 |
| **extension 能力** | 31 项需要 provider 的能力（生产默认 `unavailable`） | 不是「永远不可用」 |
| **禁用态** | 无 provider 时的呈现：可见、不可操作、给原因 + 「如何接入」 | 不是隐藏、不是假数据、不是错误态 |
| **模拟态** | dev/mock provider 注入：可完整操作，但标「模拟演示」 | 不是真实数据；不进生产包 |
| **变体** | 三套 UI 皮肤之一（cursor / claude / codex） | 不是能力状态的一部分 |
| **设备平台标签** | 参考设计「Chat/Cowork/Code 三标签」的 Pi-Remote 映射：全部 / macOS / Windows / Linux | 不是协议 `caps`（见下条） |
| **协议 `caps`** | relay/设备能力协商（`DOC/71-protocol-v4.md` 握手字段） | **和本文「能力 ID」是两件事**：`caps` 管设备/relay 支持什么，能力 ID 管 UI 扩展提供什么 |

### 1.4 能力清单（40 项，契约 `PI_UI_CAPABILITY_IDS`）

> 状态列口径：**默认状态** = 无 provider 时（`defaultStatus`）；`/ 可模拟演示` 表示该能力在 dev mock 注入后可完整演示（契约字段 `ledgerStatus`）。**builtin 9 项不需要 provider**；其余 31 项需 provider（`PI_UI_CAPABILITY_PROVIDER_IDS`）。

| 能力 id | 名称 | 分组 | 来源 | 默认状态 | 锚点 |
|---|---|---|---|---|---|
| `device-platform-tabs` | 设备平台标签 | pane | builtin（无需 provider） | available | [`#cap-device-platform-tabs`](#cap-device-platform-tabs) |
| `workspace-modes` | 会话 / 任务 / 工作台 | pane | builtin（无需 provider） | available | [`#cap-workspace-modes`](#cap-workspace-modes) |
| `pane-workspace` | 多窗格工作台 | pane | extension（provider） | unavailable | [`#cap-pane-workspace`](#cap-pane-workspace) |
| `pane-dock-drag` | 窗格拖拽与停靠 | pane | extension（provider） | unavailable（可模拟演示） | [`#cap-pane-dock-drag`](#cap-pane-dock-drag) |
| `artifacts` | 产出物 | content | extension（provider） | unavailable（可模拟演示） | [`#cap-artifacts`](#cap-artifacts) |
| `browser-pane` | 设备端浏览器工具 | pane | extension（provider） | unavailable | [`#cap-browser-pane`](#cap-browser-pane) |
| `plan-pane` | 计划 / 进度 | content | extension（provider） | unavailable（可模拟演示） | [`#cap-plan-pane`](#cap-plan-pane) |
| `side-chat` | 侧边对话 | workflow | extension（provider） | unavailable（可模拟演示） | [`#cap-side-chat`](#cap-side-chat) |
| `subagents-panel` | 子 agent 状态（只读） | workflow | extension（provider） | unavailable（可模拟演示） | [`#cap-subagents-panel`](#cap-subagents-panel) |
| `automations` | 计划任务 | workflow | extension（provider） | unavailable | [`#cap-automations`](#cap-automations) |
| `pr-review` | 代码审查 | integration | extension（provider） | unavailable（可模拟演示） | [`#cap-pr-review`](#cap-pr-review) |
| `git-commit` | Git 提交链路 | integration | extension（provider） | unavailable | [`#cap-git-commit`](#cap-git-commit) |
| `plugins` | 扩展 | integration | extension（provider） | unavailable | [`#cap-plugins`](#cap-plugins) |
| `connectors` | 连接器 | integration | extension（provider） | unavailable | [`#cap-connectors`](#cap-connectors) |
| `skills` | 技能 | integration | extension（provider） | unavailable（可模拟演示） | [`#cap-skills`](#cap-skills) |
| `permission-tiers` | 审批策略 | customization | extension（provider） | unavailable | [`#cap-permission-tiers`](#cap-permission-tiers) |
| `density-modes` | 密度模式 | customization | builtin（无需 provider） | available | [`#cap-density-modes`](#cap-density-modes) |
| `suggestions` | 建议词 | content | extension（provider） | unavailable（可模拟演示） | [`#cap-suggestions`](#cap-suggestions) |
| `code-review-comments` | 代码审查评论 | workflow | extension（provider） | unavailable（可模拟演示） | [`#cap-code-review-comments`](#cap-code-review-comments) |
| `background-tasks` | 后台任务 | workflow | builtin（无需 provider） | available | [`#cap-background-tasks`](#cap-background-tasks) |
| `mcp-tools` | MCP 工具 | integration | builtin（无需 provider） | available | [`#cap-mcp-tools`](#cap-mcp-tools) |
| `context-usage` | 上下文用量 | content | builtin（无需 provider） | available | [`#cap-context-usage`](#cap-context-usage) |
| `model-menu` | 模型 / 强度菜单 | content | builtin（无需 provider） | available | [`#cap-model-menu`](#cap-model-menu) |
| `file-editor` | 文件编辑器 | content | extension（provider） | unavailable | [`#cap-file-editor`](#cap-file-editor) |
| `file-preview` | 文件查看 | content | builtin（无需 provider） | available | [`#cap-file-preview`](#cap-file-preview) |
| `worktree` | git worktree（隔离副本） | workflow | extension（provider） | unavailable | [`#cap-worktree`](#cap-worktree) |
| `multi-tab` | 多标签页 | pane | extension（provider） | unavailable | [`#cap-multi-tab`](#cap-multi-tab) |
| `theme-custom` | 主题自定义 | customization | extension（provider） | unavailable（可模拟演示） | [`#cap-theme-custom`](#cap-theme-custom) |
| `session-pin` | 会话置顶 | workflow | extension（provider） | unavailable（可模拟演示） | [`#cap-session-pin`](#cap-session-pin) |
| `terminal-interactive` | 设备端终端（只读） | pane | extension（provider） | unavailable（可模拟演示） | [`#cap-terminal-interactive`](#cap-terminal-interactive) |
| `dictation` | 听写 | content | extension（provider） | unavailable | [`#cap-dictation`](#cap-dictation) |
| `work-mode` | 运行位置 | workflow | builtin（无需 provider） | available | [`#cap-work-mode`](#cap-work-mode) |
| `workspace-connectors` | 连接 rail 卡 | integration | extension（provider） | unavailable | [`#cap-workspace-connectors`](#cap-workspace-connectors) |
| `device-code-login` | Pi 配对 | integration | extension（provider） | unavailable（可模拟演示） | [`#cap-device-code-login`](#cap-device-code-login) |
| `subagent-orchestration` | 多代理编排 | workflow | extension（provider） | unavailable（可模拟演示） | [`#cap-subagent-orchestration`](#cap-subagent-orchestration) |
| `git-stage` | Git 暂存 | integration | extension（provider） | unavailable（可模拟演示） | [`#cap-git-stage`](#cap-git-stage) |
| `thread-fork-feedback` | 会话分叉与反馈 | workflow | extension（provider） | unavailable（可模拟演示） | [`#cap-thread-fork-feedback`](#cap-thread-fork-feedback) |
| `session-rail-extra` | 会话侧栏扩展 | pane | extension（provider） | unavailable | [`#cap-session-rail-extra`](#cap-session-rail-extra) |
| `notifications` | 通知规则 | customization | extension（provider） | unavailable | [`#cap-notifications`](#cap-notifications) |
| `terminal-panes` | 多终端（实例） | pane | extension（provider） | unavailable | [`#cap-terminal-panes`](#cap-terminal-panes) |

> 完整「能力对照 ↔ 契约」映射（34 语义 + 3 candidate + 3 契约扩展）见附录 A；早期预览版曾用别名；正式 ID 与能力对照表逐字一致（别名仅见 `PI_UI_LEGACY_CAPABILITY_ALIASES`）。

### 1.5 「生产默认禁用」到底是什么意思

- **不是坏了**：对应 UI 完整存在（布局/视觉/交互都按设计做），只是数据源未接入，所以显示禁用态（标题「本机 pi 未提供此能力」+ 原因 + 「如何接入」）。
- **不是隐藏**：隐藏等于没做；本轮验收要求是「UI 可见、可解释、可接入」。
- **不是假数据**：生产环境绝不显示看起来像真实的占位；模拟数据只在 dev/mock（`?caps=`）出现，并带「模拟演示」标识。
- **不需要刷新**：注册 provider 后能力状态实时变化、UI 自动解锁；注销后回落禁用态。

### 1.6 为什么 Pi 没有的能力也把 UI 做出来

用户要求（2026-10-26）：「参考设计文档里的每一屏/每个功能都要做出来，不要死板克隆，要结合 Pi-Remote 做映射；Pi 目前没有的能力也要有完整 UI，运行时禁用并提示『本机 pi 未提供此能力，可接入扩展』」。落地原则：

1. **不克隆要映射**：参考概念先映射到 Pi-Remote 语义（设备/平台/会话/文件夹/任务），映射依据写在第 6 章与能力对照表。
2. **UI 完整**：布局/视觉/交互按设计文档做全；禁用只是「不执行」，不是「不画」。
3. **可解释、可接入**：每块禁用界面 都能落到本文档某个 `#cap-<id>` 或映射锚点。
4. **可演示**：dev/mock 下全部可走通，供设计/验收看效果。
5. **生产不猜**：默认无 provider = 禁用；不塞假数据冒充真实能力。

### 1.7 与其它文档、版本与反馈

| 文档 | 关系 |
|---|---|
| `readyUI/data-interface.md` | Pi 现有命令/事件全表（builtin 能力与「现有能力」的依据） |
| `DOC/60-ui-enhancement.md` | 旧界面的功能增强设计（弹窗/状态条/命令中心），本文不重复 |
| `DOC/70-interface-v4-plan.md`、`DOC/71-protocol-v4.md` | 数据接口/协议演进；**协议 `caps` ≠ 本文能力 ID** |
| `DOC/20-local-device.md` | macOS 本机链路审查（设备/配对/attach 背景） |
| `DOC/75-usage-activity.md` | 设置页「使用活动」：本机聚合口径、隐私边界、协议能力位 `usage.activity.v1` 接入说明（内置数据能力，不登记为本文的 provider 能力） |
| `full-parity-inventory.md`（任务目录，非产品文档） | 117 个界面/功能点清单、适配映射、能力状态、mock 需求、验收矩阵 |

- 文档版本 1.0，对应契约 1.x；变更记录见附录 D。
- 发现文档与实现不一致：以**代码/契约**为准，在附录 D 记录差异；能力增删需求走 §7 变更流程。

---

## 2. 能力状态语义与禁用态

> 锚点 `#capability-status` / `#disabled`。实现：`ui/src/pi/extensions/{capabilities,registry,disabled,selectors}.ts`。

### 2.1 三种状态与判定规则

| 状态 | 含义 | 谁来产生 | 生产默认 | 用户感知 |
|---|---|---|---|---|
| `available` | 可用 | builtin 能力（Pi 现有数据直供）或真实 provider 注册（`mode` 缺省/`"available"`） | **9 项 builtin** | 界面正常可用，无禁用/模拟标记 |
| `unavailable` | 本机 pi 没有提供 | 该能力无 provider（31 项 extension 的默认） | **31 项 extension** | 可见但不可操作：统一禁用态 + 原因 + 「如何接入」 |
| `simulated` | 模拟数据 | dev mock provider（`mode: "simulated"`） | 否（生产不含 mock） | 界面可完整走通 + 「模拟演示」标识 |

判定规则（`registry.ts`）：

1. **状态是解析出来的**：`piUiCapabilityStatusOf(id, providers)` 从后往前找第一个提供该能力的 provider → 有则按其 `mode` 返回 `available`/`simulated`；无则回落 `piUiCapabilityMetaOf(id).defaultStatus`（builtin=`available`，extension=`unavailable`）。
2. **多 provider 同能力：最后注册者优先**；同一 provider `id` 重复注册 = 覆盖（热更新场景）。
3. **注销回落**：`unregisterPiUiExtension(id)` 后回落到下一个 provider；没有则回 `defaultStatus`。UI 必须能来回切换不残留。
4. **切换 UI 变体不影响能力状态**：能力层共享，claude/codex/cursor 读同一份 `usePiUiCapabilities()`。
5. **能力 ID 覆盖的是「需要状态化门的界面」**：模型菜单、斜杠菜单、附件等纯 UI 不在 40 项内；builtin 能力也不需要任何人写 provider。

```
未注册 provider ──register(provider)──▶ available / simulated
      ▲                                        │
      └──────── unregister(id) ◀───────────────┘
                    （多 provider：回落到下一个；否则回 defaultStatus）
```

### 2.2 能力元数据（每项能力的「身份证」）

`ui/src/pi/extensions/capabilities.ts` 的 `PI_UI_CAPABILITIES`（顺序 = 文档/设置页/验收矩阵顺序）：

| 字段 | 类型 | 用途 |
|---|---|---|
| `id` | 能力 ID（联合类型） | **契约主键，v1 冻结**；文档锚点 `#cap-<id>` |
| `label` | string | 展示名（禁用态标题、设置页行名） |
| `group` | `pane`/`content`/`workflow`/`customization`/`integration` | 文档第 4 章分组、设置页扩展区分组 |
| `description` | string | 一句话说明 |
| `source` | `builtin` / `extension` | 决定 `defaultStatus` 与是否 `providerBacked` |
| `providerBacked` | boolean | 是否需要 provider（extension=true，31 项） |
| `ledgerStatus` | `available`/`unavailable`/`simulated` | 注入后口径（mock/扩展状态，用于「两列状态」） |
| `defaultStatus` | `available`/`unavailable` | 无 provider 时的状态（builtin=available；extension=unavailable） |
| `docAnchor` | string | `#cap-<id>`，禁用态「如何接入」链接目标 |
| `unavailableReason` | string | 为什么没有（显示在禁用态） |

计数一律从常量派生，不手写：`PI_UI_CAPABILITY_IDS.length`（40）、`PI_UI_CAPABILITY_PROVIDER_IDS.length`（31）、`PI_UI_CAPABILITY_CONTRACT_IDS.length`（9）。

### 2.3 两列状态口径（生产默认 vs 注入后，别混）

| 列 | 谁说了算 | 含义 | 本文档位置 |
|---|---|---|---|
| **生产默认状态** | `defaultStatus` | 无 provider 时；extension=`unavailable`、builtin=`available` | 第 4 章每张卡片顶栏、§1.4 表 |
| **注入后状态** | `ledgerStatus` | dev mock 或真实扩展注入后的状态（`simulated` = 可 mock 完整演示） | 第 4 章卡片顶栏 |

写法示例：「生产默认：禁用态（本机 pi 未提供）；开发/验收：`?caps=artifacts` → 模拟可操作；接入扩展后：可用」——**禁止**把 `simulated` 写成「生产可用」。

### 2.4 禁用态 / 模拟态契约（两变体共用文案，各自写视觉）

`ui/src/pi/extensions/disabled.ts`：`piUiDisabledStateOf(capability, status)`（`available` 返回 `null`）返回渲染所需全部信息：

| 字段 | unavailable | simulated |
|---|---|---|
| `title` | 本机 pi 未提供此能力 | 模拟演示：未接入真实扩展 |
| `hint` | 当前版本不内置该能力；接入扩展后启用，或在开发环境用 mock 预览。 | 当前展示的是开发用 mock 数据，仅用于预览与验收，不代表真实数据。 |
| `reason` | 能力元数据 `unavailableReason` | 同上（可覆盖原因） |
| `howToConnectLabel` | 如何接入 | — |
| `docAnchor` / `docsPath` | `#cap-<id>` / `DOC/74-ui-variants-extension.md#cap-<id>` | 同左 |
| `simulated` | false | true（显示「模拟演示」徽标） |

**两套变体只允许在「长什么样」上不同，文案/语义必须一致**（跨变体一致性硬约束，也是验证线抽查点）。禁止变体自己写死「未提供」文案或另造状态枚举。

**视觉参考（最终以两变体截图为准，见各变体自查表）**：

```
Claude（暖纸面，S2 白卡 + 双环，衬线标题）      Codex（灰阶，12 圆角 + 0.5px 描边，系统字）
┌───────────────────────────┐                ┌───────────────────────────┐
│  ○  Browser               │                │  Browser                  │
│                           │                │                           │
│    本机 pi 未提供此能力    │                │   本机 pi 未提供此能力     │
│    当前版本不内置该能力；   │                │   当前版本不内置该能力；    │
│    接入扩展后启用…         │                │   接入扩展后启用…          │
│    → 如何接入              │                │   → 如何接入               │
└───────────────────────────┘                └───────────────────────────┘
```

### 2.5 禁用态的三种落位

| 落位 | 用在哪 | 禁用时表现 | 模拟态表现 |
|---|---|---|---|
| 整块窗格/面板/页面 | 设备端浏览器工具、产出物 面板、PR 详情、计划任务 页 | 面板仍在（可开关），内部居中禁用卡；不显示假数据、不显示空列表 | 正常渲染 mock 内容 + 「模拟演示」条 |
| 单按钮/单控件 | 窗格拖拽、审批策略、Review 动作 | 可见但禁用，hover/点击给原因，不隐藏 | 可点，动作走 mock，带模拟标识 |
| 卡片内行/条目 | session rail 扩展条目、composer 建议、设置页能力行 | 行可见、置灰、右侧「未接入」+ 点击进说明 | 行可用，带模拟标 |

### 2.6 禁用 ≠ 隐藏 ≠ 假数据 ≠ 空态

| 状态 | 触发条件 | 视觉语言 | 用户可做什么 | 数据来源 |
|---|---|---|---|---|
| 禁用态 `unavailable` | 无 provider | 灰化 + 「未提供」卡 + 接入链接 | 接入扩展 / 看文档 / dev 开 mock | 无 |
| 模拟态 `simulated` | dev mock | 正常 UI + 「模拟演示」标识 | 全流程试用（假数据） | mock fixtures |
| 空态 | provider 在、列表为空 | 「还没有内容」+ 可选动作 | 创建/刷新 | provider |
| 加载态 | 拉取/刷新中 | 骨架/进度（变体自写） | 等待 | provider |
| 错误态 | provider 抛错/数据不合法/超时 | 「加载失败」+ 原因 + 重试 | 重试（有界） | provider |

**不隐藏**（隐藏等于没做）、**不塞假数据**（分不清「没数据」和「没能力」）、**可解释可行动**（状态+原因+出路三件套）。

### 2.7 模拟态（simulated）边界与 mock 注入开关

1. **只在 dev/mock/验收出现**；生产包不含 mock（mock 模块只从 dev/画廊入口动态 import，生产入口不接线）。当前自动注入挂在**画廊入口** `ui/src/pi/dev/main.tsx`。
2. **开关**（`?caps=` URL 优先，localStorage 次之）：
   - `?caps=all`（请求全部；**实际只注入 31 项 provider-backed**，9 项 builtin 保持 available、不注入——避免「冒充」）或 `?caps=artifacts,browser-pane`（逗号分隔，非法 id 忽略）；
   - localStorage 键 `pi_dev_ui_mock_caps`，值 `all` / 能力列表 / `1`（=all）。
3. **mock provider**：`id = "pi-ui-mock"`、只覆盖 **31 项 provider-backed**（`PI_UI_CAPABILITY_PROVIDER_IDS`）、`mode:"simulated"`、确定性 fixtures（固定 `PI_UI_DEMO_NOW`）；有状态 store 支持动作/订阅/事件。
4. **视觉必须可区分**：模拟标识不能只靠颜色（色弱可读性），必须有文字。
5. 详见 §3.5（安装 API 与生产核验）。

### 2.8 稳定选择器（两变体/mock/验证线统一）

`ui/src/pi/extensions/selectors.ts`——所有带行为/可测语义的 DOM 只用这些属性，禁止各线自行起名：

| 属性 | 语义 |
|---|---|
| `data-p4-surface` | 可测界面元素根（值 = 能力对照表的界面编号，如 `CL-CODE-02`） |
| `data-p4-action` | 动作按钮/可点区域（语义动作名，如 `artifacts.open`） |
| `data-p4-row` / `data-p4-pane` | 列表行 / 窗格 |
| `data-pi-capability` + `data-capability-state` | 能力界面 与其状态（available/unavailable/simulated） |
| `data-pi-capability-disabled` | 禁用态容器（存在即禁用；与 state 配套） |
| `data-p4-ready` | 界面就绪（截图/e2e 等它） |

Helper：`piUiSurfaceAttrs({surface, action?, row?, pane?})`、`piUiCapabilityAttrs(capability, status)`（非 available 自动带 disabled 属性）、`piUiReadyAttr(ready)`。

### 2.9 用户怎么查能力状态

```ts
import { piUiCapabilities, piUiCapabilityStatusOf } from "@/pi/extensions"
// 或组件内：const caps = usePiUiCapabilities()

piUiCapabilityStatusOf("artifacts")     // "unavailable" | "available" | "simulated"
piUiCapabilities().list()               // 40 项能力 + meta + state（设置页/验收矩阵用）
piUiCapabilities().disabledOf("artifacts")  // unavailable/simulated → 禁用态契约；available → null
piUiCapabilities().dataOf("artifacts")      // provider 数据快照（未提供 = undefined）
piUiCapabilities().actionsOf("artifacts")   // provider 动作（未提供 = null = 只读）
```

### 2.10 验证方法（写进验收）

截图三态：① 生产默认（无 provider）禁用卡；② `?caps=<id>` 同屏模拟态；③ 注册真实 provider 后同屏可用；④ 注销后回禁用态。DOM 断言：`[data-pi-capability="<id>"][data-capability-state="unavailable"]` 存在且带 `data-pi-capability-disabled`；`data-p4-ready` 出现后再截图。

---

## 3. 快速开始：注册一个 provider

> 锚点 `#quickstart`。目标：让你在 10 分钟内把**一项能力从禁用态变成可用**，并知道自己在什么环境里能做到。
> 契约：`registerPiUiExtension` / `PiUiExtensionProvider` / `PiUiCapabilityProvider`（`ui/src/pi/extensions/{registry,types}.ts`）。

### 3.1 结果预览

接入前（生产默认，无 provider）：

```
┌───────────────────────────────┐
│  产出物                    │
│                               │
│   本机 pi 未提供此能力          │
│   当前版本不内置该能力；         │
│   接入扩展后启用，或在开发       │
│   环境用 mock 预览。            │
│   → 如何接入                   │  ← 链接到本文档 #cap-artifacts
└───────────────────────────────┘
```

接入后（`registerPiUiExtension`）：同一块 UI 变可用；`statusOf("artifacts") === "available"`；「如何接入」消失；注销后回到禁用态。

### 3.2 前置：先确认你在哪个环境（很重要）

| 环境 | 能做什么 | 说明 |
|---|---|---|
| **开发环境**（`ui/` 下 `npm run dev` / 画廊 `gallery.html`） | ① mock 演示（`?caps=`；自动注入只在画廊入口 `ui/src/pi/dev/main.tsx`）；② 在 dev 代码里注册自写 provider | 推荐先走这条，最快看到效果 |
| **自托管 / 自编译网页** | 在自己维护的 `ui/src` 里 import 契约并注册 provider → `npm run build` → 部署自己的静态资源 | **当前唯一能上生产的接入方式**：provider 代码随前端构建 |
| **生产部署网页（默认）** | **不能**动态注入 provider（无插件加载器/无 window 暴露入口） | 页面里所有 extension 能力 = 禁用态，这是设计默认，不是 bug |
| **未来 relay/pi 扩展** | 方向（协议未定） | 见 §5，不承诺 |

> ⚠️ 再次强调：生产网页目前**默认禁用**这些能力；需接入扩展（当前等价于自编译前端注册，见 §3.6）后启用。

### 3.3 最小 provider（产出物，约 20 行）

```ts
// 1) 从契约出口导入（路径以仓库为准：@ 指 ui/src）
import { registerPiUiExtension } from "@/pi/extensions"

// 2) 注册一个 provider：id 全局唯一；一个 provider 可提供多个能力
registerPiUiExtension({
  id: "example.artifacts",           // 稳定、全局唯一；重复注册 = 覆盖
  name: "示例 产出物 扩展",        // 展示名（设置页/排查时用，可选）
  capabilities: {
    artifacts: {
      // 数据快照：UI 每次渲染读一次；必须幂等、只读、无副作用
      getData: () => ({
        artifacts: [
          {
            id: "a1",
            title: "示例产物",
            kind: "markdown",
            updatedAt: Date.now(),
            content: "# 你好\n\n这是来自 provider 的产物正文。",
          },
        ],
      }),
      // 动作回调（可选）：UI 按需调用；不实现 = 只读
      getActions: () => ({
        openArtifact: (id) => console.log("open artifact", id),
      }),
      // 实时更新（可选）：数据变化时通知 UI 重新 getData
      // subscribe: (listener) => {
      //   const timer = setInterval(listener, 5_000)
      //   return () => clearInterval(timer)
      // },
    },
  },
})

// 3) 注销（dev 调试 / 验收回落）：用同一个 id
// 注销：unregisterPiUiExtension("example.artifacts")（需单独 import；见 §3.7）
```

要点：

- **`registerPiUiExtension` 没有返回值**；注销用 `unregisterPiUiExtension(id)`；测试/清理可用 `resetPiUiExtensions()`。
- **能力 ID 必须来自契约 40 项**（`PI_UI_CAPABILITY_IDS`）；拼错直接抛 `PiUiExtensionError`（`problems` 列出原因）。
- **`getData()` 只返回数据**，不要在里面发请求/改全局；异步数据先缓存，再通过 `subscribe` 通知重取。
- 带 `mode: "simulated"` 的 provider 会显示「模拟演示」标识（仅 dev/mock 使用）。

### 3.4 Provider 注册 API 参考

**`registerPiUiExtension(provider: PiUiExtensionProvider): void`**

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 扩展 id（稳定、全局唯一；重复注册以最后一次为准） |
| `name` | 否 | 展示名 |
| `capabilities` | 是 | `{ [能力ID]: PiUiCapabilityProvider }`，至少一项 |

**`PiUiCapabilityProvider`**

| 字段 | 必填 | 说明 |
|---|---|---|
| `mode` | 否 | `"available"`（默认）/ `"simulated"`（dev/mock 演示） |
| `getData()` | 是 | 返回该能力数据快照（契约见第 4 章 `PiUiCapabilityDataMap`） |
| `subscribe(listener)` | 否 | 数据变化通知；返回取消订阅函数；缺省=静态数据 |
| `getActions()` | 否 | 返回动作回调（`PiUiCapabilityActionMap`）；缺省/缺字段=只读 |
| `onEvent(listener)` | 否 | 扩展事件流 `{ capability, type, payload?, at }`；返回取消订阅 |

**其它导出**：`unregisterPiUiExtension(id): boolean`、`resetPiUiExtensions()`、`piUiCapabilityStatusOf(id)`、`piUiExtensionBindingOf(id)`、`piUiCapabilities()`、`piUiCapabilitiesOf(providers, version)`、`usePiUiCapabilities()`（React hook）、`piUiExtensionProblems(provider)`（纯校验，返回问题清单）、`PiUiExtensionError`（`problems: string[]`）。

### 3.5 Mock 注入（dev/画廊/e2e；生产包不含）

```ts
import { installPiUiExtensionMock, uninstallPiUiExtensionMock } from "@/pi/extensions/mock"

// 显式安装（mock 线/e2e/画廊静态 build 直接用）
installPiUiExtensionMock({ caps: ["artifacts", "browser-pane"], mode: "simulated", source: "url" })
// 卸载后恢复禁用态（真实 provider 不受影响）
uninstallPiUiExtensionMock()
```

自动安装：**画廊入口 `ui/src/pi/dev/main.tsx` 已接线**（`force: true` 同时支持 dev server 与 `PI_GALLERY=1` 静态 build；URL query 与 hash 内的 `caps=` 都会被解析）：

```ts
import { installPiUiExtensionMockIfRequested } from "@/pi/extensions/mock"

// 画廊入口已接线（示例，实际见 ui/src/pi/dev/main.tsx）
const hashQuery = location.hash.includes("?") ? location.hash.split("?")[1] ?? "" : ""
const mockSearch = [location.search.replace(/^\?/, ""), hashQuery].filter(Boolean).join("&")
const installed = installPiUiExtensionMockIfRequested({ force: true, search: mockSearch, storage: localStorage })
console.log("mock installed:", installed) // 画廊入口另写 window.__PI_GALLERY_MOCK__ = { installed, caps, source }
```

- 打开方式：dev server 下 `…/gallery.html?caps=all` 或 `…/gallery.html#/live/<id>?ui=claude&caps=all` 都会自动注入；
- **产品入口 `ui/src/pi/main.tsx` 不 import mock** → 生产/产品入口无 mock（构建产物核验见下）；
- 其它自定义 dev 入口可用同款写法：`if (import.meta.env.DEV) void import("@/pi/extensions/mock").then((m) => m.installPiUiExtensionMockIfRequested())`。

| 开关 | 值 | 说明 |
|---|---|---|
| URL | `?caps=all` / `?caps=artifacts,browser-pane` | URL 优先；`all` 只注入 31 项 provider-backed（builtin 保持 available） |
| localStorage | `pi_dev_ui_mock_caps = "all" \| "artifacts,…" \| "1"` | `"1"` = 全部；同样只影响 provider-backed |
| mock provider id | `pi-ui-mock` | 只注入 31 项 provider-backed，`mode:"simulated"`，fixtures 确定性（固定 `PI_UI_DEMO_NOW`） |

**生产包核验**：构建产物 grep 无 `pi-ui-mock` / `PI_UI_DEMO_FIXTURES` / `pi_dev_ui_mock_caps`（应 0 命中）。mock 只允许从 dev/画廊入口动态 import，**变体目录禁止 import `@/pi/extensions/mock`**（守卫有负例测试）。

**可复跑验证（主检出）**：

```bash
node --test test/pi-ui-extensions.test.mjs   # 契约 + DOC 锚点 + mock 接线守卫：27/27
cd ui && npm run dev                          # 画廊：http://localhost:5173/gallery.html?caps=all
                                              # 也可 #/live/<screen>?ui=claude&caps=all（hash 内 caps）
```

- 画廊页面顶部/控制台会打印 `[pi mock] simulated N provider-backed 能力（source=url|storage）`；`window.__PI_GALLERY_MOCK__` 可断言 `{ installed, caps, source }`。
- 没有 mock 时画廊同样可开（全部 extension 能力禁用态）；mock 只影响 provider-backed，不影响 builtin。

### 3.6 三条接入路径（成熟度递减，如实写）

| 路径 | 现在能不能用 | 怎么做 | 生产适用性 |
|---|---|---|---|
| ① dev/mock（`?caps=`） | ✅ | 打开 dev/画廊带 `?caps=…`；见 §3.5 | 否（mock 不进生产包） |
| ② 自编译前端注册 | ✅ 当前唯一生产路径 | 在自己维护的 `ui/src` 里 import 契约并注册（启动入口/插件文件），`npm run build` 后部署自己的静态资源 | 是（provider 代码随构建；数据源由你的扩展/服务提供） |
| ③ 浏览器 console 动态注入 | ❌ 当前不可用 | 契约层没有 `window` 暴露入口，部署好的页面无法 import TS 模块 | 不承诺 |
| ④ pi 扩展 / 未来 relay 协议 | ❌ 未实现 | 方向：pi 进程内扩展采集 → relay 帧下发 → 前端 provider 适配（协议未定） | 只写方向，不承诺 |

### 3.7 验证解锁（固定三步，配截图）

```ts
import { piUiCapabilities, registerPiUiExtension, unregisterPiUiExtension } from "@/pi/extensions"

// ① 接入前：期望 unavailable / 对应 UI 禁用态
piUiCapabilities().statusOf("artifacts")
piUiCapabilities().disabledOf("artifacts")   // 非空 = 渲染禁用态

// ② 注册后：期望 available（或 simulated）；UI 自动解锁，无需刷新（完整 provider 见 §3.3）
registerPiUiExtension({
  id: "example.artifacts",
  capabilities: { artifacts: { getData: () => ({ artifacts: [] }) } },
})
piUiCapabilities().statusOf("artifacts")

// ③ 注销后：期望回 unavailable；UI 回禁用态（防残留）
unregisterPiUiExtension("example.artifacts")
```

| 步骤 | 期望状态 | 期望 UI | 截图 |
|---|---|---|---|
| ① 接入前 | `unavailable` | 禁用卡/按钮：标题+原因+「如何接入」 | A |
| ② 注册后 | `available`（或 `simulated`） | 可交互；模拟态带「模拟演示」 | B |
| ③ 注销后 | `unavailable` | 回禁用态，无假数据残留 | C |

DOM 断言（验证线用）：`[data-pi-capability="artifacts"][data-capability-state="unavailable"][data-pi-capability-disabled]` → 注册后变 `[data-capability-state="available"]` 且无 disabled 属性。

### 3.8 常见失败与排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 注册抛 `PiUiExtensionError` | 能力 id 拼错/缺 `getData`/`mode` 非法/`capabilities` 为空 | 读错误 `problems` 列表逐条修 |
| 注册成功但 UI 没变 | 该界面 的 UI 还没接能力层（界面尚未接入）/ 注册的不是目标能力 ID | `piUiCapabilities().list()` 查状态；对照第 4 章卡片「UI 解锁点」 |
| 一直 `unavailable` | provider 没执行（代码没进构建/模块未加载） | 注册函数旁打日志；检查构建入口是否 import |
| 控制台报能力数据错 | `getData()` 形状不符（必填缺/类型错） | 对照第 4 章「数据契约」字段表 |
| 生产出现模拟数据 | mock 被 static import 进生产入口 | 只从 dev 入口动态 import；构建产物 grep 核验 |
| 注销后 UI 没回落 | 注销 id 不一致 / 组件缓存了数据 | 用同一 id；刷新复验 |

**可复跑契约自测**：`node --test test/pi-ui-extensions.test.mjs`（25 项：唯一清单/双向映射/provider 注册与合并/禁用态/选择器/prefs/mock/allowlist/DOC 锚点）。

---

## 4. 能力目录与数据契约（40 项）

> 本章按契约 `PI_UI_CAPABILITIES` 顺序、分 5 组逐项给：能力 ID、状态、数据契约、动作、事件/刷新、错误处理、边界/安全、启用前后 UI 差异、mock 验证与相关文件。数据契约直接抄自 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap` / `PiUiCapabilityActionMap`），**字段名与可选性以代码为准**。
>
> 每张卡片顶栏两列状态：**生产默认**（无 provider，契约 `defaultStatus`）/ **注入后（mock/扩展）**（`ledgerStatus`：dev mock 或真实扩展注入后）。每个卡片标题即文档锚点 `#cap-<id>`，禁用态的「如何接入」链接指向这里。

**读卡片前先记住三层**：
1. **builtin（9 项）**：Pi 现有数据/UI 直供，默认 `available`，**不需要写 provider**；本卡片的「数据契约」描述的是变体应呈现的数据形状，不是要你实现。
2. **extension（31 项）**：需要 provider；生产默认 `unavailable`（禁用态），dev `?caps=` 注入后 `simulated`，真实扩展注册后 `available`。
3. 每项能力的动作回调都可缺省：缺省 = 只读；写操作 UI 需二次确认、provider 侧做权限校验。

### 4.1 窗格与工作台

### cap-device-platform-tabs

**设备平台标签** · 分组 pane · 来源 builtin · 生产默认 `available` · 注入后（mock/扩展）`available` · builtin（无需 provider）

按设备平台筛选：Mac / Windows / Linux / 全部。

| 项 | 值 |
|---|---|
| 能力 ID | `device-platform-tabs` |
| 生产默认状态 | `available`（无 provider） |
| 注入后状态 | `available`（dev mock 或真实扩展注入后） |
| 是否需 provider | 否（builtin，Pi 现有数据直供） |
| 参考出处 | [C-§1][C-图8] Claude 三标签；§6.2 |
| Claude 落位 | 标题栏顶部平台标签（全部 / macOS / Windows / Linux）；Hub Rail 上方 |
| Codex 落位 | 不做平台标签；对应物是「运行位置三段」（work-mode，§6.3） |
| 对应界面 | CL-SHELL-05 |
| 未提供原因 | 不适用（builtin，Pi 现有数据直供，无需 provider） |

**① 用户看到什么**

- **内置可用（builtin，始终可用）**：标签始终可用；某平台无设备时该标签降饱和 + aria-disabled + 配对入口，这是空数据态而非能力禁用态（无数据时显示空态，不出现能力禁用态）
- **可用状态（builtin 数据直供）**：builtin 直接可用：点标签 → 平台粗筛（与侧栏设备细筛叠加）；记住上次平台与平台内设备；无平台设备时给「配对新设备…」

**② 数据契约**（`getData()` 返回）

```ts
type Data = { platforms: PiUiPlatformTabDescriptor[]; activeTabId?: string; deviceByPlatform?: Partial<Record<"macos" | "windows" | "linux", string>> }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `platforms` | `PiUiPlatformTabDescriptor[]` | 是 | 列表（数组顺序即展示顺序） |
| `activeTabId` | `string` | 否 | 唯一标识（provider 内稳定） |
| `deviceByPlatform` | `Partial<Record<"macos" \| "windows" \| "linux", string>>` | 否 | — |

`platforms` 元素字段（`PiUiPlatformTabDescriptor`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `"all" \| "macos" \| "windows" \| "linux"` | 是 | 唯一标识（provider 内稳定） |
| `label` | `string` | 是 | 展示名 |
| `deviceCount` | `number` | 是 | 数量 |
| `lastDeviceId` | `string` | 否 | 唯一标识（provider 内稳定） |

**JSON 示例**：

```json
{
  "platforms": [
    {
      "id": "all",
      "label": "示例名称",
      "deviceCount": 1
    }
  ],
  "activeTabId": "x-1",
  "deviceByPlatform": {}
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `selectPlatform` | 否 | `(tab: "all" \| "macos" \| "windows" \| "linux") => void` |
| `selectDevice` | 否 | `(platform: "macos" \| "windows" \| "linux", deviceId: string) => void` |

**④ 事件与刷新**：数据来自 relay 设备名册；`resolvePiUiPlatformSelection()` 纯函数计算可选平台/设备/禁用原因；平台选择写 prefs（`uiPlatformTab`/`deviceByPlatform`）后重渲染

**⑤ 错误处理**：prefs 读写失败静默回落「全部」；设备名册未就绪时显示加载态，不显示假标签

**⑥ 边界与限制**：平台是粗筛，不替代设备选择；不改 P9 C 的设备-目录绑定；未知平台（freebsd 等）只出现在「全部」

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 标题栏顶部平台标签（全部 / macOS / Windows / Linux）；Hub Rail 上方 | n/a（builtin）：标签始终可用；某平台无设备时该标签降饱和 + aria-disabled + 配对入口，这是空数据态而非能力禁用态 | builtin 直接可用：点标签 → 平台粗筛（与侧栏设备细筛叠加）；记住上次平台与平台内设备；无平台设备时给「配对新设备…」 | 同启用 + 模拟标识 |
| 不做平台标签；对应物是「运行位置三段」（work-mode，§6.3） | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：画廊 mock 设备：mac×2、win×1、无 linux、离线设备；断言无 linux 标签 aria-disabled + 配对按钮可点

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["device-platform-tabs"]` / `PiUiCapabilityActionMap["device-platform-tabs"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-workspace-modes

**会话 / 任务 / 工作台** · 分组 pane · 来源 builtin · 生产默认 `available` · 注入后（mock/扩展）`available` · builtin（无需 provider）

会话 / 任务 / 工作台 三种模式切换。

| 项 | 值 |
|---|---|
| 能力 ID | `workspace-modes` |
| 生产默认状态 | `available`（无 provider） |
| 注入后状态 | `available`（dev mock 或真实扩展注入后） |
| 是否需 provider | 否（builtin，Pi 现有数据直供） |
| 参考出处 | [C-图8②] Hub Rail 三段；§6.3 |
| Claude 落位 | 侧栏顶部 Hub Rail 三段胶囊：会话 / 任务 / 工作台 |
| Codex 落位 | 不做三段；Codex 的对应物是右栏工具面与运行位置三段 |
| 对应界面 | CL-SHELL-03 |
| 未提供原因 | 不适用（builtin，Pi 现有数据直供，无需 provider） |

**① 用户看到什么**

- **内置可用（builtin，始终可用）**：三段始终可切；模式内缺失界面（如工作台窗格）才显示对应禁用态（无数据时显示空态，不出现能力禁用态）
- **可用状态（builtin 数据直供）**：切换只换展示树：会话=消息流；任务=任务流+Progress/文件夹 chip；工作台=窗格工作台+session rail；快捷键 ⌘1/⌘2/⌘3

**② 数据契约**（`getData()` 返回）

```ts
type Data = { modes: PiUiWorkspaceMode[]; activeModeId?: string }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `modes` | `PiUiWorkspaceMode[]` | 是 | 列表（数组顺序即展示顺序） |
| `activeModeId` | `string` | 否 | 唯一标识（provider 内稳定） |

`modes` 元素字段（`PiUiWorkspaceMode`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `label` | `string` | 是 | 展示名 |
| `description` | `string` | 否 | — |

**JSON 示例**：

```json
{
  "modes": [
    {
      "id": "x-1",
      "label": "示例名称",
      "description": "示例说明"
    }
  ],
  "activeModeId": "x-1"
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `selectMode` | 否 | `(modeId: string) => void` |

**④ 事件与刷新**：模式状态为变体本地状态（会话内记忆，见 `ui/src/pi/variants/claude/model/uiMemory.ts`；契约 v1 未提供 `uiWorkspaceMode` pref 字段）；切换不重连、不丢草稿

**⑤ 错误处理**：无数据时显示空态；不因模式切换触发 relay 动作

**⑥ 边界与限制**：模式不是能力；模式内界面的能力状态独立判定；手机端收为列表页分段/对话页单模式

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 侧栏顶部 Hub Rail 三段胶囊：会话 / 任务 / 工作台 | n/a（builtin）：三段始终可切；模式内缺失界面（如工作台窗格）才显示对应禁用态 | 切换只换展示树：会话=消息流；任务=任务流+Progress/文件夹 chip；工作台=窗格工作台+session rail；快捷键 ⌘1/⌘2/⌘3 | 同启用 + 模拟标识 |
| 不做三段；Codex 的对应物是右栏工具面与运行位置三段 | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：无需 mock（builtin）；验收看三态切换与正文/侧栏/composer 变化

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["workspace-modes"]` / `PiUiCapabilityActionMap["workspace-modes"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-pane-workspace

**多窗格工作台** · 分组 pane · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`unavailable` · 需要 provider

多窗格工作台：可开合的改动 / 文件 / 终端 / 浏览器 / 计划 / 侧聊 / 任务 / 子 agent 窗格。

| 项 | 值 |
|---|---|
| 能力 ID | `pane-workspace` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `unavailable`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [C-§2][C-图2][C-图3] 窗格网格与窗格菜单 |
| Claude 落位 | 工作台模式主区窗格网格；标题栏菜单勾选开关（带快捷键） |
| Codex 落位 | 右栏多页签容器（Preview/Files/Changes/Review…） |
| 对应界面 | CL-CODE-02/03/04/23、CX-PANEL-01/02/03 |
| 未提供原因 | pi 目前只有单右栏；扩展提供多窗格后启用。 |

**① 用户看到什么**

- **禁用态（生产默认）**：工作台模式下显示窗格框架壳 + 每窗格禁用卡（「本机 pi 未提供此能力」+ 原因 + 如何接入）；现有单栏（改动/文件/终端）仍可用
- **启用后（provider 注册）**：provider 给窗格描述后：可开/关/聚焦窗格；窗格内容按各能力数据渲染；标题栏菜单列出 provider 声明的窗格
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=pane-workspace`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { panes: PiUiPaneDescriptor[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `panes` | `PiUiPaneDescriptor[]` | 是 | 列表（数组顺序即展示顺序） |

`panes` 元素字段（`PiUiPaneDescriptor`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `title` | `string` | 是 | 展示名 |
| `kind` | `"changes" \| "files" \| "terminal" \| "browser" \| "plan" \| "side-chat" \| "tasks" \| "subagent" \| "custom"` | 是 | 类型（含 tasks（Tasks 看板）/ subagent（子 agent）；开放枚举，未知值按兜底渲染） |
| `badge` | `string` | 否 | 角标文案（数量/状态点；无则不显示） |
| `dockable` | `boolean` | 否 | — |
| `order` | `number` | 否 | 排序（越小越靠前） |

**JSON 示例**：

```json
{
  "panes": [
    {
      "id": "x-1",
      "title": "示例名称",
      "kind": "changes",
      "badge": "示例",
      "dockable": true,
      "order": 1
    }
  ]
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `openPane` | 否 | `(paneId: string) => void` |
| `closePane` | 否 | `(paneId: string) => void` |
| `focusPane` | 否 | `(paneId: string) => void` |

**④ 事件与刷新**：`getData` 给 pane 描述；`openPane/closePane/focusPane` 动作由 provider 执行，完成后经 `subscribe` 刷新

**⑤ 错误处理**：窗格数据失败 → 该窗格错误态（不拖垮整页）；未知 pane kind 按 custom 渲染兜底

**⑥ 边界与限制**：布局几何由变体自写；provider 只给描述/内容；窗格数量与尺寸上限写进适配层配置

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 工作台模式主区窗格网格；标题栏菜单勾选开关（带快捷键） | 工作台模式下显示窗格框架壳 + 每窗格禁用卡（「本机 pi 未提供此能力」+ 原因 + 如何接入）；现有单栏（改动/文件/终端）仍可用 | provider 给窗格描述后：可开/关/聚焦窗格；窗格内容按各能力数据渲染；标题栏菜单列出 provider 声明的窗格 | 同启用 + 模拟标识 |
| 右栏多页签容器（Preview/Files/Changes/Review…） | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 8 类窗格描述+内容+布局；断言开/关/聚焦、禁用态文案、注销后回落

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["pane-workspace"]` / `PiUiCapabilityActionMap["pane-workspace"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-pane-dock-drag

**窗格拖拽与停靠** · 分组 pane · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`simulated` · 需要 provider

拖动窗格、停靠与保存布局。

| 项 | 值 |
|---|---|
| 能力 ID | `pane-dock-drag` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `simulated`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [C-图2] 拖拽/停靠/改尺寸/拖出独立窗口 |
| Claude 落位 | 工作台模式窗格标题栏拖拽、拖边改尺寸、布局预设 |
| Codex 落位 | 页签容器不实现拖拽（按适配方案） |
| 对应界面 | CL-CODE-02/05、CL-CODE-06 |
| 未提供原因 | pi 目前不支持窗格拖拽 / 停靠；扩展提供后启用。 |

**① 用户看到什么**

- **禁用态（生产默认）**：窗格可显示但不可拖动/停靠：拖拽手柄禁用 + 原因提示；布局预设菜单禁用态
- **启用后（provider 注册）**：拖拽摆放、拖边改尺寸、保存/恢复布局预设（`applyLayout/saveLayout/resetLayout`）
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=pane-dock-drag`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { layouts: PiUiLayoutPreset[]; activeLayoutId?: string }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `layouts` | `PiUiLayoutPreset[]` | 是 | 列表（数组顺序即展示顺序） |
| `activeLayoutId` | `string` | 否 | 唯一标识（provider 内稳定） |

`layouts` 元素字段（`PiUiLayoutPreset`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `title` | `string` | 是 | 展示名 |
| `paneIds` | `string[]` | 是 | 列表（数组顺序即展示顺序） |
| `sizes` | `number[]` | 否 | 列表（数组顺序即展示顺序） |

**JSON 示例**：

```json
{
  "layouts": [
    {
      "id": "x-1",
      "title": "示例名称",
      "paneIds": [
        "示例"
      ],
      "sizes": [
        1
      ]
    }
  ],
  "activeLayoutId": "x-1"
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `applyLayout` | 否 | `(layoutId: string) => void` |
| `saveLayout` | 否 | `(layout: PiUiLayoutPreset) => void` |
| `resetLayout` | 否 | `() => void` |

**④ 事件与刷新**：provider 提供布局列表与当前布局 id；动作后 subscribe 刷新；拖拽中的临时几何由变体本地管理

**⑤ 错误处理**：布局 id 不存在 → 回落默认布局 + 提示；保存失败提示重试，不丢当前布局

**⑥ 边界与限制**：纯交互能力；移动端/窄窗不提供拖拽（用 ⋮ 菜单）；性能：拖拽期间避免重渲染整棵 transcript

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 工作台模式窗格标题栏拖拽、拖边改尺寸、布局预设 | 窗格可显示但不可拖动/停靠：拖拽手柄禁用 + 原因提示；布局预设菜单禁用态 | 拖拽摆放、拖边改尺寸、保存/恢复布局预设（`applyLayout/saveLayout/resetLayout`） | 同启用 + 模拟标识 |
| 页签容器不实现拖拽（按适配方案） | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 拖拽布局（2 套预设）；断言 applyLayout 生效、拖拽后几何变化、注销回落

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["pane-dock-drag"]` / `PiUiCapabilityActionMap["pane-dock-drag"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-browser-pane

**设备端浏览器工具** · 分组 pane · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`unavailable` · 需要 provider

设备端浏览器工具：由设备端扩展提供的网页操作与点选。

| 项 | 值 |
|---|---|
| 能力 ID | `browser-pane` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `unavailable`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [C-图7][X-PANEL-07] Browser 面板 |
| Claude 落位 | 工作台模式 设备端浏览器工具（agent 或用户打开的标签页） |
| Codex 落位 | 右栏 Browser 页签 |
| 对应界面 | CL-COWORK-08、CX-PANEL-07 |
| 未提供原因 | 设备端浏览器需要设备端扩展；本机 pi 未提供。 |

**① 用户看到什么**

- **禁用态（生产默认）**：设备端浏览器工具禁用卡 + 原因；已有单栏工具面不受影响
- **启用后（provider 注册）**：标签页列表/激活/关闭/打开 URL；agent 打开的标签可标记；页面上可点选评论（与 code-review-comments 联动，见变体实现）
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=browser-pane`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { tabs: PiUiBrowserTab[]; activeTabId?: string }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tabs` | `PiUiBrowserTab[]` | 是 | 列表（数组顺序即展示顺序） |
| `activeTabId` | `string` | 否 | 唯一标识（provider 内稳定） |

`tabs` 元素字段（`PiUiBrowserTab`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `title` | `string` | 是 | 展示名 |
| `url` | `string` | 是 | 链接（https；不可信内容） |
| `faviconUrl` | `string` | 否 | 链接（https；不可信内容） |
| `openedBy` | `"user" \| "agent"` | 否 | — |

**JSON 示例**：

```json
{
  "tabs": [
    {
      "id": "x-1",
      "title": "示例名称",
      "url": "https://example.invalid/",
      "openedBy": "user"
    }
  ],
  "activeTabId": "x-1"
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `openUrl` | 否 | `(url: string) => void` |
| `closeTab` | 否 | `(tabId: string) => void` |
| `activateTab` | 否 | `(tabId: string) => void` |

**④ 事件与刷新**：`getData` 给 tabs+activeTabId；动作 `openUrl/closeTab/activateTab`；subscribe 刷新

**⑤ 错误处理**：URL 非法/加载失败 → 窗格错误条+重试；跨域嵌入失败给可操作说明

**⑥ 边界与限制**：安全：iframe sandbox、URL 白名单、不注入脚本、不拿用户 cookie；性能：非活动标签懒加载

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 工作台模式 设备端浏览器工具（agent 或用户打开的标签页） | 设备端浏览器工具禁用卡 + 原因；已有单栏工具面不受影响 | 标签页列表/激活/关闭/打开 URL；agent 打开的标签可标记；页面上可点选评论（与 code-review-comments 联动，见变体实现） | 同启用 + 模拟标识 |
| 右栏 Browser 页签 | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 静态 HTML 页面 + 可点选区域；断言打开/切标签/点选评论/注销回落

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["browser-pane"]` / `PiUiCapabilityActionMap["browser-pane"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-multi-tab

**多标签页** · 分组 pane · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`unavailable` · 需要 provider

多标签页：多个会话标签切换。

| 项 | 值 |
|---|---|
| 能力 ID | `multi-tab` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `unavailable`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [X-图7①] 多标签页 |
| Claude 落位 | （无对应；见变体实现） |
| Codex 落位 | 标题栏会话标签条（可关闭/切换） |
| 对应界面 | CX-SHELL-05 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：标签条显示单标签 + 「多标签未接入」提示；切换/关闭禁用
- **启用后（provider 注册）**：多会话标签：打开/切换/关闭 → 切会话（provider 定义）
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=multi-tab`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { tabs: PiUiBareTab[]; activeTabId?: string }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tabs` | `PiUiBareTab[]` | 是 | 列表（数组顺序即展示顺序） |
| `activeTabId` | `string` | 否 | 唯一标识（provider 内稳定） |

`tabs` 元素字段（`PiUiBareTab`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `title` | `string` | 是 | 展示名 |
| `kind` | `string` | 是 | 类型（开放枚举，未知值按兜底渲染） |

**JSON 示例**：

```json
{
  "tabs": [
    {
      "id": "x-1",
      "title": "示例名称",
      "kind": "示例"
    }
  ],
  "activeTabId": "x-1"
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `selectTab` | 否 | `(tabId: string) => void` |
| `closeTab` | 否 | `(tabId: string) => void` |

**④ 事件与刷新**：`getData` 给 tabs+activeTabId；动作 `selectTab/closeTab`

**⑤ 错误处理**：目标会话已被删 → 关闭标签+提示

**⑥ 边界与限制**：写操作：关闭标签需确认未保存内容；与 relay 换房间流程一致

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| （无对应；见变体实现） | 标签条显示单标签 + 「多标签未接入」提示；切换/关闭禁用 | 多会话标签：打开/切换/关闭 → 切会话（provider 定义） | 同启用 + 模拟标识 |
| 标题栏会话标签条（可关闭/切换） | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 标签列表/切换；断言切换/关闭

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["multi-tab"]` / `PiUiCapabilityActionMap["multi-tab"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-terminal-interactive

**设备端终端（只读）** · 分组 pane · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`simulated` · 需要 provider

设备端终端：只读输出，输入需扩展。

| 项 | 值 |
|---|---|
| 能力 ID | `terminal-interactive` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `simulated`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [X-PANEL-10] 设备端终端（只读） |
| Claude 落位 | 终端窗格（输入） |
| Codex 落位 | Terminal 面板（输入） |
| 对应界面 | CX-PANEL-10、CL-CODE-07 |
| 未提供原因 | 设备端终端当前只读；输入 / 交互需扩展。 |

**① 用户看到什么**

- **禁用态（生产默认）**：终端只读输出（现有）+ 输入框禁用+原因
- **启用后（provider 注册）**：发送输入到终端会话 + 输出流（provider 定义）
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=terminal-interactive`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { terminal: PiUiInteractiveTerminal | null }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `terminal` | `PiUiInteractiveTerminal \| null` | 是 | — |

**JSON 示例**：

```json
{
  "terminal": {
    "terminalId": "x-1",
    "running": true,
    "cwd": "示例",
    "recentLines": [
      "示例"
    ]
  }
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `sendInput` | 否 | `(terminalId: string, input: string) => void` |

**④ 事件与刷新**：`getData` 给 terminal 状态；动作 `sendInput`；输出经 subscribe/事件

**⑤ 错误处理**：进程退出 → 显示 exit code + 重开入口

**⑥ 边界与限制**：写操作：命令执行风险提示；与 background-tasks 边界

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 终端窗格（输入） | 终端只读输出（现有）+ 输入框禁用+原因 | 发送输入到终端会话 + 输出流（provider 定义） | 同启用 + 模拟标识 |
| Terminal 面板（输入） | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 输入/会话；断言输入→输出

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["terminal-interactive"]` / `PiUiCapabilityActionMap["terminal-interactive"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-session-rail-extra

**会话侧栏扩展** · 分组 pane · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`unavailable` · 需要 provider

会话侧栏扩展条目。

| 项 | 值 |
|---|---|
| 能力 ID | `session-rail-extra` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `unavailable`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [C-§2] session rail 扩展位；[X-图11] Environment 卡扩展 |
| Claude 落位 | 右侧 rail 第三方卡（label/badge/action） |
| Codex 落位 | Environment 卡扩展行 |
| 对应界面 | CL-CHAT-06、CX-PANEL-08 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：扩展卡区域禁用态（或隐藏，按变体）；现有 rail 卡不受影响
- **启用后（provider 注册）**：第三方条目列表（label/badge/order/actionId）+ activateEntry 动作
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=session-rail-extra`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { entries: PiUiSessionRailEntry[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `entries` | `PiUiSessionRailEntry[]` | 是 | 列表（数组顺序即展示顺序） |

`entries` 元素字段（`PiUiSessionRailEntry`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `label` | `string` | 是 | 展示名 |
| `badge` | `string` | 否 | 角标文案（数量/状态点；无则不显示） |
| `order` | `number` | 否 | 排序（越小越靠前） |
| `actionId` | `string` | 否 | 唯一标识（provider 内稳定） |

**JSON 示例**：

```json
{
  "entries": [
    {
      "id": "x-1",
      "label": "示例名称",
      "badge": "示例",
      "order": 1
    }
  ]
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `activateEntry` | 否 | `(entryId: string) => void` |

**④ 事件与刷新**：`getData` 给 entries；动作 `activateEntry`；subscribe 刷新

**⑤ 错误处理**：actionId 未实现 → 禁用条目+原因；数据缺失跳过条目

**⑥ 边界与限制**：只注入条目，不注入组件/样式；排序用 order

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 右侧 rail 第三方卡（label/badge/action） | 扩展卡区域禁用态（或隐藏，按变体）；现有 rail 卡不受影响 | 第三方条目列表（label/badge/order/actionId）+ activateEntry 动作 | 同启用 + 模拟标识 |
| Environment 卡扩展行 | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock rail 条目；断言显示/点击

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["session-rail-extra"]` / `PiUiCapabilityActionMap["session-rail-extra"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-terminal-panes

**多终端（实例）** · 分组 pane · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`unavailable` · 需要 provider

多终端：创建、切换与结束终端。

| 项 | 值 |
|---|---|
| 能力 ID | `terminal-panes` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `unavailable`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [C-图2] 多终端窗格；[X-§5] Terminal |
| Claude 落位 | 工作台模式多终端窗格 |
| Codex 落位 | 右栏 Terminal 页签（多实例） |
| 对应界面 | CL-CODE-07、CX-PANEL-10 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：多终端创建入口禁用+原因；现有单终端只读不受影响
- **启用后（provider 注册）**：终端实例创建/切换/结束（provider 定义）
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=terminal-panes`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { terminals: PiUiTerminalDescriptor[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `terminals` | `PiUiTerminalDescriptor[]` | 是 | 列表（数组顺序即展示顺序） |

`terminals` 元素字段（`PiUiTerminalDescriptor`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `title` | `string` | 是 | 展示名 |
| `status` | `"running" \| "exited"` | 是 | 状态（开放枚举） |
| `cwd` | `string` | 否 | — |
| `exitCode` | `number \| null` | 否 | — |

**JSON 示例**：

```json
{
  "terminals": [
    {
      "id": "x-1",
      "title": "示例名称",
      "status": "running"
    }
  ]
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `createTerminal` | 否 | `() => void` |
| `killTerminal` | 否 | `(terminalId: string) => void` |
| `focusTerminal` | 否 | `(terminalId: string) => void` |

**④ 事件与刷新**：`getData` 给 terminals；动作 `createTerminal/killTerminal/focusTerminal`

**⑤ 错误处理**：创建失败/到达上限 → 提示；结束进程需确认

**⑥ 边界与限制**：写操作；与 terminal-interactive 区分（多实例 vs 单终端交互）

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 工作台模式多终端窗格 | 多终端创建入口禁用+原因；现有单终端只读不受影响 | 终端实例创建/切换/结束（provider 定义） | 同启用 + 模拟标识 |
| 右栏 Terminal 页签（多实例） | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 多终端；断言创建/切换/结束

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["terminal-panes"]` / `PiUiCapabilityActionMap["terminal-panes"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### 4.2 内容与产物

### cap-artifacts

**产出物** · 分组 content · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`simulated` · 需要 provider

会话产出物：markdown / 网页 / 图表 / 代码 / 图片预览。

| 项 | 值 |
|---|---|
| 能力 ID | `artifacts` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `simulated`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [C-图9②] Artifact 卡；[C-图13③] 产出物 面板 Preview/Code |
| Claude 落位 | 对话内 Artifact 卡 + 产出物 库/面板（Preview/Code 两看法） |
| Codex 落位 | 右栏产物面板（对应面板 CX-PANEL-01；以变体实现为准） |
| 对应界面 | CL-CHAT-07/08、CL-COWORK-07、CL-CODE-22、CX-PANEL-01 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：Artifact 卡/库/面板显示禁用卡：标题「本机 pi 未提供此能力」+ 原因 + 「如何接入」链接（#cap-artifacts）
- **启用后（provider 注册）**：列表（标题/类型/更新时间）可打开 → Preview/Code 面板；支持 html/markdown/code/chart/image
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=artifacts`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { artifacts: PiUiArtifact[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `artifacts` | `PiUiArtifact[]` | 是 | 列表（数组顺序即展示顺序） |

`artifacts` 元素字段（`PiUiArtifact`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `title` | `string` | 是 | 展示名 |
| `kind` | `"markdown" \| "html" \| "code" \| "chart" \| "image" \| "other"` | 是 | 类型（开放枚举，未知值按兜底渲染） |
| `updatedAt` | `number` | 是 | 毫秒时间戳（UTC） |
| `content` | `string` | 否 | 正文（不可信内容，渲染需净化） |
| `url` | `string` | 否 | 链接（https；不可信内容） |
| `meta` | `Record<string, string \| number \| boolean>` | 否 | 扩展元数据（键值简单类型） |

**JSON 示例**：

```json
{
  "artifacts": [
    {
      "id": "x-1",
      "title": "示例名称",
      "kind": "markdown",
      "updatedAt": 1750000000000,
      "content": "示例内容"
    }
  ]
}
```

> 列表 + 详情同构；updatedAt 为毫秒时间戳

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `openArtifact` | 否 | `(artifactId: string) => void` |
| `revealArtifact` | 否 | `(artifactId: string) => void` |

**④ 事件与刷新**：`getData` 返回列表；`subscribe` 通知新增/更新；`onEvent` 可推 `artifacts:opened` 等扩展事件；动作 `openArtifact/revealArtifact`

**⑤ 错误处理**：列表空 → 空态；单条内容加载失败 → 卡内错误+重试；html 内容按不可信内容沙箱渲染

**⑥ 边界与限制**：列表只给摘要；正文按需；单条建议 ≤256KB；图片用 url/data URL；只读

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 对话内 Artifact 卡 + 产出物 库/面板（Preview/Code 两看法） | Artifact 卡/库/面板显示禁用卡：标题「本机 pi 未提供此能力」+ 原因 + 「如何接入」链接（#cap-artifacts） | 列表（标题/类型/更新时间）可打开 → Preview/Code 面板；支持 html/markdown/code/chart/image | 同启用 + 模拟标识 |
| 右栏产物面板（对应面板 CX-PANEL-01；以变体实现为准） | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 列表 3 条 + 正文（CSS/PDF/HTML）+ Preview/Code；断言打开/切看法/注销回落

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["artifacts"]` / `PiUiCapabilityActionMap["artifacts"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-plan-pane

**计划 / 进度** · 分组 content · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`simulated` · 需要 provider

计划与进度：多步计划、进度与步骤编辑。

| 项 | 值 |
|---|---|
| 能力 ID | `plan-pane` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `simulated`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [C-图5] Progress 编号步骤卡；[X-§3] plan |
| Claude 落位 | Progress 卡 + 计划窗格（编号步骤、当前步强调、待办灰阶） |
| Codex 落位 | Environment 卡 Progress 行 / plan 区域 |
| 对应界面 | CL-COWORK-05/06、CX-PANEL-08 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：Progress 卡显示禁用态（Pi 只有只读任务列表）；不伪造步骤
- **启用后（provider 注册）**：多步计划可编辑：切换步骤状态、步骤增删（动作由 provider 定义）；当前步高亮；与任务列表区分（计划不是执行日志）
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=plan-pane`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { plan: PiUiPlan }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `plan` | `PiUiPlan` | 是 | — |

`plan` 元素字段（`PiUiPlan`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `title` | `string` | 是 | 展示名 |
| `summary` | `string` | 否 | — |
| `steps` | `PiUiPlanStep[]` | 是 | 步骤列表（数组顺序即执行顺序） |
| `updatedAt` | `number` | 是 | 毫秒时间戳（UTC） |

**JSON 示例**：

```json
{
  "plan": {
    "id": "x-1",
    "title": "示例名称",
    "steps": [
      {
        "id": "x-1",
        "title": "示例名称",
        "status": "pending"
      }
    ],
    "updatedAt": 1750000000000
  }
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `updateStep` | 否 | `(planId: string, stepId: string, status: PiUiPlanStep["status"]) => void` |

**④ 事件与刷新**：`getData` 给 plan（steps 顺序即展示）；动作 `updateStep(planId, stepId, status)`；subscribe 刷新

**⑤ 错误处理**：状态值未知 → 按 pending 兜底；更新失败保留原状态+提示；并发更新以最后数据快照为准

**⑥ 边界与限制**：可写：步骤状态/增删（provider 侧校验权限）；计划规模上限（建议 ≤50 步）；与 background-tasks 边界：plan 是「打算做什么」

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| Progress 卡 + 计划窗格（编号步骤、当前步强调、待办灰阶） | Progress 卡显示禁用态（Pi 只有只读任务列表）；不伪造步骤 | 多步计划可编辑：切换步骤状态、步骤增删（动作由 provider 定义）；当前步高亮；与任务列表区分（计划不是执行日志） | 同启用 + 模拟标识 |
| Environment 卡 Progress 行 / plan 区域 | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 3–5 步 + 增删/插话事件；断言改步骤/进度变化/注销回落

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["plan-pane"]` / `PiUiCapabilityActionMap["plan-pane"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-suggestions

**建议词** · 分组 content · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`simulated` · 需要 provider

建议词：下一步建议与快捷动作。

| 项 | 值 |
|---|---|
| 能力 ID | `suggestions` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `simulated`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [C-§3] 建议提示词 ghost text；[X-图4] 建议卡 |
| Claude 落位 | 空输入框 ghost text（Tab/→ 接受） |
| Codex 落位 | 空状态建议卡（点击填输入框） |
| 对应界面 | CL-CODE-19、CX-COMP-07 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：建议区禁用态（不显示假建议）；composer 正常可用
- **启用后（provider 注册）**：按上下文返回 2–3 条建议；接受 = 填入输入框（不自动发送）；打字即消失
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=suggestions`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { suggestions: PiUiSuggestion[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `suggestions` | `PiUiSuggestion[]` | 是 | 列表（数组顺序即展示顺序） |

`suggestions` 元素字段（`PiUiSuggestion`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `text` | `string` | 是 | 正文（不可信内容，渲染需净化） |
| `kind` | `"reply" \| "action" \| "refine" \| "followup"` | 否 | 类型（开放枚举，未知值按兜底渲染） |
| `command` | `string` | 否 | — |

**JSON 示例**：

```json
{
  "suggestions": [
    {
      "id": "x-1",
      "text": "示例内容",
      "kind": "reply",
      "command": "示例"
    }
  ]
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `pickSuggestion` | 否 | `(suggestionId: string) => void` |

**④ 事件与刷新**：`getData` 给 suggestions；动作 `pickSuggestion`；上下文变化时重新拉取

**⑤ 错误处理**：建议为空=不显示（不是禁用态）；provider 失败静默隐藏建议

**⑥ 边界与限制**：建议是辅助，不阻塞发送；不要注入敏感内容；无 provider 时不显示假建议

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 空输入框 ghost text（Tab/→ 接受） | 建议区禁用态（不显示假建议）；composer 正常可用 | 按上下文返回 2–3 条建议；接受 = 填入输入框（不自动发送）；打字即消失 | 同启用 + 模拟标识 |
| 空状态建议卡（点击填输入框） | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 上下文建议 3 条；断言 Tab 接受/打字消失

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["suggestions"]` / `PiUiCapabilityActionMap["suggestions"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-context-usage

**上下文用量** · 分组 content · 来源 builtin · 生产默认 `available` · 注入后（mock/扩展）`available` · builtin（无需 provider）

上下文用量：用量卡片、百分比与费用。

| 项 | 值 |
|---|---|
| 能力 ID | `context-usage` |
| 生产默认状态 | `available`（无 provider） |
| 注入后状态 | `available`（dev mock 或真实扩展注入后） |
| 是否需 provider | 否（builtin，Pi 现有数据直供） |
| 参考出处 | [C-§2] Context 卡；[X-图11] 上下文圆环 |
| Claude 落位 | session rail Context 卡（百分比/分类明细） |
| Codex 落位 | composer 上下文圆环 + Compact 标注 |
| 对应界面 | CL-CODE-16、CX-COMP-03 |
| 未提供原因 | 不适用（builtin，Pi 现有数据直供，无需 provider） |

**① 用户看到什么**

- **内置可用（builtin，始终可用）**：`usage_state.contextUsage` 直供（无数据时显示空态，不出现能力禁用态）
- **可用状态（builtin 数据直供）**：百分比/已用 token/窗口/费用 + 分类明细（按现有数据）

**② 数据契约**（`getData()` 返回）

```ts
type Data = { usage: PiUiContextUsage }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `usage` | `PiUiContextUsage` | 是 | — |

`usage` 元素字段（`PiUiContextUsage`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tokensUsed` | `number` | 否 | — |
| `contextWindow` | `number` | 否 | — |
| `percent` | `number` | 否 | — |
| `detail` | `string` | 否 | — |

**JSON 示例**：

```json
{
  "usage": {
    "tokensUsed": 1,
    "contextWindow": 1
  }
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|

**④ 事件与刷新**：读 `usage_state`（relay 推送）；无需 provider

**⑤ 错误处理**：数据缺失显示「—」而非 0

**⑥ 边界与限制**：只读；口径与 pi footer 一致

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| session rail Context 卡（百分比/分类明细） | n/a（builtin）：`usage_state.contextUsage` 直供 | 百分比/已用 token/窗口/费用 + 分类明细（按现有数据） | 同启用 + 模拟标识 |
| composer 上下文圆环 + Compact 标注 | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：无需 mock；验收看百分比/圆环

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["context-usage"]` / `PiUiCapabilityActionMap["context-usage"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-model-menu

**模型 / 强度菜单** · 分组 content · 来源 builtin · 生产默认 `available` · 注入后（mock/扩展）`available` · builtin（无需 provider）

模型与思考强度选择。

| 项 | 值 |
|---|---|
| 能力 ID | `model-menu` |
| 生产默认状态 | `available`（无 provider） |
| 注入后状态 | `available`（dev mock 或真实扩展注入后） |
| 是否需 provider | 否（builtin，Pi 现有数据直供） |
| 参考出处 | [C-图10] 模型菜单；[X-图9] 五档模型 |
| Claude 落位 | composer 模型胶囊 + 双环 popover |
| Codex 落位 | composer 模型选择（五档带代价词） |
| 对应界面 | CL-CODE-17、CX-COMP-01 |
| 未提供原因 | 不适用（builtin，Pi 现有数据直供，无需 provider） |

**① 用户看到什么**

- **内置可用（builtin，始终可用）**：`get_available_models`/`set_model` 直供（无数据时显示空态，不出现能力禁用态）
- **可用状态（builtin 数据直供）**：可用模型列表 + 当前选中 + 切换（真实命令）；思考级别入口

**② 数据契约**（`getData()` 返回）

```ts
type Data = { models: PiUiModelOption[]; currentModelId?: string }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `models` | `PiUiModelOption[]` | 是 | 列表（数组顺序即展示顺序） |
| `currentModelId` | `string` | 否 | 唯一标识（provider 内稳定） |

`models` 元素字段（`PiUiModelOption`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `provider` | `string` | 是 | — |
| `modelId` | `string` | 是 | 唯一标识（provider 内稳定） |
| `label` | `string` | 是 | 展示名 |
| `current` | `boolean` | 否 | — |
| `contextWindow` | `number` | 否 | — |

**JSON 示例**：

```json
{
  "models": [
    {
      "id": "x-1",
      "provider": "示例",
      "modelId": "x-1",
      "label": "示例名称",
      "contextWindow": 1
    }
  ],
  "currentModelId": "x-1"
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `selectModel` | 否 | `(modelId: string) => void` |

**④ 事件与刷新**：读 models/scoped models；`set_model` 后事件流刷新

**⑤ 错误处理**：未认证模型不出现在可选列表；set 失败提示原因+回退显示

**⑥ 边界与限制**：只读展示代价词为映射；写操作（切模型）走既有命令

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| composer 模型胶囊 + 双环 popover | n/a（builtin）：`get_available_models`/`set_model` 直供 | 可用模型列表 + 当前选中 + 切换（真实命令）；思考级别入口 | 同启用 + 模拟标识 |
| composer 模型选择（五档带代价词） | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：无需 mock；验收看菜单/五档代价词

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["model-menu"]` / `PiUiCapabilityActionMap["model-menu"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-file-editor

**文件编辑器** · 分组 content · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`unavailable` · 需要 provider

文件编辑器：在应用内编辑与保存文件。

| 项 | 值 |
|---|---|
| 能力 ID | `file-editor` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `unavailable`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [X-§5][X-图10] Files 编辑；[C-§2] 变更 |
| Claude 落位 | 变更/文件窗格编辑入口 |
| Codex 落位 | 右栏 Files 页签（编辑/保存） |
| 对应界面 | CX-PANEL-02、CL-CODE-02 |
| 未提供原因 | pi 的网页端目前只读文件；扩展提供编辑接口后启用。 |

**① 用户看到什么**

- **禁用态（生产默认）**：Files 页签可看（file-preview builtin）但编辑/保存按钮禁用+原因
- **启用后（provider 注册）**：文件内容编辑、dirty 标记、保存（provider 定义）；只读预览保持 builtin
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=file-editor`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { files: PiUiEditableFile[]; activeFileId?: string }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `files` | `PiUiEditableFile[]` | 是 | 列表（数组顺序即展示顺序） |
| `activeFileId` | `string` | 否 | 唯一标识（provider 内稳定） |

`files` 元素字段（`PiUiEditableFile`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | `string` | 是 | — |
| `content` | `string` | 是 | 正文（不可信内容，渲染需净化） |
| `language` | `string` | 否 | — |
| `dirty` | `boolean` | 否 | — |
| `updatedAt` | `number` | 否 | 毫秒时间戳（UTC） |

**JSON 示例**：

```json
{
  "files": [
    {
      "path": "src/index.ts",
      "content": "示例内容",
      "language": "示例",
      "dirty": true,
      "updatedAt": 1750000000000
    }
  ],
  "activeFileId": "x-1"
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `openFile` | 否 | `(path: string) => void` |
| `saveFile` | 否 | `(path: string, content: string) => void` |

**④ 事件与刷新**：`getData` 给 files+activeFileId；动作 `openFile/saveFile`；subscribe 刷新

**⑤ 错误处理**：保存冲突/权限失败 → 明确错误+不丢内容；大文件提示分页

**⑥ 边界与限制**：写操作：保存需确认；路径监狱（设备允许目录）；不与 file-preview 混用

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 变更/文件窗格编辑入口 | Files 页签可看（file-preview builtin）但编辑/保存按钮禁用+原因 | 文件内容编辑、dirty 标记、保存（provider 定义）；只读预览保持 builtin | 同启用 + 模拟标识 |
| 右栏 Files 页签（编辑/保存） | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 编辑/保存；断言编辑→保存→刷新

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["file-editor"]` / `PiUiCapabilityActionMap["file-editor"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-file-preview

**文件查看** · 分组 content · 来源 builtin · 生产默认 `available` · 注入后（mock/扩展）`available` · builtin（无需 provider）

文件查看：文本与图片预览。

| 项 | 值 |
|---|---|
| 能力 ID | `file-preview` |
| 生产默认状态 | `available`（无 provider） |
| 注入后状态 | `available`（dev mock 或真实扩展注入后） |
| 是否需 provider | 否（builtin，Pi 现有数据直供） |
| 参考出处 | [X-图10] Files；参考设计文件查看 |
| Claude 落位 | 文件窗格（只读） |
| Codex 落位 | 右栏 Files 页签（只读） |
| 对应界面 | CX-PANEL-02、CL-CODE-02 |
| 未提供原因 | 不适用（builtin，Pi 现有数据直供，无需 provider） |

**① 用户看到什么**

- **内置可用（builtin，始终可用）**：`getFile` 只读直供（无数据时显示空态，不出现能力禁用态）
- **可用状态（builtin 数据直供）**：文件树 + 语法高亮内容 + 截断提示

**② 数据契约**（`getData()` 返回）

```ts
type Data = { preview: PiUiFilePreview | null }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `preview` | `PiUiFilePreview \| null` | 是 | — |

**JSON 示例**：

```json
{
  "preview": {
    "path": "src/index.ts",
    "kind": "text",
    "content": "示例内容"
  }
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `openFile` | 否 | `(path: string) => void` |

**④ 事件与刷新**：读设备文件（既有能力）；无 provider

**⑤ 错误处理**：读取失败显示错误+重试；二进制/超大文件给提示

**⑥ 边界与限制**：只读；路径监狱

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 文件窗格（只读） | n/a（builtin）：`getFile` 只读直供 | 文件树 + 语法高亮内容 + 截断提示 | 同启用 + 模拟标识 |
| 右栏 Files 页签（只读） | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：无需 mock；验收看文件树/高亮

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["file-preview"]` / `PiUiCapabilityActionMap["file-preview"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-dictation

**听写** · 分组 content · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`unavailable` · 需要 provider

听写：语音转文字（需扩展提供）。

| 项 | 值 |
|---|---|
| 能力 ID | `dictation` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `unavailable`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [X-§8] 听写 |
| Claude 落位 | composer 麦克风入口 |
| Codex 落位 | composer 麦克风 |
| 对应界面 | CX-COMP-06、CL-CODE-20 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：麦克风按钮禁用+原因（浏览器/环境不支持也可作为禁用原因）
- **启用后（provider 注册）**：开始/停止听写、转写文本填入 composer（provider 定义，浏览器 SpeechRecognition 可选）
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=dictation`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { dictation: PiUiDictationState }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `dictation` | `PiUiDictationState` | 是 | — |

`dictation` 元素字段（`PiUiDictationState`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `supported` | `boolean` | 是 | — |
| `listening` | `boolean` | 是 | — |
| `language` | `string` | 否 | — |
| `transcript` | `string` | 否 | — |

**JSON 示例**：

```json
{
  "dictation": {
    "supported": true,
    "listening": true,
    "language": "示例",
    "transcript": "示例"
  }
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `start` | 否 | `() => void` |
| `stop` | 否 | `() => void` |

**④ 事件与刷新**：动作由 provider 定义；转写结果回调写入输入框

**⑤ 错误处理**：权限拒绝/识别失败 → 提示+不阻塞输入

**⑥ 边界与限制**：隐私：仅用户显式触发；不后台录音

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| composer 麦克风入口 | 麦克风按钮禁用+原因（浏览器/环境不支持也可作为禁用原因） | 开始/停止听写、转写文本填入 composer（provider 定义，浏览器 SpeechRecognition 可选） | 同启用 + 模拟标识 |
| composer 麦克风 | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 听写（simulated）；断言开始/转写/停止

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["dictation"]` / `PiUiCapabilityActionMap["dictation"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### 4.3 工作流

### cap-side-chat

**侧边对话** · 分组 workflow · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`simulated` · 需要 provider

侧边对话：不打断主对话的旁路问询。

| 项 | 值 |
|---|---|
| 能力 ID | `side-chat` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `simulated`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [C-§2] side chat；[X-§5] Side chat |
| Claude 落位 | ⌘; 侧聊面板（借主线程上下文提问，不回写） |
| Codex 落位 | 右栏 Side chat 页签 |
| 对应界面 | CL-CODE-12、CX-PANEL-11 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：侧聊面板禁用卡；主对话不受影响
- **启用后（provider 注册）**：线程列表 + 消息往返 + 上下文引用展示；不写回主对话（只读引用）
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=side-chat`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { threads: PiUiSideChatThread[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threads` | `PiUiSideChatThread[]` | 是 | 列表（数组顺序即展示顺序） |

`threads` 元素字段（`PiUiSideChatThread`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `title` | `string` | 是 | 展示名 |
| `roomId` | `string` | 否 | 唯一标识（provider 内稳定） |
| `messages` | `PiUiSideChatMessage[]` | 是 | 消息列表（按时间顺序） |
| `updatedAt` | `number` | 是 | 毫秒时间戳（UTC） |

**JSON 示例**：

```json
{
  "threads": [
    {
      "id": "x-1",
      "title": "示例名称",
      "roomId": "x-1",
      "messages": [
        {
          "id": "x-1",
          "role": "user",
          "text": "示例内容",
          "at": 1750000000000
        }
      ],
      "updatedAt": 1750000000000
    }
  ]
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `sendMessage` | 否 | `(threadId: string \| null, text: string) => void` |
| `createThread` | 否 | `(title?: string) => void` |

**④ 事件与刷新**：`getData` 给 threads；动作 `sendMessage/createThread`；subscribe 刷新消息

**⑤ 错误处理**：发送失败 → 消息重试态（不丢草稿）；上下文引用失效给提示

**⑥ 边界与限制**：旁路会话数据由 provider 管理；不混入主 transcript；只读引用主会话时注意隐私

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| ⌘; 侧聊面板（借主线程上下文提问，不回写） | 侧聊面板禁用卡；主对话不受影响 | 线程列表 + 消息往返 + 上下文引用展示；不写回主对话（只读引用） | 同启用 + 模拟标识 |
| 右栏 Side chat 页签 | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 往返消息 + 上下文引用；断言发问/回复/无回写

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["side-chat"]` / `PiUiCapabilityActionMap["side-chat"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-subagents-panel

**子 agent 状态（只读）** · 分组 workflow · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`simulated` · 需要 provider

子 agent 状态（只读）：多代理运行状态与结果。

| 项 | 值 |
|---|---|
| 能力 ID | `subagents-panel` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `simulated`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [X-图12] SUBAGENTS 面板；[C-图15] |
| Claude 落位 | 任务/子 agent 列表（名称、状态、任务、耗时） |
| Codex 落位 | SUBAGENTS 面板（Active/Thinking/Done 分区） |
| 对应界面 | CL-CODE-25（列表）、CX-PANEL-09 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：面板禁用态；现有只读 subagent 行（转录流内）仍可用
- **启用后（provider 注册）**：多 agent 状态列表：running/idle/done/failed；聚焦/取消动作（provider 定义）
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=subagents-panel`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { agents: PiUiSubagent[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `agents` | `PiUiSubagent[]` | 是 | 列表（数组顺序即展示顺序） |

`agents` 元素字段（`PiUiSubagent`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `name` | `string` | 是 | 展示名 |
| `role` | `string` | 否 | — |
| `status` | `"running" \| "idle" \| "done" \| "failed"` | 是 | 状态（开放枚举） |
| `task` | `string` | 否 | — |
| `startedAt` | `number` | 否 | 毫秒时间戳（UTC） |
| `finishedAt` | `number` | 否 | 毫秒时间戳（UTC） |

**JSON 示例**：

```json
{
  "agents": [
    {
      "id": "x-1",
      "name": "示例名称",
      "role": "示例",
      "status": "running",
      "task": "示例",
      "startedAt": 1750000000000,
      "finishedAt": 1750000000000
    }
  ]
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `focusAgent` | 否 | `(agentId: string) => void` |
| `cancelAgent` | 否 | `(agentId: string) => void` |

**④ 事件与刷新**：`getData` 给 agents；动作 `focusAgent/cancelAgent`；Pi 现有 `agent_state` 事件可做 builtin 数据源（见变体实现）

**⑤ 错误处理**：agent 状态未知 → idle 兜底；取消失败给原因；列表为空=空态

**⑥ 边界与限制**：列表/状态与编排（subagent-orchestration）分开；取消是写操作需确认

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 任务/子 agent 列表（名称、状态、任务、耗时） | 面板禁用态；现有只读 subagent 行（转录流内）仍可用 | 多 agent 状态列表：running/idle/done/failed；聚焦/取消动作（provider 定义） | 同启用 + 模拟标识 |
| SUBAGENTS 面板（Active/Thinking/Done 分区） | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 3 agent×状态/diff 数 + 结果；断言展开/查看/取消

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["subagents-panel"]` / `PiUiCapabilityActionMap["subagents-panel"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-automations

**计划任务** · 分组 workflow · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`unavailable` · 需要 provider

计划任务：定时 / 事件触发的自动任务。

| 项 | 值 |
|---|---|
| 能力 ID | `automations` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `unavailable`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [X-图5] 创建弹窗；[X-§2] 侧栏 计划任务 + review queue |
| Claude 落位 | rail/设置入口（见变体实现） |
| Codex 落位 | 侧栏 计划任务 入口 + 创建弹窗 + 结果 review queue |
| 对应界面 | CX-SIDE-01/08、CX-DLG-03、CX-PAGE-05 |
| 未提供原因 | pi 目前没有计划任务调度；扩展提供后启用。 |

**① 用户看到什么**

- **禁用态（生产默认）**：入口可见、点击禁用态（原因+接入链接）；不显示假自动化
- **启用后（provider 注册）**：列表（名称/触发/启用/上次结果）、创建表单 UI（Name/Workspaces/Prompt/Schedule 星期钮；提交动作契约 v1 未提供，见 §7.4）、立即运行/启停、结果 review queue
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=automations`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { automations: PiUiAutomation[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `automations` | `PiUiAutomation[]` | 是 | 列表（数组顺序即展示顺序） |

`automations` 元素字段（`PiUiAutomation`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `name` | `string` | 是 | 展示名 |
| `description` | `string` | 否 | — |
| `trigger` | `string` | 是 | — |
| `enabled` | `boolean` | 是 | 布尔状态 |
| `lastRunAt` | `number` | 否 | 毫秒时间戳（UTC） |
| `lastResult` | `"success" \| "failed" \| "running" \| "never"` | 否 | — |

**JSON 示例**：

```json
{
  "automations": [
    {
      "id": "x-1",
      "name": "示例名称",
      "description": "示例说明",
      "trigger": "0 2 * * *",
      "enabled": true
    }
  ]
}
```

> lastResult 用于表达运行结果，不要在数据里塞错误字符串

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `runNow` | 否 | `(automationId: string) => void` |
| `toggle` | 否 | `(automationId: string, enabled: boolean) => void` |

**④ 事件与刷新**：`getData` 给 automations；动作 `runNow/toggle`；subscribe 推结果变化（running→success/failed）

**⑤ 错误处理**：创建校验失败 → 表单错误；运行失败 → lastResult=failed + 原因；调度不支持 → 禁用创建并说明

**⑥ 边界与限制**：写操作：创建/启停/运行需二次确认；provider 端权限校验；trigger 只展示不解析（cron/事件描述）

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| rail/设置入口（见变体实现） | 入口可见、点击禁用态（原因+接入链接）；不显示假自动化 | 列表（名称/触发/启用/上次结果）、创建表单 UI（Name/Workspaces/Prompt/Schedule 星期钮；提交动作契约 v1 未提供，见 §7.4）、立即运行/启停、结果 review queue | 同启用 + 模拟标识 |
| 侧栏 计划任务 入口 + 创建弹窗 + 结果 review queue | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 创建表单+schedule+review queue；断言创建→结果→审阅闭环

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["automations"]` / `PiUiCapabilityActionMap["automations"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-code-review-comments

**代码审查评论** · 分组 workflow · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`simulated` · 需要 provider

代码审查评论：行内评论、回复与解决。

| 项 | 值 |
|---|---|
| 能力 ID | `code-review-comments` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `simulated`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [C-§2][C-图4] 行内评论+攒批；[X-§5] Review 评论 |
| Claude 落位 | diff 行内评论 + 攒批提交 |
| Codex 落位 | Review 面板行内评论/攒批 |
| 对应界面 | CL-CODE-09、CX-PANEL-04 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：评论按钮/线程禁用态；diff 本身仍可看
- **启用后（provider 注册）**：行内评论线程（回复/resolve）、草稿攒批、一次提交；评论定位到 file/line
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=code-review-comments`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { threads: PiUiReviewThread[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threads` | `PiUiReviewThread[]` | 是 | 列表（数组顺序即展示顺序） |

`threads` 元素字段（`PiUiReviewThread`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `path` | `string` | 是 | — |
| `line` | `number` | 否 | — |
| `resolved` | `boolean` | 是 | 布尔状态 |
| `comments` | `PiUiReviewComment[]` | 是 | 列表（数组顺序即展示顺序） |

**JSON 示例**：

```json
{
  "threads": [
    {
      "id": "x-1",
      "path": "src/index.ts",
      "line": 1,
      "resolved": true,
      "comments": [
        {
          "id": "x-1",
          "body": "示例内容",
          "createdAt": 1750000000000,
          "resolved": true,
          "path": "src/index.ts",
          "line": 1
        }
      ]
    }
  ]
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `resolveThread` | 否 | `(threadId: string) => void` |
| `reply` | 否 | `(threadId: string, body: string) => void` |

**④ 事件与刷新**：`getData` 给 threads；动作 `resolveThread/reply`；subscribe 刷新线程

**⑤ 错误处理**：提交失败保留草稿+重试；行号漂移 → 线程标「位置可能已变」

**⑥ 边界与限制**：写操作：提交评论/攒批需确认；提交目标是 PR 还是本地由 provider 决定；与 pr-review 边界写清

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| diff 行内评论 + 攒批提交 | 评论按钮/线程禁用态；diff 本身仍可看 | 行内评论线程（回复/resolve）、草稿攒批、一次提交；评论定位到 file/line | 同启用 + 模拟标识 |
| Review 面板行内评论/攒批 | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock diff 行评论+批提交；断言评论→攒批→提交闭环

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["code-review-comments"]` / `PiUiCapabilityActionMap["code-review-comments"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-background-tasks

**后台任务** · 分组 workflow · 来源 builtin · 生产默认 `available` · 注入后（mock/扩展）`available` · builtin（无需 provider）

后台任务：任务看板、进度与取消。

| 项 | 值 |
|---|---|
| 能力 ID | `background-tasks` |
| 生产默认状态 | `available`（无 provider） |
| 注入后状态 | `available`（dev mock 或真实扩展注入后） |
| 是否需 provider | 否（builtin，Pi 现有数据直供） |
| 参考出处 | [C-§2] session rail 后台任务卡；[X-图3] Tasks 看板 |
| Claude 落位 | session rail 后台任务卡 / Tasks 看板 |
| Codex 落位 | Environment 卡 / 状态句 |
| 对应界面 | CL-CODE-24、CL-CHAT-06、CX-PANEL-08 |
| 未提供原因 | 不适用（builtin，Pi 现有数据直供，无需 provider） |

**① 用户看到什么**

- **内置可用（builtin，始终可用）**：现有 `taskList` + terminal items 直接支撑；无数据时空态（无数据时显示空态，不出现能力禁用态）
- **可用状态（builtin 数据直供）**：任务列表（状态/进度/耗时）+ 取消/打开任务（现有能力范围内）

**② 数据契约**（`getData()` 返回）

```ts
type Data = { tasks: PiUiBackgroundTask[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tasks` | `PiUiBackgroundTask[]` | 是 | 列表（数组顺序即展示顺序） |

`tasks` 元素字段（`PiUiBackgroundTask`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `title` | `string` | 是 | 展示名 |
| `status` | `"queued" \| "running" \| "done" \| "failed" \| "cancelled"` | 是 | 状态（开放枚举） |
| `progress` | `number` | 否 | 进度（0–1 或百分比，按 provider 约定） |
| `startedAt` | `number` | 否 | 毫秒时间戳（UTC） |
| `finishedAt` | `number` | 否 | 毫秒时间戳（UTC） |
| `detail` | `string` | 否 | — |

**JSON 示例**：

```json
{
  "tasks": [
    {
      "id": "x-1",
      "title": "示例名称",
      "status": "queued",
      "startedAt": 1750000000000,
      "detail": "示例内容"
    }
  ]
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `cancelTask` | 否 | `(taskId: string) => void` |
| `openTask` | 否 | `(taskId: string) => void` |

**④ 事件与刷新**：读 `relay.taskList` 与 terminal items；状态随 relay 事件更新

**⑤ 错误处理**：任务失败显示 failed+原因；数据不完整按现有空态处理

**⑥ 边界与限制**：只读展示 + 现有取消能力；不要与 plan-pane（计划）混淆

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| session rail 后台任务卡 / Tasks 看板 | n/a（builtin）：现有 `taskList` + terminal items 直接支撑；无数据时空态 | 任务列表（状态/进度/耗时）+ 取消/打开任务（现有能力范围内） | 同启用 + 模拟标识 |
| Environment 卡 / 状态句 | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：无需 mock（builtin）；验收看 Tasks 看板/rail 卡

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["background-tasks"]` / `PiUiCapabilityActionMap["background-tasks"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-worktree

**git worktree（隔离副本）** · 分组 workflow · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`unavailable` · 需要 provider

git worktree（隔离副本）：创建与打开。

| 项 | 值 |
|---|---|
| 能力 ID | `worktree` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `unavailable`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [X-图4④] Worktree 段；[C-图13] |
| Claude 落位 | （无对应；见变体实现） |
| Codex 落位 | 运行位置三段中「创建隔离副本（worktree）…」入口（禁用） |
| 对应界面 | CX-SHELL-02、CX-DLG-06 |
| 未提供原因 | Pi 当前无 git worktree（隔离副本）能力；扩展提供后启用。 |

**① 用户看到什么**

- **禁用态（生产默认）**：入口禁用 + 原因「本机 pi 未提供 git worktree 能力，可接入扩展」+ 接入链接
- **启用后（provider 注册）**：创建/管理隔离副本，写回运行目录（provider 定义）
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=worktree`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { worktrees: PiUiWorktree[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `worktrees` | `PiUiWorktree[]` | 是 | 列表（数组顺序即展示顺序） |

`worktrees` 元素字段（`PiUiWorktree`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `path` | `string` | 是 | — |
| `branch` | `string` | 是 | — |
| `repoPath` | `string` | 是 | — |
| `status` | `"clean" \| "dirty" \| "missing"` | 是 | 状态（开放枚举） |

**JSON 示例**：

```json
{
  "worktrees": [
    {
      "id": "x-1",
      "path": "src/index.ts",
      "branch": "示例",
      "repoPath": "示例",
      "status": "clean"
    }
  ]
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `createWorktree` | 否 | `(repoPath: string, branch: string) => void` |
| `openWorktree` | 否 | `(worktreeId: string) => void` |

**④ 事件与刷新**：`getData` 给 worktree 状态；动作由 provider 定义；subscribe 刷新

**⑤ 错误处理**：创建失败回滚目录选择；git 不可用给原因

**⑥ 边界与限制**：写操作；与 work-mode 的「指定文件夹」区分：那是目录选择，不创建 worktree

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| （无对应；见变体实现） | 入口禁用 + 原因「本机 pi 未提供 git worktree 能力，可接入扩展」+ 接入链接 | 创建/管理隔离副本，写回运行目录（provider 定义） | 同启用 + 模拟标识 |
| 运行位置三段中「创建隔离副本（worktree）…」入口（禁用） | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 创建流程（simulated）；断言创建→目录写回

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["worktree"]` / `PiUiCapabilityActionMap["worktree"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-session-pin

**会话置顶** · 分组 workflow · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`simulated` · 需要 provider

会话置顶与收藏。

| 项 | 值 |
|---|---|
| 能力 ID | `session-pin` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `simulated`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [X-图3①] Pinned 区 |
| Claude 落位 | 侧栏置顶区 |
| Codex 落位 | 侧栏 Pinned 区 |
| 对应界面 | CX-SIDE-04、CL-SHELL-02 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：置顶操作禁用态；会话列表正常
- **启用后（provider 注册）**：置顶/取消置顶 + 持久化（provider 定义）
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=session-pin`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { pinned: PiUiPinnedSession[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pinned` | `PiUiPinnedSession[]` | 是 | 列表（数组顺序即展示顺序） |

`pinned` 元素字段（`PiUiPinnedSession`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sessionId` | `string` | 是 | 唯一标识（provider 内稳定） |
| `pinnedAt` | `number` | 是 | 毫秒时间戳（UTC） |

**JSON 示例**：

```json
{
  "pinned": [
    {
      "sessionId": "x-1",
      "pinnedAt": 1750000000000
    }
  ]
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `togglePin` | 否 | `(sessionId: string) => void` |

**④ 事件与刷新**：`getData` 给 pinned；动作 `togglePin`

**⑤ 错误处理**：写失败回滚 UI 并提示

**⑥ 边界与限制**：写操作；不影响会话排序真实数据

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 侧栏置顶区 | 置顶操作禁用态；会话列表正常 | 置顶/取消置顶 + 持久化（provider 定义） | 同启用 + 模拟标识 |
| 侧栏 Pinned 区 | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 持久化置顶；断言置顶/取消

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["session-pin"]` / `PiUiCapabilityActionMap["session-pin"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-work-mode

**运行位置** · 分组 workflow · 来源 builtin · 生产默认 `available` · 注入后（mock/扩展）`available` · builtin（无需 provider）

运行位置：当前设备 / 指定文件夹 / 远端设备。

| 项 | 值 |
|---|---|
| 能力 ID | `work-mode` |
| 生产默认状态 | `available`（无 provider） |
| 注入后状态 | `available`（dev mock 或真实扩展注入后） |
| 是否需 provider | 否（builtin，Pi 现有数据直供） |
| 参考出处 | [X-图4④] Local/Worktree/Cloud 三段 |
| Claude 落位 | （无对应；对应物是工作台模式，由 workspace-modes 承载） |
| Codex 落位 | 新建线程空状态 composer 下方三段：当前设备 / 指定文件夹 / 远端设备 |
| 对应界面 | CX-COMP-07、CX-DLG-06 |
| 未提供原因 | 不适用（builtin，Pi 现有数据直供，无需 provider） |

**① 用户看到什么**

- **内置可用（builtin，始终可用）**：三段 UI 始终可用；选「Worktree=指定文件夹」不创建 worktree，worktree 能力入口单独禁用（无数据时显示空态，不出现能力禁用态）
- **可用状态（builtin 数据直供）**：切段改变新建会话的初始设备/目录；摘要行显示「设备 · 目录」；每段记住上次选择

**② 数据契约**（`getData()` 返回）

```ts
type Data = { modes: PiUiWorkModeOption[]; activeModeId?: string }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `modes` | `PiUiWorkModeOption[]` | 是 | 列表（数组顺序即展示顺序） |
| `activeModeId` | `string` | 否 | 唯一标识（provider 内稳定） |

`modes` 元素字段（`PiUiWorkModeOption`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `label` | `string` | 是 | 展示名 |
| `description` | `string` | 否 | — |

**JSON 示例**：

```json
{
  "modes": [
    {
      "id": "x-1",
      "label": "示例名称"
    }
  ],
  "activeModeId": "x-1"
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `selectWorkMode` | 否 | `(modeId: string) => void` |

**④ 事件与刷新**：实现见 `ui/src/pi/variants/codex/sidebar/CodexRunLocation.tsx`（`local`/`folder`/`remote` 与契约 `PI_UI_RUN_LOCATIONS` 同值）；切段只改新建参数、不新增 relay 分支

**⑤ 错误处理**：目录为空不可发送并提示；远端设备离线禁用并写原因

**⑥ 边界与限制**：纯 UI；不改新建会话流程（仍走 relay.createSession(cwd)）；与 worktree 能力区分

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| （无对应；对应物是工作台模式，由 workspace-modes 承载） | n/a（builtin）：三段 UI 始终可用；选「Worktree=指定文件夹」不创建 worktree，worktree 能力入口单独禁用 | 切段改变新建会话的初始设备/目录；摘要行显示「设备 · 目录」；每段记住上次选择 | 同启用 + 模拟标识 |
| 新建线程空状态 composer 下方三段：当前设备 / 指定文件夹 / 远端设备 | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：无需 mock（builtin）；验收看三段切换/摘要/禁用原因

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["work-mode"]` / `PiUiCapabilityActionMap["work-mode"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-subagent-orchestration

**多代理编排** · 分组 workflow · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`simulated` · 需要 provider

多代理编排：多 agent 画布与任务编排。

| 项 | 值 |
|---|---|
| 能力 ID | `subagent-orchestration` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `simulated`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [C-图15] 多代理画布（CL-CODE-25） |
| Claude 落位 | 工作台多代理画布（编排/连线/分派） |
| Codex 落位 | 子 agent 画布（见变体实现） |
| 对应界面 | CL-CODE-25 |
| 未提供原因 | 需多代理编排扩展；pi 当前无编排能力。 |

**① 用户看到什么**

- **禁用态（生产默认）**：画布区域禁用态；subagents-panel 列表不受影响
- **启用后（provider 注册）**：多 agent 编排视图（节点/连线/分派/汇总），provider 定义数据模型
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=subagent-orchestration`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = PiUiSubagentOrchestration
```

**JSON 示例**：

```json
{}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `focusNode` | 否 | `(agentId: string) => void` |
| `openCanvas` | 否 | `() => void` |

**④ 事件与刷新**：`getData` 给编排数据；动作由 provider 定义；subscribe 刷新

**⑤ 错误处理**：编排数据不合法 → 只读降级 + 提示

**⑥ 边界与限制**：与 subagents-panel（列表/状态）边界写清；写操作需确认

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 工作台多代理画布（编排/连线/分派） | 画布区域禁用态；subagents-panel 列表不受影响 | 多 agent 编排视图（节点/连线/分派/汇总），provider 定义数据模型 | 同启用 + 模拟标识 |
| 子 agent 画布（见变体实现） | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 画布（simulated）；断言节点/分派

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["subagent-orchestration"]` / `PiUiCapabilityActionMap["subagent-orchestration"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-thread-fork-feedback

**会话分叉与反馈** · 分组 workflow · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`simulated` · 需要 provider

会话分叉与反馈：从任意回合分叉，Good / Bad 反馈。

| 项 | 值 |
|---|---|
| 能力 ID | `thread-fork-feedback` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `simulated`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [X-THREAD-07] 回合动作条（Copy/Good/Bad/Fork） |
| Claude 落位 | 回合操作条：Fork 可用，Good/Bad 反馈禁用 |
| Codex 落位 | 回合操作条：同上 |
| 对应界面 | CX-THREAD-07 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：fork 部分为 Pi 现有能力（available）；Good/Bad 反馈按钮禁用+原因（无反馈数据源）
- **启用后（provider 注册）**：fork 走现有 fork 命令；反馈走 provider（feedback.enabled=true 时可用）
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=thread-fork-feedback`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = PiUiThreadForkFeedback
```

**JSON 示例**：

```json
{}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `forkThread` | 否 | `(branchId: string) => void` |
| `sendFeedback` | 否 | `(vote: "good" \| "bad") => void` |

**④ 事件与刷新**：fork 用现有命令/事件；反馈动作由 provider 定义

**⑤ 错误处理**：fork 失败提示原因；反馈失败不阻塞对话

**⑥ 边界与限制**：一个能力两个子状态（fork.available / feedback.enabled），文档卡片要分开写

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 回合操作条：Fork 可用，Good/Bad 反馈禁用 | fork 部分为 Pi 现有能力（available）；Good/Bad 反馈按钮禁用+原因（无反馈数据源） | fork 走现有 fork 命令；反馈走 provider（feedback.enabled=true 时可用） | 同启用 + 模拟标识 |
| 回合操作条：同上 | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 反馈（simulated）+ fork 真实路径；断言两种状态

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["thread-fork-feedback"]` / `PiUiCapabilityActionMap["thread-fork-feedback"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### 4.4 外观与权限

### cap-permission-tiers

**审批策略** · 分组 customization · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`unavailable` · 需要 provider

审批策略：权限档位切换（当前 pi 为逐次确认）。

| 项 | 值 |
|---|---|
| 能力 ID | `permission-tiers` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `unavailable`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [C-§4] 权限五档谱系；[X-§4] 三档 chip |
| Claude 落位 | composer 下方权限选择器（五档） |
| Codex 落位 | composer 审批 chip（三档） |
| 对应界面 | CL-CODE-14/16、CX-COMP-02/04、CX-PAGE-04 |
| 未提供原因 | pi 当前为逐次确认（允许 / 拒绝），没有档位切换；扩展提供档位后启用。 |

**① 用户看到什么**

- **禁用态（生产默认）**：选择器可见但禁用，显示当前 Pi 实际策略（审批 dialog）；切换入口禁用+原因
- **启用后（provider 注册）**：档位列表（label/描述/allows 能力清单）+ 当前档位 + selectTier；按文件夹记忆（provider 定义）
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=permission-tiers`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { tiers: PiUiPermissionTier[]; currentTierId?: string }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tiers` | `PiUiPermissionTier[]` | 是 | 列表（数组顺序即展示顺序） |
| `currentTierId` | `string` | 否 | 唯一标识（provider 内稳定） |

`tiers` 元素字段（`PiUiPermissionTier`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `label` | `string` | 是 | 展示名 |
| `description` | `string` | 否 | — |
| `allows` | `string[]` | 是 | 列表（数组顺序即展示顺序） |

**JSON 示例**：

```json
{
  "tiers": [
    {
      "id": "x-1",
      "label": "示例名称",
      "description": "示例说明",
      "allows": [
        "示例"
      ]
    }
  ],
  "currentTierId": "x-1"
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `selectTier` | 否 | `(tierId: string) => void` |

**④ 事件与刷新**：`getData` 给 tiers+currentTierId；动作 `selectTier`；subscribe 刷新

**⑤ 错误处理**：切换失败 → 保持原档位+提示；档位未知 → 只读展示

**⑥ 边界与限制**：与 Pi 现有审批语义差异如实说明（协议只有 allow/deny）；写操作需确认；安全边界由 provider 承担

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| composer 下方权限选择器（五档） | 选择器可见但禁用，显示当前 Pi 实际策略（审批 dialog）；切换入口禁用+原因 | 档位列表（label/描述/allows 能力清单）+ 当前档位 + selectTier；按文件夹记忆（provider 定义） | 同启用 + 模拟标识 |
| composer 审批 chip（三档） | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 五档/三档 + 记忆；断言切档→permission state 变化

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["permission-tiers"]` / `PiUiCapabilityActionMap["permission-tiers"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-density-modes

**密度模式** · 分组 customization · 来源 builtin · 生产默认 `available` · 注入后（mock/扩展）`available` · builtin（无需 provider）

显示密度：舒适 / 紧凑 / 详细。

| 项 | 值 |
|---|---|
| 能力 ID | `density-modes` |
| 生产默认状态 | `available`（无 provider） |
| 注入后状态 | `available`（dev mock 或真实扩展注入后） |
| 是否需 provider | 否（builtin，Pi 现有数据直供） |
| 参考出处 | [C-§5] Normal/Thinking/Verbose；[X-§8] 折叠密度 |
| Claude 落位 | 设置/侧栏密度（舒适/紧凑/详细） |
| Codex 落位 | 设置 + Worked for 折叠行控制 |
| 对应界面 | CL-CODE-18、CX-COMP-05、CX-PAGE-12 |
| 未提供原因 | 不适用（builtin，Pi 现有数据直供，无需 provider） |

**① 用户看到什么**

- **内置可用（builtin，始终可用）**：直接映射现有 `prefs.density`（compact/balanced/detailed）（无数据时显示空态，不出现能力禁用态）
- **可用状态（builtin 数据直供）**：三档映射到变体样式与折叠深度；切换即时生效并持久化

**② 数据契约**（`getData()` 返回）

```ts
type Data = { modes: PiUiDensityMode[]; currentModeId?: string }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `modes` | `PiUiDensityMode[]` | 是 | 列表（数组顺序即展示顺序） |
| `currentModeId` | `string` | 否 | 唯一标识（provider 内稳定） |

`modes` 元素字段（`PiUiDensityMode`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `label` | `string` | 是 | 展示名 |
| `description` | `string` | 否 | — |
| `rowHeight` | `number` | 否 | — |
| `fontSize` | `number` | 否 | — |

**JSON 示例**：

```json
{
  "modes": [
    {
      "id": "x-1",
      "label": "示例名称",
      "fontSize": 1
    }
  ],
  "currentModeId": "x-1"
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `selectMode` | 否 | `(modeId: string) => void` |

**④ 事件与刷新**：读写 `prefs.density`；切变体不影响偏好

**⑤ 错误处理**：非法值回落 balanced

**⑥ 边界与限制**：纯显示偏好；不改变工具执行/协议

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 设置/侧栏密度（舒适/紧凑/详细） | n/a（builtin）：直接映射现有 `prefs.density`（compact/balanced/detailed） | 三档映射到变体样式与折叠深度；切换即时生效并持久化 | 同启用 + 模拟标识 |
| 设置 + Worked for 折叠行控制 | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：无需 mock；验收看三档几何/折叠差异

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["density-modes"]` / `PiUiCapabilityActionMap["density-modes"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-theme-custom

**主题自定义** · 分组 customization · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`simulated` · 需要 provider

主题自定义：界面颜色与字体。

| 项 | 值 |
|---|---|
| 能力 ID | `theme-custom` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `simulated`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [X-图15] 表面色/强调色/导入导出 |
| Claude 落位 | 设置外观（自定义强调色） |
| Codex 落位 | 设置 Appearance（Accent/Background/Foreground + 导入导出） |
| 对应界面 | CX-SHELL-06、CX-PAGE-12 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：自定义区域禁用态；内置 light/dark/system 仍可用
- **启用后（provider 注册）**：自定义表面/强调色、主题导入导出（provider 定义）
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=theme-custom`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { customization: PiUiThemeCustomization }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `customization` | `PiUiThemeCustomization` | 是 | — |

`customization` 元素字段（`PiUiThemeCustomization`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `surface` | `string` | 否 | — |
| `accent` | `string` | 否 | — |
| `fontFamily` | `string` | 否 | — |
| `importedFrom` | `string` | 否 | — |

**JSON 示例**：

```json
{
  "customization": {
    "surface": "示例",
    "accent": "示例",
    "importedFrom": "示例"
  }
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `applyTheme` | 否 | `(patch: PiUiThemeCustomization) => void` |
| `resetTheme` | 否 | `() => void` |

**④ 事件与刷新**：`getData` 给 customization；动作 `applyTheme/resetTheme`

**⑤ 错误处理**：非法色值拒绝并提示；导入格式错误不覆盖当前主题

**⑥ 边界与限制**：只影响变体自有 token，不污染 cursor；对比度校验

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 设置外观（自定义强调色） | 自定义区域禁用态；内置 light/dark/system 仍可用 | 自定义表面/强调色、主题导入导出（provider 定义） | 同启用 + 模拟标识 |
| 设置 Appearance（Accent/Background/Foreground + 导入导出） | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 自定义 token；断言应用/重置

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["theme-custom"]` / `PiUiCapabilityActionMap["theme-custom"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-notifications

**通知规则** · 分组 customization · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`unavailable` · 需要 provider

通知规则：按事件与设备配置通知。

| 项 | 值 |
|---|---|
| 能力 ID | `notifications` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `unavailable`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [X-图15] 设置通知区；[C-§0] |
| Claude 落位 | 设置通知区 |
| Codex 落位 | 设置 Personal 分组 |
| 对应界面 | CX-PAGE-12、CL-SHELL-08 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：通知规则区禁用态；现有 completionSound 等设置不受影响
- **启用后（provider 注册）**：通知规则列表（事件/渠道/开关）+ updateRule（provider 定义）
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=notifications`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { rules: PiUiNotificationRule[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `rules` | `PiUiNotificationRule[]` | 是 | 列表（数组顺序即展示顺序） |

`rules` 元素字段（`PiUiNotificationRule`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `label` | `string` | 是 | 展示名 |
| `enabled` | `boolean` | 是 | 布尔状态 |
| `channel` | `"system" \| "sound" \| "badge" \| "none"` | 是 | — |
| `trigger` | `string` | 是 | — |

**JSON 示例**：

```json
{
  "rules": [
    {
      "id": "x-1",
      "label": "示例名称",
      "enabled": true,
      "channel": "system",
      "trigger": "0 2 * * *"
    }
  ]
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `updateRule` | 否 | `(ruleId: string, patch: Partial<Omit<PiUiNotificationRule, "id">>) => void` |

**④ 事件与刷新**：`getData` 给 rules；动作 `updateRule`；subscribe 刷新

**⑤ 错误处理**：保存失败回滚开关+提示

**⑥ 边界与限制**：写操作；渠道能力由 provider/浏览器决定

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 设置通知区 | 通知规则区禁用态；现有 completionSound 等设置不受影响 | 通知规则列表（事件/渠道/开关）+ updateRule（provider 定义） | 同启用 + 模拟标识 |
| 设置 Personal 分组 | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 规则列表/开关；断言开关持久化

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["notifications"]` / `PiUiCapabilityActionMap["notifications"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### 4.5 扩展与集成

### cap-pr-review

**代码审查** · 分组 integration · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`simulated` · 需要 provider

代码审查：PR 列表、详情、评论与审查动作。

| 项 | 值 |
|---|---|
| 能力 ID | `pr-review` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `simulated`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [X-图16] PR 详情；[X-图10] Review 面板；[X-§5] |
| Claude 落位 | Changes 卡评论联动（见变体实现） |
| Codex 落位 | 侧栏 PRs + PR 详情页 + Review 面板（范围 chips/文件树/评论/动作） |
| 对应界面 | CX-PAGE-06/07、CX-PANEL-04、CL-CODE-13/26/27 |
| 未提供原因 | 当前无法直连远端代码平台；扩展提供代码审查数据后启用。 |

**① 用户看到什么**

- **禁用态（生产默认）**：PR 列表/详情页完整显示但顶部禁用条（「本机 pi 未提供 PR 能力」+ 接入链接）；Review 动作为禁用态
- **启用后（provider 注册）**：PR 列表（状态/审查态/时间）、详情（checks/文件/评论）、Review 范围 chips；动作 approve / requestChanges / mergePr（可带 `merge`/`squash`/`rebase`）/ closePr / archivePr / reopenPr
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=pr-review`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { pullRequests: PiUiPullRequest[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pullRequests` | `PiUiPullRequest[]` | 是 | 列表（数组顺序即展示顺序） |

`pullRequests` 元素字段（`PiUiPullRequest`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `number` | `number` | 是 | — |
| `title` | `string` | 是 | 展示名 |
| `repo` | `string` | 是 | — |
| `author` | `string` | 否 | — |
| `state` | `"open" \| "draft" \| "merged" \| "closed" \| "archived"` | 是 | 状态（开放枚举；archived = 归档案，与 closed 区分） |
| `reviewState` | `"pending" \| "approved" \| "changes_requested" \| "commented"` | 否 | 状态（开放枚举） |
| `updatedAt` | `number` | 是 | 毫秒时间戳（UTC） |
| `url` | `string` | 否 | 链接（https；不可信内容） |

**JSON 示例**：

```json
{
  "pullRequests": [
    {
      "id": "x-1",
      "number": 1,
      "title": "示例名称",
      "repo": "example/pi-remote",
      "author": "alice",
      "state": "open",
      "reviewState": "pending",
      "updatedAt": 1750000000000
    }
  ]
}
```

> state/reviewState 是开放枚举，未知值按「未知」渲染

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `openPr` | 否 | `(prId: string) => void` |
| `approve` | 否 | `(prId: string) => void` |
| `requestChanges` | 否 | `(prId: string, comment: string) => void` |
| `mergePr` | 否 | `(prId: string, method?: "merge" \| "squash" \| "rebase") => void` |
| `closePr` | 否 | `(prId: string) => void` |
| `archivePr` | 否 | `(prId: string) => void` |
| `reopenPr` | 否 | `(prId: string) => void` |

**④ 事件与刷新**：`getData` 给 pullRequests；动作后 `subscribe` 刷新；事件类型 `PiUiPrReviewEventType`（7 个，UI 据此刷新列表/详情，不轮询）：`pr:opened` / `pr:approved` / `pr:changes-requested` / `pr:merged` / `pr:closed` / `pr:archived` / `pr:reopened`；事件体 `PiUiPrReviewEvent = PiUiExtensionEvent<"pr-review"> & { type; prId }`

**⑤ 错误处理**：未授权/无远端仓库 → 解释性禁用；merge 权限不足/冲突 → 明确错误并保持原状态（不改 UI 假状态）；checks pending 或 draft → merge 按钮禁用+原因；close/archive 需二次确认；未知 state 兜底渲染

**⑥ 边界与限制**：外部 id 稳定（建议 `owner/repo#number`）；url 只 https + noopener；写操作双确认 + provider 权限校验；`mergePr.method` 只接受 `merge`/`squash`/`rebase`；只读优先（先列表/详情后动作）

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| Changes 卡评论联动（见变体实现） | PR 列表/详情页完整显示但顶部禁用条（「本机 pi 未提供 PR 能力」+ 接入链接）；Review 动作为禁用态 | PR 列表（状态/审查态/时间）、详情（checks/文件/评论）、Review 范围 chips；approve / requestChanges / mergePr / closePr / archivePr / reopenPr | 同启用 + 模拟标识 |
| 侧栏 PRs + PR 详情页 + Review 面板（范围 chips/文件树/评论/动作） | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock fixtures 覆盖 open/draft/merged/closed/**archived**（`?caps=pr-review`）；断言审阅→评论→merge/close/archive/reopen 的状态变化与按钮可用性

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiPullRequest` / `PiUiCapabilityDataMap["pr-review"]` / `PiUiCapabilityActionMap["pr-review"]` / `PiUiPrReviewEventType` / `PiUiPrReviewEvent`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-git-commit

**Git 提交链路** · 分组 integration · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`unavailable` · 需要 provider

Git 提交：commit / push / 创建 PR。

| 项 | 值 |
|---|---|
| 能力 ID | `git-commit` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `unavailable`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [X-§6][X-图13④] Commit 下拉；[X-图11] Environment 卡 |
| Claude 落位 | 变更区 Commit 入口 |
| Codex 落位 | 顶栏 Open/Commit 下拉 + Review 面板 Commit or push / Create PR |
| 对应界面 | CX-SHELL-03、CX-DLG-06、CL-CODE-26/27 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：Commit/Commit or push/Create PR 按钮禁用态 + 原因（Pi 无 git 写接口）+ 接入链接
- **启用后（provider 注册）**：仓库状态 → commit（message）→ push → create PR 链路；成功后刷新 changes/branch 与 PR 列表
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=git-commit`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { repos: PiUiGitState[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `repos` | `PiUiGitState[]` | 是 | 列表（数组顺序即展示顺序） |

`repos` 元素字段（`PiUiGitState`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `repoPath` | `string` | 是 | — |
| `branch` | `string` | 是 | — |
| `staged` | `string[]` | 是 | 列表（数组顺序即展示顺序） |
| `unstaged` | `string[]` | 是 | 列表（数组顺序即展示顺序） |
| `canCommit` | `boolean` | 是 | — |

**JSON 示例**：

```json
{
  "repos": [
    {
      "repoPath": "示例",
      "branch": "示例",
      "staged": [
        "示例"
      ],
      "unstaged": [
        "示例"
      ],
      "canCommit": true
    }
  ]
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `commit` | 否 | `(repoPath: string, message: string) => void` |
| `push` | 否 | `(repoPath: string) => void` |
| `createPr` | 否 | `(repoPath: string) => void` |

**④ 事件与刷新**：`getData` 给 repos（git 状态）；动作 `commit/push/createPr`；subscribe 刷新

**⑤ 错误处理**：无未提交变更 → 按钮禁用+原因；push 冲突/权限失败 → 明确错误+建议；PR 创建失败保留 commit 结果

**⑥ 边界与限制**：写操作：commit message 预览、二次确认；不自动 force push；repository 路径来自设备声明目录

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 变更区 Commit 入口 | Commit/Commit or push/Create PR 按钮禁用态 + 原因（Pi 无 git 写接口）+ 接入链接 | 仓库状态 → commit（message）→ push → create PR 链路；成功后刷新 changes/branch 与 PR 列表 | 同启用 + 模拟标识 |
| 顶栏 Open/Commit 下拉 + Review 面板 Commit or push / Create PR | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock commit/stage/revert/branch 事件；断言 commit→push→PR 链路

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["git-commit"]` / `PiUiCapabilityActionMap["git-commit"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-plugins

**扩展** · 分组 integration · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`unavailable` · 需要 provider

扩展：pi 扩展的安装与启用。

| 项 | 值 |
|---|---|
| 能力 ID | `plugins` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `unavailable`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [X-§9.2] 扩展 页；[C-§2] 插件入口 |
| Claude 落位 | composer `+` 菜单 / 设置入口 |
| Codex 落位 | 侧栏 扩展 页（列表/启用/配置） |
| 对应界面 | CX-PAGE-08/09、CL-CODE-15、CX-COMP-08 |
| 未提供原因 | pi 当前没有扩展安装入口；扩展系统提供后启用。 |

**① 用户看到什么**

- **禁用态（生产默认）**：页面/入口完整显示+禁用态；不显示假插件
- **启用后（provider 注册）**：插件列表（版本/来源/启用态）+ 安装/启停动作（provider 定义）；与技能/连接器入口区分
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=plugins`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { plugins: PiUiPlugin[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `plugins` | `PiUiPlugin[]` | 是 | 列表（数组顺序即展示顺序） |

`plugins` 元素字段（`PiUiPlugin`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `name` | `string` | 是 | 展示名 |
| `version` | `string` | 是 | — |
| `description` | `string` | 否 | — |
| `installed` | `boolean` | 是 | 布尔状态 |
| `enabled` | `boolean` | 是 | 布尔状态 |

**JSON 示例**：

```json
{
  "plugins": [
    {
      "id": "x-1",
      "name": "示例名称",
      "version": "示例",
      "description": "示例说明",
      "installed": true,
      "enabled": true
    }
  ]
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `installPlugin` | 否 | `(pluginId: string) => void` |
| `setPluginEnabled` | 否 | `(pluginId: string, enabled: boolean) => void` |

**④ 事件与刷新**：`getData` 给 plugins；动作 `installPlugin/setPluginEnabled`；subscribe 刷新

**⑤ 错误处理**：安装失败 → 行内错误+重试；版本不兼容 → 禁用安装并说明

**⑥ 边界与限制**：写操作：安装/启停需确认；插件安全边界由 provider 负责；不承诺真实插件运行时

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| composer `+` 菜单 / 设置入口 | 页面/入口完整显示+禁用态；不显示假插件 | 插件列表（版本/来源/启用态）+ 安装/启停动作（provider 定义）；与技能/连接器入口区分 | 同启用 + 模拟标识 |
| 侧栏 扩展 页（列表/启用/配置） | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 列表+启用+配置；断言启用→UI 解锁

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["plugins"]` / `PiUiCapabilityActionMap["plugins"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-connectors

**连接器** · 分组 integration · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`unavailable` · 需要 provider

连接器：外部服务连接及状态。

| 项 | 值 |
|---|---|
| 能力 ID | `connectors` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `unavailable`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [C-§2] 连接器 rail；[X-§2] Integrations |
| Claude 落位 | session rail 连接器卡 / 设置 |
| Codex 落位 | 设置 Integrations 分组 |
| 对应界面 | CX-PAGE-09、CL-CODE-11、CX-COMP-08 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：连接器 区域禁用态；MCP（builtin）列表不受影响
- **启用后（provider 注册）**：外部服务列表（kind/状态/账号脱敏/最后同步）+ connect/disconnect
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=connectors`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { connectors: PiUiConnector[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `connectors` | `PiUiConnector[]` | 是 | 列表（数组顺序即展示顺序） |

`connectors` 元素字段（`PiUiConnector`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `name` | `string` | 是 | 展示名 |
| `kind` | `string` | 是 | 类型（开放枚举，未知值按兜底渲染） |
| `status` | `"connected" \| "disconnected" \| "error"` | 是 | 状态（开放枚举） |
| `account` | `string` | 否 | 数量 |
| `lastSyncAt` | `number` | 否 | 毫秒时间戳（UTC） |

**JSON 示例**：

```json
{
  "connectors": [
    {
      "id": "x-1",
      "name": "示例名称",
      "kind": "示例",
      "status": "connected",
      "account": "alice"
    }
  ]
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `connect` | 否 | `(connectorId: string) => void` |
| `disconnect` | 否 | `(connectorId: string) => void` |

**④ 事件与刷新**：`getData` 给 connectors；动作 `connect/disconnect`；subscribe 刷新状态

**⑤ 错误处理**：授权失败/过期 → error 状态+重新连接；账号信息脱敏展示

**⑥ 边界与限制**：密钥不进前端；OAuth 由 provider 处理；与 mcp-tools 边界：MCP server 走 mcp-tools

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| session rail 连接器卡 / 设置 | 连接器 区域禁用态；MCP（builtin）列表不受影响 | 外部服务列表（kind/状态/账号脱敏/最后同步）+ connect/disconnect | 同启用 + 模拟标识 |
| 设置 Integrations 分组 | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 连接器列表+启用+配置；断言连接状态变化

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["connectors"]` / `PiUiCapabilityActionMap["connectors"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-skills

**技能** · 分组 integration · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`simulated` · 需要 provider

技能：可复用的 pi 技能与斜杠命令。

| 项 | 值 |
|---|---|
| 能力 ID | `skills` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `simulated`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [C-§3] skills；[X-图1①] 技能 页 |
| Claude 落位 | composer 菜单/设置 skills 入口 |
| Codex 落位 | 设置 技能 / 斜杠菜单来源标注 |
| 对应界面 | CL-CODE-15、CX-PAGE-08 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：skills 列表禁用态；现有斜杠命令（含 skill source）仍可用
- **启用后（provider 注册）**：技能包列表（名称/描述/来源/启用）+ 启停（provider 定义）；与斜杠命令来源联动
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=skills`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { skills: PiUiSkill[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `skills` | `PiUiSkill[]` | 是 | 列表（数组顺序即展示顺序） |

`skills` 元素字段（`PiUiSkill`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `name` | `string` | 是 | 展示名 |
| `description` | `string` | 否 | — |
| `source` | `string` | 否 | — |
| `enabled` | `boolean` | 是 | 布尔状态 |

**JSON 示例**：

```json
{
  "skills": [
    {
      "id": "x-1",
      "name": "示例名称",
      "enabled": true
    }
  ]
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `toggleSkill` | 否 | `(skillId: string, enabled: boolean) => void` |

**④ 事件与刷新**：`getData` 给 skills；动作 `toggleSkill`；subscribe 刷新

**⑤ 错误处理**：启停失败 → 行内错误；技能包缺失 → 标记不可用

**⑥ 边界与限制**：仅浏览/启停；真正的技能执行走 pi 命令面；不承诺安装运行时

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| composer 菜单/设置 skills 入口 | skills 列表禁用态；现有斜杠命令（含 skill source）仍可用 | 技能包列表（名称/描述/来源/启用）+ 启停（provider 定义）；与斜杠命令来源联动 | 同启用 + 模拟标识 |
| 设置 技能 / 斜杠菜单来源标注 | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 列表+调用；断言启用→UI 解锁

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["skills"]` / `PiUiCapabilityActionMap["skills"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-mcp-tools

**MCP 工具** · 分组 integration · 来源 builtin · 生产默认 `available` · 注入后（mock/扩展）`available` · builtin（无需 provider）

MCP 工具：服务与工具列表、入参表单与审批。

| 项 | 值 |
|---|---|
| 能力 ID | `mcp-tools` |
| 生产默认状态 | `available`（无 provider） |
| 注入后状态 | `available`（dev mock 或真实扩展注入后） |
| 是否需 provider | 否（builtin，Pi 现有数据直供） |
| 参考出处 | [C-图15] MCP 审批卡；[X-§2] MCP 行 |
| Claude 落位 | 审批卡来源 chip（mcp://…）/ 工具列表 |
| Codex 落位 | 设置 MCP 行 / 审批卡 |
| 对应界面 | CL-CODE-23、CX-PAGE-04 |
| 未提供原因 | 不适用（builtin，Pi 现有数据直供，无需 provider） |

**① 用户看到什么**

- **内置可用（builtin，始终可用）**：`get_mcp_servers` 只读清单 + 现有审批 dialog 支撑；无 MCP 服务器时空态（无数据时显示空态，不出现能力禁用态）
- **可用状态（builtin 数据直供）**：MCP server/tool 列表（状态/toolCount/错误）+ 审批卡显示来源/入参；调用走现有 pi 工具调用链路

**② 数据契约**（`getData()` 返回）

```ts
type Data = { servers: PiUiMcpServer[]; tools: PiUiMcpTool[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `servers` | `PiUiMcpServer[]` | 是 | 列表（数组顺序即展示顺序） |
| `tools` | `PiUiMcpTool[]` | 是 | 列表（数组顺序即展示顺序） |

`servers` 元素字段（`PiUiMcpServer`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `name` | `string` | 是 | 展示名 |
| `status` | `"connected" \| "disconnected" \| "error"` | 是 | 状态（开放枚举） |
| `toolCount` | `number` | 否 | 数量 |

`tools` 元素字段（`PiUiMcpTool`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `serverId` | `string` | 是 | 所属 MCP server id |
| `name` | `string` | 是 | 展示名 |
| `description` | `string` | 否 | — |
| `inputSchema` | `Record<string, unknown>` | 否 | — |

**JSON 示例**：

```json
{
  "servers": [
    {
      "id": "x-1",
      "name": "示例名称",
      "status": "connected",
      "toolCount": 1
    }
  ],
  "tools": [
    {
      "id": "x-1",
      "serverId": "x-1",
      "name": "示例名称",
      "inputSchema": {
        "key": "value"
      }
    }
  ]
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `callTool` | 否 | `(toolId: string, input: Record<string, unknown>) => void` |

**④ 事件与刷新**：读 `get_mcp_servers`（只读白名单投影）；审批走现有 dialog 事件

**⑤ 错误处理**：server 连接失败显示 error+原因；敏感字段永不回传

**⑥ 边界与限制**：只读清单 + 既有审批；不新增 MCP 配置写入；密钥/headers 不展示

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 审批卡来源 chip（mcp://…）/ 工具列表 | n/a（builtin）：`get_mcp_servers` 只读清单 + 现有审批 dialog 支撑；无 MCP 服务器时空态 | MCP server/tool 列表（状态/toolCount/错误）+ 审批卡显示来源/入参；调用走现有 pi 工具调用链路 | 同启用 + 模拟标识 |
| 设置 MCP 行 / 审批卡 | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：MCP 审批 mock 已有（画廊）；验收看审批卡来源 chip

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["mcp-tools"]` / `PiUiCapabilityActionMap["mcp-tools"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-workspace-connectors

**连接 rail 卡** · 分组 integration · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`unavailable` · 需要 provider

连接入口：服务器与连接器卡片。

| 项 | 值 |
|---|---|
| 能力 ID | `workspace-connectors` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `unavailable`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [C-§2] 服务器/连接 rail 卡 |
| Claude 落位 | session rail 连接器/服务器卡 |
| Codex 落位 | Environment 卡扩展行 |
| 对应界面 | CL-CODE-11、CX-PANEL-08 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：rail 卡禁用态（可看不可操作）
- **启用后（provider 注册）**：服务器/连接器状态卡：名称/状态/数量/操作（provider 定义）
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=workspace-connectors`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { connectors: PiUiWorkspaceConnectorCard[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `connectors` | `PiUiWorkspaceConnectorCard[]` | 是 | 列表（数组顺序即展示顺序） |

`connectors` 元素字段（`PiUiWorkspaceConnectorCard`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一标识（provider 内稳定） |
| `name` | `string` | 是 | 展示名 |
| `status` | `"connected" \| "disconnected" \| "error"` | 是 | 状态（开放枚举） |
| `detail` | `string` | 否 | — |

**JSON 示例**：

```json
{
  "connectors": [
    {
      "id": "x-1",
      "name": "示例名称",
      "status": "connected"
    }
  ]
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `connect` | 否 | `(connectorId: string) => void` |
| `disconnect` | 否 | `(connectorId: string) => void` |

**④ 事件与刷新**：`getData` 给 cards；subscribe 刷新

**⑤ 错误处理**：状态未知/失败显示错误态+重试

**⑥ 边界与限制**：与 connectors 边界：这是 rail 卡呈现，数据可来自 connectors 能力

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| session rail 连接器/服务器卡 | rail 卡禁用态（可看不可操作） | 服务器/连接器状态卡：名称/状态/数量/操作（provider 定义） | 同启用 + 模拟标识 |
| Environment 卡扩展行 | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock rail 卡；断言状态/点开

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["workspace-connectors"]` / `PiUiCapabilityActionMap["workspace-connectors"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-device-code-login

**Pi 配对** · 分组 integration · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`simulated` · 需要 provider

Pi 配对：一次性配对码 + attach 命令；接入流程由扩展提供。

| 项 | 值 |
|---|---|
| 能力 ID | `device-code-login` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `simulated`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [X-图14] 登录页/设备码 |
| Claude 落位 | 登录页（配对码） |
| Codex 落位 | Pi 配对页（DEVICE CODE / Open browser / Copy sign-in link） |
| 对应界面 | CX-PAGE-10/11、CL-SHELL-06 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：设备码区域禁用态；现有 token/配对登录不受影响
- **启用后（provider 注册）**：设备码展示/打开浏览器/复制链接 + 轮询登录状态（provider 定义）
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=device-code-login`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { login: PiUiDeviceCodeLogin | null }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `login` | `PiUiDeviceCodeLogin \| null` | 是 | — |

**JSON 示例**：

```json
{
  "login": {
    "code": "示例",
    "expiresAt": 1750000000000
  }
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `startDeviceCodeLogin` | 否 | `() => void` |
| `cancel` | 否 | `() => void` |

**④ 事件与刷新**：`getData` 给 login 状态；动作由 provider 定义

**⑤ 错误处理**：码过期 → 刷新；轮询失败 → 提示重试

**⑥ 边界与限制**：不打印/不落盘 token；与 Pi 配对码语义相近但流程不同（如实标注）

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 登录页（配对码） | 设备码区域禁用态；现有 token/配对登录不受影响 | 设备码展示/打开浏览器/复制链接 + 轮询登录状态（provider 定义） | 同启用 + 模拟标识 |
| Pi 配对页（DEVICE CODE / Open browser / Copy sign-in link） | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock 配对/设备码（simulated）；断言展示/复制/成功

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["device-code-login"]` / `PiUiCapabilityActionMap["device-code-login"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

### cap-git-stage

**Git 暂存** · 分组 integration · 来源 extension · 生产默认 `unavailable` · 注入后（mock/扩展）`simulated` · 需要 provider

Git 暂存：stage / unstage / revert。

| 项 | 值 |
|---|---|
| 能力 ID | `git-stage` |
| 生产默认状态 | `unavailable`（无 provider） |
| 注入后状态 | `simulated`（dev mock 或真实扩展注入后） |
| 是否需 provider | 是（extension） |
| 参考出处 | [X-图10] Review 面板 Stage/Unstage/Revert（CX-PANEL-05） |
| Claude 落位 | 变更区暂存动作 |
| Codex 落位 | Review 面板 Stage all / Unstage / Revert all |
| 对应界面 | CX-PANEL-05 |
| 未提供原因 | 默认文案：当前 pi 没有提供这项能力的数据源… |

**① 用户看到什么**

- **禁用态（生产默认）**：暂存/回滚按钮禁用+原因；changes diff 仍可看
- **启用后（provider 注册）**：stage/unstage/revert 文件级动作 + 状态刷新
- **模拟态（dev mock）**：同 UI + 「模拟演示」标识（`?caps=git-stage`）。

**② 数据契约**（`getData()` 返回）

```ts
type Data = { states: PiUiGitStageState[] }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `states` | `PiUiGitStageState[]` | 是 | 列表（数组顺序即展示顺序） |

`states` 元素字段（`PiUiGitStageState`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `repoPath` | `string` | 是 | — |
| `staged` | `string[]` | 是 | 列表（数组顺序即展示顺序） |
| `unstaged` | `string[]` | 是 | 列表（数组顺序即展示顺序） |
| `canStage` | `boolean` | 是 | — |
| `canRevert` | `boolean` | 是 | — |

**JSON 示例**：

```json
{
  "states": [
    {
      "repoPath": "示例",
      "staged": [
        "示例"
      ],
      "unstaged": [
        "示例"
      ],
      "canStage": true,
      "canRevert": true
    }
  ]
}
```

**③ 动作回调**（`getActions()`；全部可选，缺省=只读）

| 动作 | 必填 | 签名 |
|---|---|---|
| `stage` | 否 | `(repoPath: string, paths: string[]) => void` |
| `unstage` | 否 | `(repoPath: string, paths: string[]) => void` |
| `revert` | 否 | `(repoPath: string, paths: string[]) => void` |

**④ 事件与刷新**：`getData` 给 states；动作由 provider 定义；subscribe 刷新

**⑤ 错误处理**：冲突/无变更 → 明确提示；revert 需二次确认

**⑥ 边界与限制**：写操作；与 git-commit 区分（暂存 vs 提交/推送）

**⑦ 启用前后 UI 差异**

| 位置 | 禁用时（无 provider） | 启用后 | 模拟态 |
|---|---|---|---|
| 变更区暂存动作 | 暂存/回滚按钮禁用+原因；changes diff 仍可看 | stage/unstage/revert 文件级动作 + 状态刷新 | 同启用 + 模拟标识 |
| Review 面板 Stage all / Unstage / Revert all | 同上（按该变体视觉） | 同上 | 同上 |

**⑧ mock 验证**：mock stage/unstage/revert；断言状态变化

**⑨ 相关文件**：契约类型 `ui/src/pi/extensions/types.ts`（`PiUiCapabilityDataMap["git-stage"]` / `PiUiCapabilityActionMap["git-stage"]`）；能力元数据 `ui/src/pi/extensions/capabilities.ts`；禁用态契约 `ui/src/pi/extensions/disabled.ts`；mock fixtures `ui/src/pi/extensions/mock/fixtures.ts`；变体消费组件见 `ui/src/pi/variants/claude/**` 与 `ui/src/pi/variants/codex/**`（能力门控/模拟态渲染）。

---

---


---

## 5. 接入实现建议：数据从哪来

> 锚点 `#integration`。本章给方向与边界，**不承诺协议**；契约层只规定「provider 给什么数据」，不规定数据怎么来——所以任何路径都可以，只要最后注册一个 provider（§3）。

### 5.1 先看结论

| 路径 | 适合谁 | 现在能不能用 | 承诺级别 |
|---|---|---|---|
| ① **pi 进程内扩展 → relay → 前端 provider** | 想要真实、跨设备可用的能力 | 链路存在（现有扩展已连 relay），**新能力的帧/命令未定义** | 推荐方向（不承诺帧格式） |
| ② **新增 relay 协议帧**（握手能力协商 + 能力帧） | 平台级能力（多设备共享） | 未实现 | 方向（沿用 `DOC/71` 三原则） |
| ③ **外部服务前端直连（MCP/HTTP）** | 只读、可控的轻量数据 | 部分可行（受 CORS/鉴权/部署限制） | 受限可行（不建议放密钥） |
| ④ **dev/mock provider** | 设计/验收/自测 | ✅ 现在可用 | 完全可用（非生产） |

### 5.2 现状能力边界（别承诺 Pi 没有的东西）

Pi-Remote 今天真实可用的数据面（`readyUI/data-interface.md`）：

- **会话/消息**：快照、`room_event`、`get_messages`/`get_entries`/`get_tree`、fork/clone/switch/new/delete、压缩、改名、导出、统计、上下文用量、投射。
- **模型/思考/工具**：`get_available_models`/`set_model`、思考级别、`get_all_tools`/`set_active_tools`、`get_commands`、系统提示词、`get_mcp_servers`（只读）、provider 认证状态（只读）。
- **设备/房间**：`room_list`、设备名册、`list_dirs`、`harness_start`、设备令牌/配对。
- **交互**：审批 dialog（allow/deny/六态/倒计时）、bash（默认关闭）、图片。
- **明确没有（协议 D 档或未实现）**：cycle_model、clear_queue、steer/followUp 模式 setter、HTML 导出等；以及第 1 章列出的全部 extension 能力的数据源。

第一原则：**不要为了 UI 好看去伪造协议已支持的能力**；缺失就是缺失，按 §2 禁用态 + 本章路径补。

### 5.3 路径①（推荐）：pi 进程内扩展 → relay → 前端 provider

**为什么首选**：Pi 的真实状态在 pi 进程内（本机扩展能拿到会话、工具、事件），而 Pi-Remote 的跨设备/远程语义由 relay 承载；现有 `extension/pi-remote-sync.ts` 就是完整链路模板。

```
┌──────────────┐   你的数据源（git/MCP/文件/任务系统…）   ┌────────────┐
│ pi 进程内扩展 │ ────────────────────────────────────▶ │   relay    │
│ (你新写)      │   ① 采集/转换 → ② 发帧（协议扩展）     │ (现有链路) │
└──────────────┘                                        └─────┬──────┘
                                                             │ ③ 下发（room_event / command 结果 / 新帧）
                                                    ┌────────▼─────────┐
                                                    │ web 前端          │
                                                    │ ④ provider adapter│
                                                    │ ⑤ registerPiUi…   │
                                                    └──────────────────┘
```

落地要点：

1. **数据形态先定**：按第 4 章对应能力的数据契约组织 payload（如 `artifacts` 的 `{artifacts:[…]}`），前端 adapter 只做「协议帧 → 契约数据」映射。
2. **传输方式二选一**：
   - **复用现有 `command` 通道**（新增扩展自有命令，如 `get_artifacts`）：改动最小，请求-响应式，实时性一般；
   - **新增下行帧**（如 `artifact_list`/`artifact_updated`）：实时性最好，需要协议版本化（见路径②）。
3. **能力协商**：前端默认无 provider = 禁用；未来可由 relay 握手 `caps`/`features` 协商后调用同一注册 API（契约不变）。
4. **安全**：对齐现有扩展做法——路径监狱、白名单投影（config 不回传 env/headers/command）、脱敏（token/密钥不进 payload）、单帧上限（12MB；>256KB 的结果不进去重表）。
5. **多设备**：能力数据要带来源设备/房间维度，provider 按当前设备过滤；契约字段没有 deviceId 的能力由 provider/变体在 UI 侧过滤。

### 5.4 路径②：新增 relay 协议帧（方向，不承诺）

- 沿用 `DOC/71-protocol-v4.md` 三原则：**不改名、只加字段**；**按能力启用**；**旧客户端照常工作**；握手版本协商（`proto`/`caps`）。
- 能力帧示意（不是承诺）：`artifact_list`/`artifact_updated`、`automation_list`/`automation_run`、`pr_list`/`pr_detail`/`pr_comment` 等；每帧带 `room`/`deviceId` 维度与版本字段；错误走现有 `error` 信封（错误码见 `DOC/71` §2）。
- 协议有唯一事实源（`protocol/v4.json`，见 `DOC/71` 头注释），扩展/relay/前端要同步；**前端不要自己发明帧名/字段**。

### 5.5 路径③：外部服务前端直连（受限）

- 适用：只读、公开、支持 CORS 的数据（如静态站点产物清单、本地服务）。
- 禁止：把第三方 token/密钥写进前端（网页是公开静态资源）；需要鉴权的服务请走自己的 BFF/relay 代理。
- 生产部署现实：web 是静态资源（`deploy/deploy-web.sh`），没有同源后端可依赖；跨域失败要有明确错误态，不能白屏。

### 5.6 能力探测与降级策略

```
真实 provider（available） → 失败/无数据 → 该能力错误态/空态（不是禁用态）
无 provider（unavailable） → 生产禁用态 + 接入引导
dev/mock（simulated）      → 完整演示，标「模拟演示」
```

- **探测 = 注册表查询**：生产默认无 provider → extension 全 `unavailable`；builtin 由 relay/prefs 直供 → `available`。
- **部分可用**：provider 可以只实现 `getData()`（只读）——动作缺失 = UI 只读；不要把「没有写能力」当成整个能力禁用（卡片写清「只读也支持」）。
- **失败降级顺序**：保留上次数据 → 空态 + 原因 → 该能力错误态；**不允许**失败时退回禁用态（误导用户以为没接入）或塞假数据。
- **未来 relay 探测**：握手 `caps` 决定是否发能力帧；前端按能否取得数据决定是否注册 provider（建立在路径②上）。

### 5.7 灰度与开关建议

| 层 | 手段 | 注意 |
|---|---|---|
| dev/验收 | `?caps=`（URL）+ localStorage `pi_dev_ui_mock_caps` | 只 dev/自托管；生产不含 mock |
| 自编译部署 | 构建期 env（只在自托管构建注册某 provider） | 不要把内部开关值暴露到公开页面 |
| 未来协议 | relay/扩展侧能力协商（caps） | 不做「远程下发开关关闭 UI」这种用户无法解释的行为 |

### 5.8 安全清单

1. **只读优先**：能只读就只读；写操作（approve/merge/commit/delete）必须 UI 二次确认 + provider 侧权限校验（UI 禁用不是安全边界）。
2. **路径监狱**：文件系统一律限制在设备声明目录（对齐 `projects`/`browseRoots` 与 `harness_start` 的 cwd 校验）。
3. **密钥不进前端**：provider 数据里不得出现 token/密钥；展示账号脱敏（对齐 `get_settings` 掩码、`get_mcp_servers` 白名单投影）。
4. **不可信内容隔离**：`artifacts` 的 html、`browser-pane` 页面、PR 评论 markdown 全部按不可信内容处理（沙箱/净化，由变体组件实现）。
5. **大小/频率上限**：单条建议 ≤256KB（对齐 relay 去重表与 12MB 单帧边界）；列表分页；事件节流/合并。
6. **外部链接**：`url` 只允许 https，打开加 `noopener,noreferrer`。
7. **错误信息**：可读中文、不泄露内部路径/密钥；重试有界。

### 5.9 性能清单

- `getData()` 每次渲染可能被调用：内部缓存快照，避免重复计算/网络请求。
- 大量数据：列表只给摘要；正文/大文件按需或 `url` 懒加载。
- `subscribe(listener)` 只在数据真正变化时通知；高频事件先合并再通知。
- 动作：异步写操作乐观更新 + 失败回滚（或等结果再刷新，二选一写清）。
- 变体侧：能力数据只在该界面 可见时消费，不要顶层全局订阅所有能力。

### 5.10 建议的落地顺序

1. `artifacts`（只读、数据简单）→ 验证「注册 → 解锁 → 渲染」全链路。
2. `suggestions` / `plan-pane`（小、纯前端消费）→ 验证写动作/刷新。
3. `pr-review` / `automations`（写操作、外部数据源）→ 验证权限/错误/二次确认。
4. 其余按 §1.4 与能力对照表波次推进。

### 5.11 待确认

- [ ] 协议方向表述边界（哪些进本文档、哪些只在维护说明）——以项目负责人裁决为准。
- [ ] 扩展侧是否有可复用的新帧/命令模板（问架构线）；没有则本文只给原则。
- [ ] 错误码：契约 v1 未定义每能力错误字段（用数据状态表达；见 §4 卡片「错误处理」）。


---


---

## 6. 与既有功能、适配的关系

> 锚点 `#device-platform` / `#cowork` / `#codex-runtime`。本章讲「参考设计的概念在 Pi-Remote 里对应什么」——**不克隆、要映射**；依据来自 §6.2/§6.4 与 `ui/src/pi/extensions/platform-prefs.ts`。

### 6.1 一条原则：能力层与适配层分开

- **能力层**（§2/§4）：某个界面有没有数据源。解决「Pi 缺失能力怎么补」。
- **适配层**（本章）：参考设计的某个概念在 Pi-Remote 对应什么（设备/平台/会话/文件夹/任务）。解决「不克隆、要映射」。
- 组合示例：设备端浏览器工具在「工作台」模式里（适配层位置），数据来自 `browser-pane` 能力（能力层）。不要把「没有 Windows 设备」误当「能力没接入」。

### 6.2 设备平台标签：Claude 的 Chat / Cowork / Code → 全部 / macOS / Windows / Linux

#### 6.2.1 为什么这样映射

Claude 的三标签是**顶层工作区切换**；Pi-Remote 的顶层现实是**名册里多台设备、跨平台**。取 Claude 的「顶层切换」层级 → 映射为**设备平台筛选**；把 Claude 的工作区语义降为**次级模式**（§6.3）。依据：①三标签在标题栏顶部（全局层）→ 平台筛选同为全局层；②Hub Rail（Chats/产出物/Projects）是段内导航 → 放模式；③「在哪台设备/哪个平台」是 Pi 的最高频决策（P9 C 的延伸）；④不新增一级导航，三套外壳结构一致。

```
┌─────────────────────────────────────────────────────────────┐
│ [品牌]   ◀ 全部 | macOS | Windows | Linux ▶   ⌘K   ○  ⚙   │  ← 一级：设备平台
├──────────────┬──────────────────────────────────────────────┤
│ Hub Rail 胶囊 │                                              │
│ 会话|任务|工作台│          对应模式的界面正文（§6.3）          │  ← 二级：模式
│ ──────────── │                                              │
│ 会话列表/项目 │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

#### 6.2.2 取值、数据来源与契约

| 标签 | 内部值 | 匹配规则 | 展示名 |
|---|---|---|---|
| 全部 | `all` | 不过滤（`deviceFilter=null`） | 全部 |
| macOS | `macos` | `device.platform` ∈ `macos`/`darwin`/`mac` | macOS |
| Windows | `windows` | ∈ `windows`/`win32` | Windows |
| Linux | `linux` | === `linux` | Linux |

- 数据来源：`relay.devices[].platform`（relay 已把 darwin/win32 归一）；平台值归一与展示名用 `platform-prefs.ts` 的 `piUiPlatformOf()` / `PI_UI_PLATFORM_LABEL`（`PI_UI_PLATFORM_TABS = ["all","macos","windows","linux"]`）。
- **平台记忆 prefs**（与现有偏好同一 `pi_remote_pi_prefs`，v1 迁移兼容，**只两变体消费，cursor 不变**）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `uiPlatformTab` | `"all" \| "macos" \| "windows" \| "linux"` | `"all"` | 设备平台标签 |
| `deviceByPlatform` | `Partial<Record<"macos"\|"windows"\|"linux", string>>` | `{}` | 每个平台上次选中的设备 id |

- 纯函数：`piUiWorkspacePrefsOf`（校验/回退）、`mergePiUiWorkspacePrefs`（合并写回，保留其他字段）、`readPiUiWorkspacePrefs`/`writePiUiWorkspacePrefs`（localStorage 不可用不抛）、`resolvePiUiPlatformSelection`（平台筛选→平台内选设备）。
- **实现位置**：`ui/src/pi/variants/claude/chrome/ClaudePlatformTabs.tsx`（标签渲染 + 无平台设备提示）与 `ui/src/pi/variants/claude/model/platformUi.ts`（切平台统一入口，点选与 `⌘⌥1–4` 共用）；prefs 字段已进 `ui/src/pi/model/prefs.ts`（`uiPlatformTab`/`deviceByPlatform`，v1 migration 兼容）。

`resolvePiUiPlatformSelection` 输入/输出（两变体共用，避免各自实现出偏差）：

| 输入 | 说明 |
|---|---|
| `tab` | 当前平台标签 |
| `devices` | 设备列表（`{id, platform, online?}`） |
| `deviceByPlatform` | 平台记忆（Q1） |
| `coarseDeviceFilter` | 侧栏设备细筛（`prefs.deviceFilter`） |
| `selectedDeviceId` | 当前选中设备 |

| 输出 | 说明 |
|---|---|
| `eligibleDeviceIds` | 粗筛 ∩ 平台筛后的候选设备 |
| `selectedDeviceId` | 选中设备（唯一候选自动选；多候选优先记忆，其次当前，最后首个） |
| `autoSelected` | 是否自动选中 |
| `disabledReason` | 无设备原因（如「macOS 平台暂无已配对设备」） |
| `showPairingEntry` | 是否显示「配对新设备…」入口 |
| `rememberedDeviceId` | 该平台记忆设备（UI 可提示「上次使用」） |

#### 6.2.3 完整切换语义（可验收）

| 场景 | 行为 |
|---|---|
| 点「全部」 | `deviceFilter=null`；列表/搜索跨全部设备；记住 lastTab=all |
| 点某平台 | 筛选该平台设备；单设备在线 → 直接选中；多设备 → 选设备（仅该平台并记住）；会话列表只显示该设备/平台设备 |
| 平台无设备 | 标签可见但 `aria-disabled` + 降饱和；tooltip/点击给原因 +「配对新设备…」（打开现有配对弹窗）+「如何接入」链接（`#device-platform`） |
| 平台有设备但全离线 | 标签可点；选中后列表显示离线态；tooltip「<平台> 设备未连接」；composer 置灰原因沿用现有逻辑 |
| 记住上次设备 | 每平台记住最后设备（`deviceByPlatform`）；设备被删 → 回退该平台第一台 |
| 会话自动跟随 | 从「全部」点开平台 X 的会话 → 标签自动切到 X；从 X 切「全部」不改变当前会话 |
| 与设备细筛/分组 | 平台=粗筛、侧栏设备 chip=细筛，两者取交集；切平台时清空细筛 chip；`prefs.grouping` 不变 |
| 与新建会话 | 默认设备 = 当前平台筛选设备（无则第一台在线设备）；新建页同样显示平台标签 |
| 键盘 | `⌘⌥1..4` 依次切 全部/macOS/Windows/Linux（与 `⌘1..3` 模式切换区分） |
| 手机 | 平台标签收进列表页顶栏第二行（胶囊横滚，高 32）；对话页顶部细条显示当前平台/设备 |
| 持久化 | `uiPlatformTab` + `deviceByPlatform` 进 `pi_remote_pi_prefs`；写失败静默回落「全部」 |

- **能力状态**：`device-platform-tabs` 是 **builtin（available）**，不需要 provider；无平台设备是正常状态而非能力禁用。

### 6.3 次级模式：会话 / 任务 / 工作台（Claude Hub Rail 三段）

| 模式 | 对应 Claude | 正文 | 侧栏内容 | Composer | 依赖能力 |
|---|---|---|---|---|---|
| **会话** | Chat | 会话消息流（现状） | 会话列表（设备/目录分组） | 现有 composer 全部控件 | 无（现有能力） |
| **任务** | Cowork | 任务会话流 + Progress 卡（可编辑步骤）+ 文件夹 chip | 任务列表（按文件夹分组、状态） | composer + 文件夹 chip + 建议卡 | `plan-pane`（可编辑步骤）/`artifacts`（产出） |
| **工作台** | Code | 窗格工作台：默认 chat+diff+Tasks 三窗格；右侧 session rail | 工作台会话列表（分支/PR 胶囊） | composer + 常驻控件行（环境/文件夹/权限/模型） | `pane-workspace`（窗格框架）+ 叠加 `pane-dock-drag`/`browser-pane`/`side-chat`/`subagents-panel` 等 |

- 位置：侧栏顶部 Hub Rail（Claude 原生位置）；快捷键 `⌘1/⌘2/⌘3`（外壳注册）。**实现位置**：`ui/src/pi/variants/claude/chrome/ClaudeHubRail.tsx`、`ClaudeModeSwitch.tsx`；模式记忆当前为**会话内记忆**（`ui/src/pi/variants/claude/model/uiMemory.ts`；契约 v1 未提供 `uiWorkspaceMode` pref 字段，后续契约提供后再持久化）。
- 硬规则：①**模式切换不是能力**——无扩展时三种模式都能打开，模式内缺失界面 显示禁用态（这正是「UI 做全、运行时禁用」的落点）；②模式切换不影响 relay/room、不丢草稿（沿用「切换不重连」约束）；③`workspace-modes` 是 builtin（available），不需要 provider。
- 手机：模式切换放列表页顶部分段（三选一）；对话页保持单一模式；不新开一级导航。

### 6.4 Codex 运行位置三段：Local / Worktree / Cloud → 当前设备 / 指定文件夹 / 远端设备

Codex 三段发生在**发消息前**（这条线程在哪跑、对哪个工作区）；Pi-Remote 的真实决策轴是**哪台设备 + 哪个目录**（P9 C）。契约：`work-mode`（**builtin，available，纯 UI**）+ `PI_UI_RUN_LOCATIONS`；**实现位置**：`ui/src/pi/variants/codex/sidebar/CodexRunLocation.tsx`（`local`/`folder`/`remote` 与契约常量同值）与 `CodexNewSession.tsx`（新建页复用）。

| 参考段 | 契约运行位置 id | 映射为 | 语义 | 默认值 |
|---|---|---|---|---|
| Local | `local` | **当前设备** | 当前选中设备 + 默认目录（最近文件夹）直接开线程 | `newSessionDefaultsOf` 的默认设备/目录 |
| Worktree | `folder` | **指定文件夹** | 在该设备选一个独立文件夹作为工作目录（P9 C 文件夹浏览器）；UI 强调「独立工作目录」 | 最近文件夹 / 该设备 `projects[0]` |
| Cloud | `remote` | **远端设备** | 选择另一台在线设备作为执行端；文案说明「Pi 无云端环境，此处为远端在线设备」 | 其余在线设备第一台；无则禁用 |

> **语义钉死**：`worktree` = **git worktree 能力**（Pi 当前无 → `unavailable`，「创建隔离副本…」入口单独禁用）；Codex 的 Worktree 段 = **指定文件夹**（运行位置，available），二者无关。`piUiRunLocationOf("Local"|"Worktree"|"Cloud") → "local"|"folder"|"remote"`；`PI_UI_GIT_WORKTREE_CAPABILITY = "worktree"`。

交互规格（给实现线）：

1. 位置：新线程空状态 composer 下方（Codex 原生位置）；三段分段控件，选中项高亮；composer 上方一行摘要 `设备 · 目录`。
2. 选「当前设备」：不打开额外 UI；发送 = 当前设备 + 默认目录（沿用现有新建会话预选逻辑）。
3. 选「指定文件夹」：展开文件夹行（当前目录 + 「更换文件夹…」→ 现有 FolderPicker/Browser）；目录为空时不可发送并提示。
4. 选「远端设备」：展开设备列表（非当前/在线优先，含平台图标）；选中后摘要变 `远端：<设备名> · <目录>`；离线设备行内写原因并禁用。
5. **不新增流程分叉**：三段只改新建会话的初始参数（设备/目录预选），提交仍走 `relay.createSession(cwd)` + 首条消息（现有 P9 逻辑）。
6. Worktree 扩展入口：二段末尾「创建隔离副本（worktree）…」按 `worktree` 能力门控——生产默认禁用（tooltip + 接入链接 `#cap-worktree`）；dev/mock（simulated）走模拟创建并弹 `CodexBranchReadyDialog`；真实 provider 注册后走 provider 动作。
7. 记住上次：当前为**会话内记忆**（实现未接 prefs）；切段不重置已选。后续如进 prefs，以契约为准。
8. 不采用的备选（写清依据）：A. 三段→平台标签（与一级平台重复）；B. 三段→模式（模式是全局视图，三段发生在发消息前）；C. Cloud→虚构云沙箱（Pi 无云端执行端，远端设备是可落地等价物）。
9. Environment 卡/PR/Commit 映射：`Local` 行 = 当前设备；分支行 = `get_git_branch`；`Commit or push`/`Create PR` 走 `git-commit`/`pr-review`（extension 能力，默认禁用 + 引导）。

### 6.5 参考设计界面 → 能力 ID 精选映射

| 参考界面 | Claude 落位 | Codex 落位 | 能力 ID | 类型 |
|---|---|---|---|---|
| 工作台窗格/布局 | 工作台模式窗格网格 | 右栏多页签 | `pane-workspace` | extension |
| 拖拽/停靠 | 窗格拖拽/布局预设 | 页签（不拖拽） | `pane-dock-drag` | extension |
| 产出物 | 对话内卡 + 库/面板 | 右栏产物面板 | `artifacts` | extension |
| Browser | 工作台 设备端浏览器工具 | 右栏 Browser 页签 | `browser-pane` | extension |
| Plan/Progress | Progress 卡 + 计划窗格 | Environment 卡 Progress 行 | `plan-pane` | extension |
| Side chat | ⌘; 侧聊 | 右栏 Side chat | `side-chat` | extension |
| 子 agent 列表 | 任务/子 agent 列表 | SUBAGENTS 面板 | `subagents-panel` | extension |
| 多代理画布 | 工作台画布 | 子 agent 画布 | `subagent-orchestration` | extension |
| 审批策略 | composer 下方选择器 | composer 审批 chip | `permission-tiers` | extension |
| 密度三档 | 设置/侧栏密度 | Worked for 折叠 | `density-modes` | builtin |
| 建议词 | ghost text | 空状态建议卡 | `suggestions` | extension |
| 行内评论/攒批 | diff 评论 | Review 行内评论 | `code-review-comments` | extension |
| 后台任务 | rail 卡/看板 | Environment 卡 | `background-tasks` | builtin |
| 文件编辑/查看 | 变更/文件窗格 | Files 页签 | `file-editor` / `file-preview` | extension / builtin |
| PR 列表/详情/审查 | Changes 卡联动 | PRs + PR 详情 + Review | `pr-review` | extension |
| git commit/push | 变更区入口 | Commit 下拉/Review 按钮 | `git-commit` | extension |
| git stage/回滚 | 变更区动作 | Review Stage/Unstage/Revert | `git-stage` | extension |
| 插件/技能/连接器 | `+` 菜单/设置 | 扩展/技能/Integrations | `plugins`/`skills`/`connectors` | extension |
| 计划任务 | rail/设置入口 | 侧栏 + 创建弹窗 + review queue | `automations` | extension |
| MCP | 审批卡来源/工具 | 设置 MCP 行 | `mcp-tools` | builtin |
| session rail 扩展 | 右侧 rail 第三方卡 | Environment 卡扩展行 | `session-rail-extra` | extension |
| 多终端/交互终端 | 终端窗格 | Terminal 面板 | `terminal-panes` / `terminal-interactive` | extension |
| 多标签话 | （无对应） | 标题栏标签条 | `multi-tab` | extension |
| 主题自定义 | 设置外观 | Appearance 自定义 | `theme-custom` | extension |
| 置顶/收藏 | 侧栏置顶 | Pinned | `session-pin` | extension |
| 听写 | composer 麦克风 | composer 麦克风 | `dictation` | extension |
| 运行位置三段 | （无对应） | 新线程三段 | `work-mode` | builtin |
| 设备平台标签 | 标题栏平台标签 | （Codex 用运行位置） | `device-platform-tabs` | builtin |
| 会话/任务/工作台模式 | Hub Rail 三段 | （无对应） | `workspace-modes` | builtin |
| Pi 配对 | 登录/配对 | 设备码页 | `device-code-login` | extension |
| 通知规则 | 设置通知区 | 设置 Personal | `notifications` | extension |
| thread fork/反馈 | 回合动作条 | 回合动作条 | `thread-fork-feedback` | extension（fork 部分 available） |
| 服务器/连接器卡 | rail 连接器卡 | Environment 卡扩展行 | `workspace-connectors` | extension |
| Worktree 隔离副本 | （无对应） | 运行位置段旁禁用入口 | `worktree` | extension |
| 上下文用量 | rail Context 卡 | 上下文圆环 | `context-usage` | builtin |
| 模型/强度菜单 | composer 模型胶囊 | composer 模型选择 | `model-menu` | builtin |

### 6.6 与 cursor 变体、P9 A/B/C 的关系

| 项 | 规则 |
|---|---|
| cursor 变体 | **能力层三套共用**（注册表/状态/hook 在共享层）；cursor 界面不新增扩展功能面、不显示扩展禁用态；设置「界面」三卡切换不影响能力状态 |
| P9 A 等你回答 | 行尾标记/「需要处理」组/标题与 favicon 外显按原逻辑；平台标签/模式外壳只换皮，不改 `attentionItemsOf`；电脑回答后 ≤1s 清空（既有验收锚点） |
| P9 B 删除三端一致 | 删除对话框、可删/运行中置灰/离线原因、relay purge 流程不动；变体自写弹层也必须走同一 `delete_session` 命令与三档文案 |
| P9 C 按设备选文件夹 | `relay.listDirs` + 文件夹浏览纯逻辑 + 隐藏开关/错误码不动；平台标签只缩小设备范围，不改设备-目录绑定；运行位置三段落在这条逻辑上 |
| 三套切换不重连 | 不变：`useRelay()` 只调一次，切换只换展示树；能力状态与 relay 连接无关 |

### 6.7 实现现状与后续

- [x] 平台标签/模式/运行位置：prefs 字段 `uiPlatformTab`/`deviceByPlatform` 已进 `pi_remote_pi_prefs`；三种模式与会话内记忆、`local`/`folder`/`remote` 三段均已实现（`uiMemory.ts`、`ClaudePlatformTabs.tsx`、`CodexRunLocation.tsx`；`uiWorkspaceMode` pref 未提供，模式不持久化）。
- [ ] 后续（不在当前契约 v1）：模式记忆持久化、真实 worktree provider 链路；Codex 用运行位置三段表达「在哪里跑」，不重复做平台标签。

---


---

## 7. 接口版本与兼容策略

> 锚点 `#versioning`。契约层当前**没有**显式的 `contractVersion` 字段（`types.ts` 只有能力/数据/注册类型；`version` 出现在 provider 自身或注册表快照计数里）。本章定义「文档/契约/provider」三者的版本口径与兼容规则；**版本号是本文件对当前 API 形状的约定**，若未来契约补版本字段，以代码为准并同步更新本章。

### 7.1 三个版本概念（先分清）

| 概念 | 是什么 | 谁拥有 | 本文写法 |
|---|---|---|---|
| **文档版本** | 这份 `DOC/74` 的版本 | 文档线 | 文档头 `文档版本 1.0`；附录 D 变更记录 |
| **契约版本** | `@/pi/extensions/**` 的接口与 40 个能力 ID 集合版本 | 契约层（架构线维护） | **契约 1.x**（1.0 = `522656d`；1.1 = `3c47af6` 追加 pr-review 动作与事件，能力数不变） |
| **provider 版本** | 某个扩展自己声明的版本 | 扩展作者 | 建议 provider 在自身代码/仓库打版本（契约 v1 不强制字段） |

关系：文档写「本版文档对应契约 1.x」；契约 MAJOR 变更 → 文档出 2.0 → 旧 provider 按 §7.6 迁移。

### 7.2 契约 1.0 的事实（冻结基线）

- 能力 ID：40 个（`PI_UI_CAPABILITY_IDS`），其中 builtin 9 / extension 31。
- 数据类型：`PiUiCapabilityDataMap` 40 项、动作 `PiUiCapabilityActionMap` 40 项（可全空 = 只读）。
- 注册 API：`registerPiUiExtension` / `unregisterPiUiExtension` / `resetPiUiExtensions` / `piUiCapabilityStatusOf` / `piUiExtensionBindingOf` / `piUiCapabilities` / `usePiUiCapabilities` / `piUiExtensionProblems` / `PiUiExtensionError`。
- 状态：`available | unavailable | simulated`；禁用态与选择器契约见 §2。
- **1.1 增量（`3c47af6`）**：`pr-review` 同一能力追加动作 `mergePr`/`closePr`/`archivePr`/`reopenPr`、状态枚举加 `archived`、新增 `PiUiPrReviewEventType`（7 个 `pr:*` 事件）；**能力计数不变（40）**，属 MINOR 级兼容扩展（旧 provider 不实现新动作仍可用）。
- 平台偏好：`uiPlatformTab` / `deviceByPlatform`（`platform-prefs.ts`）。
- mock：`@/pi/extensions/mock`（`installPiUiExtensionMock` / `installPiUiExtensionMockIfRequested` / `uninstallPiUiExtensionMock`），生产包不含。

### 7.3 兼容硬规则（双向）

**provider 必须容忍（UI 侧演进）**

1. UI 只读契约声明过的字段；provider 多给的字段一律忽略（不因未知字段报错）。
2. `getData()` 可能被多次调用（渲染/刷新）：必须幂等、无副作用；`subscribe` 缺省 = 静态数据。
3. `getActions()` 返回的动作可能不被某处 UI 调用；provider 不得依赖「UI 一定调」。
4. 能力状态可能运行中变化（provider 注销/覆盖）；provider 不得假设「注册后永远在」。

**UI / 变体必须容忍（provider 侧演进）**

1. 可选字段缺失有合理默认（`subscribe` 缺失=静态、`actions` 缺失=只读、`mode` 缺失=available）。
2. 列表为空是合法数据（空态，不是禁用态）；数据不合法应隔离成该能力错误态，**不允许拖垮整页**。
3. 未知枚举值（如新 `status` 字符串）按「未知」兜底渲染，不 crash。
4. 时间统一毫秒时间戳（number，UTC）；id 字符串且 provider 内稳定；列表顺序即展示顺序（除非有 `order`）。

### 7.4 变更分级与流程

| 级别 | 例子 | 是否破坏兼容 | 流程 |
|---|---|---|---|
| PATCH（1.0.x） | 修文案、补文档、不改类型 | 否 | 契约线直接改 + 本文附录 D 记一行 |
| MINOR（1.x.0） | 新增能力 ID、新增可选字段、新增可选动作、新增事件类型 | 否（旧 provider 继续工作；新能力默认 `unavailable`，由能力元数据 `defaultStatus` 决定） | 契约线提案 → Lead 审 → 两变体接 UI → 本文 §4/附录 A 同步 |
| MAJOR（2.0.0） | 删除/重命名能力 ID、改必填字段语义、改状态机 | 是 | 先出弃用期（§7.6），两变体与文档同时升版 |

**新增一个能力 ID 的最小清单**：① `PI_UI_CAPABILITY_IDS` 加 id；② `types.ts` 数据/动作契约 + `PiUiCapabilityDataMap`/`ActionMap`；③ `capabilities.ts` 元数据（label/group/description/source/defaultStatus/reason/anchor）；④ 本文 §4 卡片 + 附录 A 行；⑤ 两变体至少一处 UI 消费 + 禁用态落位；⑥ mock fixture（dev 可演示）；⑦ 测试（注册/状态/契约）。缺一项都不算完成。

### 7.5 能力 ID 生命周期（冻结规则）

```
proposed（提案） → active（进契约 vN，冻结） → deprecated（文档标记弃用 + 保留） → removed（契约 MAJOR）
```

- **冻结**：能力 ID 进入契约版本发布后不得改名；改名 = 删除旧 ID + 新增新 ID（MAJOR）。
- **文档锚点随 ID 冻结**：`#cap-<id>` 是变体禁用态「如何接入」的链接目标；弃用 ID 的锚点保留并重定向到替代能力。
- 当前 40 个 ID 视为 **契约 1.0 active**（以 `PI_UI_CAPABILITY_IDS` 为准）。
- 早期预览版出现过别名（仅见 `PI_UI_LEGACY_CAPABILITY_ALIASES` 兼容常量），**不得**用于新代码/新文档。

### 7.6 弃用与迁移流程

1. 契约 MAJOR 提案：列出删除/改动的 ID/字段、替代方案、受影响 provider/变体/文档章节。
2. 弃用期：旧字段/ID 保留至少一个 MINOR；本文对应卡片顶部加 `> 弃用：自 1.x 起，用 <new> 替代`。
3. 迁移指引：本文给「旧写法 → 新写法」代码对照（3–10 行）与自测断言。
4. 移除：MAJOR 发布时删代码、删文档旧锚点（重定向）、更新附录 D；示例代码全部改新写法。
5. 附录 D 每版一行：`版本 | 日期 | 契约版本 | 变更 | 对应代码 HEAD`。

### 7.7 文档与代码同步机制

| 机制 | 做法 |
|---|---|
| 锚点校验 | 契约 `piUiCapabilityAnchors()` ↔ 本文 `### cap-<id>`（测试 `test/pi-ui-extensions.test.mjs` 会校验 40 个锚点、章节关键词、文档编号统一为 74） |
| 示例可跑 | §3 最小 provider、§8 三个示例至少一个进 dev 自测；字段改名立刻暴露 |
| 验收矩阵 | 验证线按本文示例注册 1–2 个 provider；跑不通 = 文档缺陷，优先修文档 |
| 版本头 | 每章标「对应契约版本 / 最后核对日期”；契约合并后统一核对 |
| 差异记录 | 文档与实现不一致：先以代码为准修文档，附录 D 记一行；不能反过来改代码 |

### 7.8 未来（不承诺）

若走 relay/pi 扩展落数据，版本协商应沿用协议层既有做法（`DOC/71`：握手带 `proto`/`caps`，按能力启用，旧端照常工作），由 relay/扩展侧协商，**前端契约层不重复发明协商协议**。


---


---

## 8. 完整示例：产出物 / 计划任务 / PR

> 锚点 `#examples`。三个示例覆盖「只读列表」「带写操作/刷新」「跨数据源+权限」三类。**数据契约以第 4 章卡片为准**（`ui/src/pi/extensions/types.ts`）；示例数据全为假数据，不含真实 token/账号。
> 前提：`import { registerPiUiExtension, unregisterPiUiExtension } from "@/pi/extensions"`；每个示例最后可用 `unregisterPiUiExtension(id)` 验证回落。

### 8.1 示例①：产出物 提供者（只读列表 + 详情）

**需求**：你的扩展能产出可预览物（markdown/html/图表/代码/图片）；希望两套新 UI 里 Artifact 卡/库/面板可用（Pi 没有 产出物，默认禁用）。

**数据契约**（`PiUiCapabilityDataMap["artifacts"]`）：`{ artifacts: PiUiArtifact[] }`；元素字段 `id`/`title`/`kind`/`updatedAt`/`content?`/`url?`/`meta?`（见 §4 `cap-artifacts`）。动作：`openArtifact?`/`revealArtifact?`（可选）。

```ts
import { registerPiUiExtension } from "@/pi/extensions"

const DEMO_ARTIFACTS = [
  { id: "art-hello", title: "示例报告.md", kind: "markdown" as const, updatedAt: Date.now(), content: "# 示例报告\n\n这是 provider 提供的正文。" },
  { id: "art-chart", title: "用量图表", kind: "chart" as const, updatedAt: Date.now() - 60_000, content: "week,tokens\nW1,1200\nW2,1600", meta: { format: "csv" } },
]

registerPiUiExtension({
  id: "example.artifacts",
  name: "示例 产出物 扩展",
  capabilities: {
    artifacts: {
      getData: () => ({ artifacts: DEMO_ARTIFACTS.map((a) => ({ ...a })) }),
      getActions: () => ({
        openArtifact: (id) => console.log("[example.artifacts] open", id),
        revealArtifact: (id) => console.log("[example.artifacts] reveal", id),
      }),
      // 后台新增产物时通知 UI 重取：
      // subscribe: (listener) => { const t = setInterval(listener, 10_000); return () => clearInterval(t) },
    },
  },
})
```

**UI 解锁点**：Claude 对话内 Artifact 卡 + 产出物 库/面板（Preview/Code）从禁用态变可用；Codex 右栏产物面板（见变体实现）。能力对照表界面编号：`CL-CHAT-07/08`、`CL-COWORK-07`、`CL-CODE-22`、`CX-PANEL-01`。

**刷新与错误**：用 `subscribe` 通知新增/更新；正文按需给（列表不要塞大正文）；html 内容按不可信内容沙箱渲染；内容失败 → 卡内错误+重试。安全：正文不可信、单条建议 ≤256KB。

**mock 对拍**：`?caps=artifacts` → `pi-ui-mock` fixtures（列表 3 条 + Preview/Code）；断言 `statusOf("artifacts")==="available"`、列表≥2 条、注销后回 `unavailable`。

### 8.2 示例②：计划任务 提供者（写操作 + 刷新）

**需求**：你的扩展能定时/事件触发任务；希望 Codex 侧栏 计划任务 入口、创建弹窗、结果 review queue 可用。

**数据契约**：`{ automations: PiUiAutomation[] }`；元素字段 `id`/`name`/`description?`/`trigger`/`enabled`/`lastRunAt?`/`lastResult?`（`success|failed|running|never`）。动作（契约 v1）：`runNow?`/`toggle?`。

> ⚠️ 契约 v1 **没有** create/update/remove 动作：创建弹窗可以完整展示，但「创建」提交在 v1 无法声明 provider 行为 → 文档示例不伪造 API；需要「创建」时按 §7.4 走 MINOR 新增动作（新增可选动作不破坏兼容）。运行/启停是可用的。

```ts
import { registerPiUiExtension } from "@/pi/extensions"
import type { PiUiAutomation } from "@/pi/extensions"

const automations: PiUiAutomation[] = [
  { id: "auto-nightly-review", name: "夜间 review", description: "每天 02:00 跑一次代码审查", trigger: "0 2 * * *", enabled: true, lastRunAt: Date.now() - 3_600_000, lastResult: "success" },
]

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((fn) => fn())

registerPiUiExtension({
  id: "example.automations",
  name: "示例 计划任务 扩展",
  capabilities: {
    automations: {
      getData: () => ({ automations: automations.map((a) => ({ ...a })) }),
      getActions: () => ({
        runNow: (id) => {
          const item = automations.find((a) => a.id === id)
          if (!item) return
          item.lastResult = "running"
          notify()
          setTimeout(() => { item.lastRunAt = Date.now(); item.lastResult = "success"; notify() }, 1500)
        },
        toggle: (id, enabled) => {
          const item = automations.find((a) => a.id === id)
          if (!item) return
          item.enabled = enabled
          notify()
        },
      }),
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    },
  },
})
```

**UI 解锁点**：Codex 侧栏 计划任务 入口/列表、结果 review queue；Claude 见变体实现（rail/设置）。能力对照表界面编号：`CX-SIDE-01/08`、`CX-DLG-03`、`CX-PAGE-05`。

**刷新与错误**：写操作后立即 `notify()`；后台结果变化用 `subscribe` 推（示例 1.5s 后 running→success）；可展示的失败用 `lastResult:"failed"` 表达（不要抛错）；危险动作（运行/启停）UI 二次确认 + provider 侧权限校验。

**mock 对拍**：`?caps=automations`；断言启停反映到 UI、`runNow` 后状态变化、禁用态不出现假数据。

### 8.3 示例③：PR 提供者（外部数据源 + 权限 + 状态流转）

**需求**：你的扩展能连代码托管方；希望 Codex 侧栏 PRs、PR 详情、Review 面板动作（含 merge/close/archive/reopen）可用。

**数据契约**：`{ pullRequests: PiUiPullRequest[] }`；元素字段 `id`/`number`/`title`/`repo`/`author?`/`state`/`reviewState?`/`updatedAt`/`url?`；`state` 为 `open|draft|merged|closed|archived`（开放枚举）。动作（契约 v1）：`openPr?`/`approve?`/`requestChanges?`/**`mergePr?`（可带 merge 方式）**/**`closePr?`**/**`archivePr?`**/**`reopenPr?`**。

事件：`PiUiPrReviewEventType` = `pr:opened` / `pr:approved` / `pr:changes-requested` / `pr:merged` / `pr:closed` / `pr:archived` / `pr:reopened`；事件体 `PiUiPrReviewEvent` 带 `prId`（UI 刷新列表/详情，不轮询）。

```ts
import { registerPiUiExtension } from "@/pi/extensions"
import type { PiUiPullRequest } from "@/pi/extensions"

let prs: PiUiPullRequest[] = [
  { id: "example/pi-remote#42", number: 42, title: "feat(ui): 扩展接入示例", repo: "example/pi-remote", author: "alice", state: "open", reviewState: "pending", updatedAt: Date.now() - 120_000, url: "https://example.invalid/pull/42" },
]

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((fn) => fn())
const update = (id: string, patch: Partial<PiUiPullRequest>) => {
  prs = prs.map((pr) => (pr.id === id ? { ...pr, ...patch, updatedAt: Date.now() } : pr))
  notify()
}

registerPiUiExtension({
  id: "example.pr",
  name: "示例 PR 扩展",
  capabilities: {
    "pr-review": {
      getData: () => ({ pullRequests: prs.map((pr) => ({ ...pr })) }),
      getActions: () => ({
        openPr: (id) => {
          const pr = prs.find((item) => item.id === id)
          if (pr?.url) window.open(pr.url, "_blank", "noopener,noreferrer")
        },
        approve: (id) => update(id, { reviewState: "approved" }),
        requestChanges: (id, comment) => {
          console.log("[example.pr] requestChanges", id, comment) // 真实实现：调用托管方 API 提交 review
          update(id, { reviewState: "changes_requested" })
        },
        // merge/close/archive/reopen：契约已提供（merge 可带方式）；真实实现需服务端权限校验
        mergePr: (id, method = "merge") => {
          console.log("[example.pr] merge", id, method)
          update(id, { state: "merged" })
        },
        closePr: (id) => update(id, { state: "closed" }),
        archivePr: (id) => update(id, { state: "archived" }),
        reopenPr: (id) => update(id, { state: "open" }),
      }),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      // 也可用事件流通知 UI（示例：状态变化后推 pr:* 事件；事件体带 prId）
      // onEvent: (listener) => { /* 在真实状态变化处调用 listener({ capability: "pr-review", type: "pr:merged", prId, at: Date.now() }) */ return () => {} },
    },
  },
})
```

**UI 解锁点**：Codex 侧栏 PRs、PR 详情页（checks/状态/archived 区分）、Review 面板动作（approve / request changes / merge / close / archive / reopen）；Claude 侧见变体实现（Changes/评论联动）。能力对照表界面编号：`CX-PAGE-06/07`、`CX-PANEL-04`、`CL-CODE-13/26/27`。

**刷新与错误**：动作后 `notify()`（或推 `pr:*` 事件）刷新列表/详情；只读优先（列表/详情先可用，写动作逐步开放）；`id` 稳定；`url` 只 https + `noopener,noreferrer`；未授权/无远端 → 解释性禁用；权限不足/合并冲突 → 明确错误并保持原状态；UI 禁用不是安全边界，provider 必须自己校验权限。

**mock 对拍**：`?caps=pr-review`（fixtures 已含 open/draft/merged/closed/archived 与 7 个 `pr:*` 事件类型）；断言 approve 后 `reviewState` 变化、mergePr 后 `state="merged"`、closePr/archivePr/reopenPr 状态流转、openPr 打开 url（拦截 window.open 断言）、注销回禁用态。

### 8.4 三个示例的共同注意事项

1. **provider 是数据边界不是 UI 边界**：只返回数据 + 动作，**不返回 JSX/样式**；两套变体各自渲染。
2. **幂等只读 `getData()`**：可能被多次调用；异步数据先缓存再 `subscribe` 通知。
3. **动作可缺省**：缺省 = 只读；危险动作 UI 二次确认 + provider 权限校验；可展示失败用数据状态表达。
4. **不编造字段/动作**：本文出现的每个字段/动作都必须能在 `types.ts` 找到；v1 尚未提供的（如 automations 创建/更新/删除）写清「待 MINOR 新增」，不伪造 API。
5. **mock 与真实同构**：mock fixtures 用同一数据形状，保证「mock 能跑 → 真实 provider 照抄能跑」。
6. **生产不含 mock**：示例不要 static import mock；dev 注入走 `?caps=`。
7. **敏感信息**：示例全用假数据；provider 数据不得携带 token/密钥（对齐既有白名单投影口径）。


---


---

## 9. FAQ 与排错

> 锚点 `#faq`。细节章节用 `§` 指向；示例代码见 §3/§8。

### 9.1 常见问题

**Q1：为什么新 UI 里很多地方是灰的/不能点？**
A：那些是 Pi 目前没有的数据能力（产出物、Browser、计划任务、PR…）。UI 按参考设计做全了，但生产没有数据源 → 统一禁用态 + 原因 + 「如何接入」。接入 provider 后自动解锁（§2、§3），不是 bug。

**Q2：我没写扩展，只想看看这些界面长什么样？**
A：dev/画廊加 `?caps=all`（或 `?caps=artifacts`），UI 完整可操作但带「模拟演示」标识（§3.5；只模拟 31 项 extension 能力，9 项 builtin 本来就可用）。生产网页不提供模拟开关。

**Q3：为什么有些能力直接可用（模型菜单/Context/密度）？**
A：那 9 项是 builtin：Pi 现有数据/UI 直供，默认 `available`，不需要任何人写 provider（§1.4 表里「来源 = builtin」）。只有 extension（31 项）才需要接入。

**Q4：接入要改哪里？要重新部署吗？**
A：当前生产网页没有动态插件加载器；provider 代码必须随前端构建（自编译/自托管），改完重新构建部署。dev/mock 刷新页面即可（§3.2/§3.6）。

**Q5：为什么 Pi 没有的能力也把 UI 做出来？**
A：用户要求「参考设计每一屏/每个功能都做出来」+ 缺失能力「完整 UI + 运行时禁用 + 可接入」。好处：设计完整性可验收、能力补齐不用重做界面、用户能提前看到未来形态（§1.6）。

**Q6：接入会不会影响现有三套 UI / 已有功能（P9 A/B/C）？**
A：不会。能力层与皮肤层分离，三套 UI 共享同一份能力状态；P9 A/B/C 流程与逻辑不变（§6.6）。

**Q7：`available`/`unavailable`/`simulated` 什么时候变？**
A：由注册表解析：无 provider → `defaultStatus`（builtin=available / extension=unavailable）；真实 provider → available；`mode:"simulated"` → simulated；注销 → 回落（§2.1）。切 UI 变体不影响状态。

**Q8：注册了 provider，能力状态变了，但界面没反应？**
A：该界面 的 UI 可能还没接能力层（界面尚未接入），或注册的不是它消费的能力 ID。用 `piUiCapabilities().list()` 查状态，对照第 4 章卡片「UI 解锁点」与 §3.8 排错表。

**Q9：provider 抛错/超时会怎样？**
A：契约 v1 的 provider 是「快照 + 动作」模型：推荐用数据状态表达可展示的失败（如 `lastResult:"failed"`），不要塞假数据；UI 侧应有错误态/重试，不能白屏（建议见 §4 各卡片「错误处理」与 §5.6）。

**Q10：写操作（approve/运行 Automation/保存文件）有什么安全要求？**
A：UI 二次确认 + provider 侧权限校验双保险；UI 禁用不是安全边界；密钥/令牌绝不进前端数据（§5.8）。

**Q11：能力 ID 怎么选？一次能注册多个能力吗？**
A：用契约 40 项里的 ID（§1.4/附录 A）；一个 provider 可同时提供多个能力；不要自己发明 ID（拼错会抛 `PiUiExtensionError`）。

**Q12：「可模拟演示」和「生产默认禁用」矛盾吗？**
A：不矛盾。**生产默认**（`defaultStatus`）extension=unavailable；**注入后**（`ledgerStatus`）simulated 表示 dev mock 可完整演示（§2.3）。

**Q13：早期预览版的旧代号还能用吗？**
A：不要用。正式 ID 与能力对照表逐字一致，早期代号只在 `PI_UI_LEGACY_CAPABILITY_ALIASES` 兼容说明里（§7.5）。

**Q14：为什么没有「插件市场」/「不重新部署就生效」？**
A：当前契约是前端运行时注册，没有扩展发现/加载机制；生产网页无插件加载器。未来方向是 pi 扩展/relay 协商后调用同一注册 API（§5.3/§5.4，协议未定不承诺）。

**Q15：文档里说「未来 relay 协议」，什么时候有？**
A：不承诺时间/格式。现在能落地的是自编译前端注册 + dev mock；协议层能力帧需协议负责人另行设计（§5.4）。

**Q16：能力清单还会变吗？我按现在写会白做吗？**
A：40 个 ID 是契约 1.0 冻结项；变化走 §7.4 流程（新增=MINOR，删除/改名=MAJOR+弃用期），字段只加不改。按「只用声明过的字段 + 缺省兜底」写就不会被后续小版本破坏。

### 9.2 排错速查表

| 症状 | 最可能原因 | 查什么 |
|---|---|---|
| 注册抛 `PiUiExtensionError` | provider 结构/能力 ID/`getData` 缺失 | 错误 `problems` 列表；附录 A 能力 ID 表 |
| 能力一直 `unavailable` | 代码没进构建 / 模块未执行 / ID 拼错 | 注册处日志；`piUiCapabilities().list()` |
| UI 没解锁但状态 available | UI 尚未接能力层（波次未到） | 第 4 章卡片「UI 解锁点」 |
| 显示「模拟演示」但想要真实 | provider 用了 `mode:"simulated"` | 去掉 `mode` 或设 `"available"` |
| 生产出现 mock 数据 | mock 被 static import 进生产入口 | 构建产物 grep `pi-ui-mock`；只从 dev 入口动态 import |
| 注销后 UI 没回禁用态 | 注销 id 不一致 / 组件缓存数据 | 同一 id `unregisterPiUiExtension(id)`；刷新复验 |
| 数据显示错乱/缺字段 | `getData()` 形状不符 | 第 4 章对应卡片字段表 |
| 页面白屏 | provider 抛错未隔离 / 超大 payload | 控制台错误；单条 ≤256KB；错误态兜底 |
| 三套 UI 之一异常 | 皮肤层问题（非能力层） | 独立性守卫/切换回归（§6.6） |

### 9.3 报告问题

附：能力 ID + 截图 + `data-capability-state` 属性值 + 控制台错误；实现问题按验收矩阵补行，文档问题按附录 D 记录，能力增删走 §7.4 变更流程。

---

## 附录 A：能力速查与能力对照

> 锚点 `#appendix-a`。映射表由 `ui/src/pi/extensions/inventory-map.ts` 常量生成（`PI_UI_INVENTORY_MAPPING` 40 行；`piUiInventoryCoverage()` 校验无缺口）；旧名 alias 见 `PI_UI_LEGACY_CAPABILITY_ALIASES`。

### A.1 能力速查（40 项）

| 能力 id | 名称 | 分组 | 来源 | 默认状态 | 锚点 |
|---|---|---|---|---|---|
| `device-platform-tabs` | 设备平台标签 | pane | builtin（无需 provider） | available | [`#cap-device-platform-tabs`](#cap-device-platform-tabs) |
| `workspace-modes` | 会话 / 任务 / 工作台 | pane | builtin（无需 provider） | available | [`#cap-workspace-modes`](#cap-workspace-modes) |
| `pane-workspace` | 多窗格工作台 | pane | extension（provider） | unavailable | [`#cap-pane-workspace`](#cap-pane-workspace) |
| `pane-dock-drag` | 窗格拖拽与停靠 | pane | extension（provider） | unavailable（可模拟演示） | [`#cap-pane-dock-drag`](#cap-pane-dock-drag) |
| `artifacts` | 产出物 | content | extension（provider） | unavailable（可模拟演示） | [`#cap-artifacts`](#cap-artifacts) |
| `browser-pane` | 设备端浏览器工具 | pane | extension（provider） | unavailable | [`#cap-browser-pane`](#cap-browser-pane) |
| `plan-pane` | 计划 / 进度 | content | extension（provider） | unavailable（可模拟演示） | [`#cap-plan-pane`](#cap-plan-pane) |
| `side-chat` | 侧边对话 | workflow | extension（provider） | unavailable（可模拟演示） | [`#cap-side-chat`](#cap-side-chat) |
| `subagents-panel` | 子 agent 状态（只读） | workflow | extension（provider） | unavailable（可模拟演示） | [`#cap-subagents-panel`](#cap-subagents-panel) |
| `automations` | 计划任务 | workflow | extension（provider） | unavailable | [`#cap-automations`](#cap-automations) |
| `pr-review` | 代码审查 | integration | extension（provider） | unavailable（可模拟演示） | [`#cap-pr-review`](#cap-pr-review) |
| `git-commit` | Git 提交链路 | integration | extension（provider） | unavailable | [`#cap-git-commit`](#cap-git-commit) |
| `plugins` | 扩展 | integration | extension（provider） | unavailable | [`#cap-plugins`](#cap-plugins) |
| `connectors` | 连接器 | integration | extension（provider） | unavailable | [`#cap-connectors`](#cap-connectors) |
| `skills` | 技能 | integration | extension（provider） | unavailable（可模拟演示） | [`#cap-skills`](#cap-skills) |
| `permission-tiers` | 审批策略 | customization | extension（provider） | unavailable | [`#cap-permission-tiers`](#cap-permission-tiers) |
| `density-modes` | 密度模式 | customization | builtin（无需 provider） | available | [`#cap-density-modes`](#cap-density-modes) |
| `suggestions` | 建议词 | content | extension（provider） | unavailable（可模拟演示） | [`#cap-suggestions`](#cap-suggestions) |
| `code-review-comments` | 代码审查评论 | workflow | extension（provider） | unavailable（可模拟演示） | [`#cap-code-review-comments`](#cap-code-review-comments) |
| `background-tasks` | 后台任务 | workflow | builtin（无需 provider） | available | [`#cap-background-tasks`](#cap-background-tasks) |
| `mcp-tools` | MCP 工具 | integration | builtin（无需 provider） | available | [`#cap-mcp-tools`](#cap-mcp-tools) |
| `context-usage` | 上下文用量 | content | builtin（无需 provider） | available | [`#cap-context-usage`](#cap-context-usage) |
| `model-menu` | 模型 / 强度菜单 | content | builtin（无需 provider） | available | [`#cap-model-menu`](#cap-model-menu) |
| `file-editor` | 文件编辑器 | content | extension（provider） | unavailable | [`#cap-file-editor`](#cap-file-editor) |
| `file-preview` | 文件查看 | content | builtin（无需 provider） | available | [`#cap-file-preview`](#cap-file-preview) |
| `worktree` | git worktree（隔离副本） | workflow | extension（provider） | unavailable | [`#cap-worktree`](#cap-worktree) |
| `multi-tab` | 多标签页 | pane | extension（provider） | unavailable | [`#cap-multi-tab`](#cap-multi-tab) |
| `theme-custom` | 主题自定义 | customization | extension（provider） | unavailable（可模拟演示） | [`#cap-theme-custom`](#cap-theme-custom) |
| `session-pin` | 会话置顶 | workflow | extension（provider） | unavailable（可模拟演示） | [`#cap-session-pin`](#cap-session-pin) |
| `terminal-interactive` | 设备端终端（只读） | pane | extension（provider） | unavailable（可模拟演示） | [`#cap-terminal-interactive`](#cap-terminal-interactive) |
| `dictation` | 听写 | content | extension（provider） | unavailable | [`#cap-dictation`](#cap-dictation) |
| `work-mode` | 运行位置 | workflow | builtin（无需 provider） | available | [`#cap-work-mode`](#cap-work-mode) |
| `workspace-connectors` | 连接 rail 卡 | integration | extension（provider） | unavailable | [`#cap-workspace-connectors`](#cap-workspace-connectors) |
| `device-code-login` | Pi 配对 | integration | extension（provider） | unavailable（可模拟演示） | [`#cap-device-code-login`](#cap-device-code-login) |
| `subagent-orchestration` | 多代理编排 | workflow | extension（provider） | unavailable（可模拟演示） | [`#cap-subagent-orchestration`](#cap-subagent-orchestration) |
| `git-stage` | Git 暂存 | integration | extension（provider） | unavailable（可模拟演示） | [`#cap-git-stage`](#cap-git-stage) |
| `thread-fork-feedback` | 会话分叉与反馈 | workflow | extension（provider） | unavailable（可模拟演示） | [`#cap-thread-fork-feedback`](#cap-thread-fork-feedback) |
| `session-rail-extra` | 会话侧栏扩展 | pane | extension（provider） | unavailable | [`#cap-session-rail-extra`](#cap-session-rail-extra) |
| `notifications` | 通知规则 | customization | extension（provider） | unavailable | [`#cap-notifications`](#cap-notifications) |
| `terminal-panes` | 多终端（实例） | pane | extension（provider） | unavailable | [`#cap-terminal-panes`](#cap-terminal-panes) |


### A.2 能力对照明细（维护用台账映射，由 `inventory-map.ts` 常量生成）

#### A.2.1 能力对照表 ↔ 契约（37 行 = 34 语义 + 3 candidate）

| 能力对照 ID / 界面 | 契约 capability ID | 类型 | 说明 |
|---|---|---|---|
| `device-platform-tabs` | `device-platform-tabs` | exact | 与契约 ID 逐字一致 |
| `workspace-modes` | `workspace-modes` | exact | 与契约 ID 逐字一致 |
| `pane-workspace` | `pane-workspace` | exact | 与契约 ID 逐字一致 |
| `pane-dock-drag` | `pane-dock-drag` | exact | 与契约 ID 逐字一致 |
| `artifacts` | `artifacts` | exact | 与契约 ID 逐字一致 |
| `browser-pane` | `browser-pane` | exact | 与契约 ID 逐字一致 |
| `plan-pane` | `plan-pane` | exact | 与契约 ID 逐字一致 |
| `side-chat` | `side-chat` | exact | 与契约 ID 逐字一致 |
| `subagents-panel` | `subagents-panel` | exact | 与契约 ID 逐字一致 |
| `automations` | `automations` | exact | 与契约 ID 逐字一致 |
| `pr-review` | `pr-review` | exact | 与契约 ID 逐字一致 |
| `git-commit` | `git-commit` | exact | 与契约 ID 逐字一致 |
| `plugins` | `plugins` | exact | 与契约 ID 逐字一致 |
| `connectors` | `connectors` | exact | 与契约 ID 逐字一致 |
| `skills` | `skills` | exact | 与契约 ID 逐字一致 |
| `permission-tiers` | `permission-tiers` | exact | 与契约 ID 逐字一致 |
| `density-modes` | `density-modes` | exact | 与契约 ID 逐字一致 |
| `suggestions` | `suggestions` | exact | 与契约 ID 逐字一致 |
| `code-review-comments` | `code-review-comments` | exact | 与契约 ID 逐字一致 |
| `background-tasks` | `background-tasks` | exact | 与契约 ID 逐字一致 |
| `mcp-tools` | `mcp-tools` | exact | 与契约 ID 逐字一致 |
| `context-usage` | `context-usage` | exact | 与契约 ID 逐字一致 |
| `model-menu` | `model-menu` | exact | 与契约 ID 逐字一致 |
| `file-editor` | `file-editor` | exact | 与契约 ID 逐字一致 |
| `file-preview` | `file-preview` | exact | 与契约 ID 逐字一致 |
| `worktree` | `worktree` | exact | 与契约 ID 逐字一致 |
| `multi-tab` | `multi-tab` | exact | 与契约 ID 逐字一致 |
| `theme-custom` | `theme-custom` | exact | 与契约 ID 逐字一致 |
| `session-pin` | `session-pin` | exact | 与契约 ID 逐字一致 |
| `terminal-interactive` | `terminal-interactive` | exact | 与契约 ID 逐字一致 |
| `dictation` | `dictation` | exact | 与契约 ID 逐字一致 |
| `work-mode` | `work-mode` | exact | 与契约 ID 逐字一致 |
| `workspace-connectors` | `workspace-connectors` | exact | 与契约 ID 逐字一致 |
| `device-code-login` | `device-code-login` | exact | 与契约 ID 逐字一致 |
| `CL-CODE-25` | `subagent-orchestration` | candidate | 多代理画布/编排；独立 capability（subagents-panel 仍管列表/状态） |
| `CX-PANEL-05` | `git-stage` | candidate | stage/unstage/revert 暂存区动作；独立 capability（git-commit 只管 commit/push/PR） |
| `CX-THREAD-07` | `thread-fork-feedback` | candidate | thread fork（fork.available=true → available）+ Good/Bad 反馈（feedback.enabled=false → simulated）；一个 capability 两个子状态 |

#### A.2.2 契约有、能力对照表未单列（3 项 extra）

| 契约 capability ID | 能力对照 | 说明 |
|---|---|---|
| `session-rail-extra` | (none) | 第三方 session rail 条目（参考设计 hub rail 扩展位） |
| `notifications` | (none) | 通知规则（按事件/设备/房间） |
| `terminal-panes` | (none) | 多终端实例（与 terminal-interactive 的交互能力区分） |

#### A.2.3 candidate 裁决

- `subagent-orchestration`（CL-CODE-25）：**独立 capability**（画布/编排；subagents-panel 管列表/状态）。
- `git-stage`（CX-PANEL-05）：**独立 capability**（stage/unstage/revert；git-commit 管 commit/push/PR）。
- `thread-fork-feedback`（CX-THREAD-07）：**独立 capability**，两个子状态：fork（Pi 现有 → `fork.available=true` / available）+ Good/Bad 反馈（缺失 → `feedback.enabled=false` / simulated）。


### A.3 候选与扩展说明

- **3 个 candidate（独立能力，不并入）**：`subagent-orchestration`（CL-CODE-25 多代理画布）、`git-stage`（CX-PANEL-05 暂存区动作）、`thread-fork-feedback`（CX-THREAD-07：fork 部分 available + feedback simulated）。
- **3 个契约扩展（能力对照表未单列）**：`session-rail-extra`、`notifications`、`terminal-panes`。
- 计数口径：`PI_UI_CAPABILITY_IDS.length`（40）/ `PI_UI_CAPABILITY_PROVIDER_IDS.length`（31）/ `PI_UI_CAPABILITY_CONTRACT_IDS.length`（9）——一律从常量派生，不手写数字。

## 附录 B：术语与缩写

| 缩写/术语 | 全称/含义 |
|---|---|
| provider | 能力数据源实现（`getData` + 可选 subscribe/actions/events） |
| builtin | Pi 现有数据/UI 直供的能力（9 项，默认 available） |
| extension | 需要 provider 的能力（31 项，生产默认 unavailable） |
| cw / kit | cursor 变体的组件与样式命名空间（两套新变体**禁止**使用，独立性守卫检查） |
| P9 A/B/C | 既有功能：等你回答 / 删除三端一致 / 按设备选文件夹（三套 UI 都可用） |
| 界面编号 | 能力对照表里的可测屏/部件编号（如 `CL-CODE-02`、`CX-PANEL-04`） |
| tailnet / attach | Pi-Remote 本机扩展连接 relay 的方式（见 `DOC/20-local-device.md`/`DOC/20`） |

## 附录 C：错误语义与稳定选择器速查

- **注册期错误**：`PiUiExtensionError.problems: string[]`（未知能力 id / 缺 getData / mode 非法 / capabilities 为空 / 回调不是函数）。处理：按问题清单修 provider。
- **运行期数据错误**：契约 v1 没有统一错误字段；约定：可展示失败用数据状态表达（如 `lastResult:"failed"`、`status:"error"`），不可展示失败用错误态组件 + 有界重试；不要把错误字符串塞进正常数据字段。
- **禁用态判断**：`statusOf(id) !== "available"` → 渲染禁用态/模拟态；`disabledOf(id)` 返回统一文案与 `#cap-<id>` 链接（§2.4）。
- **稳定选择器**：`data-p4-surface`（界面根）/`data-p4-action`/`data-p4-row`/`data-p4-pane`/`data-pi-capability` + `data-capability-state`/`data-pi-capability-disabled`/`data-p4-ready`；helper `piUiSurfaceAttrs`/`piUiCapabilityAttrs`/`piUiReadyAttr`（§2.8）。

## 附录 D：变更记录

| 文档版本 | 日期 | 契约版本 | 变更 | 对应代码 HEAD |
|---|---|---|---|---|
| 1.0 | 2026-10-26 | 1.0 | 由架构线骨架（528 行）重写为完整版：总览/状态语义/快速开始/40 能力卡片/接入建议/映射/版本/完整示例/FAQ + 附录 A–D。能力 ID 采用能力对照表逐字一致口径（40 项 = 34 语义 + 3 candidate + 3 扩展）；旧名仅别名。 | `522656d` |
| 1.1 | 2026-10-26 | 1.1 | 同步 pr-review 契约扩展：`#cap-pr-review` 补 `mergePr(prId, method?)`/`closePr`/`archivePr`/`reopenPr`、state 加 `archived`、7 个 `pr:*` 事件（`PiUiPrReviewEvent` 带 `prId`）；§8.3 示例补 merge/close 调用；删除「PR merge 待 MINOR」过时表述（其实现已提供），仅保留 automations create 等真实缺口。 | `3c47af6` |
| 1.2 | 2026-10-26 | 1.2 | 同步 mock M1（`db59fc5`）：§2.7/§3.5 明确「`?caps=all` 请求全部但只注入 31 项 provider-backed，9 项 builtin 不注入」、画廊入口自动注入（`ui/src/pi/dev/main.tsx`，query/hash 双通道 + `__PI_GALLERY_MOCK__`）、补可复跑验证命令；文档版本 1.1→1.2。 | `db59fc5` |
| 1.2.1 | 2026-10-26 | 1.2 | 修终审 P2（示例严格 `tsc --strict` 可编译）：§8.3 PR 示例加 `import type { PiUiPullRequest }`、`prs: PiUiPullRequest[]`、`update(id: string, patch: Partial<PiUiPullRequest>)`；§8.2 计划任务 示例改 `PiUiAutomation[]` 显式类型（修 `lastResult` 窄化 TS2322）；§3.3 删未使用的 `unregisterPiUiExtension` import；§3.7 改为可编译三步示例；§3.5 自动注入片段补 import。 | `db59fc5` |
| 1.3 | 2026-10-26 | 1.2 | R5 一致性终检：能力名称/描述/未提供原因按最终 `capabilities.ts` 同步（如 pane-workspace / permission-tiers / workspace-connectors）；用户可见文案去内部话术与早期代号（状态列「注入后（mock/扩展）」「可模拟演示」，附录 A「能力对照」）；§6 映射章节补实现位置（ClaudePlatformTabs/platformUi/ClaudeHubRail/CodexRunLocation）与「模式记忆=会话内、run location 与契约常量同值、worktree 门控行为」；§4 卡片「变体消费组件」改指真实源码；窗格 kind 枚举含 tasks/subagent。 | `df41a6d` |

**与骨架（初稿）的差异**：
1. 骨架的 12 节结构重排为 9 章 + 附录；§1 能力清单、§2 能力对照（A.1–A.3）、§4/§5/§6/§7/§9 的契约事实全部保留并扩写。
2. 40 个 `### cap-<id>` 锚点、`#device-platform`/`#cowork`/`#codex-runtime` 锚点均保留（变体禁用态链接依赖）。
3. 新增：快速开始三步验证、三条接入路径（如实说明生产无动态注入）、40 张卡片的数据契约/JSON/动作/事件/错误/边界/启用差异/mock、三个完整示例、FAQ/排错、变更记录。
4. 契约 v1 尚未提供的能力动作（automations create/update/remove、per-capability 错误字段、显式 contractVersion）在正文标注「待 MINOR/MAJOR」，**不伪造 API**；PR merge/close/archive/reopen 已由契约提交 `3c47af6` 补齐（本版文档已同步：状态扩展 archived、7 个 `pr:*` 事件）。

**已知未验证/边界（发布前）**：真实扩展链路（pi 扩展→relay→前端）未实现（仅方向）；生产网页无动态注入；真实设备/真机手机未在此文档范围验证；两变体实际组件路径见变体源码（本文件已在 §4/§6 标注实现位置）。
