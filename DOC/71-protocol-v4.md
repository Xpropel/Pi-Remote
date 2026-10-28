# 协议 v4（第一轮）：握手、错误码、消息 id、设备令牌

> 这是三端共同遵守的契约。机器可读部分（版本、能力、错误码、上限）在 `protocol/v4.json`，是唯一事实源；
> `relay/protocol.json` 与扩展里的 `PROTOCOL` 块由 `node protocol/sync.cjs` 生成，`test/protocol.test.js` 保证不过期。
> 背景与分期见 `DOC/71-protocol-v4.md`。Linux 端已纳入，形态是服务器式（阿里云 Ubuntu 24.04、无桌面、tmux 拉起），设计写在 `deploy/README.md`（Linux 端负责人起草）。

## 0. 兼容原则

1. **不改名、只加字段**：v3 的帧名和字段全部保留，本轮只新增字段和少量新帧。
2. **按能力启用**：新帧/新字段只在对方声明了对应能力（`caps`）时才发；收到不认识的字段一律忽略。
3. **旧客户端照常工作**：`auth` 不带 `proto` 视为 v3，relay 对它保持 v3 行为。旧扩展、旧 attach、旧网页都要能连新 relay。
4. **网页随 relay 部署**（同源托管），所以网页可以假定 relay 是同一版；但仍按 `caps` 判断，便于回滚。

## 1. 握手

客户端第一帧（三种客户端都加这三个字段）：

```json
{ "type": "auth", "role": "viewer" | "local", "proto": 4,
  "caps": ["err.v4", "msg.cid", "device.token", "room.label", "sync.v3"],
  "client": { "kind": "viewer" | "extension" | "attach", "version": "4.0.0", "platform": "windows" | "macos" | "linux" },
  "token": "<viewerToken 或旧的 localToken>",
  "deviceId": "<v4 设备鉴权时>", "deviceToken": "<v4 设备鉴权时>" }
```

relay 回：

```json
{ "type": "auth_result", "ok": true, "proto": 4, "caps": ["err.v4", "msg.cid", "device.token", "room.label", "sync.v3", "health"],
  "boot": "<relay 进程实例>", "auth": "token" | "legacy",   // local 通道才有 auth
  "deviceId": "<v4 设备鉴权成功时回显>" }
```

- 失败：`{type:"auth_result", ok:false, error:"<文案>", code:"auth_failed"|"device_revoked"|"device_mismatch"}`，随后关闭（4003）。
- 扩展/attach 看到 relay 的 `caps` 含 `sync.v3`、`room.label` 就直接启用对应路径，**不再**用"等 `room_registered` 超时"或"解析 unknown_type 文案"去猜；relay 没带 `proto`（旧版）时才保留原来的猜测逻辑。
- 网页看到 `caps` 缺某项，就关掉依赖它的界面，而不是收到任意 `unknown_type` 就整体降级。

## 2. 错误

- 错误码表：`protocol/v4.json` 的 `errors`（码 → 默认中文文案、是否可重试）。新增码必须先加到这里。
- **viewer 通道**：
  - 请求失败的回包仍是 v3 的两种形状，但 v4 下 `code` 必填：
    - 命令/写操作：`{type:"ack", id, ok:false, error:"<给人看的文案>", code:"<码>", retryable?:true}`
    - 查询/协议级：`{type:"error", id?, code, message, retryable?}`
  - relay 收到扩展没带码的失败（旧扩展），填 `internal`；文案原样保留。
- **local 通道**：扩展的 `command_result{ok:false}` 带 `code`；扩展内部用 `RemoteError(code, message)` 抛错，未分类的异常记 `internal`。
- 网页显示错误时，优先用服务端给的文案；需要按类型做交互（比如"busy 就提示改用 steer"）一律看 `code`，**禁止**正则匹配文案。

## 3. 消息 id（cid）

能力：`msg.cid`。目的：同样内容发两次也能各自对上号。

