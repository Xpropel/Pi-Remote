# REFACTOR-LOG

工程提质（S 级）留痕。只记录**问题 → 改法 → 验证**，不写实现细节。
每条按 `## <日期> <区块>` 组织；同一区块内的多文件改动一次提交。

纪律：

- 行为不变：功能、协议、接口语义不改；每块跑全套 `npm test`，全绿才提交。
- 命名具体化：不用 `seq`/`idx`/`tmp`/`val`/`cfg`/`msg`/`opts`/`args`/`ctx`/`res`/`req`/`err`/`fn`/`cb` 之类缩写与泛词，
  也不用 `r`/`s`/`t`/`p`/`e`/`b` 单字母（`http`/`json`/`url`/`api`/`ws`/`fs` 等行业标准缩略除外）。
- 不删测试；测试只能随改名同步改名，或把**过期断言**改成当前契约（不等同于放宽，须在条目里写清证据）。
- 不改版本号；不动 `deploy/`、`deploy/docker/` 的文件构成（不加、不删、不改名）；不引入新依赖。

---

## 基线（提质开始前）

### 环境

- Node v22.23.4 / npm 10.9.9，tmux 3.4，Linux。
- `ui/node_modules` **不存在**：`ui/package.json` 里声明的 react 等从未安装过。
  这是仓库自带的安装步骤缺口，不是新增依赖（`ui/package-lock.json` 未改动，`npm ci` 严格按锁文件装）。

### `npm test` 基线结果（提质前，原样）

```
exit code 1
# tests 2537
# suites 130
# pass 2467
# fail 12
# cancelled 51
# skipped 7
# todo 0
# duration_ms 177787
```

按测试文件逐个跑（`node --test <file>`，逐文件汇总）的失败清单：

| 测试文件 | 结果 | 根因 |
|---|---|---|
| `test/shell.test.mjs` | 文件级失败，0 个用例跑到 | 缺 `ui/node_modules`，`ui/src/shell/breakpoints.ts` 引 `react` 解析不到 |
| `test/streaming-markdown.test.mjs` | 同上 | 同上 |
| `test/pi-p4pre.test.mjs` | 同上 | 同上（`ui/src/pi/hooks/usePiShortcuts.ts`） |
| `test/pi-p6-a.test.mjs` | 同上 | 同上 |
| `test/pi-search-surfaces.test.mjs` | 同上 | 同上 |
| `test/ui-usage-robustness.test.mjs` | 同上 | 同上（`ui/src/pi/usage/useUsage.ts`） |
| `test/ui-perf-stream-chunks.test.mjs` | 同上 | 同上 |
| `test/ui-sync.test.mjs` | 95 用例 1 失败 | 同上（异步活动里抛 `Cannot find module 'react'`，来自 `ui/src/chat/composer/faviconBadge.ts`） |
| `test/deploy-scripts.test.js` | 1 失败 | `deploy/start-pi.sh` 丢了对 `start-pi.sh` 的可执行位（git 里就是 `100644`） |
| `test/start-pi-sh.test.cjs` | 1 失败 | 同上 |
| `test/linux-device.test.cjs` | 1 失败 | `deploy/linux/push.sh` 丢了可执行位 |
| `test/cloudflared.test.js` | 3 cancelled | `deploy/cloudflared.cjs` 的就绪轮询定时器被 `unref()` |
| `test/extension.test.mjs` | 41 cancelled | `extension/pi-remote-sync.ts` 持留 dialog 的裁决定时器被 `unref()` |
| `test/extension-ask-select-local.test.mjs` | 7 cancelled | 同一处 unref  cascaded；以及 ask 选择组件超时定时器被 `unref()` |
| `test/linux-tmux.test.cjs` | 2 失败 | ① `device.sh 全流程` 断言停留在加密阶段 1 之前的"令牌配对"世界；② tmux 3.4 丢 `#{pane_dead_status}` 导致同一用例约四成概率红 |

> 说明：基线的 `# tests 2537` 少算了 8 个整体崩溃的文件——它们在导入阶段就死了，
> 一个用例都没跑。修好安装缺口后总数变成 2702。

---

## 基线修复（不属重构，但不修永远绿不了）

提交：`fix: restore executable bits on deploy shell scripts`
提交：`fix: keep timers that correctness depends on referenced`

### 问题 1：三个 shell 脚本在 git 里丢了可执行位

- 现象：`deploy/start-pi.sh`、`deploy/linux/push.sh`、`deploy/deploy-relay.sh` 的 index 模式是 `100644`，
  而同目录的 `attach.sh`、`deploy-web.sh`、`device.sh`、`sync-extension.sh` 是 `100755`。
- 改法：`git update-index --chmod=+x` + 工作区 `chmod +x`。文件内容零改动。
- 为什么不是"动发布物构成"：只改文件模式位，不增删文件、不改内容；测试明确要求可执行位。

### 问题 2：正确性依赖的定时器被 `unref()`

> ⚠️ **本条不是纯重构，是行为相关变更**：它改变「进程在没有其它引用时会不会退出」的时序。
> 生产里宿主进程（pi 的 TUI、relay 的 HTTP 服务）一直有别的引用，可观察行为不变；
> 但空事件循环下的退出时机确实变了。单独标注，避免与纯改名/纯拆分混在一起报。

- 现象：三个定时器一被 `unref()`，测试进程事件循环一空就退出，`await` 永远不落定，
  Node 报 `cancelledByParent: Promise resolution is still pending but the event loop has already resolved`。
  生产里宿主进程另有引用所以看不出来，属于潜伏缺陷。
- 改法：去掉这三处 `unref()`（保洁型定时器保持 `unref` 不动）：
  - `extension/pi-remote-sync.ts` `activateHeldDialog`：`entry.timer` 一响就要 resolve 掉宿主的 dialog promise；
  - `extension/pi-remote-sync.ts` `askSelectComponentFactory`：`timer` 一响就要 settle 掉宿主弹窗
    （同函数的倒计时 `tick` 只是重绘，仍然 `unref`）；
  - `deploy/cloudflared.cjs` `startTunnel`：`pollTimer` 一响就要把 `ready` 定下来或按超时失败。
- 依据：仓库自己已经踩过并写下来了——`deploy/attach.cjs` 前台窗口定时器处写着
  "不 unref：这是前台窗口，定时器必须撑住事件循环"。本次把同一条纪律推广到另外三处。
- 行为影响：宿主进程里本来就有别的引用（pi 的 TUI、relay 的 HTTP 服务），可观察行为不变；
  唯一变化是"进程不会在一个必须响的定时器触发前退出"，这正是预期语义。

### 问题 3：`test/linux-tmux.test.cjs` 的过期断言

