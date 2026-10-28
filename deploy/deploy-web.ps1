# deploy-web.ps1 —— 构建前端并部署到服务器（由中继同口托管）
# 用法： powershell -ExecutionPolicy Bypass -File deploy\deploy-web.ps1 [-Server root@<你的服务器IP>] [-ViewerBase http://<你的服务器IP>:7002]
# 只替换 web/（首次把旧站挪到 web-legacy-backup）。不删除 data/accounts 与 data/rooms，不写 token。
# 部署前把当前 web/ 快照到 web.prev/：解压、权限或验证任一步失败会自动还原并退出非零；成功也保留 web.prev/ 供手动回滚。
# 服务器上执行的脚本与 deploy-web.sh 的 SNAPSHOT/RESTORE/PERMS/WEB body 逐字相同（test/deploy-scripts.test.js 校验）。
# -Server 仍是占位符时，在构建和任何连接之前停止。
# -ViewerBase 仍是占位符时，改用 http://<Server 主机>:7002，不会去连占位主机。
param([string]$Server = "root@<你的服务器IP>", [string]$ViewerBase = "http://<你的服务器IP>:7002")
$ErrorActionPreference = "Stop"
$sshTarget = $Server
$root = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($sshTarget) -or $sshTarget -notmatch '^[^@\s]+@[^@\s]+$' -or $sshTarget -match '[<>]' -or $sshTarget -match '你的服务器IP') {
  throw "请把 -Server 换成实际的 root@主机。占位默认值不会发起连接，也不含 token。"
}
if ([string]::IsNullOrWhiteSpace($ViewerBase) -or $ViewerBase -match '[<>]' -or $ViewerBase -match '你的服务器IP') {
  $viewerHost = $sshTarget -replace '^.*@', ''
  $ViewerBase = "http://${viewerHost}:7002"
}
if ($ViewerBase -notmatch '^https?://\S+$' -or $ViewerBase -match 'token=') {
  throw "-ViewerBase 应为 http://主机:7002。不要把 token 放进参数。"
}
$ViewerBase = $ViewerBase -replace '/$', ''

Set-Location $root

Write-Host "==> 1/4 构建前端 (ui -> web)" -ForegroundColor Cyan
Push-Location ui
try {
  & cmd /c "npm run build"
  if ($LASTEXITCODE -ne 0) { throw "前端构建失败" }
} finally {
  # 构建抛错也要把目录弹回去，否则后面的相对路径全歪
  Pop-Location
}
# 冒烟验证页随站点一起部署：它要读 relay 的响应状态，只能同源打开（file:// 下浏览器拦截跨源读取）
Copy-Item (Join-Path $PSScriptRoot "verify.html") (Join-Path $root "web\verify.html") -Force

foreach ($rel in @("web\index.html", "web\favicon.svg", "web\verify.html")) {
  $built = Join-Path $root $rel
  if (-not (Test-Path -LiteralPath $built)) { throw "构建结果缺少 $rel。已停止，不会上传。" }
}

Write-Host "==> 2/4 打包 web/" -ForegroundColor Cyan
$tar = Join-Path $env:TEMP "pi-web-dist.tar"
if (Test-Path $tar) { Remove-Item $tar -Force }
& tar -cf $tar -C web .
if ($LASTEXITCODE -ne 0) { throw "打包 web 失败" }
if (-not (Test-Path -LiteralPath $tar) -or (Get-Item -LiteralPath $tar).Length -lt 1) { throw "打包结果是空的。已停止，不会上传。" }

Write-Host "==> 3/4 上传、快照旧版、解压（失败自动还原）" -ForegroundColor Cyan
scp -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$PSScriptRoot\known_hosts" $tar "${sshTarget}:/tmp/pi-web-dist.tar"
if ($LASTEXITCODE -ne 0) { throw "上传失败" }

# 以下四个远端脚本与 deploy-web.sh 的 SNAPSHOT/RESTORE/PERMS/WEB body 逐字相同，改一边必须同步另一边。
# 先整份留一份当前 web/：解压、权限、验证任一步失败都能退回去；成功也保留，供手动回滚
$snapshotBody = @'
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
'@

# 失败还原：优先 web.prev；首次部署或 WEB_BODY 中途失败时退回它留下的 web.old
$restoreBody = @'
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
'@

# 权限归一化：目录 755、文件 644（a+rX 给目录执行位），懒加载 chunk 也在 web/assets 下逐项确认 other 可读
$permsBody = @'
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
'@

# 服务器上执行的脚本：与 deploy-web.sh 里的 WEB_BODY 逐字相同，改一边必须同步另一边
$webBody = @'
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
'@

function Invoke-WebRemote([string]$Body) {
  $normalized = $Body -replace "`r`n", "`n" -replace "`r", "`n"
  if (-not $normalized.EndsWith("`n")) { $normalized += "`n" }
  $sh = Join-Path $env:TEMP "pi-deploy-web.sh"
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($sh, $normalized, $utf8)
  & scp -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$PSScriptRoot\known_hosts" $sh "${sshTarget}:/tmp/pi-deploy-web.sh" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "上传部署脚本失败" }
  $output = & ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$PSScriptRoot\known_hosts" $sshTarget "bash /tmp/pi-deploy-web.sh"
  [pscustomobject]@{ Exit = $LASTEXITCODE; Output = @($output) }
}

