# pi 终端数据接口规范（流式）

> 面向 readyUI 的组件开发。本文档定义**手机/Web 端看到的一切流式数据**的完整格式：
> 与在本机终端手动使用 pi 所见**完全一致**——思考过程、工具调用、任务队列、重试、压缩，一个不漏。
>
> 数据链路：`本机 pi（官方 CLI）→ pi-remote-sync 扩展 → relay(7001) → relay(7002) → 你的 UI`
>
> **当前版本 v3.1**（2026-10-08）：在 v3 上合并设备 / 连接窗口 / 会话清单（增量设计见 `DOC/50-protocol-delta.md`）。先读 §0 的 v3.1 小节。既有帧除该小节与正文注明处外，语义保持 v3。
> 参考实现：`ui/src/relay/sync.ts`（快照/事件对齐规则）、`ui/src/relay/commands.ts`（命令超时与重发）。

---

## 0. 版本更新（前端必读）

### v4（握手 / 错误码 / 消息 id / 设备令牌 · 2026-10-09，第一轮）

完整契约在 `DOC/71-protocol-v4.md`，机器可读部分（版本、能力、错误码、上限）在 `protocol/v4.json`；下面只列对本文件各节的影响。规则仍是**只加不改**：v3 的帧名和字段全部保留，旧客户端照常工作。

| 影响 | 内容 | 本文件对应 |
|---|---|---|
| 握手 | `auth` 加 `proto:4`、`caps`、`client`；`auth_result` 回 `proto`、`caps`（local 通道另回 `auth:"token"|"legacy"`）。按 `caps` 开关功能，不再按 `unknown_type` 猜 | §3、§4.1 |
| 错误 | v4 客户端收到的每个失败都带 `code`（`ack.code` / `error.code`），码表见 `protocol/v4.json` 的 `errors`；按码做交互，不要匹配文案。§3 末尾"线上形状按各条规则写"的几种形状仍然存在，但 v4 下都带码 | §3、§4.9、§4.10 |
| 消息 id | `prompt` / `steer` / `follow_up` 的 `args.cid`；事件 `remote_message.cid`、新事件 `remote_message_delivered{cid, at}`、`remote_message_failed.cid/code` | §4.11、§5.3 |
| 设备令牌 | viewer 新帧 `pair_create`、`device_revoke`；`room_list.devices[]` 加 `auth`、`paired`；local 通道新帧 `pair` / `pair_result` | §4.2、§4.12 |
| 健康检查 | `GET /healthz`（viewer 端口） | §3 |
| local 通道 | 全部帧（含 v3 就有但本文件没写的 `event`/`state`/`usage`/`sync`/`snapshot{mode:"append"}`/`room_registered`/`snapshot_request`/`command_result`/`room_label`/`room_closed`）见 DOC/71 §6 | §13 `LocalChannelMessage` |

### v3.1（设备 / 连接窗口 / 会话清单 · 2026-10-08）

合并协议增量（设备、连接窗口、会话清单）。增量文写的版本台阶是 v2.9→v3.0；本文件合并前的当前版本已是 **v3**，本次在文件现状上 +0.1，记为 **v3.1**。

加法式：只增字段和帧。旧扩展不带新字段时，房间归「未登记设备」；旧 UI 忽略不认识的字段。既有会话帧（`snapshot` / `room_event` / `command` / `ack` / `room_list` / `usage_state` 等）除下表「变更」行与正文注明处外，不改语义。`ack` 帧本身不变。

| 种类 | 条目 | 正文 |
|---|---|---|
| 新帧 | `device_register`（local→relay，连接窗口开始） | §4.12.1 |
| 新帧 | `device_detach`（local→relay，**本期预留，不实现**） | §4.12.2 |
| 变更 | `room_register` 增加 `accountId` / `deviceId` / `deviceName` / `platform`（`epoch` / `instance` 仍在） | §4.12.3 |
| 新帧 | `session_manifest`（local→relay，清单 upsert / 全量对账 / 墓碑） | §4.12.4 |
| 新帧 | `resend_snapshot`（relay→local）；在线且 RAM 无缓存时替代默认磁盘装配，`snapshot` 可带 `snapshotPending` | §4.5、§4.12.5 |
| 新帧 | `get_sessions`（viewer→relay）/ `session_list`（relay→viewer，未连接也可读） | §4.2.1 |
| 新帧 | `room_label`（local→relay）：会话改名只更新房间标题并广播名列表，不再整包 `room_register` | §4.12.3 |
| 变更 | `room_list` 增加 `devices[]`；`rooms[]` 增加 `accountId` / `deviceId`。广播节奏不变 | §4.2 |
| 变更 | `command` 可用 `deviceId` 代替 `room`；新命令 `harness_start`。不带 `deviceId` 时仍只按 `room` 路由 | §4.11 |
| 错误码 | `no_device` / `device_offline` / `device_no_active_session` / `session_not_found` / `cwd_not_allowed` / `spawn_failed` / `manifest_stale` | §3 |
| 状态机 | 设备三态；窗口内会话三态 | §4.12.6 |
| 参数 | `windowMaxHours`、`harnessStartTimeoutMs`、`sessionOnlineWatchMs`、`maxSessionsListed`、`maxManifestBatch`、`manifestThrottleMs`、`resendSnapshotWaitMs`、`retentionDays` | §11 |

### v3（数据链路：增量同步 / 受理回执 / 去重重发 / 载荷投影 · 2026-10-08）

新增字段全部可选：不带 `since`、`dedupeKey` 的旧前端仍按"全量快照 + 不去重"工作。

**1. 存储记录带序号（seq），房间带存储世代（rev）**
- relay 落盘的每条记录（`message_end` 的消息、`remote_message` 回显、扩展快照里的消息）有房间内单调递增的 `seq`。
- 房间有 `rev`：存储世代，房间存储被重置（换分支）时换新值，`seq` 从 0 重来；relay 重启不变（写在房间文件首行）。
- `snapshot` 帧带 `rev`、`seq`（存储当前最大 seq）；**会落盘的** `room_event`（`message_end`、`remote_message`）带 `seq`、`rev`，其余事件不带。

**2. 断线重连只收增量**
- `subscribe` 可带 `since:{rev, seq}`（上次看到的 rev 与最大 seq）。rev 一致且 seq 有效 → 回 `snapshot{delta:true, baseSeq, seq, rev, messages}`，`messages` 只含 `baseSeq` 之后的记录；否则（rev 变了、增量本身超安全阀）回全量。
- 前端对齐规则（`sync.ts` 已实现）：
  - 全量快照：整体重建，记下 `rev/seq`。
  - 增量快照：`rev` 不同 → 不带 since 重订阅全量；`baseSeq === 当前 seq` → 追加；`seq <= 当前 seq` → 忽略；否则按当前 since 重订阅。
  - 带 seq 的事件：`rev` 不同 → 重订阅全量；`seq <= 当前` → 重复，忽略；`seq === 当前+1` → 应用；跳号 → 按 since 重订阅补洞。
  - 不带 seq 的事件（流式 delta、状态类）直接应用。
  - 重订阅要限频（参考实现 1.5s 一次）。
- 增量快照也会在**已订阅期间**主动推来：扩展补传停机期间的尾部消息、`compact` 追加 `compactionSummary` 时，relay 给观众推 `delta:true` 的快照。

**3. relay 实例 id（boot）**：viewer 的 `auth_result` 带 `boot`（relay 进程启动时随机生成）。重连后 boot 变了 = relay 重启过，命令去重表已丢（见第 4 条）。

**4. 命令：受理回执 + 去重重发**
- relay 收到 `command` 先回 `{type:"command_accepted", id, room, timeoutMs}`。`timeoutMs` 是 relay 的权威超时，前端据此重设计时器，不再自己猜。
- 请求可带 `dedupeKey`（≤128 字符，同一逻辑请求重发时保持不变）。同房间同 key：在飞 → 合并到同一次执行（`command_accepted.dedup:true`）；已完成 → 直接回放结果（`ack.dedup:true`），**不会再执行一次**。去重表保留 10 分钟，只在内存里（relay 重启即丢）。
- 前端口径（`commands.ts`）：
  - 发出后 10s 没收到 `command_accepted` → 同连接、同 id、同 `dedupeKey` 重发一次。
  - 收到 `command_accepted` 后等 `timeoutMs + 5s`。
  - 断线期间命令挂起最多 20s。重连后 `boot` 不变就重发取回结果；boot 变了只重发只读命令（`get_*` / `list_*`），有副作用的命令报"结果未知"，让用户确认后再操作。
  - 有了 dedupeKey，`regenerate` / `compact` 的重发也安全。
- 被限速的帧只收到 `{type:"error", code:"rate_limited"}`（不带 id），命令就收不到受理回执，靠上面的受理超时重发恢复。

**5. 事件载荷投影（扩展侧，省流量）**：事件一个不少、顺序不变，只换掉 UI 不消费、体积随会话增长的字段：

| 事件 | 线上形态 |
|---|---|
| `message_update` | 剥掉 `partial`；同类型、同 `contentIndex` 的 `text_delta` / `thinking_delta` / `toolcall_delta` 在 25ms 窗口内拼成一帧（拼接结果与逐帧相加逐字相同） |
| `tool_execution_update` | 同一 `toolCallId` 120ms 内合并；`partialResult` 只留文本尾部 32K 字符（截过时 `truncatedHead:true`），权威全量看 `tool_execution_end` |
| `tool_result` | 只留 `toolCallId` / `toolName` / `isError`（结果见随后的 toolResult `message_end`） |
| `turn_end` | `message` / `toolResults` 保留；`context` 换成计数摘要 `{omitted:true, …}` |
| `agent_end` | `messages` 换成 `messageCount` |
| `agent_before_settle` | `context` 换成计数摘要 |
| `context` / `context_with_system` | 只留 `messageCount` |
| `before_agent_start` | `systemPrompt` 换成 `systemPromptChars`，`systemPromptOptions` 只留计数 |
| `provider_stream_event` | 默认**不转发**（本机 `PI_REMOTE_FORWARD_RAW=1` 才转） |
| system 消息的 `message_start/end` | 只留 `{role:"system", timestamp, chars, omitted:true}` |
| 其余事件 | 原样；单字段序列化超过 16KB 换成 `{omitted:true, kind, length?, chars}` |

要全量上下文走 `get_projection`，要系统提示词走 `get_system_prompt`。

**6. 图片占位**：任何位置的 `ImageContent` 只要 base64 超过 128KB（扩展和 relay 两侧都做），就换成 `{type:"image", mimeType, data:"", omitted:true, omittedBytes}`（`omittedBytes` 是原图字节数）。快照、事件、命令结果口径一致。UI 显示"图片过大未传输"占位，不要当成坏图。

**7. 背压**
- relay → viewer：发送缓冲超过 1MB 时只跳过可丢帧（`message_update` / `tool_execution_update` / `bash_execution_update` / `provider_stream_event`），快照、`message_end`、ack 照发；超过 64MB 判为挂死，断开连接。
- 扩展 → relay：本机发送缓冲超过 4MB 时同样只丢可丢帧。
- 被跳过的 delta 会由随后的 `message_end`（权威全量）补齐，前端不需要处理。

**8. 扩展 ↔ relay 对齐（与 UI 无关，排障用）**
- 扩展每次（重）连接都发 `room_register`，relay 回 `room_registered{rev, seq, msgCount, firstHash, lastHash, tailHashes}`。`tailHashes` 是热缓存里最近最多 8 条消息的 hash（旧→新）。
- 扩展用首尾 hash，再加上 `tailHashes` 整段核对，判断 relay 存的是不是本机分支的一段：是 → 只传尾部（`snapshot{mode:"append", base:{count, hash}}`）；不是 → 传全量。只看首尾会把同内容的 custom/摘要认成同一段。relay 发现锚点不符回 `snapshot_request` 要全量。
- relay 重启、断网、pi 重启后都只补停机期间的消息，`rev` 不变，观众的 since 续订照常有效。只有**同一扩展实例**的 epoch 变了（换分支）才重置存储（见 §4.11.6）。

**9. 命令口径变化**
- `get_messages {limit?}` 返回 `{messages, total, truncated, busy}`。
- `get_entries {since?, limit?}` 返回 `{entries, leafId, total, truncated}`。
- `get_tree` 默认返回轻量节点（`{id, parentId, type, timestamp, role?, customType?, preview?}`），`{full:true}` 才带完整条目。
- `list_sessions` 默认 30 条、上限 200。
- `bash`：命令超过 16000 字符直接拒绝（不截断执行）；回包 `output` 保留尾部 1MB，超出时 `truncated:true`；写进模型上下文的部分保留尾部 100KB。

**10. 以下旧说法作废**（正文已改）
- "重连后必收全量 snapshot"、"`buffer_replay`"（relay 已不再发送）
- "命令 16s 没有 ack 自动重发一次，`regenerate` / `compact` 不能重发"、"relay 侧 compact/regenerate 等 90s"（现为 120s，见 §4.11.1 超时表）
- "快照安全阀 8MB"（现为 10000 条 / 24MB）
- "`compact` 换代、重置存储"（现在只追加一条 `compactionSummary`）
- "事件 1:1 原样转发，不并不节流"（见第 5 条）
- "`bash` 的 `truncated` 恒为 false"、"`message.text` 上限 8000 字符"（没有单独上限，只受单帧 256KiB 限制）

### v2.3（会话操作零确认 · 2026-10-08）
- **`new_session` / `switch_session` / `fork` / `navigate_tree` 改为直接执行，废除本机确认（Ctrl+Alt+S）流程**：远程命令与终端命令完全等价
  - 返回值变更：会话操作现在返回 `{ok:true, kind, sessionFile}`，**不再有** `status:"pending_host"`；前端如有 pending_host 分支可保留兜底但不会触发
  - 命令超时后不自动重发（会话操作非幂等）这条仍然有效
  - 详见 §4.11.3

### v2.8（接口富化第一批：19 项新接口 + set_model 真修复 · 2026-10-08）
- **11 个新命令**（全部进程内 pi 接口直连，探针实证）：`get_all_tools`（工具注册表含 JSON Schema）、`get_provider_auth`（各 provider 认证状态，**不回密钥**）、`get_mcp_servers`（白名单投影）、`get_system_prompt`（当前系统提示词，32KB 截断）、`get_entry`（快照截断后按 id 补洞）、`get_labels`（书签）、`get_children`（会话树分页）、`get_scoped_models`、`get_flags`（仅扩展注册的 flag 有值）、`export_session`（官方 serializeConversation 导出纯文本，弥补 export_html 不可用）、`get_routing`（虚拟模型路由态）；另有 `delete_session`（路径监狱+禁删当前会话+**永久删除**）
- **6 个命令口径补全**：`get_state` 补 `mode/hasUI/projectTrusted/steeringMode/followUpMode/autoCompactionEnabled`；`compact` 回传官方 6 字段（成功时）；`new_session` 支持官方可选参数 `parentSession`；`list_sessions` 换用官方 `SessionManager.list`（messageCount 从近似变准确）+ `query/namedOnly/matched/source`；`get_available_models` 增加 `available`（认证可用）清单；`get_tree` 增加 `path`（root→leaf 活动路径）与节点 `onPath` 标记
- **3 个新事件**：`model_select`（pi 唯一没有 wire 事件的模型状态变化，钩子只读透传）、`session_tree`（本机分支跳转）、`session_compact_failed`。转发后 pi 事件共 **37 种 + 2 扩展级**
- **set_model 真修复（重要）**：`pi.setModel(provider, modelId)` 两参形式是 no-op、且 `setModel` 是**异步**的——旧实现因此从未真正切过模型。现按官方范式 `await pi.setModel(模型对象)`（先用 `modelRegistry.find` 解析对象）实现，E2E 用"返回 model 与请求一致"断言（本机仅 1 个认证可用模型，往返用例按探针结论跳过）
- **toolResult.details 契约明确为可选**：实测 39 个样本中 38 个为 undefined；bash 的 `details.truncation`（10 键）与 `fullOutputPath` 有样本但仅 1/33，read/write 的 details 全部缺失——前端禁止假设存在
- E2E 全量通过（含 set_model 真实往返与 model_select 钩子转发——用户新增 step-3.7-flash 后实测通过）

### v2.9（接口富化第二批：footer 最后缺口 + 模型投影 + 压缩前置事件 + 认证订阅态 · 2026-10-08）
- **2 个新命令**（全部进程内 pi 接口直连，源码级取证）：
  - `get_git_branch`：终端 footer `cwd (branch)` 的 branch 半边——**此前终端看得到、远端全盲的最后一个 footer 元素**。同源算法读 `.git/HEAD`（`ref: refs/heads/X`→X；短 SHA/detached→`detached:true`；无 repo→`branch:null`），不 spawn git；cwd 本级读不到时逐级上找（扩展增强，pi 只读本级）
  - `get_projection`：**模型实际所见**（`ctx.sessionManager.buildSessionProjection`）——compaction 边界、context_edit 应用后、分支相对口径下的 messages + entry↔message 映射。`get_entries` 是原始流水，本命令是"模型此刻看到的上下文"权威视图；大会话截尾 2000 条 + `truncated` 标记
- **1 个新事件** `session_before_compact`（压缩前置，自动/手动压缩都发）：`preparation.settings` = **生效的压缩阈值**（`{enabled, reserveTokens, keepRecentTokens}`——终端 /compact 面板同一份值，以前远端不可读），外加 firstKeptEntryId/isSplitTurn/tokensBefore/fileOps 计数。载荷经白名单裁剪（signal/branchEntries/messagesToSummarize 全丢）。转发后 pi 事件共 **38 种 + 2 扩展级**
- **`get_provider_auth` 增 `usingSubscription`**（`modelRegistry.isUsingSubscription`）：footer `(sub)` 订阅计费标记对账；引导用户区分"订阅配额 vs 付费"
- **toolResult.details 形状表源码级定稿**（§6.3）：替换 v2.8 的"0 样本未知"区——edit 的 diff/patch/firstChangedLine、read 的截断信息、grep/find/ls 的 limitReached 等全部有源码依据；`structuredContent`（bash 的 exit_code/wall_time_seconds）入契约
- **前端两个真 P0 修复**（详见 frontend-review.md v2.9 增补）：`compact` 16s 超时后自动重发=压缩执行两次（改 95s + 不再重发）；`draftRef` 未随 draft 同步→**远程发送整个失效**（只改 state 不改 ref，sendText 读空串静默返回）。均已浏览器实况验证
- E2E 全量通过（**72 项**：含 get_git_branch / get_projection / subscription 三个新用例）

