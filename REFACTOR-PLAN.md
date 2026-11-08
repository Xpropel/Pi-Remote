# REFACTOR-PLAN

把 Pi-Remote 提质到 S 级工程水准的施工图。**先读全仓 → 列问题 → 分块 → 逐块改/测/提交**。
施工纪律与留痕格式见 `REFACTOR-LOG.md`（基线测试结果已记录在那里）。

- 开工前基线：`npm test` 退出码 1，2537 用例 / 2467 通过 / 12 失败 / 51 取消 / 7 跳过。
  其中 8 个测试文件因 `ui/node_modules` 未安装整体崩溃，一个用例都没跑。
- 基线修复后：`npm test` 退出码 0，2702 用例 / 2695 通过 / 0 失败 / 0 取消 / 7 跳过。
  修复内容（可执行位、`unref()` 定时器、过期断言）已记入 `REFACTOR-LOG.md` 并单独提交。
- 上游 v2.1.16 已合入（`dea18c1`）：`relay/rooms.js`、`relay/local.js`、`relay/viewer.js` 与
  B1.4 / B1.6 / B2.3 / B2.4 / B2.5 重叠，所以在动这些块之前先合，冲突面只剩 3 个调用点。
  合并后全套 2731 用例 / 2724 通过 / 0 失败 / 0 取消。
- **行为相关变更必须单独标注**：凡是会改可观察时序/退出时机/错误路径的修补（例如 B0.2 去 `unref()`），
  在 `REFACTOR-LOG.md` 里用 ⚠️ 标出来，不与纯改名/纯拆分混报。

---

## 0. 仓库画像

| 区域 | 文件数 | 代码行数 | 角色 |
|---|---|---|---|
| `relay/` | 24 | 14 620 | 云端中转服务（`npm run relay` → `relay/server.js`） |
| `extension/` | 1 | 11 025 | pi 进程内扩展（单文件部署） |
| `deploy/` | 22 | 13 423 | 设备侧 attach 窗口 / 安装 / 发布脚本 |
| `ui/src/` | ~480 | 112 158 | 浏览器端（React + TS） |
| `test/` | 166 | 64 763 | 全套回归 |
| `DOC/` `readyUI/` `protocol/` | 20 | 3 875 | 设计与协议文档（事实源在 `protocol/v4.json`） |

技术形态：relay 与 deploy 是 CommonJS（Node ≥ 22.18）；UI 是 TS/React（Vite），测试用 Node 原生
`node --test` 直接 import `.ts` 源文件 + `jiti` 加载扩展。

### 边界约束（先讲清楚，后面所有分块都受它约束）

| 约束 | 来源 | 后果 |
|---|---|---|
| `extension/pi-remote-sync.ts` 必须是**单个自包含文件** | `deploy/sync-extension.sh` / `.ps1` 只拷这一个文件；`test/linux-device.test.cjs`、`test/start-pi*.test.*`、`test/deploy-scripts.test.js` 都按"一个文件"断言内容相等 | **不能拆**。只能做重命名、去死代码、内部重排、注释与常量归位 |
| `deploy/`、`deploy/docker/` 的**文件构成冻结** | `test/linux-device.test.cjs` 的 `KIT_FILES` 是精确清单；加/删/改名文件都会让测试红 | **不能加新文件**。只能做文件内重构 |
| 协议常量不许手改副本 | `protocol/sync.cjs` 从 `protocol/v4.json` 生成 `relay/protocol.json` 与扩展里的 `PROTOCOL` 块，`test/protocol.test.js` 用 `--check` 校验 | 改协议只能改 `protocol/v4.json` 再跑 `npm run sync:protocol`；本计划不碰 |
| 跨进程同源的实现不许合并 | 扩展 / relay / attach / UI 是四个进程，`hashOf`、`remoteEchoMatches`、`keyFingerprint`、`normPath`、`shrinkImagesDeep` 必须逐字一致 | 只补"同源"注释与对拍测试，不抽公共模块 |

