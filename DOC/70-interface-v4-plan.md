# 数据接口 v4：系统检查结论与改造规划

> 范围：本机扩展（`extension/pi-remote-sync.ts` + `deploy/attach.cjs`）、前端数据层（`ui/src/relay/*`）、服务端（`relay/*`），以及它们之间的两条线：7001 local 通道、7002 viewer 通道。
> 依据：逐个读了三端的收发代码和 `readyUI/data-interface.md`（v3.1），对照了每种帧谁发、谁收、文档怎么写。下文的行号指 `cursor/mac-local-device` 分支（提交 72fd7d5）。
> 状态：**规划，待确认**。先定第 5 节的几个决策，再按第 4 节分期动手。

## 1. 总体判断

功能面已经很全（45 个命令、38 种事件、增量同步、受理回执、去重重发都有），也修过很多轮；不成熟的地方集中在**接口本身没有被当成一个独立的、有版本的产品来管理**：

- 线上没有协议版本，三端靠"对方回没回某个帧 / 报没报 unknown_type"猜能力；
- 同一件事在不同地方用不同形状表达（错误有四种写法、两条通道两套帧名、发消息有两条路）；
- 远程消息从网页到 pi 再回来，全程靠**消息文本**对号，没有消息 id；
- 契约文档是手写的，类型靠"拷进 readyUI"，扩展和 relay 里没有类型，三端各自解析、各自兜底；
- 所有设备共用一个 local token，7001 明文对公网开放。

这些不是零散 bug，而是会让后面每加一个功能都要三端各修一遍的结构问题。下面按主题列证据，再给分期方案。

## 2. 问题清单（按主题，P0 = 正确性/安全，P1 = 可靠性/契约不一致，P2 = 可维护性/性能）

### 2.1 协议版本与能力协商

| 级别 | 问题 | 证据 | 影响 |
|---|---|---|---|
| P1 | 线上没有任何协议版本字段；`auth` / `auth_result` 只有 `boot`（relay 进程实例） | `relay/server.js` 814 起的 local 鉴权、viewer 鉴权；data-interface §13 `ServerMessage` | 新旧版本混跑时无法判断对方支持什么 |
| P1 | 扩展靠"relay 有没有回 `room_registered`"判断是否 v3（`relayV3`），2.5s/5s 超时后推全量 | `extension/pi-remote-sync.ts` 1519–1542 | 网络慢就误判成旧 relay，白推一次全量快照 |
| P1 | 扩展靠解析 `unknown_type` 错误**文本**里有没有 `room_label` 来降级（`noRoomLabel`） | 同上 1728–1737 | relay 改一个字的报错文案，降级逻辑就失效 |
| P1 | 前端收到任何 `unknown_type` 就整体切进 legacy 模式、关掉设备名册 | `ui/src/relay/useRelay.ts` 706–712 | 一个无关的新帧被旧 relay 拒绝，就把整个设备功能关了 |

### 2.2 消息与命令的身份（id）

| 级别 | 问题 | 证据 | 影响 |
|---|---|---|---|
| **P0** | 远程消息全程按**文本**对号：前端乐观气泡按文本被取代/标失败；扩展按文本确认送达；relay 存储按文本摘掉失败的回显 | 前端 `transcript.ts` 529–570；扩展 `deliveryKey`/`trackDelivery` 1900–1966；relay `store.markRemoteFailed` 648 | 连发两条相同内容（"继续"、"好"）时，失败标到另一条、成功的被当失败、或回显被错误摘掉；多端同时发同样的话也会串 |
| P1 | relay → 扩展的 `message` 帧只有 `{room, text}`，没有请求 id | `relay/server.js` 1679 | 扩展的成功/失败回报无法精确对应到哪一次发送 |
| P1 | 发消息有两条路：`message` 快捷帧（不去重、不能重发）和 `prompt/steer` 命令（去重、受理回执）；前端用后者，relay 两条都留着 | `useRelay.ts` 1063；`server.js` 1662 起；data-interface §13 注释"快捷帧：不去重，勿重发" | 两套语义、两套失败处理，新客户端很容易用错 |

### 2.3 响应与错误的形状