### v2.7（终端 footer 数据接口化：实时用量/费用/缓存/上下文 · 2026-10-08）
- **新增 `usage_state` 下行帧**（§4.7.1）：pi TUI footer 展示的「上下文使用量 + 累计用量与费用」现在**实时推送**给 UI——每条 assistant 回复结束、压缩结束、回合 settle、会话绑定时各推一次（payload 没变则不推）；`subscribe` 时随快照补送当前值，UI 渲染状态栏**无需轮询**
  - 内容：`tokens{input,output,cacheRead,cacheWrite,total}`（缓存读写在内）、`cost`、`usageByKind`（按 kind 拆分非消息用量，如 `cache_warm` 缓存预热）、`costByModel`（按 `provider/model` 拆分费用，对应终端 `/session` 的展示）、`contextUsage`（官方 `ctx.getContextUsage()`）
- **`get_session_stats` 记账口径修正到与 pi 官方一致**（此前少计三项）：toolResult 等任何带 usage 的消息（工具嵌套调用的用量）、`compaction` / `branch_summary` 条目的 usage（生成摘要的消耗）、`usage` 条目（此前计入但无 kind 拆分）
- **`get_context_usage` 形状确认**：`{tokens, contextWindow, percent}`（`percent` 为 0~1 小数；压缩后短时间内 tokens/percent 可能为 null——官方语义）
- E2E 49 项全过（含 `usage_state` 实时推送、`get_session_stats` 用量明细）

### v2.6（bash 缺陷修复：输出进模型上下文 · 2026-10-08）
- **bash 输出现在会进模型上下文**（对齐官方 RPC bash 语义）：命令结果以 "Ran `<cmd>`" + 代码块形态作为自定义消息（`customType:"remote-bash"`）写入会话，**下一次 prompt 模型即可见**；`excludeFromContext:true` 时只执行、不写入
  - 实现走 pi 官方接口 `pi.sendMessage()`（自定义消息 = 入库 + 进上下文 + 不触发回合），没有自制注入
- **新增 `abort_bash` 命令**（从"本模式不支持"升级为支持）：AbortController 中断正在执行的远程 bash（探针实测 `pi.exec` 的 signal 生效、返回 `killed:true`）；返回 `{ok:true, aborted:n}`
- **默认 30s 超时**（`args.timeout` 可覆盖，硬顶 120s）：挂死的命令不再永远占着命令通道
- 如实保留的两点边界：`truncated` 恒 false（`pi.exec` 一次给全量输出，没有 RPC bash 的截断/落盘机制）；**无流式**（进程内 `pi.exec` 没有增量回调，官方 RPC 的 `bash_execution_update` 流式只在 RPC 模式出现）
- `bash` 参数新增 `timeout?` / `excludeFromContext?`；"本模式不支持"从 10 个减到 9 个
- E2E 51 项全过（含 bash 真实执行 / 输出入库 / excludeFromContext / abort_bash）

### v2.5（命令面对齐 pi 官方 RPC · 2026-10-08）
- **远端命令面与 pi 官方 RPC 命令面（docs/rpc-commands.md，33 个命令）对齐**：
  - **改名（旧名保留为别名，前端可平滑迁移）**：`get_models` → `get_available_models`；`get_thinking_levels` → `get_available_thinking_levels`
  - **新增 5 个官方命令**：`prompt` / `steer` / `follow_up`（官方发送通道，`deliverAs` 即官方 `streamingBehavior`）、`abort`（中断并等空闲）、`clone`（当前活动分支原样复制进新会话）
  - **返回形状对齐官方**：`get_state` 补 `isStreaming/isCompacting/messageCount/pendingMessageCount`；`set_model`/`get_available_models` 返回完整 Model 对象（+`modelId` 别名）；`bash` 返回 `{output, exitCode, cancelled, truncated}`；会话操作补 `cancelled:false`，`fork` 补 `text`；`get_entries` 支持 `since` 游标并返回 `leafId`；`get_commands` 补 `sourceInfo`
  - **10 个命令明确“本模式不支持”**：`cycle_model` / `cycle_thinking_level` / `set_steering_mode` / `set_follow_up_mode` / `set_auto_compaction` / `set_auto_retry` / `abort_retry` / `abort_bash` / `clear_queue` / `export_html`——pi 的这些能力只在 RPC server 侧，进程内扩展接口确实没有，**明确报错而不是半吊子实现**；前端收到此类 error 直接展示，不要重试
  - 另有 7 个扩展自有命令不变（pi 的 RPC 面没有、但扩展面有真实接口）：`get_settings` / `get_active_tools` / `set_active_tools` / `get_context_usage` / `regenerate` / `list_sessions` / `navigate_tree`
  - 详见 §4.11.2 全表；E2E 47 项全过（含 follow_up 真实入队、clone 真实生效）

### v2.4（事件全表 1:1 转发 · 官方接口优先 · 2026-10-08）
- **转发清单从自制白名单（23 条）换成 pi 官方事件全表（34 条）**：`before_agent_start`、`provider_stream_event`、`tool_call`、`tool_result`、`context`、`context_with_system`、`cache_warming_decision`、`mcp_servers_change` 等此前漏转发的事件现在**全部 1:1 透传**——契约是"本地终端出现什么，服务器就同时收到什么"，不筛、不并、不节流（唯一变换仍是剥 `message_update.assistantMessageEvent.partial`，与官方 JSON wire 一致）
  - 新增事件均为**只读观察**（扩展 handler 返回 undefined 直通，不影响本机任何行为——与 pi 官方示例 debug-provider.ts 同款用法）；UI 无需渲染，收到未知事件忽略即可
  - `user_bash` 现在也会出现在转发流里（同样是只读观察）；§15 第 2 条相应更新
- **`get_models` 改走官方接口**：`ctx.modelRegistry.getAll()` → `getAvailable()`（实测 modelRegistry 上没有 getAvailableModels），仅在全不可用时回退读 models.json
- **`get_thinking_levels` 优先用官方数据**：当前 model 对象自带的 `thinkingLevels`（含 xhigh/max 等模型相关级别）；字段缺失才回退基础枚举
- **`bash` 修复调用签名**：按官方 `pi.exec(file, args[], options)` 调用（早期把整条命令当 file 传，根本跑不起来）；返回统一为 `{result:{stdout, stderr, code}}`

### v2.2（第四轮收尾）
本次把前三轮审查发现的问题**全部修完**（含"修一半"的项），并修掉联调中新暴露的两个缺陷：
1. `subscribe` 自循环抽干限速令牌（客户端无条件重订阅 + relay 每次订阅都广播 room_list）
2. `regenerate` 固定 15s 超时把"执行成功"误判为失败

### v2.1（第三轮联调修复）
- `snapshot` 帧新增 `truncated` 标志：触及安全阀（10000 条 / 8MB 扫描上限）时对 UI 可见
- 会话操作改为**立即**返回 `pending_host`（不再等 12s、不再占用命令通道）；同类操作只允许一个待确认
- 新增 4.11.6：会话换代 `epoch` 语义（`compact` / `navigate_tree` / 换会话后 relay 重置存储，杜绝新旧分支并集）
- 补明确认：`summarization_retry_scheduled` / `summarization_retry_attempt_start` / `summarization_retry_finished` / `extension_error` / `entry_appended` 五类事件**会**转发（此前文档承诺但实现漏转，已修）
- close code 修正：单条超限是 **1009**（ws 库语义），4002 仅用于二进制帧
- 错误码新增 `no_room`（订阅不存在的房间）：UI 应清空房间并改订在线房间
- `message` / `command` 的 ack **不参与房间过滤**：会话换代后 ack 带的是旧房间 id，UI 必须按 id 匹配
- `message` 发送规范明确为 **16s + 自动重发一次**（与此前 `runCommand` 对齐）
- `regenerate` / `compact` 会真实让模型干活：relay 侧等待放宽到 **90s**（原 15s 会把"执行成功"误判成超时）
- relay 限速豁免改为**反向判定**：除 `message_update`/`tool_execution_update`/`bash_execution_update` 三类流式 delta 外一律不丢（原白名单会静默丢弃 `queue_update`/`session_info_changed`/`summarization_retry_*`/`extension_error` 等）
- 存储镜像判定升级为**历史线兼容**：`compact`（历史改写）、`navigate_tree` 到更早节点（分支变短）、切回旧会话都会 reset 后重新 seed，杜绝新旧并集；重连只合并新增尾部
- `subscribe` 重复订阅同一房间不再触发 `room_list` 广播（防客户端自循环）

本次改动较大。前端若按旧版开发过，以下 6 条是**行为差异**，其余向下兼容：

1. **命令接口扩到 25 个**（§4.11）：新增 5 个只读接口（`list_sessions` / `get_commands` / `get_fork_messages` / `get_tree` / `get_session_stats`）+ 4 个**真实会话操作**（`new_session` / `switch_session` / `fork` / `navigate_tree`）。旧的"引导式" `request_new_session` / `request_resume` / `request_fork` **已移除**，请改用新命令
2. **远程切换会话 = 房间更替**：三个换代操作执行后，本机会话换代——`room_list` 里旧房间 `room_offline`、同 `cwd` 出现新房间。**UI 要把"房间没了"当正常切换，不是掉线**（§4.2）
3. **房间 label 语义变化**：优先显示会话名（`/name` 设过名的），未命名会话才显示本机标签（如"我的电脑"）
4. **`get_state` 新增 `sessionName` / `entryCount` 字段**
5. **会话操作直接执行，无需本机确认**（v2.3 起）：远程发起后本机立即切会话/切分支，与终端敲 `/new`、`/resume`、`/fork` 完全等价；命令同步返回 `{ok:true, kind, sessionFile}`，**不再有** `status:"pending_host"`。切换是否成功**以新房间出现为准**，不要轮询命令状态
6. **命令 ack 可能丢包**：云端 VPS 偶发事件循环脉冲（实测约 1/80 概率整条命令丢失）。~~16s 未收到 ack 自动重发一次~~ v3 起改为按 `command_accepted` 判断受理、带 `dedupeKey` 重发（§4.11.1）

7. **注入口径补全**：远程消息注入**失败**时会推 `remote_message_failed` 事件（§5.3），UI 必须把对应气泡标记"发送失败"；`ack.ok=true` ≠ 注入成功，以事件为准
8. **`history` 分页请求已废弃**：relay 会返回明确错误；镜像语义是全量快照，**没有分页、没有"加载更多"**（§4.5）
9. **安全/防护增强**：`get_settings` 对所有敏感键（apiKey/token/secret/password/credential…）递归脱敏；`regenerate`/`compact` 在本机正忙时直接拒绝（不再 steer 追加偷偷烧模型调用）
## 1. 架构与三层载体

```
本机终端里的 pi ──(进程内扩展)──▶ relay:7001 ──▶ relay:7002 ──▶ Web/手机 UI
      │                             local 通道        viewer 通道
      │                             （只进本机扩展）  （UI 连这里）
      └── 本机终端照常显示一切；UI 是同一会话的"镜像窗口"
```

v3.1 起，local 通道上还有一条**连接窗口**（`pi-remote attach`），与 pi 扩展是两条连接。同 `deviceId` 的新 `device_register` 只顶替旧窗口，不顶替该设备的 pi 扩展连接（§4.12.1）。公共约束：local→relay 走 7001（`role=local` + localToken），viewer 帧走 7002（`role=viewer` + viewerToken）；本期账户恒 `admin`；`room.id === sessionId` 恒成立；时间戳为毫秒 epoch，清单 `updatedAt` 由本机生成，relay 只做单调比较。单帧上限仍是 viewer 256KiB、local 16MiB（§3、§11）。

UI 消费的信封都是 JSON 文本帧（见 §3）：

| 载体 | 含义 | 详见 |
|---|---|---|
| `room_event` | 一条**实时**会话事件（pi 发生什么就推什么；会落盘的事件带 `seq`/`rev`） | §5（38 种事件全集） |
| `snapshot` | `{room, busy, rev, seq, truncated, messages, delta?, baseSeq?}` | 权威历史。全量（无 `delta`）= 整体重建；`delta:true` = 只含 `baseSeq` 之后的记录，接在已有内容后面（§4.5）。`truncated:true` 表示触及服务器安全阀（单房 10000 条或 24MB），此时镜像不完整，UI 应显式提示 |
| `room_state` / `room_list` / `room_offline` | 房间元数据（忙闲、在线、房间增删） | §4 |
| `usage_state` | 终端 footer 实时数据（累计 tokens/费用/缓存/上下文/按 kind 与按模型拆分） | §4.7.1 |
| `command_accepted` / `ack` | 命令的受理回执（带权威超时）与返回值（切换模型、改思考级别、regenerate、读设置…见 §4.11） | §4.9 / §4.11 |
| `session_list` | `get_sessions` 的应答：某设备的会话清单（窗口未连接也可读；按 `id` 匹配，10s 超时） | §4.2.1 |

local→relay 的 `device_register`、`session_manifest`，relay→local 的 `resend_snapshot`，以及本期不实现的 `device_detach`，都不是上表里的 UI 信封，见 §4.12。

**渲染总原则**：事件流负责"动"（流式 delta、状态变化），快照负责"全"（历史重建）。
任何时刻 UI 只信两样东西：最后一次全量 `snapshot` 加上其后的增量快照（按 `baseSeq` 接续），再加上之后的 `room_event` 序列。带 `seq` 的事件按序号去重、发现跳号就带 `since` 重订阅补洞（规则见 §0 v3 第 2 条）。

---

## 2. 快速开始：连上之后发生什么

```jsonc
// ① UI → relay（连上后 10 秒内必须发，否则断开）
{"type":"auth","role":"viewer","token":"<viewerToken>"}

// ② relay → UI（鉴权成功，附带 relay 实例 id 与当前房间列表 = 本机已打开的 pi 会话）
{"type":"auth_result","ok":true,"boot":"dda1a120b0d0","rooms":[{"id":"01a115ef-...","label":"我的项目","cwd":"D:\\code","online":true,"busy":true,"viewers":2}]}

// ③ UI → relay（选定一个房间）。**只在房间变化或重连时订阅**：relay 的 subscribe 处理会广播 room_list，
//    无条件重订阅会形成 socket 速度的自循环，很快把该连接的限速令牌抽干、后续命令被丢。
//    relay 侧也已加固：重复订阅同一房间（观众数未变）不再广播 room_list。
{"type":"subscribe","room":"01a115ef-..."}
//    重连时带上次看到的 rev 与最大 seq，只收增量：
{"type":"subscribe","room":"01a115ef-...","since":{"rev":"9f3c2a1b7e40","seq":562}}

// ④ relay → UI（订阅确认 + 快照 + 当前用量）
{"type":"subscribed","room":"01a115ef-...","online":true,"busy":true}
{"type":"snapshot","room":"01a115ef-...","busy":true,"rev":"9f3c2a1b7e40","seq":562,"truncated":false,"messages":[ …全量消息… ]}
//    或（带 since 且 rev 一致时）增量：
{"type":"snapshot","room":"01a115ef-...","busy":false,"rev":"9f3c2a1b7e40","seq":564,"truncated":false,"delta":true,"baseSeq":562,"messages":[ …2 条… ]}
{"type":"usage_state","room":"01a115ef-...","usage":{…}}

// ⑤ 此后每条 pi 事件都是一条 room_event；会落盘的（message_end / remote_message）带 seq 与 rev
{"type":"room_event","room":"01a115ef-...","event":{"type":"message_update","usage":{…},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"你好，"}}}
{"type":"room_event","room":"01a115ef-...","seq":565,"rev":"9f3c2a1b7e40","event":{"type":"message_end","message":{…}}}

// ⑥ UI 发消息（官方 prompt 命令；忙时改发 steer）/ 中断：先收受理回执，再收 ack
{"type":"command","room":"01a115ef-...","id":"c1_k3f9","command":"prompt","args":{"message":"帮我看下这个 bug"},"dedupeKey":"c1_k3f9"}
   →  {"type":"command_accepted","id":"c1_k3f9","room":"…","timeoutMs":15000}
   →  {"type":"ack","id":"c1_k3f9","room":"…","ok":true,"data":{"disposition":"started"}}
{"type":"command","room":"01a115ef-...","id":"c2_k3f9","command":"abort","args":{},"dedupeKey":"c2_k3f9"}   →  同上
{"type":"ping"}                                                    →  {"type":"pong"}
{"type":"list_rooms"}                                              →  {"type":"room_list","rooms":[…]}
// v3.1：同一条 room_list 还带 devices[]，rooms 项带 accountId/deviceId（旧 UI 只读 rooms）
{"type":"get_sessions","id":"c9","deviceId":"<deviceId>"}          →  {"type":"session_list","id":"c9","deviceId":"<deviceId>","sessions":[…],"truncated":false}
//    旧的快捷帧仍可用（relay 直接 ack，不去重、不要重发）：
{"type":"message","room":"01a115ef-...","text":"…","id":"r1"}       →  {"type":"ack","id":"r1","room":"…","ok":true}
{"type":"abort","room":"01a115ef-...","id":"r2"}                    →  {"type":"ack","id":"r2","room":"…","ok":true}
```

（真实生效、直接执行，与终端等价，见 §4.11.3）

**远程可以直接操作会话**（切模型、改思考级别、改会话名、regenerate 重发、压缩上下文、读设置…）：走 `{type:"command"}` 命令通道，同步返回 `ack.data`，全集见 §4.11。

---

## 3. 传输层规则

