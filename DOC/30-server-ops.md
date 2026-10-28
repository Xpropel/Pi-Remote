# 服务器端详细设计：云服务器部署与运维（Ubuntu 24.04 · 单机无 docker）

> 范围：云服务器基础设施与运维（node 运行时、systemd、数据目录、部署、备份、安全）。
> 与应用逻辑的边界：`relay/*.js` 内部逻辑见 `DOC/10-relay-backend.md`；本文只管"怎么把它跑稳、跑久、可回滚"。
> 帧与命令的共同约定见 `DOC/50-protocol-delta.md`。部署形态：relay 与 web 同口 7002。

## 1. 目标拓扑

```
Internet
   │  7002 (viewer：页面 + WS)   ← 手机/电脑浏览器
   │  7001 (local：**默认只绑 127.0.0.1**；要对公网开放需 PI_REMOTE_LOCAL_HOST=0.0.0.0 或 SSH 隧道)
   │        ← 家里/办公室 Windows 的 attach 命令与 pi 扩展
   ▼
<你的服务器IP> (Ubuntu 24.04)
   systemd: pi-remote.service    WorkingDirectory=/opt/pi-remote/app
   ├── relay/*.js（入口 server.js，其余是按职责拆开的模块）+ relay/protocol.json
   ├── web/         （前端产物，relay 7002 同口静态托管）
   └── data/
       ├── accounts/index.jsonl + accounts/<账户>/...     【本期唯一持久化内容：索引，KB 级】
       └── rooms/*.jsonl                                  【旧正文存储：默认停写，30 天自然过期】
```

安全组只放 7001/7002 入站；SSH(22) 仅信任 IP（或密钥）。

## 2. 运行时与目录

| 项 | 值 |
|---|---|
| Node | `/opt/pi-remote/bin/node`（v22 LTS，npmmirror 安装） |
| 代码 | `/opt/pi-remote/app/`（relay/ + web/ + package.json + node_modules） |
| 数据 | `/opt/pi-remote/app/data/` |
| 日志 | journald（`journalctl -u pi-remote.service`）+ 应用 `logs/` 目录 |
| 单元 | `/etc/systemd/system/pi-remote.service`（+ drop-in override 放 token） |

## 3. systemd 单元（含 token 隔离）

`/etc/systemd/system/pi-remote.service`：

```ini
[Unit]
Description=pi-remote relay (viewer page and local channel)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/pi-remote/app
ExecStart=/usr/local/bin/node relay/server.js
Restart=on-failure
RestartSec=2
Environment=NODE_ENV=production
# token 不放代码仓库：用 drop-in（见下）
EnvironmentFile=-/etc/pi-remote.env

[Install]
WantedBy=multi-user.target
```

`/etc/pi-remote.env`（**仅存服务器**，600 权限，绝不入库）：

```
PI_REMOTE_LOCAL_TOKEN=<真实 localToken>
PI_REMOTE_VIEWER_TOKEN=<真实 viewerToken>
# PI_REMOTE_PERSIST_TRANSCRIPTS 不设 = 默认停写正文（本期默认）
# PI_REMOTE_ALLOW_LEGACY_LOCAL 不设 = 兼容期仍接受共享 localToken 登录 7001；
#   所有设备都配对过（网页名册里 auth 全是 token）之后设成 0，7001 就只认设备令牌
```

- 本次改造的**关键前置**：扩展默认行为从"常连"改为"窗口门控"后，服务端必须已能用 env 取到 token（本设计即为此），否则步 1 上线瞬间全部掉线。
- 权限：`chmod 600 /etc/pi-remote.env`；`systemctl daemon-reload && systemctl restart pi-remote.service` 生效。

## 4. 部署

### 4.1 首次上云

1. 装 Node（npmmirror，见 README/deploy README 既有步骤）。
2. 上传项目 → `npm install --registry=https://npmmirror.com ws dotenv`。
3. 装单元 + `/etc/pi-remote.env` + `daemon-reload` + `enable --now`。
4. 安全组开 7001/7002；`curl 127.0.0.1:7002/` 回 200。
5. 部署 web（`deploy-web.ps1`，见 4.3）。

### 4.2 日常三件套（本机 PowerShell 执行）

