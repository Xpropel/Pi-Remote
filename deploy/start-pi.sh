#!/usr/bin/env bash
# pi-remote：带 pi-remote 环境变量启动 pi（macOS / Linux；Windows 用 start-pi.cmd）。
# 用法：deploy/start-pi.sh [pi 的其它参数...]   在 pi 要工作的项目目录里运行。
# 变量来源：本脚本上一级的 .env > 已有的系统环境变量（.env 里留空的键不覆盖系统值）。
# .env 规则与 deploy/attach.cjs 一致：跳过空行和 # 注释；键名两侧空格去掉；值去掉首尾空格，
# 再去掉一对成对的引号（"a b" 或 'a b'）；值原样导出，绝不当命令执行。容忍 CRLF 和 UTF-8 BOM。
# 兼容 macOS 自带的 bash 3.2。

# 软链到 PATH 里（ln -s …/deploy/start-pi.sh ~/bin/pi-remote）也要找回真正的 deploy/，否则读不到 .env
self=${BASH_SOURCE[0]}
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case "$link" in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done
script_dir=$(cd "$(dirname "$self")" && pwd)
# Env file: attach injects PI_REMOTE_PI_ENV_FILE when it launches pi, so a pi
# started via `attach --env <file>` reads that same file instead of silently
# falling back to the install-root .env (defect F2). Manual runs keep the
# default: the .env one level above this script.
env_file="${PI_REMOTE_PI_ENV_FILE:-$script_dir/../.env}"

# 去首尾空白，结果写进第一个参数指名的变量：printf -v 不开子 shell（bash 3.1 起支持）
trim_to() {
  local s=$2
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf -v "$1" '%s' "$s"
}

# tmux 3.4 约四成概率丢 #{pane_dead_status}：拉起时由 attach.cjs / device.cjs 注入落盘文件，
# 本脚本在正常退出、找不到 pi（127）、被信号打断时都写一行退出码；读侧窗格有值仍以窗格为准。
# 不注入时保持原来的 exec，零额外进程。
exit_file=${PI_REMOTE_EXIT_FILE:-}
if [ -n "$exit_file" ]; then
  case "$exit_file" in
    */*) mkdir -p -- "${exit_file%/*}" 2>/dev/null || true ;;
  esac
  write_exit_code() {
    printf '%s\n' "$1" >"$exit_file" 2>/dev/null || true
  }
  trap 'write_exit_code $?' EXIT
  trap 'write_exit_code 129; exit 129' HUP
  trap 'write_exit_code 130; exit 130' INT
  trap 'write_exit_code 143; exit 143' TERM
fi

# nvm 的 node/pi 在 ~/.nvm/versions/node/<版本>/bin；系统服务、cron 的 PATH 里没有它。
# 按版本序取最新（sort -V：Ubuntu coreutils 与 macOS 都支持）。
nvm_bins() {
  for base in "${NVM_DIR:-$HOME/.nvm}/versions/node" "$HOME/.nvm/versions/node"; do
    [ -d "$base" ] || continue
    for d in "$base"/*/bin; do
      [ -d "$d" ] && printf '%s\n' "$d"
    done
  done | awk '!seen[$0]++' | sort -V
}

nvm_latest_bin() {
  nvm_bins | while IFS= read -r d; do
    [ -x "$d/$1" ] && printf '%s\n' "$d"
  done | tail -n 1
}