- 证据：该文件自 v2.0.0 初始公开发布起没再改过；而 v2.1.4「设备身份（加密阶段 1）」之后
  `deploy/attach.cjs` 的 `pair` 会 `ensureDeviceKeys` 生成身份钥、登记公钥，并由 relay 作废该设备的令牌行
  （设计 §3.4，`relay/local.js` "双轨铁律：已登记公钥的设备不许改走令牌"）。
  `test/attach-pair.test.js:181`、`crypto-stage1/2/3.test.js` 全都断言 `auth === "key"`。
- 改法（不是放宽，是把断言挪到当前契约）：
  1. `dev.auth` 期望 `"token"` → `"key"`，`dev.paired` 期望 `true` → `false`。
     `paired` 的契约见 `relay/devices.js` 注释："paired = 有没有有效令牌"——钥设备的令牌行已作废，所以是 false。
  2. 假 pi 增加记录 `KEY=${PI_REMOTE_DEVICE_KEY_FILE:+set}`，断言从 `[DEV, TOK=set, RELAY]` 改成
     `[DEV, TOK=, KEY=set, RELAY]`：设备令牌按设计清空，但钥文件路径必须到 pi 手里。
     **断言覆盖面比原来更宽**（多证一条钥文件通路）。
  3. tmux 3.4 丢 `#{pane_dead_status}` 的探针改为按产品自己的口径取值
     （`attach.cjs tmuxEarlyExit` / `device.cjs piSessions` 都是"窗格优先、落盘回落"）：
     `pane.status != null ? pane.status : attach.readExitCode(name, box.home)`。
     仍然要求退出码是 127，只是不再断言行号字段——产品明确把该字段按不可靠处理。

### 问题 4：tmux 3.4 下 `test/linux-tmux.test.cjs` 约四成概率红

- 根因：`#{pane_dead_status}` 在 tmux 3.4 上会被丢（产品注释原文："tmux 3.4 约四成概率丢"）。
- 处理：随问题 3 的第 3 项一并消掉。连续 8 次单跑全绿。

### 修复后全套结果

```
exit code 0
# tests 2702
# suites 144
# pass 2695
# fail 0
# cancelled 0
# skipped 7
# todo 0
# duration_ms 206196
```

（7 个 skip 都是平台条件跳过：Windows-only / 没装 tmux，与基线一致。）

---

## 提质过程中的条目（按区块追加）

> 每个区块：问题 → 改法 → 风险 → 验证。区块划分与顺序见 `REFACTOR-PLAN.md`。

---

## B1.1 · relay 叶子模块命名具体化

提交：`refactor(relay): give the leaf modules self-describing names`

### 范围

`relay/util.js`、`relay/wire.js`、`relay/conn.js`、`relay/acktrack.js`、`relay/web.js`、
`relay/notify.js`、`relay/purge.js`、`relay/sessionArchive.js`（8 个文件，1 143 行）。

### 问题

- 缩写/泛词：`cfg`（配置对象）、`opts`、`msg`、`ctx`、`snap`、`err`、`res`、`req`、`prefs`、`deps`、`extra`、`st`、`sig`、`def`、`pres`、`raw`、`u`、`doFetch`、`on`、`sr`、`exp`、`t`。
- 单字母：`a`/`b`/`ab`/`bb`、`v`、`s`、`c`、`k`、`n`、`d`、`e`、`r`、`p`（`pub` 是 public key，保留）。
- 同义不同名：`extra` 在三处分别表示「对话框附加信息」「错误帧附加字段」；`opts` 在两处分别表示「消息处理器」「发送选项」。

### 改法（纯标识符改名，无逻辑变化）

| 文件 | 主要改名 |
|---|---|
| `util.js` | `safeEqual(a,b)`→`(left,right)`；`formatFingerprint(fp)`→`(fingerprintHex)`；`setQuiet(v)`→`(quiet)`；`log(...a)`→`(...parts)` |
| `wire.js` | `parseHello(msg)`→`(hello)`；`helloVersionError(msg)`→`(hello)`；`helloText(s)`→`(state)`；`snapshotBodyFrom(snap)`→`(snapshot)`；`send`/`broadcast` 的 `opts`→`sendOptions`；`errorFrame` 的 `c`/`def`→`normalizedCode`/`definition`；`broadcast` 的 `list`→`recipients` |
| `conn.js` | `attachCommon(ws,cfg,opts)`→`(ws,config,handlers)`；`msg`→`parsedMessage`；`s`→`state`；`t`→`authTimeoutTimer` / `sweepTimer` |
| `acktrack.js` | `isAckFp(v)`→`(value)`；`ends`→`reportedEnds`；`distinct`→`fingerprints`；`sig`→`signature`；`ackTrackerOf(ctx)`→`(relayContext)` |
| `web.js` | `req`/`res`→`request`/`response`；`err`→`readError`/`streamError`/`requestError`；`st`→`fileStat`；`isIndex`→`isIndexFallback`；`immutable`→`cacheable`；`rel`→`relativePath`；`healthBody` 的 `list`→`roomList` |
| `notify.js` | `createNotifier(cfg,deps)`→`(config,dependencies)`；`prefs`→`eventPreferences`；`extra`→`dialogInfo`；`pres`→`presentation`；`doFetch`→`fetchImplementation`；`st`→`roomState`；`sr`→`stopReason`；`msg`→`assistantMessage`；`exp`→`expiresAt`；`on`→`enabledKinds`；`u`→`parsedUrl`；`raw`→`rawUrl` |
| `purge.js` | `dropStoredRoom(store,id)`→`(roomStore,roomId)`；`done`→`purgedIds`；`dev`→`deviceRecord`；`raw`→`rawId`；`forgot`→`tombstoneWritten`；`v`→`viewer` |
| `sessionArchive.js` | `storeSessionArchive(dev,…)`→`(deviceRecord,…)`；`body`→`sanitized`；`replaySessionArchives(ws,…)`→`(socket,…)`；`index`→`frameIndex` |

`cfg` 是全仓 717 处的高频缩写，**本块只清这 8 个文件里的 22 处**；其余文件的 `cfg`→`config`
由 B1.2–B1.6 各块顺手清自己范围内的那部分，不单独开一个大 diff。

### 跨文件同步改名（定义侧改名后调用侧必须跟着改）

`relay/purge.js` 的 `purgeSessions` 用对象解构取配置，形参从 `cfg` 改成 `config` 后，
3 个 relay 调用点与 3 个测试调用点的键名同步改成 `config:`：

- `relay/viewer.js:600`、`relay/viewer.js:1199`、`relay/local.js:1498` → `config: cfg`
- `test/pair-qr-link.test.js:352`、`test/relay-runtime-hardening.test.js:167,186` → `config: {}`

这是「改名全仓一致，定义、引用、测试同步」，断言内容一字未动。

### 风险与验证

