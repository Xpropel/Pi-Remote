#!/bin/sh
# pi-remote attach（macOS / Linux 壳；Windows 用 attach.cmd）：参数同 node deploy/attach.cjs
# 软链到 PATH 里也能用：顺着链接找回 deploy/。PATH 里没有 node（launchd、cron 拉起）时再试 Homebrew 与 /usr/local。
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case "$link" in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done
dir=$(cd "$(dirname "$self")" && pwd) || exit 1

# nvm 的 node 在 ~/.nvm/versions/node/<版本>/bin；launchd / cron / systemd 的 PATH 里没有它。
# 按版本序取最新（sort -V：Ubuntu coreutils 与 macOS 都支持）。
nvm_bins() {
  for base in "${NVM_DIR:-$HOME/.nvm}/versions/node" "$HOME/.nvm/versions/node"; do
    [ -d "$base" ] || continue
    for d in "$base"/*/bin; do
      [ -d "$d" ] && printf '%s\n' "$d"
    done
  done | awk '!seen[$0]++' | sort -V
}

nvm_latest_node() {
  nvm_bins | while IFS= read -r d; do
    [ -x "$d/node" ] && printf '%s\n' "$d"
  done | tail -n 1
}

node_bin=$(command -v node 2>/dev/null)
if [ -z "$node_bin" ]; then
  nvm_dir=$(nvm_latest_node)
  [ -n "$nvm_dir" ] && node_bin=$nvm_dir/node
fi
if [ -z "$node_bin" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$c" ]; then
      node_bin=$c
      break
    fi
  done
fi
if [ -z "$node_bin" ]; then
  echo "[error] node not found: install Node.js 22+ or add it to PATH" >&2
  exit 127
fi
exec "$node_bin" "$dir/attach.cjs" "$@"
