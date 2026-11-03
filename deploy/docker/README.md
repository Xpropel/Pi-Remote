# relay 的 Docker 部署

用 Docker Compose 运行 relay 的可选路径，与 [deploy/README.md](../README.md) 里的 systemd 部署二选一。镜像只包含 relay 本体、预构建的网页与生产依赖（`ws`），以非 root 用户（`node`）运行；设备端的 pi 与 attach 不在镜像内，仍按主 README 的快速开始在本机运行。

## 首次启动

在本目录（`deploy/docker/`）执行：

```bash
cp .env.example .env
# 编辑 .env，填入三枚 token（生成方法见 .env.example 注释）
docker compose up -d
curl -s http://127.0.0.1:7002/healthz
```

`docker compose up -d` 会先构建镜像再启动。`/healthz` 返回 `{"ok":true,...}` 即 relay 已就绪；浏览器打开 `http://<服务器地址>:7002`，输入 `.env` 里的 viewer token 登录。

配置全部经 `.env` 注入，字段说明在 `.env.example` 里：`PI_REMOTE_LOCAL_TOKEN` 与 `PI_REMOTE_VIEWER_TOKEN` 必填（缺任何一个 compose 都会拒绝启动），`PI_REMOTE_ADMIN_TOKEN` 强烈建议填（不填则网页上无法生成配对码、撤销设备），其余可选。真实 token 只存在于 `.env`（已 gitignore），不进镜像、不进仓库。

## 端口

| 容器端口 | 宿主机映射（默认） | 说明 |
|---|---|---|
| 7002 | `7002`（全部网卡） | 网页与 viewer WebSocket，含 `/healthz` |
| 7001 | `127.0.0.1:7001`（仅宿主机回环） | 扩展通道。默认不对网络开放：同机 attach、SSH 隧道可直接用；pi 在另一台机器时，把 compose 里这一行改成 `"7001:7001"` 并用防火墙限制来源地址 |

公网暴露与 TLS 的注意事项与 systemd 部署相同，见 [deploy/README.md 第 1.1 节](../README.md#11-暴露面与-tls重要先读)。

## 数据

全部状态只存一个命名卷 `pi-remote-data`，挂在容器内 `/app/data`：

| 卷内路径 | 内容 |
|---|---|
| `data/accounts/` | 账户、设备名册、会话清单（不过期，升级必须保留） |
| `data/rooms/` | 会话正文（默认不写；`.env` 里加 `PI_REMOTE_PERSIST_TRANSCRIPTS=1` 才落盘，保留期 30 天） |

选命名卷而不是宿主机目录，是为了让三个平台（Linux / macOS / Windows）行为一致、且不会随代码目录被误删。`docker compose down` 不删卷；只有 `docker compose down -v` 会删，日常不要用 `-v`。

备份（打包整个数据卷）：

```bash
docker run --rm -v pi-remote-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/pi-remote-data-$(date +%F).tgz -C /data .
```

恢复：停 relay 后把包解回空卷再启动。

```bash
docker compose down
docker run --rm -v pi-remote-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/pi-remote-data-<日期>.tgz -C /data'
docker compose up -d
```

如需改用宿主机目录，把 compose 里的 `pi-remote-data:/app/data` 换成 `./data:/app/data` 并删掉顶层 `volumes:` 段；目录属主需与容器内 `node` 用户（uid 1000）可读写一致。

## 升级

升级 = 换新代码、重建镜像、原地重启，数据卷不动：

```bash
# 1) 取得新版本代码（git pull 或解压新版 release 包）

# 2) 升级前自检（只读，不改任何数据；不过就先停下处理，不要硬升）
docker compose exec relay node deploy/docker/pre-upgrade-check.cjs
#    容器还没起来时用一次性容器跑同样的检查：
#    docker compose run --rm relay node deploy/docker/pre-upgrade-check.cjs

# 3) 重建并重启
docker compose build
docker compose up -d
curl -s http://127.0.0.1:7002/healthz
```

自检脚本校验：账号索引（`index.jsonl`、`devices.jsonl`、会话清单）可读且每行可解析、房间文件可读、目录可写、是否还有 relay 进程占用数据目录。个别坏行只告警（relay 加载时同样跳过坏行），文件整体不可读或非空文件无一行可解析才判失败并以退出码 1 停住。升级前另做一份第 3 节的卷备份更稳妥。

回滚：切回旧版本代码，重复第 2、3 步即可；数据格式向后兼容，不要删除数据卷。

## 日常命令

```bash
docker compose logs -f relay     # 看日志（进程日志走 stdout）
docker compose ps                # 状态（含 healthcheck 结果）
docker compose restart relay     # 重启
docker compose down              # 停止并删容器（保留数据卷）
```
