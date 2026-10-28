# 契约增量（Protocol Delta）：设备 / 连接窗口 / 会话清单

> 四线（前端/后端/本地端/服务器端）**共同契约**。本文定义新增与变更的帧、命令、错误码、状态机与参数。
> 现有会话帧（`snapshot` / `room_event` / `command` / `ack` / `room_list` / `usage_state` …）除注明外**一律不改**。
> 落地时把本文合并进 `readyUI/data-interface.md`（v2.9 → v3.0）。

## 0. 设计约束（所有条目的公共规则）

1. **加法式**：只增字段/帧；旧扩展不带新字段 → 房间归「未登记设备」；旧 UI 忽略新字段。
2. **`room.id === sessionId`** 恒成立：启用结果关联、去重、索引行都以它对齐。
3. 所有 local→relay 帧走 7001（`role=local` + localToken）；所有 viewer 帧走 7002（`role=viewer` + viewerToken）。本期账户恒 `admin`。
4. 时间戳统一毫秒 epoch；`updatedAt` 由**本机**生成，relay 只做单调比较。
5. 单帧 ≤256KiB（viewer 通道）/ ≤16MB（local 通道）；超限走截断规则（§4/§5）。

## 1. 帧总表

| 帧 | 方向 | 状态 | 用途 |
|---|---|---|---|
| `device_register` | local→relay | **新增** | 连接窗口开始：声明设备身份 |
| `device_detach` | local→relay | **新增（本期预留，不实现）** | 显式断开窗口 |
| `room_register` | local→relay | **变更** | +`accountId/deviceId/deviceName/platform` |
| `session_manifest` | local→relay | **新增** | 会话清单 upsert / 全量对账 / 墓碑 |
| `resend_snapshot` | relay→local | **新增** | RAM 无快照缓存时请扩展重推 |
| 限速 | viewer 与未认证连接 20/s（突发 60），local 已认证连接不限；被限速回 `error{code:"rate_limited", id:<原请求id>}`，前端按 id 立刻失败，不等超时 |
| `get_sessions` | viewer→relay | **新增** | 查询某设备会话清单（未连接也可读） |
| `session_list` | relay→viewer | **新增** | `get_sessions` 的应答 |
| `room_list` | relay→viewer | **变更** | +`devices[]`；rooms +`accountId/deviceId/lastActivity`；未淘汰的离线房间也下发 |
| `room_label` | local→relay | **新增** | 会话改名：只更新房间标题并广播名列表（不再整包 `room_register`） |
| `command` | viewer→relay→local | **变更** | `room` 可替换为 `deviceId` 寻址；新命令 `harness_start` |
| `ack` | relay→viewer | 不变 | 命令应答（`harness_start` 复用其 id 匹配/超时机制） |

## 2. 设备身份与名册

### 2.1 `room_register`（扩展，窗口内）

```jsonc
{ "type": "room_register", "room": {
  "id": "<sessionId>", "label": "<会话名>", "cwd": "<项目目录>",
  "accountId": "admin", "deviceId": "<deviceId>",
  "deviceName": "Windows", "platform": "windows" } }
```

- 缺省/旧扩展：`accountId/deviceId` 缺失 → 服务端填 `"未登记设备"`（展示用假设备），不报错。
- `accountId` 缺省填 `admin`（本期固定值）；`deviceId` 缺失才归「未登记」。

### 2.2 `device_register`（连接命令，窗口开始）

```jsonc
{ "type": "device_register", "accountId": "admin",
  "device": { "id": "<deviceId>", "name": "Windows", "platform": "windows",
              "projects": ["D:\\pi-myself", "D:\\work\\app"],
              "windowExpiresAt": 1791437613000 } }
```

| 字段 | 规则 |
|---|---|
| `id` | 本机 `.env` 的 `PI_REMOTE_DEVICE_ID`（uuid，重装才换） |
| `name` / `platform` | 展示名（≤64 字符，relay 截断）/ `windows` · `macos` · `linux`（relay 把 `win32`、`darwin` 归一成前两者；路径大小写规则按平台：windows、macos 不分，linux 区分） |
| `projects` | 允许新建/启用会话的目录白名单（`;` 分隔来自 `.env`） |
| `windowExpiresAt` | 本地 `--max-hours` 换算的到期时刻；**信息字段**，relay 不据此踢人（真离线以连接断开为准） |

**顶替规则**：同 `deviceId` 的新 `device_register` 顶掉旧窗口连接（旧 ws 关闭、广播 `room_offline` 不动它的房间）。不得顶替该设备的 pi 扩展连接。

