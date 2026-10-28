#!/usr/bin/env bash
# deploy-relay.sh —— 部署 relay 到云服务器并重启 systemd 服务（macOS / Linux；Windows 用 deploy-relay.ps1）
# 用法：
#   deploy/deploy-relay.sh --server root@<你的服务器IP>
#   deploy/deploy-relay.sh --server <~/.ssh/config 里的主机别名>
#   deploy/deploy-relay.sh --server root@<你的服务器IP> --rollback
# 与 deploy-relay.ps1 做同样的事；除 RESTART 段外服务器脚本逐字相同（test/deploy-scripts.test.js 校验）：
# 上传 relay/ 下全部 .js 模块与 protocol.json 到 relay.new/，顶替时把 relay/ 里其余文件（config.json 等）一并带过去。
# 顶替前的整份 relay/ 先留在 relay.cur/；重启 + 回环验证都通过后才轮转成 relay.prev/（再上一版 relay.prev.1/）。
# 失败的部署不会冲掉备份：重启、权限归一化或回环验证失败会自动回滚到 relay.cur/ 并重启；--rollback 优先还原 relay.cur/（本次没确认成功），否则还原 relay.prev/。
# 每次同步 deploy/pi-remote.service（里面没有 token），并确保 data/accounts 存在且不被删除。
# 不写 /etc/pi-remote.env，不打印 token。不设置 PI_REMOTE_PERSIST_TRANSCRIPTS（默认停写对话正文）。
# 占位默认值不会发起连接；服务器主单元里若已有 token 赋值，在备份和上传之前停止，不打印原值。
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/.." && pwd)
app=/opt/pi-remote/app
remote=$app/relay
# 上传 relay/ 下全部 .js 模块与 protocol.json（协议常量，由 protocol/sync.cjs 生成）；服务器上的 config.json 等本地配置不动
required=(server.js store.js index.js protocol.json)
files=()
ssh_opts=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$here/known_hosts")

server="root@<你的服务器IP>"
rollback=0
while [ $# -gt 0 ]; do
  case "$1" in
    --server | -Server)
      server=${2:-}
      shift 2 || { echo "--server 需要一个值" >&2; exit 2; }
      ;;
    --server=*) server=${1#--server=}; shift ;;
    --rollback | -Rollback) rollback=1; shift ;;
    -h | --help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
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

assert_server_arg() {
  case "$server" in
    *"<"* | *">"* | *你的服务器IP*) die "请把 --server 换成实际的 root@主机 或 ssh 别名。脚本里的默认值只是占位，不会发起连接，也不含 token。" ;;
  esac
  if ! printf '%s' "$server" | grep -Eq '^([^@[:space:]]+@[^@[:space:]]+|[A-Za-z0-9._-]+)$'; then
    die "参数 --server 应为 root@主机（或 ~/.ssh/config 里的主机别名）。不要把 token 放进参数。"
  fi
}

# 与服务器端 prepBody 的检查保持同一宽度：Environment= 后面允许成对引号
assert_unit_safe() {
  if grep -Eq '^[[:space:]]*Environment[[:space:]]*=[[:space:]]*"?[^"]*PI_REMOTE_(LOCAL|VIEWER)_TOKEN[[:space:]]*=' "$1"; then
    die "拒绝上传：pi-remote.service 写了 token。token 只能放在服务器 /etc/pi-remote.env。"
  fi
  if grep -Eq '^[[:space:]]*(Environment[[:space:]]*=[[:space:]]*"?)?PI_REMOTE_PERSIST_TRANSCRIPTS[[:space:]]*=' "$1"; then
    die "拒绝上传：单元设置了 PI_REMOTE_PERSIST_TRANSCRIPTS。留空才是默认停写对话正文。"
  fi
}

md5_of() {
  if command -v md5sum >/dev/null 2>&1; then
    md5sum "$1" | cut -d' ' -f1
  else
    md5 -q "$1"
  fi
}

