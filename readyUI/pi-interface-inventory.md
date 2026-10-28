# pi 数据接口普查总账（接口富化施工图）

> 2026-10-08 · 基于事件流、命令能力、数据与 UI 面的静态审计 + 运行时探针实证。
> 证据分级：**[文档]** = `D:\pi\docs\*` 明示；**[示例]** = `D:\pi\examples\*` 有真实用法；**[探针]** = 本机运行时实测；**[推断]** = 推理，需实测确认。
> 本文件是**规划件**：清点"pi 有什么、前端能用多少、差什么、按什么顺序补"。契约本身仍以 `data-interface.md` 为准。

---

## 0. 总览：三层接口面现状

| 面 | pi 的全集 | 前端已能用 | 缺口 |
|---|---|---|---|
| **事件流** | wire 事件 **24**（json.md 规范表）+ 扩展钩子 **10**（extensions.md，`pi.on()` 可观察） | **34 种 1:1 转发** + 2 种扩展级合成事件（remote_message/_failed）+ 1 种实时帧（usage_state） | **3 个漏转钩子**（model_select / session_tree / session_compact_failed）+ 若干载荷未写全 |
| **命令** | 官方 RPC **33**（rpc-commands.md） | **24 已对齐 + 7 扩展自有 + 2 别名 = 33 个可用名**（9 个官方命令明确"本模式不支持"） | **~14 个进程内有接口但未暴露**（见 §3） |
| **数据结构** | message **8 role** + **4 block** + usage 全字段；session entry **12 type** | 类型全覆盖（契约 §6/§7/§13）；快照只承载 message 类 | 缺口在**渲染语义与元数据**（见 §4） |

**两个计数纠正**（此前口径不准，本文件起统一）：
1. "官方对齐命令"是 **24 个**（不是 26）：33 官方 = 24 已实现 + 9 明确不支持。
2. 转发的"34 事件" = **24 wire + 10 钩子**。钩子不在 json.md wire 表里（进程内扩展可观察并转发），对外表述时不要笼统说"34 种官方 wire 事件"。

---

## 1. 事件流全表

### 1.1 已转发的 34 种（24 wire + 10 钩子）

**wire 24**（json.md）：agent_start / agent_end / agent_settled / turn_start / turn_end / message_start / message_update / message_end / tool_execution_start / tool_execution_update / tool_execution_end / queue_update / entry_appended / session_info_changed / thinking_level_changed / compaction_start / compaction_end / auto_retry_start / auto_retry_end / summarization_retry_scheduled / summarization_retry_attempt_start / summarization_retry_finished / bash_execution_update / extension_error。

**钩子 10**（extensions.md）：before_agent_start / agent_before_settle / tool_call / tool_result / provider_stream_event / context / context_with_system / user_bash / cache_warming_decision / mcp_servers_change。

### 1.2 载荷补遗（契约 §5.0 要补的，均有出处）

| 事件 | 要补的载荷事实 | 依据 |
|---|---|---|
| `before_agent_start` | 字段是**当前 system prompt 字符串** `systemPrompt` + `systemPromptOptions`（含 `.sections`），**不是**"用户提示词"（现契约表述误导） | [示例] preset.ts:389、prompt-customizer.ts:42-46 |
| `tool_execution_*` | 嵌套调用（`ctx.executeTool`）三者**都带 `parentToolCallId`**，`toolCallId` 被赋为 `<parent>/n`；这些 id 不进 transcript，结果消息上以 `nestedCalls` 记录（name/args/status/duration/error，**不含结果**） | [文档] extensions.md:148 |
| `user_bash` | 返回契约：返回 `{operations}`/`{result}` **阻断**本地执行；返回 `undefined` 才直通；handler 抛错 = 阻断（fail-safe） | [文档] extensions.md:127 |
| `tool_call` | 有 `annotations`（readOnly/destructive/idempotent/openWorld）；返回 `{block:true, reason}` 可阻断 | [文档] extensions.md:166-178 |
| `context` / `context_with_system` | 字段名 `messages`（AgentMessage[]）；前者不含 system，后者含且 system 在 index0 | [示例] plan-mode:181 |
| `message_end` | 具 **replace 能力**（保持 role 替换终版，transform）；只读透传不受影响 | [文档] extensions.md:105 |
| `agent_before_settle` / `turn_end` | 二者是 **actionable 边界**：可 propose custom/custom_message/context_edit/compaction 条目并 `continue:true` 触发下一请求；只读转发时不做 | [文档] extensions.md:66,117 |
| `cache_warming_decision` / `mcp_servers_change` | **payload 未公开**（pi 文档/示例均无字段说明）→ 契约应标"payload 未公开，UI 忽略"，别再暗示可用 | [推断] |
| `entry_appended` | 仅 `pi.appendEntry()` 触发；model_change/usage/compaction/branch_summary/context_edit 等**内部条目不触发** | [文档] json.md:122 |
| 文档 bug | data-interface.md §1（L95）与 §4.6（L207）仍写"26 种事件"，与 §5"34 种"矛盾 → 应改 34 | — |