| 项 | 规则 |
|---|---|
| 协议 | WebSocket，**仅 JSON 文本帧**。二进制帧会被关闭连接（code 4002） |
| 单条超限 | 由 ws 库直接断开，close code **1009**（Message Too Big）；**不是** 4002（4002 只用于二进制帧） |
| 路径 | 任意（relay 不校验 path） |
| 单条上限 | viewer 通道 256 KiB（262144 字节），超限断开（code 1009）；local 通道 16 MiB |
| 限速 | 每连接 20 msg/s（突发 60）。超速返回 `{"type":"error","code":"rate_limited"}`，不断开 |
| 限速 | viewer 与未认证连接 20 条/秒（突发 60）；被限速时回 `error{code:"rate_limited", id:<原请求id>}`，前端按 id 让对应查询/命令立刻失败，不用等超时 |
| 鉴权超时 | 连接后 10s 未发 `auth` → 断开（code 4001） |
| 心跳 | relay 每 30s 发 WS ping；UI 侧也应对长期空闲连接发 `{"type":"ping"}`（有 `pong` 回应） |
| 断线 | UI 自己指数退避重连（建议 1s→20s）；**重连后必须重新 auth + 重新 subscribe**。带 `since:{rev, seq}` 只收增量快照接在已有内容后面；不带或 rev 已变则收全量，按快照重建 |
| 压缩 | viewer 通道开启 permessage-deflate（≥1KB 的帧，level 1）；浏览器自动协商，无需处理 |
| 背压 | relay 对某个 viewer 的发送缓冲超过 1MB 时跳过可丢的流式帧（delta / 工具中间输出），关键帧照发；超过 64MB 断开该连接 |
| 多端 | 同一房间可多人同时看（上限 20）。任何人发消息，所有端都经同一事件流看到，**无需乐观回显**（Event 即真相；如需即时反馈可做本地回显，收到权威 `message_end` 后去掉） |

relay 错误信封：`{"type":"error","code":"…","message":"…"}`，code 取值：
`auth_timeout` / `binary_not_allowed` / `payload_too_large` / `rate_limited` / `bad_json` / `no_room` / `room_full` / `unknown_type` / `server_error`。
（`no_room`：订阅的房间不存在。UI 应清空当前房间并改订一个在线房间，否则输入条会永久禁用）

**v3.1 追加**（50 号标题是 `ack.error` / `error` 帧：下面这些码不是同一种信封。既有 code 的含义不变）。`manifest_stale` 只记日志，不面向用户，也不进上面的 `type:"error"` 列表。

| code | 触发 | 人读文案（建议） |
|---|---|---|
| `no_device` | `get_sessions` / 设备级命令指向从未登记的设备 | 这台设备从未连接过 |
| `device_offline` | 设备登记过但窗口没在跑 | 设备未连接：在电脑上执行 pi-remote attach |
| `device_no_active_session` | 设备级命令但该设备无活动会话 | 这台设备没有在跑的会话，先启用/新建一个 |
| `session_not_found` | `harness_start` 的 `sessionId` 不在该设备未删除清单中 | 这台设备上没有这个会话 |
| `cwd_not_allowed` | 目录不在该设备 `projects` 白名单 | 该目录不在这台设备的允许列表里 |
| `spawn_failed` | 本机启动 pi 失败 | 本机启动失败：<原因> |
| `manifest_stale` | manifest 的 `updatedAt` 更旧，被丢弃 | 仅日志，不面向用户 |

线上形状按各条规则写，不要互相改写成同一种：

- `get_sessions` 指向从未登记的设备：`error` 帧，`code` 为 `no_device`，不回 `session_list`。
- 设备级命令但没有活动会话：`ack{ok:false, error:"device_no_active_session"}`，建议文案是「这台设备没有在跑的会话，先用「启用/新建」打开一个」。
- 设备级白名单以外的命令：`ack{ok:false, error:"该命令必须指定房间"}`（这是文案，不是上表里的 code）。
- `harness_start` 在设备离线时的示例：`{ok:false, error:"设备未连接（在电脑上执行 pi-remote attach）", code:"device_offline"}`。

---

## 4. Relay 下行消息（UI 直接消费的 13 种信封）

### 4.1 `auth_result`
```jsonc
{"type":"auth_result","ok":true,"boot":"dda1a120b0d0","rooms":[RoomInfo]}
{"type":"auth_result","ok":false,"error":"token 不正确"}   // 随后连接关闭(4003)，UI 应清掉本地 token 让用户重输
```
- `boot`：relay 进程实例 id（每次启动随机）。与上次连接的值不同 = relay 重启过，命令去重表已丢失（§4.11.1）
`RoomInfo` = `{ id: string, label: string|null, cwd: string|null, online: boolean, busy: boolean, viewers: number }`
- `id`：pi 会话 ID（等同本机会话身份）
- `label`：会话显示名（本机 `/name` 设置过则为该名，否则一般是 null 或 cwd 末段）
- `online`：本机 pi 是否还连着；**false 时消息发不出去**（`ack.ok=false`）
- `busy`：模型是否正在输出

### 4.2 `room_list`（房间集合变化时推送，也可主动 `list_rooms` 拉取）
```jsonc
{"type":"room_list","rooms":[RoomInfo]}
```
**远程发起会话切换**（直接生效）
**房间 = 本机的一个 pi 会话**（不是"一台电脑"）：远程 `/resume`、`/new`、`/fork` 生效后，旧房间 `room_offline`、同 `cwd` 立刻出现新房间（`label` = 会话名，未命名则为"我的电脑"这类本机标签）。UI 侧建议按 `cwd` 分组展示，把该本机的所有房间归为一组，当前在线的那个高亮；旧房间可从列表收起（保留可回看：服务器持久化，重新上线时同 id 房间会自动恢复）。


**v3.1 完整形状**（上一行仍是 `rooms` 的简写；旧 UI 只读 `rooms`）：

```jsonc
{ "type": "room_list",
  "devices": [ { "id": "<deviceId>", "accountId": "admin", "name": "Windows",
                 "platform": "windows", "online": true,
                 "projects": ["D:\\pi-myself"], "lastAttachAt": 1791437613000, "windowExpiresAt": 1791437613000 } ],
  "rooms": [ { "id": "<sessionId>", "accountId": "admin", "deviceId": "<deviceId>",
               "label": "…", "cwd": "…", "online": true, "busy": false, "viewers": 1,
               "lastActivity": 1791437613000 } ] }
```

- `rooms[]` 原字段仍是 `RoomInfo`。新增 `accountId`、`deviceId`、`lastActivity`。`id` 仍是会话 id，且 **`room.id === sessionId`**。`label` / `cwd` / `online` / `busy` / `viewers` 的含义不变。`lastActivity` 是 relay 内存里的房间最近活动时间（同 `cwd` 同时有多个在线房间时，UI 据此挑最新的那个；旧 relay 不下发时为 0）。
- **监听地址**：local 通道（7001）默认只绑 `127.0.0.1`，`viewer` 通道（7002）默认绑全网卡；分别可用 `PI_REMOTE_LOCAL_HOST` / `PI_REMOTE_VIEWER_HOST` 覆盖（`relay/config.json` 的 `localHost` / `viewerHost` 同义）。要对公网开放 7001 时必须显式配置，部署取舍见 `deploy/README.md` §1.1。
- **离线房间也会出现在 `rooms[]`**：只要还没被淘汰（离线 6 小时内、或还有人在看），就带 `online:false` 下发，供"已结束 N"折叠和回看；即将淘汰的才不再下发。UI 要把"房间从列表消失"当成正常淘汰，不是掉线。
- `devices[]` 是名册全量（含当前没连上的设备）。这里的 `online` 表示**连接窗口在跑**，与房间的 `online` 不是同一个标志。未登记房间对应的设备条目固定为 `{id:"未登记设备", online:false}`。
- `devices[].latencyMs`（v4 追加字段，additive）：设备↔relay 的平滑延迟，整数毫秒。来自 relay 保活对设备窗口连接的 `ping`/`pong` RTT（EMA，新样本占 0.3，30s 一轮）。**只有在线且已经回过至少一次 pong 才是数字**；离线 / 刚连上还没样本时是 `null` —— UI 显示「—」，不要写成 `0ms`。`auth_result.devices` 与 `room_list.devices` 同源，字段一致；旧 relay 不带该字段，按「暂无」处理。
- 没有 `devices` 的 `room_list`（旧 relay）仍只按 `rooms` 用。
- 广播节奏不变：房间集合变化、设备上下线、观众数变化时推送。主动 `list_rooms` 拉到的也是这一帧。

### 4.2.1 `get_sessions` / `session_list`（viewer 查询，未连接也可读）

```jsonc
// 请求（viewer → relay）
{ "type": "get_sessions", "id": "c9", "deviceId": "<deviceId>" }
// 应答（id 原样回显；设备不存在 → error，code 为 no_device，不回本帧）
{ "type": "session_list", "id": "c9", "deviceId": "<deviceId>",
  "sessions": [ { "id": "<sessionId>", "name": "…", "cwd": "…",
                  "messageCount": 128, "sizeBytes": 86016,
                  "updatedAt": 2, "active": false,
                  "online": false, "deleted": false } ],
  "truncated": false }
```

- 这是新的应答模式：relay **直接应答**、带 `id`、**不走 local**。前端按 `id` 匹配，**10s** 超时。
- `online` = 该 session 当前是不是活动房间（`room.online`），只有窗口连着时才可能为 true。
- 墓碑行不回。排序为 `updatedAt` 倒序。超过 `maxSessionsListed`（默认 200，§11）时截断，并设 `truncated:true`。
- 返回行带 `deleted`（活着的行为 false）。已删除的 id 不出现在 `sessions` 里。
- 设备级 `command` 白名单里也有同名 `get_sessions`（§4.11.1）。50 号没有给出 `{type:"command", command:"get_sessions"}` 的 args 和应答，这里不补那套参数，也不规定它和本帧谁算查询入口。

### 4.3 `subscribed`
```jsonc
{"type":"subscribed","room":"…","online":true,"busy":false}
```

### 4.4 `buffer_replay`（已移除）
旧版本接口，relay 已不再发送。旧前端里处理它的分支可以删掉；万一收到，忽略即可。

### 4.5 `snapshot` ★ 会话快照（服务器存储供给）
```jsonc
// 全量
{"type":"snapshot","room":"…","busy":true,"rev":"9f3c2a1b7e40","seq":562,"truncated":false,"messages":[AgentMessage, …]}
// 增量（subscribe 带 since 且 rev 一致；或扩展补传尾部 / compact 追加摘要时主动推送）
{"type":"snapshot","room":"…","busy":false,"rev":"9f3c2a1b7e40","seq":564,"truncated":false,"delta":true,"baseSeq":562,"messages":[AgentMessage, AgentMessage]}
```
- `rev`：房间存储世代（存储被重置时换新；新房间、存储为空时为 `null`）。`seq`：存储当前最大记录序号
- `messages`：全量时是**该会话的完整消息列表**（old→new），增量时只有 `baseSeq` 之后的记录。字段全集见 §6。**不含 system 消息**（存储不落 system，UI 也不渲染）
- **完整镜像语义**：服务器持久化保存本机会话**当前分支**的全部消息（`/resume` 恢复的老会话，在 resume 时整条分支就会进存储）；**没有分页**。UI 若为了长会话性能只渲染末尾一段，那是展示层的事，数据是完整的。v3.1 起，RAM 无缓存时不再默认从磁盘补齐，见下面的 `resend_snapshot` 条
- 装配对 UI 透明。单房间超过 10000 条或 24MB 时只交付尾部并标 `truncated:true`（扩展单帧上限 12MB，超出时同样从头部丢最旧消息并标记）。内存里已有的热缓存仍直接用。**v3.1**：缓存为空时不再默认走磁盘补齐，见下一条。
- 特殊形态：远程消息在历史中合成为 `{role:"user", remote:true, content:[{type:"text",text}], timestamp}`——UI 渲染为带"远程"角标的 user 气泡（与实时 `remote_message` 规则一致，见 §5.3）；被随后同文本的 user 消息取代、或注入失败的回显，读时已过滤。pi 写进会话的文本若只是在原文后多了 `\n\n` 加若干行 `[Image ...]`（缩放/转码提示），也算同一条
- **本机离线时快照依然完整可用**（服务器持久化）；此后 `room_offline` 会告知无法发消息
- **v3.1 `resend_snapshot`**：`PI_REMOTE_PERSIST_TRANSCRIPTS` 默认停，磁盘装配不再作为默认。viewer 订阅一个 `online=true` 的房间，而 relay RAM 无该房快照缓存（`room.snap` 空或 TTL 过期）时，relay 给该房 local 发 `{type:"resend_snapshot"}`，扩展回一份现有 `snapshot`（广播给该房观众）。3s（`resendSnapshotWaitMs`）未回 → relay 仍回现有 `snapshot` 帧，`messages` 为空，并标 `snapshotPending:true`（前端显示「正在从本机拉取会话…」，收到后续 `snapshot` 后换掉）。不新增除此之外的快照字段；`rev` / `seq` / `busy` / `truncated` 仍按现有快照规则填。帧的触发与兜底见 §4.12.5。上一句的离线可读，只在服务器当时仍持有该房快照时成立。
- 语义：全量 = `清空 → 按序渲染 → 滚到底`；增量 = 按 §0 v3 第 2 条的规则接续（`baseSeq` 等于当前 seq 才追加，否则重订阅）。`busy` 是快照时刻状态，之后以事件为准

### 4.6 `room_event` ★ 实时事件流
```jsonc
{"type":"room_event","room":"…","event":SessionEvent}
{"type":"room_event","room":"…","seq":565,"rev":"9f3c2a1b7e40","event":{"type":"message_end",…}}   // 会落盘的事件
```
`event` 的类型全集见 §5。**这是 UI 动画的主要驱动源。**
- 只有被 relay 落盘的事件（`message_end` 的非 system 消息、`remote_message`）带 `seq` / `rev`；它们与快照里的记录同一序号空间，UI 据此去重、检测跳号（§0 v3 第 2 条）
- 流式帧（`message_update` 等）不带序号；背压时可能被跳过，随后的 `message_end` 是权威全量

### 4.7 `room_state`
```jsonc
{"type":"room_state","room":"…","busy":true}
```
仅在忙闲**翻转**时发。驱动：底部"正在输出"条、输入框 placeholder（运行中=将被 steer 追加）、发送按钮文案。

### 4.7.1 `usage_state`（终端 footer 实时数据）

```jsonc
{"type":"usage_state","room":"…","usage":{
  "tokens":{"input":892,"output":9,"cacheRead":1024,"cacheWrite":0,"total":1925},
  "cost":0.0021,
  "usageByKind":{"cache_warm":{"count":1,"tokens":{"input":0,"output":0,"cacheRead":50000,"cacheWrite":0,"total":50000},"cost":0.015}},
  "costByModel":{"stepfun/step-5-preview":0.0021},
  "contextUsage":{"tokens":977,"contextWindow":1024000,"percent":0.000954}
}}
```

pi 的 TUI footer 展示「当前目录、会话、模型、上下文使用量、累计用量与费用」；本帧是其中**用量部分**的服务器版实时数据（目录/会话/模型见 `get_state`）。

- **触发时机**：每条 assistant 回复结束（`message_end`）、压缩结束（`compaction_end`）、回合 settle（`agent_settled`）、会话绑定时各推一次；payload 与上次**完全相同则不再推**（不刷屏）
- **订阅即送**：viewer `subscribe` 时随 `snapshot` 之后补送当前值，无需额外拉取
- `tokens` 含缓存读写（`cacheRead`/`cacheWrite`）——缓存命中/写入量直接可见
- `usageByKind` 按 kind 拆分**非消息用量**（如 `cache_warm` 缓存预热；未知 kind 照常计入 totals，分组名原样呈现，UI 不应拒绝）
- `costByModel` 按 `provider/model` 拆分费用：虚拟模型路由到物理模型时，每个物理模型的花费单独可见（对应终端 `/session` 的展示）
- `contextUsage` = 官方 `ctx.getContextUsage()`（压缩阈值与 footer 用的同一份估计）；`percent` 是 0~1 小数；压缩后短时间内 `tokens/percent` 可能为 `null`（官方语义：要等压缩后第一次回复给出有效用量）
- 拉取等价接口：`get_session_stats`（同一份数据 + 消息计数）、`get_context_usage`（只要 `contextUsage`）

### 4.8 `room_offline`
```jsonc
{"type":"room_offline","room":"…"}
```
本机 pi 断开。UI 应：显示离线条、停止忙碌动画、保留最后画面（历史可看，消息发不出去）。
本机重连后不会收到 `room_online`——以 `room_list` 里 `online:true` 或下一次成功 `ack` 为准。

### 4.9 `ack`
```jsonc
{"type":"ack","id":"r7","ok":true}                       // message/abort 成功受理
{"type":"ack","id":"r7","ok":false,"error":"本机未连接，消息无法送达"}
// 命令调用（§4.11）成功时还带 data：
{"type":"ack","id":"c1","ok":true,"room":"01a1…","data":{"ok":true,"level":"high"}}
```
`id` 对应 UI 发请求时带的 `id`（可选）。对 `message` / `abort` 快捷帧，**`ack.ok=true` 只代表"已送达本机扩展"**，模型开始处理要看后续事件流；命令的 ack 是执行结果（§4.11.1）。
- `dedup:true`：命令按 `dedupeKey` 命中去重表，这是首次执行结果的回放，没有再执行一次
- v3.1：帧的字段与按 `id` 匹配的方式不变。`harness_start` 复用这套匹配和超时。50 号把设备离线的失败示例写成带 `code` 的对象：`{ok:false, error:"设备未连接（在电脑上执行 pi-remote attach）", code:"device_offline"}`。`get_sessions` 指向从未登记的设备时是 `error` 帧（`code:"no_device"`），不是这条 ack。

### 4.9.1 `command_accepted`（命令受理回执）
```jsonc
{"type":"command_accepted","id":"c1_k3f9","room":"01a1…","timeoutMs":15000}
{"type":"command_accepted","id":"c1_k3f9","room":"01a1…","timeoutMs":15000,"dedup":true}   // 合并到在飞的同 key 请求
```
relay 已转发给本机、开始计时。`timeoutMs` 是 relay 的权威超时，超时后 relay 代答失败 ack；前端收到后把自己的计时器重设为 `timeoutMs` + 余量。房间不存在或本机离线时不发本帧，直接回失败 ack。设备级失败 ack 的形状见 §3 与 §4.11.1。50 号没有改本帧的字段，也没有写设备级 `command_accepted` 是否仍带 `room`。

### 4.10 `error` / `pong`
见 §3。`pong` 对应 UI 的 `ping`。