---

## 1. 问题清单

### A. 规模与结构

| # | 问题 | 位置 |
|---|---|---|
| A1 | 11 025 行单文件扩展：`class Bridge` 一个类约 6 600 行，外加约 120 个模块级函数 | `extension/pi-remote-sync.ts` |
| A2 | 6 456 行 attach CLI：157 个顶层函数 + 2 000 行 `AttachController` | `deploy/attach.cjs` |
| A3 | `useRelay()` 一个 React hook 5 400 行、约 150 个 `useState`/`useRef` | `ui/src/relay/useRelay.ts` |
| A4 | `RoomStore` 一个类 125 个方法，外加 60 个模块级助手 | `relay/store.js`（3 584 行） |
| A5 | 2 394 行二维码渲染/终端绘制 | `deploy/qrcode.js` |
| A6 | `startLocalServer` 约 1 540 行，外加 90 个 `remember*` 房间状态函数混住 | `relay/local.js`（2 264 行） |
| A7 | `startViewerServer` 约 1 730 行单函数 | `relay/viewer.js`（1 811 行） |
| A8 | `Rooms` 类与 60 个 `sendCached*` / 视图投影函数混住 | `relay/rooms.js`（1 782 行） |
| A9 | 转录归约、类型、分组、图片、bash 截断、工具渲染全在一个文件 | `ui/src/relay/transcript.ts`（1 733 行） |
| A10 | `ui/src/pi/**` 一批 600–1 000 行组件（侧栏、容器、设置页） | `PiSidebar.tsx`、`ComposerContainer.tsx`、`settings/**` 等 |

### B. 依赖结构

| # | 问题 | 位置 |
|---|---|---|
| B1 | **循环依赖**：`relay/index.js` 顶层 `require("./devices")`，`relay/devices.js` 顶层 `require("./index")`。现在靠 `index.js` 里一个函数内懒 `require("./devices")` 拆环（`pathUnderRoot`） | `relay/index.js:183`、`relay/devices.js:3` |
| B2 | `DOC/10-relay-backend.md` §1.1 明确写"依赖只往表的上方指，没有循环"，实现已走样；后续 store/local/viewer/rooms 膨胀后没再拆分 | — |

### C. 命名（违反原则 2）

| # | 问题 | 规模 |
|---|---|---|
| C1 | 缩写/泛词标识符：`seq` `idx` `tmp` `val` `cfg` `msg` `opts` `args` `cb` `fn` `err` `res` `req` `ctx` `obj` `arr` `str` `num` `dir` | 209 处声明（extension 43、attach 38、store 15、rooms 7、server 6、local 6 …） |
| C2 | 单字母标识符：`r` `s` `t` `p` `e` `b` … | 约 700 处（extension 212、store 101、qrcode 89、attach 67、transcript 44 …） |
| C3 | 同义不同名：`cfg` / `config` / `options` 并存；`dir` / `path` / `root` 混用 | 全仓 |

### D. 重复实现

| # | 问题 | 位置 |
|---|---|---|
| D1 | `aDeviceRosterParts` 用注释"照 `relay/devices.ts` `deviceAuthState` 的口径"复刻了一份设备状态判定 | `ui/src/components/pi/shell/PiDevicePairing.tsx:10` |
| D2 | TODO 工具名集合两份，内容还不一致（`todoread`/`tasks` 只在一份里） | `ui/src/pi/model/toolWeight.ts:15`、`ui/src/components/pi/conversation/tools.ts:14` |
| D3 | `capStr` 两份、`fsyncFile` 三份、`numOr` 独一份 | `relay/inbox.js`、`relay/schedule.js`、`relay/index.js`、`relay/prefs.js` |
| D4 | relay 内多处"JSONL 追加 + fsync + 读时按 id 合并"逻辑各写一遍 | `relay/index.js`、`inbox.js`、`schedule.js`、`prefs.js` |