function Write-WebOutput($Result) {
  foreach ($line in @($Result.Output)) {
    if ($null -eq $line) { continue }
    $text = "$line".TrimEnd()
    if ($text -eq "") { continue }
    Write-Host $text
  }
}

function Restore-Web {
  $restoreResult = Invoke-WebRemote $restoreBody
  Write-WebOutput $restoreResult
  if ($restoreResult.Exit -ne 0) {
    Write-Host "  自动还原失败（没有 web.prev/、也没有 web.old/，或恢复命令失败）。" -ForegroundColor Red
    Write-Host "  立即 ssh $sshTarget 检查 /opt/pi-remote/app/web*，必要时从 web-legacy-backup/ 恢复旧站。" -ForegroundColor Red
    return $false
  }
  Write-Host "  已自动还原上一版 web/" -ForegroundColor Green
  # 旧版可能是权限修复前部署的：还原后再补一次可读权限
  $permsResult = Invoke-WebRemote $permsBody
  Write-WebOutput $permsResult
  if ($permsResult.Exit -ne 0) {
    Write-Host "  警告：还原后权限归一化失败，请手动检查服务器上的 web/" -ForegroundColor Red
  }
  return $true
}

$snapshotResult = Invoke-WebRemote $snapshotBody
Write-WebOutput $snapshotResult
if ($snapshotResult.Exit -ne 0) { throw "旧版快照失败；web/ 未改动，已停止" }

$webResult = Invoke-WebRemote $webBody
Write-WebOutput $webResult
if ($webResult.Exit -ne 0) {
  Write-Host "服务器端解压/切换失败" -ForegroundColor Red
  Restore-Web | Out-Null
  throw "部署失败：已尝试还原上一版（看上面的输出）"
}
$permsResult = Invoke-WebRemote $permsBody
Write-WebOutput $permsResult
if ($permsResult.Exit -ne 0) {
  Write-Host "web/ 权限归一化失败" -ForegroundColor Red
  Restore-Web | Out-Null
  throw "部署失败：已尝试还原上一版（看上面的输出）"
}
Write-Host "  权限已归一化：目录可进入、文件（含懒加载 chunk）对服务用户可读" -ForegroundColor Green

Write-Host "==> 4/4 验证" -ForegroundColor Cyan
# 主 JS/CSS 名带内容 hash：从刚构建的 index.html 里取，确认服务器上真是这一版
$index = Get-Content (Join-Path $root "web\index.html") -Raw
$paths = @("/", "/favicon.svg", "/verify.html")
foreach ($m in [regex]::Matches($index, '(?:src|href)="(/assets/index-[^"]+\.(?:js|css))"')) { $paths += $m.Groups[1].Value }
# 再抽一个非入口的懒加载 chunk：确认带 hash 的按需资源也能被服务用户读到
$lazy = ""
$assetsDir = Join-Path $root "web\assets"
if (Test-Path -LiteralPath $assetsDir -PathType Container) {
  $lazyFile = Get-ChildItem -LiteralPath $assetsDir -File | Sort-Object Name | Where-Object { $_.Name -like "*.js" -and $_.Name -notlike "index-*" } | Select-Object -First 1
  if ($null -ne $lazyFile) {
    $lazy = $lazyFile.Name
    $paths += "/assets/$lazy"
  }
}
$failed = 0
if ($paths.Count -lt 5) { $failed++; Write-Host "  web\index.html 里没找到主 JS/CSS（构建产物不完整？）" -ForegroundColor Red }
foreach ($p in $paths) {
  $code = 0
  # 与 .sh 的 --retry 2 对齐：瞬时失败重试两次，仍失败才算这个地址不通过
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 -Uri ($ViewerBase + $p)
      $code = [int]$r.StatusCode
      break
    } catch {
      if ($attempt -lt 2) { Start-Sleep -Seconds 1 }
    }
  }
  if ($code -eq 200) {
    Write-Host "  $p -> $code" -ForegroundColor Green
  } else {
    $failed++
    $codeText = if ($code -gt 0) { "$code" } else { "无响应" }
    Write-Host "  $p -> $codeText" -ForegroundColor Red
  }
}
if ($failed -ne 0) {
  Write-Host "$failed 个地址验证失败：开始自动还原上一版" -ForegroundColor Red
  Restore-Web | Out-Null
  throw "$failed 个地址验证失败；已尝试还原上一版（看上面的输出）"
}
Write-Host ""
Write-Host "DONE. 打开 $ViewerBase/" -ForegroundColor Green
Write-Host "冒烟验证页：$ViewerBase/verify.html"
Write-Host "上一版保留在服务器 /opt/pi-remote/app/web.prev/；需要手动回滚时："
Write-Host "  ssh $sshTarget 'cd /opt/pi-remote/app && rm -rf web.failed && mv web web.failed && mv web.prev web && systemctl restart pi-remote.service'"
Write-Host "viewer token 在服务器 /etc/pi-remote.env。不要写进仓库、参数或这条命令的输出。"