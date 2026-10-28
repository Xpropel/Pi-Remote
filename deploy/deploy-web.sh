#!/usr/bin/env bash
# deploy-web.sh —— 构建前端并部署到服务器（由中继同口托管）。macOS / Linux；Windows 用 deploy-web.ps1
# 用法： deploy/deploy-web.sh --server root@<你的服务器IP> [--viewer-base http://<你的服务器IP>:7002]
#        --server 也可以是 ~/.ssh/config 里的主机别名
# 只替换 web/（首次把旧站挪到 web-legacy-backup）。不删除 data/accounts 与 data/rooms，不写 token。
# 部署前把当前 web/ 快照到 web.prev/：解压、权限或验证任一步失败会自动还原并退出非零；成功也保留 web.prev/ 供手动回滚。
# --server 仍是占位符时，在构建和任何连接之前停止。
# --viewer-base 不给或仍是占位符时，改用 http://<Server 主机>:7002，不会去连占位主机。
# 服务器上替换 web/ 的脚本与 deploy-web.ps1 的 $lines 逐字相同；.sh 额外做快照/还原/权限，见 test/deploy-scripts.test.js。
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/.." && pwd)
ssh_opts=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$here/known_hosts")

server="root@<你的服务器IP>"
viewer_base="http://<你的服务器IP>:7002"
while [ $# -gt 0 ]; do
  case "$1" in
    --server | -Server)
      server=${2:-}
      shift 2 || { echo "--server 需要一个值" >&2; exit 2; }
      ;;
    --server=*) server=${1#--server=}; shift ;;
    --viewer-base | -ViewerBase)
      viewer_base=${2:-}
      shift 2 || { echo "--viewer-base 需要一个值" >&2; exit 2; }
      ;;
    --viewer-base=*) viewer_base=${1#--viewer-base=}; shift ;;
    -h | --help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  c_green=$'\033[32m' c_red=$'\033[31m' c_cyan=$'\033[36m' c_off=$'\033[0m'
else
  c_green="" c_red="" c_cyan="" c_off=""
fi
green() { printf '%s%s%s\n' "$c_green" "$*" "$c_off"; }
red() { printf '%s%s%s\n' "$c_red" "$*" "$c_off"; }
step() { printf '%s%s%s\n' "$c_cyan" "$*" "$c_off"; }
die() {
  red "$*" >&2
  exit 1
}

case "$server" in
  "" | *"<"* | *">"* | *你的服务器IP*) die "请把 --server 换成实际的 root@主机 或 ssh 别名。占位默认值不会发起连接，也不含 token。" ;;
esac
printf '%s' "$server" | grep -Eq '^([^@[:space:]]+@[^@[:space:]]+|[A-Za-z0-9._-]+)$' ||
  die "参数 --server 应为 root@主机（或 ~/.ssh/config 里的主机别名）。"

case "$viewer_base" in
  "" | *"<"* | *">"* | *你的服务器IP*)
    case "$server" in
      *@*) viewer_host=${server#*@} ;;
      *) viewer_host=$(ssh -G "$server" 2>/dev/null | awk '$1 == "hostname" { print $2; exit }') ;;
    esac
    [ -n "$viewer_host" ] || die "解析不出 $server 的主机名，请用 --viewer-base 指定。"
    viewer_base="http://${viewer_host}:7002"
    ;;
esac
viewer_base=${viewer_base%/}
if ! printf '%s' "$viewer_base" | grep -Eq '^https?://[^[:space:]]+$' || printf '%s' "$viewer_base" | grep -q 'token='; then
  die "--viewer-base 应为 http://主机:7002。不要把 token 放进参数。"
fi

cd "$root"

step "==> 1/4 构建前端 (ui -> web)"
(cd ui && npm run build) || die "前端构建失败"
# 冒烟验证页随站点一起部署：它要读 relay 的响应状态，只能同源打开（file:// 下浏览器拦截跨源读取）
cp "$here/verify.html" "$root/web/verify.html"
for rel in web/index.html web/favicon.svg web/verify.html; do
  [ -f "$root/$rel" ] || die "构建结果缺少 $rel。已停止，不会上传。"
done