# 远端脚本走 ssh 的 stdin（LF、无 BOM）；只收 stdout，stderr 直接显示
remote_out=""
remote_exit=0
run_remote() {
  local tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/pi-deploy-relay.XXXXXX")
  printf '%s\n' "$1" | tr -d '\r' >"$tmp"
  set +e
  remote_out=$(ssh "${ssh_opts[@]}" "$server" 'bash -s' <"$tmp")
  remote_exit=$?
  set -e
  rm -f "$tmp"
}

report_line() {
  local text=$1
  case "$text" in
    "OK relay_prev_ready") green "  部署已确认：上一版 relay/ 轮转到 relay.prev/（供 --rollback）" ;;
    "OK relay_cur_kept") green "  顶替前的 relay/ 整份留在 relay.cur/（部署确认成功后才轮转成 relay.prev/）" ;;
    "OK relay_failed_discarded") yellow "  上次部署没确认成功：保留 relay.cur/ 不动，未确认的 relay/ 移到 relay.failed/" ;;
    "OK carried "*) green "  带到新 relay/：${text#OK carried }" ;;
    "OK rollback_from "*) green "  从 ${text#OK rollback_from }/ 整份还原 relay/（含 config.json）" ;;
    "OK code_owned_by_root") green "  代码目录归 root、服务用户只能写 data/ 与 logs/；config.json 为 root:pi-remote 640" ;;
    "OK data_accounts_kept") green "  data/accounts 保留（索引目录，本脚本不删除）" ;;
    "OK persist_transcripts_unset") green "  未设置 PI_REMOTE_PERSIST_TRANSCRIPTS（默认停写对话正文）" ;;
    "WARN persist_transcripts_is_set") yellow "  警告：环境里设置了 PI_REMOTE_PERSIST_TRANSCRIPTS，data/rooms 会继续写对话正文。本期默认不要设置它。" ;;
    "WARN legacy_dropin_present") yellow "  警告：仍有 systemd drop-in override.conf。里面的 Environment= 会盖过 /etc/pi-remote.env。token 只留 env 文件一处。脚本不打印、不删除该文件。" ;;
    "WARN missing_env_file") yellow "  警告：没有 /etc/pi-remote.env。请按 deploy/README.md 在服务器上创建并 chmod 600。不要把 token 写入仓库。" ;;
    "OK env_mode_600") green "  /etc/pi-remote.env 权限 600" ;;
    "WARN env_mode="*) yellow "  警告：/etc/pi-remote.env 权限是 ${text#WARN env_mode=}，应为 600" ;;
    "OK env_token_names_present") green "  /etc/pi-remote.env 含 local 与 viewer 两个 token 变量（值未打印）" ;;
    "OK dropin_token_names_present") yellow "  drop-in 里有两个 token 变量（值未打印）。建议迁到 /etc/pi-remote.env 后删掉 drop-in。" ;;
    "OK config_json_token_names_present") yellow "  relay/config.json 里有 token 字段（值未打印）。建议改到 /etc/pi-remote.env，配置文件不要入库。" ;;
    "WARN token_not_found") yellow "  警告：env 文件、drop-in、relay/config.json 都没找到两个 token 变量。服务会落到代码占位符。脚本不会写入 token。" ;;
    "OK restored_index_js") green "  已从 relay.prev/ 恢复 index.js" ;;
    "OK removed_index_js") green "  上一版没有 index.js，已从 relay/ 移除" ;;
    active) green "  服务状态 active" ;;
    inactive | failed | activating | deactivating | reloading) red "  服务状态 $text" ;;
    "HTTP_CODE="*) echo "  7002 回环 HTTP ${text#HTTP_CODE=}" ;;
    "OK healthz_proto="*) green "  /healthz 报协议 v${text#OK healthz_proto=}：新版 relay 在跑" ;;
    "FAIL healthz_proto_not_"*) red "  7002 有回应，但 /healthz 报的不是这次带上去的协议 v${text#FAIL healthz_proto_not_}（还是旧版 relay 在跑）" ;;
    "FAIL unit_contains_token") red "  拒绝覆盖：服务器主单元里有 token 赋值。已停止，没有上传或改数据目录。请先把 token 写入 /etc/pi-remote.env，再从主单元删掉这些行。脚本不会打印原值。" ;;
    "FAIL data_symlink") red "  data、data/accounts 或 data/rooms 是符号链接。已停止，没有删除这些目录。" ;;
    "FAIL "*) red "  $text" ;;
    *)
      if printf '%s' "$text" | grep -Eq 'PI_REMOTE_(LOCAL|VIEWER)_TOKEN[[:space:]]*=|"(local|viewer)Token"[[:space:]]*:'; then
        yellow "  [已隐藏一行可能含 token 的输出]"
      else
        echo "  $text"
      fi
      ;;
  esac
}