### 1.3 漏转评估（建议补进转发清单）

| 优先级 | 钩子 | 载荷 | 为什么值得转 | 风险/前置 |
|---|---|---|---|---|
| **P0** | `model_select` | `{model, previousModel, source}`（source=/model、Ctrl+P、restore） | pi **唯一没有 wire 事件的状态变化**（thinking level 有事件、model 没有，严重不对称）。前端现在只能从下一条 assistant 消息反推，无即时"模型已切"信号 | notification 钩子，示例只 notify/setStatus，返回 undefined 无副作用 [示例]；**"返回 undefined 不改变 pi 行为"无文档明说 [推断]，补前需一次实测** |
| **P1** | `session_tree` | 通知（`/tree` 分支跳转后，带 ctx） | 本机分支跳转前端无即时事件，只能等快照 | notification，[推断] 同 P0 需实测 |
| **P2** | `session_compact_failed` | `{reason, errorMessage?, aborted, willRetry, fromExtension}` | 与 compaction_end 失败分支信息重叠，价值低 | notification |
| P2 | `session_before_compact` | 富前置（firstKeptEntryId/tokensBefore/…） | 压缩详情调试 UI 有价值，非镜像必需 | 数据含 signal，只读透传 |

**明确不转**：`input`（transform 钩子无通知形态——原文不是终端最终呈现，转它反而破坏 1:1）；`session_before_switch`/`session_before_fork`/`session_before_tree`（可取消守卫，转发者无取消权=越权误导）；`resources_discover`（装载期一次性）；`session_start`/`session_shutdown`/`project_trust`（本地生命周期/安全决策）。

### 1.4 事件之外的"状态变化通知"缺口（只登记）

模型切换（仅 model_select 钩子）/ 分支跳转（仅 session_tree）/ 设置变更 / 模型 catalog 刷新 / provider 认证变更 / 会话文件被外部改 / 扩展重载——**均无 wire 事件**，前端只能轮询命令或靠连接重建。唯一例外：MCP 连接变化有 `mcp_servers_change`（已转发，payload 未公开）。

---

## 2. 命令面：官方 33 核对

**已对齐 24**：prompt, steer, follow_up, abort, abort_bash, get_state, get_messages, set_model, get_available_models, set_thinking_level, get_available_thinking_levels, compact, bash, get_session_stats, new_session, switch_session, fork, clone, get_fork_messages, get_entries, get_tree, get_last_assistant_text, set_session_name, get_commands。

**明确不支持 9**（进程内扩展接口确实没有，契约已声明）：cycle_model / cycle_thinking_level（循环规则在 RPC server 侧）/ set_steering_mode / set_follow_up_mode / set_auto_compaction / set_auto_retry（设置项只读）/ abort_retry / clear_queue（队列能看不能清）/ export_html。

**已暴露但口径缺边**：
- `get_state` 缺官方 3 字段 `steeringMode`/`followUpMode`/`autoCompactionEnabled`（`pi.getSettings()` 就能拿到）
- `compact` 把官方 6 字段返回（summary/firstKeptEntryId/tokensBefore/estimatedTokensAfter/usage/details）裁成了 `{ok:true}`（`ctx.compact()` 本来就有这数据）
- `new_session` 未传官方可选参数 `parentSession`
- `get_available_models` 用 `getAll()`（全部已配置）而非 `getAvailable()`（认证可用）——前端分不清"已配置但没配 key"，要靠 §3 的 `get_provider_auth` 补

---

## 3. 命令面：未暴露机会清单（前端还用不了的）

> "调用安全度"：**可直调** = WS 回调/事件 ctx 里安全；**需谨慎** = command-only 或有 stale-ctx 陷阱；**不可调** = 不应从远端触达。
> **重要前提**：probe-out.json 的方法面采自**命令上下文**，扩展 WS 回调持有的是**事件上下文**（extensions.md:214-215 明示 reload/shutdown/waitForIdle/会话替换 command-only）——这正是扩展用 `sm.*` 而非 `ctx.newSession()` 的原因。probe10 已在 session_start（事件 ctx）上证实事例见下。

### 3.1 只读查询类（全部可直调，低风险）