| 环节 | 帧 / 字段 |
|---|---|
| 网页发消息 | `command{command:"prompt"|"steer"|"follow_up", args:{message, cid}}`（`cid`：网页生成，`[A-Za-z0-9_-]{1,64}`）。旧的 `message` 快捷帧也可带 `cid` |
| relay 入口校验 | `cid` 形状不合法 → 直接回 `bad_args`，不转发（网页自己生成的 cid 不会不合法，坏输入早拒绝） |
| relay → 扩展 | 命令 `args` 原样转发；`message` 帧只对握手里声明了 `msg.cid` 的扩展带上 `cid`（旧扩展收到的帧不变）。扩展对不合法的 cid 仍按"没有"处理（防御） |
| 扩展回显 | `room_event.event = {type:"remote_message", text, at, cid}` |
| 送达确认（新） | `{type:"remote_message_delivered", cid, at}`：扩展观察到这条消息真正进了 pi（开回合或消费排队）时发，关键帧 |
| 失败 | `{type:"remote_message_failed", text, error, code, at, cid}`（顶层帧形状同理加 `cid`、`code`） |
| relay 存储 | `remote` 记录存 `cid`；失败按 `cid` 摘掉回显（没有 `cid` 时退回按文本）；pi 的 user `message_end` 取代回显时，同文本有多条按**先进先出**取最早一条 |
| 网页 | 乐观气泡按 `cid` 标记：发送中 → 已回显 → 已送达 / 失败；最终由 user `message_end` 取代（同文本先进先出） |

扩展的送达匹配：仍然只能观察 pi 的 user 消息文本，但同文本有多条待确认时按先进先出确认，确认到哪条就回哪条的 `cid`。

## 4. 设备令牌与配对

能力：`device.token`。目的：每台设备自己的令牌，拿到一台的令牌不能冒充另一台。

### 4.1 配对流程

1. 网页（已鉴权的 viewer）发 `{type:"pair_create", id, name?}` → relay 回 `ack{ok:true, data:{code, expiresAt}}`。
   配对码 8 位，字符集见 `limits.pairCodeAlphabet`（去掉了 0/O/1/I），展示为 `XXXX-XXXX`，10 分钟有效，**只能用一次**，只存在 relay 内存里。
2. 本机执行 `attach --pair XXXX-XXXX`（Windows `node deploy\attach.cjs --pair …`，macOS / Linux `deploy/attach.sh --pair …`）：
   连 7001，**第一帧**发 `{type:"pair", proto:4, code, device:{id?, name, platform}}`（不需要先 auth）。
   - `device.id`：本机 `.env` 已有 `PI_REMOTE_DEVICE_ID` 就带上（保留原有名册和会话清单），没有则由 relay 生成 uuid。
3. relay 校验配对码 → 签发 `deviceToken`（32 字节随机，base64url）→ 回 `{type:"pair_result", ok:true, accountId, deviceId, deviceToken}` → 关闭这条连接。
   失败：`{type:"pair_result", ok:false, code:"pair_invalid"|"pair_expired", error}`。
4. attach 把 `PI_REMOTE_DEVICE_ID`、`PI_REMOTE_DEVICE_TOKEN` 写进 `.env`（已有的行就地替换），提示重启 pi。
   `start-pi.cmd` / `start-pi.sh` 会把它们导出给 pi，扩展据此鉴权。

### 4.2 服务端存储与鉴权

- 令牌只存哈希：`data/accounts/<account>/device-tokens.jsonl`，行 `{kind:"token", deviceId, hash:sha256hex, createdAt, revokedAt?}`；同一设备重新配对时旧令牌全部作废。
- local 通道 v4 鉴权：`auth{role:"local", proto:4, deviceId, deviceToken}` → 哈希比对（定时安全比较）→ 连接绑定 `deviceId`。
- 绑定之后：`device_register.device.id`、`room_register.room.deviceId`、`session_manifest.deviceId` 必须等于绑定的设备，否则回 `error{code:"device_mismatch"}` 并丢弃该帧。
- 旧的共享 `localToken` 仍可登录（兼容期），连接标记为 `legacy`；`PI_REMOTE_ALLOW_LEGACY_LOCAL=0` 时拒绝。
- 撤销：网页发 `{type:"device_revoke", id, deviceId}` → 作废该设备全部令牌，断开它的窗口和扩展连接，回 `ack`。