report_lines() {
  local line text
  while IFS= read -r line; do
    text=$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    [ -n "$text" ] || continue
    report_line "$text"
  done <<<"$remote_out"
}

report() {
  report_lines
  if [ "$remote_exit" -ne 0 ]; then die "$1"; fi
}

loopback_code() {
  printf '%s\n' "$remote_out" | sed -n 's/^[[:space:]]*HTTP_CODE=//p' | tail -1 | tr -d '[:space:]'
}

# 部署失败（权限归一化、重启、回环验证任一步）时自动回到 relay.cur/，再确认服务真的起来。
# 回滚后不要求“新协议版本”：旧版本来就不认识新协议，只要求 7002 回 200。
auto_rollback() {
  local why=$1 code
  red "部署未通过：$why"
  yellow "==> 自动回滚到部署前版本（relay.cur/；data/、data/accounts、data/rooms 与 token 都不动）"
  run_remote "$ROLLBACK_BODY"
  report_lines
  if [ "$remote_exit" -ne 0 ]; then
    red "自动回滚失败。立即手动执行：deploy/deploy-relay.sh --server $server --rollback"
    red "（看上面的 FAIL 行，或 ssh 上去 journalctl -u pi-remote.service）"
    exit 1
  fi
  step "==> 回滚后回环验证（只要求 200，不要求新协议版本）"
  run_remote "$VERIFY_BODY"
  report_lines
  code=$(loopback_code)
  if [ "$remote_exit" -ne 0 ] || [ "$code" != "200" ]; then
    red "回滚后 7002 仍未返回 200（${code:-无响应}）。服务可能未恢复，立即手动检查："
    red "  ssh $server 'systemctl status pi-remote.service --no-pager; journalctl -u pi-remote.service -n 80 --no-pager'"
    red "  再试：deploy/deploy-relay.sh --server $server --rollback"
    exit 1
  fi
  green "已自动回滚到部署前版本并重启；新版没有上线。"
  echo "  失败原因：$why"
  echo "  手动回滚命令仍可用：deploy/deploy-relay.sh --server $server --rollback"
  exit 1
}

assert_loopback_200() {
  report "${1:-7002 未返回 200、协议版本不对，或 data/accounts 不存在}"
  local code
  code=$(loopback_code)
  [ "$code" = "200" ] || die "7002 未返回 200（$code）"
}

viewer_host() {
  case "$server" in
    *@*) printf '%s' "${server#*@}" ;;
    *) ssh -G "$server" 2>/dev/null | awk '$1 == "hostname" { print $2; exit }' ;;
  esac
}

# 服务器上执行的脚本：与 deploy-relay.ps1 里的 $xxxBody 逐字相同，改一边必须同步另一边
IFS= read -r -d '' PREP_BODY <<'PREP_BODY' || true
set -eu
cd /opt/pi-remote/app
if [ -L data ] || [ -L data/accounts ] || [ -L data/rooms ]; then
  echo "FAIL data_symlink"
  exit 1
fi
unit=/etc/systemd/system/pi-remote.service
if [ -f "$unit" ] && grep -Eq '^[[:space:]]*Environment=.*PI_REMOTE_(LOCAL|VIEWER)_TOKEN=.+' "$unit"; then
  echo "FAIL unit_contains_token"
  exit 1