- 风险：低。全是函数内部与形参改名；唯一有外部影响的是 `purgeSessions` 的解构键名，已同步。
- 验证：
  - 8 个模块全部 `require` 通过；
  - 改名后扫描（缩写词表 + 单字母 + `\bcfg\b`）在这 8 个文件里**零命中**；
  - 定向测试 `pair-qr-link`、`relay-runtime-hardening`、`notify`、`web-static`、`conn-frames`、`conn-heartbeat` 共 67 例全过；
  - **全套 `npm test`：2702 用例 / 2695 通过 / 0 失败 / 0 取消 / 7 跳过**（与基线修复后完全一致）。
- diff 体量 317 增 / 317 删，增删相等即「只有改名」的机械佐证。

---

## B1.2 · relay 名册/配置/配对/索引层命名具体化

提交：`refactor(relay): self-describing names in config, pairing, devices, index, prefs`

### 范围

`relay/config.js`、`relay/pairing.js`、`relay/devices.js`、`relay/index.js`、`relay/prefs.js`（5 个文件，1 997 行）。

### 问题

- `cfg` / `fileCfg` / `cfgPath`：配置对象三处不同写法。
- `mem`（内存名册记录）/ `row`（索引行）/ `dev` / `d` / `r` / `p` / `s` / `c` / `t` / `n` / `v` / `a` / `b` / `rec` / `prev` / `sig` / `der` / `tmp` / `abc` / `len` / `buf` / `dflt` / `src`。
- `num(value, dflt)` 的 `dflt`、`clampPort(v, dflt)` 的 `v`。
- 同一文件里 `row` 既指「索引行」又指「待写盘的新行」，`devices` 既指「内存名册 Map」又指「下发给前端的数组」。

### 改法

| 文件 | 主要改名 |
|---|---|
| `config.js` | `cfg`/`fileCfg`/`cfgPath` → `config`/`fileConfig`/`configPath`；`clampPort(v,dflt)` → `(value,fallback)`；`positiveInt` 的 `n` → `parsed`；`cleanServerName(raw)` → `(rawValue)`；`warnRejectedToken(name,raw)` → `(fieldName,rawValue)` |
| `devices.js` | `normPath(p)` → `(rawPath)`；`cwdAllowed`/`underRoots` 的 `c`/`r` → `normalizedCwd`/`normalizedRoot`；`cleanProjects` 的 `s` → `trimmed`；`boundAccount` 的 `cfgAccount` → `configAccount`、`dev` → `deviceRecord`；`buildDeviceList` 的 `mem` → `deviceRecord`、`row` → `indexRow`、`unreg` → `unregisteredOnline`、`r` → `room`；`firstSeenOf(row,mem)` → `(indexRow,memoryRecord)` |
| `index.js` | `safeKey`/`legacyKey` 的 `s` → `sanitized`；`readMap` 的 `rec`/`prev`/`t` → `record`/`previous`/`trimmed`；`num(v,dflt)` → `(value,fallback)`；`sameJson(a,b)` → `(left,right)`；`pathUnderRoot` 的 `p`/`r`/`target` → `candidatePath`/`normalizedRoot`/`normalizedCandidate`；`fsyncDir`/`_forgetDir` 的 `dir` → `directoryPath`；`_mergeJsonlInto` 的 `src`/`dst`/`cur` → `sourceRows`/`targetRows`/`current`；`_sessionFrom(prev,src)` → `(previousRow,sourceRow)`，函数体内 `p.` → `previous.`、`src.` → `sourceRow.`；`rewriteFromMap`/`_compactTokensIfLarge` 的 `tmp` → `temporaryFile`；`listSessions` 的 `r` → `row`、排序回调 `(a,b)` → `(left,right)` |
| `pairing.js` | `b64buf(v)` → `(value)`、`buf` → `decoded`；`newPairCode` 的 `abc`/`len`/`s`/`i` → `pairCodeAlphabet`/`pairCodeLength`/`code`/`position`；`ed25519PubKey`/`p256PubKey` 的 `der` → `derBytes`；`verifyEd25519`/`verifyP256`/`cleanPairKeys` 的 `sig` → `signature`；`canonicalJson`/`adminPayload` 的 `k` → `key`、`src` → `source`；`normalizePairCode(v)` → `(value)`、`s`/`abc`/`len` → `bare`/`pairCodeAlphabet`/`pairCodeLength`；`plainIp(v)` → `(value)`、`s` → `address`；`ipv6Prefix64` 的 `width`/`a`/`b`/`g`/`n` → `groupWidth`/`headGroups`/`tailGroups`/`group`/`total`；`checkDeviceToken` 的 `cfg` → `config` |
| `prefs.js` | `cleanPrefsSubset` 的 `v` → `value`；`cleanRecord`/`PrefsStore` 的 `rec` → `record`、`cur` → `current`；`tmp` → `temporaryFile` |

`der` 只在 Node 自己的 `format: "der"` 字样与注释里保留（ASN.1 DER 是行业标准缩略，且是 API 入参值）；变量本体已改成 `derBytes`。

### 跨文件影响

无。本块改名的形参全是位置传参，没有解构键名变化。

### 风险与验证

- 风险：中。`relay/index.js` 的 `_sessionFrom` 用脚本按行区间替换 `p.` → `previous.`，`relay/devices.js` 的
  `buildDeviceList` 改了循环变量名——两处都是「改了定义忘了改引用」的高危形态。
- **实际踩到并修掉的两个此类 bug**（全套测试抓到的，正是为什么每块都必须跑全套）：
  1. `relay/devices.js` `keyFpOf(row)` / `keyAddedAtOf(row)`：循环变量已改名 `indexRow`，这两行没跟着改，
     一进 `buildDeviceList` 就 `ReferenceError`。由 `attach-upgrade` 的 "waiting for auth_result timed out" 抓到。
  2. `relay/config.js` `warnRejectedToken`：形参 `name` → `fieldName` 后，查表键和两条模板字符串里仍写 `name`，
     `ReferenceError: name is not defined`。由 `relay.test.js` 的令牌强度用例抓到。
- 验证：
  - 5 个模块全部 `require` 通过；`node --check` 语法通过；
  - 补了一次「旧名残留」全量扫描（把每个文件改过的旧名逐个 grep），确认只剩注释/字符串里的合理残留；
  - 定向测试 `attach-upgrade`、`attach-pair`、`attach`、`attach-link`、`attach-local`、`devices`、`index`、
    `pair-qr-link`、`prefs-sync`、`relay`、`relay-runtime-hardening`、`relay-low-fixes`、`store*`、`crypto-stage0..3`
    共 553 例全过；
  - **全套 `npm test`：2702 用例 / 2695 通过 / 0 失败 / 0 取消 / 7 跳过**。
- diff 体量 401 增 / 401 删。

> 教训（后续每块都照此办理）：**改了循环变量/形参名之后必须再做一次旧名残留扫描**。
> `node --check` 只查语法、不查未定义变量，本块两个 bug 都是它放过去的。B1.3 起每块都加这一步。