**名册持久化**：每次 register upsert 一行进 `data/accounts/<accountId>/devices.jsonl`（字段见 3.2）。窗口断开只改内存 `online=false`，**不删文件行**。

### 2.3 `room_list`（广播）

```jsonc
{ "type": "room_list",
  "devices": [ { "id": "<deviceId>", "accountId": "admin", "name": "Windows",
                 "platform": "windows", "online": true,
                 "projects": ["D:\\pi-myself"], "lastAttachAt": 1791437613000,
                 "latencyMs": 38 } ],
  "rooms": [ { "id": "<sessionId>", "accountId": "admin", "deviceId": "<deviceId>",
               "label": "…", "cwd": "…", "online": true, "busy": false, "viewers": 1,
               "lastActivity": 1791437613000 } ] }
```

- `devices[]` = 名册全量（含未连接），`online` = 窗口在跑。未登记房间的设备条目固定为 `{id:"未登记设备", online:false}`。
- `latencyMs`（v4 追加字段，additive）：设备↔relay 的平滑延迟，整数毫秒。数据源是 relay 保活对 local 连接（attach 窗口）的 `ping`/`pong` RTT，按 EMA（新样本占 0.3）平滑后取整；**只有在线且已经回过至少一次 pong 才给数字**，离线 / 刚连上还没有样本 / 连接没有 `_state` 时一律 `null`（不写 0、不外推、不复用上一轮连接的值）。旧端忽略该字段即可；未登记设备的伪条目不带延迟（仍是 `{id, online}`）。
- `rooms[]` 还带 `lastActivity`（同目录多个在线房间时前端据此选最新）；**未被淘汰的离线房间也下发**（`online:false`，供"已结束 N"折叠与回看）。细则以 `readyUI/data-interface.md` §4.2 为准。
- 广播节奏不变（房间集合变化 / 设备上下线 / 观众数变化时），数据结构向后兼容（旧 UI 只读 `rooms`）。

## 3. 会话清单（session manifest）

### 3.1 `session_manifest`（扩展 → relay，仅窗口内）

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
| 增量 | 只带变化的行（活动切换 / 改名 / 回合结束节流 / 删除墓碑） |
| `active` | 本机当前活动会话为 true，其余 false（全量时旧活动置假） |
| `updatedAt` 单调 | 每条带本机时钟；relay 丢弃**更旧**的 upsert（防旧重连帧覆盖新状态），丢弃只记日志（`manifest_stale`） |
| 截断 | `sessions` 超过 `maxManifestBatch`（默认 200，按本机 `updatedAt` 倒序）时截断 + 顶层 `truncated:true`；全量帧因此可能分多帧（`full` 帧带 `part:i/n`，本期可简化为"先推最近的 200"） |
| 删除 | `removed[]` 的 id 写墓碑行（`deleted:true`），不物理删行 |

**持久化**：`data/accounts/<accountId>/sessions/<deviceId>.jsonl`，一行一会话 upsert（后行覆盖前行），墓碑行保留。

**行格式**（落盘）：

```jsonc
{ "kind": "session", "id": "<sessionId>", "path": "…", "name": "…", "cwd": "…",
  "firstMessage": "…", "messageCount": 128, "sizeBytes": 86016,
  "createdAt": 1, "updatedAt": 2, "active": false, "deleted": false }
```

### 3.2 `devices.jsonl` 行格式

```jsonc
{ "kind": "device", "id": "<deviceId>", "name": "Windows", "platform": "windows",
  "projects": ["D:\\pi-myself"], "lastAttachAt": 1791437613000, "updatedAt": 1791437613000 }
```

`accounts/index.jsonl`：`{ "kind": "account", "id": "admin", "firstSeenAt": 1, "lastSeenAt": 2 }`。

### 3.3 `get_sessions` / `session_list`（viewer 查询，**未连接也可读**）

```jsonc
// 请求
{ "type": "get_sessions", "id": "c9", "deviceId": "<deviceId>" }
// 应答（id 原样回显；设备不存在 → error no_device）
{ "type": "session_list", "id": "c9", "deviceId": "<deviceId>",
  "sessions": [ { "id": "<sessionId>", "name": "…", "cwd": "…",
                  "messageCount": 128, "sizeBytes": 86016,
                  "updatedAt": 2, "active": false,
                  "online": false, "deleted": false } ],
  "truncated": false }
```