### 4.11 命令接口（远程调用 pi 能力）★

UI 不只能"看"，还能**操作**本机会话：切模型、改思考级别、改会话名、重发上一条（regenerate）、压缩上下文、读设置/状态……全部走一条通用命令通道，由本机 pi 进程内的扩展真实执行。

#### 4.11.1 通道模型与信封

```text
viewer ──{type:"command",room,id,command,args,dedupeKey}──▶ relay ──{command_accepted}──▶ viewer
                                                            relay ──▶ 本机扩展执行 ──▶ {type:"command_result",…} ──▶ relay ──▶ {type:"ack",…} ──▶ viewer
```

```jsonc
// 请求（viewer → relay）
{"type":"command","room":"01a1…","id":"c1_k3f9","command":"get_state","args":{},"dedupeKey":"c1_k3f9"}
// 设备级（v3.1）：用 deviceId 代替 room。不带 deviceId 的 command 仍只按 room 路由，行为与上面完全相同。
{"type":"command","id":"c10","deviceId":"<deviceId>","command":"switch_session","args":{"sessionPath":"C:/.../<sessionId>.jsonl"}}
{"type":"command","id":"c11","deviceId":"<deviceId>","command":"harness_start","args":{"cwd":"D:\\pi-myself"}}
{"type":"command","id":"c12","deviceId":"<deviceId>","command":"harness_start","args":{"sessionId":"<sessionId>"}}
// 受理回执（relay 已转发，timeoutMs = 权威超时）
{"type":"command_accepted","id":"c1_k3f9","room":"01a1…","timeoutMs":15000}
// 成功 → ack（data 即命令返回值）
{"type":"ack","id":"c1_k3f9","ok":true,"room":"01a1…","data":{"sessionId":"…","model":{"provider":"stepfun","modelId":"step-5-preview"}}}
// 失败 → ack（error 为可读中文原因）
{"type":"ack","id":"c1_k3f9","ok":false,"room":"01a1…","error":"未知命令：xxx（可用命令见 readyUI/data-interface.md）"}
```

- **超时由 relay 决定**（`command_accepted.timeoutMs`），到点 relay 代答 `{"ok":false,"error":"本机执行超时（Ns）"}`。扩展在这个时间前 1.5s 先收尾，给出更具体的原因：

  | 命令 | relay 超时 |
  |---|---|
  | `compact` / `regenerate` | 120s |
  | `bash` | `args.timeout`（默认 30s，上限 120s）+ 15s |
  | 会话操作（`new_session` / `switch_session` / `fork` / `clone` / `navigate_tree` / `delete_session`） | 30s |
  | 慢读（`export_session` / `list_sessions` / `get_entries` / `get_projection` / `get_tree` / `get_session_stats`） | 30s |
  | `abort` | 20s |
| 设备级命令（带 `deviceId`；不含 `harness_start`） | 按命令名各自分档（会话操作 30s、慢读 30s、其余 15s；不再单设 16s 档）。前端口径：总等 35s（不小于 relay 分档，避免提前报"结果未知"诱发重复执行），不自动重发 |
  | `harness_start` | 10s（只等「已拉起」；会话上线由 `room_list` 驱动，前端另设 60s 观察窗） |
  | 其余 | 15s |

- **执行顺序**：只读命令和 `abort` / `abort_bash` 立即执行；其余命令在本机串行排队（排队时间也算在超时内）
- **重发与去重**：请求带 `dedupeKey`（同一逻辑请求重发时不变，可以直接用 id）。relay 按（房间，dedupeKey）在飞合并、完成后回放结果（`ack.dedup:true`），保留 10 分钟，所以按 `room` 路由的命令重发不会重复执行。推荐口径（`ui/src/relay/commands.ts`，房间级命令）：
  - 10s 没收到 `command_accepted` → 同连接、同 id、同 dedupeKey 重发一次
  - 收到 `command_accepted` 后等 `timeoutMs + 5s`
  - 断线挂起最多 20s；重连后 `auth_result.boot` 不变就重发取回结果，boot 变了（relay 重启，去重表已丢）只重发只读命令，其余报"结果未知"由用户确认
  - 不带 dedupeKey 的请求超时即作废，迟到的结果 relay 会丢弃
- **本机离线**：立即返回 `{"ok":false,"error":"本机未连接，无法执行"}`，不等待；执行中本机断开 → 立即返回 `本机连接已断开，命令结果未知`
- **设备级寻址（v3.1）**：请求带 `deviceId`、不带 `room`。路由到该设备**当前活动房间**的 local 连接。没有活动房间 → `ack{ok:false, error:"device_no_active_session"}`（文案：「这台设备没有在跑的会话，先用「启用/新建」打开一个」）。
  - 白名单只有：`switch_session` / `new_session` / `fork` / `clone` / `get_state` / `get_sessions` / `harness_start`。其余 → `ack{ok:false, error:"该命令必须指定房间"}`。
  - 前端对设备级命令**不自动重发**（与会话操作同档，见 40 号文档；本文不抄 40 号正文）。relay 对设备级命令按命令名分档（会话操作 30s、`get_state`/`get_sessions` 15s），`harness_start` 单列 10s；前端 `harness_start` 等 10s、其余设备级命令等 35s（见 §4.11.1 与 `ui/src/relay/devices.ts` 的 `DEVICE_COMMAND_TIMEOUT_MS`）。
  - 不带 `deviceId` 的 `command` 行为完全不变，仍按 `room` 路由，重发规则仍是上面的 `dedupeKey` 口径。
- `id` 由 UI 自产（建议 `c` + 自增 + 页面实例随机后缀，如 `c7_k3f9`）。relay 内部会改写为全局唯一 wireId 再转给本机，**多个页面/设备用相同 id 也不会互相撞**；ack 里的 `id` 仍是 UI 原值
- **`ack.ok=true` 对命令的含义与注入消息不同**：命令是执行完才回，`data` 就是最终结果
- 结果太大（超过扩展单帧上限 12MB）会改为失败 ack 并提示缩小范围（如 `get_entries` 的 `limit`）；超过 256KB 的结果不进去重表，重发会重新执行（只读命令才会这么大）

#### 4.11.2 命令全集（24 个 pi 官方 RPC 命令已对齐 + 21 个扩展自有命令 + 1 个窗口命令 `harness_start` + 2 个别名；另 9 个官方命令本模式明确不支持）

**A. pi 官方 RPC 命令（docs/rpc-commands.md；进程内有真实接口，逐个直连）**

| 命令 | args | `data` 返回 | 说明 |
|---|---|---|---|
| `prompt` | `{message, images?, streamingBehavior?}` | `{disposition:"started"\|"queued"}` | 官方发送通道：空闲直接开跑（`started`）；**忙时必须带** `streamingBehavior`（`steer`/`followUp`），否则报错。注入后同样推 `remote_message` 回显（§5.3） |
| `steer` | `{message, images?}` | `{disposition:"queued"}` | 插到当前回合工具调用之后、下次 LLM 调用之前 |
| `follow_up` | `{message, images?}` | `{disposition:"queued"}` | 等当前会话完全空闲后才投递 |
| `abort` | – | `{ok:true}` | 中断当前运行并等会话空闲（最多等 10s）。另有 relay 级快路径 `{type:"abort"}`（§4.9） |
| `abort_bash` | – | `{ok:true, aborted:n}` | 取消本机正在执行的远程 bash（signal 中断；`n`=取消数，官方只有 success） |
| `get_state` | – | `{sessionId, sessionName, entryCount, sessionFile, cwd, model, thinkingLevel, isIdle, busy, online, isStreaming, isCompacting, messageCount, pendingMessageCount, mode, hasUI, projectTrusted, steeringMode, followUpMode, autoCompactionEnabled}` | 会话全景。`mode`∈tui/rpc/print；`steeringMode/followUpMode` 默认 `"one-at-a-time"`、`autoCompactionEnabled` 默认 true（pi 未物化设置项时的文档默认值）；`model` 为完整 Model 对象或 null |
| `get_messages` | `{limit?}` | `{messages: AgentMessage[], total, truncated, busy}` | 当前分支消息（与 `snapshot` 同源，免订阅直取；字段见 §6）。`limit` 只取末尾 N 条；`total` 是分支总条数 |
| `get_entries` | `{since?, limit?}` | `{entries:[...], leafId, total, truncated}` | 原始会话条目（含非消息类/被放弃分支）。`since`=某 entry id 时只返回**其后**条目（官方游标语义）；id 不存在则报错。`limit` 只取末尾 N 条（大会话务必带，否则可能超单帧上限） |
| `get_available_models` | – | `{models:[Model], available:[Model]}` | `models` = 全部已配置（modelRegistry.getAll）；`available` = **认证可用**（getAvailable，[探针] 本机仅 1 个）。切换模型只用 available 里的——pi.setModel 对未认证模型返回 false |
| `set_model` | `{provider, modelId}` | `{ok:true, model: Model}` | 切换模型，立即生效；返回完整 Model 对象（同上） |
| `get_available_thinking_levels` | – | `{levels:[…]}` | 当前模型支持的思考级别（model 自带 `thinkingLevels`，可含 xhigh/max）；模型无推理支持时返回 `["off"]` |
| `set_thinking_level` | `{level}` | `{ok:true, level}` | 切换思考级别，立即生效 |
| `compact` | `{customInstructions?}`（兼容旧名 `instructions`） | `{ok:true, summary?, firstKeptEntryId?, tokensBefore?, estimatedTokensAfter?, usage?, details?}` | 手动压缩上下文。**忙时拒绝**。成功时透出 `ctx.compact()` 的官方 6 字段（rpc-commands.md §compact）；无可压缩内容时只有 `{ok:true}` |
| `bash` | `{command, cwd?, timeout?, excludeFromContext?}` | `{result:{output, exitCode, cancelled, truncated}}` | 远程 shell（本机 `pi.exec` 官方接口；Windows 走 `cmd /d /s /c`，其余 `bash -c`）。**默认关闭**（见 4.11.3）。命令超过 16000 字符直接拒绝。**输出默认进模型上下文**：以 "Ran `<cmd>`"+代码块形态写自定义消息（只留尾部 100KB），下次 prompt 模型可见；`excludeFromContext:true` 只执行不写。默认 30s 超时（`timeout` 可覆盖、硬顶 120s）。回包 `output` 保留尾部 1MB，超出时 `truncated:true`。**无流式**（`pi.exec` 无增量回调，官方流式 `bash_execution_update` 只在 RPC 模式有） |
| `get_session_stats` | – | `{sessionFile, sessionId, userMessages, assistantMessages, toolCalls, toolResults, totalMessages, tokens:{input,output,cacheRead,cacheWrite,total}, cost, usageByKind, costByModel, contextUsage?}` | 会话统计。**记账口径与 pi 官方一致**（session-format.md）：任何带 usage 的消息（assistant + toolResult 的工具嵌套用量）+ `usage` 条目（cache_warm 等，`usageByKind` 按 kind 拆分）+ `compaction`/`branch_summary` 条目用量；`costByModel` 按 `provider/model` 拆分费用 |
| `new_session` | `{parentSession?}` | `{ok:true, cancelled:false, kind, sessionFile}` | 真实新建会话（直接执行，与终端 `/new` 等价）；`parentSession` 为官方可选的父会话追踪路径 |
| `switch_session` | `{sessionPath 或 sessionId}` | `{ok:true, cancelled:false, kind, sessionFile}` | **真实切换会话**（= `/resume`）：`sessionPath` 用 `list_sessions` 的 `path` |
| `fork` | `{entryId?}` | `{ok:true, cancelled:false, kind, sessionFile, text?}` | **真实 fork**：从指定 user 消息（默认最后一条）分叉出新会话；`text` = 被分叉消息的文本（官方字段） |
| `clone` | – | `{ok:true, cancelled:false, kind, sessionFile}` | **真实 clone**（官方命令）：把当前活动分支原样复制进一个新会话 → 换房间，流程同 fork |
| `get_fork_messages` | – | `{messages:[{entryId, text}]}` | 可 fork 的 user 消息点 |
| `get_tree` | `{full?}` | `{tree:[{entry, children, label?, labelTimestamp?, onPath}], leafId, path}` | 会话条目树。默认 `entry` 是轻量节点 `{id, parentId, type, timestamp, role?, customType?, preview?}`（`preview` 为前 120 字）；`full:true` 才带完整条目（大会话可能很大）。`path` = root→leaf 的 entry id 链（活动分支），节点上同步打 `onPath` 标记——前端不必自己反推 |
| `get_last_assistant_text` | – | `{text:string}` | 最后一条 assistant 消息的纯文本（无则空串） |
| `set_session_name` | `{name}` | `{ok:true}` | 改当前会话名 |
| `get_commands` | – | `{commands:[{name, description, source, sourceInfo}]}` | 当前可用命令清单（扩展命令 / prompt 模板 / skill；`sourceInfo` 为官方元数据） |

**B. 扩展自有命令（pi 的 RPC 面没有、但扩展面有真实接口）**

| 命令 | args | `data` 返回 | 说明 |
|---|---|---|---|
| `get_settings` | – | `{settings:{…}}` | pi 设置；**所有敏感键（apiKey/authorization/token/secret/password/credential 等，递归匹配）值均已替换为 `***`**，可安全展示 |
| `settings_set` | `{settings:{…}}`（兼容 `patch` / 平铺） | `{ok:true, applied:{点号扁平键}, restartRequired:true, restartReason, reloadHint}` | **设置写桥（additive）**：只接受 14 个白名单键（steering/followUp/compaction×3/hideThinkingBlock/defaultProjectTrust/installTelemetry/skillCommands/images×2/defaultThinkingLevel/defaultModel+defaultProvider）；未知/非法/不成对一律 `bad_args` 且不碰原文件。原子写全局 `~/.pi/agent/settings.json`（0600，不写项目本地），不回路径/完整设置/密钥。**运行中 pi 不热更新**：`restartRequired:true`，`/reload` 只能带上一部分，重启是保证。详见 `DOC/76-settings-write-bridge.md` |
| `get_active_tools` | – | `{tools:string[]}` | 当前启用工具集 |
| `set_active_tools` | `{tools:string[]}` | `{ok:true, tools}` | 改启用工具集 |
| `get_context_usage` | – | 上下文用量对象或 `null` | token 占用等 |
| `regenerate` | `{fromIndex?}` | `{ok:true, resent, mode}` | **重发第 N 条（默认最后一条）user 消息让模型重新回答**。忙时直接拒绝（不再 steer 追加烧第二次模型调用） |
| `list_sessions` | `{limit?, query?, namedOnly?}` | `{sessions:[{id, path, name, firstMessage, created, modified, size, messageCount, truncated, current}], total, matched, sessionDir, source}` | 本机会话列表（`limit` 默认 30、上限 200）。默认走**官方** `SessionManager.list`（messageCount/firstMessage 准确，`source:"SessionManager.list"`）；官方 API 不可用时回退 fs 扫描。`query` 匹配 name/firstMessage/id，`namedOnly` 只看已命名；`truncated` 恒 false（官方清单） |
| `navigate_tree` | `{targetId}` | `{ok:true, cancelled:false, kind, sessionFile}` | 会话内树跳转（不换会话，之后推送新快照） |
| `get_all_tools` | – | `{tools:[{name, description, parameters, promptGuidelines[], exposure, sourceInfo}]}` | pi 工具注册表（`pi.getAllTools`，[探针] 本机 10 个）。`parameters` 为完整 JSON Schema（可渲染参数表单）；`exposure`=direct/callable/codemode 等 |
| `get_provider_auth` | – | `{providers:[{id, registered, models, displayName?, configured?, authSource?, status?, usingOAuth?, usingSubscription?}]}` | 各 provider 认证状态（`modelRegistry.getProviderAuthStatus` 为权威，[探针]：stepfun `{configured:true, source:"models_json_key"}`）。**只回状态，绝不含密钥**（apiKey/headers 类方法禁止触达） |
| `get_mcp_servers` | – | `{servers:[{keys, name?, transport?, exposure?, enabled?, connected?, status?, toolCount?, error?}]}` | MCP 服务器清单（`pi.getMcpServers`，[探针] 返回数组）。**白名单投影**：config 可能含 env/headers/command，绝不整包回传；`keys` = 实际字段名（元素细目 [待有 MCP 服务器时实测]） |
| `get_system_prompt` | – | `{prompt, chars, truncated, supported, options?}` | 当前生效系统提示词（`ctx.getSystemPrompt`，[探针] 事件 ctx 可用）。32KB 截断 + `truncated` 标记；`options` 仅当 ctx 提供 `getSystemPromptOptions` 时才出现（[探针] 事件 ctx 上通常没有） |
| `get_entry` | `{entryId}` | `{entry}` | 单条目全字段（`sm.getEntry`/`byId`）——快照触及 12MB 预算被截断后，前端按 id 补洞用；id 不存在返回 error |
| `get_labels` | – | `{labels:[{targetId, label, at}]}` | 书签清单（`sm.labelsById`/`labelTimestampsById`，[探针] 均为 Map） |
| `get_children` | `{parentId?}` | `{children, leafId, parentId}` | 会话树分页探索（`sm.getChildren`）。`parentId` 缺省 = 根层（具体语义以 pi 实现为准） |
| `get_scoped_models` | – | `{scoped, models:[Model]}` | 模型作用域（`ctx.scopedModels`，--models/`/scoped-models` 选中的集合）。`scoped:false` = 未设作用域（全部可用） |
| `get_flags` | `{names[]}` | `{flags:{name:value|null}}` | 读扩展注册的 CLI flag（`pi.getFlag(name)`）。[探针]：只有 `registerFlag` 注册的 flag 有值，未注册名（含 pi 内置 flag）一律 null |
| `export_session` | `{maxChars?}` | `{format:"text", chars, truncated, text}` | 导出会话纯文本（官方 `serializeConversation(convertToLlm(messages))`，[探针] 输出 "[User]: …\n\n[Assistant]: …" 形态）。**不落盘**、直接回传；默认 100KB、硬顶 500KB |
| `get_routing` | – | `{selected, lastDispatched, current}` | 虚拟模型路由态（从会话条目派生）：`selected`=最后 model_change 条目；`lastDispatched`=最后一条 assistant 消息实际路由到的物理模型；`current`=当前选择 |
| `delete_session` | `{sessionPath}` | `{ok:true, deleted}` | **永久删除**一个会话文件（路径监狱 + 禁删当前会话）。UI 必须二次确认——没有回收站 |
| `get_git_branch` | – | `{branch, repoRoot, detached}` | 当前目录所在 git 仓库的分支（终端 footer 同源）。`branch:null`=不在仓库内；`detached:true` 时 branch 是短 SHA
 | `get_projection` | – | `{supported, counts:{entries, messages}, entries:[{sourceEntry, messages[]}], messages:AgentMessage[], truncated?, kept?, leafId?}` | 模型实际所见（`buildSessionProjection`）：compaction 摘要边界、context_edit 应用后、分支相对口径。`supported:false` 时 `error` 说明原因。截尾策略同快照（保尾部 + `truncated:true`）