---

## B1.3 · relay 命令/收件箱/排期/使用量层命名具体化

提交：`refactor(relay): self-describing names in commands, inbox, schedule, usage`

### 范围

`relay/commands.js`、`relay/inbox.js`、`relay/schedule.js`、`relay/usage.js`（4 个文件，1 583 行）。

### 问题

- `cfg`（配置对象）、`w`（waiter）、`v`（value / validated）、`n`（计数器）、`m`（正则匹配 / model）、
  `t2`（落定时刻）、`e`（error）、`tmp`、`fn`、`evt`、`k`、`i`、`d`、`p`、`dev`。
- `capStr` 在 `inbox.js` 与 `schedule.js` 各一份、签名里的 `n` 没说是「多少个字符」。
- `sameWire(a,b)` / 排序回调 `(a,b)` 全是单字母，读起来分不清左右。
- 同一文件里 `entry` 既指「命令等待条目」又指「收件箱条目」又指「排期条目」。

### 改法

| 文件 | 主要改名 |
|---|---|
| `commands.js` | `commandTimeoutMs` 的 `harnessMs` → `harnessStartTimeoutMs`、`v` → `configured`、`t` → `seconds`；`stableJson` 的 `k` → `key`；`finishWaiter(w)` → `(waiter)`；`settleEntry` 的 `e` → `settleError`；`armWaiter` 的 `w`/`i`/`cfg` → `waiter`/`waiterIndex`/`config`；`pruneDedupe` 的 `k`/`e`/`cfg` → `dedupeKey`/`entry`/`config` |
| `inbox.js` | `capStr(v,n)` → `(value,maxChars)`；`sameWire(a,b)` → `(left,right)`；`fsyncFile`/`_persist` 的 `e`/`tmp` → `fsyncError`/`writeError`/`temporaryFile`；`_emit(evt)` → `(transition)`；`onTransition(fn)` → `(listener)`；`_evictOverflow` 的 `e`/`(a,b)` → `entry`/`(left,right)`；`sweepRestored`/`clearRoomTurns` 的 `n` → `swept`/`removed`；`roomEntries`/`restoredWaitingKeys` 的 `e` → `entry` |
| `schedule.js` | `parseScheduleCid` 的 `m` → `match`；`capStr(v,n)` → `(value,maxChars)`；`numOr(v,fallback)` → `(value,fallback)`、`n` → `parsed`；`_persist` 的 `(id,entry)` → `(scheduleId,entry)`、`tmp` → `temporaryFile`；`armedCount` 的 `n` → `armed`；`armedOfRoom` 的 `e` → `entry`；`start()` 的 `e` → `startupError`/`tickError`；`create` 的 `v` → `validated`；`_inboxError` 的 `e` → `inboxError`；`retireRoom` 的 `n` → `retired`；`_fire` 的 `t2` → `settledAt`、`e` → `deliverError` |
| `usage.js` | `isRecord`/`isNonNegInt`/`isTimezoneOffset`/`isDate`/`keyHash` 的 `v` → `value`；`sensitivePath` 的 `[k,v]` → `[key,nested]`、循环 `i` → `itemIndex`；`validateUsageSnapshot` 的 `d`/`k`/`m`/`p`/`i` → `day`/`tokenKey`/`messageKey`/`model`/`peak`/`dayIndex`/`modelIndex`/`peakName`；`UsageBroker` 构造参数 `cfg` → `config`、`this.cfg` → `this.config`；`usageConnOf` 的 `dev` → `deviceRecord`；`handleGet` 的 `dev` → `deviceRecord`；`writeCache` 的 `tmp`/`e` → `temporaryFile`/`writeError` |

`raw.v` / `v: 1`（落盘格式版本号）与 `DATE_RE` 里的 `\d` 保持原样——前者是持久化字段，改了旧缓存全部失效；后者是正则元字符。

### 跨文件同步改名

`UsageBroker` 的构造参数从解构的 `cfg` 改成 `config`，两个调用点的键名同步：

- `relay/server.js:248` → `config: cfg`
- `test/relay-low-fixes.test.js:317` → `config: {}`

### 风险与验证

- 风险：中。四个文件都是「存储 + 状态机」形态，`cfg`→`config` 在 `UsageBroker` 上跨了文件。
- **踩到一个 bug 并修掉**：`relay/commands.js` `armWaiter` 形参 `w` → `waiter` 后，函数末尾的
  `w.timer.unref()` 没跟着改，`ReferenceError: w is not defined`。由 `relay-low-fixes` 的
  低-20 对账窗口用例抓到。B1.2 立下的「旧名残留扫描」这次先跑了一遍，漏了这一处
  （扫描只覆盖了我列进映射表的旧名，`w` 当时没进 `commands.js` 的映射表）——映射表必须从
  **diff 里实际删掉的标识符**反推，不能凭记忆列。
- 验证：
  - 4 个模块全部 `require` 通过；
  - 旧名残留扫描（含 `w`）只剩 `v: 1` 落盘版本字段与 `\d` 正则；
  - 定向测试 `relay-low-fixes`、`schedule*`、`inbox*`、`usage*`、`relay-waiting`、
    `relay-runtime-hardening` 共 121 例全过；
  - **全套 `npm test`：2702 用例 / 2695 通过 / 0 失败 / 0 取消 / 7 跳过**。
- diff 体量 178 增 / 178 删。

> 流程补丁：旧名映射表改为**从 `git diff` 的删除行里提取标识符**自动生成，不再手写。

---

## B1.4 · relay 房间表命名具体化

提交：`refactor(relay): self-describing names in the room registry`

### 范围

`relay/rooms.js`（1 895 行，合并上游 v2.1.16 之后的版本）。本文件是 relay 里改名面最大的一块：
约 60 个 `sendCached*` 补发函数 + `Rooms` 类的全部方法。

### 问题

- `cfg` 137 处（含 `this.cfg`）、`r`（房间）、`s`（dialog 槽）、`w`（等待条目 / viewer 连接 / waiter）、
  `v`（viewer 连接 / 遍历节点）、`p`（uiPrompt）、`d`（device）、`e`、`i`、`x`、`n`、`g`、`le`、`inf`、`hit`。
- `ws` 作为形参到处都是——`ws` 是行业缩略，但这里它同时表示「viewer 连接」「设备窗口连接」
  「local 桥连接」三种东西，读时分不清。统一改成 `socket`，需要区分时用 `viewerConnection` /
  `deviceConnection`。
- `out` 在 `roomsViewFor` / `devicesViewFor` / `inboxViewFor` 里既是被裁剪的条目又是裁剪结果。
- `seq` / `rev` 在 `resendFallbackBody` / `_fallbackSnapshotBody` 里是**变量**，而同名的 `"seq"` / `"rev"`
  是**线上字段名**——改名后变量叫 `sequence` / `revision`，字段名不动。
