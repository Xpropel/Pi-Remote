#!/bin/sh
# pi-remote Linux 设备（服务器式，tmux 拉起）的命令壳：参数同 node deploy/linux/device.cjs，device.sh help 看用法。
# 允许从符号链接调用（例如 ln -s ~/pi-remote/deploy/linux/device.sh ~/.local/bin/pi-remote）。
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case "$link" in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done

# nvm 的 node 在 ~/.nvm/versions/node/<版本>/bin；cron / systemd / 精简 PATH 里没有它。
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
  for c in /usr/local/bin/node /usr/bin/node; do
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
exec "$node_bin" "$(dirname "$self")/device.cjs" "$@"
