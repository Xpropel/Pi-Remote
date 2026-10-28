# 后端详细设计：relay 应用逻辑（设备窗口 / 清单 / 命令路由）

> 工作流：**后端** = `relay/*.js` 的应用逻辑（跑在云服务器上，但属于应用而非运维）。
> 共同契约：`DOC/50-protocol-delta.md`（先读它）。阶段归属：步 0（索引层）/ 步 1（窗口与路由）/ 步 3（收尾）。
> 本文只定义设计与接口，不含实现代码。

## 1. 模块划分与职责

| 模块 | 现状 | 本期改为 |
|---|---|---|
| `relay/index.js` | 不存在 | **新模块**：账户/设备/会话三级索引的读写（upsert/墓碑/对账/查询），JSONL 落盘 |
| `relay/server.js` | 双端口中转 + store 供给 | 帧处理增补：`device_register` / `session_manifest` / `get_sessions` / `resend_snapshot`；`command` 设备级寻址；`room_register`/`room_list` 扩展字段；配置项；`store.record` 降级 |
| `relay/store.js` | 全量正文存储 | **降级为兼容只读**：`record` 变 no-op（除非 `PI_REMOTE_PERSIST_TRANSCRIPTS=1`）；`exists/assemble` 保留一版供旧房间回看 |

### 1.1 代码分文件（协议 v4 第一轮 S6）

`server.js` 只剩装配与启动，其余按职责拆开（逐行搬运，行为不变）。依赖只往表的上方指，没有循环：

| 文件 | 职责 | 依赖（relay 内） |
|---|---|---|
| `util.js` | 日志与静音开关（`log` / `setQuiet`）、id 白名单、定时安全比较 | — |
| `config.js` | `DEFAULT_CONFIG`、`loadConfig`（config.json + 环境变量）、`normalizeAccount` | `index` |
| `wire.js` | 协议 v4：`RELAY_VERSION`、`RELAY_CAPS`、握手解析、错误帧 / `ack` / 快照帧、带背压的 `send` / `broadcast` | `util`、`config` |
| `conn.js` | 连接通用：认证超时、二进制与坏 JSON、限速、心跳 | `util`、`wire` |
| `commands.js` | 命令超时表、白名单与错误文案、等待与去重表 | `util`、`wire` |
| `devices.js` | 设备名册：平台与路径规则、白名单清洗、账号绑定、`room_list` 的设备项 | `util`、`config`、`index` |
| `pairing.js` | 配对码、配对限速的来源（`requestSource`）、设备令牌校验 | `util`、`devices` |
| `rooms.js` | `Rooms`（房间表、名册广播）、resend 兜底、图片降级、local 消息归属 | `util`、`wire`、`devices`、`index` |
| `web.js` | viewer 端口的 HTTP：静态页面、`/healthz` 正文 | `util`、`wire`、`devices` |
| `local.js` | 7001 通道：扩展与 attach 窗口的全部帧（含 `pair`） | 以上各层、`store` |
| `viewer.js` | 7002 通道：页面 WebSocket 的全部帧 | 以上各层、`store` |
| `server.js` | `startRelay`（共享 `ctx`、`Rooms`、存储与索引、定时淘汰）、`main`；对外导出和拆分前一样 | 全部 |

- 部署脚本本来就上传 `relay/` 下全部 `.js`，加文件不用改脚本；`server.js` 仍是 systemd 的入口。
- 日志静音是进程级开关：`startRelay` 按 `cfg.quiet` 调 `setQuiet`，同一进程起两个 relay 以后起的为准（和拆分前一样）。

## 2. 内存结构（`startRelay` 装配，`Rooms` 在 `rooms.js`）

```
devices: Map<deviceId, {
  accountId, name, platform, projects: string[],
  conn: ws | null,            // 窗口连接（attach 命令）
  online: boolean,
  windowExpiresAt: number | null,
  lastAttachAt: number,
  activeRoomId: string | null, // 该设备当前活动房间（room.online 的最新者）
  startInFlight: boolean       // harness_start 串行锁
}>
rooms: 现有结构扩展 { accountId, deviceId }（缺省 "未登记设备"/null）
viewerQueries: Map<reqId, {ws, timer}>  // get_sessions 的 10s 超时
```

`activeRoomId` 维护：`room_register`（该房 online）时置；`room_offline`（该房掉线）时清（若指向它）；设备断连不影响（房间独立）。