| 级别 | 问题 | 证据 | 影响 |
|---|---|---|---|
| P1 | 错误至少四种写法：`error` 帧（`code`+`message`）、`ack{ok:false,error:文案}`、`ack{ok:false,error:"device_no_active_session"}`（`error` 字段里放的是码）、`ack{ok:false,error,code}`；契约里明写"不要互相改写成同一种" | data-interface §3（309–314 行）；`server.js` `ackFrame` 600 | 前端要按来源写不同的解析分支；错误码表无法穷举 |
| P1 | 房间命令的失败只有中文文案、没有错误码（扩展 `sendResult` 只发 `error` 字符串） | 扩展 1832–1836、各 `cmd*` 里的 `throw new Error("…")` | 前端只能用正则匹配文案判断（例如 `/未知命令/` 决定是否走旧 abort 帧，`useRelay.ts` 1079） |
| P1 | 查询类请求（`get_sessions`）超时走 `error{code:"timeout"}`，命令超时走 `ack{ok:false}`，两套超时机制 | `server.js` 1511–1516；`commands.ts` | 同类"请求-响应"有两种回包和两种前端处理 |
| P2 | 45 个命令的参数校验是各自手写的 `if (!args.x) throw`，返回值形状各异（有的 `{ok:true,…}`，有的直接是数据，`get_context_usage` 可能返回 `null`） | 扩展 2063–2150 | 没有机器可读的命令表，前端/文档/实现三处各写一份 |

### 2.4 两条通道的帧与文档

| 级别 | 问题 | 证据 | 影响 |
|---|---|---|---|
| P1 | 7001 上的核心帧（`event`、`state`、`usage`、`sync`、`snapshot{mode:"append",base}`、`room_registered`、`snapshot_request`、`command_result`、`room_label`、`room_closed`）在契约里几乎没有定义；§13 的 `LocalChannelMessage` 只列了 4 种 | data-interface 1319–1328；`server.js` 827–1149 的 case 列表 | 本机端协议"代码即文档"，换人或换实现（比如以后的 Linux 设备代理）只能读源码 |
| P2 | 同一概念两套名字：local 上叫 `event` / `state` / `usage` / `command_result`，viewer 上叫 `room_event` / `room_state` / `usage_state` / `ack` | 同上 | 排障时要在两套词汇之间翻译 |
| P2 | 契约自相矛盾或留白：§3 两行"限速"写法不同；`command_accepted.room` 注释写着"设备级是否仍带，50 号没写"；事件联合类型末尾是 `{type:string;[k:string]:unknown}` | data-interface 284–285、1303、1406 | 类型兜底太宽，等于没有类型 |
| P2 | §13 的 TS 类型要"拷进 readyUI"，前端的 `RoomInfo`/`Device` 等是另写的；扩展和 relay 没有类型 | `ui/src/relay/devices.ts`、`useRelay.ts` | 三端漂移只能靠人工审查发现（`readyUI/frontend-review.md` 记录了好几轮这种修补） |

### 2.5 事件模型与 pi 版本耦合

| 级别 | 问题 | 证据 | 影响 |
|---|---|---|---|
| P1 | 事件基本是 pi 内部事件原样转发（投影只是瘦身），未知事件默认 `shrinkDeep` 后照发 | 扩展 `projectEvent` 437–523 | 前端直接依赖 pi 1.0.2 的内部事件形状；pi 升级改一个字段，网页就坏，而且没有任何一层能发现 |
| P2 | 前端事件处理是 30 多个 `case` 的大 switch，散在 `useRelay.ts` 和 `transcript.ts` 两处 | `useRelay.ts` 274–420 | 改事件语义要改两处 |

### 2.6 同步与快照

| 级别 | 问题 | 证据 | 影响 |
|---|---|---|---|
| P1 | 快照是"整条分支一次给完"，上限 10000 条 / 24MB；手机打开长会话要一次收完 | `server.js` DEFAULT_CONFIG `maxSnapshotRecords`/`maxSnapshotBytes`；`history` 分页已废弃（1657） | 移动网络下首屏慢、费流量；超过上限就静默截断，只能提示"只加载了最近一部分" |
| P2 | 流式中的半条回复不进存储，断线重连到 `message_end` 之前看不到正在输出的内容 | `store.record` 只给落盘事件分 seq | 手机切后台再回来，正在生成的回复是空的，要等这条结束 |

### 2.7 安全与多设备

| 级别 | 问题 | 证据 | 影响 |
|---|---|---|---|
| **P0** | 所有设备、所有 pi 进程共用同一个 localToken；任何持有它的一方都能用别人的 `deviceId` 发 `device_register`，把真设备顶下线（`device_replaced`），或注册任意房间 | `server.js` 814、827–912 | 一台电脑泄露 `.env`，所有设备的身份都不可信；加 Mac、Linux 后风险成倍 |
| **P0** | 7001 明文 ws 对公网开放（生产 `/etc/pi-remote.env` 里有 `PI_REMOTE_LOCAL_HOST`），7002 也是明文；viewerToken 被嗅探等于远程执行 | `deploy/README.md` 1.1 节"当前这套部署的实际取值"；服务器检查结果 | 这是目前最大的风险点，文档里已承认但没处理 |
| P2 | 账户固定 `admin`，没有多用户 | 契约 §4.12 | 现在够用；做多用户前要先把设备鉴权做对 |

### 2.8 服务端实现

