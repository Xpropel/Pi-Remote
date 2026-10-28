#!/usr/bin/env bash
# sync-extension.sh —— 把 pi-remote 扩展同步到 pi 的个人扩展目录（macOS / Linux；Windows 用 sync-extension.ps1）
# 用法： deploy/sync-extension.sh
# 时机：每次改完 extension/pi-remote-sync.ts 都要跑；跑完重启 pi 生效。
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
src="$root/extension/pi-remote-sync.ts"
dst_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"
dst="$dst_dir/pi-remote-sync.ts"

if [ ! -f "$src" ]; then
  echo "找不到扩展源码: $src" >&2
  exit 1
fi
# 开发时常把扩展软链到源码：同一个文件就不用拷，拷了反而把链接换成死副本
if [ "$src" -ef "$dst" ]; then
  echo "OK 扩展已链接到源码，无需同步 -> $dst"
  exit 0
fi
mkdir -p "$dst_dir"
# 先写临时文件再改名：pi 正在启动时不会读到写了一半的扩展；中途失败不留半截临时文件
tmp="$dst.tmp.$$"
trap 'rm -f -- "$tmp"' EXIT
cp "$src" "$tmp"
mv -f "$tmp" "$dst"

md5_of() {
  if command -v md5sum >/dev/null 2>&1; then
    md5sum "$1" | cut -d' ' -f1
  else
    md5 -q "$1"
  fi
}
h1=$(md5_of "$src")
h2=$(md5_of "$dst")
if [ "$h1" != "$h2" ]; then
  echo "MD5 不一致，同步失败: $h1 vs $h2" >&2
  exit 1
fi

echo "OK 扩展已同步 -> $dst"
echo "  md5 = $h1"
echo "  重启 pi 后生效（交互模式退出重进；RPC 模式重启进程）。"
