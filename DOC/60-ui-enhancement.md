# 前端功能增强设计：状态条 · 模型切换 · 命令弹窗体系

> **本文只做设计，不含实现代码；执行由项目负责人按本文展开。**
> 范围：现有三皮肤（desktop `/`、mobile `/m`、beauty `/b`）的**功能增强**，不动协议、不动后端、
> 不动 `useRelay`/`transcript` 的数据层——所有能力都映射到 `readyUI/data-interface.md` 里已有的命令与帧。
> 与 `DOC/40-frontend.md`（harness 的前端）相互独立：那份面向新协议，本文面向现行 UI 的功能补齐。
> **状态（2026-10 换成新界面之后）**：本文是旧界面的设计，§9 列的 `chat/ui.tsx`、`chat/dialogs.tsx`、`App.tsx`、`chat/parts.tsx`、`chat/slash.tsx` 都已删除。现在的对应关系（路径相对 `ui/src`）：
> 弹窗 → `pi/containers/DialogsContainer.tsx` + `components/pi/composer/*Dialog.tsx`（PiDialog / PiSheet 家族，`components/pi/shared/PiOverlay.tsx`）；
> 状态条 → `components/pi/composer/PiComposerStatusRow.tsx`；命令中心 → `components/pi/composer/PiCommandPalette.tsx`（⌘K）；
> slash 路由 → `components/pi/composer/PiComposerMenu.tsx` + `pi/model/slashMenu.ts`。弹窗的命令、帧、文案口径（§5、§10）仍然有效。现行界面说明见 `ui/README.md`。

## 1. 现状与缺口（逐条带证据）

| # | 能力 | 数据接口里已有 | 前端现状 | 缺口 |
|---|---|---|---|---|
| 1 | 上下文消耗程度 | `usage_state.contextUsage{tokens,contextWindow,percent}`（§4.7.1）、`get_context_usage` | 仅 desktop 头部一行小字"上下文 8.8%" | 无进度条、无 token/窗口数、mobile/beauty 无 |
| 2 | 花费 | `usage_state.cost`、`costByModel`、`get_session_stats.cost` | 头部 `$0.0010` 小字 | 无累计明细、无按模型/按类型拆分、无统计面板 |
| 3 | token 明细 | `usage_state.tokens{input,output,cacheRead,cacheWrite}` | 未展示 | 完全缺失 |
| 4 | 模型切换 | `get_available_models`（`available`=认证可用）、`set_model`（E2E 真实往返已验证） | 只能敲 `/model` | 无可见按钮、无模型列表窗口 |
| 5 | 思考级别 | `get_available_thinking_levels`、`set_thinking_level` | 只能敲 `/thinking` | 无可见按钮 |
| 6 | 设置 / 工具 / 压缩 / 统计 / 上下文 / 切会话 / 分叉 / 树 / 命名 / 导出 / 删除 | 对应命令全部存在（§4.11.2，45 个） | slash 敲完只弹一条通知 | 无独立窗口、无表单、无浏览、无确认流 |
| 7 | 本机信息（工具全表/认证/MCP/作用域/路由/flags/书签/子节点/git 分支/模型投影） | `get_all_tools`/`get_provider_auth`/`get_mcp_servers`/`get_scoped_models`/`get_routing`/`get_flags`/`get_labels`/`get_children`/`get_git_branch`/`get_projection` | 完全不可见 | 无检视入口 |

结论：**数据都在，缺的是"展示层 + 交互层"**。本设计补齐这两层，不新增任何接口。

## 2. 设计目标与原则

