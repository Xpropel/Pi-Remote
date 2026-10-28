[English](README.md) | 简体中文

# pi-remote —— pi 终端多端同步

不改 pi 源码、不劫持终端：用 pi 官方**扩展 API**（`pi.on()` 事件 + `pi.sendUserMessage()` 注入），
把本机终端里正在进行的 pi 会话**实时镜像**到手机/其他电脑浏览器，远程端可向同一会话发消息、发命令——
远程体验与终端等价（模型切换、思考级别、压缩、会话树、队列、用量费用一个不漏）。

```
本机（Windows）                                    云服务器（<你的服务器IP>）
┌──────────────────────────────┐                  ┌────────────────────────────────────┐
│ pi CLI（官方，D:\pi\pi.exe）  │                  │ systemd: pi-remote.service          │
│  └ 扩展 extension/            │══ 7001 local ══▶ │  relay/server.js + relay/store.js   │
│    pi-remote-sync.ts          │   （只进扩展）    │   · 7001 只接受本机扩展              │
│    → ~/.pi/agent/extensions/  │                  │   · 7002 接 UI（页面 + WS）          │
│  .env（relay 地址/token/显示名）│ ◀═ 7002 viewer ══ │   · 静态托管 web/（前端产物）        │
│  deploy\start-pi.cmd 启动     │   （页面+WS）     │   · data/accounts/ 账号/设备/会话索引  │
│  deploy\attach.cmd 开窗口     │                  │   · data/rooms/ 仅开持久化时才写正文  │
└──────────────────────────────┘                  └────────────────────────────────────┘
        本机终端体验零变化                ▲ 手机/其他电脑浏览器打开 http://<你的服务器IP>:7002/
                                          （token <你的 viewerToken>；同一会话的"镜像窗口"）
```

## 1. 系统组成（按部署位置分四类）