- `online` = 该 session 当前是否活动房间（`room.online`），仅窗口内可能为 true。
- 墓碑行**不回`；排序 `updatedAt` 倒序；超过 `maxSessionsListed`（默认 200）截断 + `truncated:true`。
- 这是**新应答模式**（relay 直接应答、带 id、不走 local）。前端按 id 匹配，10s 超时。

## 4. 命令通道扩展

### 4.1 寻址：`room` → `deviceId`

```jsonc
{ "type": "command", "id": "c10", "deviceId": "<deviceId>",
  "command": "switch_session", "args": { "sessionPath": "C:/.../<sessionId>.jsonl" } }
```

| 规则 | 说明 |
|---|---|
| 路由 | `deviceId` → 该设备**当前活动房间**的 local 连接；无活动房间 → `ack{ok:false,error:"device_no_active_session"}`（文案："这台设备没有在跑的会话，先用「启用/新建」打开一个"） |
| 白名单 | 设备级仅允许：`switch_session` / `new_session` / `fork` / `clone` / `get_state` / `get_sessions` / `harness_start`；其余 → `ack{ok:false,error:"该命令必须指定房间"}` |
| 不重发 | 前端对设备级命令**不自动重发**（与会话操作同档，见 40 号文档）。relay 对设备级命令按命令名走各自分档（会话操作 30s、`get_state`/`get_sessions` 15s、`harness_start` 10s），见 §4.11.1 超时表；前端口径 `harness_start` 10s、其余设备级命令总等 35s（不小于 relay 分档，不会提前报"结果未知"诱发重复执行） |
| 兼容 | 不带 `deviceId` 的 `command` 行为完全不变（按 `room` 路由） |

### 4.2 新命令 `harness_start`（窗口内远程操作）

```jsonc
// 请求（cwd 与 sessionId 二选一，都不带 → 参数错误）
{ "type": "command", "id": "c11", "deviceId": "<deviceId>",
  "command": "harness_start", "args": { "cwd": "D:\\pi-myself" } }
{ "type": "command", "id": "c12", "deviceId": "<deviceId>",
  "command": "harness_start", "args": { "sessionId": "<sessionId>" } }

// 应答（ack.data）
{ "ok": true, "status": "started" }                      // 本机已拉起（会话未必上线）
{ "ok": true, "status": "already_running", "roomId": "…" } // 该 cwd 已有在线会话
{ "ok": false, "error": "设备未连接（在电脑上执行 pi-remote attach）", "code": "device_offline" }
```

| 规则 | 值 |
|---|---|
| 超时 | relay 侧 **10s**（只等"已拉起"应答；会话上线由 `room_list` 驱动，前端另设 60s 观察窗） |
| 重发 | **禁止自动重发**（幂等由 attach 命令串行 + `already_running` 判定保证） |
| `cwd` 校验 | 必须在该设备 `projects` 内 → 否则 `cwd_not_allowed` |
| `sessionId` 校验 | 必须存在于该设备清单（未删）→ 否则 `session_not_found` |
| 启动失败 | 本机 spawn 失败 → `spawn_failed` + 可读原因 |
| 会话上线关联 | `started` 后：`sessionId` 形态等 `room.id === sessionId` 的房间出现；`cwd` 形态等该 `deviceId+cwd` 的最新新房间 |

## 5. 快照与窗口的交互（`resend_snapshot`）

- 触发：viewer 订阅一个 `online=true` 的房间，而 relay RAM 无该房快照缓存（`room.snap` 空 / TTL 过期）。
- 行为：relay 给该房 local 发 `{type:"resend_snapshot"}`；扩展回一份 `snapshot`（现有帧，广播给该房观众）。
- 兜底：3s 未回 → relay 以空 messages 快照应答 + 标注 `snapshotPending:true`（前端显示"正在从本机拉取会话…"，收到 `snapshot` 后自然替换）。
- 本期 `PI_REMOTE_PERSIST_TRANSCRIPTS` 默认停：**磁盘装配路径不再作为默认**，此帧是替代。

## 6. 错误码枚举（ack.error / error.frame）

| code | 触发 | 人读文案（建议） |
|---|---|---|
| `no_device` | `get_sessions`/设备级命令指向从未登记的设备 | "这台设备从未连接过" |
| `device_offline` | 设备登记过但窗口没在跑 | "设备未连接：在电脑上执行 pi-remote attach" |
| `device_no_active_session` | 设备级命令但该设备无活动会话 | "这台设备没有在跑的会话，先启用/新建一个" |
| `session_not_found` | `harness_start{sessionId}` 不在清单 | "这台设备上没有这个会话" |
| `cwd_not_allowed` | 目录不在 `projects` 白名单 | "该目录不在这台设备的允许列表里" |
| `spawn_failed` | 本机启动 pi 失败 | "本机启动失败：<原因>" |
| `manifest_stale` | manifest `updatedAt` 更旧被丢弃 | 仅日志，不面向用户 |

## 7. 状态机

### 7.1 设备（三态）

```
未连接 ──attach──▶ 已连接（窗口） ──退出/到期/断线──▶ 未连接
   │                    │
   │                    └─ 活动会话上线（room.online）→ 网页可镜像/发消息/发命令
   └─ 名册在（索引）：可看上次清单，全部操作禁用
