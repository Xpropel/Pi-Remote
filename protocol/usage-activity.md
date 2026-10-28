# `usage.activity.v1`（设置页「使用活动」数据协议，P10）

> 唯一事实源：`protocol/v4.json` 的 `caps["usage.activity.v1"]` 与 `limits.usage*`。
> 改协议后跑 `node protocol/sync.cjs`（同步 `relay/protocol.json` + extension 的 PROTOCOL 块），
> 再跑 `test/usage-contract.test.mjs` / `test/usage-relay.test.mjs`。

## 1. 链路

```
pi 会话 jsonl（设备本地）→ extension 聚合扫描
  → usage_snapshot（extension → relay）
  → relay 校验 + 按 account+device 缓存
  → usage_get（viewer → relay）→ usage_refresh（relay → extension）→ usage_snapshot（relay → viewer）
  → UI useUsageActivity() 渲染
```

- 数据源只有一个：设备本机 `PI_CODING_AGENT_DIR|~/.pi/agent` + `/sessions/<项目>/<会话>.jsonl`；
  不混 relay room 记录（同一批数据的子集，混加会重复计）。
- 口径：本地时区分天；`role=user` 才计用户消息；`totalTokens` = API 处理量（每轮重报上下文），
  文案只能写「Token 活动/用量」；**不读/不传/不显示金额（cost）**；只传聚合计数，无正文/标题/cwd/路径。
- 快照结构见 `ui/src/pi/usage/types.ts`（`UsageSnapshotV1`）；扩展侧镜像类型由测试防漂移。
- `summary.peaks` 口径：`tokens` = 快照窗口内单日 **totalTokens** 最大日；`messages` = 单日 **user 消息数**最大日
  （只数 `role=user`，不叠加 assistant——设计「最活跃的一天」与账本 `real-expected.json` 同口径）。

## 2. 帧

| 方向 | 帧 | 字段 |
|---|---|---|
| viewer → relay | `usage_get` | `deviceId`（必填，本账号设备）、`requestId`（viewer 生成，响应原样带回）、`force?`（true = 跳过 relay 缓存，设置页刷新按钮） |
| relay → extension | `usage_refresh` | `deviceId`、`requestId`（relay 生成） |
| extension → relay | `usage_snapshot` | `deviceId`、`requestId?`、`snapshot`（`UsageSnapshotV1`） |
| relay → viewer | `usage_snapshot` | `deviceId`、`requestId?`、`available`、`reason?`、`snapshot?`、`receivedAt?`、`stale?` |

- `available=false` 时 `reason` ∈ `no_data | device_offline | unsupported | timeout | stale`；UI 显示空态与一句原因，不报错。
- relay 缓存新鲜期 5min（`USAGE_CACHE_TTL_MS`）；过期/`force` 才向设备发 `usage_refresh`；
  同一设备并发请求合并为一次刷新，所有等待 viewer 收到同一快照。
- **请求号对账（低-22）**：relay 有等待中的刷新时，`usage_snapshot` 必须带回同一个
  `requestId`（relay 在 `usage_refresh` 里下发的 `relayRequestId`）才能结案；缺失或不符的
  快照视为迟到/主动推送，**不结案、不写缓存**（否则一条旧快照会顶掉刚发出的 `force` 刷新）。
  没有等待者时，设备主动推送的快照仍可用于预热 relay 缓存。
- **stale 的连接口径（低-21）**：缓存命中时 `stale` 看的是能刷新 usage 的那条连接
  （声明 `usage.activity.v1` 的 extension room 连接，`usageConnOf`），不是 attach 窗口的
  `dev.conn`；attach 在线但没有 usage 能力同样标 `stale:true`。
- relay 校验会核对 `summary` 与 `days` 明细（低-23）：`totals` 是近 30 天子集，只能
  ≤ 全量 `days` 合计；`peaks` 日期必须在 `days` 里且不超过单日最大（messages 峰按
  user+assistant 之和取上界），`streaks.current ≤ longest`；对不上的快照整份拒收。
- 设备离线/relay 重启后名册消失：有缓存回 `available:true + stale:true`；无缓存回 `device_offline`/`no_data`。
- 快照 ≤ 256KB（`usageSnapshotMaxBytes`）；days ≤ 400；models ≤ 8；超限拒收/截断（`coverage.truncated`）。

## 3. 鉴权与隔离

- viewer 使用现有 viewer token 握手；`usage_get` 只接受本账号（relay 配置账号）名下的设备，
  未知/越权 deviceId 回 `no_data` 空态（不区分错误，不泄露设备是否存在）。
- relay 缓存按 `accountId + deviceId` 哈希落盘（`data/accounts/usage/`），不跨账号；缓存只有聚合快照。
- extension 只在收到 `usage_refresh` 时扫描本机会话；不主动外发、不向外提供文件/正文。

## 4. 旧端兼容

| 对端 | 行为 |
|---|---|
| 旧 extension（无 cap） | relay 发 `usage_refresh` → 旧端回 `unknown_type`；relay 不重试，回 `unsupported` 空态 |
| 旧 relay（无 cap） | 新 UI 握手 caps 无 `usage.activity.v1` → `useUsageActivity` 直接 `unsupported` 空态（不发无用请求） |
| 旧 viewer | 不会发 `usage_get`；新 relay 不主动向它发任何 usage 帧，既有面不受影响 |
| 坏/超限/含 cost 的快照 | relay 校验失败 → 丢弃并记日志；等待中的 viewer 到 8s 超时回缓存 stale / `timeout` 空态 |

## 5. 缓存与降级

- 设备侧：`<agentDir>/usage-days.json`（per-file mtime+size + 日聚合贡献；时区/版本/损坏 → 全量重扫）。
- relay 侧：`data/accounts/usage/<hash(account)>-<hash(device)>.json`（`{v, accountId, deviceId, receivedAt, snapshot}`），
  原子写；文件损坏按无缓存处理。
- 任何一侧失败都只降级为空态，不影响 pi / relay / 设置页其它功能。