step "==> 2/4 打包 web/"
tar_file=$(mktemp "${TMPDIR:-/tmp}/pi-web-dist.XXXXXX")
sh_file=$(mktemp "${TMPDIR:-/tmp}/pi-deploy-web.XXXXXX")
trap 'rm -f "$tar_file" "$sh_file"' EXIT
# macOS 的 bsdtar 默认会塞 ._ 资源叉和 xattr 扩展头：服务器上的 GNU tar 解出来就是一堆垃圾文件和告警
tar_flags=()
if tar --version 2>/dev/null | grep -q bsdtar; then tar_flags=(--no-mac-metadata --no-xattrs); fi
COPYFILE_DISABLE=1 tar ${tar_flags[@]+"${tar_flags[@]}"} -cf "$tar_file" -C web . || die "打包 web 失败"
[ -s "$tar_file" ] || die "打包结果是空的。已停止，不会上传。"

step "==> 3/4 上传、快照旧版、解压（失败自动还原）"
scp -q "${ssh_opts[@]}" "$tar_file" "$server:/tmp/pi-web-dist.tar" || die "上传失败"

run_web_remote() {
  printf '%s\n' "$1" | tr -d '\r' >"$sh_file"
  ssh "${ssh_opts[@]}" "$server" 'bash -s' <"$sh_file"
}

# 先整份留一份当前 web/：解压、权限、验证任一步失败都能退回去；成功也保留，供手动回滚
IFS= read -r -d '' SNAPSHOT_BODY <<'SNAPSHOT_BODY' || true
set -eu
app=${PI_REMOTE_APP_DIR:-/opt/pi-remote/app}
cd "$app"
if [ -L web ] || [ -L web.prev ]; then echo "FAIL web_symlink"; exit 1; fi
rm -rf web.prev web.failed web.next
if [ -d web ]; then
  cp -a web web.prev
  echo "OK web_prev_kept"
else
  echo "OK web_prev_absent"
fi
SNAPSHOT_BODY

# 失败还原：优先 web.prev；首次部署或 WEB_BODY 中途失败时退回它留下的 web.old
IFS= read -r -d '' RESTORE_BODY <<'RESTORE_BODY' || true
set -eu
app=${PI_REMOTE_APP_DIR:-/opt/pi-remote/app}
cd "$app"
src=web.prev
if [ ! -d "$src" ]; then
  if [ -d web.old ]; then
    src=web.old
  else
    echo "FAIL web_prev_missing"
    exit 1
  fi
fi
rm -rf web.failed
if [ -d web ]; then mv web web.failed; fi
mv "$src" web
rm -rf web.next
echo "OK web_restored"
RESTORE_BODY

# 权限归一化：目录 755、文件 644（a+rX 给目录执行位），懒加载 chunk 也在 web/assets 下逐项确认 other 可读
IFS= read -r -d '' PERMS_BODY <<'PERMS_BODY' || true
set -eu
app=${PI_REMOTE_APP_DIR:-/opt/pi-remote/app}
cd "$app"
if [ -L web ]; then echo "FAIL web_symlink"; exit 1; fi
chown -R root:root web || { echo "FAIL perms_web_owner"; exit 1; }
chmod -R a+rX,go-w web || { echo "FAIL perms_web_mode"; exit 1; }
# web/assets 下的懒加载 chunk 与入口文件一样必须 other 可读，目录必须可进入
bad=$(find web -type f -not -perm -004 -print)
if [ -n "$bad" ]; then
  echo "FAIL perms_web_unreadable"
  printf '%s\n' "$bad"
  exit 1
fi
bad=$(find web -type d -not -perm -001 -print)
if [ -n "$bad" ]; then
  echo "FAIL perms_web_untraversable"
  printf '%s\n' "$bad"
  exit 1
fi
echo "OK web_perms"
PERMS_BODY

restore_web() {
  if run_web_remote "$RESTORE_BODY"; then
    green "  已自动还原上一版 web/"
    # 旧版可能是权限修复前部署的：还原后再补一次可读权限
    run_web_remote "$PERMS_BODY" || red "  警告：还原后权限归一化失败，请手动检查服务器上的 web/"
    return 0
  fi
  red "  自动还原失败（没有 web.prev/、也没有 web.old/，或恢复命令失败）。"
  red "  立即 ssh $server 检查 /opt/pi-remote/app/web*，必要时从 web-legacy-backup/ 恢复旧站。"
  return 1
}

