# relay 同步/去重契约（v4）

> 本文补齐 `protocol/v4.json` 里只有一句说明、却没有可执行细节的两类契约：
> **断线同步（sync.v3）** 与 **命令幂等/去重（msg.cid / dedupeKey）**，并写明握手版本与
> 偏好同步（prefs.sync）的裁决边界。帧名与字段仍以 `v4.json` / `relay/protocol.json` 为准；
> 本文只定义"同一帧重复/乱序/迟到时两端怎么对齐"，不新增帧类型。
>
> 改动协议后先跑 `node protocol/sync.cjs`（把 `v4.json` 同步到 relay/extension 副本），
> 再跑 `test/protocol.test.js`、`test/relay-runtime-hardening.test.js`、`test/prefs-sync.test.mjs`
> 与 `test/relay-low-fixes.test.js`。

## 1. 版本与握手

- `v4.json.proto` 是 relay 当前实现的版本，`minProto` 是仍能理解的最低版本（当前 3）。
- `auth.proto` 缺省：按兼容期旧客户端处理，relay 回自己支持的协议版本，caps 按已知名字过滤。
  这是既有兼容行为，**不是**"协议版本被静默抬高"。
- `auth.proto` 显式存在但无法解析为整数、或 `< minProto`：**拒绝握手**，不得按 `minProto`
  放行。relay 回
  `{type:"auth_result", ok:false, code:"unsupported", error:"协议版本过低…", proto, minProto}`，
  随后以 `4003` 关闭连接。viewer/local 两个通道同一口径。
- `auth.proto > proto`：按本 relay 的 `proto` 说话（向前兼容），客户端按 `auth_result.proto`
  与 `caps` 降级，不假设 relay 认识未来帧。
- `caps` 只认 `v4.json.caps` 里登记过的名字；未登记的能力名不进入连接的 caps 集合。

## 2. 断线同步（sync.v3）

同步的单位是**房间**，锚点是 `{rev, seq}`：

| 字段 | 含义 |
|---|---|
| `rev` | 存储世代/重写代号。存储被重置、全量重写或世代变化时改变；`rev` 对不上 = 增量不可用。 |
| `seq` | 房间内消息/事件记录的单调序号。只保证同一 `rev` 内递增。 |
| `epoch` | 扩展侧分支/实例换代计数（`navigate_tree`、终端 `/tree`、扩展实例更替）。`epoch` 变化只用于判断是否要重置存储，**不等于** `rev`。 |

### 2.1 local → relay

1. 连接后 `room_register`，relay 回 `room_registered{room, epoch, rev, seq, msgCount, firstHash,
   lastHash, tailHashes}`。这是扩展侧的同步锚点。
2. 扩展可发 `sync` 做轻量探测，relay 只重发 `room_registered`，不改注册信息。
3. 扩展用 `snapshot{mode}` 提交正文：
   - `mode:"append"`：只上传尾部，`base` 必须与存储锚点一致；不一致时 relay 回
     `snapshot_request{room, reason}`，扩展必须改发全量 `snapshot`（不带 `mode:"append"`）。
   - 不带 `mode:"append"`：全量快照，relay 按首尾 hash 合并/补种；空全量快照也是权威快照
     （表示"这个会话确实还没有消息"），会用空快照收掉等待中的 viewer。
4. 扩展断线重连后先拿 `room_registered` 的 `rev/seq/tailHashes` 判断续传，不得无条件先推全量。

### 2.2 viewer → relay

1. viewer 用 `subscribe{room, since?}` 订阅；`since` 是上次收到的 `{rev, seq}`。
2. `since.rev` 与当前存储 `rev` 相同且 `since.seq` 可对齐 → relay 回
   `snapshot{delta:true, baseSeq, messages}` 增量；否则回全量 `snapshot`。
