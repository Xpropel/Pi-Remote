# pi-remote 多端同步 · 执行期总领设计（Windows · admin 测试期）

> **定位**：本文是执行分工总纲。概念层设计见 `DOC/device-harness.md`（设备与连接窗口）与
> `DOC/session-registry.md`（服务端索引）；本篇把它们落成**四个工作流**的详细设计索引、阶段计划与共同原则。
> **本文与各详细设计只定义"做什么、接口是什么、怎么验收"，不包含实现代码；执行由项目负责人按文档展开。**

## 1. 本期范围

### 1.1 做（本期交付）

| # | 能力 | 说明 |
|---|---|---|
| A1 | 账户固定为 `admin` | 不设注册/登录体系；`.env` 里 `PI_REMOTE_ACCOUNT` 缺省即 `admin`，UI 不展示账户概念 |
| A2 | 设备身份与名册 | `deviceId/deviceName/projects` 来自本机 `.env`；`platform` 本期为 `windows`；服务端持久名册 |
| A3 | 连接窗口 | 本机执行 `pi-remote attach` 才在线；退出即断；默认 12h 自动到期；扩展仅在窗口内连接 |
| A4 | 服务端只存索引 | `data/accounts/index.jsonl` + `data/accounts/admin/devices.jsonl` + `data/accounts/admin/sessions/<设备>.jsonl`；**不存对话正文**（`PI_REMOTE_PERSIST_TRANSCRIPTS` 默认停） |
| A5 | 窗口内远程操作 | 网页：看活动会话、看清单、**启用未活动会话**（`harness_start{sessionId}`）、**新建会话**（`harness_start{cwd}`） |
| A6 | 前端设备/会话选择 | 三个皮肤统一：先选设备，再列会话；未连接设备展示上次清单（只读） |
| A7 | Windows 端完整可用 | 本地命令、扩展门控、spawn 新控制台、部署运维全部 Windows 流程跑通 |

### 1.2 不做（明确排除，后续增量）

| 项 | 原因 / 去向 |
|---|---|
| Mac / Linux 本地端 | 后续补充（协议与后端零改动，只加 `attach.sh` 与启动脚本） |
| 多账户、注册、邀请、设备审批 | 概念层已预留 `accountId` 字段；本期固定 `admin` |
| 无人值守 headless（`--headless`） | 接口预留参数，本期不实现 |
| 网页主动「断开此设备」（D6） | 帧已预留 `device_detach`，本期不实现 |
| 远程 bash / 网页删会话 / 关机 | 维持既有边界，与本功能无关 |
| 服务端对话历史回放 | 永久放弃（内容只在本机），旧 jsonl 30 天自然过期 |

## 2. 术语与固定取值

| 术语 | 定义 |
|---|---|
| `accountId` | 账户编号。**本期恒为 `admin`**（`PI_REMOTE_ACCOUNT` 缺省值） |
| `deviceId` | 设备编号，本机 `.env` 生成一次、永不改（uuid）。重装系统才换 |
| 连接窗口（window） | 本机 `attach` 命令的运行期。窗口内：设备在线、扩展才连 relay、网页可操作 |
| 会话（session） | 本机 pi 的一个会话文件（`sessionId`）。**房间 `room.id` 恒等于 `sessionId`** |
| 活动会话 | 窗口内其 pi 进程的扩展已登记房间（`room.online=true`） |
| 清单（manifest） | 某设备全部会话的索引行（含非活动），服务端持久、窗口内更新 |

## 3. 架构与工作流划分

```
                         ┌──────────────────────────── 浏览器 / 手机 ───────────────────────────┐
                         │                                                                      │
   前端（ui/src）        │  DeviceList / SessionList / 启用·新建 / 三皮肤一致                      │
        │               └───────────────────────────────┬──────────────────────────────────────┘
        │                                          7002 viewer
        ▼                                               ▼
┌───────────────────────────────────────────── 云服务器（<你的服务器IP>） ─────────────────────────────────────────────┐
│                                                                                                                      │
│   后端 = relay 应用逻辑（relay/*.js）                服务器端 = 基础设施与运维                                        │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────┐   ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│   │ server.js    │  │ index.js(新) │  │ store.js │   │ node 运行时  │  │ systemd 单元 │  │ data/accounts/ 索引  │  │
│   │ 帧路由/命令  │→│ 名册+清单读写│  │ 降级只读 │   │ 部署脚本     │  │ token 环境变量│  │ 旧 rooms 30 天过期   │  │
│   └──────────────┘  └──────────────┘  └──────────┘   └──────────────┘  └──────────────┘  └──────────────────────┘  │
│                                                                                                                      │
└───────────────────────────────────────────────┬──────────────────────────────────────────────────────────────────┘
                                                │ 7001 local（只接受本机主动连入）
        ┌───────────────────────────────────────┼───────────────────────────────┐
        ▼                                       ▼                               ▼
 本地端（Windows）                       本地端（Windows）                本机 pi 进程
 attach 连接命令                          扩展（pi 进程内）               （内容唯一副本）
 · device_register                        · 窗口门控（状态文件）          · 会话 jsonl 在本机
 · harness_start 拉起                     · session_manifest 上报
 · 状态显示 / 到期自断                     · room_register 带 account/device
```