## 3. `index.js` 设计

### 3.1 文件与目录

```
data/accounts/index.jsonl                     账户行（kind=account）
data/accounts/<accountId>/devices.jsonl       设备行（kind=device）
data/accounts/<accountId>/sessions/<deviceId>.jsonl  会话行（kind=session）
```

- 路径安全：`accountId/deviceId` 过滤 `[A-Za-z0-9_-]`（其余 → `_`，截断 64）。
- 写盘策略：**追加 + 批量 flush**（复用 store.js 的 200ms 合批思路；索引写入量极小，即使立即刷也无妨——选简单：每条 manifest 一次合并写 + `fsync` 由 OS 决定）。

### 3.2 API（函数级语义）

| 函数 | 语义 |
|---|---|
| `touchAccount(accountId)` | upsert `accounts/index.jsonl` 的账户行（firstSeenAt/lastSeenAt） |
| `upsertDevice(accountId, device)` | upsert `devices.jsonl`：name/platform/projects/lastAttachAt/updatedAt |
| `listDevices(accountId)` | 读 `devices.jsonl` → Map 合并 → 数组（按 lastAttachAt 倒序） |
| `applyManifest(accountId, deviceId, {full, updatedAt, sessions[], removed[]}, nowAt)` | 见 3.3 |
| `listSessions(accountId, deviceId, {limit})` | 读会话文件 → Map 合并（墓碑标记 deleted）→ 过滤 deleted → `updatedAt` 倒序 → limit |
| `getDeviceRow(accountId, deviceId)` | 单设备行（不存在 → null，驱动 `no_device`） |

### 3.3 `applyManifest` 处理规则（核心）

1. **整帧校验**：`accountId/deviceId` 必填（缺 → 记日志丢弃）；`sessions` 非数组 → 丢弃。
2. **帧级新旧**：与内存中该设备 `lastManifestAt` 比较，更旧 → `manifest_stale` 记日志、丢弃。
3. **行级新旧**：每行与文件中已存行的 `updatedAt` 比较，更旧 → 跳该行。
4. **`full=true` 语义（权威重算）**：
   - 帧内 id → upsert（并写盘）；
   - 文件中**存在但帧内缺失**的 id → `active` 置 false 并写盘（表示"本机已无此活动态"，不删行——本机可能还有文件，只是没进最近 200）；
   - `removed[]` → 写墓碑行。
5. **`full=false`（增量）**：只 upsert 帧内行 + `removed` 墓碑。
6. **截断帧**：`truncated:true` 时不执行第 4 步的"缺失置假"（防止截断误伤）。
7. **在线标记**：`active` 行仅表示本机活动态；`online`（房间在线）由 `rooms` 现取，不落盘。

### 3.4 读路径（`get_sessions`）

1. `getDeviceRow` 为 null → `error{code:no_device}`。
2. `listSessions(limit=maxSessionsListed)` → 每行附 `online = rooms.get(id)?.online === true`。
3. 应答 `session_list`（id 原样回显）；`truncated` = 总数 > limit。
4. 查询**不要求设备在线**（读的是索引文件）；设备在线与否只改变 `online` 字段。

## 4. 帧处理详设（local 通道在 `local.js`，viewer 通道在 `viewer.js`）

### 4.1 `device_register`（local 通道）

```
1. 校验 role=local（7001 已有鉴权）+ 字段完整（accountId/device.id/name/platform）
2. 同 deviceId 已有窗口连接且 conn !== ws：
    旧 conn 发 {type:"device_replaced"} 后关闭（不碰该设备的房间连接）
3. devices.set(...)：conn=ws, online=true, windowExpiresAt, lastAttachAt=now
4. index.upsertDevice(accountId, device) + index.touchAccount(accountId)
5. 广播 room_list（devices 变化）
6. local 断连（ws close）时：若 devices.get(id).conn === ws → online=false, conn=null, activeRoomId 保留
```

- **不**在断开时写 `online:false` 到文件（文件只记名册与最近出现时间；在线态是内存态）。
- 未登记兼容：房间 register 时若无 deviceId → `devices` 视图中补固定假设备 `{id:"未登记设备", online:false}`。

### 4.2 `session_manifest`（local 通道）

