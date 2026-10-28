# 部署与运维手册

pi-remote 分成本机和云服务器两处。本手册覆盖：首次上云、日常部署、数据目录、token（local / viewer / admin 三种）、备份、回滚、故障排查。

本期服务器只持久化索引（`data/accounts/`）。对话正文默认不落盘：systemd 与 `/etc/pi-remote.env` 都不设置 `PI_REMOTE_PERSIST_TRANSCRIPTS`。只有该变量被设成非空（例如 `1`）时，新 relay 才恢复写入 `data/rooms/`。

PowerShell 脚本参数是 `-Server`（web 另有 `-ViewerBase`），macOS / Linux 的 `.sh` 用 `--server`（web 另有 `--viewer-base`）。仓库、单元文件、脚本里都不写真实 token，也不写死服务器地址。下面的 `<你的服务器IP>` 整段换成实际主机。

## 1. 系统分布

```
本机（Windows）                                   云服务器（<你的服务器IP> · Ubuntu 24.04）
┌─────────────────────────────┐                  ┌──────────────────────────────────────────┐
│ pi CLI（官方，不改源码）      │                  │ systemd: pi-remote.service               │
│  └ 扩展 pi-remote-sync.ts    │══ ws://IP:7001 ══▶ │  relay/*.js（server/store/index…）      │
│     （~/.pi/agent/extensions/│   local 通道       │   · 7001 local（本机 attach 与扩展连入） │
│        由 sync-extension     │                  │   · 7002 viewer（页面 + WS，同口托管 web/）│
│        .ps1 同步）           │                  │   · /etc/pi-remote.env（token，不入库）   │
│ deploy/start-pi.cmd（带 .env │ ◀═ ws://IP:7002 ══ │  data/accounts/   索引（本期要保留）      │
│   环境变量启动 pi）           │   viewer 通道      │  data/rooms/      旧正文（默认停写）      │
└─────────────────────────────┘                  └──────────────────────────────────────────┘
            ▲                                              ▲
            │ 浏览器打开 http://<你的服务器IP>:7002/ ◀─────┘（手机/其他电脑）
```

| 项 | 值 |
|---|---|
| Node | `/opt/pi-remote/bin/node`（v22 LTS）。首次安装时再链到 `/usr/local/bin/node`，单元的 `ExecStart` 用这条链 |
| 代码 | `/opt/pi-remote/app/`（`relay/` + `web/` + `package.json` + `node_modules`） |
| 数据 | `/opt/pi-remote/app/data/` |
| 日志 | journald（`journalctl -u pi-remote.service`）。进程启动时会建 `logs/`；应用日志以 stdout 进 journald 为主 |
| 单元 | `/etc/systemd/system/pi-remote.service` |
| token | `/etc/pi-remote.env`（local / viewer / admin 三种），权限 600，只放在服务器上 |

安全组只放 7001/7002 入站。SSH(22) 只对信任的来源开放。

本机只出不进：7001 只接受 `role=local`；网页只连 7002。relay 不碰模型密钥。磁盘上的索引是设备名、目录和会话元数据；默认不再把对话正文写入 `data/rooms/`。

### 1.1 暴露面与 TLS（重要，先读）

- 7001 现在**默认只绑 127.0.0.1**：扩展和 attach 从公网连不上，除非在 `/etc/pi-remote.env` 里显式 `PI_REMOTE_LOCAL_HOST=0.0.0.0`。
  真要对公网开放 7001 时，请二选一：
  1. **SSH 隧道（推荐，零额外组件）**：本机 `ssh -N -L 7001:127.0.0.1:7001 root@<你的服务器IP>`，然后把 `.env` 的 `PI_REMOTE_RELAY` 改成 `ws://127.0.0.1:7001`。7001 不必对公网开放。
  2. **反代 + TLS**：Caddy 自动签证书，把 `wss://<域名>/local` 反代到 `127.0.0.1:7001`。
- 7002 默认绑全网卡（手机要能连）。**明文 ws 下 viewerToken 可被嗅探**，而拿到它就能向带工具权限的 pi 发提示词——等同远程执行。所以：要么只在内网/隧道里用，要么给 7002 上 TLS：

```caddy
# /etc/caddy/Caddyfile
<你的域名> {
  reverse_proxy 127.0.0.1:7002
}
```

  之后浏览器开 `https://<域名>/`，前端按同源走 `wss://`；本机 `.env` 的 `PI_REMOTE_RELAY` 仍指向 7001 通道。若 7001 也要走 `wss`，按 1.1 开头的反代方案把 `/local` 转到 `127.0.0.1:7001`，再把 `.env` 改成 `wss://<域名>/local`。
- 换 token：生成命令与三种令牌的约束见 2.1 节；写进 `/etc/pi-remote.env` 后 `systemctl restart pi-remote`。local token 变了还要同步本机 `.env` 并重启 pi；viewer / admin token 变了只需在浏览器重输。

**当前这套部署的实际取值**（2026-10-09 起）：设备从公网连 `IP:7001`，所以 `/etc/pi-remote.env` 里显式写了 `PI_REMOTE_LOCAL_HOST=0.0.0.0`——这是对"默认只听回环"的有意放开，靠 localToken + 安全组收敛。要收成默认值，需要先把本机切到 SSH 隧道（`PI_REMOTE_RELAY=ws://127.0.0.1:7001`），再从 env 文件删掉这一行。
**踩过的坑**：只改代码默认值、没改服务器 env 就重启 → 7001 只剩回环在听，设备无限重连。改监听地址后必须确认 `ss -ltn | grep 7001` 与设备在线。