1. **不新造数据**：一律消费既有命令/帧；契约零变更。
2. **一眼可见的状态**：上下文、花费、模型、思考级别常驻可见（状态条）。
3. **一处入口的命令**：鼠标/触屏用户也有"命令中心"，不必记 slash。
4. **该窗口化的就窗口化**：凡需要"选、填、看结果、确认"的命令进独立弹窗；一键执行的（复制、排队、新建）才保留 slash 直发。
5. **三皮肤同数据同交互只换皮**：组件树只有一套，皮肤差异走既有 `useStylePrefs`/`SlotTint` 机制。
6. **可访问性延续既有水位**：弹窗 = `role=dialog aria-modal`＋焦点管理；选择列表用 `role=listbox`（slash 面板已有同款实现可参照）。
7. **一切降级有路**：未连接、命令失败、数据为空都有明确空态与文案。

## 3. 信息架构

```
会话页
├─ 状态条 StatusStrip（常驻：输入区上方，三皮肤都有）
│   ├─ 上下文消耗条（percent 进度条 + tokens/窗口）
│   ├─ 累计花费 $
│   ├─ token 明细 ↑输入 ↓输出 R缓存读 W缓存写
│   ├─ [模型 step-5-preview ▾] ──▶ 弹窗 A 模型选择
│   ├─ [思考 high ▾]           ──▶ 弹窗 B 思考级别
│   ├─ [状态]                  ──▶ 弹窗 C 用量与费用
│   └─ [命令]                  ──▶ 弹窗 P 命令中心（分组网格 → 打开其余弹窗）
├─ 消息区 / 输入区（现状不动）
└─ 全局弹窗宿主 UiHost（App 根部，任何组件可唤起）
```

弹窗族一览：

| 类型 | 弹窗 |
|---|---|
| 选择型 | 模型 / 思考级别 / 切换会话 / 分叉点 / 会话树节点 |
| 表单型 | 压缩上下文（customInstructions）/ 修改会话名 / 工具管理（多选+保存） |
| 展示型 | 用量与费用 / 上下文占用 / 当前会话状态 / 本机设置 / 本机信息检视 |
| 确认型 | 克隆分支 / 重新回答 / 删除会话（两点确认） |
| 导出型 | 导出会话（复制 / 下载 .txt） |
| 入口型 | 命令中心（分组网格） |

## 4. 弹窗基元（所有弹窗共用规范）

| 项 | 规范 |
|---|---|
| 结构 | 标题栏（标题 + 关闭钮）／内容区（独立滚动，`max-h: 88dvh`）／底部操作区（按需） |
| 打开 | 焦点吸入弹窗；`aria-modal="true"`、`aria-label=标题` |
| 关闭 | Esc、点遮罩、关闭钮；关闭后焦点还原到唤起点 |
| 移动端 | 底部抽屉（贴底、上圆角、全宽）；桌面居中模态 |
| 主题 | 只用现有令牌（`bg-card`/`border-input`/`text-muted-foreground`/`bg-accent`…），不引入新配色 |
| 通用子件 | 列表行（主标题+副标题+右侧标记/动作）、加载中、错误块、JSON 展示块（限高滚动）、键值行、主按钮、危险按钮（删除） |
| 状态闭环 | 每个弹窗：loading → 内容/空态/错误；操作中按钮禁用+文案；成功→通知并关闭；失败→通知并**保持打开**可重试 |

## 5. 各弹窗详细设计

### 5.1 模型选择（A）
- **数据**：`get_available_models` → 优先 `available`（认证可用）；`available` 为空回落 `models` 并提示"未认证，切换可能失败"；两者都空 → 空态引导"去本机 pi `/login`"。
- **列表**：主标题 `name`，副标题 `provider/modelId · 上下文 <window>`；当前模型行高亮 + "当前"标记。
- **交互**：点行 → `set_model{provider, modelId}`；该行进入"切换中…"；成功 → 关闭 + 通知"已切换模型"；失败 → 通知错误原因、保持打开。
- **边界**：离线禁用；`set_model` 对未认证模型会被本机拒绝（E2E 已验证），错误原文透出。

### 5.2 思考级别（B）
- **数据**：`get_available_thinking_levels` → `levels`（由当前模型决定，可含 xhigh/max）。
- **交互**：点行 → `set_thinking_level{level}`；当前级别标记；成功关闭。