| 工作流 | 边界（负责什么） | 详细设计 | 主要触及 |
|---|---|---|---|
| **前端** | UI 状态模型、设备/会话选择、启用·新建交互、三皮肤一致、错误分支 | `DOC/40-frontend.md` | `ui/src/**`（2026-10 起只有一套界面，按宽度选桌面 / 手机布局，见 `ui/README.md`） |
| **后端** | relay 应用逻辑：窗口登记、清单读写、命令寻址与路由、快照 RAM 缓存、旧存储降级 | `DOC/10-relay-backend.md` | `relay/server.js`、`relay/index.js`(新)、`relay/store.js` |
| **本地端** | Windows 设备侧：attach 命令、扩展窗口门控与清单上报、spawn 规则、`.env` | `DOC/20-local-device.md` | `extension/pi-remote-sync.ts`、`deploy/attach.cjs`(新)、`deploy/*.cmd`、`.env.example` |
| **服务器端** | 云服务器：运行时、systemd、数据目录与迁移、部署、备份、安全、运维 | `DOC/30-server-ops.md` | `deploy/*.ps1`、`deploy/pi-remote.service`、服务器 `/opt/pi-remote/**` |

**四线共同契约**：`DOC/50-protocol-delta.md`（新增/变更帧、命令、错误码、状态机、参数表）。任何一线先读它再读自己的详细设计。

## 4. 契约增量索引（摘要，全量以 50 号文档为准）

| 类别 | 内容 |
|---|---|
| 新增帧（local→relay） | `device_register`、`device_detach`（预留，不实现）、`session_manifest` |
| 新增帧（relay→local） | `resend_snapshot` |
| 变更帧 | `room_register` +`accountId/deviceId/deviceName/platform`；`room_list` +`devices[]`、rooms +`accountId/deviceId` |
| 新增 viewer 帧 | `get_sessions`（viewer→relay）→ `session_list`（relay→viewer，含 `sessions[]`、`truncated`） |
| 命令通道扩展 | `command` 可用 `deviceId` 替代 `room` 寻址；新命令 **`harness_start`**（`args` 里 `cwd` 或 `sessionId` 二选一，应答走现有 `ack`） |
| 错误码 | `no_device` / `device_offline` / `device_no_active_session` / `session_not_found` / `cwd_not_allowed` / `spawn_failed` / `manifest_stale` |

## 5. 阶段计划与分工（每步可独立部署、独立验收）

| 步 | 目标 | 前端 | 后端 | 本地端 | 服务器端 | 验收要点 |
|---|---|---|---|---|---|---|
| **0** | 索引层：清单落盘与可读 | （无改动） | `index.js` + `session_manifest` 写 + `get_sessions` 读 + `room_register` 扩展字段 | 扩展上报 manifest（**沿用现有「总是连接」行为**，不带窗口门控）；`.env` 增加 `PI_REMOTE_ACCOUNT`（缺省 `admin`）、`PI_REMOTE_DEVICE_ID`、`PI_REMOTE_DEVICE_NAME`、`PI_REMOTE_PROJECTS` | 数据目录 `data/accounts/`；`PI_REMOTE_PERSIST_TRANSCRIPTS` 默认停；部署脚本上传 `index.js` | E2E：upsert/墓碑/乱序丢弃/full 对账；未连接也可 `get_sessions`；旧房间归"未登记设备" |
| **1** | 连接窗口 | （无改动） | `device_register` 登记/顶替、`devices[].online`、`harness_start` 路由、设备级命令寻址与白名单 | `attach` 命令（登记/状态文件/显示/到期）；扩展窗口门控 + `fs.watch`；spawn 串行（`cwd` 与 `sessionId` 两种） | systemd 增加 token 环境变量（隔离真实 token）；冒烟 | E2E（假窗口连接）：登记/顶替/到期断开/门控；`harness_start` started / already_running / 三类错误 |
| **2** | 前端设备/会话选择 | 设备列表+会话列表+未连接只读+启用·新建入口（`40` 号文档；中间态与超时归步 3） | （步 0/1 已就绪的帧） | （无） | （无） | 浏览器 checklist：选设备→列会话；未连接灰+只读清单+文案；三皮肤一致 |
| **3** | 窗口内远程操作收尾 | 启动中间态/超时/重试策略接入（含错误码文案，见 `40` §5） | `harness_start` 串行化与 `already_running{roomId}` 预判 | （无） | （无） | E2E+浏览器：`cwd` 新建与 `sessionId` 启用两条链路全通 |