3. `snapshot` 之后 relay 按固定顺序补缓存态（待发队列、任务清单、进行中工具、自动重试、
   本机弹窗、扩展状态、compaction）；**客户端不得把 `snapshot` 之后的补发帧当作新消息**
   重复插入，按 `seq` 去重（无 `seq` 的缓存帧按类型/槽位覆盖）。
4. 同一 `rev` 内 `seq <= 已收到 seq` 的 `room_event` 直接丢弃；`seq` 跳号才允许触发重订阅。
5. `rev` 变化 = 存储换代：客户端清掉该房增量基线，按全量 `snapshot` 重建。

### 2.3 对账责任

- relay 是 `rev/seq` 的权威；客户端只携带自己**最后成功应用**的锚点，不自行推进。
- 扩展的 `room_registered` 锚点与 relay 的 `rev/seq` 不一致时，以 relay 回包为准，
  由扩展决定续传/全量；relay 不猜测客户端缺了哪些消息。

## 3. 命令幂等与去重（dedupeKey / cid）

### 3.1 帧与超时

```
viewer → relay   {type:"command", id, command, args, room? | deviceId?, dedupeKey?}
relay → viewer   {type:"command_accepted", id, room?, deviceId?, timeoutMs, dedup?}
relay → local    {type:"command", id:<wireId>, command, args, timeoutMs, room?, deviceId?}
local → relay    {type:"command_result", id:<wireId>, ok, data? | error?, code?}
relay → viewer   {type:"ack", id, ok, data? | error?, code?, dedup?}
```

- `command` 的 `id` 是 viewer 的请求号；转发给 local 时 relay 换成一词一用的 `wireId`，
  `command_result.id` 必须回 `wireId`。
- relay 是超时的唯一权威：`command_accepted.timeoutMs` 就是 relay 的等待上限（分档见
  `relay/commands.js` 的 `commandTimeoutMs`）。扩展可用更短的内部预算先回结果，
  但不能晚于 relay 的 `timeoutMs` 才回。
- relay 超时回 `ack{ok:false, code:"timeout", retryable:true}`；它只表示"relay 不等了"，
  不表示设备没执行。relay 不向设备发明"取消"指令（协议目前没有安全的取消帧）。

### 3.2 dedupeKey

- `dedupeKey` 由 viewer 生成，用于**同一逻辑请求的重发**（断线重连、UI 自动重试）。
- relay 计算实际去重键：

  ```
  dedupeKey = scope | command | sha1(stableJson(args))[0:16] | client dedupeKey
  scope     = room.id（按房间寻址）或 deviceId（设备级命令 / harness_start）
  ```

  - 参数用**稳定序列化**（对象键排序、数组保序）后再摘要；参数键序不同视为同一请求。
  - 键同时绑定 `scope`、`command`、`args` 摘要和客户端 key。**只复用 key 但换了命令/参数
    不会命中去重**，必须作为新命令执行（防止回放上一个结果）。
  - 摘要只进日志/Map，不把正文或大 base64 放进键。

### 3.3 命中语义

| relay 状态 | 收到同 key 重发 | 结果 |
|---|---|---|
| 未见过的 key | 正常转发 | 回 `command_accepted`（无 `dedup`），设备执行一次 |
| 已完成（`done`） | 不转发 | 直接回 `ack`，带 `dedup:true` 与首次结果 |
| 在飞（未 `done`） | 不重复转发 | 回 `command_accepted`（`dedup:true`），把该 viewer 加入同一批 waiter |
| 超时但在对账窗口内 | 不重复转发 | 与"在飞"相同；迟到结果仍写入去重表，重发可回放 |
| 对账窗口结束仍无结果 | 转发 | 视为新请求重新执行（`dedupeTtlMs` 内也可能被裁剪） |

- 去重表保留 `dedupeTtlMs`（默认 10 分钟），只淘汰**已完成且无等待者**的条目；
  在飞条目不能被容量挤兑删掉。
- 结果太大的命令（如读类）不长期留在去重表里，重发会重新执行；客户端应按结果大小
  自行降低重发频率。