- `args` 在 `dispatchSchedulePrompt` 里是本地命令参数，而 `cached.args` / 帧里的 `args:` 是线上字段。

### 主要改名

| 类别 | 改名 |
|---|---|
| 配置 | `cfg` → `config`；`this.cfg` → `this.config`（本文件内部使用，外部无读取方，已 grep 确认） |
| 连接 | `ws` → `socket`；需要区分身份时 `viewerConnection` / `deviceConnection` |
| 房间 | `r` → `room` / `roomEntry`（列表条目） |
| 槽位 | `s` → `slot`；`w`（等待条目）→ `waitingEntry`；`p` → `uiPrompt` |
| 设备 | `d` / `dev` → `device` / `deviceRecord` |
| 存储 | `store`（= `this.inbox` 的本地别名）→ `inboxStore`，与 `room.store`（转录存储）区分 |
| 错误 | `e` → `serializeError` / `readError` / `buildError` / `anchorError` / `rosterError` / `snapshotError` 等按场景命名 |
| 循环 | `i` → `blockIndex` / `capIndex` / `index`；`x` → `child`；`v`（遍历节点）→ `node` |
| 计数 | `n` → `reaped` / `swept` / `omittedCount`；`hit` → `omittedCount` |
| 锚点 | `rev` / `seq`（变量）→ `revision` / `sequence`；`inf` → `storeInfo` |
| 其它 | `le` → `lastEvent`；`live` → `liveKeys`；`ref` → `inboxRef`；`end` → `turnEnd`；`has` → `hasViewers`；`g` → `group`；`inboxSnap` → `cachedInboxSnapshot`；`res` → `outcome`；`cmdEntry` → `commandEntry`；`w`（占位 waiter）→ `placeholderWaiter`；`lo`/`hi`/`mid`/`best` → `low`/`high`/`middleIndex`/`batchEnd`；`out`（裁剪结果）→ `prunedEntry` / `prunedDevice` |

保留不动的：线上字段名（`args`、`id`、`seq`、`rev`、`key`、`enc`、`titleEnc`、`answerable`…）、
`RoomMap.delete(id)` 的 `id`（Map 键）、`list()` 方法名、`ws` 作为**对象字面量属性**（`{ ws: null }`，
`armWaiter`/`finishWaiter` 读它）。

### 风险与验证

- 风险：中高。1 895 行、约 60 个函数、`this.cfg` 跨类内部使用；且上游 v2.1.16 刚改过这个文件
  （D-4 壳回收、encReason、roomsViewFor 的 cap 掩码），两部分改动能正确自动合并是本块的前提。
- **踩到 4 个 bug 并全部修掉**（都是「改了定义忘了改引用」，全套测试抓到的）：
  1. `Rooms.bindStore`：形参 `store` → `transcriptStore` 后，函数体里 `store.setLocator` /
     `store.onCapState` 没跟着改 → `ReferenceError: store is not defined`，`startRelay` 直接起不来。
  2. `Rooms.listFor` / `roomsViewFor`：形参 `ws` → `socket` 后，函数体仍写 `ws` → 认证即
     `server_error`，viewer 永远连不上。
  3. `Rooms.get`：形参 `id` → `roomId` 后，新建房间字面量里仍写 `id,` → `room_register` 抛
     `ReferenceError: id is not defined`。
  4. `Rooms.reapShell`：形参 `id` → `roomId` 后，`this.map.delete(id)` / `_disarmInboxGrace(id)` /
     `sweepRestored(id)` / `retireRoom(id)` 四处没跟着改 → D-4 壳回收全挂。
- 验证：
  - 旧名残留扫描（从 `git diff` 删除行自动提取标识符，**这次把 `id`、`store`、`key`、`list` 也纳入了**）
    只剩线上字段名与 Map 键属性；
  - 定向测试 `relay`、`relay-waiting`、`relay-low-fixes`、`relay-runtime-hardening`、
    `relay-room-registry`、`relay-image-budget`、`conn-frames`、`conn-heartbeat` 共 180 例全过；
  - **全套 `npm test`：2731 用例 / 2724 通过 / 0 失败 / 0 取消 / 7 跳过**。
- diff 体量 547 增 / 547 删。

> 流程补丁 2：B1.3 的旧名映射表漏了 `w`（因为它没被手写进 `commands.js` 的映射表）。
> 本块起映射表完全由 `git diff` 删除行生成，并且**把常见泛词（`id`/`store`/`key`/`list`/`args`）也列进候选**，
> 再人工判读每一跳是「真漏改」还是「线上字段名」。本块 4 个 bug 里有 2 个是 `id` 漏改，
> 只有把 `id` 纳入扫描才看得见。

---

## B1.5 · relay 会话存储命名具体化

提交：`refactor(relay): self-describing names in the session store`

### 范围

`relay/store.js`（3 584 行，`RoomStore` 一个类 125 个方法 + 约 60 个模块级纯函数）。
这是全仓改名面最大、密度最高的一块。

### 问题

- `r`（房间记录）776 处——几乎每个方法的第一参。
- `ctx`（索引上下文）73 处、`rec`（落盘记录）175 处、`v`/`j`/`o`/`f`/`ts`/`op`/`seg`/`ck`/`q`/`h`/`k`
  等单字母字段与变量、`e`（错误与缓存条目两种含义）、`m`（消息 / 正则匹配 / 工具元数据三种含义）、
  `s`（序号 / 段）、`p`（待取代回显 / 指针）、`i`/`n`/`x`/`a`/`b`/`t`、`tmp`、`pos`、`got`、`cnt`、`ptr`、`inf`、`hit`、`le`、`devs`、`wss`、`seqs`、`msgs`、`fp`、`metaObj`。
- 同一文件里 `store` 既指「转录存储」又指「收件箱存储」，`record` 既指「落盘的一行」又指「方法名」。

### 主要改名