| 建议接口 | pi 依据 | 返回形状 | 证据 |
|---|---|---|---|
| **`get_all_tools`** | `pi.getAllTools()` | `{tools:[{name, description, parameters(JSON Schema), promptGuidelines[], exposure, sourceInfo}]}` | **[探针]** probe10：本机 10 个工具，字段如上（注意：内置 read 工具上**没有** annotations/namespace 字段，别按 extensions.md:164 的描述臆造） |
| **`get_provider_auth`** | `modelRegistry.getProviderAuthStatus(provider)` / `hasConfiguredAuth(model)` / `isUsingOAuth(model)` / `getProviderDisplayName(provider)` / `getRegisteredProviderIds()` | `{providers:[{id, displayName, status, usingOAuth, registered}]}` | **[探针]** probe10：`getProviderAuthStatus()` → `{configured:false}`；`getRegisteredProviderIds()` → `["llama.cpp"]`。**红线：绝不经 getApiKeyAndHeaders/getApiKeyForProvider 取密钥** |
| **`get_mcp_servers`** | `pi.getMcpServers()` | `{servers:[{name, transport, exposure, enabled, connected, toolCount, error?}]}`（**白名单投影**） | **[探针]** probe10：返回数组（本机为空）；config 可能含 env/headers/command，绝不整包回传 [文档] mcp.md |
| **`get_system_prompt`** | `ctx.getSystemPrompt()` | `{prompt, chars, truncated?}`（32KB 截断） | **[探针]** probe10：session_start ctx 上可用，本机 2604 字符。**[探针] `ctx.getSystemPromptOptions()` 在事件 ctx 上不是函数**（probe-out.json 的命令 ctx 上有）→ 做成可选：有则回，无则省略 |
| **`get_scoped_models`** | `ctx.scopedModels` | `{models:[…]｜null}` | **[探针]** probe10：事件 ctx 上是数组（本机为空数组） |
| **`get_entry {entryId}`** | `sm.getEntry(id)`/`byId(id)` | 单条目全字段 | **[探针]** probe10：条目形如 `{type,id,parentId,timestamp,…}`。价值：快照 12MB 预算截断后的**按需补洞** |
| **`get_labels`** | `sm.getLabel(id)`/`labelsById`/`labelTimestampsById` | `{labels:[{targetId,label,at?}]}` | **[文档]** session-format.md:189-198；**[探针]** probe10：`getLabel()` 无参时返回 undefined（需按 targetId 调） |
| **`get_children {parentId?}`** | `sm.getChildren(id?)` | `{children:[…] , leafId}` | **[探针]** probe10：`getChildren(leafId)` → 数组（本机空）。价值：大会话树分页探索 |
| **`get_flags {names[]}`** | `pi.getFlag(name)` | `{flags:{name:value}}` | **[探针]** probe10：`pi.getFlag()` 无参返回 **undefined**——只能按名取，pi 无"列全部 flag"接口；前端只能查已知名（--ssh/--preset/--no-sandbox 等） |
| **`export_session {format, maxChars?}`** | 包导出 `serializeConversation()` | `{text}`（直接回传，不落盘） | **[文档]** sdk.md + [示例] handoff.ts:110；**[探针]** 早前 probe-out.json 实证进程内 `import("@earendil-works/pi-coding-agent")` 可用（156 导出）。价值：**弥补 export_html 不可用** |

### 3.2 写操作类（需门控/谨慎）

| 建议接口 | pi 依据 | 风险 | 结论 |
|---|---|---|---|
| `delete_session {sessionPath}` | 无 pi API，删 `.jsonl`（session-format.md:16-20） | 路径监狱 + trash 优先 + **禁删当前会话** | 推荐做（会话管理闭环最后一块） |
| `set_label {entryId,label}` / `clear_label` | `pi.setLabel(entryId, label｜undefined)` → 落 LabelEntry | 写会话树（不进模型上下文）；需与 compact/fork 同样的 epoch+快照语义 | 候补；允许远端写会话结构，默认开或关需产品决策 |
| `reload_runtime` | `ctx.reload()`（**command-only**） | 重载后旧 ctx 全失效、WS 桥重建、窗口期内远端命令必失败 | 候补；需先实测事件 ctx 上有无 reload（probe-out.json 的 reload 来自命令 ctx） |

### 3.3 明确拒绝（记入契约 §15 防误用）