### 1.2 个人局域网使用（TLS 背景，不要求本次落地）

- relay 和手机/电脑都在同一个可信家庭局域网时，`http://<内网IP>:7002` 可以直接用；但明文 `ws` 会把 viewerToken、会话内容和远程命令一起暴露给同一二层网络里能抓包的人。公共 Wi-Fi、合租网络、来路不明的路由器都不应当作“可信内网”。
- 只在局域网用也不等于没有风险：viewerToken 能向带工具权限的 pi 发提示词，等同远程执行。不要在路由器上把 7002 端口转发到公网；个人跨网使用优先 WireGuard / Tailscale / SSH 隧道，链路层已经加密，relay 和 UI 不用改。
- 要自己上 TLS 时，用 Caddy / Nginx 终结 `https`，再把 WebSocket 反代到 `127.0.0.1:7002`（后端不需要监听公网）。证书要有域名或受信任 CA；给内网 IP 签自签证书时，手机必须先安装并信任该 CA，否则浏览器会直接拒绝 `wss`，不要用“继续访问”绕过。
- 页面切到 `https://` 后，前端 WebSocket 必须同样走 `wss://`，否则会被浏览器按混合内容拦截。7001 同理：默认只绑回环，跨网优先 SSH 隧道，直连公网时应加 `wss` 反代。本节只记录背景和取舍，不要求在这次改动里落地 TLS。

## 2. systemd 与 token

仓库里的 `deploy/pi-remote.service` 只声明：

- `WorkingDirectory=/opt/pi-remote/app`
- `ExecStart=/usr/local/bin/node relay/server.js`
- `Restart=on-failure`，`RestartSec=2`
- `Environment=NODE_ENV=production`
- `EnvironmentFile=-/etc/pi-remote.env`（文件可以暂时不存在；存在时读入环境变量）

单元里没有 token，也没有 `PI_REMOTE_PERSIST_TRANSCRIPTS`。不要设 `PI_REMOTE_DATA_DIR`：现有 relay 会把它当成旧正文目录，索引目录固定是工作目录下的 `data/accounts`，和 `data/rooms` 并列。

`/etc/pi-remote.env`（只在服务器上创建，LF，无 BOM，不要加引号，不要 `export`）：

```
PI_REMOTE_LOCAL_TOKEN=<真实 localToken，至少 16 字符>
PI_REMOTE_VIEWER_TOKEN=<真实 viewerToken，至少 16 字符，与 local 不同>
PI_REMOTE_ADMIN_TOKEN=<真实 adminToken，至少 16 字符，与上面两个都不同>
```

把尖括号里的占位整段换成真实值。三种令牌都必须独立随机，**不要复用 viewer token 当 adminToken**。不要添加 `PI_REMOTE_PERSIST_TRANSCRIPTS` 这一行。然后：

```bash
chmod 600 /etc/pi-remote.env
systemctl daemon-reload
systemctl restart pi-remote.service
```

以前如果按旧手册写过 `/etc/systemd/system/pi-remote.service.d/override.conf`，里面的 `Environment=` 会盖过 env 文件。把 local / viewer token 抄进 `/etc/pi-remote.env` 并确认能登录之后，删掉这份 drop-in，避免两处各写一份。`deploy-relay.ps1` 发现 drop-in 只告警，不删除、不打印内容。

### 2.1 adminToken（配对与撤销）与令牌强度

`adminToken` 只用于两类管理员操作：在网页上生成配对码（`pair_create`）和撤销设备（`device_revoke`）。它不是 viewer 登录口令，普通查看、发消息、远程命令都不需要它。

- **至少 16 字符，独立随机，且与 localToken / viewerToken 不同。** 生成一次的命令（跑三次，分别给三个变量）：
  ```bash
  node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
  ```
- **未配置 adminToken**：relay 仍然正常启动，查看/发消息等普通功能不受影响；但生成配对码、撤销设备会被禁用（服务端返回 `admin_required`），启动日志会有一行“管理员功能已禁用”。网页设备管理里没有输入管理员令牌时，这两个按钮也会在本地禁用。
- **配置了但短于 16 字符（或仍是 `change-me`）**：按未配置处理，只禁用管理功能；日志会提示“adminToken 长度不足 16 字符”，不会回显令牌内容。
- **升级注意（现有短令牌会被拒）**：`localToken` / `viewerToken` 也执行同样的 16 字符下限。旧配置里短于 16 字符或写成 `change-me` 的值，升级后会被当作未配置；这两者任一为空时 `relay/server.js` 启动即退出（exit 1），不会带着弱口令上线。先在 `/etc/pi-remote.env` 把三项都换成至少 16 字符的随机值，再重启并让浏览器重新输入 viewer / admin token。
- 部署脚本只检查变量名是否出现在 env 文件、旧 drop-in 或 `relay/config.json` 里，**不检查长度和强度**，也不会打印值；重启后请看 `journalctl -u pi-remote.service` 里有没有“长度不足”“管理员功能已禁用”这类提示。
- 仓库的 `relay/config.example.json` 里 `adminToken` 留空并附了同一条说明；模板中的 `change-me` 只是占位符，不要照抄。真实令牌只放服务器 `/etc/pi-remote.env`，不要写进仓库或命令行参数。