- 仅接受来自该设备**窗口连接或活动房间连接**的帧（`ws._deviceId === deviceId` 或该设备某房间 local === ws）；否则丢弃记日志。
- 走 `index.applyManifest`（§3.3）；写盘失败不影响会话转发（try/catch + 日志）。
- 处理成功后**不主动广播**（清单变化由下次 `get_sessions`/`room_list` 体现；避免manifest 风暴放大）。

### 4.3 `get_sessions`（viewer 通道）

- 新请求类型：`{type:"get_sessions", id, deviceId}` → `viewerQueries` 登记 10s 超时 → 同步读索引 → 回 `session_list`（本进程内完成，无 local 往返）。
- `deviceId` 缺省 → `error{code:no_device}`。
- 限速：纳入现有 viewer 限速口径（20/s  exempt 名单外加 `get_sessions` 豁免——它是低频用户主动查询）。

### 4.4 `command` 设备级寻址

```
msg.deviceId 存在时：
  dev = devices.get(deviceId)
  !dev || !dev.online            → ack(false, device_offline)
  !dev.activeRoomId              → ack(false, device_no_active_session)
  WHITELIST 不含 msg.command     → ack(false, "该命令必须指定房间")
  room = rooms.get(dev.activeRoomId) → 走现有 command 通路（wireId/commandWaiters/超时语义不变）
msg.deviceId 缺省 → 现有 room 寻址逻辑不变
```

- `harness_start` 走**同一条通路**，但：relay 侧超时 10s（`harnessStartTimeoutMs`）；转发给 local 后本机执行拉起并回 `command_result`。
- `harness_start` 的 `already_running` 判定在**本机 attach 命令**（它知道刚拉起的进程），relay 也可预判：该 `deviceId+cwd` 已有 `online` 房间 → 直接回 `already_running{roomId}`（**不必转本机**，省一轮）。

### 4.5 `resend_snapshot`（relay→local）

- 触发点：viewer `subscribe` 一个 `online` 房间且 `room.snap` 为空/TTL 过期时。
- 发 `{type:"resend_snapshot", room}` 给该房 local；起 3s 兜底定时器：未收到 `snapshot` → 以 `{messages:[]}` + `snapshotPending:true` 应答 viewer；期间到达的 `snapshot` 自然替换（前端按 `snapshot` 帧整体重建）。
- `snapshotPending` 是新字段（`snapshot` 帧 +`snapshotPending?:boolean`），旧 UI 忽略即可。

### 4.6 `room_register` / `room_list` 扩展

- `room_register`：读 `msg.room.accountId`（缺省 `admin`）/`deviceId`（缺省 null → 展示名"未登记设备"）/`deviceName`/`platform` → 写入 `rooms[id]`。
- `room_list`：`devices = index.listDevices(admin)` 映射 + 内存 online 覆盖；房间项 +`accountId/deviceId`。`list()` 支持 `includeOffline` 维持原语义（devices 不受它影响）。
- 记忆设备"上次清单可见性"：未连接设备也要出现在 `devices[]`（来源 = 文件行）。

### 4.7 `store.js` 降级开关

- 配置 `persistTranscripts = !!process.env.PI_REMOTE_PERSIST_TRANSCRIPTS`（默认 false）。
- false：`record()` 直接 return；`flush` 定时器不启动；`exists()` 保留（旧房间订阅兼容）；`assemble()` 保留。
- true：行为与现在完全一致（回退路径）。
- `retentionDays` 清扫逻辑照旧（只清 `data/rooms`，不碰 `data/accounts`）。

## 5. 配置项（`DEFAULT_CONFIG` 增量）

| 项 | 默认 | 来源 |
|---|---|---|
| `persistTranscripts` | false | `PI_REMOTE_PERSIST_TRANSCRIPTS` |
| `accountsDir` | `data/accounts` | 固定 |
| `maxSessionsListed` | 200 | 固定 |
| `harnessStartTimeoutMs` | 10000 | 固定 |
| `resendSnapshotWaitMs` | 3000 | 固定 |
| `deviceWhitelist` | `switch_session/new_session/fork/clone/get_state/get_sessions/harness_start` | 固定（代码内常量） |

## 6. 与既有机制的关系（不变清单）

`ack` id 匹配与去重表（boot+id）、命令 16s 默认超时（`harness_start` 除外）、`regenerate/compact` 90s、限速豁免表（增量：`get_sessions`）、慢消费者终止、`usage_state` 广播、epoch/generation、图片降级、`ESSENTIAL_FORWARD`——**全部不改**。