fi
mkdir -p data/accounts
# 上次中断留下的 relay.new 先清掉，避免把残留文件一起顶替上去
rm -rf relay.new relay.new.tmp
mkdir -p relay.new
# 新代码先落 relay.new：MD5 校验通过后才顶替 relay/。
# relay.prev/ 只在部署确认成功（重启 + 回环 200）之后才轮转，失败重跑不会把备份冲掉。
echo "OK staging_ready"
echo "OK data_accounts_kept"
PREP_BODY

IFS= read -r -d '' RESTART_BODY <<'RESTART_BODY' || true
set -u
app=${PI_REMOTE_APP_DIR:-/opt/pi-remote/app}
envfile=${PI_REMOTE_ENV_FILE:-/etc/pi-remote.env}
dropin=${PI_REMOTE_DROPIN_FILE:-/etc/systemd/system/pi-remote.service.d/override.conf}
unit=${PI_REMOTE_UNIT_FILE:-/etc/systemd/system/pi-remote.service}
cfg=$app/relay/config.json
persist=0
if [ -f "$envfile" ] && grep -Eq '^[[:space:]]*PI_REMOTE_PERSIST_TRANSCRIPTS=[^[:space:]#]+' "$envfile"; then
  persist=1
fi
if [ -f "$dropin" ] && grep -Eq '^[[:space:]]*Environment=.*PI_REMOTE_PERSIST_TRANSCRIPTS=[^[:space:]#]+' "$dropin"; then
  persist=1
fi
if [ "$persist" -eq 1 ]; then
  echo "WARN persist_transcripts_is_set"
else
  echo "OK persist_transcripts_unset"
fi
if [ -f "$dropin" ]; then
  echo "WARN legacy_dropin_present"
fi
if [ -f "$envfile" ]; then
  # 权限是安全边界：失败必须退出，不能吞掉失败后照样报 OK（过去两次事故的同类问题）
  chmod 600 "$envfile" || { echo "FAIL perms_env_mode $envfile"; exit 1; }
  mode=$(stat -c %a "$envfile" || echo unknown)
  if [ "$mode" = "600" ]; then
    echo "OK env_mode_600"
  else
    echo "WARN env_mode=$mode"
  fi
else
  echo "WARN missing_env_file"
fi
token_ok=0
if [ -f "$envfile" ] && grep -Eq '^[[:space:]]*PI_REMOTE_LOCAL_TOKEN=.+' "$envfile" && grep -Eq '^[[:space:]]*PI_REMOTE_VIEWER_TOKEN=.+' "$envfile"; then
  token_ok=1
  echo "OK env_token_names_present"
fi
if [ "$token_ok" -eq 0 ] && [ -f "$dropin" ] && grep -Eq '^[[:space:]]*Environment=.*PI_REMOTE_LOCAL_TOKEN=.+' "$dropin" && grep -Eq '^[[:space:]]*Environment=.*PI_REMOTE_VIEWER_TOKEN=.+' "$dropin"; then
  token_ok=1
  echo "OK dropin_token_names_present"
fi
if [ "$token_ok" -eq 0 ] && [ -f "$cfg" ] && grep -Eq '"localToken"[[:space:]]*:[[:space:]]*"[^"]+"' "$cfg" && grep -Eq '"viewerToken"[[:space:]]*:[[:space:]]*"[^"]+"' "$cfg"; then
  token_ok=1
  echo "OK config_json_token_names_present"
fi
if [ "$token_ok" -eq 0 ]; then
  echo "WARN token_not_found"
fi
chmod 644 "$unit" || { echo "FAIL perms_unit_mode $unit"; exit 1; }
if ! id pi-remote >/dev/null 2>&1; then
  useradd --system --home "$app" --shell /usr/sbin/nologin pi-remote || { echo "FAIL useradd_pi_remote"; exit 1; }
