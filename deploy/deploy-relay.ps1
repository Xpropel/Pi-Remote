# deploy-relay.ps1 —— 部署 relay 到云服务器并重启 systemd 服务
# 用法：
#   powershell -ExecutionPolicy Bypass -File deploy\deploy-relay.ps1 -Server "root@<你的服务器IP>"
#   powershell -ExecutionPolicy Bypass -File deploy\deploy-relay.ps1 -Server "root@<你的服务器IP>" -Rollback
# 与 deploy-relay.sh 做同样的事；服务器脚本逐字相同（test/deploy-scripts.test.js 校验）。
# 上传 relay/ 下全部 .js 模块与 protocol.json 到 relay.new/，顶替时把 relay/ 里其余文件（config.json 等）一并带过去。
# 顶替前的整份 relay/ 先留在 relay.cur/；重启 + 回环验证都通过后才轮转成 relay.prev/（再上一版 relay.prev.1/）。
# 失败的部署不会冲掉备份：重启、权限归一化或回环验证失败会自动回滚到 relay.cur/ 并重启，最终 exit 1。
# -Rollback 优先还原 relay.cur/（本次没确认成功），否则还原 relay.prev/。
# 每次同步 deploy/pi-remote.service（里面没有 token），并确保 data/accounts 存在且不被删除。
# 不写 /etc/pi-remote.env，不打印 token。不设置 PI_REMOTE_PERSIST_TRANSCRIPTS（默认停写对话正文）。
# 占位默认值不会发起连接；把 -Server 换成实际 root@主机 后再跑。
# 服务器主单元里若已有 token 赋值，在备份和上传之前停止，不打印原值。
param(
  [string]$Server = "root@<你的服务器IP>",
  [switch]$Rollback
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$server = $Server
$app = "/opt/pi-remote/app"
$remote = "$app/relay"
# 上传 relay/ 下全部 .js 模块与 protocol.json（协议常量，由 protocol/sync.cjs 生成）；服务器上的 config.json 等本地配置不动
$required = @("server.js", "store.js", "index.js", "protocol.json")

function Assert-ServerArg {
  if ([string]::IsNullOrWhiteSpace($server) -or $server -notmatch '^[^@\s]+@[^@\s]+$') {
    throw "参数 -Server 应为 root@主机。不要把 token 放进参数。"
  }
  if ($server -match '[<>]' -or $server -match '你的服务器IP') {
    throw "请把 -Server 换成实际的 root@主机。脚本里的默认值只是占位，不会发起连接，也不含 token。"
  }
}

function Assert-UnitSafe([string]$Text) {
  # 与服务器端 prepBody 的检查保持同一宽度：Environment= 后面允许成对引号（systemd 常见写法
  # Environment="PI_REMOTE_LOCAL_TOKEN=..."）。本地这关漏一种写法，第一次部署就会把 token
  # 写进 644 的单元文件——服务器侧要等第二次部署才发现。
  if ($Text -match '(?m)^\s*Environment\s*=\s*"?[^"\r\n]*PI_REMOTE_(LOCAL|VIEWER)_TOKEN\s*=') {
    throw "拒绝上传：pi-remote.service 写了 token。token 只能放在服务器 /etc/pi-remote.env。"
  }
  if ($Text -match '(?m)^\s*(Environment\s*=\s*"?)?PI_REMOTE_PERSIST_TRANSCRIPTS\s*=') {
    throw "拒绝上传：单元设置了 PI_REMOTE_PERSIST_TRANSCRIPTS。留空才是默认停写对话正文。"
  }
}

function Invoke-RemoteBash([string]$Body) {
  $normalized = $Body -replace "`r`n", "`n" -replace "`r", "`n"
  if (-not $normalized.EndsWith("`n")) { $normalized += "`n" }
  $sh = Join-Path $env:TEMP "pi-deploy-relay.sh"
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($sh, $normalized, $utf8)
  & scp -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$PSScriptRoot\known_hosts" $sh "${server}:/tmp/pi-deploy-relay.sh" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "上传远程脚本失败" }
  $output = & ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$PSScriptRoot\known_hosts" $server "bash /tmp/pi-deploy-relay.sh"
  [pscustomobject]@{ Exit = $LASTEXITCODE; Output = @($output) }
}

function Write-RemoteLines($Result) {
  foreach ($line in @($Result.Output)) {
    if ($null -eq $line) { continue }
    $text = "$line".Trim()
    if ($text -eq "") { continue }
    switch -Regex ($text) {
      '^OK relay_prev_ready$' { Write-Host "  部署已确认：上一版 relay/ 轮转到 relay.prev/（供 -Rollback）" -ForegroundColor Green }
      '^OK relay_cur_kept$' { Write-Host "  顶替前的 relay/ 整份留在 relay.cur/（部署确认成功后才轮转成 relay.prev/）" -ForegroundColor Green }
      '^OK relay_failed_discarded$' { Write-Host "  上次部署没确认成功：保留 relay.cur/ 不动，未确认的 relay/ 移到 relay.failed/" -ForegroundColor Yellow }
      '^OK carried (.+)$' { Write-Host "  带到新 relay/：$($Matches[1])" -ForegroundColor Green }
      '^OK rollback_from (.+)$' { Write-Host "  从 $($Matches[1])/ 整份还原 relay/（含 config.json）" -ForegroundColor Green }
      '^OK code_owned_by_root$' { Write-Host "  代码目录归 root、服务用户只能写 data/ 与 logs/；config.json 为 root:pi-remote 640" -ForegroundColor Green }
      '^OK data_accounts_kept$' { Write-Host "  data/accounts 保留（索引目录，本脚本不删除）" -ForegroundColor Green }
      '^OK persist_transcripts_unset$' { Write-Host "  未设置 PI_REMOTE_PERSIST_TRANSCRIPTS（默认停写对话正文）" -ForegroundColor Green }
      '^WARN persist_transcripts_is_set$' { Write-Host "  警告：环境里设置了 PI_REMOTE_PERSIST_TRANSCRIPTS，data/rooms 会继续写对话正文。本期默认不要设置它。" -ForegroundColor Yellow }
      '^WARN legacy_dropin_present$' { Write-Host "  警告：仍有 systemd drop-in override.conf。里面的 Environment= 会盖过 /etc/pi-remote.env。token 只留 env 文件一处。脚本不打印、不删除该文件。" -ForegroundColor Yellow }
      '^WARN missing_env_file$' { Write-Host "  警告：没有 /etc/pi-remote.env。请按 deploy/README.md 在服务器上创建并 chmod 600。不要把 token 写入仓库。" -ForegroundColor Yellow }
      '^OK env_mode_600$' { Write-Host "  /etc/pi-remote.env 权限 600" -ForegroundColor Green }
      '^WARN env_mode=(.+)$' { Write-Host "  警告：/etc/pi-remote.env 权限是 $($Matches[1])，应为 600" -ForegroundColor Yellow }
      '^OK env_token_names_present$' { Write-Host "  /etc/pi-remote.env 含 local 与 viewer 两个 token 变量（值未打印）" -ForegroundColor Green }
      '^OK dropin_token_names_present$' { Write-Host "  drop-in 里有两个 token 变量（值未打印）。建议迁到 /etc/pi-remote.env 后删掉 drop-in。" -ForegroundColor Yellow }
      '^OK config_json_token_names_present$' { Write-Host "  relay/config.json 里有 token 字段（值未打印）。建议改到 /etc/pi-remote.env，配置文件不要入库。" -ForegroundColor Yellow }
      '^WARN token_not_found$' { Write-Host "  警告：env 文件、drop-in、relay/config.json 都没找到两个 token 变量。服务会落到代码占位符。脚本不会写入 token。" -ForegroundColor Yellow }
      '^OK restored_index_js$' { Write-Host "  已从 relay.prev/ 恢复 index.js" -ForegroundColor Green }
      '^OK removed_index_js$' { Write-Host "  上一版没有 index.js，已从 relay/ 移除" -ForegroundColor Green }
      '^active$' { Write-Host "  服务状态 active" -ForegroundColor Green }
      '^(inactive|failed|activating|deactivating|reloading)$' { Write-Host "  服务状态 $text" -ForegroundColor Red }
      '^HTTP_CODE=(.*)$' { Write-Host "  7002 回环 HTTP $($Matches[1].Trim())" }
      '^OK healthz_proto=(.+)$' { Write-Host "  /healthz 报协议 v$($Matches[1])：新版 relay 在跑" -ForegroundColor Green }
      '^FAIL healthz_proto_not_(.+)$' { Write-Host "  7002 有回应，但 /healthz 报的不是这次带上去的协议 v$($Matches[1])（还是旧版 relay 在跑）" -ForegroundColor Red }
      '^FAIL unit_contains_token$' { Write-Host "  拒绝覆盖：服务器主单元里有 token 赋值。已停止，没有上传或改数据目录。请先把 token 写入 /etc/pi-remote.env，再从主单元删掉这些行。脚本不会打印原值。" -ForegroundColor Red }
      '^FAIL data_symlink$' { Write-Host "  data、data/accounts 或 data/rooms 是符号链接。已停止，没有删除这些目录。" -ForegroundColor Red }
      '^FAIL (?!unit_contains_token$|data_symlink$|healthz_proto_not_)' { Write-Host "  $text" -ForegroundColor Red }
      default {
        if ($text -match 'PI_REMOTE_(LOCAL|VIEWER)_TOKEN\s*=' -or $text -match '"(local|viewer)Token"\s*:') {
          Write-Host "  [已隐藏一行可能含 token 的输出]" -ForegroundColor Yellow
        } else {
          Write-Host "  $text"
        }
      }
    }
  }
}

function Write-RemoteReport($Result, [string]$FailMessage) {
  Write-RemoteLines $Result
  if ($Result.Exit -ne 0) { throw $FailMessage }
}

function Get-LoopbackCode($Result) {
  $code = ""
  foreach ($line in @($Result.Output)) {
    if ("$line".Trim() -match '^HTTP_CODE=(.*)$') { $code = $Matches[1].Trim() }
  }
  return $code
}

function Assert-Loopback200($Result) {
  Write-RemoteReport $Result "7002 未返回 200、协议版本不对，或 data/accounts 不存在"
  $code = Get-LoopbackCode $Result
  if ($code -ne "200") { throw "7002 未返回 200（$code）" }
}

$prepBody = @'
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
'@

$restartBody = @'
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
# Uploads can carry macOS working-copy modes (files 600, dirs 700) through scp,
# and the go-w pass above only strips write bits: a 600 file stays unreadable
# for the service user (EACCES crash-loop). Normalize explicitly: dirs 755,
# shell scripts and already-executable files 755, plain files 644.
# node_modules is excluded on purpose: it is installed on the server, and
# rewriting its modes once stripped the exec bits from its .bin shims.
# data/ and logs/ are pruned here (locked down by the steps below), and
# config.json is re-tightened to 640 by its dedicated step further down.
find "$app" -mindepth 1 \( -path "$app/data" -o -path "$app/logs" -o -name node_modules \) -prune -o -type d -exec chmod 755 {} + || { echo "FAIL perms_norm_dir $app"; exit 1; }
find "$app" -mindepth 1 \( -path "$app/data" -o -path "$app/logs" -o -name node_modules \) -prune -o -type f -name '*.sh' -exec chmod 755 {} + || { echo "FAIL perms_norm_script $app"; exit 1; }
find "$app" -mindepth 1 \( -path "$app/data" -o -path "$app/logs" -o -name node_modules \) -prune -o -type f ! -name '*.sh' -perm /111 -exec chmod 755 {} + || { echo "FAIL perms_norm_exec $app"; exit 1; }
find "$app" -mindepth 1 \( -path "$app/data" -o -path "$app/logs" -o -name node_modules \) -prune -o -type f ! -name '*.sh' ! -perm /111 -exec chmod 644 {} + || { echo "FAIL perms_norm_file $app"; exit 1; }
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
'@

$promoteBody = @'
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
'@

# 重启 + 回环验证都通过后才轮转备份：relay.cur -> relay.prev -> relay.prev.1
$finalizeBody = @'
set -eu
cd /opt/pi-remote/app
if [ -d relay.cur ]; then
  rm -rf relay.prev.1
  if [ -d relay.prev ]; then mv relay.prev relay.prev.1; fi
  mv relay.cur relay.prev
  echo "OK relay_prev_ready"
fi
rm -rf relay.failed
'@

$verifyBody = @'
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
'@

$rollbackBody = @'
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
'@

# 部署失败（权限归一化、重启、回环验证任一步）时自动回到 relay.cur/，再确认服务真的起来。
# 回滚后不要求“新协议版本”：旧版本来就不认识新协议，只要求 7002 回 200。
function Invoke-AutoRollback([string]$Why) {
  Write-Host "  部署未通过：$Why" -ForegroundColor Red
  Write-Host "==> 自动回滚到部署前版本（relay.cur/；data/、data/accounts、data/rooms 与 token 都不动）" -ForegroundColor Yellow
  $rollbackResult = Invoke-RemoteBash $rollbackBody
  Write-RemoteLines $rollbackResult
  if ($rollbackResult.Exit -ne 0) {
    Write-Host "  自动回滚失败。立即手动执行：powershell -ExecutionPolicy Bypass -File deploy\deploy-relay.ps1 -Server `"$server`" -Rollback" -ForegroundColor Red
    Write-Host "  （看上面的 FAIL 行，或 ssh 上去 journalctl -u pi-remote.service）" -ForegroundColor Red
    exit 1
  }
  Write-Host "==> 回滚后回环验证（只要求 200，不要求新协议版本）" -ForegroundColor Cyan
  $verifyResult = Invoke-RemoteBash $verifyBody
  Write-RemoteLines $verifyResult
  $code = Get-LoopbackCode $verifyResult
  if ($verifyResult.Exit -ne 0 -or $code -ne "200") {
    $codeLabel = if ($code) { $code } else { "无响应" }
    Write-Host "  回滚后 7002 仍未返回 200（$codeLabel）。服务可能未恢复，立即手动检查：" -ForegroundColor Red
    Write-Host "  ssh $server 'systemctl status pi-remote.service --no-pager; journalctl -u pi-remote.service -n 80 --no-pager'" -ForegroundColor Red
    Write-Host "  再试：powershell -ExecutionPolicy Bypass -File deploy\deploy-relay.ps1 -Server `"$server`" -Rollback" -ForegroundColor Red
    exit 1
  }
  Write-Host "已自动回滚到部署前版本并重启；新版没有上线。" -ForegroundColor Green
  Write-Host "  失败原因：$Why"
  Write-Host "  手动回滚命令仍可用：powershell -ExecutionPolicy Bypass -File deploy\deploy-relay.ps1 -Server `"$server`" -Rollback"
  exit 1
}

if ($Rollback) {
  Assert-ServerArg
  Write-Host "==> 回滚 relay.cur/ 或 relay.prev/ -> relay/（含 config.json；不改 data/accounts、data/rooms、/etc/pi-remote.env）" -ForegroundColor Cyan
  Write-RemoteReport (Invoke-RemoteBash $rollbackBody) "回滚失败（看上面的 FAIL 行，或 journalctl -u pi-remote.service）"
  Write-Host "==> 回环验证" -ForegroundColor Cyan
  Assert-Loopback200 (Invoke-RemoteBash $verifyBody)
  Write-Host "DONE. relay 代码已回滚并重启。索引与 token 都没动。" -ForegroundColor Green
  exit 0
}

foreach ($f in $required) {
  $path = Join-Path $root "relay\$f"
  if (-not (Test-Path -LiteralPath $path)) {
    throw "缺少 $path。部署必须带上 relay/ 的 server.js、store.js、index.js、protocol.json；缺文件时不会连接服务器。"
  }
}
$files = @(Get-ChildItem -LiteralPath (Join-Path $root "relay") -File | Where-Object { $_.Name -like "*.js" -or $_.Name -eq "protocol.json" } | ForEach-Object { $_.Name } | Sort-Object)
foreach ($f in $files) {
  if ($f -notmatch '^[A-Za-z0-9._-]+$') { throw "relay 文件名只能含字母、数字和 ._-：$f" }
  if ((Get-Item -LiteralPath (Join-Path $root "relay\$f")).Length -lt 1) { throw "空文件: relay\$f" }
}
# 部署后 /healthz 必须报这次带上去的协议版本；protocol.json 里没有 proto 时只看 200
$wantProto = "$(([System.IO.File]::ReadAllText((Join-Path $root 'relay\protocol.json')) | ConvertFrom-Json).proto)"
if ($wantProto -notmatch '^\d+$') { $wantProto = "" }
Assert-ServerArg

# systemd 单元先校验再上传：token 泄漏/占位符这类问题必须在动服务器之前拦下
$unitSrc = Join-Path $PSScriptRoot "pi-remote.service"
$unitRaw = [System.IO.File]::ReadAllText($unitSrc)
Assert-UnitSafe $unitRaw
$unitLf = $unitRaw -replace "`r`n", "`n" -replace "`r", "`n"
if (-not $unitLf.EndsWith("`n")) { $unitLf += "`n" }
$unitDst = Join-Path $env:TEMP "pi-remote.service"
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($unitDst, $unitLf, $utf8)

Write-Host "==> 1/4 上传 $($files -join ' ') 到 relay.new/" -ForegroundColor Cyan
Write-RemoteReport (Invoke-RemoteBash $prepBody) "部署前检查失败（看上面的 FAIL 行）。未打印 token，也未删除 data/accounts 或 data/rooms。"
foreach ($f in $files) {
  & scp -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$PSScriptRoot\known_hosts" (Join-Path $root "relay\$f") "${server}:${remote}.new/$f"
  if ($LASTEXITCODE -ne 0) { throw "$f 上传失败" }
}

Write-Host "==> 2/4 MD5 比对（本地 vs 服务器）" -ForegroundColor Cyan
$localHash = @{}
foreach ($f in $files) {
  $localHash[$f] = (Get-FileHash (Join-Path $root "relay\$f") -Algorithm MD5).Hash.ToLower()
}
# 在暂存目录里跑 md5sum：确认上传完整后才谈替换
$remoteOut = & ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$PSScriptRoot\known_hosts" $server "cd $remote.new && md5sum $($files -join ' ')"
if ($LASTEXITCODE -ne 0) { throw "服务器 md5sum 失败" }
$remoteText = @($remoteOut) -join "`n"
foreach ($f in $files) {
  $name = [regex]::Escape($f)
  $match = [regex]::Match($remoteText, "(?m)^([0-9a-fA-F]+)\s+$name\s*$")
  $remoteHash = $match.Groups[1].Value.ToLower()
  if ($localHash[$f] -ne $remoteHash) { throw "$f MD5 不一致: 本地 $($localHash[$f]) / 服务器 $remoteHash" }
  Write-Host "  $f $($localHash[$f])" -ForegroundColor Green
}

Write-Host "==> 3/4 顶替 relay/（部署前那版留 relay.cur/，确认成功后才轮转成 relay.prev/）并同步 systemd 单元重启" -ForegroundColor Cyan
Write-RemoteReport (Invoke-RemoteBash $promoteBody) "顶替失败：relay/ 未被改动，可重跑部署"
& scp -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$PSScriptRoot\known_hosts" $unitDst "${server}:/etc/systemd/system/pi-remote.service"
if ($LASTEXITCODE -ne 0) { throw "systemd 单元上传失败" }
# 权限归一化或重启失败不能把坏版本留在线上：与 .sh 一样自动回滚，最终 exit 1。
$restartResult = Invoke-RemoteBash $restartBody
Write-RemoteLines $restartResult
if ($restartResult.Exit -ne 0) {
  Invoke-AutoRollback "服务重启或权限归一化失败"
}

Write-Host "==> 4/4 端口验证（服务器本机回环）" -ForegroundColor Cyan
$verifyResult = Invoke-RemoteBash ("want_proto=$wantProto`n" + $verifyBody)
Write-RemoteLines $verifyResult
$verifyCode = Get-LoopbackCode $verifyResult
if ($verifyResult.Exit -ne 0 -or $verifyCode -ne "200") {
  $protoLabel = if ($wantProto) { $wantProto } else { "?" }
  Invoke-AutoRollback "端口验证失败：新版本没起来，或 /healthz 报的协议版本不是 v$protoLabel"
}
Write-RemoteReport (Invoke-RemoteBash $finalizeBody) "备份轮转失败（新版已在运行；relay.cur/ 仍保留部署前那版）"
$viewerHost = $server -replace '^.*@', ''
Write-Host "DONE. relay 已更新（$($files -join '、')）。" -ForegroundColor Green
Write-Host "  viewer: http://${viewerHost}:7002/  （token 在服务器 /etc/pi-remote.env，不在本仓库）"
Write-Host "  回滚代码：powershell -ExecutionPolicy Bypass -File deploy\deploy-relay.ps1 -Server `"$server`" -Rollback"
Write-Host "  回滚整份还原 relay/（含 config.json），不动 data/accounts、data/rooms 和 token。"