`pi.sendMessage()`/`pi.appendEntry()` 远端调用（写会话/往模型上下文注入任意内容）；`sm.append*/persist/_rewriteFile`（绕过 pi 校验改 jsonl）；`modelRegistry.stream/streamSimple/complete/classify/generateImages`（远端直接烧 token）；一切密钥类方法（`getApiKeyAndHeaders`/`getApiKeyForProvider`/readStoredCredential）；`ctx.shutdown()`（远端杀死用户终端）；全部 `register*/unregister*`（远端=代码/工具注入面）；`ctx.ui.confirm/select/input/editor/custom` 透传（远端弹窗骚扰 + RPC Extension UI 子协议不在本通道）；放宽 `pi.exec`（保持 PI_REMOTE_ALLOW_BASH 门控）。

---

## 4. 数据结构面

### 4.1 消息类型（8 role + 4 block）——**类型已全覆盖，缺口在渲染语义**

| 缺口 | 说明 | 出处 |
|---|---|---|
| **toolResult.details 无逐工具 schema** | 契约只说"按 toolName 解析"却没定义形状（bash 退出码/edit diff/read 行号），diff 卡片要前端自制 | [文档] message-types.md:164-173 |
| **user/custom 的 string↔array content 双形态** | §8 重建算法默认按 array，本地裸 string user 消息会兜底失败 | [文档] message-types.md:110-117 |
| **system 在快照中缺席**（设计如此：§4.5 不落） | sections/toolsAdded/toolsRemoved（"模型为什么这么做"）前端无源 → 靠 `get_system_prompt` 补成品，sections 演变得靠 system 消息（现无源） | [文档] message-types.md:97-105 |
| custom/branchSummary/compactionSummary 无特化卡片；toolCall 的 thoughtSignature/namespace 可忽略 | — | [文档] message-types.md |
| message_update delta-only 约定（12 型 assistantMessageEvent、剥 partial） | 契约 §5.1/§8 **已完整覆盖**，无缺口 | [文档] json.md:70-95 |

### 4.2 会话条目（12 type）——快照只承载 message 类，其余半可见

`session / message / model_change / thinking_level_change / usage / compaction / context_edit / branch_summary / custom / custom_message / label / session_info`。

半可见映射：model/thinking → get_state；usage → usage_state.usageByKind；compaction → compaction_end + 摘要卡；session_info → session_info_changed。
**基本不可见**：
- **`context_edit`**（replacement：null=从模型视野删除/非 null=仅替内容/最新-on-分支胜/分支相对）——前端无法知道某消息被改写/被删，树与导出失真风险
- **`custom`** 的 renderer 输出走 `registerEntryRenderer` 另一条协议，前端只拿裸 data
- **`label`** 仅附在 get_tree 节点的 label?/labelTimestamp?

### 4.3 终端展示面（终端有、前端无）——v2.7 后 footer 已全量对接

剩余：启动 header 的 instructions/resources 清单（靠 `get_system_prompt` 补）；扩展 status/widget/notify（见 §4.4）；富工具/条目 renderer 输出（TUI/HTML 专用，不透数据）；本机终端 toggle（Ctrl+O/Ctrl+T，跨端同步价值低）。

### 4.4 Extension-UI 子协议评估

pi 的 `ctx.ui` 仅在 **RPC 模式** materialize 成 `extension_ui_request`/`extension_ui_response`（stdout/stdin，按 id 关联）。我们是进程内 TUI 扩展，**没有**这条 wire 桥——这是 §15.1 不透传的原因。关键事实：**每个扩展有独立 ctx，34 事件流里没有任何"某扩展调了 ui"的上报** [推断] → 镜像扩展看不到**别的**扩展的 notify/dialog。
**低风险可透传子集（仅限镜像扩展自有 UI）**：notify / setStatus / setWidget（fire-and-forget 无阻塞）。dialog 需完整双向通道且只覆盖自己，暂不做。

---

## 5. 优先路线图（前端价值 × 实现成本）

> **进度（2026-10-08 晚）**：P0 全部完成、P1 全部完成、P2 大部分完成（context_edit 暴露以契约说明落地、notify 透传经评估由 remote_message 事件覆盖无需单独做）。落地明细见 data-interface.md v2.8 与 frontend-review.md v2.8 附注；E2E 60 项全过。剩余候补：reload_runtime（需先实测事件 ctx 有无 reload）、wait_idle、toolResult.details 逐工具补样（edit/grep/find/ls 本机 0 样本）。