### 4.3 名册字段

`room_list.devices[]` 每项新增：`auth: "token" | "legacy" | null`（当前在线连接的鉴权方式；离线为 null）、`paired: boolean`（是否有有效令牌）。

**后加字段（additive，不升 proto、不改帧名）**：`latencyMs: number | null` —— 设备↔relay 的平滑延迟，整数毫秒。

- 数据源：relay 保活（`relay/conn.js` 的 `keepaliveSweep`）对 local 连接的 `ws.ping()` / `pong` 实测 RTT，按 EMA（新样本占 0.3）平滑后取整，存在该连接的 `ws._state.latencyMs`；`buildDeviceList` 从设备窗口连接（`dev.conn._state`）读出。
- 只在**设备在线且至少回过一次 pong** 时给数字。离线、连接刚建立还没样本、`_state` 不存在时一律 `null`（不写 0、不外推、不复用上一轮连接的值）。
- `room_list.devices[]` 与 `auth_result.devices` 同源（都走 `buildDeviceList`），两处都带该字段；未登记设备的伪条目仍是 `{id, online}`，不带该字段。
- 旧客户端忽略未知字段即可；`/healthz` 不变（只给计数）。
- 采样节奏是保活固定的 30s 一轮，所以新连上的设备最多要等一轮才有第一个数字。

## 5. 健康检查

能力：`health`。`GET /healthz`（viewer 端口，无需 token）→
`{ok:true, proto:4, version, uptimeSec, rooms:{online, total}, devices:{online, total}, viewers}`。只给计数，不给房间名、路径、设备名。部署脚本的回环验证改用它。

## 6. local 通道帧全表（v3 现状 + v4 增量）

扩展（`client.kind=extension`）与 attach 窗口（`client.kind=attach`）共用 7001。

| 方向 | 帧 | 字段 | 说明 |
|---|---|---|---|
| ↑ | `auth` | 见 §1 | |
| ↑ | `pair` | 见 §4.1 | v4，仅 attach，作为第一帧 |
| ↑ | `device_register` | `accountId, device{id,name,platform,projects,windowExpiresAt}` | attach 窗口；v4 下 id 必须等于绑定设备 |
| ↑ | `room_register` | `room{id,label,cwd,epoch,instance,generation,accountId,deviceId,deviceName,platform}` | 扩展；绑定/换代/重连时发 |
| ↑ | `sync` | `room` | 轻量对齐探测（`sync.v3`） |
| ↑ | `snapshot` | `room, busy, messages[], truncated?, dropped?, mode?:"append", base?:{count,hash}` | 全量或补尾部 |
| ↑ | `event` | `room, event` | 事件；`event.type` 见 data-interface §5，另加 `remote_message_delivered`（v4） |
| ↑ | `state` | `room, busy` | 忙闲 |
| ↑ | `usage` | `room, usage` | footer 用量 |
| ↑ | `room_label` | `room, label` | 改名（`room.label`） |
| ↑ | `session_manifest` | 见 data-interface §4.12.4 | |
| ↑ | `command_result` | `room, id, ok, data? | error, code` | v4：失败必带 `code` |
| ↑ | `remote_message_failed` | `room, text, error, code?, cid?` | 会话切换窗口内报回原房间 |
| ↑ | `room_closed` | `room` | |
| ↑ | `pong` | | |
| ↓ | `auth_result` | 见 §1 | |
| ↓ | `pair_result` | 见 §4.1 | v4 |
| ↓ | `room_registered` | `room, msgCount, firstHash, lastHash, tailHashes` | 对齐锚点（`sync.v3`） |
| ↓ | `snapshot_request` | `room, reason` | 补尾部锚点不符，要全量 |
| ↓ | `resend_snapshot` | `room` | 有观众订阅但内存里没正文 |
| ↓ | `message` | `room, text, cid?` | 快捷注入（v4 带 `cid`） |
| ↓ | `command` | `id, room? | deviceId?, command, args, timeoutMs` | |
| ↓ | `abort` | `room` | |
| ↓ | `device_replaced` | | 同设备新窗口顶替旧窗口 |
| ↓ | `error` | `code, message` | |