### 5.3 用量与费用（C）
- **数据**：`get_session_stats`（`totalMessages/userMessages/assistantMessages/toolCalls/toolResults`、`tokens`、`cost`、`usageByKind`、`costByModel`）+ `usage_state.contextUsage`（实时上下文）。
- **布局**（自上而下）：三宫格（消息数 / 用户:助手 / 工具调用）→ token 五行表（输入/输出/缓存读/缓存写/合计）→ 累计费用 → 按用量类型拆分（kind、次数、tokens、cost）→ 按模型拆分费用 → 实时上下文进度条；右下角"刷新"（重取 stats）。
- **说明**：所有数字口径见契约 §4.7.1/§4.11.2（toolResult 嵌套用量、`usage` 条目、压缩摘要用量都已计入）。

### 5.4 上下文占用（D）
- **数据**：`get_context_usage`（`{tokens, contextWindow, percent}`）+ `usage_state` 兜底。
- **布局**：大进度条（阈值染色）+ 百分比 + `tokens / 窗口`；脚注说明"接近 100% 自动压缩；压缩后短时间内为空是官方语义"。

### 5.5 当前会话状态（E）
- **数据**：`get_state`。
- **布局**：键值行——会话名/目录/模型/思考级别/消息数/待发消息/`mode`·`hasUI`/项目已信任/steer·followUp 模式/自动压缩开关/运行态（压缩中·输出中·空闲）。

### 5.6 本机设置（F）
- **数据**：`get_settings`（服务端已对敏感键递归脱敏为 `***`）。
- **布局**：JSON 展示块（限高滚动）+ 脱敏提示。只读，不做编辑（编辑设置仍在本机）。
- **2026-10-28 追加**：扩展侧已提供 `settings_set` 白名单写桥（additive；只写全局 agentDir，写后需重启，见 `DOC/76-settings-write-bridge.md`）。本节旧只读 JSON 展示块未改；设置页 v2 的 ◐ 项由后续 UI 工作流接入。

### 5.7 工具管理（G）
- **数据**：`get_active_tools` + `get_all_tools`（池=全表工具名；全表不可用时退化为 active）。
- **交互**：checkbox 多选；仅在有改动时启用"保存" → `set_active_tools{tools}`；结果通知"已启用：…"或"已清空"。
- **边界**：与终端 `/tools` 语义一致（改的是启用集，不是注册表）。

### 5.8 压缩上下文（H）
- **数据/命令**：`compact{customInstructions?}`。
- **布局**：说明（会让模型总结更早对话，烧一次调用）+ 多行输入（可选的自定义要求）+ 主按钮；`relay.busy` 时按钮禁用并提示"本机正在输出，压缩会被拒绝"。
- **成功**：通知"已开始压缩"→ 关闭；后续 `compaction_*` 事件 + 新快照自然到达（无需轮询）。

### 5.9 切换会话（I）
- **数据/命令**：`list_sessions{limit:50}` → `switch_session{sessionPath}`。
- **列表**：name/firstMessage（主）、`cwd · N 条`（副）、当前标记。
- **后续**：切换成功后本机换会话 → `room_list` 出现新房间（现状机制，UI 无需特殊处理）。

### 5.10 从消息分叉（J）
- `get_fork_messages` → 行（user 消息摘要）→ `fork{entryId}`；成功通知"列表里会出现新会话"。

### 5.11 会话树跳转（K）
- `get_tree` → 展平节点（`entry.id`、label、`当前叶` 标记、层级缩进）→ `navigate_tree{targetId}`；成功通知"已跳到所选节点"。

### 5.12 修改会话名（L）
- 输入框（默认当前名）→ `set_session_name{name}`。双入口：slash 带参数（`/name 新名字`）直发；无参数开本弹窗。

### 5.13 导出会话（M）
- `export_session` → 文本展示（限高滚动）+「复制」（clipboard，失败提示手动选择）+「下载 .txt」（Blob）；`truncated` 时提示已截断。