| 类别 | 改名 |
|---|---|
| 房间 | `r` → `room`（776 处） |
| 索引上下文 | `ctx` → `indexContext`（73 处，含 `job.ctx` → `job.indexContext`） |
| 落盘记录 | `rec` → `record` |
| 消息 | `m` → `message`；正则匹配 → `match` / `encPrefixMatch` / `prefixMatch` / `seqMatch` / `segmentNameRe` |
| 工具元数据 | `meta` → `toolMetadata`；`metaObj` → `metadataRecord` |
| 段 | `seg` → `segment`；`segs` 保持属性名；`segIdx` 保持 |
| 检查点 | `ck` → `checkpoint`；`ckpt*` 属性名保持 |
| 指针 | `ptr`/`p` → `pointer`；`inf` → `storeInfo` |
| 缓冲/读取 | `buf` 保持（Buffer）；`pos` → `position`；`got` → `bytesRead`；`cnt` → `byteCount` |
| 段文件 | `f` → `segmentFile`；`devs`/`wss` → `deviceSegments`/`workspaceEntries` |
| 序号 | `seqs` → `sequenceNumbers`；`msgs` → `messageCount`；`hit` → `omittedCount` |
| 指纹 | `fp` → `fingerprint` |
| 错误 | `e` → `readError`/`writeError`/`serializeError`/`scanError`/`restoreError`/`repairError`/`renameError`/`resetError`/`checkpointError`/`pointerError`/`dirFsyncError`/`fsyncError`/`cleanupError`/`prewarmError`/`migrationError`/`settleError`/`replayError`/`snapshotError`/`buildError`/`anchorError`/`deliverError` 等按场景命名 |
| 循环 | `i` → `blockIndex`/`capIndex`/`segmentIndex`/`byteIndex`/`lineIndex`/`entryIndex`/`rangeIndex`/`bufferIndex`/`messageIndex`/`tailIndex`/`snapshotIndex`/`dayIndex`；`x` → `child`；`n` → `newlineCount`/`nextSegmentNumber`/`bytesWritten`/`chunkBytes`/`wanted`/`reaped`/`evicted`/`swept`/`omittedCount` |
| 其它 | `q` → `pendingRemote`；`le` → `lastEvent`；`live` → `liveKeys`；`ref` → `inboxRef`；`end` → `turnEnd`；`has` → `hasViewers`；`g` → `group`；`inboxSnap` → `cachedInboxSnapshot`；`res` → `outcome`；`cmdEntry` → `commandEntry`；`w`（占位 waiter）→ `placeholderWaiter`；`lo`/`hi`/`mid`/`best` → `low`/`high`/`middleIndex`/`batchEnd`；`out`（裁剪结果）→ `prunedEntry`/`prunedDevice`；`t` → `trimmed` |

保留不动：**落盘字段名**（`k`/`v`/`seq`/`h`/`ct`/`j`/`op`/`at`/`ref`/`enc`）、`room.id`/`room.seq` 等属性名、
`dir`（Node fs API 对目录路径的标准叫法）、`buf`（Buffer）、`store`（`[store]` 日志前缀与 `bindStore` 形参）。

### 风险与验证

- 风险：**高**。3 584 行、`RoomStore` 的落盘格式与跨对象契约（`job.ctx`、`job.ck`、`base.ck`、
  `pre.fp`、`_journalIfIndexing` 的 `op`）都是「写侧改名 / 读侧漏改」的雷区。
- **踩到 8 个 bug 并全部修掉**（全套测试抓到）：
  1. 全局 `\br\b` → `room` 把 **文件打开标志字符串** `"r"` / `"r+"` 改成了 `"room"` / `"room+"`，
     `fs.openSync` 直接抛 `invalid flags`——整个存储层读写全废。
  2. 全局 `\bv\b` → `value` 把三个**落盘字段名** `v:`（状态 payload / 清单 doc / 指针文件）改成了 `value:`。
  3. 全局 `\bj\b` → `serializedJson` 把 `_packRecent` 写出的 `j:` 改掉，而 `_applyStateRec` 读的是 `.j`。
  4. 全局 `\bop\b` → `operation` 把 6 处 `_journalIfIndexing` 的 `op:` 改掉 5 处，漏了 `remote_message` 那一处，
     而 `_replayJournalOp` 读的是 `.op`。
  5. `_settleIndexJob` 写 `prewarmed.fingerprint` 而 `_room` 读 `prewarmed.fp`（全局 `\bfp\b` 只改了写侧）。
  6. `_readCheckpoint` 返回 `.record` 而 `_applyCheckpointState` 读 `.rec`。
  7. `_startIndexJob` 的 `this._indexJobs.set(id, job)` 漏改（形参已改名 `roomId`）。
  8. `_cancelIndexJob` 的 `this._indexJobs.delete(id)`、`setEncMeta` 的 `prev`、`_applyBase` 的 `base.ck` 同属漏改。
- 验证：
  - `node --check` + 全模块 `require` 通过；
  - 定向测试 `store`、`store-data-integrity`、`store-segments`、`store-rooms-lowrisk`、
    `crypto-stage3`、`crypto-stage3-relay`、`crypto-stage3-archive` 共 122 例全过；
  - **全套 `npm test`：2731 用例 / 2724 通过 / 0 失败 / 0 取消 / 7 跳过**。
- diff 体量 1316 增 / 1316 删。

> 流程补丁 3（**最重要的一条**）：B1.4 起用的「从 diff 删除行提取旧名」扫描，抓不到
> **「写侧键名被改、读侧属性访问没被改」**这一类——因为属性访问（`.fp`）在删除行里根本不以
> `fp` 出现。本块补一道**写读配对审计**：对每个全局改名，同时统计
> 「新名作为对象键的写法」「新名的属性读取」「旧名的属性读取」「旧名作为对象键的写法」，
> 四种组合里出现「写新读旧」或「写旧读新」即报警。本块 8 个 bug里有 5 个是这一道审计抓出来的。
> 另外：**全局单字母正则替换前必须先排除字符串字面量**——bug 1（`"r"`→`"room"`）
> 完全是字符串被误伤，`node --check` 和旧名扫描都放它过去。


---

## 附录：`relay/` 死导出清单（39 个）

判定方法：在 `relay/*.js` 全部文件与 `test/*` 全部文件里搜不到引用的 `module.exports` 名字。
这些名字**在本文件内部仍被使用**（`refs_in_file ≥ 3`：定义 + 导出 + 至少一处调用），死的是导出面，
所以处理方式是「从 `module.exports` 去掉，保留定义」，不是删代码。

| 文件 | 死导出 |
|---|---|
| `relay/acktrack.js` | `createAckTracker` |
| `relay/commands.js` | `armReconcileCleanup`、`stableJson`、`argsDigest` |
| `relay/config.js` | `NUMERIC_CONFIG_FIELDS`、`STRING_CONFIG_FIELDS`、`BOOLEAN_CONFIG_FIELDS` |
| `relay/inbox.js` | `INBOX_TOMB_RETENTION_MS`、`INBOX_TITLE_MAX` |
| `relay/pairing.js` | `PAIR_FAIL_MAX`、`PAIR_FAIL_SOURCES_MAX`、`ed25519PubKey` |
| `relay/prefs.js` | `PREFS_FIELDS` |
| `relay/rooms.js` | `requestExtStatus`、`EXT_STATUS_REQUEST_MIN_MS`、`toolEndMetaEntry`、`roomListCapKey`、`encReasonOf`、`inboxViewFor` |
| `relay/schedule.js` | `INBOX_TITLES`、`SCHEDULE_TICK_MS`、`SCHEDULE_MIN_INTERVAL_MS`、`SCHEDULE_DEFAULT_EXPIRE_MS`、`SCHEDULE_ONCE_GRACE_MS`、`SCHEDULE_RETAIN_MS`、`SCHEDULE_ROOM_ARMED_MAX`、`SCHEDULE_ACCOUNT_ARMED_MAX`、`SCHEDULE_TEXT_MAX_BYTES` |
| `relay/sessionArchive.js` | `isSealedArchive` |
| `relay/store.js` | `contentText`、`remoteEchoMatches`、`deviceSegment`、`SEGMENT_MAX_BYTES`、`UNCLASSIFIED_SEG` |
| `relay/usage.js` | `usageUnavailable`、`USAGE_VERSION`、`USAGE_CACHE_VERSION`、`TZ_OFFSET_MIN`、`TZ_OFFSET_MAX`、`isTimezoneOffset` |

