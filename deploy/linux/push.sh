#!/usr/bin/env bash
# push.sh —— 把 Linux 设备套件推到服务器上某个普通用户的目录（在 Mac / Linux 上执行；设计见 deploy/README.md）
# 用法：
#   deploy/linux/push.sh --server root@<你的服务器IP> --user <设备用户> [--dir <目录>]
#   deploy/linux/push.sh --server <以设备用户登录的 ssh 别名> [--dir <目录>]
# 做什么：打包本机端要用的文件（attach、start-pi、扩展、协议、deploy/linux、package*.json）→ 传到登录用户的家目录 →
#   以设备用户身份解到 <目录>.new.<pid> 暂存目录并 npm ci → 整体换版（旧版留 <目录>.prev/）→ 扩展同步 → doctor。
# 暂存目录里任何一步失败都不动正式目录；扩展同步失败会把旧版换回来。.env 复制进新版并收紧 600；不碰 relay 与 /etc/pi-remote.env。
# --user 缺省是 ssh 登录用户。设备用户是 root 时停止（网页能让 pi 执行命令，不给它 root），确实要用加 --allow-root。
# 占位的 --server 不会发起连接。known_hosts 用 deploy/known_hosts（同 deploy-relay.sh）。
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
deploy_dir=$(cd "$here/.." && pwd)
root=$(cd "$deploy_dir/.." && pwd)
ssh_opts=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$deploy_dir/known_hosts")
remote_tar=pi-remote-device-kit.tar
kit_files=(
  package.json
  package-lock.json
  .env.example
  protocol/v4.json
  extension/pi-remote-sync.ts
  deploy/attach.cjs
  deploy/session-library.cjs
  deploy/attach.sh
  deploy/start-pi.sh
  deploy/sync-extension.sh
  deploy/linux/device.cjs
  deploy/linux/device.sh
)

server="root@<你的服务器IP>"
user=""
dir=""
allow_root=0
while [ $# -gt 0 ]; do
  case "$1" in
    --server)
      server=${2:-}
      shift 2 || { echo "--server 需要一个值" >&2; exit 2; }
      ;;
    --server=*) server=${1#--server=}; shift ;;
    --user)
      user=${2:-}
      shift 2 || { echo "--user 需要一个值" >&2; exit 2; }
      ;;
    --user=*) user=${1#--user=}; shift ;;
    --dir)
      dir=${2:-}
      shift 2 || { echo "--dir 需要一个值" >&2; exit 2; }
      ;;
    --dir=*) dir=${1#--dir=}; shift ;;
    --allow-root) allow_root=1; shift ;;
    -h | --help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  c_green=$'\033[32m' c_yellow=$'\033[33m' c_red=$'\033[31m' c_cyan=$'\033[36m' c_off=$'\033[0m'
else
  c_green="" c_yellow="" c_red="" c_cyan="" c_off=""
fi
green() { printf '%s%s%s\n' "$c_green" "$*" "$c_off"; }
yellow() { printf '%s%s%s\n' "$c_yellow" "$*" "$c_off"; }
red() { printf '%s%s%s\n' "$c_red" "$*" "$c_off"; }
step() { printf '%s%s%s\n' "$c_cyan" "$*" "$c_off"; }
die() {
  red "$*" >&2
  exit 1
}

case "$server" in
  "" | *"<"* | *">"* | *你的服务器IP*) die "请把 --server 换成实际的 root@主机 或 ssh 别名。占位默认值不会发起连接。" ;;
esac
printf '%s' "$server" | grep -Eq '^([^@[:space:]]+@[^@[:space:]]+|[A-Za-z0-9._-]+)$' ||
  die "参数 --server 应为 用户@主机（或 ~/.ssh/config 里的主机别名）。"
if [ -n "$user" ]; then
  printf '%s' "$user" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || die "--user 应为 Linux 用户名（小写字母、数字、_ 和 -）：$user"
fi
login_user=""
case "$server" in *@*) login_user=${server%%@*} ;; esac
if [ "${user:-$login_user}" = root ] && [ "$allow_root" != 1 ]; then
  die "设备用户是 root：网页能让服务器上的 pi 执行命令，不要给它 root。加 --user <普通用户>（没有就先在服务器上 adduser），确实要用 root 加 --allow-root。"