| 改动 | 命令 | 说明 |
|---|---|---|
| 扩展 `extension/**` | `deploy\sync-extension.ps1` | 本机同步 + MD5；**不碰服务器**；重启 pi 生效 |
| relay `relay/**`（含新 `index.js`） | `deploy\deploy-relay.ps1 -Server "root@<IP>"` | 先校验 systemd 单元（不含 token）→ 上传到 `relay.new/` → md5 比对 → 顶替 `relay/`（`config.json` 等非代码文件一并带过去，部署前那版整份留 `relay.cur/`）→ `systemctl restart` → 回环 7002 验证 200 → 确认成功后才轮转成 `relay.prev/`（再上一版 `relay.prev.1/`） |
| 前端 `ui/src/**` | `deploy\deploy-web.ps1 -Server "root@<IP>" -ViewerBase "http://<IP>:7002"` | 本机构建 → tar → 上传解到 `web.next/` 再整目录替换 `web/`（部署中途不会拿到新旧混合文件）→ 验证 `/` 与 `/favicon.svg` 200 |

> `deploy-relay.ps1` 本期需**增加上传 `relay/index.js`**（后端新增文件）；脚本已有的 MD5/重启/回环校验逻辑不变。

### 4.3 部署顺序（与阶段计划对齐）

- 步 0：先部署 relay（含 `index.js`）→ 再部署扩展（manifest 上报）→ 数据目录自动出现 `data/accounts/admin/...`。
- 步 1：先确认 `/etc/pi-remote.env` 就位 → 再部署带门控的扩展 + attach 命令；部署后**先本机 attach 一次**再宣布完成。
- 任何时候：先服务器后本机（token 一致性原则）。

## 5. 数据与迁移

| 目录 | 内容 | 策略 |
|---|---|---|
| `data/accounts/` | 索引（账户/设备/会话清单）；`<账户>/device-tokens.jsonl` 是设备令牌的 sha256（600 权限，不含令牌原文） | **不过期**（KB 级）；随部署/重启保留。删掉令牌文件 = 所有设备要重新配对 |
| `data/rooms/` | 旧正文 jsonl | 默认不再写入（`PI_REMOTE_PERSIST_TRANSCRIPTS` 未设）；`retentionDays=30` 自然清理；期间旧房间 id 仍可订阅（读完即弃） |
| `logs/` | 应用日志 | logrotate（10MB×5） |

**零人工迁移**：升级后第一个窗口连接即把该设备清单写入索引；旧文件自然过期。

## 6. Token 管理（轮换流程，服务器端主导）

1. 服务器：编辑 `/etc/pi-remote.env` 两个值 → `daemon-reload` → `restart`。
2. 本机：`.env` 的 `PI_REMOTE_TOKEN` 同步改 → 重启 pi / 重跑 attach。
3. viewer：所有已登录浏览器要**重新输 token**（localStorage 里的旧值失效，auth 失败自动清除）。
4. 顺序永远是**先服务器后本机**；回滚则反向。

设备令牌（协议 v4 `device.token`）不走上面的流程：网页"添加设备"生成一次性配对码，本机 `attach --pair` 换令牌；某台设备丢了或令牌泄露，在网页上撤销它（`device_revoke`），或重新配对一次（旧令牌自动作废）。两者都会立刻断开这台设备用旧令牌连着的窗口和扩展。

## 7. 备份与恢复

| 对象 | 频率 | 方式 | 恢复 |
|---|---|---|---|
| `data/accounts/` | 每日（cron tar） | `tar czf /opt/backups/accounts-$(date +%F).tgz -C /opt/pi-remote/app/data accounts` | 先 `systemctl stop pi-remote`，解包回 `data/`，再 start。relay 把名册、会话清单、令牌表缓存在内存里，运行中解包它看不到，之后的写入还可能盖掉解包的内容 |
| `/etc/pi-remote.env` | 每次变更后 | 手动异地保存（密码管理器） | 写回 + restart |
| `relay/*.js` + `deploy/*.ps1` | 随 git | 项目仓库即备份 | 重新部署 |
| 对话正文 | **不备份** | 内容只在本机；本机自己有 session 文件 | — |

保留 7 天备份；`data/rooms` 不备份（过渡期旧数据，丢了就丢了）。

## 8. 监控与运维命令

```bash
systemctl status pi-remote.service        # 状态
systemctl restart pi-remote.service       # 重启
journalctl -u pi-remote.service -f        # 实时日志
ss -ltnp | grep 700                       # 端口
du -sh /opt/pi-remote/app/data/*          # 数据体积（accounts 应 KB 级）
ls /opt/pi-remote/app/data/accounts/admin/devices.jsonl   # 名册存在性
```

健康检查：`curl -s http://127.0.0.1:7002/healthz` → `{"ok":true,"proto":4,"version":…,"uptimeSec":…,"rooms":{"online":…,"total":…},"devices":{"online":…,"total":…},"viewers":…}`。不需要 token，只给计数和版本（`relay/wire.js` 里的常量 `RELAY_VERSION`），不含房间名、路径、设备名。部署脚本的回环验证认它的正文：部署时 `proto` 必须是这次带上去的协议版本（旧版 relay 对任何路径都回首页 200，只看状态码分不出新旧）；回滚到没有 `/healthz` 的旧版时，才退回看 `GET /` 是 200。

