# 会话登记（Session Registry）：服务端索引层设计

> **执行期**：索引文件布局以 `DOC/10-relay-backend.md` 与 `DOC/00-overview.md` 为准（`accounts/admin` 目录形式：`data/accounts/index.jsonl`、`data/accounts/admin/devices.jsonl`、`data/accounts/admin/sessions/<设备>.jsonl`）。本文是概念设计，不单独作为落地路径依据。

> 本文是 harness 的**会话管理组件**规范：服务器只保存「账户 → 设备 → 会话清单」三级索引（KB 级），
> **不再保存任何对话内容**；对话内容的唯一副本在本机。
> 设备与连接模型以 `DOC/device-harness.md` 为准，传输层细节仍以 `readyUI/data-interface.md` 为准，
> 落地时把新增帧补进那份契约。

## 1. 为什么要改（成本）

现状：relay 把每个房间的**全量对话**按消息级 JSONL 落盘（`data/rooms/<roomId>.jsonl`，30 天保留），
快照装配/seed-merge/迟到 viewer 的回放都依赖它。对一个天天用的开发者，这是**每月 GB 级的持续写入**：

| 成本项 | 现状 | 问题 |
|---|---|---|
| 磁盘 | 每会话一份全量 jsonl（长会话 MB 级），30 天滚动 | 服务器从"转发方"变成"对话备份"，私人部署也要为它买盘 |
| CPU/IO | **每条消息**（含流式 `message_end`）都要 record + 定期 flush | 通道上最频繁的事件恰好是它 |
| 存储语义 | 服务端存的是"历史回放"能力 | 实测价值很低：`rooms.list()` 默认只列在线房间（server.js:186-193），离线房间 6 小时无观众即被 evict（`roomIdleEvictMs`），evict 后 label/cwd 也丢——**离线回放 today 几乎是残的** |

内容在本机（session 文件就在那台电脑上），服务器没有任何理由当第二份副本。**服务器只配做索引**。

## 2. 新模型（一句话 + 图）

```
服务器持久化 = 索引（KB 级）          内存 = 在线房间的工作态
  账户文件：账户 → 设备名册              活跃房间的快照缓存（RAM，迟到 viewer 用）
  设备会话文件：设备 → 对话清单          在线状态/观众/限速（现状不变）
本机 = 内容唯一副本（session jsonl + pi 进程）
查看端 = 看索引浏览 → 下命令让设备恢复会话 → 镜像（现状协议）
```

三条原则：

1. **服务器永不存对话正文**（配置可回退，见 §8）。
2. **清单的唯一事实源在本机扩展**（`SessionManager.list` 官方 API，count 准确）；relay 只汇总，不推断。
3. **"打开一个会话" = 窗口内让设备把它拉起来**（`harness_start{deviceId, sessionId}`：用该 session 文件起一份 pi → 扩展登记 → 房间上线），不是从服务器读历史——设备没在窗口内，什么都做不了。

## 3. 数据布局与文件格式

```
data/
├── accounts/index.jsonl                      # 一行一账户：这个 relay 上出现过的账户
├── accounts/admin/devices.jsonl              # 一行一设备（upsert）：该账户的设备名册
└── accounts/admin/sessions/<设备>.jsonl      # 一行一会话（upsert/墓碑）：该设备的对话清单
```

按账户分目录（不用扁平拼接；本期目录名为 `admin`）：`accountId`/`deviceId` 落盘前做文件安全过滤（`[A-Za-z0-9_-]`，其余替换为 `_`，超长截断）。

**行格式**（每行一个 JSON，追加式；按 id upsert，读时后行覆盖前行）：

```jsonc
// data/accounts/admin/devices.jsonl —— 设备名册
{ "kind": "device", "id": "<deviceId>", "name": "Windows", "platform": "windows",
  "projects": ["D:\\pi-myself"], "online": false, "lastSeenAt": 1791437613000,
  "updatedAt": 1791437613000 }

// data/accounts/admin/sessions/<设备>.jsonl —— 会话清单
{ "kind": "session", "id": "<sessionId>", "path": "C:/.../<sessionId>.jsonl",
  "name": "重构 relay 存储", "cwd": "D:\\pi-myself", "firstMessage": "我们来重构…",
  "messageCount": 128, "sizeBytes": 86016, "createdAt": 1791400000000,
  "updatedAt": 1791437613000, "active": true, "deleted": false }
```