## 2.2 单元文件与 env 的部署约束

`deploy-relay.ps1` 每次部署都会把仓库里的单元文件上传到 `/etc/systemd/system/pi-remote.service`（上传前转成 LF）并 `daemon-reload`。仓库里的单元是 CRLF，不要绕过脚本直接 scp，否则 systemd 可能解析失败。服务器上直接改过的主单元会被这次上传覆盖。额外配置写在 env 文件里。若 env 文件已存在，脚本会 `chmod 600`，仍然不改其中的值，也不打印内容。

若主单元里已经有 `Environment=PI_REMOTE_LOCAL_TOKEN` 或 `PI_REMOTE_VIEWER_TOKEN`，脚本在备份和上传之前停止，不打印原值。先把 token 写入 `/etc/pi-remote.env`，再从主单元删掉这些行。drop-in 不会被脚本删除。

## 2.3 known_hosts（首次部署必做）

三个部署脚本都用 `-o StrictHostKeyChecking=yes -o UserKnownHostsFile=deploy/known_hosts`：
第一次部署前先固定主机指纹，否则会直接 `Host key verification failed`。

```powershell
# 仓库根目录执行一次（IP 换成你的服务器；deploy/known_hosts 已在 .gitignore，不进仓库）
ssh-keyscan -H <你的服务器IP> >> deploy/known_hosts
```

更稳妥：先 `ssh root@<你的服务器IP>` 手动连一次、核对指纹、输入 yes，再把 `~/.ssh/known_hosts` 里对应行追加进 `deploy/known_hosts`。

## 3. 首次上云（只需一次）

```bash
# 1) 装 node（国内镜像）
curl -fsSL https://npmmirror.com/mirrors/node/v22.20.0/node-v22.20.0-linux-x64.tar.xz -o /tmp/node.tar.xz
mkdir -p /opt/pi-remote && tar xf /tmp/node.tar.xz -C /opt/pi-remote --strip-components=1
ln -sf /opt/pi-remote/bin/node /usr/local/bin/node && ln -sf /opt/pi-remote/bin/npm /usr/local/bin/npm

# 2) 放项目并装依赖（需要 relay/ 与 package.json；index.js 随本期后端一并在仓库里）
cd /opt/pi-remote/app && npm install --registry=https://registry.npmmirror.com ws dotenv
mkdir -p /opt/pi-remote/app/data/accounts /opt/pi-remote/app/relay /opt/pi-remote/app/logs

# 3) 写 /etc/pi-remote.env（见上一节，chmod 600）。
#    先不要 enable。单元由下一节的 deploy-relay.ps1 上传（脚本会把 CRLF 转成 LF）。
#    该脚本成功后，再在服务器上执行一次：
#    systemctl enable --now pi-remote.service
#    curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7002/

# 4) 安全组只开 7001/7002
```

`enable` 和回环 `curl` 要等下一节的 `deploy-relay.ps1` 成功后再做。`curl` 应打印 `200`。然后再部署 web。

## 4. 日常三件套（本机 PowerShell；macOS / Linux 见 4.1）

| 改了什么 | 命令 | 做什么 |
|---|---|---|
| `extension/**` | `powershell -ExecutionPolicy Bypass -File deploy\sync-extension.ps1` | 只同步到本机 pi 扩展目录并核对 MD5；与 `.sh` 同口径：目标已软链/硬链到源码时不覆盖，先写临时文件再改名。不连接服务器。重启 pi 生效 |
| `relay/**`（含 `index.js`） | `powershell -ExecutionPolicy Bypass -File deploy\deploy-relay.ps1 -Server "root@<你的服务器IP>"` | 先校验 systemd 单元（不含 token）→ 上传 `relay/` 下全部 `.js` 与 `protocol.json` 到 `relay.new/` → MD5 → 顶替 `relay/`（`config.json` 等非代码文件一并带过去；部署前那版整份留 `relay.cur/`）→ 重启 → 本机回环验证（`/healthz` 要报这次带上去的协议版本；回滚时旧版没有 `/healthz`，才退回看首页 200）→ 确认成功后才把 `relay.cur/` 轮转成 `relay.prev/`。**重启、权限归一化或验证任一步失败会自动整份还原 `relay.cur/` 并重启，再以非零退出；失败的部署不会冲掉 `relay.prev/`。** app 下除 `data/`、`logs/` 外全部归 root，`config.json` 为 `root:pi-remote 640`，数据/日志才给 pi-remote |
| `ui/src/**` | `powershell -ExecutionPolicy Bypass -File deploy\deploy-web.ps1 -Server "root@<你的服务器IP>" -ViewerBase "http://<你的服务器IP>:7002"` | 本机构建 → tar → 上传；部署前把当前 `web/` 快照到 `web.prev/` → 解压到 `web.next/` 后整体切换（首次若已有 `web/` 会另挪成 `web-legacy-backup/`）→ 权限归一化（目录可进入、文件可读，含带 hash 的懒加载 chunk）→ 验证 `/`、`/favicon.svg`、`/verify.html`、入口 JS/CSS 和一个非 `index-*` 懒加载 chunk 均为 200。**解压、权限或验证失败会自动还原 `web.prev/` 并以非零退出；部署前已有 `web/` 时，成功也保留 `web.prev/` 供手动回滚。** |