fi
if [ -n "$dir" ]; then
  printf '%s' "$dir" | grep -Eq '^/[A-Za-z0-9._/-]+$' || die "--dir 要写绝对路径，只含字母、数字和 ._/-：$dir"
  case "$dir/" in
    */./* | */../* | / | //*) die "--dir 不能是根目录，也不能含 . 或 .. 段：$dir" ;;
  esac
  dir=${dir%/}
fi
for f in "${kit_files[@]}"; do
  [ -s "$root/$f" ] || die "缺少 ${root}/${f}（或是空文件）。已停止，没有连接服务器。"
done

step "==> 1/3 打包设备套件（${#kit_files[@]} 个文件，不含 .env 和 node_modules）"
tar_file=$(mktemp "${TMPDIR:-/tmp}/pi-device-kit.XXXXXX")
sh_file=$(mktemp "${TMPDIR:-/tmp}/pi-device-push.XXXXXX")
trap 'rm -f "$tar_file" "$sh_file"' EXIT
# macOS 的 bsdtar 默认会塞 ._ 资源叉和 xattr 扩展头：服务器上的 GNU tar 解出来就是一堆垃圾文件和告警
tar_flags=()
if tar --version 2>/dev/null | grep -q bsdtar; then tar_flags=(--no-mac-metadata --no-xattrs); fi
(cd "$root" && COPYFILE_DISABLE=1 tar ${tar_flags[@]+"${tar_flags[@]}"} -cf "$tar_file" "${kit_files[@]}") || die "打包失败"

step "==> 2/3 上传到 ${server}（登录用户的家目录，不经 /tmp）"
scp -q "${ssh_opts[@]}" "$tar_file" "$server:$remote_tar" || die "上传失败"

# 服务器上执行：以设备用户身份解包、装依赖、同步扩展、体检。参数：设备用户（空=登录用户）、目录（空=~用户/pi-remote）、是否允许 root
# 先在 <目录>.new.<pid> 暂存：解包、npm ci 全部成功后才整体换目录；任何一步失败都不动旧目录。
IFS= read -r -d '' PUSH_BODY <<'PUSH_BODY' || true
set -eu
want=${1:-}
dir=${2:-}
allow_root=${3:-0}
tar_in=$HOME/pi-remote-device-kit.tar
me=$(id -un)
[ -n "$want" ] || want=$me
if [ "$want" = root ] && [ "$allow_root" != 1 ]; then echo "FAIL root_user"; exit 1; fi
if ! id "$want" >/dev/null 2>&1; then echo "FAIL no_user $want"; exit 1; fi
if [ "$me" != "$want" ] && [ "$(id -u)" != 0 ]; then echo "FAIL need_root $me"; exit 1; fi
home=$(getent passwd "$want" 2>/dev/null | cut -d: -f6 || true)
# 用户名已在本机校验过只含 [a-z0-9_-]，eval 展开 ~用户 是安全的（没有 getent 的系统才走这里）
if [ -z "$home" ]; then home=$(eval "printf '%s' ~$want"); fi
[ -n "$dir" ] || dir=$home/pi-remote
dir=${dir%/}
[ -n "$dir" ] || { echo "FAIL bad_dir"; exit 1; }
as_user() {
  if [ "$me" = "$want" ]; then
    "$@"
  else
    runuser -u "$want" -- env HOME="$home" USER="$want" LOGNAME="$want" PATH="$home/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@"
  fi
}
if [ -L "$dir" ]; then echo "FAIL dir_symlink $dir"; exit 1; fi
staging="${dir}.new.$$"
# 暂存目录与旧目录同父目录、同文件系统：最后的 mv 才是原子替换
trap 'rm -f "$tar_in"; rm -rf "$staging"' EXIT
as_user mkdir -p "$(dirname "$dir")" || { echo "FAIL staging_parent $dir"; exit 1; }
as_user rm -rf "$staging"
as_user mkdir -p "$staging" || { echo "FAIL staging $staging"; exit 1; }
if ! as_user tar -xf - -C "$staging" <"$tar_in"; then
  echo "FAIL extract $dir"
  exit 1
fi
# The kit tar preserves the sender's working-copy modes: files packed from a
# macOS tree can land as 600 and dirs as 700, which leaves the shell entry
# points (attach.sh, start-pi.sh, device.sh) without an exec bit. Normalize
# the staged tree before anything runs from it: dirs 755, shell scripts and
# already-executable files 755, plain files 644. node_modules is not touched:
# it does not exist yet (npm ci runs below) and keeps the modes npm gives it.
as_user find "$staging" -type d -exec chmod 755 {} + || { echo "FAIL perms $staging"; exit 1; }
as_user find "$staging" -type f -name '*.sh' -exec chmod 755 {} + || { echo "FAIL perms $staging"; exit 1; }
as_user find "$staging" -type f ! -name '*.sh' -perm /111 -exec chmod 755 {} + || { echo "FAIL perms $staging"; exit 1; }
as_user find "$staging" -type f ! -name '*.sh' ! -perm /111 -exec chmod 644 {} + || { echo "FAIL perms $staging"; exit 1; }
echo "OK perms_normalized"
echo "OK staged $staging"
# .env 不在压缩包里：从旧目录复制进暂存目录，切换后路径不变；失败时旧目录和旧 .env 都没动
if [ -f "$dir/.env" ]; then
  as_user cp -p "$dir/.env" "$staging/.env" || { echo "FAIL env_copy $dir/.env"; exit 1; }
  as_user chmod 600 "$staging/.env" || { echo "FAIL env_chmod $staging/.env"; exit 1; }
  echo "OK env_kept"
else
  echo "OK env_absent"
fi
if ! command -v npm >/dev/null 2>&1; then echo "FAIL no_npm"; exit 1; fi
if ! (cd "$staging" && as_user npm ci --omit=dev --no-audit --no-fund --loglevel=error --registry=https://registry.npmmirror.com >/dev/null); then
  echo "FAIL npm_ci $dir"
  exit 1
fi
echo "OK deps"
# 原子切换：旧目录先留成 <dir>.prev（再上一版 .prev.1），暂存目录改名成正式目录
rm -rf "$dir.prev.1"
if [ -d "$dir.prev" ]; then mv "$dir.prev" "$dir.prev.1" || { echo "FAIL rotate_prev $dir.prev"; exit 1; }; fi
if [ -d "$dir" ]; then
  mv "$dir" "$dir.prev" || { echo "FAIL swap_old $dir"; exit 1; }
fi
if ! mv "$staging" "$dir"; then
  echo "FAIL swap_new $dir"
  # 换版失败：把刚挪走的旧版放回去
  if [ -d "$dir.prev" ] && [ ! -e "$dir" ]; then
    mv "$dir.prev" "$dir" && echo "OK swap_restored"
  fi
  exit 1
fi
echo "OK swapped $dir"
# 扩展同步是最后一步副作用：失败时把旧套件换回来，并重新同步旧扩展
if ! as_user bash "$dir/deploy/sync-extension.sh" >/dev/null; then
  echo "FAIL extension_sync"
  if [ -d "$dir.prev" ]; then
    rm -rf "$dir.failed"
    mv "$dir" "$dir.failed" || { echo "FAIL rollback_new $dir"; exit 1; }
    mv "$dir.prev" "$dir" || { echo "FAIL rollback_old $dir"; exit 1; }
    if [ -d "$dir.prev.1" ]; then mv "$dir.prev.1" "$dir.prev"; fi
    as_user bash "$dir/deploy/sync-extension.sh" >/dev/null || echo "WARN extension_resync_old"
    echo "OK restored $dir"
  else
    echo "WARN no_prev_to_restore"
  fi
  exit 1
fi
echo "OK extension_synced"
echo "DOCTOR_BEGIN"
(cd "$dir" && as_user node "$dir/deploy/linux/device.cjs" doctor) || true
echo "DOCTOR_END"
echo "OK done $want $dir"
PUSH_BODY
printf '%s\n' "$PUSH_BODY" | tr -d '\r' >"$sh_file"

step "==> 3/3 以设备用户身份在暂存目录解包、装依赖、原子切换、同步扩展、体检"
set +e
remote_out=$(ssh "${ssh_opts[@]}" "$server" "bash -s -- '$user' '$dir' '$allow_root'" <"$sh_file")
remote_exit=$?
set -e

done_user=""
done_dir=""
in_doctor=0
while IFS= read -r line; do
  if [ "$in_doctor" = 1 ]; then
    if [ "$line" = DOCTOR_END ]; then in_doctor=0; else echo "    $line"; fi
    continue
  fi
  case "$line" in
    "") ;;
    DOCTOR_BEGIN) echo "  体检（device.sh doctor）：" && in_doctor=1 ;;
    "OK staged "*) green "  暂存目录已解包：${line#OK staged }（旧版未动）" ;;
    "OK perms_normalized") green "  权限已归一化：目录 755、脚本与可执行文件 755、普通文件 644" ;;
    "OK env_kept") green "  .env 保留，权限收紧到 600" ;;
    "OK env_absent") yellow "  还没有 .env（下面的下一步会生成）" ;;
    "OK deps") green "  依赖已装（npm ci --omit=dev，暂存目录内）" ;;
    "OK swapped "*) green "  已原子切换：${line#OK swapped }；上一版保留为 <目录>.prev/" ;;
    "OK restored "*) yellow "  扩展同步失败，已恢复上一版：${line#OK restored }（新版留在 <目录>.failed/）" ;;
    "OK swap_restored") yellow "  换版失败，旧版已放回原目录" ;;
    "OK extension_synced") green "  扩展已同步到设备用户的 ~/.pi/agent/extensions" ;;
    "OK done "*)
      rest=${line#OK done }
      done_user=${rest%% *}
      done_dir=${rest#* }
      ;;
    "FAIL root_user") red "  设备用户是 root：不把 pi 跑在 root 下（确实要用加 --allow-root）" ;;
    "FAIL no_user "*) red "  服务器上没有用户 ${line#FAIL no_user }：先建一个（sudo adduser --disabled-password --gecos '' ${line#FAIL no_user }）" ;;
    "FAIL need_root "*) red "  以 ${line#FAIL need_root } 登录不能替别的用户安装：用 root@主机 加 --user，或直接以设备用户登录" ;;
    "FAIL dir_symlink "*) red "  目标目录是符号链接，不顺着写：${line#FAIL dir_symlink }" ;;
    "FAIL staging "* | "FAIL staging_parent "*) red "  建不了暂存目录：${line#FAIL }（旧版未动）" ;;
    "FAIL extract "*) red "  解包失败：${line#FAIL extract }（旧版未动，暂存目录已清理）" ;;
    "FAIL perms "*) red "  权限归一化失败：${line#FAIL perms }（旧版未动）" ;;
    "FAIL env_copy "* | "FAIL env_chmod "*) red "  .env 复制/收紧失败：${line}（旧版未动）" ;;
    "FAIL no_npm") red "  服务器上找不到 npm（装 node 见 deploy/README.md 第 3 节）" ;;
    "FAIL npm_ci "*) red "  npm ci 失败：在服务器上 cd ${line#FAIL npm_ci } && npm ci --omit=dev 看详情（旧版未动）" ;;
    "FAIL swap_old "* | "FAIL swap_new "* | "FAIL rotate_prev "*) red "  换版失败：${line}（旧版仍在 <目录>.prev/ 或原目录）" ;;
    "FAIL extension_sync") red "  扩展同步失败；上面的 OK restored / WARN 行说明旧版是否已恢复" ;;
    "WARN no_prev_to_restore") yellow "  警告：首次安装没有旧版可回滚；新版已切换但扩展同步失败" ;;
    "WARN extension_resync_old") yellow "  警告：恢复旧版后重新同步旧扩展失败，请手动跑一次 sync-extension.sh" ;;
    FAIL*) red "  $line" ;;
    *) echo "  $line" ;;
  esac
done <<<"$remote_out"
[ "$remote_exit" -eq 0 ] || die "服务器端失败（看上面的红字）。旧版目录与 .env 未被半成品覆盖。"

d=$done_dir
green "DONE. 套件在 ${server} 的 ${d}（用户 ${done_user}）。"
echo "下一步（在服务器上以 $done_user 身份，第一次才需要前两步）："
echo "  装 pi：    npm i -g --prefix ~/.local @earendil-works/pi-coding-agent --registry=https://registry.npmmirror.com"
echo "  配模型：   tmux 里跑一次 ~/.local/bin/pi，按提示登录或配置模型，再退出"
echo "  生成 .env：$d/deploy/linux/device.sh init --projects <允许网页新建会话的目录>"
echo "  配对：     网页「设备」→「添加设备」，$d/deploy/linux/device.sh pair XXXX-XXXX"
echo "  开窗口：   $d/deploy/linux/device.sh up"