规则：

| 规则 | 说明 |
|---|---|
| upsert | 同行 id 后写覆盖先写；读 = 全表扫 + Map 合并（沿用现有 store 的 scan/merge 思路） |
| 墓碑 | 本机删除会话 → 写 `{"deleted":true}` 一行，不物理删行（乱序保护 + 可恢复） |
| `updatedAt` 单调 | 每条带本机时钟；relay 收到**更旧**的 upsert 时丢弃（防旧重连帧覆盖新状态） |
| `full` 对账 | 扩展每次连接发一次全量清单（`full:true`），relay 用它做"该设备会话集合"的权威重算 |
| compaction | 单文件超过 N 行（如 5000）且墓碑/覆盖行过半时，读时顺带重写压缩（低优先级，可后置） |
| 保留 | 索引文件不过期（KB 级无所谓）；`retentionDays` 只影响旧的 rooms jsonl（§8） |

体积账：一行会话 ≈ 250–400B；**100 个会话/设备 ≈ 40KB**；账户名册 < 2KB。100 个会话全量重推一次的帧 ≈ 40KB（local 通道上限 16MB，viewer 通道 256KB——**设备多/会话多时 session_list 要分页或截断**，见 §5）。

## 4. 数据从哪来（责任划分）

| 事实 | 权威源 | 上报方式 |
|---|---|---|
| 设备身份/显示名/平台/projects | 本机 `.env`（`PI_REMOTE_DEVICE_ID/NAME`、连接命令填 platform、projects 来自 .env） | 连接命令 `device_register`（每次 attach）+ 扩展 `room_register`（窗口内）各带一份 |
| 会话清单（有哪些、名字、cwd、条数、大小、时间） | **扩展**（`pi` 进程内 `SessionManager.list` + 活动会话） | `session_manifest` 帧（§5） |
| 会话当前是否活动（哪个房间） | 扩展（room_register 的那条连接） | room.online + manifest `active` |
| 设备是否在线 | **连接窗口是否在跑**（attach 命令那条连接） | device_register / 连接断开 |

**上报触发点**（扩展侧）：

| 时机 | 动作 |
|---|---|
| 扩展连上、绑定会话（仅在窗口内） | `session_manifest {full:true}` 全量 |
| `session_start`（new/resume/fork/reload） | upsert 该会话（`active:true`，旧活动置假） |
| `set_session_name` / fork / clone 完成 | upsert（name/text 变化） |
| `delete_session` 成功 | 墓碑行 |
| 回合结束（`agent_settled`） | **节流** upsert `updatedAt/messageCount`（≥60s 一次，避免每回合都写） |
| 扩展断开 | 无帧；relay 侧 `room_offline` + active 位由下次全量对账修正 |
| 连接窗口关闭 | attach 状态文件删除 → 扩展主动断开；本机 pi 进程不受影响；relay 把该设备房间全部 offline |

乱序/旧帧：relay 按 `updatedAt` 丢弃更旧者；同一 `sessionId` 的活动位以 `full` 对账和最新 upsert 为准。

## 5. 协议新增（全部加法式，现有帧不动）