三个脚本失败都会抛错。`deploy-relay.ps1` 在 `relay/` 下必需文件缺失、或 `-Server` 仍是占位符时，不会发起连接。`deploy-web.ps1` 在 `-Server` 仍是占位符时，同样在构建和连接之前停止。`-ViewerBase` 若仍是占位符，则改用 `http://<Server 主机>:7002`，不会去请求占位主机。两个部署脚本都不把 token 放进参数。

`.ps1` 与 `.sh` 在服务器上执行的远端脚本逐字相同（`test/deploy-scripts.test.js` 校验，改一边必须同步另一边），包括这次新增的 relay 自动回滚、web 快照/还原/权限检查。Windows 脚本已同步，但本机没有 `pwsh`：只做了 BOM、here-string、括号平衡和 `bash -n` 等静态检查，**尚未在 Windows 实机上执行过**；首次在 Windows 部署前需要按第 12 节做一次演练。

首次上云：`deploy-relay.ps1` 成功后，在服务器执行 `systemctl enable --now pi-remote.service`，再 `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7002/`，应为 200。然后跑 `deploy-web.ps1`。

### 4.1 macOS / Linux

同样三件事，换成 `.sh`。服务器上执行的脚本与 `.ps1` 逐字相同（`test/deploy-scripts.test.js` 校验，改一边必须同步另一边），占位符、token 检查、MD5、备份轮转、回滚的行为都一样。`--server` 除了 `root@主机`，也可以写 `~/.ssh/config` 里的主机别名（密钥、用户名都走 ssh 配置）；known_hosts 仍然用 `deploy/known_hosts`。