> **进度（2026-10-08 夜 · 第四轮）**：三路并行复查完成（pi 出厂 bundle 源码级普查 / 前端逐条核对契约 / UI 审查）。新落地：`get_git_branch`（footer 最后缺口）、`get_projection`（模型实际所见，buildSessionProjection）、`session_before_compact` 裁剪转发（含生效压缩阈值）、`get_provider_auth.usingSubscription`、toolResult.details 源码级形状表入契约 v2.9；前端修掉 2 个真 P0（compact 双发、draftRef 导致远程发送全失效）+ 12 项 P1 + 一批 UI 优化（ARIA/性能/安全区/ErrorBoundary）。E2E **72 项**全过，浏览器实况验证通过。明细见 data-interface.md v2.9 与 frontend-review.md v2.9 附注。
>
> **剩余明确不做（源码级结论，别再列待评估）**：跨扩展 notify/setStatus/setWidget 透传（结构性不可观测——每扩展独立 ctx，dialog 之外不 emit）；before_provider_request / before_provider_headers（= 完整请求体/含密钥，红线）；session_before_switch/fork/tree（可取消守卫，转发=越权）；input（破坏 1:1 镜像语义）；wait_idle（撞 60s 命令超时且 abort 已内含等空闲）；cycle_*（扩展面无，前端用 available + set_model 自循环）；export_html（RPC 模式专有）；reload_runtime（路线已通但产品价值低，需产品决策）。缓存预热下次决策（CacheWarmer.status 不可达）、retryAttempt（不可达）——事件/usage_state 已覆盖。

### P0（下一批就做，成本低价值高）
1. **`get_state` 补官方 3 字段**（steeringMode/followUpMode/autoCompactionEnabled ← getSettings）+ mode/hasUI/projectTrusted
2. **`compact` 回传官方完整结果**（6 字段）
3. **`get_all_tools`**（pi.getAllTools，纯只读；probe10 形状已证）
4. **`get_provider_auth`**（认证状态；红线已明）
5. **`model_select` 事件补转发**（前置一次"返回 undefined 无副作用"实测）
6. **user string↔array content 兜底**（前端渲染修复，契约补一节）
7. 载荷补遗 10 条进 data-interface.md §5.0（含"26 种事件"bug 修正）

### P1（紧随其后）
8. **`get_mcp_servers`**（白名单投影）
9. **`get_system_prompt`**（+ options 可选）
10. **`get_entry` / `get_labels` / `get_children`**（快照截断补洞 + 书签 + 树分页）
11. **`session_tree` 事件补转发**（同 P0 需实测）
12. **`delete_session`**（路径监狱 + 禁当前会话）
13. **`get_scoped_models`**

### P2（有价值或有前置）
14. **`export_session`**（serializeConversation → 文本回传；import 路径已实证可用）
15. **context_edit 语义暴露**（树/导出不失真）
16. **get_tree 活动路径标记**（isOnActivePath，前端自反推改服务端算）
17. **toolResult.details 逐工具 schema 调查**（对每个内置工具实跑一次取 details 形状）
18. **`new_session` 传 parentSession**；**`list_sessions` 加 query/namedOnly**；**`get_flags`**；**`get_routing`**（虚拟模型路由态，从 entries 派生）
19. **镜像扩展自有 notify/status/widget 透传**（Extension-UI 低风险子集）

---

## 附录：本账使用的探针证据（probe8/9/10，本机实测）

| 探针 | 结论 |
|---|---|
| probe8 | `ctx.executeTool`/`ctx.tools` 在命令 ctx **不存在**（只有工具 ctx 有）→ 远程 bash 走 pi.exec 是对的；`pi.exec` 返回 `{stdout,stderr,code,killed}`、认 signal（abort 后 killed:true）、**无 onUpdate 流式**；`pi.sendMessage` 落 `custom_message` 条目 |
| probe9 | `ctx.getContextUsage()` = `{tokens, contextWindow, percent}`（percent 为 0~1 小数） |
| probe10 | `getAllTools()`→10 项 `{name,description,parameters,promptGuidelines,exposure,sourceInfo}`；`getMcpServers()`→数组（空）；`getFlag()` 无参→undefined；`getSettings()` keys=[lastChangelogVersion,defaultProvider,defaultModel,defaultThinkingLevel]；`scopedModels`→数组（空）；`getSystemPrompt()` 可用（2604 字符）；**`getSystemPromptOptions` 在事件 ctx 上不是函数**；modelRegistry 认证方法族存在（getProviderAuthStatus→{configured:false}, getRegisteredProviderIds→["llama.cpp"]）；`sm.getHeader()`→{type,version:3,id,timestamp,cwd}；`sm.getLeafEntry()`→{type,id,parentId,timestamp,…}；`sm.getChildren(leafId)`→数组 |

三份完整分报告（含逐字段大表）：`<scratch>/events-census-report.md`、`<scratch>/pi-capability-census.md`、`<scratch>/pi-interface-survey.md`。