`data/accounts/` 下的文件被 relay 整份缓存在内存（写穿透）：运行期间手改或替换这些文件不会生效，要重启。

异常对照：

| 现象 | 先查 |
|---|---|
| viewer 全掉 | `systemctl status`；token 是否被改；`ss` 端口 |
| 设备能注册但网页看不到 | `room_list.devices` 是否含该 deviceId；`data/accounts/admin/devices.jsonl` 有无行 |
| 会话清单空 | 扩展是否在窗口内上报（本机 attach 在跑？）；`sessions/<deviceId>.jsonl` 有无行 |
| 磁盘上涨 | `data/rooms` 未停写（`PI_REMOTE_PERSIST_TRANSCRIPTS` 被设了？） |

## 9. 回滚

| 回滚什么 | 做法 |
|---|---|
| relay 代码 | `deploy-relay.ps1 -Rollback`：本次部署没确认成功时整份还原 `relay.cur/`，否则整份还原 `relay.prev/`（含 `config.json`）→ restart（索引数据格式加法式兼容，无需回滚数据） |
| web 产物 | 服务器留 `web-legacy-backup/`（首次部署时 mv）；拷贝回 |
| 配置/token | `/etc/pi-remote.env` 改回旧值 → restart（同时本机改回） |
| 扩展 | 本机 `sync-extension.ps1` 同步旧版扩展文件 → 重启 pi |

## 10. 安全边界（服务器侧）

- 7001 只接受 `role=local` + 设备令牌（或兼容期的共享 localToken），以及未鉴权的一次性 `pair` 帧，且**默认只听回环**；7002 只接受 `role=viewer`+viewerToken。
- 用设备令牌登录的连接只能以绑定的那台设备登记窗口、房间和会话清单。共享 localToken 在兼容期只能登记**从未配对过**的设备：设备名册里一旦有 `pairedAt`（令牌被撤销后也保留），legacy 的 `device_register` / `room_register` / `session_manifest` 一律 `device_mismatch`。要彻底关掉兼容期，设 `PI_REMOTE_ALLOW_LEGACY_LOCAL=0`。
- 重新配对已有设备必须同时出示旧设备令牌（`attach --pair` 会自动带上 `.env` 里的旧令牌）；只有配对码不能接管已知 deviceId。
- 配对码只在 relay 内存里、10 分钟有效、只能用一次；同一来源一分钟内配对失败 10 次就停它一分钟，别的来源照常配对。来源是对端 IP（IPv6 按 /64）；7001 前面套本机反代（Caddy）时按 `X-Forwarded-For` 的最后一跳算，反代不在本机的话所有设备都算成反代这一个来源。日志里的"配对失败"行带来源，可以据此在安全组封 IP。
- 明文 ws 下 viewerToken 可被嗅探，而拿到它就能向带工具权限的 pi 发提示词（等同远程执行）：要么内网/隧道使用，要么 Caddy 反代上 TLS（配方见 `deploy/README.md` §1.1）。
- 文件属主：`/opt/pi-remote/app` 下的代码归 root，只有 `data/` 与 `logs/` 归 `pi-remote`——relay 被攻破后不能改写自己的代码持久化。systemd 单元用 `UMask=0077`、`ProtectSystem=strict`、`ProtectHome`、`PrivateTmp`、`NoNewPrivileges`，`ReadWritePaths` 只放 `data/` 与 `logs/`；部署脚本会把旧索引文件补成属主可读。
- 无任何文件上传/下载/路径接口；relay 不碰模型密钥。
- 索引文件只含设备名/目录/会话元数据（无对话正文）；被拖库也拿不到内容。
- TLS 升级路径：有域名后前置 Caddy 终结 `wss`（relay/UI 零改动）。

## 11. 验收清单（服务器端）

1. 单元就位且 `enable --now`；`/etc/pi-remote.env` 600 权限且 token 生效（`auth` 通）。
2. `deploy-relay.ps1`（含 index.js）→ md5 一致、restart 后 7002 回环 200、旧房间仍可订阅。
3. `deploy-web.ps1` → `/` 与 favicon 200。
4. 真实窗口连接后：`data/accounts/admin-<hash>/devices.jsonl` 与 `sessions/<deviceId>.jsonl` 出现且体积 KB 级（目录名带账号哈希，不是字面 `admin`）。
5. 备份 cron 就位；恢复演练一次（解包→查询接口正常）。
6. `data/rooms` 不再增长（`du` 两天对比）。