```

### 7.2 会话（三态，窗口内）

```
仅清单 ──harness_start{sessionId}──▶ 活动（room.id===sessionId）───pi 退出──▶ 仅清单
   │                                        │
   └─ 未连接设备：停留在仅清单                 └─ 订阅/镜像/发消息/发命令（现状）
新建：harness_start{cwd} ──▶ 新 sessionId 房间上线（deviceId+cwd 关联）
```

## 8. 参数表（默认值，集中管理）

| 参数 | 默认 | 所在 |
|---|---|---|
| `windowMaxHours` | 12 | attach 命令（`--max-hours`） |
| `harnessStartTimeoutMs` | 10000 | relay |
| `localHost` / `viewerHost` | `127.0.0.1` / `0.0.0.0` | relay（7001 默认只听回环，要对公网开放必须显式配置） |
| `roomIdleEvictMs` / `storeIdleEvictMs` | 6h / 30min | relay（离线房正文保留与"房间还在列表里"对齐） |
| `sessionOnlineWatchMs`（前端观察窗） | 60000 | 前端 |
| `maxSessionsListed` | 200 | relay（`session_list` 截断） |
| `maxManifestBatch` | 200 | 扩展（manifest 截断） |
| `manifestThrottleMs`（回合结束节流） | 60000 | 扩展 |
| `resendSnapshotWaitMs` | 3000 | relay |
| `retentionDays`（旧 rooms 清理） | 30 | relay（仅影响旧正文文件） |

## 9. 兼容矩阵

| 组合 | 行为 |
|---|---|
| 旧扩展 + 新 relay | 房间归「未登记设备」；无 manifest；`harness_start` 不可用（无窗口） |
| 新扩展 + 旧 relay | 新帧被 `unknown_type` 拒绝（扩展记日志、功能降级为现状）；**不支持长期共存** |
| 旧 UI + 新 relay | 只读 `rooms`；设备面板不可见（其余照常） |
| 新 UI + 旧 relay | 设备/清单请求报 `unknown_type`/无应答 → 前端按降级展示（仅房间列表） |

## 10. 明确不支持（wontfix-by-design）

以下五项经功能映射审查（第二版 §五）定性为**永久不支持**，成文登记：它们不是「未做」，是「不做」——协议与 UI 都不为其预留通道，后续复审引用本节即可，不再逐项重新发现。

- **本机与远程竞速应答（O3，死路）**：不支持本机与远程对同一个对话框同时抢答。pi 的 dialog 只有一个应答出口，竞速裁决不可控；远程应答只走 O2 接管语义（开关打开且有 viewer 在线时由远程接管，本机不再弹）。
- **SDK 自研宿主（O5，排除）**：不自研 SDK 宿主另起进程跑会话。Pi-Remote 的形态是附着正在运行的 pi 进程做镜像与注入，自研宿主等于另写一个 pi，不纳入路线。
- **按键直通（无通道）**：不透传原始按键/终端按键序列。协议只有消息与命令通道，没有按键级通道，本机终端的按键（含控制键）不经 Pi-Remote 传递。
- **pi 内建选择器状态镜像（无信号）**：不镜像 pi 内建选择器（设置/模型选择器等）的状态。这类选择器不走 ctx.ui，连方法 tap 都碰不到，无信号可采、仓库内无解；本机开着这类选择器时远程零感知属预期行为。
- **custom / 工厂 / renderer 的内容映射（硬界）**：不映射依赖本机代码渲染的内容。custom 条目、工厂函数产物与自定义 renderer 的呈现逻辑只在本机侧，无法经协议序列化到远程 UI；远程只呈现协议可表达的结构化内容。