> 注意：`relay/store.js` 的 `hashOf`、`cleanCid`、`encodeCwdSegment`，`relay/rooms.js` 的 `roomsViewFor`、
> `shrinkImagesDeep` 等**不是**死导出——测试或别的 relay 模块在用，动它们会直接红。

### 复搜记录（B3.3 开工前置，审查意见 #2）

第一版名单只扫了 `relay/*.js` + `test/*`。B3.3 动手之前按审查意见做了**全仓复搜**：

- 语料：2 030 个文件，覆盖 `relay/`、`extension/`、`deploy/`、`ui/src/`、`ui/vendor/`、`test/`、
  `DOC/`、`readyUI/`、`protocol/`（排除 `node_modules`、`.git`、`dist`、`.registry`、`public`）。
- 方法：先剥掉行注释与块注释再匹配标识符（避免把「照 relay/devices.js deviceAuthState 的口径」
  这类说明文字当成引用），再排除 owning file 自身。
- 结果：**39 个全部仍然只有 owning file 内部使用**，名单无需增删。
- 唯一需要解释的命中：`relay/usage.js` 的 `USAGE_CACHE_VERSION` 在
  `extension/pi-remote-sync.ts` 里出现 6 次。查证：扩展是单文件模块、`require` 不到 relay，
  它在 10701 行**自己定义**了 `const USAGE_CACHE_VERSION = 1`，两边写的是不同路径下的不同缓存文件
  （relay 写 `data/accounts/usage/<hash>.json`，扩展写自己的 `usageCachePath`）。同名是巧合，不是引用。
- 另外两处「命中」也是文档/注释：`protocol/relay-sync.md:90` 提到 `stableJson`（散文），
  `REFACTOR-LOG.md` / `REFACTOR-PLAN.md` 自己列了这些名字。

**结论：B3.3 可执行，删除面就是这 39 个导出；执行时单独一个提交，便于整体回退。**

---

## 合并上游（审查意见 #1）

提交：`dea18c1 Merge remote-tracking branch 'origin/main' (upstream v2.1.16)`

- 上游 main 已到 v2.1.16（`8c93c6e`），改了 `relay/rooms.js`、`relay/local.js`、`relay/viewer.js`，
  与计划里的 B1.4 / B1.6 / B2.3 / B2.4 / B2.5 完全重叠。按审查意见在动这些块之前先合。
- `git merge --no-edit origin/main` **无冲突**自动合入。唯一与既有重构重叠的地方是
  `relay/local.js` / `relay/viewer.js` 里 `purgeSessions` 的 3 个调用点——B1.1 引入的
  `config: cfg` 键名被正确保留。
- 验证：合并后树上跑全套 `npm test`，**2731 用例 / 2724 通过 / 0 失败 / 0 取消 / 7 跳过**
  （上游自带 29 个新用例，基线 2702 → 2731）。
- 版本号变成 2.1.16 是上游的 bump，不是本次改动。

---

## B1.6 · relay 双通道与启动层命名具体化

提交：`refactor(relay): self-describing names in the local/viewer channels and the startup layer`

### 范围

- `relay/local.js`（2 300 行，local 通道：鉴权、配对、房间注册、事件出口、快照落地）
- `relay/viewer.js`（1 800 行，viewer 通道：页面 HTTP + 全部网页命令面）
- `relay/server.js`（启动编排：单实例锁、端口、sweep、`main`）

### 主要改名

| 类别 | 改名 |
|---|---|
| 配置 | `cfg` → `config`（两通道全部形参与读取） |
| 跨通道上下文 | `ctx` → `relayContext`（`viewerKeyEndpoints`/`localKeyEndpoints`/`routeContentKeyGrant`/`cleanKeyGrant`/`issuePairEntry`/`dropDevice`/`pairCodes`/`pairFailures` 的载体） |
| 入口签名 | `startLocalServer(cfg, rooms, store, ctx, …)` → `startLocalServer(config, rooms, store, relayContext, …)` |
| 请求帧 | `msg` → `frame`（两条通道的 `onMessage` 形参、`runCommand`/`routeHarness`/`routeDeviceCommand`/`routeDeleteSession`/`forwardToLocal`/`adminAuthorized`/`adminSigAuthorized`/`rejectAdminAny` 等全部取帧形参） |
| 连接状态 | `s` → `state`（`socket._state` 的本地别名） |
| HTTP 回调 | `(req, res)` → `(request, response)` |
| 循环/回调单字母 | `c`→`clientSocket`/`connection`、`v`→`viewerSocket`/`option`、`w`→`waiter`、`k`→`code`/`field`、`n`→`closed`、`e`（错误）→ 按场景命名、`i`→`index`/`blockIndex`、`tc`→`toolCall`、`ame`→`assistantEvent`、`idx`→`blockIndex`、`L`→`limits` |
| 出口帧（避免与请求帧同名） | `const frame = {…}` → `outboundFrame`/`answerFrame`/`requestFrame`/`grantFrame`/`roomEventFrame`/`viewerListFrame`/`encFrame` |
| 其它 | `res`（auth_result / migrateRoom 结果）→ `authResult`/`migration`、`r`（rooms.map 扫描）→ `candidate`/`staleRoom`、`seq`（落盘序号）→ `assignedSeq`、`args`（工具参数局部）→ `toolArguments`/`commandArgs` |

### 锚点形状（测试钉住，逐字保留）

- `relay/viewer.js`：`targetRoom = onlineRoomByCwd(deviceId, row.cwd, dev.platform || "")`、
  `const active = dev.activeRoomId ? rooms.peek(dev.activeRoomId) : null`、
  `runCommand(ws, msg, targetRoom, local, extra)`——用文件内别名 `const dev = deviceRecord` /
  `const ws = socket` / `const msg = frame` 保住这三行原文。
- `relay/server.js`：`main()` 内 `let cfg` + `warnMissingWebRoot(cfg)`、`startRelay()` 返回的
  `{ cfg: config, … }` 键名（`test/relay-low-fixes.test.js`、`test/devices.test.js` 等直接读 `relay.cfg`）。