| 级别 | 问题 | 证据 | 影响 |
|---|---|---|---|
| P2 | `relay/server.js` 1877 行，两个端口的全部帧处理在两个大 switch 里 | 827–1149、1497–1710 | 难测、难审，加帧容易漏校验 |
| P2 | 名册/清单（`relay/index.js`）每次读写都把整个 jsonl 同步读一遍再解析；每次广播房间列表都会读一次设备名册 | `index.js` 27–31、272、294；`server.js` `buildDeviceList` | 现在文件是 KB 级没问题，设备和会话多了以后在事件循环上做同步磁盘 I/O |
| P2 | 没有健康检查与指标端点；部署验证靠 `GET /` 返回 200 | `deploy-relay.*` 的 verify 段 | 线上出问题只能翻 journald |
| P2 | 没有 CI；端到端测试要手工起三个进程 | `开发工具（未随公开仓提供）` | 回归靠自觉 |

### 2.9 本机扩展与前端实现

| 级别 | 问题 | 证据 | 影响 |
|---|---|---|---|
| P2 | 扩展单文件 3316 行（必须装成一个文件进 `~/.pi/agent/extensions/`） | `extension/pi-remote-sync.ts` | 同上；但"装成一个文件"可以靠打包解决，源码不必是一个文件 |
| P2 | 前端 `useRelay.ts` 1352 行，几十个 `useRef` 互相牵制（`pendingSwitchRef`、`expectedSessionFile`、`armingRef`…），连接、订阅、名册、会话切换的状态机揉在一个 hook 里 | `useRelay.ts` | 会话切换类 bug 反复出现（frontend-review 多轮记录），修一处牵一片 |
| P2 | 前端对收到的帧基本是 `Record<string, unknown>` + 就地断言，没有统一的入口校验 | `useRelay.ts` 562–821 | 坏帧的处理分散、不一致 |

## 3. 目标形态（v4）

一句话：**一份机器可读的协议定义，三端共用；线上带版本和能力；所有请求有 id、所有失败有码；本机事件先归一成 pi-remote 自己的事件模型再上线。**

1. **协议包 `protocol/`**（新目录，TypeScript，零依赖）：
   - 帧定义：两条通道、两个方向的所有帧，统一命名（同一概念同一个名字，方向由通道决定）；
   - 命令表：每个命令的参数、返回值、是否只读、超时类别、需要的能力；
   - 错误码表：`code` + 默认文案 + 是否可重试；
   - 运行时校验函数（手写、零依赖，便于扩展打包）；
   - 由它**生成**契约文档里的帧表/命令表/错误码表和前端类型，`data-interface.md` 只保留叙述部分。
   - 扩展、relay、前端都从这里取类型和校验；relay 仍是纯 JS，用构建产物（或 JSDoc 引用）。
2. **握手**：`auth` 带 `proto`（整数）与 `caps`（能力列表），`auth_result` 回 relay 的 `proto` 与 `caps`。三端按能力启用功能，删除 `relayV3` / `noRoomLabel` / `legacyRef` 这类猜测。旧客户端不带 `proto` 时按 v3 处理（兼容期）。
3. **统一请求-响应**：所有客户端请求带 `id`；回应只有两种：`result{id, data}` 和 `error{id, code, message, retryable}`；长任务先回 `accepted{id, timeoutMs}`。v3 的 `ack`/`command_accepted`/带 id 的 `error` 在兼容期继续发。
4. **消息 id 贯穿**：网页发消息生成 `cid`，经 relay → 扩展 → 回显事件 → 送达确认/失败 → 存储取代，全程按 `cid` 对号；文本匹配只作为旧客户端的兜底。
5. **事件模型归一**：扩展把 pi 事件翻译成 pi-remote 事件（消息开始/增量/结束、工具开始/进度/结束、忙闲、用量、压缩、重试…），带 `v`；pi 原始事件只在调试开关下转发。pi 升级时只改扩展这一层。
6. **快照分页**：订阅先给"尾部 N 条 + 总数"，向上滚动按 seq 范围取更早的页；保留"增量续订"。流式中的半条回复作为房间状态的一部分随订阅下发。
7. **设备鉴权**：每台设备一个 device token（`attach --init` 时用一次性配对码向 relay 换取），pi 扩展和 attach 窗口都用它；localToken 降级为"配对用"。relay 只认 token 绑定的 deviceId。
8. **传输安全**：7001/7002 走 TLS（有域名用 Caddy 自动证书）；没有域名时，把服务器加入你现有的 Tailscale 网络，7001 只绑 tailnet 地址，公网只留 7002（或也走 tailnet，手机装 Tailscale）。

## 4. 分期计划

每一期都保持新旧兼容：relay 先升级并同时说 v3/v4，再升扩展，最后升前端；每期结束在阿里云上做端到端验证，Windows 和 Mac 两台设备都要在线。