- 超时后 relay 保留条目的**对账窗口**（`COMMAND_RECONCILE_GRACE_MS`，默认 60 秒）：
  设备迟到回 `command_result` 时，relay 仍按 `wireId` 收下，执行服务端后置钩子
  （例如删除会话后的副本清理）并更新去重表；带 key 的请求在窗口内重发能取回该结果。
  窗口结束后条目才被清理。

### 3.4 cid 与 dedupeKey 的分工

- `cid` 属于**消息注入**（`prompt/steer/follow_up`）：扩展用它在回显、送达、失败事件之间对号，
  不承担"同一条命令只执行一次"的职责。
- `dedupeKey` 属于**命令通道**：只对 `type:"command"` 生效。消息类命令的幂等靠 `cid`
  + 扩展侧待发队列；不要把两者混用。
- 不带 `dedupeKey` 的命令不做跨重发去重：relay 只保证同一次转发内的 waiter 共享结果。
  需要重发安全的客户端（尤其是删除/改名/切换类）必须带稳定 `dedupeKey`。

### 3.5 超时/断线的结果归属

- viewer 断线：命令继续执行；结果留在去重表，重连后同 key 重发可回放（`dedup:true`）。
- local 断线：所有等待该连接的条目立即失败 `code:"result_unknown"`（命令可能已执行），
  不让 viewer 干等超时；带 key 的条目从去重表移除，避免把"未知"当成已完成回放。
- 服务端后置钩子（`onResult`）即使 viewer 不在、relay 已超时，也必须在迟到结果到达时执行。

## 4. 偏好同步（prefs.sync）的裁决边界

- `prefs_set{subset, baseRev}` 的 `subset` 可以只带变化字段（当前 UI 只上行
  `{mobileNav}`）。relay 按**字段合并**到当前记录：缺席字段保留原值，不能整份替换清空
  别端同步的外观字段。
- `rev` 由 relay 单调 +1，`updatedAt` 用 relay 时钟；客户端时钟不参与裁决。
- `baseRev` 只用于诊断/日志：落后不拒绝（LWW，到达顺序裁决）。发送端必须以
  `prefs_saved.rev` 对齐本地，并在收到 `prefs_changed` 时接受对方子集。
- `auth_result.prefs` 是当前快照（无记录为 `null`）；未声明 `prefs.sync` 的连接不收
  `prefs_changed`，回包也不带 prefs 字段。

## 5. usage 刷新的请求号

- `usage_get{deviceId, requestId, force?}` 的 `requestId` 由 viewer 生成；relay 回
  `usage_snapshot` 时原样带回，多个并发 viewer 各自拿到自己的 `requestId`。
- relay 向设备发 `usage_refresh{requestId: relayRequestId}`。设备回的 `usage_snapshot`
  必须带回同一个 `relayRequestId` 才能结案；缺失或不符的快照视为迟到/主动推送，
  **不结案、不写缓存**（否则一条旧快照会顶掉刚发出的强制刷新）。
- 没有等待中的刷新时，设备主动推送的 `usage_snapshot` 可以只用于预热 relay 缓存。
- 等待超时（`usageRequestTimeoutMs`，默认 8 秒）→ 有缓存回 `available:true, stale:true`，
  无缓存回 `available:false, reason:"timeout"`。

## 6. 兼容性检查清单

- [ ] 新帧/新字段只在对方声明对应 cap 时发送；旧端既有字段不剥。
- [ ] 改 `commandTimeoutMs` 分档时同步本文 §3.1 和 `DOC/50-protocol-delta.md` 的超时表。
- [ ] 改去重键组成时同步本文 §3.2、`relay/commands.js` 与
      `test/relay-runtime-hardening.test.js` 的"低-10"用例。
- [ ] 改 `sync.v3` 的增量/全量判定时同步本文 §2 与 `test/integration-v4.test.mjs`。
- [ ] 改偏好合并语义时同步本文 §4 与 `test/prefs-sync.test.mjs`。
