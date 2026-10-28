# sync-extension.ps1 —— 把 pi-remote 扩展同步到 pi 的个人扩展目录（本机）
# 用法： powershell -ExecutionPolicy Bypass -File deploy\sync-extension.ps1
# 时机：每次改完 extension/pi-remote-sync.ts 都要跑；跑完重启 pi 生效。
# 和 sync-extension.sh 同口径：目标已经软链/硬链到源码时不动它；先写临时文件再改名，
# 失败不留半截文件；同步后核对 MD5。
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "extension\pi-remote-sync.ts"
# 和 pi 本身、sync-extension.sh 一样认 PI_CODING_AGENT_DIR，否则同步到的目录 pi 根本不读
$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE ".pi\agent" }
$dstDir = Join-Path $agentDir "extensions"
$dst = Join-Path $dstDir "pi-remote-sync.ts"

if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { throw "找不到扩展源码: $src" }

# 同一个文件（开发时常把扩展软链到源码）：拷贝反而会把链接换成死副本
$srcFull = [System.IO.Path]::GetFullPath($src)
$dstFull = [System.IO.Path]::GetFullPath($dst)
$same = $dstFull -eq $srcFull
if (-not $same -and (Test-Path -LiteralPath $dst)) {
  $dstItem = $null
  try { $dstItem = Get-Item -LiteralPath $dst -Force } catch { }
  if ($dstItem -and $dstItem.LinkType) {
    try {
      $target = @($dstItem.Target)[0]
      if ($target) {
        $targetPath = [string]$target
        if ([System.IO.Path]::IsPathRooted($targetPath)) {
          $resolved = $targetPath
        } else {
          $resolved = Join-Path $dstDir $targetPath
        }
        $same = ([System.IO.Path]::GetFullPath($resolved)) -eq $srcFull
      }
    } catch { }
  }
  # 硬链接在 Windows PowerShell 5.1 里可能没有 LinkType/Target：用 fsutil 列出同一文件的所有链接名再比。
  # 普通副本（不是硬链接）fsutil 只会列出它自己，不会误判。
  if (-not $same -and (Test-Path -LiteralPath $dst -PathType Leaf)) {
    try {
      $links = & fsutil.exe hardlink list $dst 2>$null
      foreach ($link in @($links)) {
        $normalized = ([string]$link).Trim().TrimStart("\") -replace "/", "\"
        $sourceNormalized = $srcFull.TrimStart("\") -replace "/", "\"
        if ($normalized -ieq $sourceNormalized) { $same = $true; break }
      }
    } catch { }
  }
}
if ($same) {
  Write-Host "OK 扩展已链接到源码，无需同步 -> $dst" -ForegroundColor Green
  Write-Host "  重启 pi 后生效（交互模式退出重进；RPC 模式重启进程）。"
  exit 0
}
if (Test-Path -LiteralPath $dst -PathType Container) { throw "目标位置是目录，不能覆盖: $dst" }

New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
# 先写临时文件再改名：pi 正在启动时不会读到写了一半的扩展；中途失败不留半截临时文件
$tmp = "$dst.tmp.$PID"
try {
  Copy-Item -LiteralPath $src -Destination $tmp -Force
  try {
    Move-Item -LiteralPath $tmp -Destination $dst -Force
  } catch {
    # 目标是符号链接时 Windows PowerShell 5.1 的 Move-Item -Force 可能拒绝覆盖：换成先删链接再改名
    if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Force }
    Move-Item -LiteralPath $tmp -Destination $dst -Force
  }
} finally {
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}

$h1 = (Get-FileHash $src -Algorithm MD5).Hash
$h2 = (Get-FileHash $dst -Algorithm MD5).Hash
if ($h1 -ne $h2) { throw "MD5 不一致，同步失败: $h1 vs $h2" }

Write-Host "OK 扩展已同步 -> $dst" -ForegroundColor Green
Write-Host "  md5 = $h1"
Write-Host "  重启 pi 后生效（交互模式退出重进；RPC 模式重启进程）。"