## 7. 错误与边界

| 情况 | 行为 |
|---|---|
| manifest 来自未登记设备（无 deviceId） | 丢弃 + 日志（不建索引） |
| `accountId` 非 admin（将来多账户） | 本期照单全收但归到该账户目录；UI 只展示 admin |
| `get_sessions` 时索引文件不存在 | 返回空 `sessions[]`（不是错误——设备登记过但没上报过） |
| 窗口连接与房间连接同一 ws（不可能：协议分流） | 防御性判断：`ws._deviceId` 与 `ws._room` 互斥 |
| 磁盘写失败 | try/catch + 日志；不影响转发主链路 |

## 8. 测试与验收（后端侧）

**单元级（relay 进程内，假帧驱动）**：
1. `applyManifest`：upsert 覆盖 / 墓碑 / `updatedAt` 旧帧丢弃 / `full` 缺失置假 / 截断帧不致误 / 行级新旧。
2. `get_sessions`：未连接设备可读 / `online` 标注 / limit 截断 / `no_device`。
3. `device_register`：登记 / 同 id 顶替（旧连接收到 `device_replaced`）/ 断开只改内存。
4. `command` 寻址：`device_offline` / `device_no_active_session` / 白名单外拒绝 / 正常路由到活动房间。
5. `harness_start`：`already_running` 预判（本进程内直接回，不转本机）/ 10s 超时 ack。
6. `resend_snapshot`：3s 兜底 / 快照后到替换。

**E2E（沿用现有一整套，假设备/假扩展连接 7001）**：
7. 假窗口连接 register → `room_list.devices` 出现且 online=true；断开 → online=false。
8. 假扩展发 manifest（full+增量+墓碑）→ 假 viewer `get_sessions` 三轮断言。
9. 真 keeper（`pi --mode rpc`）+ 真扩展：窗口门控关闭时扩展不连（等步 1 联调）。
10. 回归：现有 72 项 E2E 全过（协议加法式不破坏旧路径）。

## 9. 文件级改动清单

| 文件 | 改动 |
|---|---|
| `relay/index.js` | 新建（§3） |
| `relay/server.js` | §4 各帧分支；内存结构扩展；配置项；`store.record` 开关；`room_list` 结构 |
| `relay/store.js` | `record` no-op 化（按开关）；其余不动 |
| `relay/config.example.json` | 增补说明（不含密钥） |
| 部署 | `deploy-relay.ps1` 增加上传 `index.js`（服务器端文档 §4） |

## 10. 协议 v4 第一轮：握手与错误码（relay 侧）

契约见 `DOC/71-protocol-v4.md` §1–§2；码表、能力名、上限在 `relay/protocol.json`（`node protocol/sync.cjs` 从 `protocol/v4.json` 生成，勿手改）。

### 10.1 握手

- 读 `auth.proto / caps / client`：`proto` 缺省或低于 `minProto` 按 v3，高于本 relay 的按本 relay；`caps` 只留协议里有的名字；`client` 只留 `kind/version/platform` 短串。三者存在连接状态上，认证日志带一行 `proto=… client=…`。
- 成功回包两条通道都带 `proto`、`caps`、`boot`；local 另带 `auth:"legacy"`（共享 localToken 登录；设备令牌落地后才有 `"token"`）。v3 客户端不认识这些字段，忽略即可。
- `caps` 取自 `wire.js` 的 `RELAY_CAPS`，**只列已实现的能力**：目前是第一轮的全部六项（`device.token`、`err.v4`、`health`、`msg.cid`、`room.label`、`sync.v3`）。以后的新能力在实现它的同一次提交里再加——对方会照着声明的能力发新帧。
- 失败：`auth_result{ok:false, error, code:"auth_failed"}`，随后以 4003 关闭。

### 10.2 错误码

所有失败经两个出口发出：`errorFrame(code, message, {id, room, deviceId})`（查询/协议级 `error` 帧）和 `ackFrame(id, false, {error, code})`（命令/写操作）。出口统一做三件事：缺码填 `internal`；码表里可重试的加 `retryable:true`（不可重试的不带这个字段）；没给文案时用码表默认文案。