**C. 旧名别名（v2.5 起等价于官方名，前端迁移期可继续用）**

| 旧名 | = 官方名 |
|---|---|
| `get_models` | `get_available_models` |
| `get_thinking_levels` | `get_available_thinking_levels` |

**D. 本模式不支持（pi 的 RPC 面有、进程内扩展接口没有；返回 `{ok:false, error:"本模式不支持 xxx：<原因>"}`，前端直接展示、不要重试）**

| 命令 | 原因 |
|---|---|
| `cycle_model` / `cycle_thinking_level` | 循环逻辑在 `AgentSession`（RPC server 只是转发调用它），进程内扩展面没有 `cycleModel`/`cycleThinkingLevel`。**前端可自循环**：`get_available_models.available` + `set_model`、`get_available_thinking_levels` + `set_thinking_level` |
| `set_steering_mode` / `set_follow_up_mode` | 投递模式是 pi 设置项，扩展面只有只读 `getSettings` |
| `set_auto_compaction` / `set_auto_retry` | 开关是 pi 设置项，扩展面无 setter |
| `abort_retry` | 扩展面无中断重试的接口 |
| `clear_queue` | 扩展面无清空 steer/followUp 队列的接口（队列内容可从 `queue_update` 事件读） |
| `export_html` | 扩展面无 HTML 导出接口（RPC 模式专有） |

**E. 连接窗口命令（v3.1，走同一条 `command` 通道；用 `deviceId` 寻址）**

| 命令 | args | `data` 返回 | 说明 |
|---|---|---|---|
| `harness_start` | `{cwd}` 或 `{sessionId}`（二选一；都不带 → 参数错误） | `{ok:true, status:"started"}`；或 `{ok:true, status:"already_running", roomId}`。失败见 §3 | 窗口内远程启用/新建。`started` = 本机已拉起（会话未必上线）。`already_running` = 该 `cwd` 已有在线会话。relay 超时 10s。禁止自动重发。`cwd` 必须在该设备 `projects` 内，否则 `cwd_not_allowed`。`sessionId` 必须在该设备未删除清单中，否则 `session_not_found`。本机 spawn 失败 → `spawn_failed` 加可读原因。细则 §4.11.3 |

| （未知命令） | – | – | `{"ok":false,"error":"未知命令：xxx（可用命令见 readyUI/data-interface.md）"}` |

#### 4.11.3 必须知道的语义

- **`set_*` 会真实改变会话**，并触发对应 pi 事件（`thinking_level_changed` / `session_info_changed` 等，见 §5）——UI 从事件流即可看到变化，无需轮询回读
- **`regenerate` 会烧一次模型调用**：UI 应给出"重新生成中"状态，结束以 `agent_settled` / `get_state.isIdle` 为准；不要让用户连点
- **`bash` 默认关闭**：需在本机 `.env` 设 `PI_REMOTE_ALLOW_BASH=1` 并重启 pi 才可用；未启用时命令快速失败（`bash 接口未启用…`），不会执行任何命令
  - **输出默认进模型上下文**（官方 RPC bash 同款语义）：结果以 "Ran `<cmd>`"+代码块的自定义消息（`customType:"remote-bash"`）写入会话，**下一次 prompt 模型即可见**；`excludeFromContext:true` 则只执行、不写入
  - 默认 30s 超时（`args.timeout` 可覆盖，硬顶 120s）；超时/中断时 `cancelled:true`
  - **无流式输出**：进程内 `pi.exec` 没有增量回调，命令一次性返回全量（官方 RPC 的 `bash_execution_update` 流式只在 RPC 模式有）；UI 用"执行中"状态 + 最终结果展示
  - `abort_bash` 可取消正在执行的远程 bash → `{ok:true, aborted:n}`
- **会话操作（`new_session` / `switch_session` / `fork` / `navigate_tree`）：与终端完全等价，直接执行，无需本机确认**
  - 远程发一条命令，本机立刻切会话/切分支，和你在终端里敲 `/new`、`/resume`、`/fork` 效果一模一样。**没有排队、没有快捷键、没有 pending_host**
  - 命令直接返回真实结果：`{ok:true, kind:"new_session", sessionFile:"/path/xxx.jsonl"}`（`sessionFile` 是操作后**当前**的会话文件；`navigate_tree` 不变会话文件，只换活动分支）
  - 实现方式：扩展直接调用 `ctx.sessionManager` 上的 `newSession()` / `setSessionFile()` / `createBranchedSession(leafId)` / `branch(targetId)`。这些 API 在 WebSocket 回调这类**非 pi 生命周期**的上下文里调用不会死锁（pi 文档所说的 command-only 是指不能在 lifecycle handler 里调），实测运行时确实跟着切
  - **UI 确认切换成功的方式**：换会话 = 出新房间。`room_list` 里同 `cwd` 出现新房间（`online:true`），对其 `get_state` 的 `sessionFile` 即目标会话；旧房间随之 `room_offline`
  - `navigate_tree` 不换会话：成功后**同房间推送新 `snapshot`**（新分支内容），UI 照常按快照重建
  - 失败时命令返回 `{ok:false, error:"..."}`（例如"会话路径越界"、"找不到会话"），前端直接展示错误即可；旧房间不会被破坏
  - 本机侧 `/pi-remote` 命令保留，供终端手动用：`/pi-remote [new | switch <路径> | fork [entryId] | goto <entryId>]`，与远端走同一个函数

- **会让模型干活的命令**：`prompt` / `steer` / `follow_up` / `regenerate`（`follow_up`/`steer` 会真实入队并触发模型回合）。UI 应给"发送中/生成中"状态，结束以 `agent_settled` / `get_state.isIdle` 为准
- **`prompt` 的忙时语义与官方一致**：会话忙而未指定 `streamingBehavior` 时命令直接报错（不擅自默认 steer——官方 RPC 同样如此）；UI 的发送按钮在忙时应改发 `steer`（插队）或 `follow_up`（排队），与终端体验一致
- **`abort` = 停止当前回合**：返回 `{ok:true}` 即已发起中断并等到空闲（上限 10s）。UI 的"停止"按钮用它；`abort` 之后若队列里还有 steer/followUp 消息，pi 会继续处理它们（官方语义）
- **`clone` 与 `fork` 的差别**：`fork` 从某条 user 消息分叉（历史被截断到该点）；`clone` 把**当前活动分支原样**复制进新会话（位置不变）。两者都换房间（旧房间 `room_offline`）
- **用量/费用/上下文（终端 footer 数据）**：
  - 实时看 `usage_state` 帧（§4.7.1）：回复结束/压缩结束/回合 settle 后推送，UI 直接渲染状态栏，**无需轮询**
  - 主动拉取：`get_session_stats`（同一份数据 + 消息计数）/ `get_context_usage`（只要上下文）——与推送帧同一代码路径，数值必然一致
  - 缓存（cacheRead/cacheWrite）在 `tokens` 里；`usageByKind` 里 `cache_warm` 等非消息用量单独可见（缓存预热这类后台消耗不混进对话用量）
  - `contextUsage` 是压缩阈值的同一份估计：UI 可用来做"上下文将满"预警（接近 100% 时 pi 会自动压缩，会推 `compaction_*` 事件 + 新快照）
- **`get_all_tools` / `get_provider_auth` / `get_mcp_servers`**：三个"本机能力体检"接口——前端可做"工具管理/认证引导/MCP 状态"面板。provider 未认证时 `get_available_models.available` 里也不会有它的模型，UI 应引导用户去本机 `/login`
- **终端 footer 全景对齐**：`cwd` / 模型 / 思考级别 / ↑↓token / 费用 / 上下文% / 缓存读写 都已在 `usage_state` + `get_state` 里；branch 用 `get_git_branch` 补齐（唯一剩余缺口）。缓存命中率 CH% 可由前端按官方公式自算：最后一条 assistant 消息 `cacheRead/(input+cacheRead+cacheWrite)*100`（不需要新接口）
- **"模型此刻看到什么"** 用 `get_projection`：压缩改写/context_edit 后的真实上下文（含 entry↔message 映射）；排查"模型为什么这么回答"比 get_entries（原始流水）准确
- **命令超时（前端口径）**：不再按命令分档猜，以 `command_accepted.timeoutMs` 为准（`compact`/`regenerate` 为 120s，`harness_start` 为 10s，表见 §4.11.1）。房间级命令重发带同一个 `dedupeKey`，relay 保证只执行一次。以 `deviceId` 寻址的设备级命令**不自动重发**（§4.11.1）
- **`harness_start`（v3.1，窗口内远程启用/新建）**：
  - `args` 是 `{cwd}` 与 `{sessionId}` 二选一。都不带 → 参数错误。
  - 成功：`{ok:true, status:"started"}`（本机已拉起，会话未必已经上线），或 `{ok:true, status:"already_running", roomId}`（该 cwd 已有在线会话）。
  - 设备登记过但窗口没在跑：`{ok:false, error:"设备未连接（在电脑上执行 pi-remote attach）", code:"device_offline"}`。
  - relay 只等「已拉起」应答，超时 **10s**（`harnessStartTimeoutMs`）。会话上线由 `room_list` 驱动，前端另设 **60s** 观察窗（`sessionOnlineWatchMs`）。
  - **禁止自动重发**。幂等靠 attach 串行，加上 `already_running` 判定。
  - `cwd` 必须落在该设备 `projects` 内，否则 `cwd_not_allowed`。`sessionId` 必须存在于该设备清单且未删除，否则 `session_not_found`。本机 spawn 失败 → `spawn_failed`，并带可读原因（建议文案「本机启动失败：<原因>」）。
  - 上线对上号：`started` 之后，`sessionId` 这一种等 `room.id === sessionId` 的房间出现；`cwd` 这一种等该 `deviceId` + `cwd` 的最新新房间。
- **压缩阈值可读**：`session_before_compact.preparation.settings` = 生效的 `{enabled, reserveTokens, keepRecentTokens}`（与终端 /compact 面板同源）；`get_state.autoCompactionEnabled` 只有总开关
- **`delete_session` 是破坏性操作**：路径监狱（只准删 sessionDir 内的 .jsonl）+ 禁删当前会话；**永久删除无回收站**，UI 必须二次确认
- **`set_model` 只切 `available` 里的模型**：pi 对未认证 provider 的模型返回 false（它自己的 `/model` 选择器同样不列）
- **3 个新事件**（`model_select`/`session_tree`/`session_compact_failed`）：pi 对模型切换/分支跳转没有 wire 事件，这仨是 extensions.md 的通知型钩子只读透传；`model_select` 载荷**已探针实证**（`{type, model:完整Model, previousModel:完整Model, source}`，程序化切换 source="set"，E2E 用 step-3.7-flash 真实往返验证通过）；`session_tree`/`session_compact_failed` 载荷仍为文档口径
- **所有命令都在本机进程内执行**（`prompt`/`steer`/`follow_up`/`regenerate` 会经模型；其余只读写会话状态）
- 与注入口径的关系：远程发消息走 `{type:"message"}` + ack（§2/§4.9），命令走本节；两者 `id` 空间独立

#### 4.11.4 TypeScript（可拷进 readyUI）

```ts
export interface CommandRequest {
  type: "command";
  room?: string; // 不带 deviceId 时必填；此时行为与 v3 相同
  deviceId?: string; // v3.1 设备级示例只带 deviceId、不带 room。两者同时出现时增量文没有定义
  id?: string; // 建议 "c"+自增+随机后缀，用于把 ack 对回请求
  command: string;
  args?: Record<string, any>;
  dedupeKey?: string; // ≤128 字符；重发时保持不变 → relay 只执行一次
}
export interface CommandAccepted {
  type: "command_accepted";
  id?: string;
  room: string; // v3 按 room 路由时有这个字段。设备级是否仍带 room，50 号没写
  timeoutMs: number; // relay 权威超时
  dedup?: true; // 合并到在飞的同 key 请求
}
export interface CommandAck {
  type: "ack";
  id?: string;
  ok: boolean;
  room?: string;
  data?: any; // ok=true 时：命令返回值（见 4.11.2 表）
  error?: string; // ok=false 时：可读原因
  code?: string; // 50 号的 device_offline 示例里有这个字段；不是每种失败都有
  dedup?: true; // 去重表回放的结果
}
/** 超时 / 本机离线 / 执行中断开均以 ok=false + error 呈现；重发规则见 4.11.1，完整实现见 ui/src/relay/commands.ts */

/** 命令名联合类型（与 4.11.2 表一一对应） */
export type RemoteCommand =
  // —— pi 官方 RPC 命令（docs/rpc-commands.md；进程内有接口）——
  | "prompt" | "steer" | "follow_up" | "abort"
  | "get_state" | "get_messages" | "get_entries"
  | "get_available_models" | "set_model"
  | "get_available_thinking_levels" | "set_thinking_level"
  | "compact" | "bash" | "abort_bash" | "get_session_stats"
  | "new_session" | "switch_session" | "fork" | "clone"
  | "get_fork_messages" | "get_tree" | "get_last_assistant_text"
  | "set_session_name" | "get_commands"
  // —— 扩展自有命令（pi 的 RPC 面没有，扩展面有真实接口）——
  | "get_settings" | "get_active_tools" | "set_active_tools" | "get_context_usage"
  | "get_all_tools" | "get_provider_auth" | "get_mcp_servers" | "get_system_prompt"
  | "get_entry" | "get_labels" | "get_children" | "get_scoped_models" | "get_flags"
  | "export_session" | "get_routing" | "delete_session"
  | "harness_start" // v3.1 连接窗口；用 deviceId 寻址，禁止自动重发
  | "regenerate" | "list_sessions" | "navigate_tree"
  // —— 旧名别名（v2.5 起等价官方名）——
  | "get_models" | "get_thinking_levels"
  // —— pi RPC 有但本模式不支持（明确报错，勿重试）——
  | "cycle_model" | "cycle_thinking_level" | "set_steering_mode" | "set_follow_up_mode"
  | "set_auto_compaction" | "set_auto_retry" | "abort_retry"
  | "clear_queue" | "export_html";
export function sendCommand(ws: WebSocket, room: string, command: string, args?: Record<string, any>, id?: string, deviceId?: string) {
  const reqId = id ?? "c" + Math.random().toString(36).slice(2, 8);
  const req: CommandRequest = { type: "command", id: reqId, command, args: args ?? {}, dedupeKey: reqId };
  // 带 deviceId：设备级，不带 room，且不要自动重发。不带 deviceId：仍只填 room（与 v3 相同）。
  if (deviceId) req.deviceId = deviceId;
  else req.room = room;
  ws.send(JSON.stringify(req));
  return req.id!;
}
```

#### 4.11.5 前端集成清单（典型流程）

**A. 切换模型**（无本机确认，同步返回）

1. `get_models` → 渲染选择器（`provider` + `modelId`）
2. `set_model {provider, modelId}` → `{ok:true, model}`；之后新回合即用新模型。UI 可再 `get_state` 确认，或从事件流的 `session_info_changed` 感知

**B. 远程 resume（= `/resume`）**

1. `list_sessions` → 渲染会话选择器（`name` / `firstMessage` / `modified`；`current` 标出当前会话，`truncated` 的计数为近似值）
2. `switch_session {sessionPath}`（也接受 `sessionId`）→ `{ok:true, cancelled:false, kind, sessionFile}`（**直接生效，无确认步骤**）
3. UI 收到 `room_list`：同 `cwd` 新房间 online → 自动 `subscribe` 新房间 → 收全量 `snapshot` 即完成；旧房间 `room_offline`

**C. Fork 新分支**

1. `get_fork_messages` → 选一个 user 消息（`entryId`）
2. `fork {entryId}`（省略 = 最后一条）→ 同 B 的房间更替流程（直接生效）

**D. 重新生成上一回答**

1. `regenerate`（可带 `fromIndex`）→ 模型真实重跑（**会消耗 token**），UI 进入"生成中"态
2. 直到 `agent_settled`（或 `get_state.isIdle === true`）结束
3. 丢包重发必须带同一个 `dedupeKey`（relay 只执行一次）；**不要换新 key 自动重试**，否则模型会再跑一次。`ack` 报超时或"结果未知"时提示用户确认后手动重试

**E. 在指定设备上启用或新建（`harness_start`）**

1. 设备窗口未连接：操作禁用；清单仍可用 `get_sessions` 看（§4.2.1）。窗口已连接才发命令。
2. 新建：`harness_start {cwd}`，`cwd` 必须在该设备 `projects` 里。启用已有会话：`harness_start {sessionId}`。
3. 10s 内等 ack。`started` 之后用 `room_list` 观察最多 60s：`sessionId` 形态等 `room.id === sessionId`；`cwd` 形态等该 `deviceId` + `cwd` 的最新新房间。`already_running` 则直接用返回的 `roomId`。
4. **不要自动重发**。失败 ack 按 §3 的 code / 文案展示。

---

#### 4.11.6 会话换代与 epoch（relay 侧存储重置）

扩展在 `room_register` 的 `room` 对象里带 `epoch`（分支世代）和 `instance`（扩展实例的随机 id）。
v3.1 起同一 `room` 对象还可带 `accountId`、`deviceId`、`deviceName`、`platform`（缺省与「未登记设备」见 §4.12.3）。`epoch` / `instance` 的换代规则不变。