fi
mkdir -p "$app/data/accounts" "$app/data/rooms" "$app/logs" || { echo "FAIL mkdir_data $app"; exit 1; }
# 代码归 root、只有数据与日志给服务用户：relay 被攻破后不能改写自己的代码来持久化。
# 递归处理 app 下除 data/、logs/ 以外的全部内容（relay/、relay.*、node_modules/、package.json …），
# chown -R 不跟随符号链接。任何一步失败立即报错退出，不打印 OK code_owned_by_root。
chown root:root "$app" || { echo "FAIL perms_app_owner $app"; exit 1; }
chmod 755 "$app" || { echo "FAIL perms_app_mode $app"; exit 1; }
find "$app" -mindepth 1 -maxdepth 1 ! -name data ! -name logs -exec chown -R root:root {} + || { echo "FAIL perms_tree_owner $app"; exit 1; }
find "$app" -mindepth 1 -maxdepth 1 ! -name data ! -name logs -exec chmod -R go-w {} + || { echo "FAIL perms_tree_mode $app"; exit 1; }
chown -R pi-remote:pi-remote "$app/data" "$app/logs" || { echo "FAIL perms_data_owner $app/data $app/logs"; exit 1; }
# 索引含设备名/项目路径/会话标题：旧文件补一次收紧（新文件由 systemd UMask=0077 兜底）
chmod -R go-rwx "$app/data" "$app/logs" || { echo "FAIL perms_data_mode $app/data $app/logs"; exit 1; }
# config.json 归 root、组 pi-remote 只读：600 root 会让服务读不到它
if [ -f "$cfg" ]; then
  chown root:pi-remote "$cfg" || { echo "FAIL perms_config_owner $cfg"; exit 1; }
  chmod 640 "$cfg" || { echo "FAIL perms_config_mode $cfg"; exit 1; }
fi
echo "OK code_owned_by_root"
echo "OK service_user"
set -e
systemctl daemon-reload
systemctl restart pi-remote.service
sleep 1
systemctl is-active pi-remote.service
RESTART_BODY

IFS= read -r -d '' PROMOTE_BODY <<'PROMOTE_BODY' || true
set -eu
cd /opt/pi-remote/app
# 先确认暂存目录在，再动 relay/：缺了就什么都不改
if [ ! -d relay.new ]; then
  echo "FAIL relay_new_missing"
  exit 1
