# 本地端详细设计（Windows / macOS / Linux）：attach 连接命令 + 扩展窗口门控与清单上报

> 范围：设备侧的一切（连接命令、pi 扩展、`.env`、脚本）。
> 帧与命令的共同约定见 `DOC/50-protocol-delta.md` 与 `readyUI/data-interface.md`。
> 最初只做 Windows；macOS 已补齐（启动壳 + 拉起方式 + 路径规则，见 §3.4.1 与 §9），Linux 走 tmux（服务器式 Linux 设备的安装、窗口与运维见 `deploy/README.md`）。协议与本文逻辑不变。

## 1. 组件总览

| 组件 | 位置 | 本期动作 |
|---|---|---|
| `deploy/attach.cjs` | 项目 `deploy/` | **新建**：连接窗口命令（跨平台 node 实现，Windows 壳 `attach.cmd`） |
| `deploy/start-pi.cmd` | 已有 | 复用为 spawn 目标（不变） |
| `.env` / `.env.example` | 项目根 | 增加 `PI_REMOTE_ACCOUNT` / `PI_REMOTE_DEVICE_ID` / `PI_REMOTE_DEVICE_NAME` / `PI_REMOTE_PROJECTS` |
| `extension/pi-remote-sync.ts` | pi 进程内 | 窗口门控、`room_register` 扩展字段、`session_manifest` 上报、`resend_snapshot` 响应 |

## 2. `.env` 增量（本地端唯一配置入口）

```
PI_REMOTE_ACCOUNT=admin                    # 本期固定 admin（缺省即 admin）
PI_REMOTE_DEVICE_ID=<uuid，首次生成后永不改>
PI_REMOTE_DEVICE_NAME=Windows
PI_REMOTE_PROJECTS=D:\pi-myself;D:\work\app   # 白名单目录（新建/启用只能从这里选）
```

- 首次生成辅助：`deploy/attach.cjs --init` 生成本机 `.env` 片段（uuid + name + 默认 relay），已存在则不动。
- `PI_REMOTE_LABEL` 语义不变（会话标题兜底）。

## 3. `attach` 连接命令（`deploy/attach.cjs`）

### 3.1 命令形态

```
pi-remote attach [项目目录...] [--max-hours 12] [--init]
```

- 无参 = 只开窗口（不主动起会话）；带目录 = 开窗口**并**在这些目录各起一份 pi（等价于现在连敲多个 `start-pi.cmd`）。
- `--init` 只在没配 `deviceId` 时生成 `.env` 片段后退出（一次性引导）。
- 前台运行；终端即状态面板；Ctrl+C / 关终端 / 到期 → 清理退出。

### 3.2 生命周期（做什么）

```
启动
 ├─ 读 .env（RELAY/TOKEN/ACCOUNT/DEVICE_ID/NAME/PROJECTS）
 │    └─ deviceId 缺失 → 提示跑 --init 并退出（不静默失败）
 ├─ 写窗口状态文件 %USERPROFILE%\.pi\agent\remote-attach.json
 │    { deviceId, accountId, relay, startedAt, expiresAt }
 ├─ 连 7001（role=local + localToken）→ 发 device_register
 │    └─ 被顶替（收到 device_replaced）→ 提示"另一个窗口已开启"，退出
 ├─ 对每个入参目录：起一份 pi（§3.4）
 ├─ 状态循环（每 5s 刷新终端）：
 │    设备已连接 · 剩余 xx:xx · 活动会话 N 个（来自 room_list/room_register 观察）
 │ · viewer 地址 http://<relay-host>:7002/
 ├─ 监听 relay 来的 harness_start 命令 → §3.5
 └─ 退出（Ctrl+C/到期/断线选择）：
      删状态文件 → 发 device_detach(本期可不发，直接断连) → 关 ws → 退出
      （已拉起的 pi **不杀**：它们是独立进程，只是镜像断了）
```

### 3.3 窗口状态文件（扩展门控的唯一信号）

- 路径：`%USERPROFILE%\.pi\agent\remote-attach.json`（Windows）。
- 内容：`{ deviceId, accountId, relay, startedAt, expiresAt }`。
- 语义：**存在且未过期 = 窗口开着**；`attach` 退出/到期即删除。
- 扩展用 `fs.watch` 盯这个文件：出现→立即（重）连；消失→立即断开并停止重连。
- 过期判定双保险：`attach` 本地定时器到点删文件；扩展读文件时也校验 `expiresAt`（时钟偏差兜底）。

### 3.4 拉起 pi（Windows spawn 规则）