if [ -f "$env_file" ]; then
  first=1
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    if [ "$first" = 1 ]; then
      line=${line#$'\xef\xbb\xbf'}
      first=0
    fi
    trim_to line "$line"
    case "$line" in "" | "#"*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    trim_to key "${line%%=*}"
    trim_to val "${line#*=}"
    case "$key" in "" | [0-9]* | *[!A-Za-z0-9_]*) continue ;; esac
    if [ ${#val} -ge 2 ]; then
      q=${val:0:1}
      if { [ "$q" = '"' ] || [ "$q" = "'" ]; } && [ "${val:${#val}-1:1}" = "$q" ]; then
        trim_to val "${val:1:${#val}-2}"
      fi
    fi
    [ -n "$val" ] || continue
    export "$key=$val"
  done < "$env_file"
else
  echo "[warn] $env_file not found, run: node deploy/setup.cjs" >&2
fi

if [ -z "${PI_REMOTE_RELAY:-}" ]; then
  echo "[warn] PI_REMOTE_RELAY is empty: the extension will not connect to a relay, pi still works locally" >&2
else
  echo "[pi-remote] relay=$PI_REMOTE_RELAY label=${PI_REMOTE_LABEL:-}"
fi

# Terminal / tmux 拉起时 PATH 可能不含 Homebrew 或 npm 全局目录：先认 PI_REMOTE_PI_BIN，再找 PATH，最后试常见位置
pi_bin=${PI_REMOTE_PI_BIN:-}
if [ -n "$pi_bin" ]; then
  if [ ! -x "$pi_bin" ]; then
    echo "[error] pi not found: PI_REMOTE_PI_BIN=$pi_bin is not executable" >&2
    exit 127
  fi
else
  pi_bin=$(command -v pi 2>/dev/null || true)
  if [ -z "$pi_bin" ]; then
    nvm_dir=$(nvm_latest_bin pi)
    [ -n "$nvm_dir" ] && pi_bin=$nvm_dir/pi
  fi
  if [ -z "$pi_bin" ]; then
    for c in /opt/homebrew/bin/pi /usr/local/bin/pi "$HOME/.npm-global/bin/pi" "$HOME/.local/bin/pi"; do
      if [ -x "$c" ]; then
        pi_bin=$c
        break
      fi
    done
  fi
  if [ -z "$pi_bin" ]; then
    echo "[error] pi not found: install it (npm i -g) or set PI_REMOTE_PI_BIN in .env" >&2
    exit 127
  fi
fi

# pi 是 #!/usr/bin/env node 脚本：按绝对路径找到了 pi，PATH 里没有 node 照样报 env: node: No such file or directory。
# Homebrew、nvm 都把 node 和 pi 装在同一目录。该目录已经在 PATH 后面时，前面的 node 会抢先被 env 选中。
# 同目录有可执行 node 时，把该目录移到 PATH 最前并去掉后面的同一项；本来不在 PATH 里时只前置一次。
# 同目录没有 node 且 PATH 里也找不到时，再试常见位置。
case "$pi_bin" in
  */*) pi_dir=${pi_bin%/*} ;;
  *) pi_dir= ;;
esac

# 按冒号逐段比较，目录名里的空格原样保留。不用数组，兼容 bash 3.2。
path_front() {
  local dir="$1" rest="$2" out="$1" part=""
  if [ -z "$rest" ]; then
    export PATH="$dir"
    return
  fi
  while :; do
    case "$rest" in
      *:*)
        part=${rest%%:*}
        rest=${rest#*:}
        if [ "$part" != "$dir" ]; then
          out=$out:$part
        fi
        ;;
      *)
        if [ "$rest" != "$dir" ]; then
          out=$out:$rest
        fi
        break
        ;;
    esac
  done
  export PATH="$out"
}

if [ -n "$pi_dir" ] && [ -x "$pi_dir/node" ]; then
  path_front "$pi_dir" "$PATH"
elif ! command -v node >/dev/null 2>&1; then
  for d in /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$d/node" ]; then
      export PATH="$PATH:$d"
      break
    fi
  done
  if ! command -v node >/dev/null 2>&1; then
    nvm_dir=$(nvm_latest_bin node)
    [ -n "$nvm_dir" ] && export PATH="$PATH:$nvm_dir"
  fi
fi

if [ -t 1 ]; then
  printf '\033]0;pi · %s\007' "${PWD##*/}"
fi

# 不加 -e：扩展装在 ~/.pi/agent/extensions/ 会自动加载，再 -e 一次就是两条连接互相顶下线
if [ -n "$exit_file" ]; then
  "$pi_bin" "$@"
  exit $?
fi
exec "$pi_bin" "$@"