| 场景 | 帧 | code |
|---|---|---|
| 鉴权失败 / 10s 未鉴权 | `auth_result` / `error` | `auth_failed` / `auth_timeout` |
| 二进制帧、非 JSON、限速 | `error` | `binary_not_allowed` / `bad_json` / `rate_limited` |
| 未知帧 | `error` | `unknown_type`（文案保留帧名：旧扩展靠它判断 relay 认不认 `room_label`） |
| 帧处理抛异常 | `error` | `server_error` |
| local：`device_register` 字段不全或连接已绑房间；`room_register` id 非法或连接已是设备窗口 | `error` | `bad_args`（原来的 `bad_device` / `bad_room` 不在码表里，也没有客户端依赖它们） |
| `message` / `command` / `abort` 房间不存在 | `ack` | `no_room` |
| 空消息；设备命令参数二选一不满足；设备级不允许的命令 | `ack` | `bad_args` |
| 房间的本机未连接 | `ack` | `room_offline` |
| `harness_start` 时设备窗口不在 | `ack` | `device_offline` |
| `harness_start` 串行锁占用 | `ack` | `harness_busy` |
| 命令超时 | `ack` | `timeout` |
| 本机断开，在飞命令结果未知 | `ack` | `result_unknown` |
| `history`（已废弃） | `ack` | `unsupported` |
| 本机 `command_result` 失败 | `ack` | 透传本机给的码；没带（旧扩展）填 `internal`，文案原样 |
| `remote_message_failed`（顶层帧和 `event` 两条路） | `room_event` | 同上 |

设备命令的 `no_device` / `device_offline` / `device_no_active_session` / `cwd_not_allowed` / `session_not_found`，`get_sessions` 的 `no_device` / `timeout` / `server_error`，`subscribe` 的 `no_room` / `room_full` 保持原样，只是多了 `retryable`。

`test/relay.test.js` 有一条扫源码的测试：`relay/*.js` 里写死的码必须都在码表里。要新增码，先改 `protocol/v4.json`（指挥官名下）再 sync。

### 10.3 消息 cid（`msg.cid`）

`cid` 由网页生成，格式 `[A-Za-z0-9_-]{1,cidMax}`，校验函数是 `store.js` 的 `cleanCid`。

| 环节 | relay 做什么 |
|---|---|
| viewer `message` 帧带 `cid` | 不合法回 `ack{code:"bad_args"}`、不转发；合法的只在扩展声明了 `msg.cid` 时放进转给扩展的 `message` 帧（旧扩展收到的帧不变） |
| viewer `command` 的 `prompt` / `steer` / `follow_up` | `args.cid` 不合法回 `bad_args`；合法的随 `args` 原样转发 |
| local `event`：`remote_message` / `remote_message_delivered` / `remote_message_failed` | 不合法的 `cid` 删掉，合法的原样转给观众；`remote_message_delivered` 不进存储，按关键帧发（不会因为观众积压被跳过） |
| local 顶层 `remote_message_failed` | 合法的 `cid` 带进转给观众的事件，并按它摘回显 |
| 存储 | `remote` 行存 `cid`，快照里的回显消息带 `cid`；失败带 `cid` 只摘这一条（对不上就不摘），没有 `cid`（旧扩展）退回按文本摘最近一条；pi 的 user 消息取代回显时，同文本多条按先进先出取最早一条，重开索引（没有 drop 行的旧文件）也按同一规则 |

### 10.4 设备令牌与配对（`device.token`）

契约见 `DOC/71-protocol-v4.md` §4。

**配对码**：viewer `pair_create{id, name?}` → `ack{data:{code:"XXXX-XXXX", expiresAt}}`。码只在内存（`ctx.pairCodes`），字符集和长度取 `limits`，有效期 `cfg.pairCodeTtlMs`（默认取 `limits.pairCodeTtlMs`，测试可调短），同时最多 20 个未用的码；日志不打印码本身。

**pair 帧**（7001，未鉴权连接的第一帧）：

1. 按来源限速：这个来源一分钟内失败满 10 次 → `pair_result{code:"rate_limited"}`，拿着真码也一样（码不作废）；别的来源不受影响。
   来源（`requestSource`）是对端 IP，IPv4 映射地址还原成 IPv4，IPv6 按 /64 算一个；对端是回环且带 `X-Forwarded-For`（本机反代，比如 Caddy 把 `wss` 转到 127.0.0.1:7001）时取最后一跳，对端不是回环不认这个头（客户端能随便写）。
   失败记账只在内存（`ctx.pairFailures`：来源 → 最近一分钟的失败时间），最多记 1000 个来源，满了挤掉最久没出错的；定时器顺手清掉过了窗口的。