| 规则 | 值 |
|---|---|
| 形态 | `cmd.exe /c start "" /D "<cwd>" deploy\start-pi.cmd`（`start` 出新控制台；`/D` 设工作目录） |
|  detached | 是（`detached:true`, `stdio:"ignore"`, `windowsHide:false`）——父进程退出不影响子 pi |
| 环境 | 继承当前进程环境（`.env` 已由 `start-pi.cmd` 自行读取注入） |
| 上线等待 | 拉起后也 arm 房间上线等待（缺省 6000ms）：超时回 `spawn_failed` 并释放目录占用；`cmd.exe` / `start` 命令非 0 退出同样释放占用并回失败原因，不再静默当成功 |
| 串行 | 同一时刻只处理一个 harness_start / 启动入参（命令内 `starting` 锁），防并发双开 |
| 去重 | 启动前先问自己："这个 cwd 有没有我刚拉起的进程"（内存表 `spawnedByCwd`）+ relay 侧 `already_running` 预判；本机进程扫描只作展示，不作权威 |
| 参数注入 | **禁止**把用户输入拼进命令行；目录来自 `projects` 白名单（ attach 自己校验）或本机入参 |

### 3.4.1 macOS / Linux 拉起规则

| 平台 / `PI_REMOTE_LAUNCHER` | 形态 | 说明 |
|---|---|---|
| macOS `terminal`（缺省） | 写一次性 `<tmp>/pi-remote-*.command`（0700，`wx` 独占创建）→ `open -a <PI_REMOTE_TERMINAL_APP 或 Terminal> <脚本>` | 脚本第一行删自己，`cd -- '<cwd>' && exec /bin/bash '<start-pi.sh>' [--session '<path>']`；路径一律 POSIX 单引号转义。`open` 非 0 退出 → 删脚本、清占用、记 `启动失败` |
| macOS / Linux `tmux` | `tmux new-session -d -s pi-<目录名>-<随机> -c <cwd> /usr/bin/env PI_REMOTE_EXIT_FILE=<退出码文件> /bin/bash <start-pi.sh> [--session <path>]`，tmux ≥ 3.2 同一条命令里接 `; set-option -w -t =<会话>: remain-on-exit failed` | 命令拆成多个参数，tmux 直接 exec，不经 `sh -c`；参数末尾的 `;` 写成 `\;`；会话名只含 `[A-Za-z0-9_-]`。找不到 tmux 直接回 `spawn_failed`；等 tmux 回话再回 `started`，约 1.5 秒内 pi 当场退出也回 `spawn_failed`（带退出码和窗格最后一行，失败现场留着）；退出码读侧窗格优先、tmux 丢 `pane_dead_status` 时回落读落盘文件（会话已收掉也读）。同目录 / 同会话的占用按 tmux 会话死活校验。`tmux ls` / `tmux attach -t …` 接管 |
| Linux `terminal` | 不支持，回到 tmux 并在窗口里提示一次 | 桌面终端各家不一样，后续按需补 |

- 找不到 tmux 的提示按平台/发行版给：macOS 是 `brew install tmux`，Linux 按探测到的 apt / dnf / yum / pacman / zypper / apk 给对应命令，探测不到时给 apt+dnf 兜底（不会在 Linux 上让人 brew）。
- 危险字符：Windows 仍拒 `" & | < > ^ %` 与控制字符；POSIX 上只拒 `\0 \r \n`（路径不进 shell 解析）。
- 路径比较：Windows 与 macOS（APFS 默认）**不分大小写**，Linux 区分；POSIX 本机路径先 `realpath`（pi 的 cwd 来自 `getcwd()`，macOS 的 `/tmp` 是 `/private/tmp`），白名单写符号链接也认得出是同一个目录；会话目录名按真实路径编码，与 pi 一致。
- `start-pi.sh`：`.env` 解析规则与 `attach.cjs` 的 `parseEnv` 一致（测试对拍），值只 `export` 不执行；兼容 macOS 自带 bash 3.2；找 pi 的顺序 `PI_REMOTE_PI_BIN` → `PATH` → nvm（`~/.nvm/versions/node/*/bin`，版本序取最新）→ `/opt/homebrew/bin`、`/usr/local/bin` 等。pi 是 `#!/usr/bin/env node` 脚本：找到 pi 后把它同目录的 node 放到 `PATH` 最前（Homebrew、nvm 都把两者装在一起），tmux 后台会话、launchd 拉起时 `PATH` 里没有 node 也能起；脚本被软链到别处时顺着链接找回自己的 `.env`。注入 `PI_REMOTE_EXIT_FILE` 时不再 `exec`：正常退出、127、信号打断都把退出码写进落盘文件。
- 防休眠（macOS / Linux）：attach 窗口开着就挂 `caffeinate -i -w <attach 进程号>`（macOS）或 `systemd-inhibit --what=idle:sleep`（Linux，盯着 attach 进程），挡住空闲睡眠——睡过去 relay 连接就断，网页上设备和会话全部离线。屏幕照常熄灭、合盖照常睡；窗口关闭 / 到期 / attach 被强杀都会放开。状态行显示「防休眠」；`.env` 设 `PI_REMOTE_KEEP_AWAKE=0` 关掉。Linux 非登录会话没有 polkit 权限时 systemd-inhibit 会拒绝，attach 只打一行提示，不影响连接。
- 平台标识：`device_register.platform` / `room_register.platform` 统一为 `windows` / `macos` / `linux`（attach 与扩展同一张映射表；relay 也会把老扩展上报的 `darwin` 归一成 `macos`）。缺省设备名按平台：`Windows` / `Mac` / `Linux`。