- **换分支**（远程 `navigate_tree`、本机 `/tree`）：房间 id 不变，扩展 `epoch+1` 并重新注册。relay 收到**同一 instance 的 epoch 变化**会 `store.reset(room)`（`rev` 换新、`seq` 归零），随后扩展推全量重新播种，观众收到一个新 `rev` 的全量快照。
- **换会话**（`new_session` / `switch_session` / `fork` / `clone`）：换房间 id，新房间独立存储，旧房间 `room_offline`。
- **压缩**（`compact`、阈值/溢出自动压缩）：pi 只在分支末尾追加一条 compaction 条目，**不换代**。扩展把 `compactionSummary` 追加进存储，观众收到增量快照（`delta:true`）。
- **pi 重启 / 扩展重载**：instance 变了，epoch 从 1 重来，但这不代表换分支。relay 不清库，扩展按 `room_registered` 的首尾 hash 只补尾部；对不上才推全量。

这样保证"镜像 = 当前分支"：换分支后旧分支的消息不会残留在存储里形成"新旧并集"。
**对 UI 的影响**：收到 `rev` 变化的全量快照就整体重建；之前缓存的 `since` 作废（rev 不同，relay 会回全量）。


### 4.12 设备、连接窗口与会话清单（v3.1）

本节是 local 通道上的新帧、清单落盘、快照重推、两套状态机，以及新旧实现怎么搭配。UI 直接读的 `room_list` / `session_list` 在 §4.2 / §4.2.1；设备级 `command` 与 `harness_start` 在 §4.11；错误码在 §3；默认参数在 §11。

#### 4.12.0 公共规则

1. **加法式**：只增字段/帧。旧扩展不带新字段 → 房间归「未登记设备」。旧 UI 忽略新字段。
2. **`room.id === sessionId`** 恒成立。启用结果关联、去重、索引行都以它对齐。
3. 所有 local→relay 帧走 7001（`role=local` + localToken）。所有 viewer 帧走 7002（`role=viewer` + viewerToken）。本期账户恒 `admin`。
4. 时间戳统一毫秒 epoch。`updatedAt` 由**本机**生成，relay 只做单调比较。
5. 单帧上限仍是 viewer ≤256KiB、local ≤16MiB（§3、§11）。清单条数按 `maxManifestBatch` / `maxSessionsListed` 截断（默认都是 200，§11）。

#### 4.12.1 `device_register`（连接命令，窗口开始）

local→relay。

```jsonc
{ "type": "device_register", "accountId": "admin",
  "device": { "id": "<deviceId>", "name": "Windows", "platform": "windows",
              "projects": ["D:\\pi-myself", "D:\\work\\app"],
              "windowExpiresAt": 1791437613000 } }
```

| 字段 | 规则 |
|---|---|
| `accountId` | 本期固定 `admin` |
| `device.id` | 本机 `.env` 的 `PI_REMOTE_DEVICE_ID`（uuid，重装才换） |
| `name` / `platform` | 展示名（≤64 字符，relay 截断）/ `windows` · `macos` · `linux`（relay 把 `win32`、`darwin` 归一成前两者；路径大小写规则按平台：windows、macos 不分，linux 区分） |
| `projects` | 允许新建/启用会话的目录白名单。线上是字符串数组；来源是 `.env` 里以 `;` 分隔的目录 |
| `windowExpiresAt` | 本地 `--max-hours`（默认见 `windowMaxHours`）换算的到期时刻。**信息字段**，relay 不据此踢人（真离线以连接断开为准） |

**顶替规则**：同 `deviceId` 的新 `device_register` 顶掉旧窗口连接（旧 ws 关闭、广播 `room_offline` 不动它的房间）。不得顶替该设备的 pi 扩展连接。

**名册持久化**：每次 register upsert 一行进 `data/accounts/<accountId>/devices.jsonl`。窗口断开只改内存 `online=false`，**不删文件行**。`room_list.devices[].online` 反映的是这块内存，不是把文件行删掉。

`devices.jsonl` 行：

```jsonc
{ "kind": "device", "id": "<deviceId>", "name": "Windows", "platform": "windows",
  "projects": ["D:\\pi-myself"], "lastAttachAt": 1791437613000, "updatedAt": 1791437613000 }
```

`accounts/index.jsonl`：`{ "kind": "account", "id": "admin", "firstSeenAt": 1, "lastSeenAt": 2 }`。

#### 4.12.2 `device_detach`（本期预留，不实现）

local→relay。用途是显式断开连接窗口。

本期**不实现**：不发送、不处理、不定义载荷、不定义成功响应，也不由此产生新的状态迁移。这里只预留帧名和方向，避免以后另作他用。窗口结束仍以连接断开为准（内存 `online=false`，名册行保留，见 §4.12.1）。

#### 4.12.3 `room_register` 增加字段（窗口内）

既有 `epoch` / `instance` 以及 §4.11.6 的换代规则不变。新增：

```jsonc
{ "type": "room_register", "room": {
  "id": "<sessionId>", "label": "<会话名>", "cwd": "<项目目录>",
  "accountId": "admin", "deviceId": "<deviceId>",
  "deviceName": "Windows", "platform": "windows" } }
```

- 缺省/旧扩展：`accountId` / `deviceId` 缺失 → 服务端填 `"未登记设备"`（展示用假设备），不报错。
- `accountId` 缺省填 `admin`（本期固定值）；`deviceId` 缺失才归「未登记」。
- 未登记房间在 `room_list.devices` 里的条目固定为 `{id:"未登记设备", online:false}`（§4.2）。

#### 4.12.4 `session_manifest`（扩展 → relay，仅窗口内）

```jsonc
{ "type": "session_manifest", "accountId": "admin", "deviceId": "<deviceId>",
  "full": true, "updatedAt": 1791437613000,
  "sessions": [ { "id": "<sessionId>", "path": "C:/.../<sessionId>.jsonl",
                  "name": "重构 relay 存储", "cwd": "D:\\pi-myself",
                  "firstMessage": "我们来重构…", "messageCount": 128,
                  "sizeBytes": 86016, "createdAt": 1, "updatedAt": 2,
                  "active": true } ],
  "removed": ["<已删除的 sessionId>"] }
```

| 规则 | 说明 |
|---|---|
| `full` | `true` = 该设备会话集合的**权威全量**（relay 用它重算：清单里的 upsert、缺失的清 `active`、`removed` 写墓碑）；`false` = 增量 |
| 增量 | 只带变化的行（活动切换 / 改名 / 回合结束节流 / 删除墓碑）。回合结束推送的节流间隔是 `manifestThrottleMs`（默认 60000，§11） |
| `active` | 本机当前活动会话为 true，其余 false（全量时旧活动置假） |
| `updatedAt` 单调 | 每条带本机时钟；relay 丢弃**更旧**的 upsert（防旧重连帧覆盖新状态）。丢弃只记日志（`manifest_stale`，不面向用户） |
| 截断 | `sessions` 超过 `maxManifestBatch`（默认 200，按本机 `updatedAt` 倒序）时截断，并在顶层设 `truncated:true`。全量帧因此可能分多帧（`full` 帧带 `part:i/n`）。本期可简化为先推最近的 200，不强制分片 |
| 删除 | `removed[]` 的 id 写墓碑行（`deleted:true`），不物理删行 |

**持久化**：`data/accounts/<accountId>/sessions/<deviceId>.jsonl`，一行一会话 upsert（后行覆盖前行），墓碑行保留。

落盘行：

```jsonc
{ "kind": "session", "id": "<sessionId>", "path": "…", "name": "…", "cwd": "…",
  "firstMessage": "…", "messageCount": 128, "sizeBytes": 86016,
  "createdAt": 1, "updatedAt": 2, "active": false, "deleted": false }
```

viewer 读取走 `get_sessions` / `session_list`（§4.2.1），不直接读这个文件。

#### 4.12.5 `resend_snapshot`（relay → local）

- 触发：viewer 订阅一个 `online=true` 的房间，而 relay RAM 无该房快照缓存（`room.snap` 空 / TTL 过期）。
- 行为：relay 给该房 local 发 `{type:"resend_snapshot"}`；扩展回一份 `snapshot`（现有帧，广播给该房观众）。增量文给出的形状只有 `type`。
- 兜底：3s 未回（`resendSnapshotWaitMs`）→ relay 以空 `messages` 的 `snapshot` 应答，并标 `snapshotPending:true`。前端显示「正在从本机拉取会话…」，收到后续 `snapshot` 后换掉。`snapshot` 的其余语义（`rev` / `seq` / `delta` / 安全阀）不变。
- 本期 `PI_REMOTE_PERSIST_TRANSCRIPTS` 默认停：**磁盘装配路径不再作为默认**，此帧是替代。UI 侧见 §4.5。

#### 4.12.6 状态机

**设备（三态）**

```
未连接 ──attach──▶ 已连接（窗口） ──退出/到期/断线──▶ 未连接
   │                    │
   │                    └─ 活动会话上线（room.online）→ 网页可镜像/发消息/发命令
   └─ 名册在（索引）：可看上次清单，全部操作禁用
```

**会话（三态，窗口内）**

```
仅清单 ──harness_start{sessionId}──▶ 活动（room.id===sessionId）───pi 退出──▶ 仅清单
   │                                        │
   └─ 未连接设备：停留在仅清单                 └─ 订阅/镜像/发消息/发命令（现状）
新建：harness_start{cwd} ──▶ 新 sessionId 房间上线（deviceId+cwd 关联）
```

已订阅房间里的忙闲、队列、离线提示仍以 §10 为准，不由这两套状态机替换。

#### 4.12.7 兼容矩阵

| 组合 | 行为 |
|---|---|
| 旧扩展 + 新 relay | 房间归「未登记设备」；无 manifest；`harness_start` 不可用（无窗口） |
| 新扩展 + 旧 relay | 新帧被 `unknown_type` 拒绝（扩展记日志、功能降级为现状）；**不支持长期共存** |
| 旧 UI + 新 relay | 只读 `rooms`；设备面板不可见（其余照常） |
| 新 UI + 旧 relay | 设备/清单请求报 `unknown_type` / 无应答 → 前端按降级展示（仅房间列表） |

## 5. 会话事件流全集（`room_event.event`：24 种 pi 规范 wire 事件 + 14 种扩展钩子 + 2 种扩展级事件）

> 事件集合与 pi 官方 JSON/RPC 事件流一致（已与出厂代码逐一核对存在），**一个不少、顺序不变**；载荷按 §0 v3 第 5 条做了投影（体积随会话增长、UI 不消费的字段换成计数摘要，`provider_stream_event` 默认不转）。
> 除特别说明，所有事件都是"通知"性质。通用字段不再每节重复。
> **wire 瘦身约定**：`message_update` 在线只有 `{type, usage, assistantMessageEvent}` 三个字段——SDK 自带的累积 `message` 快照和 `assistantMessageEvent.partial` 均在转发时剥掉（与官方 JSON 流定义一致，stream size 保持线性）。任何拿到带 `message` 字段的 `message_update` 的实现都是错的。连续的同类 delta 会被合并成一帧（`delta` 是多段拼接），UI 照常追加即可。

### 5.0 总表

| 事件 | 字段 | UI 用途 |
|---|---|---|
| `before_agent_start` | 提示词与 `systemPromptOptions`（只读转发） | 一次运行即将开始；UI 可忽略（权威开始信号是 `agent_start`） |
| `agent_start` | — | 一轮运行开始 → 忙碌条出现 |
| `agent_end` | `messageCount: number`（原 `messages` 已换成计数）, `willRetry: boolean` | 底层一轮结束；`willRetry=true` 时先别停忙碌动画 |
| `agent_before_settle` | —（扩展用） | 可忽略 |
| `agent_settled` | — | **pi 不会再自动动作** → 忙碌条消失的权威信号 |
| `turn_start` | — | 一个 assistant 回合开始 |
| `turn_end` | `message: AssistantMessage`, `toolResults: ToolResultMessage[]`（`context` 若存在已换成计数摘要） | 一个回合（回复+其工具调用）结束 |
| `message_start` | `message: AgentMessage` | 一条消息开始（assistant 的 `stopReason:"pending"`） |
| `message_update` | `usage: Usage`, `assistantMessageEvent: AssistantMessageEvent` | **流式增量**，核心打字机效果 |
| `message_end` | `message: AgentMessage` | **权威终版**，整体替换该消息 |
| `tool_execution_start` | `toolCallId`, `toolName`, `args` | 工具卡片：进入"执行中" |
| `tool_execution_update` | `toolCallId`, `toolName`, `args`, `partialResult` | 工具流式中间输出（如 bash 增量）。`partialResult` 是**累积**结果，只保留文本尾部 32K 字符（截过时 `truncatedHead:true`），同一工具 120ms 内只发最新一帧 |
| `tool_execution_end` | `toolCallId`, `toolName`, `result`, `isError` | 工具卡片：完成/出错 |
| `compaction_start` | `reason: "manual"｜"threshold"｜"overflow"` | "压缩上下文中…"提示 |
| `compaction_end` | `reason`, `result?`, `aborted`, `willRetry?`, `errorMessage?` | 压缩完成/失败提示 |
| `session_before_compact` | `{reason, willRetry, customInstructions?, preparation:{firstKeptEntryId, isSplitTurn, tokensBefore, settings:{enabled, reserveTokens, keepRecentTokens}, fileOps:{readFiles, modifiedFiles}}, messagesToSummarize(n), branchEntries(n)}`（signal/messagesToSummarize/branchEntries 原文已裁剪，只回计数） | 压缩**开始前**："正在压缩…"预告 + **生效压缩阈值**可读；自动（threshold/overflow）与手动都发 |
| `auto_retry_start` | `attempt`, `maxAttempts`, `delayMs`, `errorMessage` | "网络抖动，Ns 后重试(attempt/max)" |
| `auto_retry_end` | `success`, `attempt`, `finalError?` | 重试成功/最终失败 |
| `summarization_retry_scheduled` | `attempt`, `maxAttempts`, `delayMs`, `errorMessage` | 压缩摘要重试排队 |
| `summarization_retry_attempt_start` | `source: "compaction"｜"branchSummary"`, `reason?` | 摘要重试开始 |
| `summarization_retry_finished` | — | 摘要重试结束 |
| `queue_update` | `steering: AgentMessage[]`, `followUp: AgentMessage[]` | **待发队列**渲染（steer=插到当前回合后，followUp=排队等） |
| `session_info_changed` | `name: string｜undefined` | 会话改名；`undefined`=被清除 |
| `thinking_level_changed` | `level: string` | 思考深度变更（本机切换时） |
| `entry_appended` | `entry: SessionEntry` | 扩展追加的持久条目（一般 UI 不渲染，见 §9.3） |
| `bash_execution_update` | `id?`, `delta: string` | 仅 RPC 直跑 bash 命令时触发；本通道基本不出现，出现即 bash 输出增量 |
| `extension_error` | `extensionPath`, `event`, `error` | 扩展内部错误（诊断用） |
| `provider_stream_event` | `provider`, `api`, `model`, `data` | provider 原始流事件。**默认不转发**（本机 `PI_REMOTE_FORWARD_RAW=1` 才转；高频，UI 无需渲染） |
| `tool_call` | `toolName`, `input` 等 | 工具调用钩子，**只读转发**；权威生命周期看 `tool_execution_start/update/end` |
| `tool_result` | `toolCallId`, `toolName`, `isError`（结果内容已去掉，与随后的 toolResult 消息重复） | **只读转发**；UI 无需渲染（结果以 `tool_execution_end` / toolResult `message_end` 为准） |
| `context` | `messageCount`（原 messages 已换成计数） | 上下文变换钩子，**只读转发**（扩展返回 undefined，不影响本机） |
| `context_with_system` | `messageCount` | 同上（含系统消息的请求级变换） |
| `cache_warming_decision` | `{warmCost, missCost, continuationProbability, action}`（[源码]） | 提示词缓存预热决策："值得预热吗"的成本模型；**只读转发** |
| `mcp_servers_change` | `{servers}`（[源码]：变化后的 MCP 服务器集合） | MCP 服务器连接集合变化；UI 可忽略或配合 `get_mcp_servers` 刷新状态面板 |
| `model_select` | `{type:"model_select", model:Model, previousModel:Model, source:string}`（**[探针实证]**：`model`/`previousModel` 均为完整 Model 对象；程序化 setModel 时 `source:"set"`，终端内切换为 `/model`、Ctrl+P 循环、`restore`） | 模型切换通知（pi **无**对应 wire 事件，v2.8 补的对称）；UI 即时更新模型徽标，不用等下一帧 assistant 消息 |
| `session_tree` | `{newLeafId, oldLeafId, summaryEntry?, fromExtension?}`（[源码]） | 本机 `/tree` 分支跳转；收到后准备接收同房间新 `snapshot` |
| `session_compact_failed` | `{reason, errorMessage?, aborted, willRetry, fromExtension}`（[源码]） | 压缩失败（与 `compaction_end` 失败分支互为补充） |
| `remote_message` ★ | `text: string`, `at: number` | **扩展级事件**（非 pi 原生）：远程消息成功注入后回显，UI 渲染为 user 气泡，见 §5.3 |
| `remote_message_failed` ★ | `text: string`, `error: string`, `at: number` | **扩展级事件**：远程消息注入**失败**时报（本机未就绪/引用失效/steer 也失败）。UI 应把对应气泡标记为发送失败（可重试），见 §5.3 |
| `user_bash` | —（输入侧钩子） | 转发流中**只读出现**：扩展不拦截用户输入（返回 undefined 直通本地执行）。UI 不需要渲染 |

### 5.1 assistantMessageEvent 全集（`message_update` 的内嵌对象，12 种）

流式重建的**唯一事实来源**。`contentIndex` 指明这条增量属于当前 assistant 消息里的第几个内容块（从 0 开始）。

| `type` | 增量字段 | 权威字段 | UI 动作 |
|---|---|---|---|
| `start` | — | — | provider 流开始（可忽略） |
| `text_start` | `contentIndex` | — | 建立一个 text 块气泡 |
| `text_delta` | `contentIndex`, `delta` | — | 追加到对应 text 块（打字机） |
| `text_end` | `contentIndex` | `content: string` | 用权威内容替换该块 |
| `thinking_start` | `contentIndex` | — | 建立可折叠"思考中"块 |
| `thinking_delta` | `contentIndex`, `delta` | — | 追加思考文本 |
| `thinking_end` | `contentIndex` | `content: string` | 用权威内容替换 |
| `toolcall_start` | `contentIndex`, `id`, `toolName` | — | 插入工具卡片（执行中） |
| `toolcall_delta` | `contentIndex`, `delta` | — | 追加参数 JSON 文本 |
| `toolcall_end` | `contentIndex` | `toolCall: ToolCall` | 卡片参数定型 |
| `done` | `reason` | `message` | provider 流正常结束 |
| `error` | `reason`, `error` | — | 本次流出错（UI 提示） |