### E. 死代码 / 死导出

| # | 问题 | 规模 |
|---|---|---|
| E1 | 导出但仓库内（含测试）无人引用的名字 | 39 个，见 `REFACTOR-LOG.md` 附录（`store.js` 的 `deviceSegment`/`SEGMENT_MAX_BYTES`/`UNCLASSIFIED_SEG`、`rooms.js` 的 `encReasonOf`/`roomListCapKey`/`inboxViewFor`、`schedule.js` 的 9 个 `SCHEDULE_*` 常量 …）——**全部仍在本文件内部使用，死的是导出面** |
| E2 | 纯别名导出，无人使用 | `extension/pi-remote-sync.ts:914` `encryptMessageBody = sealBody`、`:932` `decryptMessageBody = openBody` |
| E3 | `extension/pi-remote-sync.ts` 导出的 `PROTOCOL` / `CLIENT_CAPS` 等被测试引用，**不是**死代码（误报高发区，逐个确认后再动） | — |

### F. 错误处理不一致

| # | 问题 | 规模 |
|---|---|---|
| F1 | 静默吞错的空 `catch {}` | 331 处（无法逐个人工判断，按"是否必须吞"分级：必须吞的加一句为什么，其余改成记录或上报） |
| F2 | `: any` 大量使用，类型边界糊 | 658 处（集中在扩展；全改成精确类型不现实，优先改公开导出签名） |
| F3 | 错误构造三套并存：`RemoteError` + `remoteErrorCode`、`fileAccessError`、`sessionFileError` | `extension/pi-remote-sync.ts` |
| F4 | `deploy/attach.cjs` 与 `extension/pi-remote-sync.ts` 对"钥文件损坏"的文案/降级路径各写一份 | — |

### G. 魔法常量

| # | 问题 | 位置 |
|---|---|---|
| G1 | `dialogAnswerTimeoutMs` 的兜底值 `120000` 在扩展里写死，而协议里已有该键 | `extension/pi-remote-sync.ts:5199` |
| G2 | 命令超时 `120000` 写死两处 | `relay/commands.js:19,21` |
| G3 | 字符/字节上限常量散落，未标注是否来自 `protocol/v4.json` 的 `limits` | 全仓（`IMAGE_MAX_CHARS`、`PARTIAL_TAIL_CHARS`、`HEAVY_FIELD_CHARS` …） |

### H. 已知但**不动**（改了就等于改接口语义，只记录）

| # | 问题 | 为什么不改 |
|---|---|---|
| H1 | `deviceAuthState({auth:"key", paired:false})` 显示"未配对"，而钥设备其实已配对 | `paired` 的契约在 `relay/devices.js` 注释里写死为"有没有有效设备令牌"；改 relay 输出=改协议，改 UI=改展示语义。记录待产品决策 |
| H2 | 扩展单文件契约 | 见边界约束 |
| H3 | `deploy/` 文件构成 | 见边界约束 |

---

## 2. 分块计划

顺序原则：**先叶子后枝干、先低风险后高风险、先能单独验证的**。每块一个提交，提交前跑全套 `npm test`。

图例：风险 = 改坏的可能性 × 回归面；验证 = 该块的专项验证手段（全套 `npm test` 每块都跑）。

### 第 0 阶段 · 基线修复（已完成，见 REFACTOR-LOG.md）

| 块 | 内容 | 风险 | 验证 |
|---|---|---|---|
| B0.1 | 恢复 `deploy/start-pi.sh`、`deploy/linux/push.sh`、`deploy/deploy-relay.sh` 的可执行位 | 无 | `deploy-scripts`、`start-pi-sh`、`linux-device` |
| B0.2 | 去掉三处"正确性依赖"定时器的 `unref()` | 低 | `cloudflared`、`extension`、`extension-ask-select-local` |
| B0.3 | 修正 `linux-tmux` 的过期断言 + tmux 3.4 探针口径 | 低 | `linux-tmux` 连跑 8 次 |