### 5.14 删除会话（N）
- `list_sessions{limit:100}` → 仅列**非当前**会话 → 两点确认（第一次选中标记"再点一次确认"，第二次才执行）→ `delete_session{sessionPath}`。
- 红色警示"永久删除，没有回收站"；成功后通知并关闭。

### 5.15 确认型（O：克隆 / 重新回答）
- 统一"说明 + 取消/确认"；`relay.busy` 时禁用并提示；执行 `clone` / `regenerate`。

### 5.16 本机信息检视（Q）
- 顶部分类切换钮 + JSON 展示区，分类：工具全表（`get_all_tools`）/ Provider 认证（`get_provider_auth`）/ MCP（`get_mcp_servers`）/ 模型作用域（`get_scoped_models`）/ 虚拟路由（`get_routing`）/ 扩展 flags（`get_flags`）/ 会话树子节点（`get_children`）/ 书签（`get_labels`）/ git 分支（`get_git_branch`）/ 模型看到的上下文（`get_projection`）。
- 用途：把"接口有但前端没入口"的数据一次性开放为只读检视。

## 6. 命令中心（P）

- **形态**：分组网格（桌面 3 列 / 移动 2 列），四组：**模型与生成**（切换模型/思考级别/重新回答）、**上下文**（压缩/用量与费用/上下文占用）、**会话**（切换/分叉/克隆/树跳转/命名/导出/删除）、**本机**（设置/工具管理/当前状态/本机信息检视）。
- **行为**：点格打开对应弹窗（可连续跳转，如 命令中心→模型→关闭回到命令中心）。
- **与 slash 的关系**：slash 保留（键盘流），命令中心服务鼠标/触屏流；两者命令集合同源，不重复实现业务。

## 7. slash 面板改造（最小改动）

| 命令 | 现状 | 改为 |
|---|---|---|
| `/model` `/thinking` `/compact` `/settings` `/stats` `/usage` `/resume` `/fork` `/tree` `/clone` `/regenerate` `/session` `/tools` | 直接执行 + 一条通知 | 打开对应弹窗（§5） |
| `/name` | 直接执行 | 带参数直发；无参数开弹窗（双入口） |
| `/copy` `/follow` `/new` `/commands` | 直接执行 | 保留直发（无输入无确认）；`/commands` 改为打开命令中心 |

实现要点（非代码）：命令规格表加 `dialog` 字段 → `choose()` 命中即 `ui.open(dialog)`；不带 `dialog` 的走原执行路径。

## 8. 状态条详细设计

### 8.1 字段映射（全部来自 `usage_state` 与 `get_state`，零轮询）

| 展示 | 数据来源 | 备注 |
|---|---|---|
| 进度条 + `上下文 x.x%` | `contextUsage.percent`（0~1） | null 时退化为 `tokens/窗口`；再退化为"—" |
| `$0.0010` | `cost` | 0 或不显示 |
| `↑in ↓out R… W…` | `tokens.{input,output,cacheRead,cacheWrite}` | 千分位/k 缩写；悬浮显示原值 |
| `[模型 …]` | `model`（`model_select` 事件/命令返回值更新） | 点击开弹窗 A |
| `[思考 …]` | `thinkingLevel` | 点击开弹窗 B |
| `[状态] [命令]` | — | 打开 C / P |

### 8.2 视觉与阈值
- 进度条三段染色：`<70%` 绿 / `70–90%` 琥珀 / `≥90%` 红（对齐"将满预警"）。
- 单行不换行溢出：窄屏隐藏 token 明细（保留上下文条与两个 chip），悬浮/点击看全量。

### 8.3 三皮肤落位（旧界面）
- desktop/beauty：输入区上方一整条（现有 `Composer` 包裹层内，三皮肤共用）。
- mobile：同一组件，窄屏折叠 token 明细；按钮触控区 ≥44px。