# 服务器上执行的脚本：与 deploy-web.ps1 里的 $lines 逐字相同，改一边必须同步另一边
IFS= read -r -d '' WEB_BODY <<'WEB_BODY' || true
set -eu
cd /opt/pi-remote/app
if [ -L web ] || [ -L web-legacy-backup ] || [ -L data ] || [ -L data/accounts ] || [ -L data/rooms ]; then echo "FAIL web_symlink refusing to follow a symlink into web or data; nothing deleted"; exit 1; fi
mkdir -p data/accounts
if [ -d web ] && [ ! -d web-legacy-backup ]; then mv web web-legacy-backup; fi
# 先解到 web.next 再整体换目录：部署过程中访问不会拿到新旧混合的文件，旧资源也不会越积越多
rm -rf web.next
mkdir -p web.next
tar -xf /tmp/pi-web-dist.tar -C web.next
rm -f /tmp/pi-web-dist.tar
# 已打开的旧页面还会按旧 index 懒加载带 hash 的 chunk：把上一版 7 天内的 assets 带过来（不覆盖新文件）。
# cp -p 保留原 mtime，带过来的旧文件 7 天后自然不再续命，不会无限累积。
if [ -d web/assets ]; then mkdir -p web.next/assets; find web/assets -maxdepth 1 -type f -mtime -7 -exec sh -c 'for f do b=$(basename "$f"); [ -e "web.next/assets/$b" ] || cp -p "$f" "web.next/assets/$b"; done' sh {} +; fi
if [ -d web ]; then rm -rf web.old; mv web web.old; fi
mv web.next web
rm -rf web.old
# 与 relay 一致：代码归 root，服务用户只读；别把 app 整棵树给 pi-remote
chown -R root:root web
echo "web files ready"
WEB_BODY

run_web_remote "$SNAPSHOT_BODY" || die "旧版快照失败；web/ 未改动，已停止"
if ! run_web_remote "$WEB_BODY"; then
  red "服务器端解压/切换失败"
  restore_web || true
  die "部署失败：已尝试还原上一版（看上面的输出）"
fi
if ! run_web_remote "$PERMS_BODY"; then
  red "web/ 权限归一化失败"
  restore_web || true
  die "部署失败：已尝试还原上一版（看上面的输出）"
fi
green "  权限已归一化：目录可进入、文件（含懒加载 chunk）对服务用户可读"

step "==> 4/4 验证"
# 主 JS/CSS 名带内容 hash：从刚构建的 index.html 里取，确认服务器上真是这一版
paths=(/ /favicon.svg /verify.html)
while IFS= read -r asset; do
  [ -n "$asset" ] && paths+=("$asset")
done < <(grep -Eo '(src|href)="/assets/index-[^"]+\.(js|css)"' "$root/web/index.html" | sed -E 's/^(src|href)="//; s/"$//')
# 再抽一个非入口的懒加载 chunk：确认带 hash 的按需资源也能被服务用户读到
lazy=""
if [ -d "$root/web/assets" ]; then
  for f in "$root/web/assets"/*.js; do
    [ -f "$f" ] || continue
    b=${f##*/}
    case "$b" in index-*) ;; *) lazy=$b; break ;; esac
  done
fi
if [ -n "$lazy" ]; then paths+=("/assets/$lazy"); fi
failed=0
if [ "${#paths[@]}" -lt 5 ]; then
  failed=$((failed + 1))
  red "  web/index.html 里没找到主 JS/CSS（构建产物不完整？）"
fi
for p in "${paths[@]}"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 --retry 2 --retry-delay 1 "$viewer_base$p" || true)
  if [ "$code" = "200" ]; then
    green "  $p -> $code"
  else
    failed=$((failed + 1))
    red "  $p -> ${code:-无响应}"
  fi
done
if [ "$failed" -ne 0 ]; then
  red "$failed 个地址验证失败：开始自动还原上一版"
  restore_web || true
  die "$failed 个地址验证失败；已尝试还原上一版（看上面的输出）"
fi
echo
green "DONE. 打开 $viewer_base/"
echo "冒烟验证页：$viewer_base/verify.html"
echo "上一版保留在服务器 /opt/pi-remote/app/web.prev/；需要手动回滚时："
echo "  ssh $server 'cd /opt/pi-remote/app && rm -rf web.failed && mv web web.failed && mv web.prev web && systemctl restart pi-remote.service'"
echo "viewer token 在服务器 /etc/pi-remote.env。不要写进仓库、参数或这条命令的输出。"