### 第 1 阶段 · 命名具体化（C1/C2/C3）

纯机械改名，逐文件推进；每块改完立刻全套测试。**从被依赖最多的叶子模块开始**，让后面的块受益。

| 块 | 范围 | 风险 | 验证 |
|---|---|---|---|
| B1.1 | ✅ `relay/util.js`、`relay/wire.js`、`relay/conn.js`、`relay/acktrack.js`、`relay/web.js`、`relay/notify.js`、`relay/purge.js`、`relay/sessionArchive.js` | 低 | `conn-frames`、`conn-heartbeat`、`web-static`、`notify`、`relay-runtime-hardening` |
| B1.2 | ✅ `relay/config.js`、`relay/pairing.js`、`relay/devices.js`、`relay/index.js`、`relay/prefs.js` | 中 | `devices`、`index`、`preauth-local`、`prefs-sync`、`pair-qr-link`、`protocol` |
| B1.3 | ✅ `relay/commands.js`、`relay/inbox.js`、`relay/schedule.js`、`relay/usage.js` | 中 | `inbox*`、`schedule*`、`usage*`、`relay-waiting` |
| B1.4 | ✅ `relay/rooms.js` | 中高 | `relay`、`relay-waiting`、`crypto-phase4-t1`、`attention*` |
| B1.5 | ✅ `relay/store.js`（101 处单字母，最密） | 中高 | `store`、`store-*`、`crypto-stage3*`、`relay-image-budget` |
| B1.6 | ✅ `relay/local.js`、`relay/viewer.js`、`relay/server.js` | 中高 | `relay`、`attach*`、`local-device`、`integration-v4` |
| B1.7 | ✅ `deploy/cloudflared.cjs`、`deploy/setup.cjs`、`deploy/session-library.cjs`、`deploy/linux/device.cjs` | 中 | `cloudflared`、`start-pi*`、`linux-*`、`deploy-scripts` |
| B1.8 | `deploy/attach.cjs`（105 处） | 中高 | `attach*`、`qrcode`、`deploy-scripts`、`linux-*` |
| B1.9 | `deploy/qrcode.js`（89 处） | 中 | `qrcode`、`pair-qr-link` |
| B1.10 | `extension/pi-remote-sync.ts`（255 处，最密） | 高 | `extension*`、`usage*`、`keyauth*`、`integration-v4`、`ui-*` |
| B1.11 | `ui/src/relay/*.ts` | 中 | `ui-sync`、`ui-*` |
| B1.12 | `ui/src/chat/**`、`ui/src/conversation/**`、`ui/src/shell/**` | 中 | `chapter5-*`、`conversation`、`shell`、`streaming-markdown` |
| B1.13 | `ui/src/pi/**`、`ui/src/components/**` | 中 | `pi-*` 全量 |

> 改名手法：整文件 `git mv` 不动（只改标识符），用词表驱动 + 编译/导入检查。
> UI 侧额外跑 `ui` 的 `tsc -b`（`ui/package.json` 的 `build` 第一步）确认没有拼错引用。

### 第 2 阶段 · 大文件拆分（A1–A10）

只拆**允许加文件**的区域：`relay/`、`ui/src/`。`extension/`、`deploy/` 受边界约束不能加文件，只做第 3 阶段的内部整理。