### 3.5 响应 `harness_start`（窗口内的远程拉起）

```
收到 command{command:"harness_start", args:{cwd|sessionId}}
 ├─ 校验：cwd ∈ projects（否则 ack false cwd_not_allowed）
 │        sessionId 在本地会话清单且未删（否则 ack false session_not_found）
 ├─ starting 锁：忙 → ack false "正在启动另一个会话，请稍候"（不排队）
 ├─ already_running 预判：该 cwd 有 online 房间（relay 已预判，可省）——本机侧再查一次 spawnedByCwd
 ├─ 拉起：
 │    cwd      → start-pi.cmd（新会话）
 │    sessionId → start-pi.cmd 后由扩展/本机以 --session <path> 形式指定会话文件
 └─ 回 command_result：{ok:true, status:"started"}（**不等会话上线**）
     失败 → {ok:false, code:"spawn_failed", error:<可读原因>}
```

> `--session <path>` 需要 pi CLI 支持以指定会话文件启动（现状 `start-pi.cmd` 只 `pi %*`；
> 落点时若 pi 无该参数， fallback 为"起新 pi 后由扩展执行 `switch_session{sessionPath}`"——
> 二选一在实现时定，契约不变）。

### 3.6 断线与异常

| 情况 | 行为 |
|---|---|
| relay 不可达 | 指数退避重连（1s→20s）；终端显示"重连中…"；**不删状态文件**（窗口还在） |
| 被顶替 | 收到 `device_replaced` → 提示并退出（删状态文件） |
| `--max-hours` 到点 | 终端提示"窗口已到时间，已断开"，删状态文件、断连、退出 |
| pi 启动失败 | ack `spawn_failed` + 原因；窗口继续在 |
| 用户在原终端直接跑 `pi`（没窗口） | 扩展门控关闭 → 不连 relay（终端正常用，无镜像） |

## 4. 扩展改动（`extension/pi-remote-sync.ts`）

### 4.1 窗口门控（连接前置于一切）

```
shouldConnect():
  read attachFile；不存在 → false
  JSON.parse 失败 / expiresAt < now → false
  deviceId 与 .env 不一致 → false（防拷错文件）
连接循环（现有退避逻辑改造）：
  !shouldConnect() → 若已连接则主动 close + 停止重连；否则继续等待
  shouldConnect() && 未连接 → 立即连接（退避清零）
fs.watch(attachFile 目录) → 变化即重评 shouldConnect（不等退避）
```

- 兼容期开关：`PI_REMOTE_ALWAYS_ONLINE=1` 可临时回到"总是连接"（联调/过渡用），默认无。

### 4.2 `room_register` 扩展

携带 `accountId/deviceId/deviceName/platform`（全部来自 `.env`；缺省值由契约 §2.1 定）。

### 4.3 `session_manifest` 上报

| 触发点 | 内容 |
|---|---|
| 连上并绑定会话 | `full:true` 全量（`SessionManager.list` + 活动位），超 200 条截断 |
| `session_start`（new/resume/fork/reload） | 增量：该会话 `active:true`，旧活动置假 |
| `set_session_name` / `fork` / `clone` 完成 | 增量：对应行 |
| `delete_session` 成功 | `removed:[sessionId]` |
| `agent_settled` | 增量：当前活动会话 `updatedAt/messageCount`（≥60s 节流） |
| 窗口关闭/断开 | 不发（relay 侧 room_offline 自然体现） |

- 数据源：`SessionManager.list`（官方，messageCount 准确）+ `sm.getSessionFile/getCwd`。
- 全部为**只读** pi 接口 + 现有 WS 发送，无新执行面。

### 4.4 `resend_snapshot` 响应

收到 `{type:"resend_snapshot", room}` → 立即重推一份 `snapshot`（复用 `pushSnapshot` 现有实现，房间 id 以帧为准）。

## 5. 安装 / 升级 / 初始化（Windows）