## 7. viewer 通道新增

| 帧 | 方向 | 回包 |
|---|---|---|
| `pair_create{id, name?}` | ↑ | `ack{data:{code, expiresAt}}` |
| `device_revoke{id, deviceId}` | ↑ | `ack` |
| `auth_result.proto / caps` | ↓ | |
| `room_list.devices[].auth / paired` | ↓ | |
| `room_event.event.type = remote_message_delivered` | ↓ | |

## 8. 开发约定

- 改动前先跑 `npm test`；前端另跑 `cd ui && npx tsc -b && npx oxlint && npm run build`。
- 新增远程命令/错误码时先更新 `protocol/v4.json`，再运行 `npm run sync:protocol`。

## 9. P9 增量（relay 侧：等待摘要 / 删除清理 / 目录浏览）

能力、错误码、上限的机器可读定义已由 protocol 基础提交登记进 `protocol/v4.json` 并同步；
本节只写 relay 的行为契约（实现见 `relay/rooms.js`、`relay/views*` 相关函数、`relay/purge.js`、
`relay/viewer.js` 的 `routeDeleteSession`、`relay/devices.js`）。

### 9.1 A：`room.dialogs`（relay 与网页声明，relay 已实现）

- `room_list.rooms[]`（含 `auth_result.rooms`、`list_rooms` 回包）给声明了本能力的连接多带：
  - `waiting[]`：`{dialogId, kind, startedAt, title?, timeout?, answerable?}`，只列在线房间的多槽 dialog 缓存，
    **不带** `options/message/prefill` 等正文面；离线房间恒为 `[]`；
  - `waitingPrompt`：`{kind, title, at} | null`，旧单槽 `ui_prompt` 的兜底信号（`at` 是 relay 收到
    `ui_prompt_start` 的时间），只在 `waiting` 为空时非 null。
- 新帧 `room_waiting`：`{type, room, waiting, waitingPrompt}`，发给 `rooms.viewers` 里所有声明
  `room.dialogs` 的连接（不按订阅过滤，听众与 `room_attention` 相同）；每帧全量，摘要变化时广播。
- 字段按连接能力组合裁剪：无 `room.attention` 去 `lastTurnEnd`；无 `room.dialogs` 去
  `waiting/waitingPrompt`；无 `dialog.respond` 去 `waiting[].answerable`。`broadcastRoomList`
  按能力组合分组（最多 8 组）各算一份副本；设备窗口连接固定拿「什么能力都没有」的那份。

### 9.2 B：`session.purge`（relay 与网页声明，relay 已实现）

- 网页设备级删除：`{type:"command", id, deviceId, command:"delete_session", args:{sessionId}}`。
  relay 的 `routeDeleteSession` 四条路由（顺序固定）：
  1. attach 在线且声明 `session.files` → 交给 attach 在整个会话根目录里删；
  2. 否则按目标会话 `cwd` 找同目录在线房间 → 交给那个扩展删（R25 老路，`args.sessionPath`）；
  3. 设备在线但 attach 无 `session.files` → `device_update_required`；
  4. 设备离线 → `device_offline`。
  - 目标 id 的在线房间存在 → `session_running`；索引里已不存在 → 回
    `ack{ok:true, data:{status:"already_deleted", method:null}}` 并照常清残留副本（幂等）。