| 块 | 拆分 | 新模块 | 风险 | 验证 |
|---|---|---|---|---|
| B2.1 | 破环：把 `normPath` / `underRoots` / `cwdAllowed` / `normalizePlatform` / `POSIX_PLATFORMS` 提到 `relay/paths.js`（叶子，无内部依赖） | `relay/paths.js` | 中 | `devices`、`index`、`attach*`、`relay`；并加一条"index 不再懒加载 devices"的断言 |
| B2.2 | `relay/store.js` 抽出纯函数层：seq 区间打包、记录/信封形状、`hashOf`、`remoteEchoMatches`、`cleanCid`、`toolMeta*`、路径段编码、存储常量 | `relay/store/seqRanges.js`、`relay/store/recordShape.js`、`relay/store/constants.js`；`relay/store.js` 保留 `RoomStore` 与既有导出（转出） | 中高 | `store`、`store-*`、`crypto-stage3*`、`relay-image-budget` |
| B2.3 | `relay/local.js` 拆成"房间状态记忆"与"7001 通道装配" | `relay/local/roomState.js`（90 个 `remember*`/`clean*`）、`relay/local/server.js`（`startLocalServer`）；`relay/local.js` 只转出 | 中高 | `relay`、`local-device`、`integration-v4`、`attach*` |
| B2.4 | `relay/viewer.js` 拆出认证/配对/命令路由/帧处理 | `relay/viewer/auth.js`、`relay/viewer/commands.js`、`relay/viewer/frames.js`、`relay/viewer/server.js` | 高 | `relay`、`viewer-*`、`crypto-*`、`usage-*`、`pi-pair-link` |
| B2.5 | `relay/rooms.js` 拆出"重发缓存发送器"与"名册/收件箱/排期视图" | `relay/rooms/resend.js`、`relay/rooms/views.js`、`relay/rooms/inboxSync.js`、`relay/rooms/scheduleDispatch.js` | 中高 | `relay`、`relay-waiting`、`inbox*`、`schedule*`、`crypto-phase4-t1` |
| B2.6 | `ui/src/relay/transcript.ts` 按职责拆 | `transcript/types.ts`、`transcript/reducer.ts`、`transcript/grouping.ts`、`transcript/images.ts`、`transcript/bashTail.ts`、`transcript/toolDisplay.ts`；原文件转出 | 中 | `ui-sync`、`ui-perf-*`、`conversation`、`streaming-markdown`、`pi-*` |
| B2.7 | `ui/src/relay/devices.ts`、`viewerIdentity.ts` 拆 | `devices/roster.ts`、`devices/pairLink.ts`、`viewerIdentity/core.ts`、`viewerIdentity/backup.ts` | 中 | `ui-viewer-identity*`、`identity-backup-ui`、`pi-pair-link`、`ui-sync` |
| B2.8 | `ui/src/relay/useRelay.ts` 抽子 hook（**最高风险，放最后**） | `useRelay/connection.ts`、`useRelay/rooms.ts`、`useRelay/dialogs.ts`、`useRelay/roomCrypto.ts`、`useRelay/history.ts`、`useRelay/outbox.ts`、`useRelay/notices.ts`、`useRelay/index.ts` | 高 | `ui-sync`、`ui-*`、`pi-*`、`mobile`、`chapter5-*` |
| B2.9 | `ui/src/pi/**` 大组件：把纯模型/逻辑搬到同级 `model/` 或 `*.model.ts`，组件只留渲染 | 逐文件 | 中 | 对应 `pi-*` 测试 |

> 拆分手法：**逐行搬运，行为不变**（DOC/10 §1.1 当年就是这么做的）。原文件保留并转出所有既有导出名，
> 保证 `require`/`import` 路径不变；新模块之间不允许成环（拆完跑一次环检测脚本）。

### 第 3 阶段 · 设计纠偏（D/E/F/G）