| 改了什么 | 命令 |
|---|---|
| `extension/**` | `deploy/sync-extension.sh`（同步到 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/` 并核对 MD5，重启 pi 生效） |
| `relay/**` | `deploy/deploy-relay.sh --server root@<你的服务器IP>`；回滚加 `--rollback` |
| `ui/src/**` | `deploy/deploy-web.sh --server root@<你的服务器IP> [--viewer-base http://<你的服务器IP>:7002]` |
| 本机端文件 → Linux 服务器设备 | `deploy/linux/push.sh --server root@<你的服务器IP> --user <设备用户>`（暂存目录装依赖后原子换版，旧版留 `<目录>.prev/`；`.env` 原样复制进新版并收紧 0600；设备日常操作与验收见本文件） |
| 配对 / 撤销设备 | 网页「添加或管理设备」生成配对码需要 adminToken；本机 `node deploy\attach.cjs --pair XXXX-XXXX`（macOS / Linux：`deploy/attach.sh --pair XXXX-XXXX`），成功后 `.env` 为 0600 |
| 本机连不上 / 拉不起会话 | `deploy/attach.sh --doctor`（只读：node / pi 路径存在且可执行 / 扩展版本 / .env / relay 端口 / 连接窗口 / Terminal 或 tmux（缺 tmux 按发行版给安装命令）/ 防休眠 / 白名单） |

`deploy/linux/push.sh` 不直接在正式目录上改：先在 `<目录>.new.<pid>/` 解包并 `npm ci --omit=dev`，全部成功后才把旧目录挪成 `<目录>.prev/`、暂存目录改名成正式目录（同一文件系统内的原子换版，再上一版是 `.prev.1/`）。解包或装依赖失败时旧目录和旧 `.env` 都没有动；扩展同步失败会把旧版换回来并重新同步旧扩展。它不会修改 relay，也不会碰 `/etc/pi-remote.env`。

`deploy/setup.cjs` 只在没有 `.env` 时生成模板；**已存在就拒绝覆盖**（里面有设备编号、设备令牌、白名单、拉起方式）。只改 relay 地址请直接编辑 `.env`；确实要从模板重建再加 `--force`。

macOS 打包 `web/` 时会关掉 `._*` 资源叉和 xattr 扩展头（`COPYFILE_DISABLE=1`、`--no-mac-metadata --no-xattrs`），服务器上的 GNU tar 解出来是干净的。

部署顺序：

1. 步 0：先 `deploy-relay.ps1`（带 `index.js`）→ 再 `sync-extension.ps1` 让扩展上报清单。第一个窗口连上后，服务器上出现 `data/accounts/admin-<hash>/...`。不用手抄旧房间进索引。
2. 步 1：先确认 `/etc/pi-remote.env` 已就位且服务用它完成过认证，再部署带连接窗口门控的扩展。部署后先在本机跑一次 attach，再算完成。
3. 轮换 token 的顺序见第 6 节。

**部署后冒烟**：浏览器打开 `http://<你的服务器IP>:7002/verify.html`（必须从 relay 同源打开），在输入框里填 viewer token 再点「开始检测」。逐项看首页、主 JS/CSS、favicon、路径穿越被拒绝、viewer 鉴权与错误 token 被拒。token 不再放 URL 参数（会留在浏览历史和 Referer 里）。契约文档 `readyUI/*.md` 不在部署链路里。

## 5. 数据目录

| 目录 | 内容 | 策略 |
|---|---|---|
| `data/accounts/` | 账户 / 设备名册 / 会话清单 | 不过期。`deploy-relay.ps1` 与 `deploy-web.ps1` 都会 `mkdir -p`，都不会删除它。重启后保留 |
| `data/accounts/index.jsonl` | 账户行 | 本期账户显示名是 `admin`；目录是 `admin-<hash>` |
| `data/accounts/admin-<hash>/devices.jsonl` | 设备名册 | 窗口断开只在内存里标离线，不删行；`pairedAt` 标记不可逆，撤销令牌后 legacy 仍不能冒用 |
| `data/accounts/admin-<hash>/sessions/<deviceId>-<hash>.jsonl` | 该设备的会话清单 | 一行一会话，后行覆盖前行 |
| `data/rooms/` | 旧对话正文 | 默认不再写入。保留期 30 天，只清理这里，不动 `data/accounts`。保留期内旧房间 id 仍可订阅 |
| `logs/` | 应用日志目录 | 见第 7 节。进程主日志在 journald |

零人工迁移：升级后该设备的第一个窗口连接会把清单写入索引。旧 `data/rooms` 文件自己过期。

部署脚本若发现 `data`、`data/accounts`、`data/rooms` 或 `web` 是符号链接，会直接停止，不删除这些目录，也不顺着链接写入。

停写正文由新的 `relay/store.js` 完成：`PI_REMOTE_PERSIST_TRANSCRIPTS` 不存在时不再追加 `data/rooms`。运维要保证单元和 `/etc/pi-remote.env` 都不设置这个变量。仍在跑的旧版 `store.js` 会忽略它、继续写文件，需要和带这个开关的后端一起部署后，`data/rooms` 才会停。

不要设 `PI_REMOTE_DATA_DIR` 把 rooms 挪到别处，否则正文目录和 `data/accounts` 会拆开。

## 6. Token 轮换

三种令牌可以分开轮换：轮换时先改服务器，再改本机，最后让浏览器重输对应 token。回滚按相反顺序：先本机改回旧 token，再把服务器改回并重启，然后浏览器重输旧的 token。两端停在同一个值上才算完成。

1. 服务器：编辑 `/etc/pi-remote.env` 里对应的值 → `systemctl daemon-reload` → `systemctl restart pi-remote.service`。
2. 本机：只有 local token 变了才改 `.env` 的 `PI_REMOTE_TOKEN` → 重启 pi / 重跑 attach。配对换来的 `PI_REMOTE_DEVICE_TOKEN` 是设备自己的令牌，不随 local token 轮换。
3. viewer token 改了，已经打开的网页要重新输入（浏览器里旧值会在认证失败后清掉）；adminToken 改了，不需要重新登录 viewer，但下一次生成配对码/撤销设备要在设备管理里输入新的管理员令牌。
4. 每次改完 env 文件，把新值存进密码管理器。不要把文件拷回仓库。

`adminToken` 只影响生成配对码、撤销设备，不会把已登录的 viewer 踢下线；它不是 viewer token，不能拿来登录。未配置时 relay 仍正常启动，只是这两项管理功能禁用（见 2.1 节）。

### 6.1 设备配对、撤销与 .env 权限

- 网页上生成配对码、撤销设备都需要 adminToken；未配置或输错时统一返回 `admin_required`，不会生成码、不会撤销设备，也不会泄露 relay 到底配没配管理员令牌。
- 本机配对：Windows 用 `node deploy\attach.cjs --pair XXXX-XXXX`，macOS / Linux 用 `deploy/attach.sh --pair XXXX-XXXX`；`.env` 里还没有 relay 地址时加 `--relay ws://<你的服务器IP>:7001`。配对成功后写入 `PI_REMOTE_DEVICE_ID` 和 `PI_REMOTE_DEVICE_TOKEN`，令牌不打印。
- `attach --pair` 和 `--init` 都会把 `.env` 落盘权限收紧到 **0600**（新建时即 0600；已有的宽权限也会被 `chmod` 收紧）。如果无法收紧权限，命令直接报错退出，不会留下同机其他用户可读的令牌文件。不要把 adminToken 写进 `.env` 或命令行参数——它只放在服务器 env 和网页本机存储里。
- 设备被撤销后连接会被断开；重新在网页生成配对码并在本机执行 `attach --pair`，之后重启 pi 让扩展重新读取设备令牌。
- 本机 `.env` 可用 `node deploy\setup.cjs ws://<你的服务器IP>:7001` 从本机环境变量 `PI_REMOTE_LOCAL_TOKEN` 或 `relay/config.json` 生成。启动 pi：在项目目录运行 `deploy\start-pi.cmd`（macOS / Linux：`deploy/start-pi.sh`）。`start-pi.cmd` 必须保持 CRLF，`.sh` 必须保持 LF（`.gitattributes` 已固定）。
- 多台设备共用同一个 local token，但**设备编号每台各一个**：新电脑跑一次 `attach --init` 生成自己的 `PI_REMOTE_DEVICE_ID`，不要把别的电脑 `.env` 里的编号抄过来，否则两台的 attach 窗口会互相顶下线（`device_replaced`）。

## 7. 备份

| 对象 | 频率 | 做法 | 恢复 |
|---|---|---|---|
| `data/accounts/` | 每天 | 下面的 cron | 解包回 `data/`，不必为了索引停服 |
| `/etc/pi-remote.env` | 每次变更 | 密码管理器另存 | 写回服务器并 `chmod 600`，然后 restart |
| `relay/**`、`protocol/**` 与 `deploy/**` | 随 git | 仓库即备份 | 重新跑部署脚本 |
| 对话正文 | 不备份 | 正文只在本机会话文件里 | — |

保留 7 天打包。不要备份 `data/rooms`。

部署脚本不会安装 cron，也不会在部署时替你执行。需要在服务器上手工跑一次下面的命令，并自己做一次解包演练。验收清单里的「备份 cron 在位」指的是这一步，不是脚本已经完成。

```bash
mkdir -p /opt/backups
cat > /etc/cron.d/pi-remote-accounts <<'EOF'
SHELL=/bin/bash
PATH=/usr/sbin:/usr/bin:/sbin:/bin
15 3 * * * root tar czf /opt/backups/accounts-$(date +\%F).tgz -C /opt/pi-remote/app/data accounts && find /opt/backups -name 'accounts-*.tgz' -mtime +7 -delete
EOF
chmod 644 /etc/cron.d/pi-remote-accounts
```

crontab 里的 `%` 必须写成 `\%`。恢复：

```bash
tar xzf /opt/backups/accounts-YYYY-MM-DD.tgz -C /opt/pi-remote/app/data
```

`logs/` 若出现 `*.log`，用 10MB × 5 份滚动（进程主日志仍在 journald；没有 `*.log` 时这份配置空转）：

```
# /etc/logrotate.d/pi-remote
/opt/pi-remote/app/logs/*.log {
    size 10M
    rotate 5
    missingok
    notifempty
    copytruncate
    compress
}
```

## 8. 回滚

| 回滚什么 | 做法 |
|---|---|
| relay 代码 | `powershell -ExecutionPolicy Bypass -File deploy\deploy-relay.ps1 -Server "root@<你的服务器IP>" -Rollback`（macOS / Linux：`deploy/deploy-relay.sh --server root@<你的服务器IP> --rollback`）。本次部署没确认成功（重启、权限归一化或回环验证失败）时，部署脚本已经自动整份还原 `relay.cur/` 并重启；手动 `--rollback` 也优先用它。否则整份还原 `relay.prev/`（含 `config.json`；旧脚本留下的只有 3 个 js 的备份，会从当前 `relay/` 补回 `config.json`），再重启。上一版没有 `index.js` 时新文件随之消失。索引格式是加法式的，不回滚 `data/accounts` |
| web 产物 | `deploy-web.sh` / `deploy-web.ps1` 每次部署前把当前 `web/` 快照到 `/opt/pi-remote/app/web.prev/`；解压、权限归一化或 HTTP 验证任一步失败会自动还原并退出非零；部署前已有 `web/` 时，成功后也保留这份快照。手动回滚在服务器上执行：`cd /opt/pi-remote/app && test -d web.prev && rm -rf web.failed && mv web web.failed && mv web.prev web && chmod -R a+rX,go-w web && systemctl restart pi-remote.service`。首次部署时没有 `web.prev/`，旧站只在 `web-legacy-backup/`（只保留第一次那份，之后不再更新）。不要对 `data/accounts` 或 `data/rooms` 做删除 |
| token | 先把本机 `.env` 改回旧 token，再把 `/etc/pi-remote.env` 改回旧值 → `daemon-reload` → `restart`，浏览器重输旧 viewer token；adminToken 回滚后在设备管理里重输旧值 |
| 扩展 | 本机用旧的扩展文件再跑 `sync-extension.ps1`（macOS / Linux：`deploy/sync-extension.sh`），然后重启 pi |

**自动回滚**：relay 重启/权限/验证失败时，脚本会还原 `relay.cur/` 并再次做回环验证（只要求 200，不要求新协议版本），成功后才以非零退出；首次部署没有 `relay.cur/` 时没有可还原的旧版，脚本会报 `FAIL relay_prev_missing`，修复后重跑即可。web 解压/权限/验证失败时还原 `web.prev/`（首次没有快照则退回 `web.old/`，仍失败会明确要求从 `web-legacy-backup/` 恢复）。两种自动回滚都不会把失败报成成功，也不会动 `data/accounts`、`data/rooms`、`/etc/pi-remote.env`。

`-Rollback` 不修改 `/etc/pi-remote.env`，不删除 `data/rooms`。备份为 `relay.prev/` 与再上一版 `relay.prev.1/`，只在部署确认成功后轮转，失败的部署不会冲掉它们。web 的 `web.prev/` 在每次部署开始前刷新；自动还原会把它移回 `web/`，所以还原后这个快照不再存在，下次部署成功后会重新生成。它和 `web-legacy-backup/` 都不包含 `data/`。

## 9. 监控与故障

```bash
systemctl status pi-remote.service
systemctl restart pi-remote.service
journalctl -u pi-remote.service -f
ss -ltnp | grep 700
du -sh /opt/pi-remote/app/data/*
ls /opt/pi-remote/app/data/accounts/admin-*/devices.jsonl
curl -s http://127.0.0.1:7002/healthz
```

`data/accounts` 应保持 KB 级。健康检查看 `/healthz` 的正文（`"ok":true` 和 `proto`）；旧版 relay 没有这个路由，会把首页当 200 回来，所以只看状态码分不出新旧。

| 现象 | 先查 |
|---|---|
| relay 启动即退出 | `journalctl -u pi-remote.service -n 50`。常见原因是 localToken/viewerToken 缺失、仍是 `change-me` 或短于 16 字符（升级旧配置后最可能）；按 2.1 节换成长随机令牌再重启 |
| 添加设备返回 `admin_required` / 按钮不可用 | 服务器是否配置了 `PI_REMOTE_ADMIN_TOKEN`（至少 16 字符，且与另外两个不同），以及网页设备管理里输入的是否同一个值；改完 env 要 restart relay |
| web 403 / 白屏 / 懒加载 chunk 404 | 重跑 `deploy-web.sh`（或 `.ps1`）；它会重新归一化权限并把上一版 7 天内的 `assets` 带过来。仍失败时查 `/opt/pi-remote/app/web.prev/` 和 `web-legacy-backup/` |
| 网页全部掉线 | `systemctl status`；token 是否被改；`ss` 是否还在听 7001/7002 |
| 设备能注册但网页看不到 | `room_list.devices` 是否含该 deviceId；`data/accounts/admin-<hash>/devices.jsonl` 有没有行 |
| 会话清单是空的 | 本机 attach 是否在跑、扩展是否在窗口内上报；`data/accounts/admin-<hash>/sessions/<deviceId>-<hash>.jsonl` 有没有行 |
| `data/rooms` 还在涨 | `/etc/pi-remote.env` 或 drop-in 里是否设置了 `PI_REMOTE_PERSIST_TRANSCRIPTS`。部署脚本会告警，但不会擅自改这个文件 |
| 扩展连上又掉 | 本机 `PI_REMOTE_TOKEN` 与服务器 local token 不一致。改完 `.env` 要重启 pi |
| 页面 404 / 白屏 | 重跑 `deploy-web.ps1`，打开 `verify.html` 看哪一项失败 |
| 改完扩展不生效 | 没跑 `sync-extension.ps1`，或 pi 没重启 |
| UI 房间列表为空 | pi 是否在跑；扩展日志 `~/.pi/agent/pi-remote-sync.log`；`PI_REMOTE_RELAY` 是否指向云地址 |

`PI_REMOTE_DEBUG=1` 时扩展日志同时打到 stderr。`PI_REMOTE_LOG` 可改扩展日志路径。

## 10. 本机闭环（不碰云）

先在当前终端给 relay 三个令牌（都至少 16 字符，生成命令见 2.1 节），否则 `relay/server.js` 会按设计拒绝启动。PowerShell 写法：

```powershell
$env:PI_REMOTE_LOCAL_TOKEN = "<至少 16 字符>"
$env:PI_REMOTE_VIEWER_TOKEN = "<至少 16 字符，和 local 不同>"
$env:PI_REMOTE_ADMIN_TOKEN = "<至少 16 字符，和上面两个都不同>"   # 不配也可以，配对/撤销会被禁用
```

```powershell
cd D:\pi-myself
npm install
npm run relay                                  # 127.0.0.1:7001 + 7002
# 另一个终端：
deploy\start-pi.cmd
# 浏览器 http://127.0.0.1:7002 ，token 用你给 relay 配的 viewerToken
```

macOS / Linux：

```bash
cd ~/CLI/Pi-Remote
npm install
export PI_REMOTE_LOCAL_TOKEN="<至少 16 字符>"
export PI_REMOTE_VIEWER_TOKEN="<至少 16 字符，和 local 不同>"
export PI_REMOTE_ADMIN_TOKEN="<至少 16 字符，和上面两个都不同>"   # 可选
npm run relay                                  # 127.0.0.1:7001 + 7002
# 另一个终端：
deploy/start-pi.sh
```

本机 `.env` 的 `PI_REMOTE_TOKEN` 要与上面的 local token 一致，pi 扩展才能连上；浏览器输入的是 viewerToken。`start-pi.cmd` / `start-pi.sh` 只负责把 `.env` 读进 pi 进程环境。

```bash
npm test            # 单元/协议测试，不需要 pi
```

端到端的 `relayRestart` 需要 `E2E_RELAY_RESTART` 指向一条能重启本机 relay 的命令。

### 10.1 本地真实测试安全（硬规则）

- **禁止**在本地真实测试里直接运行 `deploy/attach.cjs`：它默认读仓库根 `.env`，可能带生产 relay / 生产 token。
- 本地测试只用：**127.0.0.1 relay + 临时 `data/` + 独立 env 文件**：

  ```bash
  node deploy/attach.cjs --env /tmp/pi-local-test.env   # 或 export ATTACH_ENV_FILE=/tmp/pi-local-test.env
  ```

- 默认 env 仍是仓库根 `.env`（兼容旧用法），但启动时会打印 env 来源与"本地测试请用 --env"提示。
- **非 localhost relay 默认在连接前退出（exit 2）**；部署/冒烟确需远端时显式加 `--allow-remote`，会打印醒目警告。
  guard 覆盖 attach / `--pair` / `--doctor`（doctor 只告警，因为只做 TCP 探测、不鉴权）。
- guard 自测（不真实连接）：`node --test test/deploy-attach-guard.test.mjs`。

## 11. 安全边界

- 7001 只接受 `role=local` 加 local token；7002 只接受 `role=viewer` 加 viewer token。
- relay 没有文件上传、下载或路径接口，也不读取模型密钥。
- 索引文件被拷走也没有对话正文。
- 有域名之后可以在前面加 Caddy 终结 `wss`，relay 与 UI 不用改。

## 12. 验收（要在服务器上做，脚本本身不代替这一步）

1. 单元已 `enable --now`；`/etc/pi-remote.env` 是 600，local / viewer / admin 三项都至少 16 字符且互不相同：local token 能连 7001、viewer token 能认证、admin token 能生成配对码/撤销设备。
2. `deploy-relay.ps1` / `.sh` 上传 `relay/` 下全部 `.js` 与 `protocol.json`（含 `index.js`），MD5 一致，重启后 `/healthz` 返回 200 且 `proto` 是本次版本。旧房间在保留期内仍可订阅。
3. `deploy-web.ps1` / `.sh` 之后 `/`、`/favicon.svg`、`/verify.html`、入口 JS/CSS 和一个非 `index-*` 懒加载 chunk 都是 200；部署前已有 `web/` 时服务器上存在 `web.prev/`，文件/目录权限对服务用户可读可进入。
4. 真实窗口连上后，`data/accounts/admin-<hash>/devices.jsonl` 与同目录 `sessions/` 下的清单文件出现，体积是 KB 级。
5. 生成一次配对码并用 `attach --pair` 成功换到设备令牌，`.env` 为 0600；撤销设备后该设备断开，重新配对可恢复。
6. 备份 cron 在位，并做过一次解包恢复。
7. 对比两天的 `du`，`data/rooms` 不再增长。
8. Windows 部署脚本已与 `.sh` 同步，但本机没有 `pwsh`，只做了静态检查；首次在 Windows 上执行 `.ps1` 时，按第 4 节观察自动回滚/快照输出，确认一次成功和一次失败路径。

## 13. 备注

- `data/rooms/*.jsonl` 与 `data/accounts/` 都是运行时数据，不是源码。本机 `npm run relay` 时项目下的 `data/` 同样如此。
- 测试在仓库 `test/`。早期一次性的浏览器脚本不在仓库里。
- 旧网关已由 `relay/` 取代，存档在 `backup/`（不进公开仓库的那部分保持 gitignore）。

## 14. 页面外通知（webhook → ntfy）

relay 内置通知编排器（`relay/notify.js`）：页面关着、手机锁屏时，回合完成（turn_done）、回合出错（turn_error）、对话框等待处理（dialog_waiting）三类事件经 webhook 渠道按 ntfy 的 **JSON 发布语义**发出——话题从配置地址的路径最后一段拆出、POST 到站点根 URL、body 带 `topic` 与 title / message / priority / tags（dialog_waiting 为最高 priority）。注意别把 JSON 直接 POST 到 `/<话题名>`：ntfy 会把它当成纯文本消息，标题与优先级全丢。与页面内的 Toast / 提示音互不影响。

### 配置（两项，只许写在服务器侧）

```ini
# /etc/pi-remote.env（chmod 600），或 relay/config.json 的同名字段（env 优先）
PI_REMOTE_NOTIFY_WEBHOOK_URL=https://ntfy.example.com/<话题名>
```

```json
// relay/config.json（gitignore，不进仓库）
{ "notifyEvents": { "turn_done": true, "turn_error": true, "dialog_waiting": true } }
```

- **webhook 地址本身就是凭据**（ntfy 的话题名即口令）：只许出现在服务器的 env / config.json 里，绝不写进仓库的任何文件、脚本或本文档；本文所有示例都是占位符。
- 默认全关：没配 URL = 整渠道禁用、零行为变化；配了 URL 也要把 `notifyEvents` 里对应事件改成 `true` 才发（缺省 false，防意外轰炸）。改完重启 relay 生效；启动日志会有一行启用说明（不带地址）。
- 临时停发：env 只要存在就以 env 为准——把 `PI_REMOTE_NOTIFY_WEBHOOK_URL` 显式设成空字符串（`PI_REMOTE_NOTIFY_WEBHOOK_URL=`）即可覆盖掉 config.json 里已配的地址，不必改文件；或把三类事件开关全改回 `false`。同样改完重启 relay 生效。
- 发送失败只在日志记一行（不带地址），不重试、不影响主流程。

### 接收端：ntfy 两条路线（二选一，部署位置待拍板后落地）

1. **ntfy.sh 公共服务（零部署，先行打通用）**：手机装 ntfy App → 订阅一个足够长的随机话题名 → webhook URL 写 `https://ntfy.sh/<同一个话题名>`。话题名泄露 = 任何人可往你的话题发消息，所以务必随机且只存服务器侧。代价：通知元信息（标题/会话名）经第三方服务器中转。
2. **自建 ntfy（与 relay 同机，数据不出自有服务器）**：ntfy 是单个 Go 二进制，服务器上装好后以 systemd 运行（官方文档的 server.yml + systemd 单元为准），监听本机端口、前面用既有反代（Caddy）终结 TLS 并加访问控制，不许裸奔公网可任意发布；webhook URL 写 `https://<你的域名>/<话题名>`。订阅端同样在 ntfy App 里添加自建服务器地址后订阅话题。

将来从路线 1 迁到路线 2 只改 `PI_REMOTE_NOTIFY_WEBHOOK_URL` 一个值，编排器与偏好不用动。

### 自测（在服务器上，地址换成真实值，不要把真实地址贴回任何仓库文件）

```bash
curl -s -X POST 'https://ntfy.example.com/' \
  -H 'content-type: application/json' \
  -d '{"topic":"<话题名>","title":"Pi-Remote · 测试","message":"webhook 链路自测","priority":3,"tags":["white_check_mark"]}'
# 按 ntfy 的 JSON 发布语义自测：POST 到站点根、topic 放 body 里，与编排器的发送形态一致；
# 把 JSON 直接 POST 到 /<话题名> 会被 ntfy 当成纯文本消息（标题/优先级丢失），不要那样测。
# 手机 ntfy App 收到这条 = 链路通；再把真实地址配进 env、三类开关打开、重启 relay，
# 关掉网页跑完一个回合，应收到“回合完成”通知。
```