> 本机端支持 **Windows / macOS / Linux**，多台设备可同时连同一个 relay（每台一个设备编号，网页名册里各显示平台）。
> 下表以 Windows 为例；macOS / Linux 的对应脚本见 [§4 快速开始](#4-快速开始) 与 [deploy/README.md](deploy/README.md) 第 4 节。

### A. 本机（你的 Windows / Mac 电脑）—— 只出不进

| 组件 | 位置 | 职责 |
|---|---|---|
| pi CLI | `D:\pi\pi.exe`（官方） | 跑模型/工具的终端本体，**零改动** |
| 同步扩展 | `extension/pi-remote-sync.ts` → 同步到 `%USERPROFILE%\.pi\agent\extensions\` | 跑在 pi 进程内：转发 38 种会话事件（载荷投影 + delta 合并 + 大图占位）、镜像按 hash 增量对齐、接收远程消息注入（闲→直接发 / 忙→steer，送达确认）、**45 个远程命令**（24 个对齐 pi 官方 RPC + 21 个扩展自有；含 set_model/compact/new_session/fork/clone/navigate_tree 等真实会话操作）、断线退避重连。**attach 窗口门控**：只有 `pi-remote attach` 在跑（本地状态文件存在）才连云；设备身份（accountId/deviceId）来自 `.env`，`session_manifest` 只上报**索引**（会话 id/名字/条数/大小/时间），不上报正文。日志写 `~/.pi/agent/pi-remote-sync.log` |
| 本机配置 | `.env`（模板 `.env.example`） | `PI_REMOTE_RELAY` 地址、`PI_REMOTE_TOKEN`、房间显示名；`PI_REMOTE_ACCOUNT/DEVICE_ID/DEVICE_NAME/PROJECTS` 设备身份与项目白名单；`deploy\\start-pi.cmd` 读取并注入 pi |
| 本地 relay（联调用） | `npm run relay` → `relay/server.js` + `relay/store.js` 本机跑一份 | 不碰云服务器做闭环联调；正式运行时它在云上 |
| 本地 relay 数据 | `data/rooms/*.jsonl` | 本机联调时的会话存储（运行时产物；默认不写，仅 `PI_REMOTE_PERSIST_TRANSCRIPTS=1` 时写入，30 天自动清理） |

### B. 云服务器（<你的服务器IP> · Ubuntu 24.04）—— 纯中转 + 存储

| 组件 | 位置 | 职责 |
|---|---|---|
| relay 服务 | `/opt/pi-remote/app/relay/{server,store,index}.js`，systemd `pi-remote.service` | 7001 local 通道（鉴权/attach 窗口注册/设备名册/房间注册/事件/快照对齐/注入）+ 7002 viewer 通道（房间列表/订阅/增量续订/命令受理与去重/中断）+ 限速 + 背压 + 心跳；**不带 pi、不碰模型凭据**。token 走 `/etc/pi-remote.env`（600，root only） |
| 账号/设备/会话索引 | `/opt/pi-remote/app/data/accounts/`（`relay/index.js` 管理） | jsonl 追加式索引：`accounts/index.jsonl` + `<account>/devices.jsonl` + `<account>/sessions/<device>.jsonl`（upsert/墓碑/updatedAt 单调）。**只存索引不存正文**（会话正文默认不落盘，`PI_REMOTE_PERSIST_TRANSCRIPTS=1` 才开），`get_sessions` 未连接也可读 |
| 前端产物 | `/opt/pi-remote/app/web/`（由 `deploy-web.ps1` 上传，含冒烟页 `verify.html`） | relay 在 7002 **同口静态托管**（无独立 nginx） |
| 会话存储 | `/opt/pi-remote/app/data/rooms/<roomId>.jsonl`（默认关闭） | 打开持久化时：消息级追加落盘（每条带 seq，首行记 rev）+ 每房 500 条内存热缓存 + 全量装配（安全阀 10000 条 / 24MB）+ 断线增量续订 + 重启恢复 + 30 天清理 |

### C. UI / 前端（`ui/` 源码 → `web/` 产物）

| 目录 | 内容 |
|---|---|
| `ui/src/relay/` | WS 客户端 `useRelay.ts`（鉴权/订阅/since 续订/usage_state/attach 窗口名册）+ `sync.ts`（快照与带序号事件的对齐规则）+ `commands.ts`（命令通道：受理回执、超时、dedupeKey 重发）+ `devices.ts`（设备名册解析、错误码文案、启用/新建状态机、选房规则）+ `transcript.ts`（快照+事件 → 渲染项的 reducer，流式打字机/工具卡/去重都在这里） |
| `ui/src/pi/` | 界面：入口 `main.tsx` / `PiApp.tsx`（宽度 ≥ 1024 用桌面布局，否则用手机布局）、`containers/`（接 useRelay，把数据交给部件）、`model/`（纯函数，node --test 直接测）、`hooks/`、`styles/`（令牌）、`dev/`（开发画廊，不进生产包） |
| `ui/src/components/pi/` | Pi 部件：`shared/`（根节点、外壳、侧栏、顶栏、浮层、pi-theme.css）、`shell/`（登录、配对、会话菜单、搜索）、`conversation/`（对话流、审批卡、终端 / 改动 / 文件 pane、灯箱）、`composer/`（输入区、菜单、命令面板、弹窗、设置页） |
| `ui/src/components/kit/` | 从 Cursor 3 Agents Window 复刻搬来的基础组件（只读 `--cw-*` 令牌） |
| `web/` | `ui` 的构建产物（**不手改**，由 `deploy-web.ps1` 生成并部署） |

入口、目录、令牌、开发画廊和对图方法见 [ui/README.md](ui/README.md)。

### D. 共享：契约与文档（`readyUI/` 契约 + `DOC/` 分工设计）—— 不在部署链路里

| 文件 | 作用 |
|---|---|
| `readyUI/data-interface.md`（**v3.1，唯一事实源**） | 传输层、12 种下行信封、增量同步（rev/seq/since）、命令受理与去重、38 种 pi 事件 + 2 扩展级事件及载荷投影、45 个远程命令、消息/toolResult 数据结构、流式重建算法、TS 类型 |
| `readyUI/pi-interface-inventory.md` | 接口普查总账（事件矩阵/33 命令核对/未暴露机会/路线图/进度） |
| `DOC/10-relay-backend.md` | 后端设计：index.js 索引模块、applyManifest 七条规则、帧处理、命令路由/白名单 |
| `DOC/20-local-device.md` | 本机设计：attach 命令生命周期、`.env` 设备身份、扩展改动点、Windows spawn 规则 |
| `DOC/30-server-ops.md` | 运维设计：systemd + token env 文件、部署、迁移、备份、换 token、回滚 |
| `DOC/50-protocol-delta.md` | 共享协议增量：10 个新帧、7 个错误码、参数表、新旧兼容矩阵 |
| `DOC/device-harness.md` / `DOC/session-registry.md` | 概念层来源：attach 窗口模型 / 服务器只存索引模型 |

## 2. 目录结构

```
D:\pi-myself\
├─ extension/pi-remote-sync.ts   # 本机：pi 进程内扩展（唯一需要装进 pi 的代码）
├─ relay/server.js               # 后端：双端口中转 + attach 窗口/设备名册/命令路由
├─ relay/store.js                # 后端：会话存储（rev/seq/since 增量，默认不落正文）
├─ relay/index.js                # 后端：账号/设备/会话 jsonl 索引（只存索引）
├─ ui/                           # 前端源码（React 19 + TS + Vite 8 + Tailwind 4），说明见 ui/README.md
│  └─ src/{pi,components/{pi,kit,ui},relay,chat,shell,mobile,conversation,lib}
├─ web/                          # 前端构建产物（部署到服务器，relay 7002 同口托管）
├─ readyUI/                      # 契约与审查文档（前端团队按 data-interface.md 开发）
├─ DOC/                          # 分工设计与协议增量（10 后端 / 20 本机 / 30 运维 / 50 协议 / 71 协议 v4 / 76 设置写桥 / device-harness / session-registry）
├─ test/                         # npm test（1200 余项）：store / relay 协议 / 前端同步与命令通道 / 扩展纯函数 / attach 窗口 / 设备名册 / 启动与部署脚本 / 新界面部件与纯函数（test/pi-*.test.mjs）/ 源码结构检查（pi-structure）
├─ deploy/                       # 部署运维：见 deploy/README.md
│  ├─ sync-extension.ps1         #   扩展 → ~/.pi/agent/extensions/（MD5 校验）
│  ├─ deploy-relay.ps1           #   relay → 云服务器（MD5 校验 + 重启 + 回环验证）
│  ├─ deploy-web.ps1             #   ui 构建 → web/ → 云服务器（验证 / 200）
│  ├─ attach.cjs / attach.cmd    #   本机 attach 窗口：pi-remote attach [dirs...] [--max-hours 12]（跨平台；Windows 壳 .cmd）
│  ├─ attach.sh                  #   macOS / Linux 壳
│  ├─ setup.cjs                  #   生成 .env（自动填 token）
│  ├─ start-pi.cmd / start-pi.sh #   带环境变量启动 pi（Windows / macOS、Linux）
│  ├─ sync-extension.sh          #   macOS / Linux 版扩展同步
│  ├─ deploy-relay.sh / deploy-web.sh  # macOS / Linux 版部署（服务器上执行的脚本与 .ps1 逐字相同，有测试守着）
│  ├─ pi-remote.service          #   systemd 单元（token 走 /etc/pi-remote.env，600）
│  └─ verify.html                #   部署冒烟验证页
├─ data/rooms/                   # 运行时：本机 relay 的会话存储（gitignore）
├─ data/accounts/                # 运行时：账号/设备/会话索引（gitignore）
├─ backup/                       # 本地存档（gitignore，不进公开仓库）：旧 UI 参考、被 relay/ 取代的旧副本、已合并草稿
├─ .pi/plan/                     # 本地：最初的任务规划
├─ logs/                         # 运行时：日志（gitignore）
├─ .env / .env.example           # 本机配置（.env gitignore；.env.example 是模板）
└─ package.json                  # npm run relay（本机联调启动）/ npm test / npm run test:e2e
```

## 3. 一条数据的旅程

| 场景 | 路径 |
|---|---|
| 终端里模型输出 | pi → 扩展 `pi.on("message_update")`（25ms 内的同类 delta 合并成一帧）→ 7001 → relay 广播 7002；`message_end` 落盘并带 seq → UI `transcript` reducer 打字机渲染 |
| footer 用量/费用 | 扩展在 message_end/compaction_end/settle 时算好 → `usage_state` 帧 → UI 状态栏（**零轮询**） |
| 远程发消息 | UI → `prompt`（闲）/ `steer`（忙）命令 → 7002 → 7001 → 扩展 `sendUserMessage(deliverAs)` → pi 作为普通 user message 处理；同时回推 `remote_message` 给所有端，pi 没接收则推 `remote_message_failed` |
| 远程发命令 | UI → `command` 帧（带 dedupeKey）→ relay 回 `command_accepted`（权威超时）→ 扩展进程内执行（set_model / compact / new_session / get_projection…）→ `ack` 按 id 回传；丢包重发由 relay 去重，不会执行两次 |
| 手机刚打开页面 | auth → subscribe → relay 从 store 装配**完整快照**（无分页）+ 当前 usage_state + 之后的实时事件流 → 与终端看到的一切一致 |
| 断线 / relay 重启 | 扩展重连后按首尾 hash 只补停机期间的消息；页面重连带 `since:{rev,seq}` 只收增量快照 |
| 手机上"打开一个会话" | UI 发 `harness_start{cwd 或 sessionId}` → relay 校验设备白名单/索引 → 命令 attach 窗口 spawn `start-pi.cmd` → 新房间进 `room_list` → 前端自动订阅（不是翻历史，是真拉起） |
| 设备上/下线 | attach 窗口连上/断开 → `device_register` 改内存 online 位 + 全量 `session_manifest` → 前端名册与"已结束 N"折叠实时更新 |

## 4. 快速开始

**本机闭环联调**（不碰云）：

```powershell
cd D:\pi-myself
npm install
npm run relay                    # 127.0.0.1:7001 + 7002
deploy\start-pi.cmd              # 另一个终端：带环境变量启 pi（.env 里可临时指向 127.0.0.1）
# 浏览器 http://127.0.0.1:7002 ，token <你的 viewerToken>
```

**正式使用**（云服务器已部署好时）：本机跑 `deploy\\attach.cmd`（attach 窗口；设备才会上线）→ `deploy\\start-pi.cmd` 启 pi → 手机/电脑浏览器开 <http://<你的服务器IP>:7002/> 输入 token。窗口关掉（Ctrl+C / 到期）= 设备立刻下线，扩展零连接。

**macOS / Linux**（同一个仓库，脚本换成 `.sh`；需要 Node ≥ 22.18 和全局安装的 pi）：

```bash
cd ~/CLI/Pi-Remote
npm install
node deploy/setup.cjs ws://<你的服务器IP>:7001   # 生成 .env（token 取 PI_REMOTE_LOCAL_TOKEN 或 relay/config.json）
deploy/attach.sh --init                          # 这台电脑自己的设备编号（新装时设备名取电脑名）
deploy/sync-extension.sh                         # 扩展装进 ~/.pi/agent/extensions/
deploy/attach.sh                                 # 开 attach 窗口（设备上线）
deploy/start-pi.sh                               # 另一个终端：在项目目录里启 pi
deploy/attach.sh --doctor                        # 连不上 / 网页拉不起会话：逐项自检（只读）
```

网页上"新建/启用会话"在 macOS 上默认开一个 Terminal 新窗口跑 pi；`.env` 设 `PI_REMOTE_LAUNCHER=tmux` 则在后台 tmux 会话里跑（`tmux ls` / `tmux attach -t <会话名>` 接管）。Linux 只支持 tmux。路径规则：Windows 与 macOS 不分大小写，Linux 区分；白名单写符号链接也按真实路径认。

**Linux 服务器**（无桌面，例如和 relay 同一台的阿里云）：用专门的普通用户跑 pi，窗口和会话都放进 tmux，日常只用 `~/pi-remote/deploy/linux/device.sh init | pair | up | down | status | sessions | doctor`；开发机用 `deploy/linux/push.sh` 把本机端文件推上去。安装、配对与验收清单见 [deploy/README.md](deploy/README.md)。

**改动之后**：先跑测试（下面），再按需部署：扩展 → `deploy\sync-extension.ps1`（macOS / Linux：`deploy/sync-extension.sh`）并重启 pi；后端 → `deploy\deploy-relay.ps1`（`deploy/deploy-relay.sh --server <root@主机或 ssh 别名>`）；前端 → `deploy\deploy-web.ps1`（`deploy/deploy-web.sh --server …`）。部署完浏览器打开 `http://<你的服务器IP>:7002/verify.html`，在页面里填 viewer token 冒烟。细节与故障排查见 **[deploy/README.md](deploy/README.md)**。

**测试**（需要 Node ≥ 22.18：前端测试直接导入 `ui/src` 的 `.ts`，依赖 Node 内置的类型剥离）：

```bash
npm install
npm --prefix ui install
npm test            # 单元/协议测试，不需要 pi 和模型：store、relay 协议（临时端口）、前端同步与命令通道、transcript、扩展纯函数、新界面部件与纯函数（test/pi-*.test.mjs）、源码结构检查（pi-structure）
```

## 5. 文档索引（先读哪份）

| 你想… | 读 |
|---|---|
| 开发/对接 UI | `readyUI/data-interface.md`（v3.1：所有信封/事件/命令的精确形状，§0 v3 小节是同步与命令协议的变化） |
| 改界面 / 加设计屏 / 对图 | `ui/README.md`（入口、目录、令牌、开发画廊 gallery.html、L1 / L2 / L3） |
| 了解某能力"终端有、远端有没有" | `readyUI/pi-interface-inventory.md` |
| 部署/换 token/排障 | `deploy/README.md` |

## 6. 安全边界

- token 双轨：localToken（7001，扩展用）/ viewerToken（7002，UI 用）；`.env` 与 `relay/config.json` 均已 gitignore；云上 token 放 `/etc/pi-remote.env`（600，root only），不进 unit 文件
- 7001 **默认只绑 127.0.0.1**（`PI_REMOTE_LOCAL_HOST=0.0.0.0` 才对外）；7002 无任何文件上传/下载/路径接口；仅 JSON over WS，单条 ≤256KiB
- relay 无模型凭据、无你的代码。**但泄露 viewerToken ≠ 只泄会话内容**：攻击者能借它向带工具权限的 pi 发提示词，等同远程执行。所以要么只在内网/隧道里用，要么前面挡一层 TLS 反代（见 deploy/README）
- 远程 bash 默认关闭（需本机 `PI_REMOTE_ALLOW_BASH=1`），且 cwd 必须落在会话目录或已登记项目内；敏感 settings 递归脱敏（含 accessKey/passphrase）；图片按 128KB/图 降级（快照/事件/命令回包三路一致）
- **attach 窗口 = 安全边界**：没有窗口就没有设备连接，远程任何操作都到不了本机；`harness_start` 只能 spawn 白名单目录、只能拉起本机 `start-pi.cmd`
- 升级路径：有域名后云上前置 Caddy 终结 TLS（`wss://`），relay 与 UI 代码零改动

## 7. 当前状态（全部经过实证）

- ✅ 仓库内测试：`npm test`（**1200 余项**：store / relay 协议 / 前端同步与命令通道 / transcript / 扩展纯函数 / attach 窗口 / 设备名册 / 三平台拉起规则 / start-pi.sh / 部署脚本一致性 / 新界面部件与纯函数 / 源码结构检查；在 macOS 与 Windows 上都跑过，各自跳过另一平台专属的几项）+ `npm run test:e2e`（13 个场景：流式合并、工具输出、大图占位、帧体积、since 增量、忙时 steer、中断、压缩、远程 bash 限长、命令受理/去重、长会话、relay 重启续传）
- ✅ 早期一次性 E2E 脚本（不在仓库）：26 个命令逐一真实执行（set_model 真实切换往返、compact 官方返回、new_session/fork/clone 真实生效、bash 开关门控、usage_state 实时推送…）
- ✅ 云上全链路：本机 pi → 云端 relay → 公网 viewer；relay 内存热缓存回看；对话正文默认不落盘，设 `PI_REMOTE_PERSIST_TRANSCRIPTS=1` 才持久化并支持重启恢复
- ✅ 新界面：桌面 / 手机两种布局（按宽度自动切换，平板对话列限宽）、深浅主题、命令面板（⌘K）、斜杠 / @ 菜单、模型切换、停止按钮、审批卡、终端 / 改动 / 文件 pane、点图打开灯箱
- ✅ 前后端类型/静态检查：`tsc -b` 0 error、`oxlint` 0 error
- 📋 暂缓项：长会话真正的虚拟化渲染（目前一次挂最近 300 条，往上点「显示更早的 N 条」再挂一页，见 `ui/src/pi/model/transcriptWindow.ts`）、reload_runtime、`ui/tsconfig.app.json` 开 strict、`usageText` 抽到无 React 依赖的模块以便单测——见 `ui/README.md`

## 许可证

MIT License，见 [LICENSE](LICENSE)。

## 参与开发

- 提交前跑 `npm test`；前端另跑 `cd ui && npx tsc -b && npx oxlint && npm run build`。
- 不要提交 `.env`、token、私钥、真实会话正文或个人路径；示例配置见 `.env.example`。
- 安全问题请通过仓库的私密报告渠道联系维护者，不要在公开 issue 中贴 token 或会话内容。