- 删除成功（attach/扩展回 `ok`）后，relay 在给网页回执之前清服务器副本：名册里的离线房间、
  `data/rooms/<id>.jsonl` 与检查点、`dev.archives` 会话库正文、索引旧行（只留
  `{kind,id,deleted,updatedAt}` 最小墓碑）。然后向声明 `session.purge` 的连接广播
  `session_removed{deviceId, ids[]}` 并刷新 `room_list`。在线房间永远跳过。
- 旧网页按房间寻址的 `delete_session` 继续支持，也走同一清理入口（会话 id 由 `sessionPath`
  文件名最后一个 `_` 之后、`.jsonl` 之前那段反推）。
- `device_register.device` 新字段：`trash: boolean`、`browse:{roots:string[]}`；relay 存成
  `dev.trash` / `dev.features` / `dev.browseRoots`，并在 `room_list.devices[]` 下发
  `features: string[]`（`session.files`、`fs.browse` 的交集，仅在线时非空）、`trash: boolean`、
  `browseRoots: string[]`（仅在线时非空）。
- attach 的全量 `session_manifest` 可带 `scope:"device"` 与 `root:"<会话根目录绝对路径>"`：
  relay 在 `full && !truncated` 时把 root 下「这一帧没出现、还没删除」的会话打成墓碑（反向同步），
  返回里的 `tombstoned[]` 直接喂同一套清理；root 以外的行不动。设备重新出现的会话从墓碑恢复
  （行 `updatedAt` 取 `max(帧里值, 墓碑时间+1)`）。
- `RELAY_CAPS` 现在声明 `room.dialogs`、`session.purge`。`session.files` / `fs.browse` 是 attach
  声明、relay 只转发的能力，**不在** relay 的 caps 里（经 `room_list.devices[].features` 透传）。

### 9.3 C：`fs.browse`（attach 声明，relay 只转发）

- 新设备命令 `list_dirs{path?, showHidden?}`：relay 只转给声明 `fs.browse` 的 attach
  （超时 8s，`DEVICE_COMMANDS` 白名单）；没声明的回 `device_update_required`，不会落进
  「交给扩展房间」的分支。回包 `data:{root, path, parent, entries:[{name,path}], truncated}`。
- `harness_start{cwd}` 放宽：`cwd` 在白名单里，**或者**设备声明了 `fs.browse` 且 `cwd` 在
  `browseRoots` 下（relay 用 `underRoots` 粗查，attach 按真实路径复查）。错误码见
  `protocol/v4.json` 的 `fs_outside_root / fs_not_found / fs_not_dir / fs_denied / browse_disabled`，
  上限 `dirListMax / dirNameMax / browseRootsMax`。

### 9.4 D：`settings_set`（扩展侧设置写桥，additive）

- **性质**：additive。不新增帧名、不升 `proto`、不新增 caps、不改 relay；旧 relay 原样转发，
  旧扩展回 `unknown_command`。UI 不需要按能力位开关，按命令成功/错误码即可判断写桥是否可用。
- **契约**：`command:"settings_set"`，`args.settings` 为白名单补丁（兼容 `args.patch` / 平铺）；
  成功回 `{ok:true, applied:{点号扁平}, restartRequired:true, restartReason, reloadHint}`。
  只写全局 agentDir（`PI_CODING_AGENT_DIR` 或 `~/.pi/agent`）的 `settings.json`，不写项目本地设置；
  只接受白名单字段，未知/非法值一律 `bad_args`，不碰原文件；原子写、文件 0600；不回传路径/完整设置/密钥。
- **写后生效**：运行中的 pi 从内存 `SettingsManager` 读取设置，扩展 API 只有只读 `getSettings()`，
  查不到 setter/事件 ctx reload；因此写桥**不能热更新**，统一要求重启。本机 TUI 的 `/reload`
  可带上一部分设置（settingsManager.reload + syncQueueModes + 资源重载），但写桥无法触发它，
  也不是全部字段的保证。
- **白名单/证据/测试/未开放项**：见 `DOC/76-settings-write-bridge.md`。