2. 码不分大小写、忽略空格和短横线；查不到 → `pair_invalid`，过期 → `pair_expired`（两者都计入这个来源的失败次数，日志 `配对失败:` 带来源）。
3. `device.name`（缺省用 `pair_create` 的 `name`）和 `device.platform` 必填，`device.id` 可选（只能是 `[A-Za-z0-9._-]`），否则 `bad_args`，码不作废。
4. 没带 `id` 时 relay 生成 uuid；生成 32 字节令牌（base64url），sha256 写进 `device-tokens.jsonl`（同一设备的旧令牌一并作废），设备写进名册（`name/platform`），然后码作废。写盘失败回 `server_error`，码保留可重试。
5. 用这台设备旧令牌连着的连接全部断开（先发 `error{code:"device_revoked"}`，再 4003）。
6. 回 `pair_result{ok:true, accountId, deviceId, deviceToken}` 后关闭连接（1000），广播 `room_list`。

**local 鉴权**：

| auth 帧 | 结果 |
|---|---|
| 带 `deviceToken` | 只按令牌认，失败不退回共享 token。令牌 sha256 与账号下每一行定时安全比较：对不上 `auth_failed`；属于别的设备 `device_mismatch`；属于这台但已作废 `device_revoked`。成功 → `auth:"token"`、回显 `deviceId`，连接绑定这台设备 |
| 只带 `token`（共享 localToken） | `cfg.allowLegacyLocal`（`PI_REMOTE_ALLOW_LEGACY_LOCAL=0` 关）为真时通过，`auth:"legacy"`；否则 `auth_failed` |

失败都是 `auth_result{ok:false, code, error}` 后 4003 关闭。

**绑定**：令牌登录的连接发 `device_register`（`device.id`）、`room_register`（`room.deviceId`，缺省也算不符）、`session_manifest`（`deviceId`）时，设备不是绑定的那台 → `error{code:"device_mismatch"}`，丢帧、连接保留。账号取令牌所在账号。共享 token 登录的连接不受这条约束（兼容期）。

**撤销**：viewer `device_revoke{id, deviceId}` → 缺 `deviceId` 回 `bad_args`；名册、内存、令牌表里都没有这台 → `no_device`；否则作废它的全部令牌、断开它的窗口和扩展连接（不论哪种鉴权），回 `ack{data:{revoked, closed}}` 并广播 `room_list`。

**名册**：`room_list.devices[]` 每项加 `auth`（在线窗口连接的鉴权方式，`"token"` / `"legacy"`，离线 `null`）和 `paired`（有没有有效令牌）。"未登记设备"那一项保持 `{id, online}`。令牌表整份缓存在内存（`AccountIndex.tokenCache`，先写盘再更新缓存），所以每次广播名册不读盘。

### 10.5 健康检查与索引缓存（`health`）

**`GET /healthz`**（7002，`GET`/`HEAD`，不要 token）→ `{ok:true, proto, version, uptimeSec, rooms:{online,total}, devices:{online,total}, viewers}`，`Cache-Control: no-store`。

- `rooms` 按 `rooms.list()` 数（和观众看到的房间列表一致，快被淘汰的离线房间不算）；`devices` 按名册数，不含"未登记设备"那一项；`viewers` 是已鉴权的观众连接数。
- `version` 是 `relay/wire.js` 里的常量 `RELAY_VERSION`（部署只带 `relay/`，服务器上的 `package.json` 不跟着更新，不能用它）；`uptimeSec` 从这个 relay 实例启动算起。
- 只给计数和版本：没有房间名、路径、设备名、id。

**索引缓存**：`AccountIndex` 把 `index.jsonl`、各账号 `devices.jsonl`、各设备 `sessions/*.jsonl` 的合并结果按文件缓存在内存（`fileCache`）。第一次用到时读一次文件，之后的查询（`findDevice` / `listDevices` / `getDeviceRow` / `listSessions` / `getSession`，以及每次广播名册）都不读盘。写穿透：先追加落盘，成功后再改缓存，然后照旧按体积压缩（压缩用缓存里的合并结果重写文件）。`applyManifest` 在缓存的副本上对账，写盘失败时缓存不变。读文件失败（ENOENT 以外）不缓存，下次再读。代价：运行期间手改这些文件不会生效，要重启 relay。