```jsonc
// —— local → relay（7001，role=local + localToken，与现有一致）——

// 连接命令登记设备（窗口开始；不占房间）
{ "type": "device_register", "accountId": "me", "device": { "id": "<deviceId>", "name": "Windows",
  "platform": "windows", "projects": ["D:\\pi-myself"] } }

// 扩展 room_register 增加账户/设备字段（旧扩展不带 → 归"未登记"，兼容）
{ "type": "room_register", "room": { "id": "<sessionId>", "label": "…", "cwd": "…",
  "accountId": "me", "deviceId": "<deviceId>", "deviceName": "Windows", "platform": "windows" } }

// 会话清单 upsert（full=true 为全量对账；否则增量）
{ "type": "session_manifest", "accountId": "me", "deviceId": "<deviceId>",
  "full": true, "updatedAt": 1791437613000,
  "sessions": [ { "id": "<sessionId>", "cwd": "…", "name": "…", "messageCount": 128,
                  "sizeBytes": 86016, "createdAt": 1, "updatedAt": 2, "active": true } ],
  "removed": ["<已删除的 sessionId>"] }

// —— viewer ↔ relay（7002）——

// 浏览某设备的会话清单（未连接也返回——读的是索引；未连接时 online 全 false）
{ "type": "get_sessions", "id": "c9", "deviceId": "<deviceId>" }
{ "type": "session_list", "id": "c9", "deviceId": "<deviceId>",
  "sessions": [ { "id": "<sessionId>", "name": "…", "cwd": "…", "messageCount": 128,
                  "updatedAt": 2, "active": true, "online": true } ],
  "truncated": false }

// room_list 增加设备名册与账户/设备字段（广播节奏不变）
{ "type": "room_list",
  "devices": [ { "id": "<deviceId>", "accountId": "me", "name": "Windows",
                 "platform": "windows", "online": true, "projects": ["…"], "cwd": "…" } ],
  "rooms": [ { "id": "<sessionId>", "accountId": "me", "deviceId": "<deviceId>",
               "label": "…", "cwd": "…", "online": true, "busy": false, "viewers": 1 } ] }
```

**命令寻址扩展到设备级**（harness 的核心）：`command` 帧增加可选 `deviceId`（替代 `room`）。
relay 路由规则：`deviceId` → 该设备**当前活动房间**的 local 连接；无活动房间 → ack 报
`device_no_active_session`（可读文案："这台设备没有在跑的会话，先打开 PI"）。
设备级命令白名单（第一阶段）：`switch_session` / `new_session` / `fork` / `clone` / `get_state` /
`get_sessions`——**全部是既有会话命令，不新增执行面**。`prompt`/`steer` 等发消息类仍必须走房间
（镜像语义要求接到具体会话上）。

**错误码枚举**（补进契约，前端做分支用）：
`no_device`（设备从未登记）/ `device_offline`（登记过但没连）/ `device_no_active_session` /
`session_not_found`（清单里没有这个 sessionId）/ `manifest_stale`（updatedAt 更旧被丢弃，仅日志）。

**session_list 的分页/截断**：会话数 > `maxSessionsListed`（默认 200，按 `updatedAt` 倒序）时
`truncated:true`，前端提示"仅显示最近 200 个"；设备侧 `full` 对账帧同理截断（先推最近的）。

## 6. 会话的三种状态与 UI 流程（替代"离线回放"的新交互）

| 状态 | 判定 | 网页行为 |
|---|---|---|
| **活动**（连接窗口内且是当前房间） | room.online（且窗口在跑） | 直接订阅，镜像/发消息/发命令（现状） |
| **在本机非活动**（窗口内，会话在清单里但不是当前房间） | manifest 有 + room 不在线 | 点"启用" → `harness_start{deviceId, sessionId}` → 设备用该会话文件起一份 pi → 新房间进 room_list → 自动选中订阅 |
| **仅清单**（设备未连接，但索引里有） | 没有连接窗口在跑 | 列表**可见**（名字/cwd/条数/时间来自索引），操作禁用，提示"在电脑上执行连接命令"；**不承诺看历史** |

关键 UX 变化（相对 `device-harness.md` §9）：**未连接设备"看得见清单、打不开"**，取代原来"看历史"的承诺。注意"未连接"的定义 = 没有连接命令在跑（不等于计算机关机）——设备开着但没执行命令，与关机对服务器无异，这正是下限模型。

切换竞态：viewer 点"打开"→ 命令在飞 → 设备切换 → 房间上线，其间按钮进 loading；另一个 viewer 也点同一会话 → 以设备侧串行（pi 的会话操作本来就在扩展命令队列里串行）结果为准，后到看 room_list。

## 7. relay 侧的存储职责切分