| 块 | 内容 | 风险 | 验证 |
|---|---|---|---|
| B3.1 | 收敛 D1/D2：`aDeviceRosterParts` 改为复用共享纯函数；两份 TODO 工具名集合合并成一处导出 | 中 | `pi-fixtures`、`ui-sync`、`pi-ui-variants` |
| B3.2 | 收敛 D3/D4：`capStr`/`fsyncFile`/JSONL 读写助手提到 `relay/jsonl.js`，四家共用 | 中 | `index`、`inbox`、`schedule`、`prefs-sync` |
| B3.3 | 删 E1 的死导出（本文件内部仍可用的保留定义，只从 `module.exports` 去掉）；删 E2 的两个别名 | 低 | 全套（重点 `store`、`rooms`、`schedule`、`usage`、`config`） |
| B3.4 | G1/G2/G3：魔法常量改为具名常量，来自协议的标注 `PROTOCOL.limits.<key>`，来自产品决策的标注出处注释 | 低 | 全套 |
| B3.5 | F1：331 处空 `catch` 分级——必须吞的（清理路径、尽力而为的通知）加一句为什么；其余改成记日志或计数 | 中 | 全套 + 人工审 diff |
| B3.6 | F3：统一扩展侧错误构造出口（`RemoteError` + 码表），`fileAccessError`/`sessionFileError` 改为它的薄包装 | 中 | `extension*`、`integration-v4` |
| B3.7 | 文档同步：`DOC/10-relay-backend.md` §1.1 的模块表按拆分后的真实结构更新；`README` 的组件表不变 | 无 | `deploy-scripts`（不改脚本） |

#### B3.3 开工前置（硬性，审查意见 #2）

删死导出之前必须做**全仓复搜**，不能只扫 `relay/` + `test/`：

1. 语料必须覆盖 `relay/`、`extension/`、`deploy/`、`ui/src/`、`ui/vendor/`、`test/`、`DOC/`、
   `readyUI/`、`protocol/`（排除 `node_modules` / `.git` / `dist` / `.registry` / `public`）。
2. 匹配前先剥掉行注释与块注释——「照 relay/devices.js `deviceAuthState` 的口径」这类说明文字
   不是引用，`DOC/*.md` 与 `protocol/*.md` 的散文提及也不算。
3. 对每个命中逐个查证是不是**真引用**（`require`/`import`/解构），同名但各自定义的常量要能说清
   两边写的是不同文件（例：`USAGE_CACHE_VERSION` 在扩展里是自己定义的那份）。
4. 复搜结果写进 `REFACTOR-LOG.md` 附录；**删除单独成一个提交**，便于整体回退。

已完成的复搜结论见 `REFACTOR-LOG.md`「附录 · 复搜记录」：39 个全部仍然死，名单无需增删。

### 收尾

- 全量 `npm test` 绿 + `npm run sync:protocol -- --check` 绿 + `cd ui && npx tsc -b` 绿。
- `REFACTOR-LOG.md` 补一条总结：改了哪些文件、行数变化、测试从 2537→? 。
- 本地 git 提交，不推远端。

---

## 3. 每块的通用验证方式

1. **全套**：`npm test`，要求 `# fail 0` 且 `# cancelled 0`（7 个平台 skip 允许）。
2. **协议副本一致性**：`npm run sync:protocol -- --check`（`test/protocol.test.js` 已覆盖，单独跑用于快速定位）。
3. **UI 类型**：`cd ui && npx tsc -b --noEmit` 风格的编译检查（`ui/package.json` 的 `build` 第一步就是 `tsc -b`）。
4. **环检测**：拆分类块跑一次 `relay/` 的 `require` 环扫描（B2.1 起每次都要）。
5. **定向**：按上表"验证"列先跑相关测试文件，再跑全套。
6. **回退线**：任一块全套不绿且 30 分钟内修不绿，`git reset --hard` 回退该块，把结论写进 `REFACTOR-LOG.md` 再换思路。

## 4. 明确不做

- 不改 `package.json` / `ui/package.json` 的版本号与依赖（`ui/node_modules` 只是把锁文件里已有的包装上，不入库）。
- 不动 `deploy/`、`deploy/docker/`、`extension/` 的文件构成。
- 不改协议语义、帧字段、命令名与参数、错误码表。
- 不推远端。
- 不改 H1/H2/H3 三项（记录待决）。