> 转发时已**剥掉 `partial` 快照字段**（wire 上不含累积快照，省流量）；累积文本由 UI 按 `contentIndex` 自己拼。
> `message_update.usage` 是最新累计用量，可为 0（provider 不中途上报时），最终值以 `message_end.message.usage` 为准。

### 5.2 关键事件 payload 细节

```jsonc
// agent_end（messages 已换成计数）
{"type":"agent_end","messageCount":6,"willRetry":false}

// turn_end —— message 是 AssistantMessage；toolResults 是本回合产生的工具结果
{"type":"turn_end","message":{…AssistantMessage…},"toolResults":[…ToolResultMessage…]}

// message_start —— assistant 消息初始形态
{"type":"message_start","message":{"role":"assistant","content":[],"api":"…","provider":"stepfun","model":"step-5-preview","usage":{…},"stopReason":"pending","timestamp":1791368801000}}

// message_end —— 权威终版（stopReason 变为 stop/toolUse/length/error/aborted…）
{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"…"},{"type":"text","text":"OK"}],"stopReason":"stop","usage":{…}}}

// tool_execution_start / update / end
{"type":"tool_execution_start","toolCallId":"call_abc","toolName":"bash","args":{"command":"ls -la"}}
{"type":"tool_execution_update","toolCallId":"call_abc","toolName":"bash","args":{…},"partialResult":{"content":[{"type":"text","text":"partial output"}]}}
{"type":"tool_execution_end","toolCallId":"call_abc","toolName":"bash","result":{"content":[{"type":"text","text":"complete output"}],"details":{}},"isError":false}

// compaction_start / compaction_end
{"type":"compaction_start","reason":"threshold"}
{"type":"compaction_end","reason":"threshold","result":{"summary":"…","firstKeptEntryId":"abc","tokensBefore":150000,"estimatedTokensAfter":32000,"usage":{…},"details":{}},"aborted":false,"willRetry":false}
{"type":"compaction_end","reason":"threshold","aborted":false,"errorMessage":"summarization failed"}   // 失败形态：无 result

// retry
{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"529 overloaded"}
{"type":"auto_retry_end","success":true,"attempt":2}
{"type":"auto_retry_end","success":false,"attempt":3,"finalError":"provider unavailable"}
{"type":"summarization_retry_scheduled","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"terminated"}
{"type":"summarization_retry_attempt_start","source":"compaction","reason":"threshold"}   // source 亦可为 "branchSummary"（此时无 reason）
{"type":"summarization_retry_finished"}

// queue_update —— 两个数组都是完整当前队列（元素是 AgentMessage，通常是 user 消息）
{"type":"queue_update","steering":[…],"followUp":[…]}

// session
{"type":"session_info_changed","name":"修登录 bug"}     // name 缺省/undefined = 清除名字
{"type":"thinking_level_changed","level":"high"}
{"type":"entry_appended","entry":{ …SessionEntry，见 §9.3… }}
{"type":"extension_error","extensionPath":"/path/ext.ts","event":"tool_call","error":"boom"}
{"type":"bash_execution_update","id":"req-1","delta":"total 48\n"}
```

---

### 5.3 远程消息的回显契约（重要，UI 必读）

实测结论（RPC/交互模式真实验证）：
- 远程消息经 `sendUserMessage(text, deliverAs)` 注入后，消息事件分两种情形：
  - **空闲注入**：pi 会正常补发 `message_start/message_end`（role=user）→ 与 `remote_message` **重复**
  - **忙时 steer 折进当前轮**：pi **不发** user 消息事件，`queue_update` 也不触发
- 因此扩展在每次成功注入后都补发一条 `remote_message`，这是唯一保证"谁发了什么"在所有端可见的机制。

UI 规则：
1. 收到 `remote_message` → 立即渲染一条 user 气泡（可标"远程"小角标），无需等模型响应
2. 去重：若随后到达的 `message_end`（role=user）文本与最后一条 `remote_message` 气泡相同，**移除该 remote 气泡**，以权威消息为准（pi 自己补发消息时会出现）
3. 本机用户自己输入的消息走正常 `message_start/message_end`（user），与 `remote_message` 互不干涉
4. **失败回报**：收到 `remote_message_failed` → 把对应远程气泡标记为"发送失败"（置灰 + 重试按钮），不要当成已送达；`error` 为可读原因
5. 发送方本地：`ack.ok=true` 才做乐观回显；`ack.ok=false`（本机未连接）时显示发送失败。注意 `ack.ok=true` 只代表"已送达扩展"，**注入结果以 `remote_message` / `remote_message_failed` 事件为准**

```jsonc
{"type":"room_event","room":"R","event":{"type":"remote_message","text":"帮我看下这个 bug","at":1791369000000}}
```

---
## 6. 消息类型全集（`AgentMessage`，8 种角色）

快照的 `messages[]` 与 `message_start/message_end` 的 `message` 都是这些。
时间戳是 **Unix 毫秒**（注意与会话条目的 ISO 字符串区分）。

### 6.1 `user`
```jsonc
{"role":"user","content":"你好" | [TextContent|ImageContent],"timestamp":1733234401000}
```

### 6.2 `assistant`
```jsonc
{
  "role":"assistant",
  "content":[TextContent | ThinkingContent | ToolCall],
  "api":"openai-completions",            // provider API 形态
  "provider":"stepfun",
  "model":"step-5-preview",
  "responseModel":"step-5-preview",      // 实际应答模型（与请求不同时）
  "responseId":"…",                      // provider 侧 ID
  "providerThinkingLevel":"high",
  "usage":Usage,
  "stopReason":"pending|stop|length|toolUse|error|aborted|deferred",
  "errorMessage":"…",                    // stopReason=error 时
  "endTurn":true,
  "timestamp":1733234402000
}
```
流式中 `stopReason="pending"`；`message_end` 时是终态。**`aborted` = 被中断**（UI 显示"已中断"）。

### 6.3 `toolResult`
```jsonc
{"role":"toolResult","toolCallId":"call_abc","toolName":"bash","content":[TextContent|ImageContent],"details":{…工具特定…},"usage":Usage?,"isError":false,"timestamp":…}
```
`details` 因工具而异（如 bash 有退出码、edit 有 diff 数据、read 有行号）。UI 做通用展示取 `content`；要做工具专属卡片（diff 等）按 `toolName` 分支解析 `details`。
,> **`details` 口径（v2.9：源码级定稿 + 实测互证）**：
,> - `details` **仍须按可选处理**：69 个实测样本中 68 个 undefined；但形状不再"未知"——以下按 pi 出厂源码（内置工具 execute 返回值）定稿
,> - **bash**（33 样本）：`{truncation?:TruncationInfo, fullOutputPath?:string}`；非截断时整块 undefined。`TruncationInfo` = `{content?, truncated, truncatedBy?:"lines"|"bytes", totalLines?, totalBytes?, outputLines?, outputBytes?, lastLinePartial?, firstLineExceedsLimit?, maxLines?, maxBytes?}`（除 truncated 外均可缺）。**`structuredContent`**（tool_execution_end 同源对象上）恒有：`{output, truncated, full_output_path?, exit_code, wall_time_seconds}`——前端展示退出码/耗时用它
,> - **powershell**：与 bash 同工厂同构（0 样本，[源码]）
,> - **edit**：`{diff:string, patch:string, firstChangedLine:number}` **恒存在**（generateDiffString/generateUnifiedPatch 产物）——前端可直接渲染 diff 卡片
,> - **grep**：`{matchLimitReached?:number, truncation?:TruncationInfo, linesTruncated?:true}`；无命中/无截断时 undefined
,> - **find**：`{resultLimitReached?:number, truncation?:TruncationInfo}`；无匹配时 undefined
,> - **ls**：`{entryLimitReached?:number, truncation?:TruncationInfo}`；空目录 undefined
,> - **read**：`{truncation?:TruncationInfo}`（仅截断时出现；maxLines 默认 2000 / maxBytes 51200）
,> - **write**：**恒 undefined**（execute 明写 details:void 0）
,> - **codemode**：`{calls:[{id, name, args, status, durationMs, error?}], fullOutputPath?, usage?}`
,> - **tool_search**：`{loaded:string[]}`（被激活的工具名）
,> - **MCP 工具**（含 list/read_mcp_resource）：`{server, tool, fullOutputPath?}`
,> - **toolResult.usage**：自有 + 嵌套调用累加；`nestedCalls={calls:[…], complete:boolean}`（args>8KiB 省略、≤256 条）
,> - isError 与 details 正交：错误文本在 `content[].text`（bash 尾缀 "Command exited with code N"）；**`tool_execution_end.isError`/`result` 与 toolResult 同源，UI 以一个为准**

### 6.4 `system`
```jsonc
{"role":"system","content":"","sections":{"preamble":"You are…","tools":"<tools>…","cwd":"…","skills":"…"},"toolsAdded":[{"name":"read","description":"…","parameters":{…}}],"toolsRemoved":[{"name":"write"}],"replace":true,"timestamp":…}
```
system prompt/工具清单的**声明流**：多条 system 消息按序重放得到当前生效的 prompt 与工具集（`sections` 按名增删，`null` 移除；`replace:true` 重置基线）。**UI 不展示它，但别当脏数据删**——它解释"为什么模型会做某事"。

### 6.5 `bashExecution`（本机直接跑 shell，非模型工具）
```jsonc
{"role":"bashExecution","command":"ls -la","output":"…","exitCode":0,"cancelled":false,"truncated":false,"fullOutputPath":"…","excludeFromContext":false,"timestamp":…}
```

### 6.6 `custom`（扩展注入的上下文消息）
```jsonc
{"role":"custom","customType":"my-ext","content":"…","display":true,"details":{…},"timestamp":…}
```
`display=false` 时本机 TUI 都不显示，UI 也应隐藏。

### 6.7 `branchSummary` / 6.8 `compactionSummary`（分支/压缩摘要）
```jsonc
{"role":"branchSummary","summary":"Branch explored approach A…","fromId":"f6g7h8i9","timestamp":…}
{"role":"compactionSummary","summary":"User discussed X, Y, Z…","tokensBefore":50000,"timestamp":…}
```
上下文折叠产物。UI 建议渲染为一条"已折叠早期对话（摘要）"的分隔卡，**不是普通对话**。

---

## 7. 内容块与 Usage

```jsonc
TextContent    {"type":"text","text":"…","textSignature?":"opaque"}
ThinkingContent{"type":"thinking","thinking":"…","thinkingSignature?":"opaque","redacted?"false}
ToolCall       {"type":"toolCall","id":"call_abc","name":"bash","arguments":{"command":"ls"},"namespace?":"…"}
ImageContent   {"type":"image","data":"<base64>","mimeType":"image/png"}
               {"type":"image","data":"","mimeType":"image/png","omitted":true,"omittedBytes":230760}   // 大图占位
```
- `textSignature` / `thinkingSignature` 是 provider 私有数据，**原样透传、别解析、别展示**
- `redacted:true` 的 thinking 块可能无可见文本，保留签名即可
- `ImageContent.data` 不超过 128KB（base64 字符数）时是完整 base64，直接渲染；超过的在扩展和 relay 两侧都会换成占位（`data:""`, `omitted:true`, `omittedBytes`=原图字节数），UI 显示"图片过大未传输（xx KB），请在本机查看"。快照、事件、命令结果口径一致

```jsonc
Usage {"input":100,"output":512,"cacheRead":0,"cacheWrite":0,"cacheWrite1h?":0,"reasoning?":0,"totalTokens":612,
       "cost":{"input":0.001,"output":0.01,"cacheRead":0,"cacheWrite":0,"total":0.011}}
```
`reasoning` 已含在 `output` 内，**别再叠加**。展示位置建议：每条 assistant 消息脚标或回合结束时。

---

## 8. 流式重建算法（UI 必读）

对每个 `room_event`，维护"当前 live assistant 消息"上下文：

```
message_start(msg)          → msg.role==="assistant" 时新建 live 气泡（stopReason=pending）
message_update(evt)         → 按 evt.assistantMessageEvent：
    text_delta[t]           → blocks[contentIndex=t].text += delta
    thinking_delta[t]       → blocks[t].thinking  += delta
    toolcall_start(t,id,nm) → blocks[t] = 工具卡片(执行中)，记录 id→卡片
    toolcall_delta(t)       → 追加到最后一张工具卡片的参数文本
    toolcall_end(t,tc)      → 用 tc.arguments/tc.name 定型该卡片
    text_end/thinking_end   → 用权威 content 覆盖对应块
message_end(msg)            → 用整条 msg 整体替换 live 气泡（权威）
agent_settled               → live 置空（若没有 message_end 的半成品直接丢弃）
tool_execution_start/end(id)→ 按 toolCallId 找卡片：执行中→完成/出错（isError）
                                找不到卡片（如非模型直跑的 bash）→独立渲染一张卡
```

要点：
1. **`message_end` 是权威**：任何拼接结果都以它为准整体替换，不要试图合并
2. `contentIndex` 是**同一条 assistant 消息内**的块序号；跨消息重新计数
3. 工具卡片双通道：`toolcall_*`（assistant 内容块内）+ `tool_execution_*`（生命周期事件）按 `toolCallId`/卡片 `data-tool-id` 对应
4. 用户消息也可能经事件流到达（远程注入/本机输入都有 `message_start/message_end` 的 user 消息）——**不要做本地乐观回显去重冲突**：做回显就标记，收到权威同文本 `message_end` 时移除回显
5. `turn_end.toolResults` 已包含在消息流里（toolResult 消息也有自己的 message_start/end），二选一渲染，别双份
6. 合并后的 `text_delta` / `thinking_delta` / `toolcall_delta` 的 `delta` 是多段拼接，照常追加；背压时个别 delta 帧可能被跳过，以 `message_end` 整体替换为准
7. 带 `seq` 的事件先过序号检查（§0 v3 第 2 条）：重复的直接丢，跳号的先带 `since` 重订阅补洞，不要硬应用
8. 长会话：全量快照一次给出全部消息，渲染层可以只挂载末尾一段（参考实现每次 300 条，按钮加载更早的），reducer 处理快照要保持 O(n)

---

## 9. 快照与会话条目

### 9.1 快照 `messages[]` 的构成
= 当前**活跃分支**上所有"消息类条目"的 `message` 字段（含 system/user/assistant/toolResult/custom/branchSummary/compactionSummary/bashExecution）。
顺序 = 上下文顺序。旧会话被压缩后，前面会出现一条 `compactionSummary`，其后是保留的近段消息——**这就是模型看到的全部，UI 与模型所见严格一致**。

### 9.2 system 消息处理建议
默认不渲染；可在"调试/详情"里展示 `sections` 与 `toolsAdded/toolsRemoved` 的演变。

### 9.3 `entry_appended` 与条目类型
`entry` 是 pi 的持久化条目（树结构，`{type,id,parentId,timestamp}`），除消息条目外还有：
`model_change`、`thinking_level_change`、`usage`、`compaction`、`context_edit`、`branch_summary`、`custom`、`custom_message`、`label`、`session_info`。
**这些条目不进消息流也不进快照 messages**（它们不是消息）；`entry_appended` 一般无需 UI 渲染。例外：`session_info` 改名会同时发 `session_info_changed`（UI 应响应那个）。

---

## 10. 忙闲、队列与中断的 UI 语义

| 状态 | 信号源 | UI |
|---|---|---|
| 运行中 | `room_state.busy=true`、`agent_start`、`turn_start` | 忙碌条 + spinner；输入框 placeholder 改为"运行中，发送将 steer 追加" |
| 空闲 | `agent_settled`、`room_state.busy=false` | 忙碌条消失 |
| 输入框按钮 | 由本地 busy 态切换：发送 / Steer | 由本地 busy 态切换 |
| 待发队列 | `queue_update.steering / followUp` | 在输入框上方渲染排队消息（steer=当前回合后插入，followUp=回合结束后处理） |
| 中断 | 发 `{"type":"abort","room":…}` | 点击后忙碌条应立即消失；随后 `agent_end{willRetry:false}`、`agent_settled` 到达，assistant 消息 `stopReason:"aborted"` |
| 重试中 | `auto_retry_start/end`、`summarization_retry_*` | 黄色提示行；**忙碌条别消失**（`agent_end.willRetry=true` 就是干这个的） |
| 压缩中 | `compaction_start/end` | "正在压缩上下文…"提示行；结束后若 `willRetry:true` 会继续跑 |
| 离线 | `room_offline` / `room_list.online=false` | 顶部红色条；发送按钮禁用；消息留最后画面 |

v3.1 的设备三态、会话三态见 §4.12.6。上表仍只描述**已订阅房间**里的忙闲、队列和离线，信号源不变。设备未连接时：清单可读（§4.2.1），启用/新建/发命令禁用。

---

## 11. 限制与配额

- viewer 发往 relay 的单条 WS 消息 ≤ 256KiB，超限断开（1009）；relay 发给 viewer 的帧没有这个限制（快照可达数 MB，开了 permessage-deflate）
- 本机扩展 → relay（local 通道）单帧 ≤ 16MiB；扩展自己按 12MB 预算组帧，超出时快照从头部丢最旧消息并标 `truncated`、单条超大消息截断长字符串、命令结果改报错
- viewer 每连接 20 msg/s（突发 60），超出回 `rate_limited`（不带 id，被丢的命令靠受理超时重发恢复）；房间观众上限 20 人
- **存储与缓存**（服务器侧）：
  - **全量快照 = 当前分支完整会话**（无分页）：单房超 10000 条或 24MB 时只交付尾部并标 `truncated:true`。内存热缓存仍直接用。v3.1 起缓存为空时不再默认磁盘补齐，改走 `resend_snapshot`（§4.5、§4.12.5）
  - 每房内存热缓存最近 500 条且 ≤16MB，超出驻留磁盘（`data/rooms/<room>.jsonl` 追加式 JSONL，首行是 `rev`）
  - 落盘批量合并（200ms 周期），最多丢失一个刷盘窗口；**relay 重启后历史、`rev`、`seq` 完整保留**，扩展重连后只补停机期间的消息
  - 房间文件保留 30 天（超期自动清理）；本机关闭后房间离线，同会话重连即恢复
  - v3.1：`retentionDays` 默认仍是 30，作用范围仅旧正文文件
  - 命令去重表只在内存里，保留 10 分钟（relay 重启即丢，此时 `auth_result.boot` 会变）