fi
# relay/ 里部署不管的文件（config.json 等）带到新目录，否则顶替后服务读不到 token 配置
if [ -d relay ]; then
  for f in relay/* relay/.[!.]*; do
    [ -e "$f" ] || continue
    b=$(basename "$f")
    case "$b" in *.js|protocol.json) continue ;; esac
    if [ ! -e "relay.new/$b" ]; then
      cp -a "$f" "relay.new/$b"
      echo "OK carried $b"
    fi
  done
fi
if [ -d relay.cur ]; then
  # 上次部署没确认成功：relay.cur 仍是最后一版确认能跑的，当前 relay/ 不当备份
  rm -rf relay.failed
  if [ -d relay ]; then mv relay relay.failed; fi
  echo "OK relay_failed_discarded"
else
  if [ -d relay ]; then
    mv relay relay.cur
    echo "OK relay_cur_kept"
  fi
fi
mv relay.new relay
echo "OK promoted"
PROMOTE_BODY

IFS= read -r -d '' FINALIZE_BODY <<'FINALIZE_BODY' || true
set -eu
cd /opt/pi-remote/app
if [ -d relay.cur ]; then
  rm -rf relay.prev.1
  if [ -d relay.prev ]; then mv relay.prev relay.prev.1; fi
  mv relay.cur relay.prev
  echo "OK relay_prev_ready"
fi
rm -rf relay.failed
FINALIZE_BODY

IFS= read -r -d '' VERIFY_BODY <<'VERIFY_BODY' || true
set -u
want="${want_proto:-}"
code=000
health=""
i=0
while [ "$i" -lt 5 ]; do
  # 旧版 relay 没有 /healthz，会把首页当 200 回来：认正文，不认状态码
  health=$(curl -s --max-time 3 http://127.0.0.1:7002/healthz || true)
  case "$health" in
    *'"ok":true'*) code=200 ;;
    *) code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:7002/ || true) ;;
  esac
  if [ "$code" = "200" ]; then
    break
  fi
  i=$((i + 1))
  sleep 1
done
echo "HTTP_CODE=$code"
if [ "$code" != "200" ]; then
  exit 1
fi
if [ -n "$want" ]; then
  case "$health" in
    *"\"proto\":$want,"* | *"\"proto\":$want}"*) echo "OK healthz_proto=$want" ;;
    *)
      echo "FAIL healthz_proto_not_$want"
      exit 1
      ;;
  esac
fi
if [ ! -d /opt/pi-remote/app/data/accounts ]; then
  echo "FAIL data_accounts_missing"
  exit 1
fi
if [ ! -d /opt/pi-remote/app/data/rooms ] && [ -e /opt/pi-remote/app/data/rooms ]; then
  echo "FAIL data_rooms_not_dir"
  exit 1
fi
echo "OK data_accounts_kept"
VERIFY_BODY

IFS= read -r -d '' ROLLBACK_BODY <<'ROLLBACK_BODY' || true
set -eu
cd /opt/pi-remote/app
if [ -L data ] || [ -L data/accounts ] || [ -L data/rooms ]; then
  echo "FAIL data_symlink"
  exit 1
fi
mkdir -p data/accounts
# 本次部署没确认成功时 relay.cur 是部署前那版；否则回到 relay.prev
src=relay.prev
if [ -d relay.cur ]; then src=relay.cur; fi
if [ ! -f "$src/server.js" ] || [ ! -f "$src/store.js" ]; then
  echo "FAIL relay_prev_missing"
  exit 1
fi
rm -rf relay.restore
cp -a "$src" relay.restore
# 旧脚本留下的 relay.prev 只有 3 个 js：当前 relay/ 里有、备份里没有的文件（config.json 等）补回去
if [ -d relay ]; then
  for f in relay/* relay/.[!.]*; do
    [ -e "$f" ] || continue
    b=$(basename "$f")
    case "$b" in *.js|protocol.json) continue ;; esac
    if [ ! -e "relay.restore/$b" ]; then cp -a "$f" "relay.restore/$b"; echo "OK carried $b"; fi
  done
fi
if [ -f relay.restore/index.js ]; then
  echo "OK restored_index_js"
else
  echo "OK removed_index_js"
fi
rm -rf relay.failed
if [ -d relay ]; then mv relay relay.failed; fi
mv relay.restore relay
echo "OK rollback_from $src"
echo "OK data_accounts_kept"
if [ "$src" = "relay.cur" ]; then
  rm -rf relay.cur
elif [ -d relay.prev.1 ]; then
  rm -rf relay.prev
  mv relay.prev.1 relay.prev
  echo "OK prev_rotated"
fi
systemctl restart pi-remote.service
sleep 1
systemctl is-active pi-remote.service
ROLLBACK_BODY

if [ "$rollback" -eq 1 ]; then
  assert_server_arg
  step "==> 回滚 relay.cur/ 或 relay.prev/ -> relay/（含 config.json；不改 data/accounts、data/rooms、/etc/pi-remote.env）"
  run_remote "$ROLLBACK_BODY"
  report "回滚失败（看上面的 FAIL 行，或 journalctl -u pi-remote.service）"
  step "==> 回环验证"
  run_remote "$VERIFY_BODY"
  assert_loopback_200
  green "DONE. relay 代码已回滚并重启。索引与 token 都没动。"
  exit 0
fi

for f in "${required[@]}"; do
  [ -f "$root/relay/$f" ] || die "缺少 $root/relay/$f。部署必须带上 relay/ 的 server.js、store.js、index.js、protocol.json；缺文件时不会连接服务器。"
done
for p in "$root"/relay/*.js "$root"/relay/protocol.json; do
  [ -f "$p" ] || continue
  b=$(basename "$p")
  printf '%s' "$b" | grep -Eq '^[A-Za-z0-9._-]+$' || die "relay 文件名只能含字母、数字和 ._-：$b"
  [ -s "$p" ] || die "空文件: $p"
  files+=("$b")
done
# 部署后 /healthz 必须报这次带上去的协议版本；protocol.json 里没有 proto 时只看 200
want_proto=$(awk -F'[:,]' '/^[[:space:]]*"proto"[[:space:]]*:/ && !n { gsub(/[^0-9]/, "", $2); print $2; n = 1 }' "$root/relay/protocol.json")
assert_server_arg

# systemd 单元先校验再上传：token 泄漏/占位符这类问题必须在动服务器之前拦下
unit_src="$here/pi-remote.service"
assert_unit_safe "$unit_src"
unit_lf=$(mktemp "${TMPDIR:-/tmp}/pi-remote.service.XXXXXX")
trap 'rm -f "$unit_lf"' EXIT
tr -d '\r' <"$unit_src" >"$unit_lf"
[ -z "$(tail -c 1 "$unit_lf")" ] || printf '\n' >>"$unit_lf"

step "==> 1/4 上传 ${files[*]} 到 relay.new/"
run_remote "$PREP_BODY"
report "部署前检查失败（看上面的 FAIL 行）。未打印 token，也未删除 data/accounts 或 data/rooms。"
for f in "${files[@]}"; do
  scp -q "${ssh_opts[@]}" "$root/relay/$f" "$server:$remote.new/$f" || die "$f 上传失败"
done

step "==> 2/4 MD5 比对（本地 vs 服务器）"
# 在暂存目录里跑 md5sum：确认上传完整后才谈替换
remote_md5=$(ssh "${ssh_opts[@]}" "$server" "cd $remote.new && md5sum ${files[*]}") || die "服务器 md5sum 失败"
for f in "${files[@]}"; do
  want=$(md5_of "$root/relay/$f" | tr 'A-F' 'a-f')
  got=$(printf '%s\n' "$remote_md5" | awk -v f="$f" '$2 == f { print tolower($1) }')
  [ "$want" = "$got" ] || die "$f MD5 不一致: 本地 $want / 服务器 $got"
  green "  $f $want"
done

step "==> 3/4 顶替 relay/（部署前那版留 relay.cur/，确认成功后才轮转成 relay.prev/）并同步 systemd 单元重启"
run_remote "$PROMOTE_BODY"
report "顶替失败：relay/ 未被改动，可重跑部署"
scp -q "${ssh_opts[@]}" "$unit_lf" "$server:/etc/systemd/system/pi-remote.service" || die "systemd 单元上传失败"
run_remote "$RESTART_BODY"
report_lines
if [ "$remote_exit" -ne 0 ]; then
  auto_rollback "服务重启或权限归一化失败"
fi

step "==> 4/4 端口验证（服务器本机回环）"
run_remote "want_proto=$want_proto"$'\n'"$VERIFY_BODY"
report_lines
if [ "$remote_exit" -ne 0 ] || [ "$(loopback_code)" != "200" ]; then
  auto_rollback "端口验证失败：新版本没起来，或 /healthz 报的协议版本不是 v${want_proto:-?}"
fi
run_remote "$FINALIZE_BODY"
report "备份轮转失败（新版已在运行；relay.cur/ 仍保留部署前那版；可重跑部署或手动把 relay.cur/ 轮转成 relay.prev/）"
green "DONE. relay 已更新（${files[*]}）。"
echo "  viewer: http://$(viewer_host):7002/  （token 在服务器 /etc/pi-remote.env，不在本仓库）"
echo "  回滚代码：deploy/deploy-relay.sh --server $server --rollback"
echo "  回滚整份还原 relay/（含 config.json），不动 data/accounts、data/rooms 和 token。"