| 期 | 内容 | 主要改动 | 验收 | 规模 |
|---|---|---|---|---|
| **0** 收尾 | 部署本次 Mac 版（向后兼容），Windows 端同步 `cursor/mac-local-device` | 已完成的代码 | 阿里云上 Windows + Mac 同时在线，网页能分别拉起会话 | 小 |
| **1** 安全底线 | ① 传输加密（TLS 或 Tailscale，二选一见 5.2）② 每设备 token + 配对流程 ③ relay 只接受 token 绑定的设备身份 | relay、attach、扩展、部署脚本、`.env` | 抓包看不到明文 token；拿 A 设备的 token 不能登记成 B；旧 localToken 只能用于配对 | 中 |
| **2** 协议包与握手 | ① 新建 `protocol/`：帧、命令、错误码、校验 ② `auth` 增加 `proto/caps` ③ 三端入口统一走校验 ④ 补全 7001 帧的文档（由协议包生成） ⑤ 去掉三处能力猜测 | 新目录 + 三端入口 | 三端类型都从协议包来；未知字段/坏帧有统一日志；契约文档的帧表由脚本生成且有测试保证不过期 | 中 |
| **3** 请求-响应与消息 id | ① 统一 `result/error/accepted` ② 全部命令带错误码（扩展 `throw` 改成带码的错误）③ 消息 `cid` 贯穿三端 ④ 合并 `message` 快捷帧到 `prompt/steer` | 三端 | 连发两条相同文本，失败/成功各自对得上；前端不再用正则匹配错误文案 | 中 |
| **4** 事件模型 | ① 扩展输出 pi-remote 事件（带版本）② 前端事件处理收拢到一处 reducer ③ 原始事件调试开关 | 扩展、前端 | 用录制的 pi 事件流做回放测试；换 pi 版本时只有扩展的翻译层测试会挂 | 大 |
| **5** 快照分页与续流 | ① 尾部优先快照 + 按 seq 翻页 ② 半条回复随订阅下发 ③ relay 名册/清单改内存缓存 + 写穿透 | relay、前端 | 1 万条的会话在手机上首屏 < 1s、首包 < 200KB；生成中断线重连能看到已输出的部分 | 中 |
| **6** 工程化 | ① 扩展源码拆模块、打包成单文件安装 ② relay 按"连接/房间/设备/命令/存储"拆文件 ③ 前端把 `useRelay` 拆成与框架无关的客户端状态机 + 薄 hook ④ `/healthz` 与基础指标 ⑤ 端到端测试自动化（假 pi + relay + 假 viewer，一条命令跑完），macOS/Windows/Linux 三平台跑 | 三端 | 单文件都 < 800 行；`npm run test:e2e` 无需手工准备；健康检查能看到在线设备数/房间数/版本 | 大 |

建议顺序就是表里的顺序：先 0、1（风险最高、和协议无关），2 是后面所有工作的地基，3 解决最容易出错的"消息对号"，4、5 是体验和长期维护，6 可以穿插在各期里做（每拆一块就补一块测试）。

## 5. 需要你拍板的事

5.1 **兼容期多长**：relay 同时支持 v3/v4 到什么时候？建议"所有设备升到 v4 后再删 v3 路径"，大约两期。

5.2 **传输安全走哪条路**：
- A. 买/用一个域名 + Caddy 自动 TLS（手机直接 https 打开，最省事）；
- B. 服务器加入 Tailscale，7001 只在 tailnet 上开放，7002 继续公网（或也走 tailnet，手机装 Tailscale 才能用）；
- C. 两者都做（7001 走 tailnet，7002 走 TLS）。我倾向 C。

5.3 **设备配对方式**：网页上点"添加设备"生成一次性配对码、本机 `attach --init <配对码>` 换 token（推荐）；或者沿用手工把 token 写进 `.env`。

5.4 **事件模型（第 4 期）要不要做**：这是最大的一块，收益是"pi 升级不再牵连网页"。如果近期不打算升级 pi，可以往后放。

5.5 **Linux 设备的形态**：服务器式（无桌面，tmux 足够）还是桌面 Linux（需要开终端窗口）？影响 attach 在 Linux 上的拉起方式。

## 6. 附：本次已经顺手做掉的

（`cursor/mac-local-device`，提交 72fd7d5，尚未部署）

- 设备平台统一为 `windows` / `macos` / `linux`（relay 也会归一老扩展上报的 `darwin`），白名单与"已在运行"判断按设备平台比较路径；
- `device_register` 的设备名、白名单条数与长度设了上限；
- 远程 bash 的工作目录按真实路径判断，项目内指向外部的符号链接不能当跳板；
- Mac / Linux 的启动、拉起、扩展同步与部署脚本，以及守着 `.ps1` / `.sh` 一致性的测试。