| 场景 | 动作 |
|---|---|
| 新电脑 | 拷项目 → `deploy\attach.cjs --init`（生成 deviceId/name）→ `deploy\sync-extension.ps1`（扩展就位）→ 第一次 `attach` |
| 扩展升级 | `sync-extension.ps1`（MD5 校验）→ 重启 pi（门控逻辑变化须重启） |
| 命令升级 | 拉项目新版 `deploy/attach.cjs` 即生效（无状态） |
| 卸载 | 删 `~/.pi/agent/extensions/pi-remote-sync.ts` + `.env` 里的 `PI_REMOTE_*` |

## 6. 测试与验收（本地端）

**本地闭环**（relay 跑本机 127.0.0.1，不起云）：
1. `attach --init` → `.env` 片段生成；二次执行不覆盖。
2. `attach` → 终端显示已连接；viewer 列表出现设备 online=true；**未执行 attach 时扩展不连**（门控）。
3. `attach D:\pi-myself` → 新控制台起 pi → 房间上线 → viewer 可见可发消息。
4. `attach D:\pi-myself` 再来一次 → 收到 `device_replaced` 退出，旧窗口的房间**不掉**。
5. Ctrl+C → 状态文件删除 → 扩展断开 → 设备转未连接；pi 进程仍在跑。
6. `--max-hours 0.02`（约 1 分钟）→ 到点自动断开。
7. 假 viewer 发 `harness_start{cwd}` → 新控制台起 pi；`{sessionId}` → 指定会话拉起；并发两个 → 第二个被 `starting` 锁挡。
8. E2E 回归：现有 72 项在"窗口开启"状态下全过。

## 7. 文件级改动清单

| 文件 | 改动 |
|---|---|
| `deploy/attach.cjs` | 新建：CLI/状态文件/device_register/状态显示/spawn/harness_start 响应/退出清理 |
| `deploy/attach.cmd` | Windows 壳：先探测 node（PATH → `where node.exe` → `%ProgramFiles%\nodejs` / `%LOCALAPPDATA%\Programs\nodejs` / nvm-windows），找不到给一条可操作错误并退出 127；找到后 `node "%~dp0attach.cjs" %*`，参数与退出码透传 |
| `deploy/start-pi.cmd` | 不变（spawn 目标） |
| `.env.example` | 增加 4 个变量与注释 |
| `extension/pi-remote-sync.ts` | §4 四项改动（门控/register/manifest/resend_snapshot） |
| `deploy/sync-extension.ps1` | 与 `sync-extension.sh` 同口径：目标已软链/硬链到源码时不覆盖；先写临时文件再改名；同步后核对 MD5 |

## 8. 边界与红线

- `attach` 命令**不读取模型密钥**、不转发会话内容；只管设备身份与进程拉起。
- 不经Web输入拼命令行；目录只从白名单来。
- 窗口是暴露边界：门控关闭时扩展零连接（连重连都不重试）。
- Windows 专属：控制台 spawn / `%USERPROFILE%` / `.cmd` 壳；macOS / Linux 换成 §3.4.1 的拉起表与 `.sh` 壳，状态文件同样是 `~/.pi/agent/remote-attach.json`。

## 9. macOS / Linux 文件清单

| 文件 | 作用 |
|---|---|
| `deploy/start-pi.sh` | 读 `.env` 注入环境变量后 `exec pi "$@"`（对应 `start-pi.cmd`）；注入 `PI_REMOTE_EXIT_FILE` 时改为前台等 pi 退出并落盘退出码；补 node 的 `PATH`、认软链（见 §3.4.1） |
| `deploy/attach.sh` | `exec node attach.cjs "$@"`（对应 `attach.cmd`）；软链调用也找得到 `attach.cjs`，`PATH` 里没有 node 时先试 nvm，再试 `/opt/homebrew/bin`、`/usr/local/bin` |
| `deploy/sync-extension.sh` | 扩展同步 + MD5（对应 `sync-extension.ps1`）；目标已软链到源码时不覆盖，失败不留临时文件 |
| `deploy/deploy-relay.sh` / `deploy-web.sh` | 部署到云（对应 `.ps1`，服务器上执行的脚本逐字相同） |
| `.env` 新增可选项 | `PI_REMOTE_LAUNCHER`（terminal / tmux）、`PI_REMOTE_TERMINAL_APP`、`PI_REMOTE_PI_BIN`、`PI_REMOTE_KEEP_AWAKE`（macOS / Linux，缺省开）、`PI_REMOTE_LAUNCH_WAIT_MS` |

新电脑：拷项目 → `npm install` → `node deploy/setup.cjs ws://<relay>:7001` → 网页「添加设备」拿配对码 → `deploy/attach.sh --pair XXXX-XXXX`（换这台自己的设备编号和令牌，写进 `.env`）→ `deploy/sync-extension.sh` → `deploy/attach.sh`。还在用共享令牌的老部署，配对那一步换成 `deploy/attach.sh --init`。