### 8.4 降级
- 未连接（`online=false`）/ 无会话：chips 与按钮禁用，进度条置灰并显示"—"。
- `usage_state` 未到（剛订阅）：显示"—"，不报错（契约 §4.7.1：subscribe 时会补送）。

## 9. 组件与文件划分（执行落位，不含代码）
（旧界面的落位，下表的新增文件都已删除，对应关系见文件开头。）

| 文件 | 动作 | 说明 |
|---|---|---|
| `ui/src/chat/ui.tsx` | **新增** | `UiProvider`/`useUi`（弹窗开关上下文）+ `Modal` 基元 + `StatusStrip` |
| `ui/src/chat/dialogs.tsx` | **新增** | §5 全部弹窗 + `UiHost`（按名渲染）+ 命令中心 |
| `ui/src/App.tsx` | 改 | 用 `UiProvider` 包根；渲染 `<UiHost relay>` |
| `ui/src/chat/parts.tsx` | 改 | `Composer` 内渲染 `<StatusStrip>`（三皮肤共用） |
| `ui/src/chat/slash.tsx` | 改 | 命令表加 `dialog` 字段与路由（§7） |
| `ui/src/relay/useRelay.ts` | 不动 | `runCommand/usage/model/thinkingLevel/online` 已够 |
| `readyUI/data-interface.md` | 不动 | 无协议变更 |

## 10. 错误与文案（统一出口）

| 场景 | 文案 |
|---|---|
| 设备/本机离线 | 本机未连接，稍后再试 |
| 命令 10s/16s 无回应 | 本机没有回应，请重试 |
| `set_model` 被拒 | 透出来自本机的错误原文（如"模型切换被拒绝"） |
| 无可用模型 | 没有可用模型：先去本机 pi `/login` |
| 压缩时正忙 | 本机正在输出，压缩会被拒绝，稍后再试 |
| 删除当前会话 | 当前会话不能删除 |
| 剪贴板失败 | 复制失败，请手动选择文本 |

## 11. 验收标准

**功能（E2E 假帧 + 真 keeper）**：
1. 模型弹窗：列表=`available`、当前标记、往返切换成功、失败保持打开。
2. 思考级别弹窗：切换生效且 `thinking_level_select` 到达后 chip 更新。
3. `用量与费用`：各数字与 `get_session_stats` 一致；`costByModel` 拆分正确。
4. 工具管理：保存后 `get_active_tools` 反映；未改动时保存禁用。
5. 压缩：busy 时禁用；成功后收到 `compaction_*` 与新快照。
6. 切换会话/分叉/树：成功后 `room_list` 换房或同房新快照。
7. 删除：两点确认；当前会话不在可删列表。
8. 状态条：usage_state 推送即刷新、percent 阈值染色、离线禁用。

**体验（浏览器 checklist）**：三皮肤一致；Esc/遮罩可关；焦点吸入与还原；移动端 44px；空态/错误态齐全；`tsc -b` 0 error、`oxlint` 0 error。（旧界面；新界面按桌面 / 手机两种布局验收，见 `ui/README.md` 的对图一节）

## 12. 明确不做

- 任何协议/后端变更（本文零新增接口）。
- 账户 UI、设备断开按钮、图片附件发送（另册）。
- 长会话虚拟化渲染（另册遗留项）。
- 设置的编辑保存（只读展示；改设置仍在本机终端）。

## 13. 实施顺序建议（按收益排序）

| 批次 | 内容 | 依赖 |
|---|---|---|
| P0 | 状态条 + 模型/思考弹窗 + 命令中心 + UiProvider/UiHost 骨架 | 无 |
| P1 | 用量与费用 / 上下文占用 / 设置 / 工具管理 / 压缩 | P0 |
| P2 | 切换会话 / 分叉 / 树 / 命名 / 导出 / 删除 / 本机信息检视 + slash 改造 | P0 |

> 附：原误建的实现文件已全部回退删除，仓库与线上均未受影响；本文为唯一交付物。