| 职责 | 现在（store.js） | 新（index.js + RAM） |
|---|---|---|
| 对话正文 | 磁盘 jsonl（每消息） | **不落盘**；活跃房间只在 RAM 留一份快照缓存（`room.snap`，TTL 现已存在），迟到 viewer 订阅时直接用它；没有缓存则请扩展重推（§8 的 `resend_snapshot`） |
| 房间元数据（label/cwd） | 注册表内存 + 从快照反推 | 注册表内存不变；**新增持久化来源 = 该房间所属设备的 sessions 索引行** |
| 房间在设备间的位置 | 无 | `rooms[].accountId/deviceId`（room_register 带） |
| 设备名册 | 无 | `data/accounts/admin/devices.jsonl`（每次 attach 时 upsert） |
| 会话清单 | 无 | `data/accounts/admin/sessions/<设备>.jsonl` |
| `list_sessions`（ viewer 主动拉） | 无 | 新 `get_sessions` 帧 → 读索引文件（不打扰设备） |

**`resend_snapshot`（小协议增量）**：viewer 订阅一个在线房间而该房间 RAM 没有快照缓存时，relay 给
local 发 `{type:"resend_snapshot"}`，扩展回一份 `snapshot`（现有帧）。这替代了"从磁盘装配"。

## 8. 迁移（不推翻重来，按开关走）

1. **新部署**：`PI_REMOTE_PERSIST_TRANSCRIPTS` 不设 = 默认停——`store.record` 变 no-op，rooms jsonl 不再产生；
   `retentionDays` 清扫照旧（清旧文件）。
2. **旧部署升级**：relay 重启后 rooms map 从内存重建（在线房间由 room_register 重新注册， RAM 快照由
   扩展连接时的 `snapshot` 补齐——**扩展本来就会在绑定/切换时推全量快照**）；磁盘旧 jsonl 保留 30 天自然过期，
   期间 `store.exists()` 仍允许对旧房间 id 的订阅（读完即弃）。
3. **代码**：`store.js` 保留（旧路径 + 一个版本的兼容读取），新写 `index.js`；两个都小，不合并。
4. **升级后第一次连接**：扩展发 `full` 清单 + 全量快照，服务器索引即成型（**零人工迁移**）。

## 9. 落地顺序（重排，每步可独立部署）

| 步 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| 0 | **索引层**：`index.js` + `session_manifest` 写入 + `get_sessions` 读 + room_register 带 accountId/deviceId | 无（设备字段缺省归"未登记"） | E2E：manifest upsert/墓碑/乱序丢弃/full 对账；get_sessions 未连接也可读 |
| 1 | **连接命令**：`deploy/attach.cjs`——device_register + 本机 attach 状态文件 + 扩展窗口门控 + harness_start 拉起（cwd/sessionId 两种） | 步 0 | E2E（假窗口连接）：登记/顶替/到期断开/门控；started / already_running / 三类错误 |
| 2 | **UI 设备/会话选择**：room_list.devices + session_list；未连接设备展示索引清单、已连接可启用/新建 | 步 0/1 | E2E + 浏览器：未连接可见清单、已连接可启用旧会话并自动订阅 |
| 3 | **设备级命令寻址 + 错误码进契约**：command{deviceId} 白名单 + 六错误码枚举 | 步 1 | E2E：device_offline / cwd_not_allowed / session_not_found 的 UI 分支 |

## 10. 待你拍板的决策

| # | 决策 | 我的建议 |
|---|---|---|
| D1 | `accountId` 从哪来：本机 `.env` 写 `PI_REMOTE_ACCOUNT`（同一人所有设备同值）/ 服务端派生 | `.env` 显式声明、默认 `default`；私有部署单人单账户无感知 |
| D2 | 是否默认停写对话正文（`PI_REMOTE_PERSIST_TRANSCRIPTS`） | 默认停；这是整个改造成本的来源 |
| D3 | 设备级命令白名单边界 | 白名单起步（§5）；发消息类永远走房间 |
| D4 | 未连接设备是否展示上次清单 | **展示**（标注"未连接"）——索引的价值就在这；可配置隐藏 |
| D5 | 连接窗口是否自动到期（`--max-hours` 默认值） | 默认 12h 自动断；Ctrl+C 随时手动断 |
| D6 | 网页是否可主动「断开此设备」 | 可以（忘关窗口时有用）；只断窗口不断本机 pi |

> D1/D2 定了我就按 §9 步 0 开工（`index.js` + manifest 协议 + E2E），步 1 连接命令一起做；步 2/3 依赖步 1。
> D4/D5/D6 不阻塞开工——按建议默认值实现，你随时可改。