> 步 0 不依赖连接命令。步 2 的只读清单不依赖连接命令；启用与新建依赖步 1。步 3 依赖步 1。步 1 起**扩展默认行为变化**（不再常连）——发布前按 30 号文档 §3、§4.3 把 `/etc/pi-remote.env` 就位，否则步 1 上线即掉线。

## 6. 跨线共同原则

1. **加法式兼容**：所有协议变更只增字段/帧；旧扩展（不带账户/设备字段）的房间归「未登记设备」；旧 UI 忽略新字段即可跑。
2. **`room.id === sessionId` 恒等式**：前端关联"启用结果"、后端去重、索引行都以它对齐，不引入第二标识。
3. **窗口即暴露边界**：设备只有窗口内可达；`harness_start` **不自动重发**（重发=起两份）；relay 侧单独 10s 超时（只等"已拉起"应答，会话上线由 `room_list` 驱动）。
4. **权威源与乱序防护**：会话清单权威在本机扩展（`SessionManager.list`）；relay 只汇总，`updatedAt` 单调丢弃旧帧；`full:true` 为权威重算。
5. **错误必须可分支**：机器可判的错误码 + 人可读的文案，两者都给（码见本文 §4；文案以 `DOC/50-protocol-delta.md` §6 与 `DOC/40-frontend.md` §5 为准）。
6. **Windows-only 落地**：本地端只保证 Windows 路径（`cmd`/控制台/`%USERPROFILE%`）；协议不绑定平台，Mac 后续只加启动壳。
7. **单一契约来源**：`readyUI/data-interface.md` 当前是 v3，仍是线上契约；本系列落地时把 50 号文档的增量合并进去，版本在 v3 之上递增。

## 7. 风险与对策

| 风险 | 影响 | 对策（落在哪） |
|---|---|---|
| 两个 viewer 同时启用同一会话 / 同 cwd 双开 | 起两份 pi | attach 命令侧串行 + relay 单 in-flight/设备 + `already_running` 判定（后端/本地端） |
| 窗口假死（TCP 半开） | 网页对着死窗口发起点 | 现有 30s 心跳 + 断连即 offline；`harness_start` 10s 超时（后端） |
| 步 1 上线后扩展不再常连 | 用户以为"坏了" | UI 明确「未连接=没执行 attach」文案；本地命令终端常显状态（前端/本地端） |
| 索引乱序（旧重连帧覆盖新状态） | 清单回跳 | `updatedAt` 单调 + `full` 对账（后端） |
| 新建会话的房间 id 事前未知 | 前端不知道等哪个房间 | 启动中间态 + `deviceId+cwd` 关联"最新出现的房间" + 60s 总超时（前端） |
| 旧 `data/rooms` 存量 | 磁盘不回血 | 默认停写 + 30 天清理 + 读兼容一版（服务器端） |
| token 只活在服务器 env / 本机 .env | 轮换时集体掉线 | 轮换流程写入运维手册（先服务器后本机）（服务器端） |
| 远端消息 → 模型内置 bash 工具（既有链路） | 远程注入 ≈ 本机执行 | 窗口期才是暴露面；`PI_REMOTE_ALLOW_BASH` 之外，文档如实标注（跨线） |

## 8. 决策记录（落定值）

| # | 决策 | 落定 |
|---|---|---|
| D1 | accountId | 固定 `admin`（`PI_REMOTE_ACCOUNT` 缺省值）；多账户后续 |
| D2 | 对话正文持久化 | 默认停（`PI_REMOTE_PERSIST_TRANSCRIPTS=1` 才恢复） |
| D3 | 设备级命令 | 白名单：`switch_session/new_session/fork/clone/get_state/get_sessions/harness_start`；发消息类永远走房间 |
| D4 | 未连接设备清单 | 展示上次清单（标注"未连接"），可配置隐藏 |
| D5 | 窗口自动到期 | `--max-hours` 默认 12；Ctrl+C/关终端立即断 |
| D6 | 网页断开设备 | 本期不做（帧预留） |

## 9. 文档地图

```
DOC/
├─ device-harness.md        概念层：设备/连接窗口/状态（背景）
├─ session-registry.md      概念层：服务端索引存储模型（背景）
├─ 00-overview.md           本文：总领、分工、阶段、原则
├─ 50-protocol-delta.md     ★ 四线共同契约增量（先读）
├─ 10-relay-backend.md      后端（relay 应用逻辑）详细设计
├─ 20-local-device.md       本地端（Windows）详细设计
├─ 30-server-ops.md         服务器端（部署运维）详细设计
└─ 40-frontend.md           前端详细设计
```

**执行顺序建议**：步 0 可四线中三线并行（后端先出 `index.js` 与帧处理，本地端出 manifest 上报，服务器端出目录与部署）；步 1 后端+本地端联调；步 2/3 前端在后端帧稳定后切入。