- `message.text` / `prompt.message` 没有单独的长度上限，只受单帧 256KiB 限制；`bash` 命令 ≤ 16000 字符

**v3.1 参数（默认值，集中在这里）**

| 参数 | 默认 | 所在 |
|---|---|---|
| `windowMaxHours` | 12 | attach 命令（`--max-hours`）；换算成 `device_register.device.windowExpiresAt`，relay 不据此踢人 |
| `harnessStartTimeoutMs` | 10000 | relay（`harness_start` 只等已拉起） |
| `sessionOnlineWatchMs` | 60000 | 前端（`started` 之后看 `room_list` 的观察窗） |
| `maxSessionsListed` | 200 | relay（`session_list` 截断） |
| `maxManifestBatch` | 200 | 扩展（`session_manifest` 截断） |
| `manifestThrottleMs` | 60000 | 扩展（回合结束推清单的节流） |
| `resendSnapshotWaitMs` | 3000 | relay（`resend_snapshot` 兜底） |
| `retentionDays` | 30 | relay（仅影响旧正文文件） |

---

## 12. 完整时序示例（一个真实回合）

```jsonc
// —— 用户在 UI 发送 "列出当前目录" ——
▶ {"type":"command","room":"R","id":"c1_k3f9","command":"prompt","args":{"message":"列出当前目录"},"dedupeKey":"c1_k3f9"}
◀ {"type":"command_accepted","id":"c1_k3f9","room":"R","timeoutMs":15000}
◀ {"type":"room_event","room":"R","seq":41,"rev":"9f3c2a1b7e40","event":{"type":"remote_message","text":"列出当前目录","at":1791369000000}}
◀ {"type":"ack","id":"c1_k3f9","room":"R","ok":true,"data":{"disposition":"started"}}
◀ {"type":"room_state","room":"R","busy":true}
◀ {"type":"room_event","room":"R","event":{"type":"agent_start"}}
◀ {"type":"room_event","room":"R","event":{"type":"turn_start"}}
◀ {"type":"room_event","room":"R","event":{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"列出当前目录"}],"timestamp":1791369000000}}}
◀ {"type":"room_event","room":"R","seq":42,"rev":"9f3c2a1b7e40","event":{"type":"message_end","message":{"role":"user",…}}}   // 取代上面的 remote 回显
◀ {"type":"room_event","room":"R","event":{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"pending",…}}}
◀ {"type":"room_event","room":"R","event":{"type":"message_update","usage":{…},"assistantMessageEvent":{"type":"thinking_start","contentIndex":0}}}
◀ … thinking_delta × N …
◀ {"type":"room_event","room":"R","event":{"type":"message_update","usage":{…},"assistantMessageEvent":{"type":"text_start","contentIndex":1}}}
◀ … text_delta × N（"好的，我来列出…"）…
◀ {"type":"room_event","room":"R","event":{"type":"message_update","usage":{…},"assistantMessageEvent":{"type":"toolcall_start","contentIndex":2,"id":"call_1","toolName":"bash"}}}
◀ {"type":"room_event","room":"R","event":{"type":"message_update","usage":{…},"assistantMessageEvent":{"type":"toolcall_delta","contentIndex":2,"delta":"{\"command\":"}}}
◀ … toolcall_end（arguments 定型）…
◀ {"type":"room_event","room":"R","seq":43,"rev":"9f3c2a1b7e40","event":{"type":"message_end","message":{"role":"assistant","content":[thinking,text,toolCall],"stopReason":"toolUse",…}}}
◀ {"type":"room_event","room":"R","event":{"type":"tool_execution_start","toolCallId":"call_1","toolName":"bash","args":{"command":"ls"}}}
◀ {"type":"room_event","room":"R","event":{"type":"tool_execution_update","toolCallId":"call_1","toolName":"bash","args":{…},"partialResult":{"content":[{"type":"text","text":"…"}]}}}
◀ {"type":"room_event","room":"R","event":{"type":"tool_execution_end","toolCallId":"call_1","toolName":"bash","result":{"content":[…],"details":{…}},"isError":false}}}
◀ {"type":"room_event","room":"R","event":{"type":"message_start","message":{"role":"toolResult","toolCallId":"call_1","toolName":"bash","content":[…],"isError":false,…}}}
◀ {"type":"room_event","room":"R","seq":44,"rev":"9f3c2a1b7e40","event":{"type":"message_end","message":{"role":"toolResult",…}}}
◀ … 第二轮 assistant（message_start→deltas→message_end，无工具调用）…
◀ {"type":"room_event","room":"R","event":{"type":"turn_end","message":{…},"toolResults":[…]}}}
◀ {"type":"room_event","room":"R","event":{"type":"agent_end","messageCount":5,"willRetry":false}}}
◀ {"type":"room_event","room":"R","event":{"type":"agent_settled"}}}
◀ {"type":"room_state","room":"R","busy":false}
```

---

## 13. TypeScript 类型（可直接拷进 readyUI）

export type RoomInfo = { id: string; label: string | null; cwd: string | null; online: boolean; busy: boolean; viewers: number; lastActivity: number };
/** v3.1 room_list.rooms：原字段不变，另加账户、设备与房间最近活动时间。旧帧可以没有这三项（lastActivity 缺省 0）。 */
export type RoomListEntry = RoomInfo & { accountId?: string; deviceId?: string };
/** v3.1 room_list.devices。online = 连接窗口是否在跑。名册行字段见 50 号示例。 */
export type DeviceRosterEntry = {
  id: string; accountId: string; name: string; platform: string;
  online: boolean; projects: string[]; lastAttachAt: number;
  /** 连接窗口到期时间（ms）；窗口离线或旧 relay 不下发时为 null。UI 用它显示剩余时间并提前提醒。 */
  windowExpiresAt?: number | null;
};
/** 未登记房间的设备条目固定为这一形状，不带名册其余字段。 */
export type UnregisteredDeviceEntry = { id: "未登记设备"; online: false };
export type DeviceInfo = DeviceRosterEntry | UnregisteredDeviceEntry;
/** v3.1 session_list.sessions。墓碑行不会出现在数组里。 */
export type SessionListEntry = {
  id: string; name: string; cwd: string; messageCount: number; sizeBytes: number;
  updatedAt: number; active: boolean; online: boolean; deleted: boolean;
};

export type SyncPoint = { rev: string; seq: number };

export type ServerMessage =
  | { type: "auth_result"; ok: boolean; boot?: string; rooms?: RoomInfo[]; error?: string }
  | { type: "room_list"; devices?: DeviceInfo[]; rooms: RoomListEntry[] }
  | { type: "session_list"; id: string; deviceId: string; sessions: SessionListEntry[]; truncated: boolean }
  | { type: "subscribed"; room: string; online: boolean; busy: boolean }
  | {
      type: "snapshot"; room: string; busy: boolean;
      rev: string | null; seq: number; truncated: boolean; messages: AgentMessage[];
      delta?: true; baseSeq?: number; // 增量：messages 只含 baseSeq 之后的记录
      snapshotPending?: true; // v3.1：resend 超时后的空快照，前端显示正在从本机拉取
    }
  | { type: "room_event"; room: string; seq?: number; rev?: string; event: SessionEvent } // 会落盘的事件才带 seq/rev
  | { type: "room_state"; room: string; busy: boolean }
  | { type: "usage_state"; room: string; usage: Record<string, unknown> }
  | { type: "room_offline"; room: string }
  | { type: "command_accepted"; id?: string; room: string; timeoutMs: number; dedup?: true } // room：v3 按房间路由时必有；设备级是否仍带，50 号没写
  | { type: "ack"; id?: string; room?: string; ok: boolean; data?: unknown; error?: string; code?: string; dedup?: true }
  | { type: "pong" }
  | { type: "error"; code: string; message: string; room?: string };

export type ClientMessage =
  | { type: "auth"; role: "viewer"; token: string }
  | { type: "list_rooms"; id?: string }
  | { type: "get_sessions"; id: string; deviceId: string }
  | { type: "subscribe"; room: string; since?: SyncPoint; id?: string }
  | { type: "unsubscribe"; id?: string }
  | { type: "command"; room?: string; deviceId?: string; id?: string; command: string; args?: Record<string, unknown>; dedupeKey?: string }
  | { type: "message"; room: string; text: string; id?: string } // 快捷帧：不去重，勿重发
  | { type: "abort"; room: string; id?: string }
  | { type: "ping"; id?: string };

/** local 通道帧（readyUI 不发送）。device_detach 本期不实现，没有载荷，故不列入。 */
export type LocalChannelMessage =
  | { type: "device_register"; accountId: string; device: { id: string; name: string; platform: string; projects: string[]; windowExpiresAt: number } }
  | { type: "room_register"; room: { id: string; label?: string | null; cwd?: string | null; epoch?: number; instance?: string; accountId?: string; deviceId?: string; deviceName?: string; platform?: string } }
  | {
      type: "session_manifest"; accountId: string; deviceId: string; full: boolean; updatedAt: number;
      sessions: Array<{ id: string; path: string; name: string; cwd: string; firstMessage: string; messageCount: number; sizeBytes: number; createdAt: number; updatedAt: number; active: boolean }>;
      removed?: string[]; truncated?: boolean; // 全量分片时增量文写作 part:i/n，未规定 JSON 类型；本期可不分片
    }
  | { type: "resend_snapshot" };

// ===== 内容块 =====
export type TextContent = { type: "text"; text: string; textSignature?: string };
export type ThinkingContent = { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean };
export type ToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; namespace?: string };
export type ImageContent = { type: "image"; data: string; mimeType: string; omitted?: true; omittedBytes?: number }; // omitted=大图占位，data 为空
export type ContentBlock = TextContent | ThinkingContent | ToolCall | ImageContent;

// ===== Usage =====
export type Usage = {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  cacheWrite1h?: number; reasoning?: number; totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

// ===== 消息（与快照/message_start/message_end 同型）=====
export type SystemMessage = { role: "system"; content: string | TextContent[]; sections?: Record<string, string | null>; toolsAdded?: unknown[]; toolsRemoved?: unknown[]; replace?: boolean; timestamp: number };
export type UserMessage = { role: "user"; remote?: boolean; content: string | (TextContent | ImageContent)[]; timestamp: number };
export type AssistantMessage = {
  role: "assistant"; content: (TextContent | ThinkingContent | ToolCall)[];
  api: string; provider: string; model: string;
  responseModel?: string; responseId?: string; providerThinkingLevel?: string;
  usage: Usage;
  stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  errorMessage?: string; endTurn?: boolean; timestamp: number;
};
export type ToolResultMessage = { role: "toolResult"; toolCallId: string; toolName: string; content: (TextContent | ImageContent)[]; details?: unknown; usage?: Usage; isError: boolean; timestamp: number };
export type BashExecutionMessage = { role: "bashExecution"; command: string; output: string; exitCode: number | undefined; cancelled: boolean; truncated: boolean; fullOutputPath?: string; excludeFromContext?: boolean; timestamp: number };
export type CustomMessage = { role: "custom"; customType: string; content: string | (TextContent | ImageContent)[]; display: boolean; details?: unknown; timestamp: number };
export type BranchSummaryMessage = { role: "branchSummary"; summary: string; fromId: string | null; timestamp: number };
export type CompactionSummaryMessage = { role: "compactionSummary"; summary: string; tokensBefore: number; timestamp: number };
export type AgentMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage | BashExecutionMessage | CustomMessage | BranchSummaryMessage | CompactionSummaryMessage | { role: string; timestamp: number; [k: string]: unknown }; // 末项：容忍扩展自定义角色

// ===== 流式增量 =====
export type AssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
  | { type: "done"; reason: string; message: AssistantMessage }
  | { type: "error"; reason: string; error: string };

// ===== 会话事件（room_event.event）=====
export type SessionEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messageCount: number; willRetry: boolean }
  | { type: "agent_before_settle" }
  | { type: "agent_settled" }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; usage: Usage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result?: { summary: string; firstKeptEntryId: string; tokensBefore: number; estimatedTokensAfter: number; usage?: Usage; details?: unknown }; aborted: boolean; willRetry?: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "summarization_retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "summarization_retry_attempt_start"; source: "compaction" | "branchSummary"; reason?: "manual" | "threshold" | "overflow" }
  | { type: "summarization_retry_finished" }
  | { type: "queue_update"; steering: AgentMessage[]; followUp: AgentMessage[] }
  | { type: "session_info_changed"; name?: string }
  | { type: "thinking_level_changed"; level: string }
  | { type: "entry_appended"; entry: { type: string; id: string; parentId: string | null; timestamp: string; [k: string]: unknown } }
  | { type: "bash_execution_update"; id?: string; delta: string }
  | { type: "extension_error"; extensionPath: string; event: string; error: string }
  | { type: "remote_message"; text: string; at: number } // 扩展级：远程消息注入回显（见 §5.3）
  | { type: "remote_message_failed"; text: string; error: string; at: number }
  | { type: string; [k: string]: unknown }; // 其余事件（§5.0 总表）：未知类型忽略即可
```

---

## 14. 组件映射（对照 references.md 的清单）

| 你的组件 | 数据来源 |
|---|---|
| Prompt Input / 输入条 | `room_state`/`agent_settled` 切换"发送/Steer"；`send → ack` |
| Streaming Response / 打字机 | `message_update.assistantMessageEvent` 的 text_delta（§5.1） |
| Reasoning / Thinking Bar | thinking_start/delta/end（可折叠）；`redacted` 时只显示"思考中" |
| Chain of Thought | 同一 assistant 消息内 thinking→text→toolCall 的块序（按 contentIndex） |
| Tool 卡片 / Tool Call | `toolcall_*`（块内）+ `tool_execution_start/update/end`（生命周期，`isError`、`partialResult`） |
| Task 行 / 队列 | `queue_update.steering/followUp` |
| Loader / 忙碌 | `room_state.busy`、`agent_start`、`agent_settled` |
| Approval Card | **暂不接入**：扩展确认对话框走的是另一条 RPC 子协议（`extension_ui_request`），本通道不转发（见 §15） |
| Code Block / diff | toolResult 的 `content` + `details`（edit/write 类工具含 diff 数据，按 toolName 分支解析） |
| Message Scroller | snapshot + 事件追加；断线重连带 `since` 收增量接续，rev 变了才清空按全量重建 |
| Source / 会话标题 | `RoomInfo.label` + `session_info_changed` |
| 设备名册 / 会话清单 | `room_list.devices` 与 `get_sessions` → `session_list`（§4.2、§4.2.1）。窗口未连接时只读清单，启用/新建禁用（§4.12.6） |

---

## 15. 边界与未覆盖（明确说清，免得做错）

1. **Extension UI 子协议不在本通道**：pi 的扩展弹窗/确认/通知（`ctx.ui.confirm` 等）走 RPC Extension UI 子协议，本转发链路不透传。需要审批交互是后续迭代项。
2. **`user_bash` 是输入侧钩子**：本通道以只读方式转发（仅观察，不影响本机执行），UI 无需渲染。
3. **`bash_execution_update` 基本不触发**：仅当以 RPC 方式直跑 bash 命令时才有；模型跑 bash 工具走的是 `tool_execution_*`。
4. **自定义消息角色**：扩展可注册新 role，收到未识别的 `role` 时按"通用消息"兜底渲染（type 定义末项已容忍）。
5. **图片**：不超过 128KB（base64）的图片原样传；更大的换成 `omitted:true` 占位（§7），远端看不到原图。
6. **多分支**：快照给的是当前活跃分支。远程 `navigate_tree` 跳分支后**同房间推送新 `snapshot`**（无 room_closed）；本机 `/tree` 操作则以房间更替反映。UI 一律以最新 `snapshot` 为准。
8. **远端不能写会话**：`pi.sendMessage()`/`pi.appendEntry()` 等一律不从远端调用（等于让网页往模型上下文注入任意内容、烧 token）。bash 输出进上下文是**扩展本地逻辑**（官方语义），不接受远端参数。
9. **远端不能拿密钥**：`modelRegistry.getApiKeyAndHeaders`/`getApiKeyForProvider` 等禁止触达；认证只暴露"状态"（`get_provider_auth`）。
10. **`get_mcp_servers` 是白名单投影**：MCP config 可能含 env/headers/command，只回安全字段；看到 `keys` 里有未知字段是正常的（元素细目待实测）。
11. **v3.1 设备窗口与会话清单**见 §4.2、§4.11、§4.12、§11。`device_detach` 只预留帧名，本期不实现。
12. **新旧扩展 / 新旧 UI / 新旧 relay 的搭配**见 §4.12.7。旧 UI 只读 `room_list.rooms`。
均**直接执行、无需本机确认**（v2.3 起，与终端命令完全等价）；

---

## 附：权威出处

- 事件与消息字段：本机 `D:\pi\docs\json.md`、`message-types.md`、`session-format.md`（与 `D:\Pi-desktop\resources\agent-runtime` 出厂代码逐一核对）
- 上游源码（GitHub）：`earendil-works/pi` → `packages/coding-agent/src/modes/json-event.ts`（事件转换）、`packages/ai/src/types.ts`（内容块）、`packages/agent/src/types.ts`（消息联合）、`packages/coding-agent/src/core/messages.ts`（coding-agent 消息角色）、`src/core/session-manager.ts`（条目）
（官方事件全表转发、事件不增不减；载荷投影见 §0 v3 第 5 条）
- 本仓库实现：`relay/server.js`、`relay/store.js`（relay 与存储）、`extension/pi-remote-sync.ts`（扩展）、`ui/src/relay/{sync,commands,transcript}.ts`（前端参考实现）；协议回归测试见 `test/`（`npm test`、`npm run test:e2e`）