- `relay/server.js` sweep 体的 `const r = rooms.peek(id)` / `cancelResend(r)`（源码锚点）。

### 跨模块对象形状（读侧键名不可改）

- `relay/local.js` 写 `pending = { ws: socket, … }`，`relay/viewer.js` 读 `entry.pending.ws`；
- `relay/viewer.js` 写 `waiter = { ws: socket, … }`，`relay/local.js` 读 `waiter.ws`；
- 两条通道的端点表都写 `{ ws, … }`（`send(endpoint.ws, …)`）。

### 风险与验证

- 风险：**高**。两条通道共用 `relayContext` 传函数，且大量对象是「一侧写键名、另一侧读键名」。
- 全套测试抓到并修掉 **7 处**改漏/改名引发的缺陷：
  1. `handlePair`/`handlePairRequest` 形参已改成 `frame`，函数体仍读 `msg.code`/`msg.device`/`msg.keys`/`msg.deviceToken` → 配对全链路 `server_error`；
  2. `onMessage` 未认证段的鉴权分支被反向改成 `frame.*`，而该段形参是 `msg` → `frame is not defined`，握手全拒；
  3. 同一段里 `s`（连接状态）被改名成 `state`，但 `const s = socket._state` 的声明被回退丢失 → `state is not defined`；
  4. `startLocalServer` 形参改名后 `const index = ctx.index` / `ctx.dropDevice = …` 等 20 余处漏改；
  5. `relay/viewer.js` `content_key_request` 转发循环用了 `e.ws`（`for (const endpoint of …)`）；
  6. `list_viewers` 的出口帧 `const frame = { type: "viewer_list", … }` 在 `frame.id` 读取**之后**声明 → TDZ `ReferenceError`，管理员清单全废；
  7. `routeDeleteSession` 两处 `{ ...msg, args }` 漏改 → 设备级删除不转发；
  8. `schedule_create` 一处 `{ ...msg, roomId }` 漏改 → 排期创建 `error`。
  同类阴影还有 message / dialog_answer / content_key_* 四个出口帧，均在测试转红前按命名规则预防性拆名。
- 一次操作事故（记录在案）：`relay/local.js` 的 B1.6 改名曾被 `cp` 备份覆盖 + `git checkout --`
  回退丢掉一半，靠「文件里还留着旧名」的残留扫描发现后重做。
- 验证：
  - `node -e 'require(...)'` 三文件均可加载；
  - 定向测试 `relay`、`integration-v4`、`crypto-stage2`、`crypto-stage3-relay`、`schedule-relay`、
    `pair-qr-link`、`attach-link`、`pi-pair-link`、`ui-sync`、`index` 等 394 例全过；
  - **全套 `npm test`：2731 用例 / 2724 通过 / 0 失败 / 0 取消 / 7 跳过**（与基线一致）。
- diff 体量：936 增 / 934 删（3 个文件）。

---

## B1.7 · deploy 脚本层命名具体化

提交：`refactor(deploy): self-describing names in the deploy scripts`

### 范围

- `deploy/session-library.cjs`（134 行）：`opts` → `options`、`i` → `index`。
- `deploy/setup.cjs`（193 行）：`opts` → `options`、`err`（writeErr 回调）→ `writeError`、
  `args`（main 的 argv）→ `cliArgs`、`t`/`m`/`e` → `text`/`match`/具名错误。
- `deploy/cloudflared.cjs`（576 行）：`opts` → `options`、`args` → `tunnelArgs`（`handle.args`
  对外字段名保留）、`req`/`res` → `request`/`response`、`tmp` → `tempPath`、
  `vp`/`lp`/`mp` → `viewerPortNumber`/`localPortNumber`/`metricsPortNumber`、
  `u` → `parsed`、`r` → `probeResult`/`tarResult`、`m` → `match`、`n` → `port`、`v` → `pathVersion`。
- `deploy/linux/device.cjs`（1 146 行，最大一块）：`ctx` → `context`（282 处）、`cfg` → `config`
  （含 `settings()` 返回的 `cfg` 键）、`opts`/`o` → `options`、`msg` → `frame`、`res` → `response`、
  `tv` → `tmuxInfo`、`rc` → `exitCode`、`st` → `stateDoc`，以及全部单字母：
  `p` → `targetPath`、`s` → `sessionRow`、`w` → `windowState`、`r` → `result`、`e` → `error`、
  `m` → `match`、`l` → `line`、`u` → `parsedUrl`、`h` → `health`、`t` → `text`、`i` → `index`、
  `d`/`n`/`v`/`a`/`b` 按场景 → `dateValue`/`countValue`/`valueText`/`tokenText`/`rightRow`
  （随后按上下文改成 `dir`/`lineCount`/`versionProbe`/`authProbe`/`token`/`pane`/`healthData` 等），
  `args` → `argv`/`tmuxArgs`。

### 保留不动的名字（对外契约 / 测试锚点）

- `makeContext` 注入对象的字段名（`out`、`err`、`tmux`、`sleep`、`now`、`upWaitMs`、
  `piFallbacks`、`localeSpawn`、`utf8Locale`、`nodeBin`、`WebSocketImpl`、`pairTimeoutMs`）——
  `test/linux-device.test.cjs` 的 `ctxFor` 直接按这些键注入。
- `handle.args`（`test/cloudflared.test.js` 读它核对拼出的隧道参数）。
- 协议/落盘字段名：`args`、`seq`、`msgCount`、`cfg`（`startRelay()` 返回键）。

### 风险与验证

- 风险：**中高**。`device.cjs` 单字母 200+ 处，且大量 `p`/`s`/`d`/`n` 在不同函数里指代不同事物
  （路径 / 会话行 / 日期 / 计数），一刀切改名会改出语义错误。
- **方法论补丁**：本块的机械改名用一个「只改真实代码、不碰字符串/注释/正则字面量」的扫描器
  （模板字面量里的 `${...` 表达式算代码）。第一版把模板字面量整体当字符串、把正则应则当代码，
  两次都把文件改坏（`${` 标记被吞、`/\r?\n/` 里的 `r` 被改名成 `result`）——均已回滚重做。
  这也解释了 B1.6 里 `relay/local.js` 同类事故的根因。
- 踩到并修掉 2 处机械改名的语义错误：`fmtTime` 的补零函数被改名成 `targetPath`、
  `sort((tokenText, rightRow))` 的比较符；另有 1 处 `...ctx.env` 因扫描器漏判漏改（`node --check`
  之后的残留名扫描抓到）。
- 验证：
  - 四个文件均可 `require` 加载；
  - 定向测试 `linux-device`、`linux-attach`、`linux-tmux`、`cloudflared`、`attach`、
    `attach-local` 共 213 例全过；
  - **全套 `npm test`：2731 用例 / 2724 通过 / 0 失败 / 0 取消 / 7 跳过**。
