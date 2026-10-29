/**
 * pi-remote attach —— 连接窗口（前台命令），Windows / macOS / Linux 共用。
 *
 *   node deploy/attach.cjs [项目目录...] [--max-hours 12] [--init]
 *   deploy\attach.cmd（Windows）/ deploy/attach.sh（macOS、Linux）同上
 *
 * 窗口开着：写 ~/.pi/agent/remote-attach.json，连 7001 发 device_register，
 * 响应 harness_start。退出 / 到期 / 被顶替：删状态文件并断开。已拉起的 pi 不杀。
 *
 * 不读模型密钥。连上之后读取本机会话目录（认 PI_CODING_AGENT_SESSION_DIR，缺省 ~/.pi/agent/sessions），
 * 把会话清单和正文摘要交给 relay（只在内存转发）；目录只来自白名单、浏览根目录（P9 C）或本机命令行入参。
 * P9 起还负责：设备级删除会话（trash 优先，反向同步 deleted 文件）、按请求列浏览根目录内的子目录。拉起 pi 时：
 *   Windows  cmd.exe /c start 开新控制台，路径走 argv 数组，不拼 shell 字符串
 *   macOS    默认开 Terminal 新窗口（一次性 .command 脚本，路径全部单引号转义）；可改 tmux
 *   Linux    tmux 后台会话（argv 直接 exec，不经 sh -c）
 */
"use strict";

const fs = require("node:fs");
const { readArchive, listSessionFiles, manifestRow } = require("./session-library.cjs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const net = require("node:net");
const dgram = require("node:dgram");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const HOST_PLATFORM = process.platform;
const PROTOCOL = require("../protocol/v4.json");
const ATTACH_VERSION = "4.0.0";
/**
 * attach 声明的能力位（随 auth 帧发出；relay 据此算 devices[].features）：
 *   session.files  P9 B：按 sessionId 在设备整个会话根目录里删除会话文件
 *   fs.browse      P9 C：列出浏览根目录内的子目录（只读目录名，不传文件内容）
 */
const CLIENT_CAPS = ["err.v4", "device.token", "session.files", "fs.browse"];
const PAIR_TIMEOUT_MS = 15000;
/** 反向同步扫描本机会话目录的间隔（P9 B）：默认 30s，PI_REMOTE_LIBRARY_RESCAN_MS 可改，下限 5s */
const LIBRARY_RESCAN_MS = 30000;
const LIBRARY_RESCAN_MIN_MS = 5000;
/**
 * P1-1：反向同步时"同一会话 10 分钟内最多补发一次正文"（session_archive 最大约 200KB，
 * relay 会广播给每个网页；在线会话每轮都在写文件，不能每次 mtime 变化都重发全文）。
 */
const ARCHIVE_RESEND_MS = 10 * 60 * 1000;
/** 目录浏览上限（与 protocol/v4.json 的 limits 同源；读不到时退回缺省值） */
const DIR_LIST_MAX = Number(PROTOCOL.limits && PROTOCOL.limits.dirListMax) || 500;
const DIR_NAME_MAX = Number(PROTOCOL.limits && PROTOCOL.limits.dirNameMax) || 255;
const BROWSE_ROOTS_MAX = Number(PROTOCOL.limits && PROTOCOL.limits.browseRootsMax) || 8;
/** 目录名里的控制字符：不上报、不展示 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** tmux new-session 正常几十毫秒就回话；卡住时按已拉起处理，不拖过 relay 的 harness_start 超时（10s） */
const TMUX_EXIT_WAIT_MS = 5000;
/** tmux 开成之后再等这么久，看 pi 是不是当场就退了（找不到 pi、配置坏了） */
const TMUX_SETTLE_MS = 1500;
/** macOS Terminal 拉起后等会话上线：实测冷启动约 2s，留足余量又不超过 relay 的 10s 受理超时 */
const TERMINAL_LAUNCH_WAIT_MS = 4000;
/** Windows 新控制台拉起后等会话上线：cmd 的 start 立刻返回，失败（pi 没装、配置坏了）只能靠这段等待发现 */
const WIN_LAUNCH_WAIT_MS = 6000;
/** 软超时后占用再保留这么久：给 Terminal / 新控制台冷启动留时间，又不把目录锁 10 分钟 */
const TERMINAL_CLAIM_GRACE_MS = 30000;
/** tmux 3.4 在非 UTF-8 locale 下把格式化输出里的制表符净化成下划线；优先注入这几个 locale 规避 */
const PREFERRED_UTF8_LOCALES = ["C.UTF-8", "en_US.UTF-8"];
const START_PI_WIN = path.join(__dirname, "start-pi.cmd");
const START_PI_POSIX = path.join(__dirname, "start-pi.sh");
const DEFAULT_MAX_HOURS = 12;
const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 20000;
const STATUS_MS = 5000;
/**
 * 合盖睡眠、换 Wi‑Fi 后 socket 成了半开连接：relay 90s 就判设备离线，这边却收不到 close，终端一直显示「设备已连接」。
 * 每 LIVENESS_TICK_MS 看一次：定时器晚到 WAKE_GAP_MS 以上 = 刚睡醒，直接重连；relay 每 30s ping 一次，
 * SILENCE_PING_MS 没收到任何东西就自己 ping，SILENCE_DEAD_MS 还没动静就判死重连。
 */
const LIVENESS_TICK_MS = 10000;
const WAKE_GAP_MS = 30000;
const SILENCE_PING_MS = 30000;
const SILENCE_DEAD_MS = 75000;

/** cmd.exe 会再次解析 start 的参数；这些字符不进入 argv。 */
const UNSAFE_PATH = /[\0\r\n"&|<>^%]/;
/** POSIX 上路径只进 argv 或单引号字符串，只拦控制字符。 */
const UNSAFE_PATH_POSIX = /[\0\r\n]/;

function unsafePath(p, platform = HOST_PLATFORM) {
  return (platform === "win32" ? UNSAFE_PATH : UNSAFE_PATH_POSIX).test(String(p));
}

/** 设备平台标识（device_register.platform）：win32→windows、darwin→macos，其余沿用 Node 的叫法（linux…）。 */
function platformId(platform = HOST_PLATFORM) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return String(platform || "unknown");
}

function defaultDeviceName(platform = HOST_PLATFORM) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "Mac";
  if (platform === "linux") return "Linux";
  return platformId(platform);
}

/**
 * 窗口开着时挡住空闲睡眠：macOS 用 `caffeinate -i`，Linux 用 `systemd-inhibit`。
 * 睡过去 relay 连接就断了，网页上这台设备和它的会话全部离线。缺省开，PI_REMOTE_KEEP_AWAKE=0 / false / off / no 关掉；
 * Windows 没有对等机制，不管。
 */
function keepAwakeWanted(value, platform = HOST_PLATFORM) {
  if (platform !== "darwin" && platform !== "linux") return false;
  return !/^(0|false|off|no)$/i.test(String(value == null ? "" : value).trim());
}

/** doctor 顶栏用：darwin → macOS，win32 → Windows，linux → Linux；不认识的也按首字母大写（不能是 "linux" 这种小写） */
function platformLabel(platform = HOST_PLATFORM) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  const raw = String(platform || "unknown").trim() || "unknown";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * tmux 安装提示：按平台/发行版给对应的包管理器。
 * P13 deploy 低-1：Linux 上不能给 macOS 的 brew 提示（Ubuntu 云镜像用 apt、Fedora 用 dnf、Arch 用 pacman…），
 * 探测不到包管理器时给一条同时含 apt / dnf 的兜底，不猜用户的发行版。
 */
const TMUX_INSTALL_FALLBACK = "用发行版的包管理器安装 tmux（Ubuntu/Debian：sudo apt install -y tmux；Fedora/RHEL：sudo dnf install -y tmux）";
function tmuxInstallHint(platform = HOST_PLATFORM, deps = {}) {
  if (platform === "win32") return "Windows 不需要 tmux（用新控制台拉起）";
  if (platform === "darwin") return "macOS 可 brew install tmux";
  const exists = typeof deps.exists === "function" ? deps.exists : (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  };
  const managers = [
    ["/usr/bin/apt-get", "Ubuntu/Debian：sudo apt install -y tmux"],
    ["/usr/bin/apt", "Ubuntu/Debian：sudo apt install -y tmux"],
    ["/usr/bin/dnf", "Fedora/RHEL：sudo dnf install -y tmux"],
    ["/usr/bin/yum", "CentOS/RHEL：sudo yum install -y tmux"],
    ["/usr/bin/pacman", "Arch：sudo pacman -S --noconfirm tmux"],
    ["/usr/bin/zypper", "openSUSE：sudo zypper install -y tmux"],
    ["/sbin/apk", "Alpine：sudo apk add tmux"],
    ["/usr/bin/apk", "Alpine：sudo apk add tmux"],
  ];
  for (const [file, hint] of managers) {
    if (exists(file)) return hint;
  }
  return TMUX_INSTALL_FALLBACK;
}

/** 当前生效的 locale（LC_ALL > LC_CTYPE > LANG，与 libc 的优先级一致） */
function currentLocale(environ = process.env) {
  return String((environ && (environ.LC_ALL || environ.LC_CTYPE || environ.LANG)) || "").trim();
}

function localeIsUtf8(value) {
  return /utf-?8/i.test(String(value || ""));
}

/** `locale -a` 的名字是 C.utf8 / en_US.utf8；注入时统一写成 glibc 认识的 C.UTF-8 / en_US.UTF-8。 */
function canonicalLocaleName(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  const at = s.indexOf("@");
  const mod = at >= 0 ? s.slice(at) : "";
  const base = at >= 0 ? s.slice(0, at) : s;
  const m = /^(.+?)\.(utf-?8)$/i.exec(base);
  if (m) return `${m[1]}.UTF-8${mod}`;
  return s;
}

/**
 * 本机真实存在的 UTF-8 locale：先 `locale -a`，优先 C.UTF-8 / en_US.UTF-8，再按名字取第一个。
 * 探不到返回空串（调用方走兼容解析，绝不瞎注入一个不存在的 locale）。
 */
function availableUtf8Locale(spawnSyncImpl = spawnSync, environ = process.env, platform = HOST_PLATFORM) {
  if (platform === "win32") return "";
  let list = "";
  try {
    const r = spawnSyncImpl("locale", ["-a"], { encoding: "utf8", timeout: 2000, env: environ });
    if (r && !r.error && r.status === 0) list = String(r.stdout || "");
  } catch {}
  const names = [];
  for (const line of list.split(/\r?\n/)) {
    const name = canonicalLocaleName(line);
    if (name && localeIsUtf8(name) && !names.includes(name)) names.push(name);
  }
  if (!names.length) return "";
  const rank = (name) => {
    const i = PREFERRED_UTF8_LOCALES.indexOf(name);
    return i >= 0 ? i : PREFERRED_UTF8_LOCALES.length;
  };
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return names[0];
}

/** 当前 locale 不是 UTF-8 时给 tmux 客户端注入的 locale；已经是 UTF-8 或探不到时返回空串 */
function tmuxLocaleOverride(spawnSyncImpl = spawnSync, environ = process.env, platform = HOST_PLATFORM) {
  if (platform === "win32") return "";
  if (localeIsUtf8(currentLocale(environ))) return "";
  return availableUtf8Locale(spawnSyncImpl, environ, platform);
}

/** tmux 客户端专用环境：只改 LANG/LC_ALL，不动当前进程、也不动 pi 子进程的环境 */
function tmuxEnvWithLocale(environ, locale) {
  if (!locale) return environ;
  return { ...environ, LANG: locale, LC_ALL: locale };
}

/** nvm 的 node 版本目录：~/.nvm/versions/node/v22.23.4/bin（也认 NVM_DIR），按版本从新到旧 */
function compareNodeVersions(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return b[i] - a[i];
  return 0;
}

function nvmNodeBins(home = os.homedir(), environ = process.env) {
  const bases = [];
  const envDir = environ && environ.NVM_DIR ? String(environ.NVM_DIR).trim() : "";
  if (envDir) bases.push(path.join(envDir, "versions", "node"));
  bases.push(path.join(home, ".nvm", "versions", "node"));
  const found = [];
  const seen = new Set();
  for (const base of bases) {
    let names = [];
    try {
      names = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(name);
      if (!m) continue;
      const dir = path.join(base, name, "bin");
      if (seen.has(dir)) continue;
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      seen.add(dir);
      found.push({ dir, version: [Number(m[1]), Number(m[2]), Number(m[3])] });
    }
  }
  found.sort((a, b) => compareNodeVersions(a.version, b.version));
  return found.map((item) => item.dir);
}

/** 退出码落盘契约：<home>/.pi/agent/pi-remote-exit/<安全名>-<hash>.code；会话名不进路径拼接，避免穿越 */
function exitCodeDir(home = os.homedir()) {
  return path.join(home, ".pi", "agent", "pi-remote-exit");
}

function exitCodePath(session, home = os.homedir()) {
  const name = String(session || "session");
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_").slice(0, 48) || "session";
  const hash = crypto.createHash("sha1").update(name).digest("hex").slice(0, 12);
  return path.join(exitCodeDir(home), `${safe}-${hash}.code`);
}

/** 写退出码；目录不存在就建（0700）。返回是否写成功，调用方不能因为写不了就改变退出码 */
function writeExitCodePath(file, code) {
  const n = Number(code);
  if (!file || !Number.isInteger(n)) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${n}\n`, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function readExitCodePath(file) {
  if (!file) return null;
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    return /^-?\d+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

function readExitCode(session, home = os.homedir()) {
  return readExitCodePath(exitCodePath(session, home));
}

function removeExitCode(session, home = os.homedir()) {
  try {
    fs.unlinkSync(exitCodePath(session, home));
  } catch {}
}

/** Windows 与 macOS（APFS 默认）路径不分大小写；Linux 区分。 */
function caseInsensitivePaths(platform = HOST_PLATFORM) {
  return platform === "win32" || platform === "darwin";
}

function pathApi(platform = HOST_PLATFORM) {
  return platform === "win32" ? path.win32 : path.posix;
}

function startPiFor(platform = HOST_PLATFORM) {
  return platform === "win32" ? START_PI_WIN : START_PI_POSIX;
}

const START_PI = startPiFor();

function initHint(platform = HOST_PLATFORM) {
  return platform === "win32" ? "node deploy\\attach.cjs --init" : "deploy/attach.sh --init";
}

/**
 * 绝对路径。本机 POSIX 上再解开符号链接：pi 报上来的 cwd 是 getcwd() 给的真实路径
 * （macOS 的 /tmp 是 /private/tmp，大小写也以磁盘为准），白名单写的可能是链接或别的大小写。
 */
function realDir(p, platform = HOST_PLATFORM) {
  let resolved = pathApi(platform).resolve(String(p));
  if (platform === HOST_PLATFORM && platform !== "win32") {
    try {
      resolved = fs.realpathSync.native(resolved);
    } catch {}
  }
  return resolved;
}

function isDirSafe(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * P2-4：浏览根目录的解析。POSIX 上 realDir 已经解过符号链接；win32 上 realDir 只做
 * path.win32.resolve、**不解析真实路径**，而浏览目标是用 fs.realpathSync.native 解析的。
 * 根目录本身是 junction 时两边会不一致、被误判成「不在允许范围」，所以 win32 上再解一次。
 * deps 仅用于纯函数测试（注入 realpathNative / isDir），生产调用不传。
 */
function resolveBrowseRoot(item, platform = HOST_PLATFORM, deps = {}) {
  const realpathNative = deps.realpathNative || ((p) => fs.realpathSync.native(p));
  let resolved;
  try {
    resolved = realDir(item, platform);
  } catch {
    return "";
  }
  if (platform === "win32") {
    try {
      resolved = realpathNative(resolved);
    } catch {}
  }
  return resolved;
}

/**
 * PI_REMOTE_BROWSE_ROOTS（P9 C）：网页能浏览、能在下面新建会话的根目录。
 *   空值        → [os.homedir()]（不写这一项时，缺省只放自己的家目录）
 *   off/0/false → []（关闭浏览；网页上「打开文件夹…」置灰）
 *   其它        → 按 ; 拆开；每项 realDir 解析成绝对路径，丢掉不存在/不是目录的，最多 8 个
 */
function parseBrowseRoots(value, platform = HOST_PLATFORM, deps = {}) {
  const isDir = deps.isDir || isDirSafe;
  const raw = String(value == null ? "" : value).trim();
  if (!raw) {
    const home = String(os.homedir() || "").trim();
    if (!home) return [];
    const resolved = resolveBrowseRoot(home, platform, deps);
    if (!resolved) return [];
    return isDir(resolved) ? [resolved] : [];
  }
  if (/^(off|0|false)$/i.test(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const part of raw.split(";")) {
    const item = part.trim();
    if (!item || unsafePath(item, platform)) continue;
    const resolved = resolveBrowseRoot(item, platform, deps);
    if (!resolved || !isDir(resolved)) continue;
    const key = caseInsensitivePaths(platform) ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
    if (out.length >= BROWSE_ROOTS_MAX) break;
  }
  return out;
}

/** Windows 上是 UNC 路径（\\server\share）？ */
function isUncPath(p, platform = HOST_PLATFORM) {
  return platform === "win32" && /^[\\/]{2}[^\\/]/.test(String(p || ""));
}

/** 路径比较键：先 normalizeDir（realDir + 去掉末尾分隔符），Windows 盘符统一大写。"" = 不安全路径。 */
function rootCompareKey(p, platform = HOST_PLATFORM) {
  let key = normalizeDir(p, platform);
  if (!key) return "";
  if (platform === "win32") key = key.replace(/^([a-z]):/, (m, c) => c.toUpperCase() + ":");
  return key;
}

/** 返回 p 落在哪个根目录里（原样返回该根目录字符串）；不在任何根目录里返回 null。 */
function matchedRoot(p, roots, platform = HOST_PLATFORM) {
  const target = rootCompareKey(p, platform);
  if (!target) return null;
  const targetUnc = isUncPath(target, platform);
  const sep = platform === "win32" ? "\\" : "/";
  for (const root of roots || []) {
    const base = rootCompareKey(root, platform);
    if (!base) continue;
    // UNC 路径只认 UNC 根目录：普通盘符根目录不能把它当子目录放进来
    if (targetUnc && !isUncPath(base, platform)) continue;
    if (target === base) return root;
    if (target.startsWith(base + sep)) return root;
  }
  return null;
}

/**
 * p 是否等于某个浏览根目录、或在它下面（P9 C）。
 * 按 normalizeDir 之后的路径比（大小写按平台：Windows/macOS 不分大小写；Windows 盘符统一大写）。
 */
function insideRoots(p, roots, platform = HOST_PLATFORM) {
  return matchedRoot(p, roots, platform) !== null;
}

/** 配对码：忽略大小写、空格和连字符；只认协议字母表（去掉了 0/O/1/I） */
function normalizePairCode(raw) {
  const code = String(raw == null ? "" : raw).toUpperCase().replace(/[\s-]+/g, "");
  const { pairCodeLength, pairCodeAlphabet } = PROTOCOL.limits;
  if (code.length !== pairCodeLength || [...code].some((ch) => !pairCodeAlphabet.includes(ch))) {
    throw new Error(`配对码应为 ${pairCodeLength} 位（形如 XXXX-XXXX），只含 ${pairCodeAlphabet}`);
  }
  return code;
}

/** 配对码的展示形态：裸码按一半分组（8 位 → XXXX-XXXX），与 relay 的 formatPairCode 同口径 */
function formatPairCode(code) {
  const raw = String(code == null ? "" : code).toUpperCase().replace(/[\s-]+/g, "");
  const len = Number(PROTOCOL.limits && PROTOCOL.limits.pairCodeLength) || 8;
  return raw.length === len && len % 2 === 0 ? raw.slice(0, len / 2) + "-" + raw.slice(len / 2) : raw;
}

function parseArgs(argv) {
  const out = { dirs: [], maxHours: DEFAULT_MAX_HOURS, viewerPort: 0, init: false, help: false, pair: "", link: false, share: false, tunnel: false, relay: "", doctor: false, env: "", allowRemote: false };
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === "--init") out.init = true;
    else if (a === "--doctor") out.doctor = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--pair" || a.startsWith("--pair=")) {
      out.pair = normalizePairCode(a.startsWith("--pair=") ? a.slice("--pair=".length) : args[++i]);
    }
    else if (a === "--link") out.link = true;
    else if (a === "--share") out.share = true;
    else if (a === "--tunnel") out.tunnel = true;
    else if (a === "--relay" || a.startsWith("--relay=")) {
      const raw = String(a.startsWith("--relay=") ? a.slice("--relay=".length) : args[++i] ?? "").trim();
      if (!/^wss?:\/\/\S+$/.test(raw)) throw new Error("--relay 需要 ws:// 或 wss:// 地址");
      out.relay = raw;
    }
    else if (a === "--allow-remote") out.allowRemote = true;
    else if (a === "--env" || a.startsWith("--env=")) {
      const raw = a.startsWith("--env=") ? a.slice("--env=".length) : args[++i] == null ? "" : args[i];
      const file = String(raw == null ? "" : raw).trim();
      if (!file) throw new Error("--env 需要 env 文件路径");
      out.env = file;
    }
    else if (a === "--headless") throw new Error("本期不支持 --headless");
    else if (a === "--max-hours" || a.startsWith("--max-hours=")) {
      const raw = a.startsWith("--max-hours=") ? a.slice("--max-hours=".length) : args[++i];
      const v = Number(raw);
      if (!Number.isFinite(v) || v <= 0) throw new Error("--max-hours 需要正数（小时）");
      out.maxHours = v;
    } else if (a === "--viewer-port" || a.startsWith("--viewer-port=")) {
      const raw = a.startsWith("--viewer-port=") ? a.slice("--viewer-port=".length) : args[++i];
      const v = Number(raw);
      if (!Number.isFinite(v) || v <= 0 || v > 65535) throw new Error("--viewer-port 需要 1-65535 的端口");
      out.viewerPort = v;
    } else if (a.startsWith("-")) {
      throw new Error("未知参数：" + a);
    } else {
      out.dirs.push(a);
    }
  }
  return out;
}

function unescapeEnvValue(value) {
  let v = String(value ?? "").trim();
  if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
    v = v.slice(1, -1);
  }
  return v.trim();
}

function parseEnv(text) {
  const out = {};
  const src = String(text || "").replace(/^\uFEFF/, "");
  for (const line of src.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i <= 0) continue;
    out[s.slice(0, i).trim()] = unescapeEnvValue(s.slice(i + 1));
  }
  return out;
}

/**
 * 本地真实测试安全 guard（Round 1 事故后的硬规则）：
 * - `deploy/attach.cjs` 默认读仓库根 `.env`（可能含生产 relay/token）。本地真实测试**禁止**直接运行它；
 *   只能用 127.0.0.1 relay + 临时 data + 独立 env（`--env <file>` 或 `ATTACH_ENV_FILE`）。
 * - 下列纯函数不联网、不读文件，供 main / pair / doctor 与单测复用。
 */

/** relay host 是否本地：localhost / 127.0.0.0/8 / ::1 */
function isLocalRelayHost(host) {
  const h = String(host == null ? "" : host).trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1") return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;
  return octets[0] === 127;
}

/** relay URL → host（非法 URL 返回 null） */
function relayHostOf(relayUrl) {
  try {
    return new URL(String(relayUrl == null ? "" : relayUrl)).hostname;
  } catch {
    return null;
  }
}

/**
 * 解析 env 文件路径：`--env <file>` > `ATTACH_ENV_FILE` > 默认仓库根 `.env`。
 * 返回 { path, source, explicit }；只算路径，不读文件、不联网。
 */
function resolveEnvFile(argv = [], environ = process.env, root = ROOT) {
  const args = Array.isArray(argv) ? argv : [];
  let fromCli = "";
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === "--env") {
      fromCli = String(args[i + 1] == null ? "" : args[i + 1]).trim();
      i++;
    } else if (a.startsWith("--env=")) fromCli = a.slice("--env=".length).trim();
  }
  const fromVar = String((environ && environ.ATTACH_ENV_FILE) || "").trim();
  if (fromCli) return { path: path.resolve(fromCli), source: "--env", explicit: true };
  if (fromVar) return { path: path.resolve(fromVar), source: "ATTACH_ENV_FILE", explicit: true };
  return { path: path.join(root, ".env"), source: "默认根 .env", explicit: false };
}

/**
 * 非本地 relay 且未 `--allow-remote` → 返回阻止原因（字符串）；本地 / 显式允许 → null。
 * 纯函数：测试用它验证 guard，不会真实连接。
 */
function attachRelaySafetyError(relayUrl, options = {}) {
  const host = relayHostOf(relayUrl);
  if (!host) return "relay 地址无法解析：" + String(relayUrl == null ? "" : relayUrl);
  if (isLocalRelayHost(host)) return null;
  if (options.allowRemote) return null;
  return [
    "⛔ 检测到非本地 relay：host=" + host + "（可能连接生产 relay / 读取生产令牌）。",
    "本地真实测试只允许 127.0.0.1 / localhost / ::1；",
    "如确需连远端（部署/冒烟），显式加 --allow-remote 重新运行；",
    "本地测试请用 --env <独立 env 文件>（或 ATTACH_ENV_FILE）指向临时 data 的 relay。",
  ].join("\n");
}

/** 远端 relay 已显式放行：醒目警告（不退出） */
function printRemoteRelayWarning(relayUrl, envPath) {
  console.warn("⚠️  [attach] 正在连接非本地 relay：" + String(relayUrl));
  console.warn("⚠️  [attach] env 文件：" + envPath + "；确认这是显式部署/冒烟目标，不是本地真实测试。");
}

/** 文件里任一非空设备编号都算已配置。后面的空赋值不会把它清掉（与 start-pi.cmd 一致）。 */
function deviceIdInText(text) {
  let found = "";
  const src = String(text || "").replace(/^\uFEFF/, "");
  for (const line of src.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i <= 0) continue;
    if (s.slice(0, i).trim() !== "PI_REMOTE_DEVICE_ID") continue;
    const value = unescapeEnvValue(s.slice(i + 1));
    if (value) found = value;
  }
  return found;
}

function splitProjects(value) {
  return String(value || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadConfig(envPath, environ = process.env, platform = HOST_PLATFORM) {
  let fileVars = {};
  if (envPath && fs.existsSync(envPath)) {
    fileVars = parseEnv(fs.readFileSync(envPath, "utf8"));
  }
  const pick = (key, dflt = "") => {
    const fromFile = fileVars[key];
    if (fromFile != null && String(fromFile).trim() !== "") return String(fromFile).trim();
    const fromEnv = environ[key];
    if (fromEnv != null && String(fromEnv).trim() !== "") return String(fromEnv).trim();
    return dflt;
  };
  const deviceName = defaultDeviceName(platform);
  return {
    relay: pick("PI_REMOTE_RELAY"),
    token: pick("PI_REMOTE_TOKEN"),
    deviceToken: pick("PI_REMOTE_DEVICE_TOKEN"),
    accountId: pick("PI_REMOTE_ACCOUNT", "admin") || "admin",
    deviceId: pick("PI_REMOTE_DEVICE_ID"),
    deviceName: pick("PI_REMOTE_DEVICE_NAME", deviceName) || deviceName,
    projects: splitProjects(pick("PI_REMOTE_PROJECTS")),
    launcher: pick("PI_REMOTE_LAUNCHER"),
    terminalApp: pick("PI_REMOTE_TERMINAL_APP"),
    keepAwake: keepAwakeWanted(pick("PI_REMOTE_KEEP_AWAKE"), platform),
    // P9 C：网页能浏览/能在下面新建会话的根目录（空 = 家目录；off/0/false = 关闭）
    browseRoots: parseBrowseRoots(pick("PI_REMOTE_BROWSE_ROOTS"), platform),
    // P9 B：反向同步扫描间隔（空 = 30s；控制器里再夹下限 5s）
    libraryRescanMs: pick("PI_REMOTE_LIBRARY_RESCAN_MS"),
    // 空 = 用平台缺省（macOS Terminal 4000ms、Windows 新控制台 6000ms，其余不等）；0 = 显式关掉等待
    launchWaitMs: pick("PI_REMOTE_LAUNCH_WAIT_MS"),
  };
}

/**
 * .env 里有共享令牌或设备令牌：统一 0600。
 * 收紧失败时直接报错，不能留下同机其他用户可读的令牌文件。
 */
function restrictEnvFileMode(envPath) {
  try {
    fs.chmodSync(envPath, 0o600);
  } catch (e) {
    throw new Error(`无法把 ${envPath} 的权限收紧到 0600（里面有令牌）：${e && e.message ? e.message : e}`);
  }
}

/**
 * 没配 deviceId 时追加 .env 片段（uuid + 显示名 + 缺省账户/relay）。
 * 文件里已有非空编号，或环境变量里已有编号，则原文件不动，不另生成一个。
 * 无论新建还是追加，落盘后都收紧到 0600（里面可能有共享令牌）。
 */
function initEnvFile(envPath, opts = {}) {
  const environ = opts.env || process.env;
  const platform = opts.platform || HOST_PLATFORM;
  const uuid = opts.uuid || crypto.randomUUID();
  let text = "";
  if (fs.existsSync(envPath)) {
    // 已有 .env 可能带着 0644：--init 时顺手收紧，早退分支也不漏
    restrictEnvFileMode(envPath);
    text = fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "");
  }
  const fromFile = deviceIdInText(text);
  if (fromFile) return { changed: false, deviceId: fromFile };
  const fromEnv = environ && environ.PI_REMOTE_DEVICE_ID != null ? String(environ.PI_REMOTE_DEVICE_ID).trim() : "";
  if (fromEnv) return { changed: false, deviceId: fromEnv };
  const vars = parseEnv(text);
  const lines = [`PI_REMOTE_DEVICE_ID=${uuid}`];
  if (!vars.PI_REMOTE_ACCOUNT || !String(vars.PI_REMOTE_ACCOUNT).trim()) lines.push("PI_REMOTE_ACCOUNT=admin");
  if (!vars.PI_REMOTE_DEVICE_NAME || !String(vars.PI_REMOTE_DEVICE_NAME).trim()) {
    const display = String(opts.deviceName || "").trim() || defaultDeviceName(platform);
    lines.push(`PI_REMOTE_DEVICE_NAME=${display}`);
  }
  if (!vars.PI_REMOTE_RELAY || !String(vars.PI_REMOTE_RELAY).trim()) lines.push("PI_REMOTE_RELAY=ws://127.0.0.1:7001");
  const prefix = text && !text.endsWith("\n") ? "\n" : "";
  const block = `${prefix}\n# pi-remote attach --init\n${lines.join("\n")}\n`;
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  // 新建时就用 0600（appendFileSync 在文件不存在时按 mode 创建），追加后统一再 chmod 一次
  fs.appendFileSync(envPath, block, { encoding: "utf8", mode: 0o600 });
  restrictEnvFileMode(envPath);
  return { changed: true, deviceId: uuid };
}

/**
 * 把若干键写进 .env：已有的（非注释）行就地替换，没有的追加到末尾。保留原文件的换行风格（Windows 上是 CRLF）。
 * 里面有令牌，所以不沿用旧权限：新建和改写都统一 0600。
 */
function writeEnvVars(envPath, vars) {
  let text = "";
  if (fs.existsSync(envPath)) {
    text = fs.readFileSync(envPath, "utf8");
  }
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  if (bom) text = text.slice(1);
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const lines = text ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const pending = new Map(Object.entries(vars));
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq <= 0) continue;
    const key = s.slice(0, eq).trim();
    if (!Object.prototype.hasOwnProperty.call(vars, key)) continue;
    lines[i] = `${key}=${vars[key]}`;
    pending.delete(key);
  }
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const tmp = `${envPath}.${process.pid}.tmp`;
  try {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, bom + lines.join(eol) + eol, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, envPath);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw e;
  }
  restrictEnvFileMode(envPath);
}

/* ---------- 设备身份钥（加密阶段 1 · attach 侧，设计 A §3.1/§3.2/§7） ----------
 * 钥文件与 .env 同目录（pi-remote-device.key.json，0600），格式：
 *   {v:1, deviceId, createdAt, sign:{alg:"ed25519",pub,priv}, box:{alg:"p256",pub,priv}, contentKeys?}
 * pub/priv 均为 der base64（pub=spki、priv=pkcs8）。私钥与 ACK 只许进这个文件：
 * .env 里只写一行路径 PI_REMOTE_DEVICE_KEY_FILE，钥料永不进 .env、永不打印。
 * 扩展侧将来读同一文件完成签名与 ACK 取用——读写函数都收在本段并导出，形状不许另立第二套。 */

const DEVICE_KEY_FILE_NAME = "pi-remote-device.key.json";
const DEVICE_KEY_PATH_VAR = "PI_REMOTE_DEVICE_KEY_FILE";

/** 公钥指纹：与 relay/util.js 的 keyFingerprint 同源同算法（公钥字节 SHA-256 前 8 字节 = 16 位 hex），两端对拍必须一致 */
function keyFingerprint(pub) {
  const buf = Buffer.isBuffer(pub) ? pub : Buffer.from(String(pub), "base64");
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

/** 指纹人读形态：与 relay/util.js 的 formatFingerprint 同口径（每 4 位 hex 一组空格分隔） */
function formatFingerprint(fp) {
  const hex = String(fp).replace(/[^0-9a-f]/gi, "").toLowerCase();
  return hex.replace(/(.{4})(?=.)/g, "$1 ");
}

/**
 * 钥文件路径解析：显式入参 > 环境变量 > .env 文件里的 PI_REMOTE_DEVICE_KEY_FILE > .env 同目录缺省名。
 * attach 落盘时只写绝对路径；手写相对路径按 .env 所在目录解析，不许随 cwd 漂移。
 */
function deviceKeyFilePath(envPath, opts = {}) {
  if (opts.keyFilePath) return path.resolve(String(opts.keyFilePath));
  const environ = opts.env || process.env;
  const fromEnv = environ && typeof environ[DEVICE_KEY_PATH_VAR] === "string" ? environ[DEVICE_KEY_PATH_VAR].trim() : "";
  if (fromEnv) return path.resolve(fromEnv);
  const dir = path.dirname(envPath || ENV_PATH);
  if (envPath && fs.existsSync(envPath)) {
    try {
      const vars = parseEnv(fs.readFileSync(envPath, "utf8"));
      const fromFile = typeof vars[DEVICE_KEY_PATH_VAR] === "string" ? vars[DEVICE_KEY_PATH_VAR].trim() : "";
      if (fromFile) return path.resolve(dir, fromFile);
    } catch {}
  }
  return path.join(dir, DEVICE_KEY_FILE_NAME);
}

/** 钥文件落盘：临时文件 + 0600 + rename（沿 writeEnvVars 的原子写纪律）；收紧失败直接报错，不降级成宽权限 */
function writeDeviceKeyFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw e;
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch (e) {
    throw new Error(`无法把 ${file} 的权限收紧到 0600（里面有私钥）：${e && e.message ? e.message : e}`);
  }
}

/** 把钥文件里的 der base64 还原成 KeyObject，并校验公钥确由私钥导出（不成对即坏钥）；校验失败抛错 */
function deviceKeyObjects(keys) {
  const signPriv = crypto.createPrivateKey({ key: Buffer.from(keys.sign.priv, "base64"), format: "der", type: "pkcs8" });
  const boxPriv = crypto.createPrivateKey({ key: Buffer.from(keys.box.priv, "base64"), format: "der", type: "pkcs8" });
  const signPub = crypto.createPublicKey(signPriv).export({ format: "der", type: "spki" }).toString("base64");
  const boxPub = crypto.createPublicKey(boxPriv).export({ format: "der", type: "spki" }).toString("base64");
  if (signPub !== keys.sign.pub || boxPub !== keys.box.pub) throw new Error("公钥与私钥对不上");
  return { signPriv, boxPriv };
}

const DEVICE_KEY_CORRUPT_HINT = "如确认要弃用这台设备的这套身份钥：先备份该文件，再删除它并重新配对（会生成新钥，旧钥登记随之失效）";

/**
 * 读钥文件并完整校验（形状 + 私钥可用 + 公私钥成对）：不存在返回 null；
 * 存在但损坏直接抛错并给处理办法——绝不静默当作无钥（静默回退等于把损坏伪装成新设备）。
 */
function loadDeviceKeys(file) {
  if (!fs.existsSync(file)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new Error(`设备钥文件损坏（${file}）：${e && e.message ? e.message : e}。${DEVICE_KEY_CORRUPT_HINT}`);
  }
  const bad = (why) => new Error(`设备钥文件形状不对（${file}）：${why}。${DEVICE_KEY_CORRUPT_HINT}`);
  if (!data || typeof data !== "object" || Array.isArray(data) || data.v !== 1) throw bad("缺 v:1");
  if (!data.sign || data.sign.alg !== "ed25519" || typeof data.sign.pub !== "string" || !data.sign.pub || typeof data.sign.priv !== "string" || !data.sign.priv) throw bad("sign 段缺失或算法不是 ed25519");
  if (!data.box || data.box.alg !== "p256" || typeof data.box.pub !== "string" || !data.box.pub || typeof data.box.priv !== "string" || !data.box.priv) throw bad("box 段缺失或算法不是 p256");
  if (data.contentKeys != null && (typeof data.contentKeys !== "object" || Array.isArray(data.contentKeys))) throw bad("contentKeys 不是对象");
  try {
    deviceKeyObjects(data);
  } catch (e) {
    throw bad("私钥不可用或与公钥不成对：" + (e && e.message ? e.message : e));
  }
  return data;
}

/**
 * Startup-gate helper: whether this install holds a usable identity key file
 * for the given deviceId. Key-paired devices are issued no token, so a valid
 * key file counts as a credential for the main() startup gate. A missing
 * file, a corrupt file, or a key file issued for a different deviceId does
 * NOT count — the gate must still refuse those installs.
 */
function hasUsableDeviceKey(envPath, deviceId) {
  if (!deviceId) return false;
  let keys = null;
  try {
    keys = loadDeviceKeys(deviceKeyFilePath(envPath));
  } catch {
    return false;
  }
  return !!(keys && keys.deviceId === deviceId);
}

/** 生成一套新身份钥的数据对象（DIK=Ed25519 签名、DBK=P-256 协商，设计 §2.1/§3.1；编码长度与协议 limits 对齐） */
function generateDeviceKeys(deviceId = "") {
  const sign = crypto.generateKeyPairSync("ed25519");
  const box = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const enc = (key, type) => key.export({ format: "der", type }).toString("base64");
  return {
    v: 1,
    deviceId: typeof deviceId === "string" ? deviceId : "",
    createdAt: Date.now(),
    sign: { alg: "ed25519", pub: enc(sign.publicKey, "spki"), priv: enc(sign.privateKey, "pkcs8") },
    box: { alg: "p256", pub: enc(box.publicKey, "spki"), priv: enc(box.privateKey, "pkcs8") },
  };
}

/**
 * 确保本机有身份钥：已有就读（损坏报错、绝不覆盖）；没有就生成并以 0600 落盘。
 * 返回 { file, keys, created }。deviceId 是生成当下已知的设备编号（可空，配对成功后由 persistPairResult 回填）。
 */
function ensureDeviceKeys(envPath, opts = {}) {
  const file = deviceKeyFilePath(envPath, opts);
  const existing = loadDeviceKeys(file);
  if (existing) return { file, keys: existing, created: false };
  const keys = generateDeviceKeys(typeof opts.deviceId === "string" ? opts.deviceId : "");
  writeDeviceKeyFile(file, keys);
  return { file, keys, created: true };
}

/**
 * 配对持有证明 PoP（设计 §3.2/§7）：用 DIK 对「裸配对码」签名——裸码指归一后的大写无横线码
 * （normalizePairCode 口径，与 relay/pairing.js 的 popPayload 同口径：签裸码的 UTF-8 字节），
 * 不加域分隔（§7 对 pop 只定到裸码；auth / key_update 的签名才有各自的域分隔串，不许混用）。
 * relay 用帧里同送的 signPub 对归一后的码验签，通过才登记公钥。入参必须是归一后的裸码。
 */
function signPairPop(keys, bareCode) {
  const { signPriv } = deviceKeyObjects(keys);
  return crypto.sign(null, Buffer.from(String(bareCode), "utf8"), signPriv).toString("base64");
}

/** 本机生成一枚配对码（带钥 pair_request 用）：字母表/长度与 relay 的 newPairCode 同源（协议 limits），随机源同为 crypto.randomInt */
function newDevicePairCode() {
  const { pairCodeLength, pairCodeAlphabet } = PROTOCOL.limits;
  let out = "";
  for (let i = 0; i < pairCodeLength; i++) out += pairCodeAlphabet[crypto.randomInt(pairCodeAlphabet.length)];
  return out;
}

/** 读某账号的 ACK（base64）；没有返回 ""。ACK 只从钥文件读，永不打印、永不进 .env */
function accountAckOf(keys, accountId) {
  const all = keys && keys.contentKeys && typeof keys.contentKeys === "object" ? keys.contentKeys : {};
  const v = all[accountId];
  return typeof v === "string" && v ? v : "";
}

/**
 * 写某账号的 ACK：先重新读盘再改再写——钥文件将来还有扩展侧同写，拿着旧快照整份覆写会把
 * 对方刚写进来的 ACK 冲掉；只动 contentKeys[accountId]，其余字段原样保留。返回最新钥对象。
 */
function storeAccountAck(file, accountId, ackB64) {
  const keys = loadDeviceKeys(file);
  if (!keys) throw new Error(`设备钥文件不存在（${file}），无法存账号内容钥`);
  const all = keys.contentKeys && typeof keys.contentKeys === "object" ? { ...keys.contentKeys } : {};
  all[accountId] = ackB64;
  keys.contentKeys = all;
  writeDeviceKeyFile(file, keys);
  return keys;
}

/**
 * 确保本机持有某账号的 ACK：已有直接返回；没有才生成 32B 随机并存入钥文件。
 * 只许由 finalizePairKeys 在「本设备是本账号首台钥设备」时调——ACK 全账号一把，
 * 各端各生成一把就是钥分叉，所以这个函数不许被随手调用；已有 ACK 时永不重生成。
 */
function ensureAccountAck(file, keys, accountId) {
  const have = accountAckOf(keys, accountId);
  if (have) return { ack: have, created: false, keys };
  const ack = crypto.randomBytes(32).toString("base64");
  const next = storeAccountAck(file, accountId, ack);
  return { ack, created: true, keys: next };
}

/** 配对成功后把 relay 签发的 deviceId 回填钥文件（生成钥时可能还没有编号）；先重新读盘再改，已一致不动文件 */
function syncDeviceKeyId(file, keys, deviceId) {
  if (!deviceId) return keys;
  const fresh = loadDeviceKeys(file) || keys;
  if (fresh.deviceId === deviceId) return fresh;
  fresh.deviceId = deviceId;
  writeDeviceKeyFile(file, fresh);
  return fresh;
}

/**
 * 钥形态配对成功后的 ACK 自持判定（设计 §8 阶段 1，persistPairResult 在 result.keyRegistered 时调）：
 * 「账号已有 ACK」的信号任一在场 → 本机不生成，保持无内容钥状态等交付/索取：contentKeyGrant
 * （持钥端正在交付）、ackFp（relay 所知本账号内容钥指纹）、hasKeyHolder（relay 报本次登记前
 * 本账号已有其他已登记公钥的设备——在册持钥端存在的代理信号；上线后桥走 content_key_request
 * 索取）。信号全缺席（旧 relay 也全缺席）→ 本机就是首台钥设备，生成并自持。
 * 本机已有该账号 ACK 时一律不动（ensureAccountAck 内部保证）。
 */
function finalizePairKeys(keyCtx, result) {
  const accountId = result.accountId || "admin";
  if (accountAckOf(keyCtx.keys, accountId)) return;
  if (result.contentKeyGrant || (typeof result.ackFp === "string" && result.ackFp)) return;
  if (result.hasKeyHolder === true) return;
  keyCtx.keys = ensureAccountAck(keyCtx.file, keyCtx.keys, accountId).keys;
}

/** local 通道鉴权帧（attach 窗口）：有设备令牌就按设备鉴权；共享 token 照带，旧 relay 只认它 */
function attachAuthFrame({ token, deviceId, deviceToken, platform = HOST_PLATFORM }) {
  const frame = {
    type: "auth",
    role: "local",
    proto: PROTOCOL.proto,
    caps: CLIENT_CAPS.slice(),
    client: { kind: "attach", version: ATTACH_VERSION, platform: platformId(platform) },
  };
  if (deviceId && deviceToken) {
    frame.deviceId = deviceId;
    frame.deviceToken = deviceToken;
  }
  if (token) frame.token = token;
  return frame;
}

/** 挑战-签名的 clientNonce：16 字节随机 base64（relay 口径 16–64 字节，每次连接新生成一份） */
function newClientNonce() {
  return crypto.randomBytes(16).toString("base64");
}

/**
 * 钥模式鉴权帧（设计 §3.3）：带 keyFp 即走挑战路，按协议不带 deviceToken（带了反而会被
 * relay 当降级拒绝）；caps 在窗口既有能力上加 crypto.auth。clientNonce 由调用方生成并
 * 留存（应答签名要用同一份）；没传时本函数生成，调用方从返回帧的 clientNonce 读回。
 */
function attachKeyAuthFrame({ deviceId, keys, platform = HOST_PLATFORM, clientNonce }) {
  return {
    type: "auth",
    role: "local",
    proto: PROTOCOL.proto,
    caps: [...CLIENT_CAPS, "crypto.auth"],
    client: { kind: "attach", version: ATTACH_VERSION, platform: platformId(platform) },
    deviceId,
    keyFp: keyFingerprint(keys.sign.pub),
    clientNonce: clientNonce || newClientNonce(),
  };
}

/**
 * 挑战应答签名（设计 §3.3，与 relay/pairing.js 的 authPayload 同口径，两处不许漂移）：
 * Ed25519 签 域分隔串 "pi-remote-auth-v1" ‖ deviceId ‖ relayNonce ‖ clientNonce（nonce 均为原始字节）。
 */
function signAuthResponse(keys, deviceId, relayNonceB64, clientNonceB64) {
  const { signPriv } = deviceKeyObjects(keys);
  const payload = Buffer.concat([
    Buffer.from("pi-remote-auth-v1", "utf8"),
    Buffer.from(String(deviceId), "utf8"),
    Buffer.from(String(relayNonceB64), "base64"),
    Buffer.from(String(clientNonceB64), "base64"),
  ]);
  return crypto.sign(null, payload, signPriv).toString("base64");
}

/**
 * pair_result 的成功形态判定（pair 与 pair_request 两条路径共用，不许各写一份）：
 *  - 令牌形态：带 deviceToken（旧 relay、或未走钥登记）——原样，与旧行为逐字节一致；
 *  - 钥形态（设计 §3.2/§7）：keyRegistered:true 且无 deviceToken。钥设备不再下发令牌，
 *    「没令牌」不是失败；contentKeyGrant / ackFp / hasKeyHolder 若在场原样带回（ACK 交付判定在落盘处）。
 * 都不满足 → 按失败归一 {ok:false, code, error}。
 */
function pairResultFromMsg(msg) {
  if (!msg || msg.type !== "pair_result") return null;
  if (msg.ok && typeof msg.deviceId === "string" && msg.deviceId) {
    if (typeof msg.deviceToken === "string" && msg.deviceToken) {
      return { ok: true, accountId: msg.accountId || "admin", deviceId: msg.deviceId, deviceToken: msg.deviceToken };
    }
    if (msg.keyRegistered === true) {
      const out = { ok: true, accountId: msg.accountId || "admin", deviceId: msg.deviceId, deviceToken: "", keyRegistered: true };
      if (msg.contentKeyGrant && typeof msg.contentKeyGrant === "object") out.contentKeyGrant = msg.contentKeyGrant;
      if (typeof msg.ackFp === "string" && msg.ackFp) out.ackFp = msg.ackFp;
      if (typeof msg.hasKeyHolder === "boolean") out.hasKeyHolder = msg.hasKeyHolder;
      return out;
    }
  }
  return { ok: false, code: msg.code || "pair_invalid", error: msg.error || PROTOCOL.errors.pair_invalid.message };
}

/**
 * 配对：连 relay 的 7001，第一帧发 pair{code, device}，等 pair_result。
 * 成功返回 {ok, accountId, deviceId, deviceToken}（钥形态另带 keyRegistered:true、deviceToken 为空）；
 * 失败返回 {ok:false, code, error}。不写文件，由调用方落盘。
 * deviceKeys 在场时帧里带 keys{signPub, boxPub, pop}（设计 §7）；旧 relay 不认 keys 字段、
 * 照旧回令牌形态，本函数两种都收——新 attach × 旧 relay 的行为与今天一致。
 */
function requestPairing({ relay, code, deviceId, deviceName, deviceToken, deviceKeys, platform = HOST_PLATFORM, WebSocketImpl, timeoutMs = PAIR_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let WS = WebSocketImpl;
    if (!WS) {
      try {
        WS = require("ws");
      } catch (e) {
        resolve({ ok: false, code: "internal", error: "无法加载 ws：" + (e && e.message ? e.message : e) });
        return;
      }
    }
    let done = false;
    let ws;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws && ws.close();
      } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, code: "timeout", error: "relay 没有回应配对请求" }), timeoutMs);
    try {
      ws = new WS(relay);
    } catch (e) {
      finish({ ok: false, code: "offline", error: "连不上 relay：" + (e && e.message ? e.message : e) });
      return;
    }
    const device = { name: deviceName || defaultDeviceName(platform), platform: platformId(platform) };
    if (deviceId) device.id = deviceId;
    // 码在本机先归一（CLI 路径 parseArgs 已归一，直接调本函数的可能带展示形态 XXXX-XXXX）：
    // relay 按归一码查表、按归一码验 pop，两处必须同口径；归一失败的怪码原样发，让 relay 按旧路回 pair_invalid
    let frameCode = String(code == null ? "" : code);
    try {
      frameCode = normalizePairCode(frameCode);
    } catch {}
    const onOpen = () => {
      try {
        const frame = { type: "pair", proto: PROTOCOL.proto, code: frameCode, device };
        // 重新配对已有设备时 relay 要求出示旧设备令牌；首次配对/撤销后重配没有令牌也能过
        if (deviceToken) frame.deviceToken = String(deviceToken);
        // 钥登记（设计 §7）：pop 签归一后的裸码，relay 验签通过才登记公钥
        if (deviceKeys) frame.keys = { signPub: deviceKeys.sign.pub, boxPub: deviceKeys.box.pub, pop: signPairPop(deviceKeys, frameCode) };
        ws.send(JSON.stringify(frame));
      } catch (e) {
        finish({ ok: false, code: "offline", error: "发送配对请求失败：" + (e && e.message ? e.message : e) });
      }
    };
    const onMessage = (data) => {
      let msg;
      try {
        msg = JSON.parse(typeof data === "string" ? data : String(data));
      } catch {
        return;
      }
      if (!msg) return;
      if (msg.type === "pair_result") {
        finish(pairResultFromMsg(msg));
        return;
      }
      if (msg.type === "error" && msg.code === "unknown_type") {
        finish({ ok: false, code: "unsupported", error: "relay 版本太旧，不支持配对（先升级服务器上的 relay）" });
      }
    };
    const onClose = () => finish({ ok: false, code: "offline", error: "relay 关闭了连接，没有给出配对结果" });
    if (typeof ws.on === "function") {
      ws.on("open", onOpen);
      ws.on("message", onMessage);
      ws.on("close", onClose);
      ws.on("error", () => {});
    } else {
      ws.onopen = onOpen;
      ws.onmessage = (ev) => onMessage(ev && ev.data !== undefined ? ev.data : ev);
      ws.onclose = onClose;
      ws.onerror = () => {};
    }
  });
}

function pairHint(platform = HOST_PLATFORM) {
  return platform === "win32" ? "node deploy\\attach.cjs --pair <配对码>" : "deploy/attach.sh --pair <配对码>";
}

/** 扫码链接命令：与 pairHint 并列的第二条配对路径（pi 运行端出示二维码，手机确认） */
function linkHint(platform = HOST_PLATFORM) {
  return platform === "win32" ? "node deploy\\attach.cjs --link" : "deploy/attach.sh --link";
}

/** 本机自检命令：启动失败时要指给用户看的那条 */
function doctorHint(platform = HOST_PLATFORM) {
  return platform === "win32" ? "node deploy\\attach.cjs --doctor" : "deploy/attach.sh --doctor";
}

/** macOS 的电脑名：默认设备名用 "Mac" 时，两台 Mac 在名册里分不出来 */
function macComputerName(spawnSyncImpl = spawnSync) {
  if (process.platform !== "darwin") return "";
  try {
    const r = spawnSyncImpl("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 });
    const name = r && !r.error && r.status === 0 ? String(r.stdout || "").trim() : "";
    if (name) return name;
  } catch {}
  return String(os.hostname() || "").replace(/\.local$/, "");
}

function defaultAttachFile(environ = process.env) {
  const override = environ.PI_REMOTE_ATTACH_FILE;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  return path.join(os.homedir(), ".pi", "agent", "remote-attach.json");
}

function sessionRootFromEnv(environ = process.env) {
  const custom = environ.PI_CODING_AGENT_SESSION_DIR;
  if (custom && String(custom).trim()) return path.resolve(String(custom).trim());
  return path.join(os.homedir(), ".pi", "agent", "sessions");
}

/**
 * pi 会话目录名：去掉首部斜杠，把 / \ : 换成 -，再包一层 --。
 * D:\pi-myself → --D--pi-myself--；/Users/user/CLI/Pi-Remote → --Users-user-CLI-Pi-Remote--（按真实路径，/tmp 记作 --private-tmp--）
 */
function encodeCwdDir(cwd, platform = HOST_PLATFORM) {
  const resolved = realDir(cwd, platform);
  const body = resolved.replace(/^[\\/]+/, "").replace(/[\\/:]/g, "-");
  return `--${body}--`;
}

const SPAWN_CLAIM_MS = 10 * 60 * 1000;

function normalizeDir(p, platform = HOST_PLATFORM) {
  if (p == null) return "";
  const raw = String(p).trim();
  if (!raw || unsafePath(raw, platform)) return "";
  let resolved;
  try {
    resolved = realDir(raw, platform);
  } catch {
    return "";
  }
  resolved = platform === "win32" ? resolved.replace(/[\\/]+$/, "") : resolved.replace(/\/+$/, "");
  return caseInsensitivePaths(platform) ? resolved.toLowerCase() : resolved;
}

function cwdAllowed(cwd, projects, platform = HOST_PLATFORM) {
  const key = normalizeDir(cwd, platform);
  if (!key) return false;
  return (projects || []).some((p) => normalizeDir(p, platform) === key);
}

function parseHarnessArgs(args) {
  const src = args && typeof args === "object" ? args : {};
  const cwd = src.cwd == null ? "" : String(src.cwd).trim();
  const sessionId = src.sessionId == null ? "" : String(src.sessionId).trim();
  const hasCwd = cwd !== "";
  const hasSid = sessionId !== "";
  if (hasCwd === hasSid) return { ok: false, error: "参数错误：cwd 与 sessionId 必须二选一" };
  if (hasCwd) return { ok: true, cwd };
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return { ok: false, code: "session_not_found", error: "这台设备上没有这个会话" };
  return { ok: true, sessionId };
}

let sessionManagerApi;
async function loadSessionManager() {
  if (sessionManagerApi !== undefined) return sessionManagerApi;
  try {
    const pkg = await import("@earendil-works/pi-coding-agent");
    const SM = pkg && (pkg.SessionManager || (pkg.default && pkg.default.SessionManager));
    sessionManagerApi = SM && typeof SM.list === "function" ? SM : null;
  } catch {
    sessionManagerApi = null;
  }
  return sessionManagerApi;
}

/** 优先 SessionManager.list；当前 node 解析不到 pi 包时，退回会话目录文件名。 */
const SESSION_LOOKUP_TTL_MS = 30 * 1000;
const sessionListCache = new Map();

/** SessionManager.list 同步 stat 全目录：项目多时每次都跑一遍，10s 的 harness 超时很容易被吃光。按目录缓存 30s。 */
async function listSessionsCached(SM, dir, fresh = false) {
  const hit = sessionListCache.get(dir);
  if (!fresh && hit && Date.now() - hit.at < SESSION_LOOKUP_TTL_MS) return hit.list;
  const list = (await SM.list(dir)) || [];
  sessionListCache.set(dir, { at: Date.now(), list });
  return list;
}

async function defaultSessionLookup(sessionId, projects, root, smOverride, platform = HOST_PLATFORM) {
  const SM = smOverride !== undefined ? smOverride : await loadSessionManager();
  if (SM) {
    // 先查缓存；没命中再强制刷新一遍（刚新建不到 30s 的会话不在缓存里）
    for (const fresh of [false, true]) {
      for (const dir of projects || []) {
        let list = [];
        try {
          list = await listSessionsCached(SM, dir, fresh);
        } catch {
          continue;
        }
        for (const row of list) {
          if (!row || row.deleted || String(row.id) !== String(sessionId) || !row.path) continue;
          return { id: String(row.id), path: String(row.path), cwd: row.cwd ? String(row.cwd) : pathApi(platform).resolve(String(dir)), deleted: false };
        }
      }
    }
    return null;
  }
  return findSessionFile(sessionId, projects, root, platform);
}

/**
 * 在白名单项目对应的会话目录里按文件名找 `<timestamp>_<sessionId>.jsonl`。
 * 只匹配文件名，不读对话正文。
 */
function findSessionFile(sessionId, projects, root, platform = HOST_PLATFORM) {
  const id = String(sessionId || "");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const base = root || sessionRootFromEnv();
  for (const dir of projects || []) {
    if (!dir || unsafePath(dir, platform)) continue;
    let folder;
    try {
      folder = path.join(base, encodeCwdDir(dir, platform));
    } catch {
      continue;
    }
    let names = [];
    try {
      names = fs.readdirSync(folder);
    } catch {
      continue;
    }
    const hit = names.find((name) => name === `${id}.jsonl` || name.endsWith(`_${id}.jsonl`));
    if (!hit) continue;
    return { id, path: path.join(folder, hit), cwd: pathApi(platform).resolve(String(dir)), deleted: false };
  }
  return null;
}

/**
 * P9 B：在整个会话根目录里按 sessionId 找会话文件（不再只查白名单项目）。
 * 只认 root/* 下一层目录里的 `<时间戳>_<id>.jsonl` / `<id>.jsonl`；文件名匹配，不读正文；
 * 文件本身必须 lstat 是普通文件（符号链接文件不收，防止拿链接指到根目录外面）。
 * 目录项若本身是符号链接会跟进去看一眼：真正的 jail 在调用方用 realpath 判（insideDir）。
 */
function findSessionFileAnywhere(root, sessionId, platform = HOST_PLATFORM) {
  const id = String(sessionId || "");
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) return null;
  const base = root || sessionRootFromEnv();
  let dirs = [];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return null;
  }
  const want = `${id}.jsonl`;
  const suffix = `_${id}.jsonl`;
  for (const dirent of dirs) {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
    const folder = path.join(base, dirent.name);
    if (!isDirSafe(folder)) continue;
    let names = [];
    try {
      names = fs.readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name !== want && !name.endsWith(suffix)) continue;
      const full = path.join(folder, name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isFile()) return full;
    }
  }
  return null;
}

/** 从 `<时间戳>_<sessionId>.jsonl` 文件名取出 id（只认文件名，不读正文）。 */
function sessionIdFromFileName(file) {
  const base = path.basename(String(file || "")).replace(/\.jsonl$/i, "");
  if (!base) return "";
  const i = base.lastIndexOf("_");
  const id = i >= 0 ? base.slice(i + 1) : base;
  return /^[A-Za-z0-9_-]{1,200}$/.test(id) ? id : "";
}

/** 只读会话文件第一行（pi 的 session 头），拿不到/坏行返回 null。 */
function readSessionHeader(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const line = buf.slice(0, n).toString("utf8").split(/\r?\n/, 1)[0];
    const header = JSON.parse(line);
    return header && typeof header === "object" ? header : null;
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/** P9 C：按 sessionId 在全根里找会话文件，并从会话头读出 cwd（拉起时用）。 */
function defaultSessionFindAnywhere(sessionId, platform = HOST_PLATFORM) {
  const file = findSessionFileAnywhere(sessionRootFromEnv(), sessionId, platform);
  if (!file) return null;
  const header = readSessionHeader(file);
  const cwd = header && header.cwd ? String(header.cwd) : "";
  if (!cwd) return null;
  return { id: String(sessionId), path: file, cwd, deleted: false };
}

/**
 * realpath 之后的包含判定（P9 B 的路径监狱）：target 必须在 root 里（含相等）。
 * 两个参数都应是 fs.realpathSync.native 的结果；大小写按平台，Windows 分隔符也认 /。
 */
function insideDir(target, root, platform = HOST_PLATFORM) {
  const t = String(target || "");
  const r = String(root || "");
  if (!t || !r) return false;
  const trim = (p) => (platform === "win32" ? p.replace(/[\\/]+$/, "") : p.replace(/\/+$/, ""));
  const ci = caseInsensitivePaths(platform);
  const a = trim(ci ? t.toLowerCase() : t);
  const b = trim(ci ? r.toLowerCase() : r);
  if (!a || !b) return false;
  if (a === b) return true;
  const sep = platform === "win32" ? "\\" : "/";
  const alt = platform === "win32" ? "/" : null;
  return a.startsWith(b + sep) || (alt !== null && a.startsWith(b + alt));
}

/** PATH 里第一个可执行的 trash 的完整路径（Windows 也找 trash.exe / trash.cmd / trash.bat）；没有返回 ""。 */
function findTrashCommand(platform = HOST_PLATFORM, environ = process.env) {
  const raw = String((environ && (environ.PATH || environ.Path || environ.path)) || "");
  if (!raw) return "";
  const dirs = raw.split(platform === "win32" ? ";" : path.delimiter);
  const names = platform === "win32" ? ["trash.exe", "trash.cmd", "trash.bat", "trash"] : ["trash"];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = pathApi(platform).join(dir, name);
      if (!fs.existsSync(candidate)) continue;
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return "";
}

function hasTrashCommand(platform = HOST_PLATFORM, environ = process.env) {
  return findTrashCommand(platform, environ) !== "";
}

/**
 * 执行 trash。Windows 的 npm 全局 trash 是 trash.cmd 批处理 shim，CreateProcess 不能直接起
 * （Node 会报 EINVAL），必须经 cmd.exe；目标路径走环境变量传入，避免路径里的 % 被 cmd 再展开。
 */
function runTrash(trash, target, platform, environ) {
  const args = target.startsWith("-") ? ["--", target] : [target];
  const opts = { encoding: "utf8", timeout: 10000, env: environ };
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(trash)) return spawnSync(trash, args, opts);
  const env = { ...(environ || process.env), PI_REMOTE_TRASH_TARGET: target };
  const comspec = String((environ && environ.ComSpec) || process.env.ComSpec || "cmd.exe");
  const quote = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const line = quote(trash) + (target.startsWith("-") ? " --" : "") + ' "%PI_REMOTE_TRASH_TARGET%"';
  return spawnSync(comspec, ["/d", "/s", "/c", `"${line}"`], { ...opts, env, windowsVerbatimArguments: true });
}

/**
 * 和 pi 删除会话文件一样的动作（P9 B/C，扩展里有一份同逻辑的）：
 * 有 trash 就先 trash（参数按 pi 的写法处理 - 开头的文件名），失败或不在了再 unlink。
 */
function deleteLikePi(file, platform = HOST_PLATFORM, environ = process.env) {
  const target = String(file || "");
  const trash = findTrashCommand(platform, environ);
  if (trash) {
    let r = null;
    try {
      r = runTrash(trash, target, platform, environ);
    } catch (e) {
      r = { error: e };
    }
    const ran = r && !r.error;
    if (ran && (r.status === 0 || !fs.existsSync(target))) return { ok: true, method: "trash" };
  }
  try {
    fs.unlinkSync(target);
    return { ok: true, method: "unlink" };
  } catch (e) {
    const code = e && e.code;
    return {
      ok: false,
      error: code === "EACCES" || code === "EPERM" ? "没有权限删除这个文件" : "删除失败：" + (e && e.message ? e.message : e),
    };
  }
}

/** session_archive 帧里只放正文摘要：路径与本机文件元数据不过线。 */
function archiveBody(archive) {
  const session = { ...archive };
  delete session.path;
  delete session.modified;
  delete session.sizeBytes;
  delete session.createdAt;
  delete session.updatedAt;
  delete session.parentSession;
  return session;
}

/**
 * Crypto Phase 3: seal one text under the account content key (ACK).
 * The envelope payload is base64( nonce(12) || AES-256-GCM(ACK, utf8(text)) || tag(16) ),
 * the same ACK-level layout the web end opens (decryptCtText) and the
 * extension produces for firstMessage previews. The nonce is fresh random
 * per seal and never reused.
 */
function sealAckText(ack, text) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ack, nonce);
  const ct = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64");
}

/**
 * Crypto Phase 3: the on-the-wire form of a session_archive payload.
 * Without an ACK (legacy token device) this is exactly archiveBody(archive),
 * byte for byte. With an ACK the body travels as one whole sealed blob
 * (design 4.1: the archive body is content, relay only forwards/caches
 * ciphertext): a session-level { enc:1, ct } whose plaintext is the JSON of
 * { messages }, an empty messages array on the outside (consumers gate on
 * it before decrypting), the tier-b metadata (id/cwd/name/counts) left in
 * the clear, and firstMessage replaced by its own ACK envelope { enc:1, ct }.
 * The local archive object is never mutated -- attach's own window/status
 * surfaces keep working on the plaintext in memory.
 */
function archiveWireBody(archive, ack) {
  const body = archiveBody(archive);
  if (!ack) return body;
  const sealed = { ...body, messages: [], enc: 1, ct: sealAckText(ack, JSON.stringify({ messages: body.messages })) };
  if (typeof body.firstMessage === "string" && body.firstMessage) {
    sealed.firstMessage = { enc: 1, ct: sealAckText(ack, body.firstMessage) };
  }
  return sealed;
}

/**
 * Crypto Phase 3: the on-the-wire form of one session_manifest row.
 * Without an ACK this is exactly manifestRow(archive), byte for byte. With
 * an ACK the preview is a body slice (design 4.1), so it must not cross in
 * plaintext: it travels as an ACK-level envelope in firstMessageEnc -- the
 * same field and shape the extension's manifest rows use -- and the
 * plaintext firstMessage is nulled. The rest of the row is tier-b metadata
 * and stays in the clear.
 */
function manifestWireRow(archive, ack) {
  const row = manifestRow(archive);
  if (!ack) return row;
  if (typeof row.firstMessage === "string" && row.firstMessage) {
    row.firstMessageEnc = { enc: 1, ct: sealAckText(ack, row.firstMessage) };
    row.firstMessage = null;
  }
  return row;
}

/**
 * P1-4：正文读不出来的会话文件也要出现在带 scope:"device" 的全量清单里，
 * 否则 relay 对账会当成「设备上已经删掉了」，打墓碑并清副本，可文件还在磁盘上。
 * P9 第 2 轮审查 BUG-2：兜底行**只带 id / path / updatedAt**，其余字段一律不写（undefined，不是 null/""/0）。
 * relay 的 `_sessionFrom` 对缺省字段沿用旧行；写了空值会把索引里的名字、cwd、消息数、
 * 大小、创建时间全清掉（网页上会话丢标题、跑进 cwd 为空的组）。
 *
 * P9 第 3 轮审查 R3-1：`updatedAt` 必须带**文件真实 mtime**。不带的话 relay 会用帧时间代替，
 * 读不出的会话每次 attach 重发清单时都会在列表里显示「刚刚」并排到最前面；带了 mtime 后
 * `take()` 会把它和旧行比较（更旧则整行跳过），时间不再跳。stat 拿不到 mtime 时就不写该字段。
 */
function fallbackManifestRow(file, id, mtimeMs) {
  const row = {
    id: String(id),
    path: String(file || ""),
  };
  const updatedAt = Number(mtimeMs);
  if (Number.isFinite(updatedAt) && updatedAt > 0) row.updatedAt = updatedAt;
  return row;
}

/**
 * 拉起方式（PI_REMOTE_LAUNCHER）：Windows 固定 console（新控制台）；
 * macOS 默认 terminal（Terminal 新窗口），可设 tmux；Linux 只有 tmux。
 * 不认识或本平台不支持的值回到缺省，并给出 warning。
 */
function resolveLauncher(value, platform = HOST_PLATFORM) {
  const want = String(value || "").trim().toLowerCase();
  if (platform === "win32") {
    return { launcher: "console", warning: want && want !== "console" ? `Windows 只支持新控制台，忽略 PI_REMOTE_LAUNCHER=${want}` : "" };
  }
  const fallback = platform === "darwin" ? "terminal" : "tmux";
  if (!want) return { launcher: fallback, warning: "" };
  if (want === "tmux") return { launcher: "tmux", warning: "" };
  if (want === "terminal" && platform === "darwin") return { launcher: "terminal", warning: "" };
  return { launcher: fallback, warning: `本机不支持 PI_REMOTE_LAUNCHER=${want}，改用 ${fallback}` };
}

/** POSIX 单引号转义：'a'\''b' */
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * 显示用路径：还原外层（shell / tmux 格式）留下的 `\$`，只用于打印。
 * P13 deploy 低-3：设备列表/窗口输出里照着复制的路径不能带转义反斜杠；
 * 命令执行、白名单比较、状态文件一律用原值。
 */
function displayPathOf(p) {
  return String(p == null ? "" : p).replace(/\\\$/g, "$");
}

function tmuxSessionName(cwd, platform = HOST_PLATFORM) {
  const slug = (pathApi(platform).basename(String(cwd)) || "pi").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 32) || "pi";
  return `pi-${slug}-${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
}

/** tmux 把以 ; 结尾的参数当命令分隔符：末尾的 ; 要写成 \; 才是字面量 */
function tmuxArg(a) {
  const s = String(a);
  return s.endsWith(";") ? s.slice(0, -1) + "\\;" : s;
}

/** 找不到 tmux 返回 null。remain-on-exit failed 从 3.2 起才有；认不出版本号（master 之类）按新版处理 */
function probeTmux(spawnSyncImpl = spawnSync) {
  let r;
  try {
    r = spawnSyncImpl("tmux", ["-V"], { encoding: "utf8", timeout: 5000 });
  } catch {
    return null;
  }
  if (!r || r.error || r.status !== 0) return null;
  const version = String(r.stdout || "").trim();
  const m = /(\d+)\.(\d+)/.exec(version);
  return { version, keepFailed: !m || Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 2) };
}

function buildSpawnSpec({ cwd, sessionPath, startPi, platform = HOST_PLATFORM, launcher, terminalApp, scriptDir, keepFailed = false, exitHome = "", exitFile = "" }) {
  const piArgs = sessionPath ? ["--session", sessionPath] : [];
  if (platform === "win32") {
    return {
      file: "cmd.exe",
      args: ["/c", "start", "", "/D", cwd, startPi, ...piArgs],
      options: {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        cwd,
      },
    };
  }
  const mode = resolveLauncher(launcher, platform).launcher;
  if (mode === "tmux") {
    // 命令拆成多个参数：tmux 直接 exec，不经 sh -c，路径里的空格、引号、$ 都不会被再解析（只有末尾的 ; 要转义）
    const session = tmuxSessionName(cwd, platform);
    // tmux 3.4 约四成概率丢 #{pane_dead_status}：拉起时把退出码落盘文件注入 start-pi.sh，读侧再按"窗格优先、落盘回落"
    const codeFile = exitFile || (exitHome ? exitCodePath(session, exitHome) : "");
    const command = codeFile
      ? ["/usr/bin/env", `PI_REMOTE_EXIT_FILE=${codeFile}`, "/bin/bash", startPi, ...piArgs]
      : ["/bin/bash", startPi, ...piArgs];
    const args = ["new-session", "-d", "-s", session, "-c", cwd, ...command].map(tmuxArg);
    // 同一条命令里设，pi 再快退出也赶得上：失败退出的窗格留着（tmux attach 看得到原因），正常退出照常收掉
    if (keepFailed) args.push(";", "set-option", "-w", "-t", `=${session}:`, "remain-on-exit", "failed");
    return {
      file: "tmux",
      args,
      options: { detached: true, stdio: "ignore", cwd },
      tmuxSession: session,
      exitFile: codeFile,
    };
  }
  // Terminal 只接受脚本文件：一次性 .command，第一行就删掉自己；路径一律单引号转义
  const file = path.join(scriptDir || os.tmpdir(), `pi-remote-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}.command`);
  const lines = [
    "#!/bin/bash",
    'rm -f -- "$0"',
    `cd -- ${shellQuote(cwd)} || exit 1`,
  ];
  if (exitFile) lines.push(`export PI_REMOTE_EXIT_FILE=${shellQuote(exitFile)}`);
  lines.push(`exec /bin/bash ${[startPi, ...piArgs].map(shellQuote).join(" ")}`, "");
  return {
    file: "open",
    args: ["-a", terminalApp || "Terminal", file],
    options: { detached: true, stdio: "ignore", cwd },
    script: { path: file, text: lines.join("\n"), mode: 0o700 },
    exitFile: exitFile || "",
  };
}

/**
 * 设备登记帧。trash / browse / features 是 P9 的新字段：
 *   trash    PATH 里有没有 trash（网页据此写删除确认文案）
 *   browse   { roots } 浏览根目录；空数组 = 关闭浏览
 *   features 声明能力里 session.files / fs.browse 的交集（relay 也会按 auth caps 自己算一遍，带上方便排查）
 */
function deviceRegisterFrame({ accountId, deviceId, deviceName, projects, windowExpiresAt, platform = HOST_PLATFORM, trash = false, browse = null, features = null }) {
  const device = {
    id: deviceId,
    name: deviceName || defaultDeviceName(platform),
    platform: platformId(platform),
    projects: Array.isArray(projects) ? projects.slice() : [],
    trash: !!trash,
    windowExpiresAt,
  };
  if (browse && Array.isArray(browse.roots)) device.browse = { roots: browse.roots.slice() };
  if (Array.isArray(features)) device.features = features.slice();
  return {
    type: "device_register",
    accountId: accountId || "admin",
    device,
  };
}

function formatRemain(ms) {
  const safe = Math.max(0, Math.floor(Number(ms) || 0));
  const total = Math.floor(safe / 1000);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const p = (n) => String(n).padStart(2, "0");
  if (hh > 0) return `${p(hh)}:${p(mm)}`;
  return `${p(mm)}:${p(ss)}`;
}

function viewerUrlFromRelay(relay, viewerPort) {
  try {
    const u = new URL(relay);
    u.protocol = u.protocol === "wss:" || u.protocol === "https:" ? "https:" : "http:";
    // 端口可配（PI_REMOTE_VIEWER_PORT / --viewer-port）：原来写死 7002，自定义端口下提示的地址是错的
    u.port = String(viewerPort || 7002);
    u.pathname = "/";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return "http://127.0.0.1:7002/";
  }
}

function statusText({ connected, reconnecting, expiresAt, now, activeCount, viewer, authMode, keepAwake }) {
  const head = connected
    ? `设备已连接 · 剩余 ${formatRemain(expiresAt - now)} · 活动会话 ${activeCount} 个${authMode === "legacy" ? " · 共享令牌（建议配对）" : ""}${keepAwake ? " · 防休眠" : ""}`
    : reconnecting
      ? "重连中…"
      : "正在连接…";
  return `${head}\nviewer 地址 ${viewer}`;
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), "utf8");
  fs.renameSync(tmp, file);
}

function removeQuiet(file) {
  try {
    fs.unlinkSync(file);
  } catch {}
}

class AttachController {
  constructor(opts = {}) {
    const now = Number(opts.now) || Date.now();
    this.platform = opts.platform || HOST_PLATFORM;
    this.relay = opts.relay || "";
    this.token = opts.token || "";
    this.deviceToken = opts.deviceToken || "";
    /** 设备身份钥（阶段 1）：main() 从钥文件加载后传入；非空且有 deviceId 时窗口走挑战-签名鉴权，不再用令牌 */
    this.deviceKeys = opts.deviceKeys || null;
    /** Key file path (Phase 3): lets archive sealing re-read the file so an ACK the extension persisted after this window started is still picked up. */
    this.keyFilePath = opts.keyFilePath || "";
    /** 本次连接 auth 帧带出的 clientNonce：auth_challenge 回来时按它签名；每次 connect 新生成 */
    this.pendingClientNonce = "";
    /** relay 回的鉴权方式：token（设备令牌）/ legacy（共享令牌）；旧 relay 不回为 null */
    this.authMode = null;
    this.accountId = opts.accountId || "admin";
    this.deviceId = opts.deviceId || "";
    this.deviceName = opts.deviceName || defaultDeviceName(this.platform);
    const picked = resolveLauncher(opts.launcher, this.platform);
    this.launcher = picked.launcher;
    this.launcherWarning = picked.warning;
    this.terminalApp = opts.terminalApp || "Terminal";
    this.scriptDir = opts.scriptDir || null;
    /**
     * Terminal 拉起后等"会话真的上线"的上限。open 返回 0 只代表 Terminal 收下了脚本，
     * 不代表 pi 起来了：不等这一下，失败时网页要干等 60s 才知道，而且这个目录还会被
     * 占用标记挡住 10 分钟。0 = 不等待（老行为，测试用）。
     */
    this.launchWaitMs = opts.launchWaitMs != null
      ? Math.max(0, Number(opts.launchWaitMs) || 0)
      : this.platform === "win32"
        ? WIN_LAUNCH_WAIT_MS
        : (this.platform === "darwin" && picked.launcher === "terminal" ? TERMINAL_LAUNCH_WAIT_MS : 0);
    /** 正在等房间上线的拉起请求：{ kind: "cwd"|"session", key, resolve } */
    this.launchWaiters = new Set();
    this.claimGraceMs = opts.claimGraceMs != null ? Math.max(0, Number(opts.claimGraceMs) || 0) : TERMINAL_CLAIM_GRACE_MS;
    /** 软超时后的占用宽限计时器：key -> {timer, claim}；房间上线时取消，关闭窗口时一并清掉 */
    this.claimGraces = new Map();
    /** macOS 用 caffeinate、Linux 用 systemd-inhibit；缺省关，由 main() 按 .env 打开（测试不会意外起子进程） */
    this.keepAwake = opts.keepAwake === true && (this.platform === "darwin" || this.platform === "linux");
    this.awakeChild = null;
    /** 退出码落盘契约：本窗口自己的落盘文件 + 子 pi 的落盘目录（默认家目录，测试可指向沙箱） */
    this.env = opts.env || process.env;
    this.exitFile = String(opts.exitFile != null ? opts.exitFile : this.env.PI_REMOTE_EXIT_FILE || "").trim();
    this.exitHome = opts.exitHome || os.homedir();
    this._exitCodeWritten = false;
    /** tmux 客户端 locale 只探一次；undefined = 还没探，空串 = 探过但没有可注入的 UTF-8 locale */
    this.tmuxLocale = undefined;
    this._tmuxEnv = null;
    this.projects = Array.isArray(opts.projects) ? opts.projects.slice() : [];
    /**
     * P9 C：网页能浏览/能在下面新建会话的根目录。main() 从 loadConfig 传进来；
     * 直接构造控制器（测试、Linux device.cjs）时缺省为空 = 浏览关闭，绝不意外放开家目录。
     */
    this.browseRoots = Array.isArray(opts.browseRoots) ? opts.browseRoots.slice(0, BROWSE_ROOTS_MAX) : [];
    /** P9 B：反向同步状态——上次发出去的会话 id 集合 / 每个 id 的 mtime，以及扫描定时器 */
    this.publishedIds = new Set();
    this.publishedMtimes = new Map();
    /** P1-1：每个会话上次补发正文（session_archive）的时刻；10 分钟内不重复发 */
    this.archiveSentAt = new Map();
    this.rescanTimer = null;
    const rescanRaw = Number(opts.libraryRescanMs);
    this.libraryRescanMs = Number.isFinite(rescanRaw) && rescanRaw > 0 ? Math.max(LIBRARY_RESCAN_MIN_MS, rescanRaw) : LIBRARY_RESCAN_MS;
    this.dirs = Array.isArray(opts.dirs) ? opts.dirs.slice() : [];
    this.attachFile = opts.attachFile || defaultAttachFile();
    this.maxHours = Number(opts.maxHours) > 0 ? Number(opts.maxHours) : DEFAULT_MAX_HOURS;
    this.startedAt = now;
    this.expiresAt = now + Math.round(this.maxHours * 3600 * 1000);
    // viewer 端口可配（--viewer-port / PI_REMOTE_VIEWER_PORT），状态行提示的地址才对得上
    this.viewerPort = Number(opts.viewerPort) > 0 ? Number(opts.viewerPort) : (Number(process.env.PI_REMOTE_VIEWER_PORT) > 0 ? Number(process.env.PI_REMOTE_VIEWER_PORT) : 7002);
    /** 免服务器模式：状态行的 viewer 地址走管家的当前出示源（隧道网址/局域网地址会动态变）；缺省仍按 relay 推导 */
    this.viewerUrlProvider = typeof opts.viewerUrlProvider === "function" ? opts.viewerUrlProvider : null;
    /** 窗口关闭时的额外清理（免服务器模式管家回收子进程）；同步发起即可，控制器不等它完成 */
    this.onShutdown = typeof opts.onShutdown === "function" ? opts.onShutdown : null;
    this.startPi = opts.startPi || startPiFor(this.platform);
    /** sessionId 形态拉起的占用记录（按会话 id，不按目录）：id -> { at, tmuxSession? } */
    this.spawnedBySession = new Map();
    this.spawnImpl = opts.spawnImpl || spawn;
    /** tmux 拉起时查版本、查会话死活用（同步，几毫秒） */
    this.spawnSyncImpl = opts.spawnSyncImpl || spawnSync;
    this.tmuxInfo = null;
    this.tmuxSettleMs = opts.tmuxSettleMs != null ? Number(opts.tmuxSettleMs) : TMUX_SETTLE_MS;
    this.tmuxExitWaitMs = opts.tmuxExitWaitMs != null ? Number(opts.tmuxExitWaitMs) : TMUX_EXIT_WAIT_MS;
    this.WebSocketImpl = opts.WebSocketImpl || null;
    /**
     * P9 C：sessionId 形态拉起时在**整个会话根目录**里按 id 找文件（含会话头里的 cwd），
     * 不再只查白名单项目；测试可注入。
     */
    this.sessionLookup = opts.sessionLookup || ((id) => defaultSessionFindAnywhere(id, this.platform));
    this.existsDir = opts.existsDir || ((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
    this.exit = typeof opts.exit === "function" ? opts.exit : null;
    this.writeOut = typeof opts.writeOut === "function" ? opts.writeOut : (line) => console.log(line);
    this.bindSignals = opts.bindSignals === true;
    this.statusEnabled = opts.status !== false;
    this.stdout = opts.stdout || process.stdout;
    this.starting = false;
    this.spawnedByCwd = new Map();
    this.seenOnline = new Set();
    this.onlineRooms = [];
    this.connected = false;
    this.authed = false;
    this.reconnecting = false;
    this.ws = null;
    this.backoff = RECONNECT_MIN;
    this.reconnectTimer = null;
    this.statusTimer = null;
    this.expiryTimer = null;
    this.livenessTimer = null;
    this.lastTick = 0;
    /** 本条连接最后一次收到 relay 任何东西（帧、ping、pong）的时刻 */
    this.lastSeen = 0;
    this.closing = false;
    this.booted = false;
    this._statusLines = 0;
    this._onSignal = null;
  }

  registerFrame() {
    return deviceRegisterFrame({
      accountId: this.accountId,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      projects: this.projects,
      // P9 B/C：网页要用 trash 写删除文案、用 browse 判断能不能浏览文件夹
      trash: hasTrashCommand(this.platform),
      features: CLIENT_CAPS.filter((cap) => cap === "session.files" || cap === "fs.browse"),
      browse: { roots: this.browseRoots },
      windowExpiresAt: this.expiresAt,
      platform: this.platform,
    });
  }

  writeState() {
    writeJsonAtomic(this.attachFile, {
      pid: process.pid,
      deviceId: this.deviceId,
      accountId: this.accountId,
      relay: this.relay,
      startedAt: this.startedAt,
      expiresAt: this.expiresAt,
    });
  }

  ownsStateFile() {
    try {
      const cur = JSON.parse(fs.readFileSync(this.attachFile, "utf8"));
      return Number(cur.pid) === process.pid;
    } catch {
      return false;
    }
  }

  /**
   * 清掉上次留下的残留状态文件：pid 已经不在（被 taskkill /F、崩溃、OOM 杀掉，
   * process 的 exit 钩子根本没跑），或者窗口早就过期了。
   * 不清的后果不只是"磁盘上多个文件"：ownsStateFile() 对残留永远返回假，
   * 于是本次既不写状态、退出时也不删——扩展会一直以为窗口开着，会话照样往 relay 镜像，
   * 而用户看到的是"已关闭"。按需窗口是这个功能的总开关，开关失灵不是小事。
   * 别的窗口真活着（pid 在，或属于别的用户）时绝不动它的状态。
   */
  clearStaleState(now = Date.now()) {
    let cur = null;
    try {
      if (!fs.existsSync(this.attachFile)) return;
      cur = JSON.parse(fs.readFileSync(this.attachFile, "utf8"));
    } catch {
      return; // 读不了/解析不了：不当残留处理，交给后面的 existsSync 分支覆盖
    }
    if (!cur || typeof cur !== "object") return;
    if (Number(cur.pid) === process.pid) return;
    // 窗口早过期：哪怕 pid 还被系统复用着，也按残留处理
    if (Number(cur.expiresAt) > 0 && Number(cur.expiresAt) <= now) {
      removeQuiet(this.attachFile);
      return;
    }
    const pid = Number(cur.pid);
    if (!Number.isInteger(pid) || pid <= 0) return;
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (e) {
      alive = !!(e && e.code === "EPERM"); // 进程在但不属于当前用户：也算活着
    }
    if (!alive) removeQuiet(this.attachFile);
  }

  statusLine(now = Date.now()) {
    return statusText({
      connected: this.connected && this.authed,
      reconnecting: this.reconnecting,
      expiresAt: this.expiresAt,
      now,
      activeCount: this.onlineRooms.length,
      viewer: this.viewerUrlProvider ? this.viewerUrlProvider() : viewerUrlFromRelay(this.relay, this.viewerPort),
      authMode: this.authMode,
      keepAwake: !!this.awakeChild,
    });
  }

  paintStatus() {
    if (!this.statusEnabled || this.closing) return;
    const text = this.statusLine();
    const lines = text.split("\n");
    if (!this.stdout || !this.stdout.isTTY) {
      if (text !== this._lastStatus) {
        this._lastStatus = text;
        this.writeOut(text);
      }
      return;
    }
    if (this._statusLines) this.stdout.write(`\x1b[${this._statusLines}A`);
    this._statusLines = lines.length;
    this.stdout.write(lines.map((line) => `\x1b[2K${line}`).join("\n") + "\n");
  }

  start() {
    if (!this.deviceId) {
      this.writeOut("缺少 PI_REMOTE_DEVICE_ID。请先运行：" + initHint(this.platform));
      if (this.exit) this.exit(1);
      return;
    }
    if (this.launcherWarning) this.writeOut(this.launcherWarning);
    // 状态文件等认证通过再写：认证失败/提前退出时磁盘上不留"窗口开着"的假象
    this.clearStaleState();
    this.armKeepAwake();
    this.armExpiry();
    this.armStatus();
    this.armLiveness();
    this.armProcessExit();
    this.bindProcessSignals();
    this.connect();
  }

  /**
   * macOS：caffeinate -i -w <本进程>；Linux：systemd-inhibit 套一个盯着本进程的 shell。
   * 两者都只挡空闲睡眠（屏幕照常熄灭、合盖照常睡），attach 退出/被强杀后跟着退出，不留孤儿抑制剂。
   */
  armKeepAwake() {
    if (!this.keepAwake || this.awakeChild) return;
    const fail = (e) => this.writeOut("防休眠没开起来（不影响连接）：" + (e && e.message ? e.message : e));
    let file;
    let args;
    if (this.platform === "linux") {
      file = "systemd-inhibit";
      args = [
        "--what=idle:sleep",
        "--who=pi-remote",
        "--why=pi-remote attach keep awake",
        "--mode=block",
        "/bin/sh",
        "-c",
        `while kill -0 ${process.pid} 2>/dev/null; do sleep 5; done`,
      ];
    } else {
      file = "caffeinate";
      args = ["-i", "-w", String(process.pid)];
    }
    let child;
    try {
      child = this.spawnImpl(file, args, { stdio: "ignore" });
    } catch (e) {
      fail(e);
      return;
    }
    if (!child) return;
    this.awakeChild = child;
    if (typeof child.unref === "function") child.unref();
    if (typeof child.on === "function") {
      child.on("error", (e) => {
        if (this.awakeChild === child) this.awakeChild = null;
        fail(e);
      });
      child.on("exit", (code) => {
        const wasOurs = this.awakeChild === child;
        if (wasOurs) this.awakeChild = null;
        // 非 0 退出通常是 Linux 上非登录会话没有 polkit 权限：如实说一句，不影响连接
        if (wasOurs && code) fail(new Error(`${file} 退出码 ${code}`));
      });
    }
    this.writeOut(
      this.platform === "linux"
        ? "防休眠：窗口开着时这台 Linux 设备不会空闲睡眠（.env 设 PI_REMOTE_KEEP_AWAKE=0 关掉）"
        : "防休眠：窗口开着时这台 Mac 不会空闲睡眠（合盖照常睡；.env 设 PI_REMOTE_KEEP_AWAKE=0 关掉）",
    );
  }

  releaseKeepAwake() {
    const child = this.awakeChild;
    this.awakeChild = null;
    if (!child || typeof child.kill !== "function") return;
    try {
      child.kill();
    } catch {}
  }

  /** 进程无论如何退出，都删掉状态文件。否则扩展还会以为窗口开着。 */
  armProcessExit() {
    if (this._onExit) return;
    this._onExit = () => {
      if (this.ownsStateFile()) removeQuiet(this.attachFile);
      this.writeOwnExitCode(process.exitCode == null ? 0 : process.exitCode);
    };
    process.on("exit", this._onExit);
  }

  /** 窗口自己的退出码也落盘：tmux 3.4 丢 #{pane_dead_status} 时 device.sh up 还能报出真实原因 */
  writeOwnExitCode(code) {
    if (!this.exitFile || this._exitCodeWritten) return;
    if (writeExitCodePath(this.exitFile, code)) {
      this._exitCodeWritten = true;
      // 进程级兜底钩子看到这个标记就不再写：device.sh down 清掉文件后不会被 exit 钩子重新写回来
      process.__piRemoteExitWritten = true;
    }
  }

  armExpiry() {
    const wait = Math.max(0, this.expiresAt - Date.now());
    // setTimeout 超过 2^31-1 毫秒会被收成 1 毫秒，窗口会立刻被掐掉。先挂到上限，到点再续。
    // 不 unref：这是前台窗口，定时器必须撑住事件循环。unref 后 relay 一断进程就退出，状态文件还留着。
    const delay = Math.min(wait, 0x7fffffff);
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      if (Date.now() >= this.expiresAt) this.onExpire();
      else this.armExpiry();
    }, delay);
  }

  onExpire() {
    this.shutdown("窗口已到时间，已断开");
  }

  armStatus() {
    if (!this.statusEnabled) return;
    this.paintStatus();
    this.statusTimer = setInterval(() => this.paintStatus(), STATUS_MS);
  }

  bindProcessSignals() {
    if (!this.bindSignals) return;
    this._onSignal = () => this.shutdown("已断开");
    process.on("SIGINT", this._onSignal);
    process.on("SIGBREAK", this._onSignal);
    process.on("SIGHUP", this._onSignal);
    process.on("SIGTERM", this._onSignal);
  }

  unbindProcessSignals() {
    if (!this._onSignal) return;
    process.off("SIGINT", this._onSignal);
    process.off("SIGBREAK", this._onSignal);
    process.off("SIGHUP", this._onSignal);
    process.off("SIGTERM", this._onSignal);
    this._onSignal = null;
  }

  clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    if (this.bootFallbackTimer) {
      clearTimeout(this.bootFallbackTimer);
      this.bootFallbackTimer = null;
    }
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    // P9 B：窗口关闭/退出时停掉反向同步扫描
    this.stopRescan();
    if (this.libraryTimer) {
      clearTimeout(this.libraryTimer);
      this.libraryTimer = null;
    }
    for (const entry of this.claimGraces.values()) clearTimeout(entry.timer);
    this.claimGraces.clear();
  }

  connect() {
    if (this.closing) return;
    let WS = this.WebSocketImpl;
    if (!WS) {
      try {
        WS = require("ws");
      } catch (e) {
        this.writeOut("无法加载 ws：" + (e && e.message ? e.message : e));
        this.scheduleReconnect();
        return;
      }
    }
    let ws;
    try {
      ws = new WS(this.relay);
    } catch (e) {
      this.writeOut("连接失败：" + (e && e.message ? e.message : e));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    const onOpen = () => {
      if (this.ws !== ws || this.closing) return;
      this.connected = true;
      this.reconnecting = false;
      this.backoff = RECONNECT_MIN;
      this.lastSeen = Date.now();
      this.paintStatus();
      if (this.deviceKeys && this.deviceId) {
        this.pendingClientNonce = newClientNonce();
        this.send(attachKeyAuthFrame({ deviceId: this.deviceId, keys: this.deviceKeys, platform: this.platform, clientNonce: this.pendingClientNonce }));
      } else {
        this.send(attachAuthFrame({ token: this.token, deviceId: this.deviceId, deviceToken: this.deviceToken, platform: this.platform }));
      }
    };
    const onMessage = (data) => {
      if (this.ws !== ws) return;
      this.lastSeen = Date.now();
      let msg;
      try {
        msg = JSON.parse(typeof data === "string" ? data : String(data));
      } catch {
        return;
      }
      this.handleMessage(msg);
    };
    const onClose = () => {
      if (this.ws !== ws) return;
      this.onSocketClose();
    };
    const onAlive = () => {
      if (this.ws === ws) this.lastSeen = Date.now();
    };
    if (typeof ws.on === "function") {
      ws.on("open", onOpen);
      ws.on("message", onMessage);
      ws.on("ping", onAlive);
      ws.on("pong", onAlive);
      ws.on("close", onClose);
      ws.on("error", () => {
        try {
          ws.close();
        } catch {}
      });
    } else {
      ws.onopen = onOpen;
      ws.onmessage = (ev) => onMessage(ev && ev.data !== undefined ? ev.data : ev);
      ws.onclose = onClose;
      ws.onerror = () => {
        try {
          ws.close();
        } catch {}
      };
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.closing) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX);
    this.reconnecting = true;
    this.paintStatus();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
  }

  onSocketClose() {
    this.connected = false;
    this.authed = false;
    this.ws = null;
    // 断线后房间列表立刻失效：不清的话重连前还按旧状态判断"已在运行"
    this.onlineRooms = [];
    if (this.launchWaiters.size) this.abandonLaunchWaiters();
    // 还没等到 room_list 就断了：兜底定时器不能在断线期间拿空列表去拉起，等下次认证再挂
    if (this.bootFallbackTimer) {
      clearTimeout(this.bootFallbackTimer);
      this.bootFallbackTimer = null;
    }
    if (this.closing) return;
    this.scheduleReconnect();
  }

  armLiveness() {
    if (this.livenessTimer) return;
    this.lastTick = Date.now();
    this.livenessTimer = setInterval(() => this.checkLiveness(), LIVENESS_TICK_MS);
    // 前台窗口靠到期定时器撑住进程，这个不必再撑
    if (typeof this.livenessTimer.unref === "function") this.livenessTimer.unref();
  }

  /** 每 LIVENESS_TICK_MS 跑一次；返回判定结果给测试看 */
  checkLiveness(now = Date.now()) {
    const prev = this.lastTick || now;
    this.lastTick = now;
    if (this.closing || !this.ws || !this.connected) return "idle";
    if (now - prev > LIVENESS_TICK_MS + WAKE_GAP_MS) {
      this.dropConnection(`定时器晚了 ${Math.round((now - prev) / 1000)}s，像是刚从睡眠中醒来`);
      return "wake";
    }
    const silent = now - (this.lastSeen || now);
    if (silent >= SILENCE_DEAD_MS) {
      this.dropConnection(`${Math.round(silent / 1000)}s 没收到 relay 的任何消息`);
      return "dead";
    }
    if (silent >= SILENCE_PING_MS && typeof this.ws.ping === "function") {
      try {
        this.ws.ping();
      } catch {}
      return "ping";
    }
    return "ok";
  }

  /** 丢掉疑似半开的连接：terminate 不等 close 握手（半开时永远等不到），立刻按断线处理，退避从头算 */
  dropConnection(why) {
    const ws = this.ws;
    if (!ws) return;
    this.writeOut(`连接没有响应（${why}），重连`);
    this.ws = null;
    try {
      if (typeof ws.terminate === "function") ws.terminate();
      else ws.close();
    } catch {}
    this.backoff = RECONNECT_MIN;
    this.onSocketClose();
  }

  /** 设备一上线就读本机 pi 会话目录。失败只记一行，不影响窗口本身。 */
  scheduleLibrary() {
    if (this.libraryTimer) clearTimeout(this.libraryTimer);
    this.libraryTimer = setTimeout(() => {
      this.libraryTimer = null;
      this.publishLibrary();
    }, 400);
  }

  /** 本机会话根目录：一律认 PI_CODING_AGENT_SESSION_DIR（与扩展、pi 同一口径，P9 §4.5.2）。 */
  sessionRoot() {
    return sessionRootFromEnv();
  }

  /**
   * Crypto Phase 3: the ACK this window can seal session archives with, as
   * a 32-byte Buffer, or null when the device holds no content key. A fresh
   * read of the key file wins over the startup snapshot: the extension may
   * have received the account ACK (content_key_grant) and persisted it after
   * this window started, and the file is the shared source of truth. A
   * missing or unreadable file falls back to the snapshot; a stored value
   * that is not a 32-byte key counts as "no ACK" (legacy plaintext form).
   */
  archiveAckKey() {
    let keys = this.deviceKeys;
    if (this.keyFilePath) {
      try {
        keys = loadDeviceKeys(this.keyFilePath) || keys;
      } catch {
        // A broken key file was already reported loudly at startup; sealing
        // simply falls back to whatever the snapshot holds.
      }
    }
    const b64 = accountAckOf(keys, this.accountId);
    if (!b64) return null;
    const buf = Buffer.from(b64, "base64");
    return buf.length === 32 ? buf : null;
  }

  /** session_archive payloads leave sealed whenever this device holds the account ACK. */
  archiveWire(archive) {
    return archiveWireBody(archive, this.archiveAckKey());
  }

  /** session_manifest rows leave with sealed previews whenever this device holds the account ACK. */
  manifestWire(archive) {
    return manifestWireRow(archive, this.archiveAckKey());
  }

  publishLibrary() {
    if (!this.authed || !this.deviceId) return;
    const root = this.sessionRoot();
    let files = [];
    try {
      files = listSessionFiles(root);
    } catch (e) {
      this.writeOut("读取本地会话目录失败：" + (e && e.message ? e.message : e));
      return;
    }
    const sessions = [];
    const archives = [];
    /** P9 B：记住这次发出去的 id 与 mtime，反向扫描据此判断"删了/新出现/改了" */
    const ids = new Set();
    const mtimes = new Map();
    for (const file of files) {
      const fallbackId = sessionIdFromFileName(file);
      try {
        const archive = readArchive(file);
        if (!archive.id) continue;
        sessions.push(this.manifestWire(archive));
        archives.push(archive);
        ids.add(String(archive.id));
        try {
          mtimes.set(String(archive.id), fs.statSync(file).mtimeMs);
        } catch {}
      } catch (e) {
        this.writeOut("跳过会话文件 " + file + "：" + (e && e.message ? e.message : e));
        // P1-4：读不出正文也要进清单（最小行），否则 relay 对账会误打成"设备已删"。
        if (!fallbackId) continue;
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(file).mtimeMs;
        } catch {}
        sessions.push(fallbackManifestRow(file, fallbackId, mtimeMs));
        ids.add(fallbackId);
        mtimes.set(fallbackId, mtimeMs);
      }
    }
    this.publishedIds = ids;
    this.publishedMtimes = mtimes;
    // scope/root：这是 attach 窗口发的设备级全量清单，relay 据此只给 root 下的行打墓碑
    const sentManifest = this.send({
      type: "session_manifest",
      deviceId: this.deviceId,
      full: true,
      scope: "device",
      root,
      updatedAt: Date.now(),
      sessions,
    });
    if (!sentManifest) return;
    let index = 0;
    const step = () => {
      if (!this.authed) return;
      const archive = archives[index++];
      if (!archive) {
        this.writeOut("已同步 " + archives.length + " 个本地会话");
        return;
      }
      this.send({ type: "session_archive", deviceId: this.deviceId, session: this.archiveWire(archive) });
      // P1-1：全量补正文也算"这个会话最近发过正文"，10 分钟内不再重复
      this.archiveSentAt.set(String(archive.id), Date.now());
      setTimeout(step, 30);
    };
    step();
  }

  /**
   * P9 B 反向同步：auth 成功后启动，shutdown 时停。
   * 每 ${libraryRescanMs}ms 扫一次会话根目录：删掉的发 removed；新出现/改动过的补清单行。
   * P1-1：**改动只发清单行**（元数据，几十字节）；正文（session_archive，最大约 200KB，
   * relay 会广播给每个网页）只在两种情况下补：新出现的会话、或当前没有在线房间的会话，
   * 且同一个会话 10 分钟内最多补一次——在线会话靠房间正文看，不需要再推全文。
   */
  startRescan() {
    if (this.rescanTimer) return;
    this.rescanTimer = setInterval(() => {
      void this.rescanOnce();
    }, this.libraryRescanMs);
    if (typeof this.rescanTimer.unref === "function") this.rescanTimer.unref();
  }

  stopRescan() {
    if (!this.rescanTimer) return;
    clearInterval(this.rescanTimer);
    this.rescanTimer = null;
  }

  async rescanOnce() {
    if (!this.authed || !this.deviceId) return;
    let files = [];
    try {
      files = listSessionFiles(this.sessionRoot());
    } catch {
      return;
    }
    /** 这一次磁盘上有的：文件名里的 id -> { file, mtimeMs } */
    const now = new Map();
    for (const file of files) {
      const id = sessionIdFromFileName(file);
      if (!id) continue;
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      now.set(id, { file, mtimeMs: st.mtimeMs });
    }
    const removed = [];
    for (const id of [...this.publishedIds]) if (!now.has(id)) removed.push(id);
    if (removed.length) this.sendRemoved(removed);
    const nowAt = Date.now();
    const onlineIds = new Set((this.onlineRooms || []).map((room) => String(room && room.id)));
    for (const [id, info] of now) {
      // P9 第 2 轮审查 BUG-4：有在线房间的会话由扩展本来就会上报（正文走房间实时流），
      // 扫描直接跳过——否则正在跑的大会话每 30s 被整份 readFileSync 一遍、解析一遍，解析完却不发。
      if (onlineIds.has(id)) continue;
      const known = this.publishedIds.has(id);
      if (known && this.publishedMtimes.get(id) === info.mtimeMs) continue;
      // 先只看 stat 判断有没有变化；确定要发才读正文（上面 mtime 相等已经跳过大多数情况）。
      let archive = null;
      try {
        archive = readArchive(info.file);
      } catch {
        // 正文暂时读不了（正在写入/权限）：保留已登记状态、不更新 mtime，下一轮再试；
        // 绝不能在这里把它当"已删"，否则 relay 会清掉服务器副本。
        continue;
      }
      if (!archive.id) continue;
      this.publishedIds.add(id);
      this.publishedMtimes.set(id, info.mtimeMs);
      // 改动 → 只发清单行（元数据），不发正文（P1-1 手机流量）。扫描行去掉 active：
      // manifestRow 默认 active:false，会把运行中会话在索引里的活动位清掉（BUG-4）。
      const row = this.manifestWire(archive);
      delete row.active;
      this.send({
        type: "session_manifest",
        deviceId: this.deviceId,
        full: false,
        updatedAt: nowAt,
        sessions: [row],
      });
      const last = this.archiveSentAt.get(id) || 0;
      if (known && nowAt - last < ARCHIVE_RESEND_MS) continue;
      this.send({ type: "session_archive", deviceId: this.deviceId, session: this.archiveWire(archive) });
      this.archiveSentAt.set(id, nowAt);
    }
  }

  /** 告诉 relay 这些会话已经不在了（P9 B）：先从反向同步账本里删掉，再发一条否定清单。 */
  sendRemoved(ids) {
    const gone = (Array.isArray(ids) ? ids : []).map((id) => String(id)).filter(Boolean);
    if (!gone.length) return;
    for (const id of gone) {
      this.publishedIds.delete(id);
      this.publishedMtimes.delete(id);
      this.archiveSentAt.delete(id);
    }
    this.send({
      type: "session_manifest",
      deviceId: this.deviceId,
      full: false,
      updatedAt: Date.now(),
      sessions: [],
      removed: gone,
    });
  }

  send(obj) {
    if (!this.ws || typeof this.ws.send !== "function") return false;
    if (this.ws.readyState != null && this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  handleMessage(msg) {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "auth_challenge") {
      // 钥模式才作答：用 DIK 对挑战签名回 auth_response。材料不合口径就别乱回——
      // 不作答等 relay 的鉴权截止关连接（与扩展同口径），错误会在 auth 失败路径上显形
      if (this.deviceKeys && this.pendingClientNonce) {
        try {
          this.send({ type: "auth_response", sig: signAuthResponse(this.deviceKeys, this.deviceId, msg.nonce, this.pendingClientNonce) });
        } catch (e) {
          this.writeOut("鉴权挑战应答失败（本机钥不可用）：" + (e && e.message ? e.message : e));
        }
      }
      return;
    }
    if (msg.type === "auth_result") {
      if (!msg.ok) {
        const reason = "relay 鉴权失败：" + (msg.error || "token 不正确");
        const repair = msg.code === "device_revoked" || msg.code === "device_mismatch" || ((this.deviceToken || this.deviceKeys) && msg.code === "auth_failed");
        this.shutdown(repair ? `${reason}。在网页上生成配对码后运行：${pairHint(this.platform)}` : reason, 1);
        return;
      }
      this.authed = true;
      this.authMode = typeof msg.auth === "string" ? msg.auth : null;
      // 首次认证写状态文件；重连时只在文件不在或仍归本窗口时重写，
      // 不把别的窗口写下的状态（它的 pid / expiresAt）抢回来
      if (!this.stateWritten || this.ownsStateFile() || !fs.existsSync(this.attachFile)) {
        this.writeState();
        this.stateWritten = true;
      }
      this.send(this.registerFrame());
      this.paintStatus();
      this.scheduleLibrary();
      // P9 B：反向同步定时器跟着认证走（shutdown 时停；断线期间 rescanOnce 自己会跳过）
      this.startRescan();
      if (!this.booted) {
        this.booted = true;
        // 等第一份 room_list 到了再拉起目录：此刻 onlineRooms 还是空的，会把已在跑的 pi 再起一份
        this.pendingBoot = !!(this.dirs && this.dirs.length);
      }
      if (this.pendingBoot && !this.bootFallbackTimer) {
        this.bootFallbackTimer = setTimeout(() => {
          this.bootFallbackTimer = null;
          if (this.pendingBoot && this.authed) {
            this.pendingBoot = false;
            void this.bootDirs();
          }
        }, 3000);
      }
      return;
    }
    if (msg.type === "device_replaced") {
      this.shutdown("另一个窗口已开启");
      return;
    }
    if (msg.type === "room_list") {
      this.observeRooms(msg.rooms);
      this.paintStatus();
      if (this.pendingBoot) {
        this.pendingBoot = false;
        if (this.bootFallbackTimer) {
          clearTimeout(this.bootFallbackTimer);
          this.bootFallbackTimer = null;
        }
        void this.bootDirs();
      }
      return;
    }
    if (msg.type === "command") {
      // P9 §4.5.3：按命令名分派；不认识的也要回结果，否则 relay 只能白等到超时
      const name = String(msg.command || "");
      if (name === "harness_start") return void this.onHarness(msg);
      if (name === "delete_session") return void this.onDeleteSession(msg);
      if (name === "list_dirs") return void this.onListDirs(msg);
      this.reply(msg.id, { ok: false, code: "unknown_command", error: "这台设备的连接窗口不支持 " + name });
      return;
    }
    if (msg.type === "error" && msg.code === "unknown_type") {
      if (!this._unknownLogged) {
        this._unknownLogged = true;
        this.writeOut("relay 尚未识别设备帧（窗口仍保持，待 relay 升级）：" + (msg.message || ""));
      }
    }
  }

  /**
   * Terminal 拉起后等会话上线。resolve({roomId}) 表示成功；resolve({failed}) 表示失败/超时。
   * 没有等待上限（或不是 Terminal）时返回 null，保持原来的"立刻 started"。
   */
  armLaunchWaiter(kind, key, timeoutMs, opts = {}) {
    if (!(timeoutMs > 0) || !key) return null;
    const waiter = { kind, key, resolve: null };
    let timer = null;
    const promise = new Promise((resolve) => {
      waiter.resolve = (value) => {
        if (!this.launchWaiters.has(waiter)) return;
        this.launchWaiters.delete(waiter);
        if (timer) clearTimeout(timer);
        resolve(value);
      };
    });
    timer = setTimeout(() => {
      if (opts.timeoutIsFailure) {
        // Windows 新控制台：start 返回 0 只代表控制台开了，pi 没装/启动失败时房间永远不会上线。
        // 超时按失败回馈并释放占用，让用户能立刻重试；稍后真上线了仍可在网页看到房间。
        waiter.resolve({ failed: opts.timeoutMessage || `${Math.round(timeoutMs / 1000)} 秒内没看到会话上线` });
        return;
      }
      // 软超时：open 已经成功，Terminal 可能只是还没跑起来。绝不删脚本、绝不清占用——
      // 删了脚本 Terminal 会打不开，清了占用用户重试会起第二份 pi。占用另由 claimGrace 回收。
      waiter.resolve({ pending: true });
    }, timeoutMs);
    this.launchWaiters.add(waiter);
    return { promise, fail: (why) => waiter.resolve({ failed: why }) };
  }

  /** room_list 到了：把对应的等待者兑现成成功，带上房间 id 让网页直接切过去 */
  settleLaunchWaiters(online) {
    for (const waiter of [...this.launchWaiters]) {
      const hit = waiter.kind === "session"
        ? online.find((r) => String(r.id) === waiter.key)
        : online.find((r) => normalizeDir(r.cwd, this.platform) === waiter.key);
      if (hit) waiter.resolve({ roomId: hit.id ? String(hit.id) : null });
    }
  }

  /** 连接断了/窗口要关了：等不到结果，但也不能删脚本或清占用（pi 可能已经起来） */
  abandonLaunchWaiters() {
    for (const waiter of [...this.launchWaiters]) waiter.resolve({ pending: true });
  }

  /** 软超时后 30s 还没看到房间，才释放占用（脚本不删）：目录不会被锁 10 分钟，又给冷启动留了余量 */
  scheduleClaimGrace(plan) {
    const sessionKey = plan.sessionId ? String(plan.sessionId) : "";
    const cwdKey = plan.sessionId ? "" : normalizeDir(plan.cwd, this.platform);
    const mapKey = sessionKey ? `session:${sessionKey}` : `cwd:${cwdKey}`;
    const claim = sessionKey ? this.spawnedBySession.get(sessionKey) : this.spawnedByCwd.get(cwdKey);
    if (!claim) return;
    const timer = setTimeout(() => {
      this.claimGraces.delete(mapKey);
      // 身份校验：这期间占用可能已被新一次拉起替换，不能删别人的
      const current = sessionKey ? this.spawnedBySession.get(sessionKey) : this.spawnedByCwd.get(cwdKey);
      if (current !== claim) return;
      if (sessionKey) this.spawnedBySession.delete(sessionKey);
      else {
        this.spawnedByCwd.delete(cwdKey);
        this.seenOnline.delete(cwdKey);
      }
      this.writeOut(`${Math.round(this.claimGraceMs / 1000)} 秒内没看到会话上线，已释放占用；稍后房间出现仍可正常使用`);
    }, this.claimGraceMs);
    if (typeof timer.unref === "function") timer.unref();
    this.claimGraces.set(mapKey, { timer, claim });
  }

  observeRooms(rooms) {
    const list = Array.isArray(rooms) ? rooms.filter(Boolean) : [];
    const tagged = list.some((r) => r.deviceId);
    const mine = tagged ? list.filter((r) => String(r.deviceId) === String(this.deviceId)) : list;
    const online = mine.filter((r) => r.online);
    const onlineCwd = new Set(online.map((r) => normalizeDir(r.cwd, this.platform)).filter(Boolean));
    for (const r of online) if (r && r.id != null) this.spawnedBySession.delete(String(r.id));
    for (const cwd of [...this.spawnedByCwd.keys()]) {
      if (onlineCwd.has(cwd)) {
        const room = online.find((r) => normalizeDir(r.cwd, this.platform) === cwd);
        const rec = this.spawnedByCwd.get(cwd);
        if (rec && room && room.id) rec.roomId = String(room.id);
        this.seenOnline.add(cwd);
      } else if (this.seenOnline.has(cwd)) {
        this.spawnedByCwd.delete(cwd);
        this.seenOnline.delete(cwd);
      }
    }
    this.onlineRooms = online;
    if (this.launchWaiters.size) this.settleLaunchWaiters(online);
    // 房间在宽限期内上线了：取消对应占用的回收计时器（否则 30s 后会把正在用的占用删掉）
    if (this.claimGraces.size) {
      for (const [key, entry] of [...this.claimGraces]) {
        const hit = key.startsWith("session:")
          ? online.find((r) => String(r.id) === key.slice("session:".length))
          : online.find((r) => normalizeDir(r.cwd, this.platform) === key.slice("cwd:".length));
        if (!hit) continue;
        clearTimeout(entry.timer);
        this.claimGraces.delete(key);
      }
    }
  }

  findOnline(cwd) {
    const key = normalizeDir(cwd, this.platform);
    if (!key) return null;
    return this.onlineRooms.find((r) => normalizeDir(r.cwd, this.platform) === key) || null;
  }

  async bootDirs() {
    for (const dir of this.dirs) {
      const result = await this.launch({ cwd: dir, source: "cli" });
      if (!result.ok) this.writeOut(result.error || "启动失败：" + displayPathOf(dir));
      else if (result.status === "already_running") this.writeOut("已在运行，不另起：" + displayPathOf(dir));
      else this.writeOut("已拉起：" + displayPathOf(dir));
    }
  }

  async onHarness(msg) {
    const args = msg && msg.args && typeof msg.args === "object" ? msg.args : {};
    const result = await this.launch({ cwd: args.cwd, sessionId: args.sessionId, source: "remote" });
    this.reply(msg && msg.id, result);
  }

  /**
   * command_result 帧。P9 §4.5.4：把 result.data 里的字段并进 frame.data
   * （删除要带 method、list_dirs 要带 root/entries，只写 ok/status/roomId 不够）。
   */
  reply(id, result) {
    const src = result && typeof result === "object" ? result : {};
    const extra = src.data && typeof src.data === "object" && !Array.isArray(src.data) ? src.data : {};
    const ok = !!src.ok;
    const frame = { type: "command_result", id, deviceId: this.deviceId, ok };
    if (ok) {
      frame.status = src.status;
      if (src.roomId) frame.roomId = src.roomId;
      frame.data = { ...extra, ok: true, status: src.status };
      if (src.roomId) frame.data.roomId = src.roomId;
    } else {
      frame.error = src.error || "执行失败";
      if (src.code) frame.code = src.code;
      frame.data = { ...extra, ok: false, error: frame.error };
      if (src.code) frame.data.code = src.code;
    }
    this.send(frame);
  }

  /**
   * P9 B：设备级删除会话（不经过 pi 进程，项目里没 pi 也能删）。
   * 原则：网络上传来的路径一律不信，只按 sessionId 在自己的会话根目录里找文件；
   * realpath 之后必须在 realpath(root) 内（防符号链接逃逸）；动作和 pi 一样（trash 优先）。
   */
  async onDeleteSession(msg) {
    const sessionId = String((msg.args && msg.args.sessionId) || "").trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) {
      return this.reply(msg.id, { ok: false, code: "bad_args", error: "会话 id 不合法" });
    }
    // 和 pi 一样：正在用的会话不能删（本机在线房间 = 有 pi 开着它）
    if ((this.onlineRooms || []).some((room) => String(room && room.id) === sessionId)) {
      return this.reply(msg.id, { ok: false, code: "session_running", error: "会话正在运行，不能删除" });
    }
    const root = this.sessionRoot();
    const file = findSessionFileAnywhere(root, sessionId, this.platform);
    if (!file) {
      // P1-3：relay 会带索引里的 pathHint。提示指向的文件真实存在、文件名对得上这个 id，
      // 但 realpath 不在会话根目录里（pi 用了自定义会话目录）→ 明确回 session_outside_root，
      // 不发 removed、不清服务器副本（设备上的文件还在，让用户去 pi 里删）。
      const hint = msg.args && typeof msg.args.pathHint === "string" ? msg.args.pathHint.trim() : "";
      if (hint && this.pathHintOutsideRoot(hint, sessionId, root)) {
        const message = (PROTOCOL.errors.session_outside_root && PROTOCOL.errors.session_outside_root.message) || "这个会话不在设备的会话目录里，请在 pi 里删除";
        return this.reply(msg.id, { ok: false, code: "session_outside_root", error: message });
      }
      // 真的不在了也算成功（幂等）：顺手让 relay 把服务器上的副本清掉
      this.sendRemoved([sessionId]);
      return this.reply(msg.id, { ok: true, status: "already_deleted", data: { method: null } });
    }
    let realFile;
    let realRoot;
    try {
      realFile = fs.realpathSync.native(file);
      realRoot = fs.realpathSync.native(root);
    } catch (e) {
      return this.reply(msg.id, { ok: false, code: "internal", error: "读取会话路径失败：" + (e && e.message ? e.message : e) });
    }
    if (!insideDir(realFile, realRoot, this.platform)) {
      return this.reply(msg.id, { ok: false, code: "bad_args", error: "会话路径越界" });
    }
    const res = deleteLikePi(file, this.platform);
    if (!res.ok) return this.reply(msg.id, { ok: false, code: "internal", error: res.error });
    this.writeOut("已删除会话 " + sessionId + "（" + res.method + "）");
    this.sendRemoved([sessionId]);
    this.reply(msg.id, { ok: true, status: "deleted", data: { method: res.method } });
  }

  /**
   * P1-3：pathHint 是不是"真实存在、文件名带这个 id、但 realpath 不在会话根目录里"的会话文件。
   * 只用来判定错误码，绝不按这个路径删任何东西。
   */
  pathHintOutsideRoot(hintPath, sessionId, root) {
    if (!hintPath || unsafePath(hintPath, this.platform)) return false;
    let st;
    try {
      st = fs.statSync(hintPath);
    } catch {
      return false;
    }
    if (!st.isFile()) return false;
    const name = pathApi(this.platform).basename(hintPath);
    if (name !== `${sessionId}.jsonl` && !name.endsWith(`_${sessionId}.jsonl`)) return false;
    let realHint;
    try {
      realHint = fs.realpathSync.native(hintPath);
    } catch {
      return false;
    }
    let realRoot;
    try {
      realRoot = fs.realpathSync.native(root);
    } catch {
      realRoot = root;
    }
    return !insideDir(realHint, realRoot, this.platform);
  }

  /**
   * P9 C：列出浏览根目录内的子目录（只读目录名，不传文件、不传内容）。
   * 安全规则（spec §5.3.3 十条）：关闭时 browse_disabled；path 过 unsafePath + 绝对路径；
   * realpath 后必须落在某个根目录里；不递归；单层 readdir 上限 500。
   */
  onListDirs(msg) {
    const args = msg && msg.args && typeof msg.args === "object" ? msg.args : {};
    const roots = this.browseRoots || [];
    if (!roots.length) {
      return this.reply(msg.id, { ok: false, code: "browse_disabled", error: "这台设备没有开启文件夹浏览" });
    }
    let target = args.path == null ? "" : String(args.path).trim();
    if (!target) target = roots[0];
    if (unsafePath(target, this.platform)) {
      return this.reply(msg.id, { ok: false, code: "bad_args", error: "路径包含不允许的字符" });
    }
    const pApi = pathApi(this.platform);
    if (!pApi.isAbsolute(target)) {
      return this.reply(msg.id, { ok: false, code: "bad_args", error: "path 必须是绝对路径" });
    }
    let real;
    try {
      // realpathSync.native 才能解开 Windows 的 junction（spec §5.3.2）
      real = fs.realpathSync.native(target);
    } catch (e) {
      return this.replyPathError(msg.id, e);
    }
    const root = matchedRoot(real, roots, this.platform);
    if (!root) {
      return this.reply(msg.id, { ok: false, code: "fs_outside_root", error: "不在允许浏览的范围内" });
    }
    let st;
    try {
      st = fs.statSync(real);
    } catch (e) {
      return this.replyPathError(msg.id, e);
    }
    if (!st.isDirectory()) {
      return this.reply(msg.id, { ok: false, code: "fs_not_dir", error: "这不是文件夹" });
    }
    const showHidden = args.showHidden === true;
    let dirents = [];
    try {
      dirents = fs.readdirSync(real, { withFileTypes: true });
    } catch (e) {
      return this.replyPathError(msg.id, e);
    }
    const entries = [];
    for (const dirent of dirents) {
      const name = String((dirent && dirent.name) || "");
      if (!name) continue;
      if (name.startsWith(".") && !showHidden) continue;
      if (CONTROL_CHARS.test(name) || name.length > DIR_NAME_MAX) continue;
      const full = pApi.join(real, name);
      if (dirent.isDirectory()) {
        entries.push({ name, path: full });
        continue;
      }
      if (!dirent.isSymbolicLink()) continue;
      // 符号链接：只有指向"根目录内的目录"才收；path 写链接自己的路径（不是目标路径）
      let linked;
      try {
        linked = fs.realpathSync.native(full);
      } catch {
        continue;
      }
      let linkedStat;
      try {
        linkedStat = fs.statSync(linked);
      } catch {
        continue;
      }
      if (!linkedStat.isDirectory()) continue;
      if (!insideRoots(linked, roots, this.platform)) continue;
      entries.push({ name, path: full });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    const truncated = entries.length > DIR_LIST_MAX;
    const atRoot = rootCompareKey(real, this.platform) === rootCompareKey(root, this.platform);
    this.reply(msg.id, {
      ok: true,
      status: "ok",
      data: {
        root,
        path: real,
        parent: atRoot ? null : pApi.dirname(real),
        entries: truncated ? entries.slice(0, DIR_LIST_MAX) : entries,
        truncated,
      },
    });
  }

  /** onListDirs 的读取失败映射：ENOENT/ENOTDIR/EACCES/EPERM 各有协议码。 */
  replyPathError(id, e) {
    const code = e && e.code;
    if (code === "ENOENT") return this.reply(id, { ok: false, code: "fs_not_found", error: "文件夹不存在" });
    if (code === "EACCES" || code === "EPERM") return this.reply(id, { ok: false, code: "fs_denied", error: "没有权限读取这个文件夹" });
    if (code === "ENOTDIR") return this.reply(id, { ok: false, code: "fs_not_dir", error: "这不是文件夹" });
    return this.reply(id, { ok: false, code: "internal", error: "读取文件夹失败：" + (e && e.message ? e.message : e) });
  }

  /** P9 C：远程/本机拉起都认的目录——白名单，或者浏览根目录下面。 */
  launchAllowed(cwd) {
    if (cwdAllowed(cwd, this.projects, this.platform)) return true;
    if (!this.browseRoots || !this.browseRoots.length) return false;
    try {
      return insideRoots(realDir(String(cwd), this.platform), this.browseRoots, this.platform);
    } catch {
      return false;
    }
  }

  /**
   * source=remote：cwd 必须落在 projects。source=cli：本机入参目录允许不在白名单。
   * 同目录已有在线房间或本窗口刚拉起的进程 → already_running，不再起第二份。
   */
  async planLaunch({ cwd, sessionId, source }) {
    const parsed = parseHarnessArgs({ cwd, sessionId });
    if (!parsed.ok) return parsed;
    let targetCwd = parsed.cwd || "";
    let sessionPath = null;
    if (parsed.sessionId) {
      // sessionId 形态先按 id 找在线房间：同目录有别的会话在线，不能把用户明确要开的那个顶掉
      const byId = (this.onlineRooms || []).find((r) => String(r && r.id) === String(parsed.sessionId));
      if (byId) return { ok: true, status: "already_running", roomId: String(byId.id) };
      let found = null;
      try {
        found = await this.sessionLookup(parsed.sessionId, this.projects);
      } catch (e) {
        return { ok: false, code: "spawn_failed", error: "本机启动失败：" + (e && e.message ? e.message : e) };
      }
      if (!found || found.deleted || !found.path) {
        return { ok: false, code: "session_not_found", error: "这台设备上没有这个会话" };
      }
      targetCwd = found.cwd;
      sessionPath = found.path;
      // P9 C：会话头里的 cwd 可能来自浏览根目录（白名单外），两边规则要一致
      if (!targetCwd || !this.launchAllowed(targetCwd)) {
        return { ok: false, code: "cwd_not_allowed", error: "该目录不在这台设备的允许列表里" };
      }
    } else if (source !== "cli" && !this.launchAllowed(targetCwd)) {
      return { ok: false, code: "cwd_not_allowed", error: "该目录不在这台设备的允许列表里" };
    }
    if (!targetCwd || unsafePath(targetCwd, this.platform) || (sessionPath && unsafePath(sessionPath, this.platform))) {
      return { ok: false, code: "spawn_failed", error: "本机启动失败：路径包含不允许的字符" };
    }
    let resolved;
    try {
      resolved = realDir(String(targetCwd), this.platform);
    } catch {
      return { ok: false, code: "spawn_failed", error: "本机启动失败：目录无效" };
    }
    if (!this.existsDir(resolved)) {
      return { ok: false, code: "spawn_failed", error: "本机启动失败：目录不存在" };
    }
    // 只有 cwd 形态才看"同目录已有在线房间"；sessionId 形态上面已按 id 判断过，
    // 再按目录匹配会把同目录的别的会话当成"已经在跑"顶掉用户明确要开的那个
    if (!parsed.sessionId) {
      const online = this.findOnline(resolved);
      if (online) return { ok: true, status: "already_running", roomId: online.id ? String(online.id) : null };
    }
    if (parsed.sessionId) {
      // sessionId 形态只认"这个会话"自己的占用记录：同目录刚拉起别的会话，不能把它判成已在运行
      const sid = String(parsed.sessionId);
      const rec = this.spawnedBySession.get(sid);
      if (rec && Date.now() - (rec.at || 0) < SPAWN_CLAIM_MS && this.claimAlive(rec)) return { ok: true, status: "already_running", roomId: null };
      this.spawnedBySession.delete(sid);
      return { ok: true, status: "spawn", cwd: resolved, sessionPath, sessionId: sid };
    }
    const key = normalizeDir(resolved, this.platform);
    if (key && this.spawnedByCwd.has(key)) {
      const rec = this.spawnedByCwd.get(key) || {};
      const age = Date.now() - (rec.at || 0);
      // 拉起后 pi 一直没上线（启动失败/被关掉）：超过 SPAWN_CLAIM_MS 放行重试，
      // 否则这个目录会永久返回 already_running{roomId:null}，谁都打不开。tmux 拉起的能直接查到 pi 已经退了，不用等
      if (age < SPAWN_CLAIM_MS && this.claimAlive(rec)) {
        return { ok: true, status: "already_running", roomId: rec.roomId ? rec.roomId : null };
      }
      this.spawnedByCwd.delete(key);
      this.seenOnline.delete(key);
    }
    return { ok: true, status: "spawn", cwd: resolved, sessionPath };
  }

  async launch({ cwd, sessionId, source }) {
    // 带上协议的 harness_busy：tmux 拉起要等 pi 站稳（约 1.5 秒），撞上的机会比原来多，网页要能按码提示重试
    if (this.starting) return { ok: false, code: "harness_busy", error: "正在启动另一个会话，请稍候" };
    this.starting = true;
    try {
      const plan = await this.planLaunch({ cwd, sessionId, source });
      if (!plan.ok || plan.status !== "spawn") return plan;
      // Terminal 拉起要等房间真的上线；tmux 等它回话并看 pi 有没有当场退出
      const spawned = await this.spawnPlanned(plan);
      if (spawned && spawned.failed) return { ok: false, code: "spawn_failed", error: "本机启动失败：" + spawned.failed };
      return { ok: true, status: "started", roomId: spawned && spawned.roomId ? spawned.roomId : undefined };
    } catch (e) {
      return { ok: false, code: "spawn_failed", error: "本机启动失败：" + (e && e.message ? e.message : e) };
    } finally {
      this.starting = false;
    }
  }

  /** 返回 null 表示已拉起；异步拉起返回 Promise<{failed?}|{roomId?}>。 */
  spawnPlanned(plan) {
    if (!fs.existsSync(this.startPi)) throw new Error("找不到 " + this.startPi);
    let tmux = null;
    if (this.launcher === "tmux") {
      tmux = this.tmux();
      if (!tmux) throw new Error(`找不到 tmux（${tmuxInstallHint(this.platform)}）`);
    }
    const spec = buildSpawnSpec({
      cwd: plan.cwd,
      sessionPath: plan.sessionPath,
      startPi: this.startPi,
      platform: this.platform,
      launcher: this.launcher,
      terminalApp: this.terminalApp,
      scriptDir: this.scriptDir,
      keepFailed: !!(tmux && tmux.keepFailed),
      exitHome: this.exitHome,
    });
    if (spec.script) {
      // wx：同名文件已存在就失败，不顺着别人放的符号链接写
      fs.writeFileSync(spec.script.path, spec.script.text, { mode: spec.script.mode, flag: "wx" });
    }
    let released = false;
    // 没拉起来：立刻清掉占用标记，别让后续请求被 already_running 挡住
    const release = (why) => {
      if (released) return;
      released = true;
      this.writeOut("启动失败：" + why);
      if (spec.script) removeQuiet(spec.script.path);
      // 失败现场已经读过了（tmuxEarlyExit 先读窗格、再读落盘）；清掉落盘，别让下一次误读旧码
      if (spec.exitFile) removeQuiet(spec.exitFile);
      if (plan.sessionId) {
        this.spawnedBySession.delete(String(plan.sessionId));
        return;
      }
      const k = normalizeDir(plan.cwd, this.platform);
      if (k) {
        this.spawnedByCwd.delete(k);
        this.seenOnline.delete(k);
      }
    };
    // Terminal / Windows 新控制台的拉起命令返回 0 不代表 pi 起来了：先挂好等待者，房间一上线就兑现成功
    const waiter = (spec.script || this.platform === "win32")
      ? this.armLaunchWaiter(
          plan.sessionId ? "session" : "cwd",
          plan.sessionId ? String(plan.sessionId) : normalizeDir(plan.cwd, this.platform),
          this.launchWaitMs,
          this.platform === "win32"
            ? { timeoutIsFailure: true, timeoutMessage: `${Math.max(1, Math.round(this.launchWaitMs / 1000))} 秒内没看到会话上线（窗口可能还在启动；若 pi 没装或启动失败，看新控制台里的报错）` }
            : {},
        )
      : null;
    const child = this.spawnImpl(spec.file, spec.args, spec.options);
    if (child && typeof child.unref === "function") child.unref();
    // 占用记下 tmux 会话名：之后能直接查 pi 还在不在
    const claim = spec.tmuxSession ? { at: Date.now(), tmuxSession: spec.tmuxSession } : { at: Date.now() };
    if (plan.sessionId) this.spawnedBySession.set(String(plan.sessionId), claim);
    else {
      const key = normalizeDir(plan.cwd, this.platform);
      if (key) this.spawnedByCwd.set(key, { ...claim, roomId: null });
    }
    if (spec.tmuxSession) {
      return this.watchTmuxLaunch(child, spec.tmuxSession, tmux, release).then((why) => (why ? { failed: why } : {}));
    }
    if (child && typeof child.on === "function") {
      child.on("error", (e) => {
        const why = e && e.message ? e.message : String(e);
        release(why);
        if (waiter) waiter.fail(why);
      });
      // open / cmd 立刻返回：非 0 退出就是没拉起来（找不到 Terminal、start 失败…）
      child.on("exit", (code) => {
        if (!code) return;
        const why = `${spec.file} 退出码 ${code}`;
        release(why);
        if (waiter) waiter.fail(why);
      });
    }
    if (waiter) {
      return waiter.promise.then((out) => {
        if (out && out.failed) {
          release(out.failed);
          return { failed: out.failed };
        }
        if (out && out.pending) {
          this.scheduleClaimGrace(plan);
          this.writeOut(`Terminal 已打开，但 ${Math.max(1, Math.round(this.launchWaitMs / 1000))} 秒内没看到会话上线；按已启动处理，稍后可在网页上看房间是否出现`);
          return { roomId: null, pending: true };
        }
        return { roomId: out && out.roomId ? out.roomId : null };
      });
    }
    return null;
  }

  /** tmux 版本只探一次；没找到 tmux 下次再探（装上 tmux 不用重开窗口） */
  tmux() {
    if (!this.tmuxInfo) this.tmuxInfo = probeTmux(this.spawnSyncImpl);
    return this.tmuxInfo;
  }

  /** tmux 客户端专用环境：非 UTF-8 调用方注入本机存在的 UTF-8 locale，避免 tmux 3.4 把制表符净化成下划线 */
  tmuxEnv() {
    if (this._tmuxEnv) return this._tmuxEnv;
    if (this.tmuxLocale === undefined) {
      this.tmuxLocale = tmuxLocaleOverride(this.spawnSyncImpl, this.env, this.platform);
    }
    this._tmuxEnv = tmuxEnvWithLocale(this.env, this.tmuxLocale);
    return this._tmuxEnv;
  }

  tmuxRun(args) {
    try {
      const r = this.spawnSyncImpl("tmux", args, { encoding: "utf8", timeout: 5000, env: this.tmuxEnv() });
      return r && !r.error ? r : null;
    } catch {
      return null;
    }
  }

  /** tmux 会话里的 pi 还在吗：会话没了、窗格都已退出（remain-on-exit 留的现场）都算不在；查不了按还在 */
  tmuxAlive(session) {
    const r = this.tmuxRun(["list-panes", "-s", "-t", "=" + session, "-F", "#{pane_dead}"]);
    if (!r) return true;
    if (r.status !== 0) return false;
    return String(r.stdout || "").split("\n").some((line) => line.trim() === "0");
  }

  claimAlive(rec) {
    return !(rec && rec.tmuxSession) || this.tmuxAlive(rec.tmuxSession);
  }

  /**
   * tmux new-session 立刻返回：非 0 就是没开成（会话名冲突、目录没了）。开成了再等 tmuxSettleMs，
   * pi 当场就退了（找不到 pi、配置坏了）也算启动失败报回去，网页不用干等到超时。兑现为失败原因，成功为 null。
   */
  watchTmuxLaunch(child, session, tmux, release) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (why) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (why) release(why);
        resolve(why || null);
      };
      if (!child || typeof child.on !== "function") {
        finish(null);
        return;
      }
      // tmux 卡住不回话：按已拉起处理
      timer = setTimeout(() => finish(null), this.tmuxExitWaitMs);
      child.on("error", (e) => finish(e && e.code === "ENOENT" ? `找不到 tmux（${tmuxInstallHint(this.platform)}）` : (e && e.message) || String(e)));
      child.on("exit", (code) => {
        if (code) {
          finish(`tmux 退出码 ${code}`);
          return;
        }
        clearTimeout(timer);
        timer = setTimeout(() => finish(this.tmuxEarlyExit(session, tmux)), this.tmuxSettleMs);
      });
    });
  }

  /** 刚拉起的 pi 已经退了就返回原因（退出码 + 窗格最后一行）；还在跑、或查不了，返回 null */
  tmuxEarlyExit(session, tmux) {
    const r = this.tmuxRun(["list-panes", "-s", "-t", "=" + session, "-F", "#{pane_dead} #{pane_dead_status}"]);
    if (!r) return null;
    if (r.status !== 0) {
      const why = tmux && tmux.keepFailed ? "" : "；tmux 低于 3.2 留不下现场，在本机手动跑 start-pi.sh 看原因";
      // 会话已经收掉（pi 退得比 remain-on-exit 设置还快）也要读落盘码：这是 tmux 丢窗格字段时的最后兜底
      const code = readExitCode(session, this.exitHome);
      return `pi 刚起来就退出了（tmux 会话 ${session} 已结束${code == null ? "" : `，退出码 ${code}`}${why}）`;
    }
    const dead = String(r.stdout || "")
      .split("\n")
      .map((line) => line.trim().split(" "))
      .find(([flag]) => flag === "1");
    if (!dead) return null;
    // tmux 3.4 约四成概率丢 #{pane_dead_status}（按信号退出时也会空）：落盘文件兜底
    const paneCode = dead[1] == null || dead[1] === "" ? null : dead[1];
    const code = paneCode != null ? paneCode : readExitCode(session, this.exitHome);
    // 窗格一死，之前的输出常被挤进回滚区：要带上历史（-S）才抓得到
    const shot = this.tmuxRun(["capture-pane", "-p", "-J", "-S", "-200", "-t", `=${session}:`]);
    // 末行是 tmux 自己补的「Pane is dead (status N, 时间)」，跳过它取 pi 的最后一句
    const lines = shot && shot.status === 0 ? String(shot.stdout || "").split("\n").map((l) => l.trim()) : [];
    const last = lines.filter((l) => l && !/^Pane is dead\b/.test(l)).pop() || "";
    return `pi 退出了（退出码 ${code == null ? "?" : code}）${last ? "：" + last.slice(0, 160) : ""}。tmux attach -t ${session} 看现场`;
  }

  shutdown(reason, code = 0) {
    if (this.closing) return;
    this.closing = true;
    this.clearTimers();
    if (this.launchWaiters.size) this.abandonLaunchWaiters();
    this.releaseKeepAwake();
    if (this.onShutdown) {
      try {
        this.onShutdown();
      } catch {}
    }
    this.unbindProcessSignals();
    if (this._onExit) {
      process.removeListener("exit", this._onExit);
      this._onExit = null;
    }
    if (this.ownsStateFile()) removeQuiet(this.attachFile);
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    this.authed = false;
    if (ws) {
      try {
        ws.close();
      } catch {}
    }
    if (reason) this.writeOut(reason);
    this.writeOwnExitCode(code);
    // 失败原因要反映到退出码：调用脚本（attach.cmd / 部署）不能把失败当成功
    if (this.exit) this.exit(code);
  }
}

function launcherText(platform = HOST_PLATFORM) {
  if (platform === "win32") return "新控制台";
  if (platform === "darwin") return "Terminal 新窗口；.env 设 PI_REMOTE_LAUNCHER=tmux 则开 tmux 后台会话";
  return "tmux 后台会话，tmux attach 可接管";
}

function printHelp() {
  console.log(`pi-remote attach [项目目录...] [--max-hours 12] [--init]
pi-remote attach --pair XXXX-XXXX [--relay ws://<服务器>:7001]
pi-remote attach --link [--relay ws://<服务器>:7001]
pi-remote attach --share
pi-remote attach --doctor

开一个连接窗口：登记本机设备，窗口内扩展才连 relay。
  --pair        用网页上「添加设备」给的配对码换这台电脑自己的设备令牌，写进 .env 后退出
  --link        在本机出示二维码与对照码，手机扫码确认后把设备令牌写进 .env 后退出（relay 需支持扫码链接；太旧时改用 --pair）
  --share       免服务器模式：拉起本机 relay 并开公网隧道，只出示访问地址（局域网地址 + 隧道网址，各带二维码），不配对
  --tunnel      连接窗口 / --link 时顺带开 Cloudflare 公网隧道（仅免服务器模式；默认关，按需开；网址每次都会变）
  --relay       配对时使用的 relay 地址（.env 还没配 PI_REMOTE_RELAY 时用）
  --env <file>  显式指定 env 文件（默认仓库根 .env；也可用 ATTACH_ENV_FILE）
                本地真实测试必须用独立 env + 127.0.0.1 relay，禁止连生产
  --allow-remote 允许连接非 localhost relay（默认拒绝；部署/冒烟才用，需显式确认）
  --init        尚未配置 PI_REMOTE_DEVICE_ID 时写入 .env 片段，已有则不动
  --doctor      本机自检（只读）：node / pi / 扩展 / .env / relay 端口 / 连接窗口 / 拉起方式
  --max-hours   窗口最长小时数，默认 12。到点删状态文件并断开
  --viewer-port viewer 端口（默认 7002；也可用 PI_REMOTE_VIEWER_PORT），状态行提示用
无目录参数时只开窗口；带目录则在每个目录拉起一份 pi（${launcherText()}）。
Ctrl+C / 关终端 / 到期即断开。已经拉起的 pi 不会被关掉。${
    HOST_PLATFORM === "darwin" ? "\n窗口开着时这台 Mac 不会空闲睡眠（合盖照常睡；.env 设 PI_REMOTE_KEEP_AWAKE=0 关掉）。" : ""
  }`);
}

/** TCP 连通性探测：只证明端口可达，不鉴权、不登记设备 */
function tcpProbe(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(String(url));
    } catch {
      resolve({ ok: false, error: "地址格式不对" });
      return;
    }
    const port = Number(target.port) || (target.protocol === "wss:" || target.protocol === "https:" ? 443 : 80);
    const socket = net.connect({ host: target.hostname, port });
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({ ok: true }));
    socket.once("timeout", () => finish({ ok: false, error: `${timeoutMs}ms 内没有连上` }));
    socket.once("error", (e) => finish({ ok: false, error: e.code || e.message }));
  });
}

/** 文件存在、不是目录、可执行（POSIX 查 X_OK；Windows 由调用方按扩展名判断） */
function isExecutableFile(file, platform = HOST_PLATFORM) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 在 PATH 里按文件名找（Windows 的 node 是 .cmd shim，spawn "pi" 不一定起得来，doctor 要先能看见它） */
function findOnPath(names, platform, environ = process.env) {
  const raw = String((environ && (environ.PATH || environ.Path || environ.path)) || "");
  if (!raw) return "";
  const dirs = raw.split(platform === "win32" ? ";" : path.delimiter);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return "";
}

/**
 * pi 路径可执行性（doctor 用，纯函数便于单测）：
 *   ""                                  → 没问题
 *   "路径不存在：…"                       → PI_REMOTE_PI_BIN 写错/被卸载
 *   "不是可执行文件：…" / "没有可执行权限" → 目录、脚本没 chmod +x
 *   "Windows 上要指向 .exe / .cmd / …"    → npm 装出来的 pi 是 pi.cmd，不能是 .ps1 / 无扩展名
 * P13 deploy 低-6：以前 doctor 不看这个，路径写错也照样打印 ✓ pi。
 */
function piBinaryProblem(file, platform = HOST_PLATFORM) {
  const p = String(file || "").trim();
  if (!p) return "PI_REMOTE_PI_BIN 是空的";
  if (p === "pi") return ""; // findPiInfo 的 PATH 哨兵：spawn("pi", --version) 已经成功过
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return `路径不存在：${p}`;
  }
  if (!st.isFile()) return `不是可执行文件：${p}`;
  if (platform === "win32") {
    const ext = path.extname(p).toLowerCase();
    if (![".exe", ".cmd", ".bat", ".com"].includes(ext)) return `Windows 上要指向 .exe / .cmd / .bat / .com：${p}`;
    return "";
  }
  try {
    fs.accessSync(p, fs.constants.X_OK);
  } catch {
    return `没有可执行权限：${p}`;
  }
  return "";
}

/**
 * 找 pi：PI_REMOTE_PI_BIN > PATH > 常见安装位置（与 start-pi.sh 的查找顺序一致）。
 * 返回 { path, from }：PATH 命中时 path 是哨兵 "pi"（spawn 已经验证过可执行），doctor 据此区分
 * "用户写死的路径"（必须自己验存在+可执行）和 "PATH 里找到的命令"。
 */
function findPiInfo(spawnSyncImpl = spawnSync, environ = process.env, platform = HOST_PLATFORM) {
  const fromEnv = String((environ && environ.PI_REMOTE_PI_BIN) || "").trim();
  if (fromEnv) return { path: fromEnv, from: "env" };
  if (platform === "win32") {
    // npm 全局装出来的是 pi.cmd；CreateProcess 不能直接起批处理，spawn("pi") 常常 EINVAL。
    const onPath = findOnPath(["pi.exe", "pi.cmd", "pi.bat", "pi"], platform, environ);
    if (onPath) return { path: onPath, from: "PATH" };
  }
  try {
    const r = spawnSyncImpl("pi", ["--version"], { encoding: "utf8", timeout: 4000 });
    if (r && !r.error && r.status === 0) return { path: "pi", from: "PATH" };
  } catch {}
  const home = String((environ && (environ.HOME || environ.USERPROFILE)) || os.homedir());
  const candidates = [
    // 精简 PATH（launchd / cron）下 nvm 装的 pi 不在 PATH：按 node 版本从新到旧找
    ...nvmNodeBins(home, environ).map((dir) => path.join(dir, "pi")),
    "/opt/homebrew/bin/pi",
    "/usr/local/bin/pi",
    path.join(home, ".npm-global", "bin", "pi"),
    path.join(home, ".local", "bin", "pi"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return { path: candidate, from: "常见位置" };
    } catch {}
  }
  return null;
}

/** 兼容旧调用：只要路径字符串（空串 = 没找到） */
function findPiBinary(spawnSyncImpl = spawnSync, environ = process.env, platform = HOST_PLATFORM) {
  const info = findPiInfo(spawnSyncImpl, environ, platform);
  return info ? info.path : "";
}

function md5File(file) {
  try {
    return crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
}

/**
 * 本机自检：把"为什么连不上/为什么启动不了"变成一条条可执行的结论。
 * 只读：不连本地 relay 鉴权、不写 .env、不动状态文件。
 */
async function doctorMain(args, envPath, opts = {}) {
  const out = opts.writeOut || ((line) => console.log(line));
  const platform = opts.platform || HOST_PLATFORM;
  const spawnSyncImpl = opts.spawnSyncImpl || spawnSync;
  const probe = opts.probe || tcpProbe;
  const rows = [];
  let fails = 0;
  const add = (level, name, detail = "") => {
    if (level === "fail") fails++;
    rows.push({ level, name, detail });
  };

  add("ok", `pi-remote attach ${ATTACH_VERSION}`, `${platform} · node ${process.versions.node}`);
  const major = Number(String(process.versions.node).split(".")[0]);
  const minor = Number(String(process.versions.node).split(".")[1]);
  if (major < 22 || (major === 22 && minor < 18)) add("fail", "Node 版本太低", "需要 Node ≥ 22.18（前端测试与 pi 都依赖内置类型剥离）");

  const cfg = loadConfig(envPath, opts.env || process.env, platform);
  if (!fs.existsSync(envPath)) add("fail", "找不到 .env", envPath + "；先运行 node deploy/setup.cjs <relay地址>");
  else add("ok", ".env", envPath);
  if (!cfg.relay) add("fail", "没有 PI_REMOTE_RELAY", "在 .env 里填 ws://<服务器>:7001");
  else add("ok", "relay 地址", cfg.relay);
  if (!cfg.deviceId) add("fail", "没有设备编号", "运行 " + initHint(platform) + "、" + pairHint(platform) + " 或 " + linkHint(platform));
  else add("ok", "设备编号", cfg.deviceId);
  // 设备身份钥（阶段 1）先读一次：钥设备按设计就没有设备令牌，令牌行的判定要参考它（只读，不生成）
  const keyFile = deviceKeyFilePath(envPath, { env: opts.env || process.env });
  let devKeys = null;
  let keyErr = null;
  try {
    devKeys = loadDeviceKeys(keyFile);
  } catch (e) {
    keyErr = e;
  }
  if (cfg.deviceToken) add("ok", "设备令牌", "已配对（不会打印）");
  else if (cfg.token) add("warn", "只有共享令牌", "建议在网页「添加或管理设备」生成配对码，再运行 " + pairHint(platform) + "；或运行 " + linkHint(platform) + " 在本机出示二维码扫码链接");
  else if (devKeys) add("ok", "设备令牌", "无（本机已改用身份钥配对，见下一行）");
  else add("fail", "没有任何令牌", "先配对：" + pairHint(platform) + "，或扫码链接：" + linkHint(platform));

  // 身份钥行：只展示在不在、指纹、ACK 持仓数；私钥与 ACK 永不打印
  if (keyErr) add("fail", "设备身份钥损坏", keyErr && keyErr.message ? keyErr.message : String(keyErr));
  else if (devKeys) {
    add("ok", "设备身份钥", `指纹 ${formatFingerprint(keyFingerprint(devKeys.sign.pub))} · ${keyFile}`);
    const ackCount = devKeys.contentKeys && typeof devKeys.contentKeys === "object" ? Object.keys(devKeys.contentKeys).filter((k) => typeof devKeys.contentKeys[k] === "string" && devKeys.contentKeys[k]).length : 0;
    if (ackCount > 0) add("ok", "账号内容钥", `本机持有 ${ackCount} 个账号的 ACK（只存钥文件，从不打印）`);
  } else add("warn", "设备身份钥", "尚未生成（配对 " + pairHint(platform) + " 或 " + linkHint(platform) + " 时自动生成）；当前仍走令牌鉴权");

  if (cfg.relay) {
    const safety = attachRelaySafetyError(cfg.relay, { allowRemote: args.allowRemote });
    if (safety) add("warn", "非本地 relay（--doctor 只做 TCP 探测，不鉴权）", "本地真实测试请用 127.0.0.1 + --env；确需远端时加 --allow-remote");
    const r = await probe(cfg.relay);
    if (r.ok) add("ok", "relay 端口可达", cfg.relay);
    else add("fail", "relay 连不上", `${cfg.relay}：${r.error || "未知错误"}；检查地址、安全组、服务是否在跑`);
  }

  const piInfo = findPiInfo(spawnSyncImpl, opts.env || process.env, platform);
  if (!piInfo) add("fail", "找不到 pi", "安装 pi 或设置 PI_REMOTE_PI_BIN");
  else {
    // P13 deploy 低-6：用户写死的路径要先验存在 + 可执行（Windows 还按扩展名），不能 spawn 失败还报 ✓
    const problem = piInfo.path === "pi" ? "" : piBinaryProblem(piInfo.path, platform);
    if (problem) add("fail", "pi 路径不可用", `${problem}；改 PI_REMOTE_PI_BIN 或重新安装 pi`);
    else {
      let version = "";
      try {
        const r = spawnSyncImpl(piInfo.path, ["--version"], { encoding: "utf8", timeout: 4000 });
        if (r && r.status === 0) version = String(r.stdout || "").trim().split("\n")[0];
      } catch {}
      if (version) add("ok", "pi", `${piInfo.path} · ${version}`);
      else if (piInfo.from === "PATH") add("fail", "pi 无法运行", `${piInfo.path} --version 没有正常返回；重装 pi 或改 PI_REMOTE_PI_BIN`);
      else add("warn", "pi", `${piInfo.path}（--version 没有正常返回，可能装坏了）`);
    }
  }

  const extDir = path.join(opts.env && opts.env.PI_CODING_AGENT_DIR ? String(opts.env.PI_CODING_AGENT_DIR) : path.join(os.homedir(), ".pi", "agent"), "extensions");
  const extFile = path.join(extDir, "pi-remote-sync.ts");
  const repoExt = path.join(ROOT, "extension", "pi-remote-sync.ts");
  if (!fs.existsSync(extFile)) add("fail", "pi 扩展未安装", "运行 deploy/sync-extension.sh" + (platform === "win32" ? "（Windows：deploy\\sync-extension.ps1）" : ""));
  else {
    const a = md5File(extFile);
    const b = md5File(repoExt);
    if (a && b && a !== b) add("warn", "扩展与仓库版本不同", "重启 pi 前运行 deploy/sync-extension.sh 同步");
    else add("ok", "pi 扩展", extFile);
  }

  const stateFile = defaultAttachFile(opts.env || process.env);
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {}
  if (!state) add("ok", "连接窗口", "当前没开（设备离线）");
  else {
    const pid = Number(state.pid);
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (e) {
      alive = !!(e && e.code === "EPERM");
    }
    const remain = Number(state.expiresAt) - Date.now();
    if (!alive) add("warn", "连接窗口状态文件是残留", `pid ${pid} 已不在；下次 attach 会自动清掉`);
    else if (remain <= 0) add("warn", "连接窗口已到期", "attach 会自行断开；重新运行 attach");
    else add("ok", "连接窗口", `pid ${pid} · 剩余 ${formatRemain(remain)}`);
  }

  const picked = resolveLauncher(cfg.launcher, platform);
  if (platform === "darwin" && picked.launcher === "terminal") {
    let terminalOk = fs.existsSync("/System/Applications/Utilities/Terminal.app") || fs.existsSync("/Applications/Utilities/Terminal.app");
    if (!terminalOk) {
      try {
        const r = spawnSyncImpl("open", ["-Ra", "Terminal"], { timeout: 4000 });
        terminalOk = !!(r && !r.error && r.status === 0);
      } catch {}
    }
    add(terminalOk ? "ok" : "fail", "Terminal 拉起方式", terminalOk ? `Terminal 新窗口 · 等会话上线 ${cfg.launchWaitMs || TERMINAL_LAUNCH_WAIT_MS}ms` : "找不到 Terminal.app；改设 PI_REMOTE_LAUNCHER=tmux");
  } else if (picked.launcher === "tmux") {
    const tmux = probeTmux(spawnSyncImpl);
    // P13 deploy 低-1：提示按平台/发行版给（Linux 上不能让人 brew install tmux）
    const installHint = tmuxInstallHint(platform);
    add(tmux ? "ok" : "fail", "tmux 拉起方式", tmux ? `${tmux.version}${tmux.keepFailed ? "" : "（<3.2，失败现场留不住）"}` : "找不到 tmux；" + installHint);
  } else {
    add(
      "ok",
      "拉起方式",
      platform === "win32"
        ? `新控制台 · 等会话上线 ${cfg.launchWaitMs || WIN_LAUNCH_WAIT_MS}ms`
        : picked.launcher,
    );
  }
  if (picked.warning) add("warn", "拉起方式配置", picked.warning);

  const doctorEnv = opts.env || process.env;
  if (platform !== "win32" && (picked.launcher === "tmux" || platform === "linux")) {
    const locale = currentLocale(doctorEnv);
    const injected = tmuxLocaleOverride(spawnSyncImpl, doctorEnv, platform);
    if (localeIsUtf8(locale)) add("ok", "语言环境", locale);
    else if (injected) add("warn", "语言环境", `${locale || "未设置"}：tmux 调用已注入 ${injected}（tmux 3.4 在非 UTF-8 下会净化制表符）`);
    else add("warn", "语言环境", `${locale || "未设置"}：本机没有可用的 UTF-8 locale，tmux 输出按兼容格式解析（中文可能乱码）；建议 export LANG=C.UTF-8`);
  }

  if (platform === "darwin" && cfg.keepAwake) {
    const ok = isExecutableFile("/usr/bin/caffeinate");
    add(ok ? "ok" : "warn", "防休眠", ok ? "caffeinate 可用" : "找不到 caffeinate；不影响连接");
  } else if (platform === "linux" && cfg.keepAwake) {
    // 不只看文件在不在：没有可执行位同样起不来（P13 deploy 低-2 的核对项）
    const ok = ["/usr/bin/systemd-inhibit", "/bin/systemd-inhibit"].some((p) => isExecutableFile(p)) || !!findOnPath(["systemd-inhibit"], "linux", opts.env || process.env);
    add(
      ok ? "ok" : "warn",
      "防休眠",
      ok ? "systemd-inhibit 可用（非 idle/sleep 阻断；非登录会话没有 polkit 权限时会自动放弃，不影响连接）" : "找不到 systemd-inhibit；防休眠没开，不影响连接",
    );
  }

  if (cfg.projects.length) {
    const missing = cfg.projects.filter((p) => {
      try {
        return !fs.statSync(p).isDirectory();
      } catch {
        return true;
      }
    });
    if (missing.length) add("warn", "项目白名单有目录不存在", missing.map(displayPathOf).join("；"));
    else add("ok", "项目白名单", cfg.projects.map(displayPathOf).join("；"));
  } else {
    add("warn", "项目白名单为空", "网页上看不到可新建会话的目录；在 .env 填 PI_REMOTE_PROJECTS");
  }

  // P9 C：浏览根目录（网页「打开文件夹…」只用这些根目录；空 = 关闭）
  if (cfg.browseRoots && cfg.browseRoots.length) {
    add("ok", "浏览根目录", cfg.browseRoots.join("；"));
  } else {
    add("info", "浏览根目录", "已关闭（PI_REMOTE_BROWSE_ROOTS 为空时缺省家目录；off/0/false 关闭浏览）");
  }
  // P9 B：删除方式与反向同步
  const trash = hasTrashCommand(platform, opts.env || process.env);
  add(trash ? "ok" : "info", "删除方式", trash ? "PATH 里有 trash：网页删除会先移进废纸篓" : "PATH 里没有 trash：网页删除会直接删文件（不可恢复）");
  const rescanMs = Number(cfg.libraryRescanMs) > 0 ? Math.max(LIBRARY_RESCAN_MIN_MS, Number(cfg.libraryRescanMs)) : LIBRARY_RESCAN_MS;
  add("info", "清单反扫", `每 ${Math.round(rescanMs / 1000)}s 对一次本机会话目录（PI_REMOTE_LIBRARY_RESCAN_MS，下限 5s）`);

  const viewerPort = Number((opts.env && opts.env.PI_REMOTE_VIEWER_PORT) || process.env.PI_REMOTE_VIEWER_PORT) || 7002;
  const viewer = viewerUrlFromRelay(cfg.relay, viewerPort);
  if (cfg.relay) add("ok", "viewer 地址", viewer);

  // 免服务器（本地）模式：配置一致性、本地 relay 存活、cloudflared 准备情况、
  // 以及对管家记录在案的运行中隧道参数做目标核对（设计 §5.3：只许指向 viewer 端口）
  const modeInfo = localModeInfo(cfg.relay, opts.root || ROOT);
  if (modeInfo.configExists) {
    if (modeInfo.local) add("ok", "免服务器模式", "本地 relay 配置在位（" + modeInfo.configPath + "），attach 开窗时当管家拉起本机 relay");
    else add("warn", "本地 relay 配置对不上", "relay/config.json 在，但 .env 的 PI_REMOTE_RELAY 不是指向它的本机回环地址；attach 不会接管这个 relay");
    const healthy = await (opts.healthProbe || ((port) => httpHealthz(port, 1500)))(modeInfo.viewerPort);
    if (healthy) add("ok", "本地 relay", `http://127.0.0.1:${modeInfo.viewerPort}/healthz 正常`);
    else add("info", "本地 relay", "当前没在跑（开 attach 窗口时自动拉起，不用手动管）");
    const cfLib = loadCloudflaredLib();
    let cfDetail = "";
    if (cfLib) {
      try {
        const resolved = await (opts.resolveCloudflared || ((o) => cfLib.resolveCloudflared(o)))({ allowDownload: false, env: opts.env || process.env });
        cfDetail = `${resolved.bin}（${resolved.source === "path" ? "系统已装" : resolved.source === "cache" ? "已下载缓存" : "已指定"}）`;
      } catch {}
    }
    if (cfDetail) add("ok", "cloudflared", cfDetail);
    else add("info", "cloudflared", "还没准备：第一次开隧道（--tunnel / --share）时自动从官方 Release 下载钉死版本并校验哈希（约 40MB）");
    let keeperRec = null;
    try {
      keeperRec = JSON.parse(fs.readFileSync(keeperStatePath(opts.env || process.env), "utf8"));
    } catch {}
    if (keeperRec && Array.isArray(keeperRec.tunnelArgs) && keeperRec.tunnelArgs.length) {
      const verdict = cfLib ? cfLib.verifyTunnelArgsSafe(keeperRec.tunnelArgs, { viewerPort: modeInfo.viewerPort, localPort: modeInfo.localPort }) : "cloudflared 模块缺失，无法核对";
      if (!verdict) add("ok", "隧道目标核对", `记录中的隧道只指向 viewer 端口 ${modeInfo.viewerPort}，本地通道 ${modeInfo.localPort} 未进隧道${keeperRec.tunnelUrl ? "；当前网址 " + keeperRec.tunnelUrl : ""}`);
      else add("fail", "隧道目标异常", verdict);
    }
  }

  const logFile = path.join(os.homedir(), ".pi", "agent", "pi-remote-sync.log");
  try {
    const tail = fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).slice(-3);
    if (tail.length) add("info", "扩展日志（末 3 行）", tail.join(" / ").slice(0, 300));
  } catch {}

  const icon = { ok: "✓", warn: "!", fail: "✗", info: "·" };
  out(`pi-remote doctor · ${platformLabel(platform)}`);
  for (const row of rows) out(`${icon[row.level]} ${row.name}${row.detail ? "：" + row.detail : ""}`);
  out(fails ? `${fails} 项需要处理` : "全部通过");
  return fails ? 1 : 0;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  // ① env 来源显式可配：--env > ATTACH_ENV_FILE > 默认仓库根 .env（默认保留旧行为，但打印来源+风险提示）
  const envInfo = resolveEnvFile(argv);
  const envPath = envInfo.path;
  if (envInfo.explicit && !fs.existsSync(envPath)) {
    console.error("找不到 --env/ATTACH_ENV_FILE 指定的 env 文件：" + envPath);
    return 1;
  }
  if (envInfo.explicit) console.log(`[attach] env 文件：${envPath}（来源：${envInfo.source}）`);
  else console.log(`[attach] env 文件：${envPath}（来源：默认仓库根 .env；本地测试请用 --env 或 ATTACH_ENV_FILE 指向独立 env）`);
  if (args.doctor) return doctorMain(args, envPath);
  if (args.pair) return pairMain(args, envPath, { enforceSafety: true });
  if (args.link) return linkMain(args, envPath, { enforceSafety: true });
  if (args.share) return shareMain(args, envPath);
  if (args.init) {
    const result = initEnvFile(envPath, { deviceName: macComputerName() });
    if (result.changed) console.log("已写入 .env：PI_REMOTE_DEVICE_ID=" + result.deviceId);
    else console.log("PI_REMOTE_DEVICE_ID 已存在，未修改 .env");
    return 0;
  }
  const cfg = loadConfig(envPath);
  if (!cfg.deviceId) {
    console.error("缺少 PI_REMOTE_DEVICE_ID。请先配对：" + pairHint() + "，或扫码链接：" + linkHint() + "（或 " + initHint() + "）");
    return 1;
  }
  if (!cfg.relay || (!cfg.token && !cfg.deviceToken && !hasUsableDeviceKey(envPath, cfg.deviceId))) {
    console.error("缺少 PI_REMOTE_RELAY，或 PI_REMOTE_TOKEN 与设备令牌都没配。请先配对：" + pairHint() + "，或扫码链接：" + linkHint());
    return 1;
  }
  // ② 本地安全 guard：非 localhost relay 默认直接退出，必须 --allow-remote 显式确认
  const relaySafety = attachRelaySafetyError(cfg.relay, { allowRemote: args.allowRemote });
  if (relaySafety) {
    console.error(relaySafety);
    return 2;
  }
  if (!isLocalRelayHost(relayHostOf(cfg.relay) || "")) printRemoteRelayWarning(cfg.relay, envPath);
  // 免服务器模式：attach 当管家——先把本机 relay 拉起来并等就绪（控制器写状态文件放行扩展在那之后，
  // 顺序不能反，否则扩展连空端口白白退避）；--tunnel 按需顺带开公网隧道。关窗时控制器 shutdown 钩子回收管家。
  let keeper = null;
  const modeInfo = localModeInfo(cfg.relay);
  if (modeInfo.local) {
    keeper = createLocalKeeper({
      config: modeInfo.config,
      relay: cfg.relay,
      viewerPort: args.viewerPort || undefined,
      out: (line) => console.log(line),
      onTunnel: (t) => {
        const line = tunnelStatusLine(t);
        if (line) console.log(line);
      },
    });
    try {
      const ensured = await keeper.ensureRelay();
      console.log(
        ensured.owned
          ? "免服务器模式：本地 relay 已由 attach 拉起（关掉这个窗口，整套本地服务就停）"
          : "免服务器模式：本地 relay 已在运行（不是本窗口拉起的，本窗口不接管它）",
      );
      printLocalAccessLines(keeper, (line) => console.log(line));
      if (args.tunnel) Promise.resolve(keeper.startTunnel()).catch(() => {});
    } catch (e) {
      console.error("本地 relay 没能启动：" + (e && e.message ? e.message : e));
      await keeper.stop();
      return 1;
    }
    process.on("exit", () => keeper.killAllSync());
  }
  // 身份钥（阶段 1）：钥文件在且完好 → 窗口走挑战-签名鉴权；损坏时按设计 §3.1 明示后回退令牌路（不许静默）
  let deviceKeys = null;
  try {
    deviceKeys = loadDeviceKeys(deviceKeyFilePath(envPath));
  } catch (e) {
    console.error("设备钥文件不可用，本次窗口回退令牌鉴权：" + (e && e.message ? e.message : e));
  }
  const ctl = new AttachController({
    relay: cfg.relay,
    token: cfg.token,
    deviceToken: cfg.deviceToken,
    deviceKeys,
    keyFilePath: deviceKeyFilePath(envPath),
    accountId: cfg.accountId,
    deviceId: cfg.deviceId,
    deviceName: cfg.deviceName,
    projects: cfg.projects,
    // P9 B/C：会话根目录反扫与文件夹浏览都由 loadConfig 解析后传进控制器
    browseRoots: cfg.browseRoots,
    libraryRescanMs: cfg.libraryRescanMs,
    launcher: cfg.launcher,
    terminalApp: cfg.terminalApp,
    keepAwake: cfg.keepAwake,
    launchWaitMs: cfg.launchWaitMs !== "" && Number.isFinite(Number(cfg.launchWaitMs)) ? Number(cfg.launchWaitMs) : undefined,
    dirs: args.dirs,
    maxHours: args.maxHours,
    viewerPort: args.viewerPort,
    viewerUrlProvider: keeper ? () => keeper.origin() : undefined,
    onShutdown: keeper
      ? () => {
          keeper.stop();
        }
      : undefined,
    attachFile: defaultAttachFile(),
    bindSignals: true,
    exit: (code) => process.exit(code),
  });
  ctl.start();
  return 0;
}

/**
 * --pair / --link 共用落盘：把签发结果写进 .env（令牌不打印），写完收紧文件权限。
 * keyCtx 在场时一并写钥文件路径（只有路径、没有钥料——扩展凭它找钥文件，设计 §3.1）。
 * 钥形态（result.keyRegistered）：没有令牌可写，把 .env 里的旧设备令牌清空——relay 在
 * 登记钥时已作废该设备的令牌行（设计 §3.4），本机留着残值只会诱使扩展误走令牌路；
 * 随后回填钥文件的 deviceId，并在本机是首台钥设备时生成自持 ACK（finalizePairKeys）。
 */
function persistPairResult(args, envPath, cfg, result, keyCtx = null) {
  const vars = { PI_REMOTE_DEVICE_ID: result.deviceId, PI_REMOTE_DEVICE_TOKEN: result.deviceToken || "" };
  if (keyCtx) vars[DEVICE_KEY_PATH_VAR] = keyCtx.file;
  if (args.relay && args.relay !== cfg.relay) vars.PI_REMOTE_RELAY = args.relay;
  if (!cfg.deviceName || !fs.existsSync(envPath)) vars.PI_REMOTE_DEVICE_NAME = cfg.deviceName;
  writeEnvVars(envPath, vars);
  // 设备令牌已落盘：再显式收紧一次，避免旧 .env 的宽权限被 writeEnvVars 之外的路径沿用
  restrictEnvFileMode(envPath);
  if (keyCtx) {
    keyCtx.keys = syncDeviceKeyId(keyCtx.file, keyCtx.keys, result.deviceId);
    if (result.keyRegistered) finalizePairKeys(keyCtx, result);
  }
}

/** --pair：换设备令牌并写进 .env；已有的设备编号带上，名册和会话清单保持不变 */
async function pairMain(args, envPath, opts = {}) {
  const out = opts.writeOut || ((line) => console.log(line));
  const err = opts.writeErr || ((line) => console.error(line));
  const cfg = loadConfig(envPath, opts.env || process.env, opts.platform || HOST_PLATFORM);
  const relay = args.relay || cfg.relay;
  if (!relay) {
    err("不知道 relay 地址：加上 --relay ws://<服务器>:7001，或先在 .env 里配 PI_REMOTE_RELAY");
    return 1;
  }
  if (opts.enforceSafety === true) {
    const relaySafety = attachRelaySafetyError(relay, { allowRemote: args.allowRemote });
    if (relaySafety) {
      err(relaySafety);
      return 2;
    }
    if (!isLocalRelayHost(relayHostOf(relay) || "")) printRemoteRelayWarning(relay, envPath);
  }
  // 身份钥（阶段 1）：配对前确保本机有钥（没有就生成）；钥文件损坏直接报错停下，
  // 不许悄悄退回令牌配对——那会把损坏伪装成「新设备」，还可能把已登记的身份顶掉
  let keyCtx = null;
  try {
    keyCtx = ensureDeviceKeys(envPath, { env: opts.env || process.env, deviceId: cfg.deviceId });
  } catch (e) {
    err(e && e.message ? e.message : String(e));
    return 1;
  }
  out(`正在向 ${relay} 配对…`);
  const result = await requestPairing({
    relay,
    code: args.pair,
    deviceId: cfg.deviceId,
    deviceName: cfg.deviceName,
    deviceToken: cfg.deviceToken,
    deviceKeys: keyCtx.keys,
    platform: opts.platform || HOST_PLATFORM,
    WebSocketImpl: opts.WebSocketImpl,
    timeoutMs: opts.timeoutMs,
  });
  if (!result.ok) {
    err(`配对失败（${result.code}）：${result.error}`);
    return 1;
  }
  persistPairResult(args, envPath, cfg, result, keyCtx);
  if (result.keyRegistered) {
    out(`配对成功：设备 ${result.deviceId}，身份钥已登记（指纹 ${formatFingerprint(keyFingerprint(keyCtx.keys.sign.pub))}），本机不再使用设备令牌`);
    out(`钥文件：${keyCtx.file}（0600，含私钥，切勿外传）；.env 里只写了它的路径`);
    if (accountAckOf(keyCtx.keys, result.accountId)) out("本机持有本账号的内容钥 ACK（只存钥文件，从不打印）。");
    else if (result.hasKeyHolder === true) out("本账号已有持钥设备，本机尚未持有内容钥（ACK）：上线后会自动向持钥设备索取；若那台设备已不在，请在那台设备上处理，或走重新交付。");
    out("下一步：重启正在运行的 pi（扩展启动时读取钥文件），然后运行 attach 打开连接窗口。");
  } else {
    out(`配对成功：设备 ${result.deviceId}，令牌已写入 ${envPath}（令牌不打印，.env 权限 600）`);
    out("下一步：重启正在运行的 pi（扩展启动时读取令牌），然后运行 attach 打开连接窗口。");
  }
  return 0;
}

/* ---------- --link：pi 运行端出示二维码 / 对照码，手机确认后落盘 ----------
 * 流程（findings/qr-pairing-design.md §2/§3/§6）：本机连 relay 本地通道发 pair_request 申请码
 * （码仍由 relay 发行，与手输码同一张表、同一 TTL、一次性），终端 + 本机窗口页出示二维码；
 * 手机扫码在 viewer 落地页批准后，relay 沿这条等待连接回 pair_result，本机复用 persistPairResult 落盘。
 * 二维码只是码的搬运工：码绑定这条连接，连接断开即失效；手输 --pair 长期保留为兜底。
 */

let qrLibCache = null;
/** vendored 二维码编码器（deploy/qrcode.js）；部署包缺文件时返回 null，出示自动降级为只打印链接 + 码 */
function loadQrLib() {
  if (qrLibCache) return qrLibCache;
  try {
    qrLibCache = require("./qrcode.js");
  } catch {
    qrLibCache = null;
  }
  return qrLibCache;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

/** 用系统默认浏览器打开本地窗口页；失败不致命（调用方打印 URL 兜底） */
function openBrowserDefault(url, platform = HOST_PLATFORM, spawnImpl = spawn) {
  try {
    let file;
    let args;
    if (platform === "win32") {
      file = "cmd.exe";
      args = ["/c", "start", "", String(url)];
    } else if (platform === "darwin") {
      file = "open";
      args = [String(url)];
    } else {
      file = "xdg-open";
      args = [String(url)];
    }
    const child = spawnImpl(file, args, { detached: true, stdio: "ignore" });
    if (child && typeof child.on === "function") child.on("error", () => {});
    if (child && typeof child.unref === "function") child.unref();
    return true;
  } catch {
    return false;
  }
}

/** 终端出示：字符二维码（带 4 模块静区）+ 链接全文 + 格式化码 + 核对字 + 防转发提示。
 *  版本过高或渲染宽度超限时降级为只打印链接 + 码（窗口页里仍有真码大图）。 */
function printLinkOffer(state, { out, terminalWidth }) {
  const qr = loadQrLib();
  let svg = "";
  let lines = null;
  if (qr) {
    try {
      const m = qr.createQrMatrix(state.url);
      svg = qr.matrixToSvg(m.modules);
      if (m.version <= 16) {
        const rendered = qr.matrixToTerminalLines(m.modules, { quiet: 4 });
        if (rendered.length && rendered[0].length <= terminalWidth) lines = rendered;
      }
    } catch {}
  }
  state.qrSvg = svg;
  out("");
  out("用手机扫一扫下面的二维码，在手机上确认后，这台设备就链接好了：");
  if (lines) {
    for (const line of lines) out(line);
  } else {
    out("（终端里没画二维码：窗口太窄、链接太长或编码器不可用。用下面的链接和对照码，或打开图形窗口看大图二维码）");
  }
  out("");
  out("扫不了码时，用手机浏览器打开这个链接，再输入对照码：");
  out("  " + state.url);
  out("设备对照码：" + state.codeFormatted);
  if (state.checkDigits) out("核对字：" + state.checkDigits + "（手机确认页会显示同一个核对字，对上再点确认）");
  out(`链接码只能用一次，到期作废（剩余约 ${formatRemain(state.expiresAt - Date.now())}）；不要拍照转发给别人。`);
}

/** 窗口页轮询 /state 的数据面：只放出示所需字段，令牌永不进这个通道 */
function linkWindowStateJson(state) {
  return {
    phase: state.phase,
    deviceName: state.deviceName,
    platformLabel: state.platformLabel,
    codeFormatted: state.codeFormatted || "",
    checkDigits: state.checkDigits || "",
    qrSvg: state.qrSvg || "",
    url: state.url || "",
    expiresAt: state.expiresAt || 0,
    ttlMs: state.ttlMs || 0,
    serverNow: Date.now(),
  };
}

/**
 * 链接窗口页（用户定版设计：qr-window-design，四态同窗切换）。
 * 服务端只负责把当前 state 烤进首屏 JSON，之后页面每 900ms 轮询 /state 换态；
 * 二维码是真码 SVG（qrcode.js 矩阵渲染，含 4 模块静区、深码浅底），倒计时以 expiresAt 为准。
 */
function renderLinkPage(state) {
  const initial = JSON.stringify(linkWindowStateJson(state)).replace(/</g, "\\u003c");
  const deviceName = escapeHtml(state.deviceName || "");
  const platform = escapeHtml(state.platformLabel || "");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pi-Remote · 链接这台设备</title>
<style>
  :root{
    --page-bg:#0e0e10; --main-bg:rgba(20,20,23,.55);
    --t1:#ededf0; --t2:#c9c9cf; --t3:#a9a9b1; --t4:#7c7c84; --t5:#5f5f66;
    --ic:#8e8e96; --ink:#ececf1;
    --line:rgba(255,255,255,.08); --card-line:rgba(255,255,255,.07);
    --accent:#a78bfa; --wait:#e0a63f; --ok:#3fb96f;
    --hover:rgba(255,255,255,.045); --sel:rgba(255,255,255,.07);
    --font:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif;
    --mono:ui-monospace,"SF Mono","Cascadia Mono",Consolas,"Roboto Mono",monospace;
  }
  *{margin:0;padding:0;box-sizing:border-box;}
  body{ font-family:var(--font); color:var(--t1); background:var(--page-bg); -webkit-font-smoothing:antialiased; }
  .stage{
    min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:34px 20px 56px;
    background:
      radial-gradient(880px 520px at 10% -8%, rgba(106,74,224,.16), rgba(106,74,224,0) 60%),
      radial-gradient(760px 520px at 96% 108%, rgba(47,90,160,.12), rgba(47,90,160,0) 62%),
      linear-gradient(160deg,#17181b 0%,#0e0e10 58%,#101013 100%);
  }
  .win{
    width:400px; max-width:92vw; border-radius:16px; overflow:hidden; background:var(--main-bg);
    -webkit-backdrop-filter:blur(28px) saturate(1.2); backdrop-filter:blur(28px) saturate(1.2);
    border:1px solid var(--line); box-shadow:0 24px 64px rgba(0,0,0,.5), 0 4px 16px rgba(0,0,0,.35);
  }
  .whead{ display:flex; align-items:flex-start; padding:20px 22px 0; }
  .whead .tt{ flex:1; min-width:0; }
  .whead h1{ font-size:15px; font-weight:600; color:var(--t1); line-height:21px; }
  .whead .sub{ margin-top:3px; font-size:12.5px; line-height:17px; color:var(--t3); }
  .xbtn{
    width:26px; height:26px; flex:none; margin:-2px -4px 0 10px; border:0; border-radius:6px;
    background:transparent; color:var(--ic); cursor:pointer; display:flex; align-items:center; justify-content:center;
  }
  .xbtn:hover{ background:var(--hover); color:var(--t1); }
  .devrow{ margin:16px 22px 0; display:flex; align-items:center; gap:10px; background:rgba(255,255,255,.05); border-radius:10px; padding:9px 12px; }
  .devtile{ width:30px; height:30px; flex:none; border-radius:8px; background:rgba(255,255,255,.09); color:#dcdce0; display:flex; align-items:center; justify-content:center; }
  .devrow .dn{ flex:1; min-width:0; }
  .devrow .dn .n{ font-size:13.5px; font-weight:600; color:var(--t1); line-height:18px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .devrow .dn .m{ font-size:11.5px; color:var(--t4); line-height:15px; margin-top:1px; }
  .ondot{ width:7px; height:7px; border-radius:50%; background:var(--ok); flex:none; }
  .devrow .st{ font-size:11.5px; color:var(--t3); flex:none; }
  .wbody{ padding:20px 22px 22px; }
  .qrcard{ position:relative; width:260px; margin:0 auto; border-radius:12px; background:#f4f4f5; padding:26px; box-shadow:0 2px 10px rgba(0,0,0,.35); }
  .qrbox{ width:208px; height:208px; }
  .qrbox svg{ display:block; width:208px; height:208px; }
  .qrcard .veil{
    position:absolute; inset:0; border-radius:12px; display:none;
    align-items:center; justify-content:center; flex-direction:column; gap:9px;
    background:rgba(16,16,18,.58); color:#f2f2f4; text-align:center; padding:0 18px;
  }
  .qrcard .veil.show{ display:flex; }
  .qrcard .veil .vt{ font-size:13.5px; font-weight:600; line-height:19px; }
  .qrcard .veil .vs{ font-size:11.5px; line-height:16px; color:rgba(242,242,244,.72); }
  .spin{ width:26px; height:26px; border-radius:50%; flex:none; border:3px solid rgba(255,255,255,.22); border-top-color:#fff; animation:sp 0.9s linear infinite; }
  @keyframes sp{ to{ transform:rotate(360deg);} }
  .qr-hint{ margin-top:14px; text-align:center; font-size:13px; line-height:18px; color:var(--t3); }
  .qr-hint b{ color:var(--t2); font-weight:600; }
  .is-expired .qrbox{ filter:grayscale(1); opacity:.28; }
  .is-processing .qrbox{ opacity:.35; }
  .divider{ height:1px; background:var(--card-line); margin:20px 0 16px; }
  .codelab{ display:flex; align-items:baseline; justify-content:space-between; }
  .codelab .lb{ font-size:11px; letter-spacing:.12em; color:var(--t4); text-transform:uppercase; }
  .codelab .alt{ font-size:11.5px; color:var(--t5); }
  .coderow{ margin-top:8px; display:flex; align-items:center; gap:8px; }
  .code{
    flex:1; text-align:center; font-family:var(--mono); font-size:27px; font-weight:600; letter-spacing:3px; color:var(--ink);
    line-height:36px; background:rgba(255,255,255,.04); border:1px solid var(--card-line); border-radius:10px; padding:7px 4px 8px;
  }
  .code .dash{ color:var(--t5); }
  .is-expired .code{ color:var(--t5); text-decoration:line-through; text-decoration-thickness:1px; }
  .copybtn{
    width:38px; height:38px; flex:none; border:1px solid var(--card-line); border-radius:10px;
    background:rgba(255,255,255,.04); color:var(--ic); cursor:pointer; display:flex; align-items:center; justify-content:center;
  }
  .copybtn:hover{ background:var(--hover); color:var(--t1); }
  .is-expired .copybtn, .is-processing .copybtn{ opacity:.35; pointer-events:none; }
  .cdrow{ margin-top:16px; display:flex; align-items:center; gap:10px; }
  .cdrow .ct{ font-size:12.5px; color:var(--t3); white-space:nowrap; }
  .cdrow .ct b{ font-family:var(--mono); font-weight:600; color:var(--t2); font-size:12.5px; }
  .cdrow .ct.warn b{ color:var(--wait); }
  .cdrow .ct .digits{ font-size:15px; color:var(--t1); }
  .track{ flex:1; height:3px; border-radius:99px; background:rgba(255,255,255,.09); overflow:hidden; }
  .track i{ display:block; height:100%; border-radius:99px; background:var(--accent); transition:width 1s linear; }
  .is-expired .track i{ background:var(--t5); }
  .foot{ margin-top:14px; font-size:11.5px; line-height:16px; color:var(--t5); }
  .actions{ margin-top:18px; display:flex; gap:8px; }
  .btn{
    flex:1; height:36px; border-radius:9px; border:0; cursor:pointer; font-family:var(--font); font-size:13.5px; font-weight:600;
    display:flex; align-items:center; justify-content:center; gap:7px;
  }
  .btn.pri{ background:#ececf1; color:#17181b; }
  .btn.pri:hover{ background:#ffffff; }
  .btn.ghost{ background:rgba(255,255,255,.06); color:var(--t2); flex:0 0 104px; }
  .btn.ghost:hover{ background:rgba(255,255,255,.09); color:var(--t1); }
  .okwrap{ padding:8px 0 2px; text-align:center; }
  .okring{
    width:64px; height:64px; margin:6px auto 0; border-radius:50%; border:2px solid var(--ok);
    display:flex; align-items:center; justify-content:center; color:var(--ok); box-shadow:0 0 0 8px rgba(63,185,111,.10);
  }
  .okwrap h2{ margin-top:16px; font-size:16px; font-weight:600; color:var(--t1); }
  .okwrap p{ margin-top:6px; font-size:13px; line-height:19px; color:var(--t3); }
  .okwrap .auto{ margin-top:12px; font-size:12px; color:var(--t5); }
  .okwrap .auto b{ font-family:var(--mono); color:var(--t3); font-weight:600; }
  .statepane{ display:none; }
  .statepane.on{ display:block; }
</style>
</head>
<body>
<div class="stage">
  <section class="win" id="win" aria-label="设备链接窗口">
    <div class="whead">
      <div class="tt">
        <h1>链接这台设备</h1>
        <div class="sub">用手机扫码，或在手机上输入对照码，把这台正在运行 pi 的设备链接到你的账号。</div>
      </div>
      <button class="xbtn" title="关闭" aria-label="关闭" onclick="doneClose()">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="devrow">
      <div class="devtile">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 14h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      </div>
      <div class="dn">
        <div class="n">${deviceName}</div>
        <div class="m">${platform} · pi 正在这台设备上运行</div>
      </div>
      <span class="ondot" title="在线"></span><span class="st">在线</span>
    </div>
    <div class="wbody">

      <div class="statepane on" data-pane="1">
        <div class="qrcard">
          <div class="qrbox"></div>
          <div class="veil" id="veilConn">
            <div class="spin"></div>
            <div class="vt">正在向 relay 申请链接码…</div>
            <div class="vs">马上就好</div>
          </div>
        </div>
        <div class="qr-hint">用手机相机或浏览器<b>扫一扫</b>上方二维码</div>
        <div class="divider"></div>
        <div class="codelab"><span class="lb">设备对照码</span><span class="alt">扫不了码时，在手机上输入这一枚</span></div>
        <div class="coderow">
          <div class="code paircode">····<span class="dash">-</span>····</div>
          <button class="copybtn" title="复制对照码" aria-label="复制对照码" onclick="copyCode()">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.6" stroke="currentColor" stroke-width="1.3"/><path d="M11 5V3.6A1.6 1.6 0 0 0 9.4 2H3.6A1.6 1.6 0 0 0 2 3.6v5.8A1.6 1.6 0 0 0 3.6 11H5" stroke="currentColor" stroke-width="1.3"/></svg>
          </button>
        </div>
        <div class="cdrow" id="digitsrow" style="display:none">
          <span class="ct">核对字 <b class="digits"></b></span>
          <span class="ct" style="color:var(--t5)">手机确认页会显示同一个核对字，对上再点确认</span>
        </div>
        <div class="cdrow">
          <span class="ct cdtext">剩余 <b>--:--</b></span>
          <div class="track"><i class="cdbar"></i></div>
          <span class="ct" style="color:var(--t5)">到期自动失效</span>
        </div>
        <div class="foot">二维码与对照码是同一枚一次性链接码，只可使用一次；链接成功后立即失效。不要拍照转发给别人。</div>
      </div>

      <div class="statepane is-processing" data-pane="2">
        <div class="qrcard">
          <div class="qrbox"></div>
          <div class="veil show">
            <div class="spin"></div>
            <div class="vt">已扫码，正在完成链接…</div>
            <div class="vs">请在手机上确认链接这台设备</div>
          </div>
        </div>
        <div class="qr-hint">手机已打开链接页，<b>请在手机上确认</b></div>
        <div class="divider"></div>
        <div class="codelab"><span class="lb">设备对照码</span><span class="alt">已被手机领取，无需再输入</span></div>
        <div class="coderow">
          <div class="code paircode" style="color:var(--t4)">····<span class="dash">-</span>····</div>
          <button class="copybtn" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.6" stroke="currentColor" stroke-width="1.3"/><path d="M11 5V3.6A1.6 1.6 0 0 9.4 2H3.6A1.6 1.6 0 0 0 2 3.6v5.8A1.6 1.6 0 0 0 3.6 11H5" stroke="currentColor" stroke-width="1.3"/></svg>
          </button>
        </div>
        <div class="cdrow">
          <span class="ct cdtext">剩余 <b>--:--</b></span>
          <div class="track"><i class="cdbar"></i></div>
          <span class="ct" style="color:var(--t5)">等待手机确认</span>
        </div>
        <div class="foot">如果不是你本人扫的码，请直接关闭这个窗口（或在终端按 Ctrl-C），这枚码会立即作废。</div>
      </div>

      <div class="statepane" data-pane="3">
        <div class="okwrap">
          <div class="okring">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none"><path d="M4.5 12.5l5 5L19.5 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </div>
          <h2>链接成功</h2>
          <p>这台设备已链接到你的账号。<br>现在可以在手机上查看并控制它的 pi 会话。</p>
          <div class="auto">窗口将在 <b id="autoclose">5</b> 秒后自动关闭</div>
        </div>
        <div class="actions">
          <button class="btn ghost" onclick="regen()">再链接一台</button>
          <button class="btn pri" onclick="doneClose()">完成</button>
        </div>
        <div class="foot" style="text-align:center">这枚链接码已使用并失效，截图留存也无法再次使用。</div>
      </div>

      <div class="statepane is-expired" data-pane="4">
        <div class="qrcard">
          <div class="qrbox"></div>
          <div class="veil show">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7"/><path d="M12 7v5.2l3.4 2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
            <div class="vt">这枚链接码已过期</div>
            <div class="vs">为安全起见，链接码到期后自动失效</div>
          </div>
        </div>
        <div class="qr-hint">二维码已失效，扫码不会有任何效果</div>
        <div class="divider"></div>
        <div class="codelab"><span class="lb">设备对照码</span><span class="alt">已失效</span></div>
        <div class="coderow">
          <div class="code paircode">····<span class="dash">-</span>····</div>
          <button class="copybtn" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.6" stroke="currentColor" stroke-width="1.3"/><path d="M11 5V3.6A1.6 1.6 0 0 0 9.4 2H3.6A1.6 1.6 0 0 0 2 3.6v5.8A1.6 1.6 0 0 0 3.6 11H5" stroke="currentColor" stroke-width="1.3"/></svg>
          </button>
        </div>
        <div class="actions">
          <button class="btn pri" onclick="regen()">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89M13.5 1.8v2.6h-2.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            重新生成链接码
          </button>
        </div>
        <div class="foot">重新生成后，旧码彻底作废，只有新码有效。若按钮没反应，说明 attach 已经退出，回终端重新运行即可。</div>
      </div>

    </div>
  </section>
</div>
<script>
  var S = ${initial};
  var phase = "";
  var closeTimer = null;
  var closeLeft = 0;
  function el(id){ return document.getElementById(id); }
  function all(sel){ return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function setPane(n){
    all('.statepane').forEach(function(p){ p.classList.toggle('on', +p.getAttribute('data-pane') === n); });
  }
  function fmtRemain(ms){
    if (ms < 0) ms = 0;
    var s = Math.ceil(ms / 1000);
    var mm = String(Math.floor(s / 60)); var ss = String(s % 60);
    if (mm.length < 2) mm = '0' + mm;
    if (ss.length < 2) ss = '0' + ss;
    return mm + ':' + ss;
  }
  function tickCountdown(){
    if (!S.expiresAt) return;
    var remain = S.expiresAt - Date.now();
    var total = S.ttlMs > 0 ? S.ttlMs : 600000;
    all('.cdtext').forEach(function(t){
      t.innerHTML = '剩余 <b>' + fmtRemain(remain) + '</b>';
      t.classList.toggle('warn', remain <= 60000);
    });
    all('.cdbar').forEach(function(b){ b.style.width = Math.max(0, Math.min(100, remain / total * 100)) + '%'; });
    if (remain <= 0 && (phase === 'waiting' || phase === 'processing')) setPane(4);
  }
  function startCloseCountdown(){
    stopCloseCountdown();
    closeLeft = 5;
    var e = el('autoclose');
    if (e) e.textContent = closeLeft;
    closeTimer = setInterval(function(){
      closeLeft--;
      if (closeLeft <= 0){ stopCloseCountdown(); doneClose(); return; }
      if (e) e.textContent = closeLeft;
    }, 1000);
  }
  function stopCloseCountdown(){ if (closeTimer){ clearInterval(closeTimer); closeTimer = null; } }
  function applyState(s){
    S = s;
    if (s.qrSvg) all('.qrbox').forEach(function(b){
      if (b.getAttribute('data-svg') !== s.qrSvg){ b.innerHTML = s.qrSvg; b.setAttribute('data-svg', s.qrSvg); }
    });
    if (s.codeFormatted){
      var html = s.codeFormatted.replace('-', '<span class="dash">-</span>');
      all('.paircode').forEach(function(c){ c.innerHTML = html; });
    }
    var dr = el('digitsrow');
    if (dr) dr.style.display = s.checkDigits ? '' : 'none';
    if (s.checkDigits) all('.digits').forEach(function(d){ d.textContent = s.checkDigits; });
    el('veilConn').style.display = s.phase === 'connecting' ? 'flex' : 'none';
    if (s.phase !== phase){
      phase = s.phase;
      stopCloseCountdown();
      if (phase === 'done'){ setPane(3); startCloseCountdown(); }
      else if (phase === 'expired') setPane(4);
      else if (phase === 'processing') setPane(2);
      else setPane(1);
    }
    tickCountdown();
  }
  function regen(){ try { fetch('/regen', { method: 'POST' }); } catch (e) {} }
  function doneClose(){ try { window.close(); } catch (e) {} }
  function copyCode(){
    var t = (S.codeFormatted || '').replace(/-/g, '');
    if (t && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).catch(function(){});
  }
  setInterval(tickCountdown, 250);
  setInterval(function(){
    fetch('/state').then(function(r){ return r.json(); }).then(applyState).catch(function(){});
  }, 900);
  applyState(S);
</script>
</body>
</html>`;
}

/** 本机窗口页服务：只绑 127.0.0.1 随机端口；GET / 出页面、GET /state 出状态、POST /regen 请求重新生成 */
function startLinkWindowServer(state, opts = {}) {
  const onRegen = typeof opts.onRegen === "function" ? opts.onRegen : () => {};
  const server = http.createServer((req, res) => {
    try {
      const u = new URL(String(req.url || "/"), "http://127.0.0.1");
      if (req.method === "GET" && u.pathname === "/state") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(linkWindowStateJson(state)));
        return;
      }
      if (req.method === "POST" && u.pathname === "/regen") {
        onRegen();
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
        return;
      }
      if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(renderLinkPage(state));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    } catch {
      try {
        res.writeHead(500);
        res.end();
      } catch {}
    }
  });
  return new Promise((resolve) => {
    server.once("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}/`,
        close: () => {
          try {
            server.close();
          } catch {}
        },
      });
    });
  });
}

/**
 * 一轮 --link 尝试：连本地通道，第一帧发 pair_request，等 pair_request_result（onCode 出示），
 * 再等 pair_result（结果帧与 requestPairing 同形）。过期有三种到达方式——pair_expired 帧、
 * pair_result/error 带 pair_expired、本地到点——都归一成 { ok:false, code:"pair_expired", expired:true }。
 * relay 太旧不认识 pair_request（unknown_type）→ code:"unsupported"，调用方提示改用 --pair。
 */
function requestLinkAttempt({ relay, deviceId, deviceName, deviceToken, deviceKeys, platform = HOST_PLATFORM, WebSocketImpl, timeoutMs = PAIR_TIMEOUT_MS, onCode, onClaimed, registerAbort }) {
  return new Promise((resolve) => {
    let WS = WebSocketImpl;
    if (!WS) {
      try {
        WS = require("ws");
      } catch (e) {
        resolve({ ok: false, code: "internal", error: "无法加载 ws：" + (e && e.message ? e.message : e) });
        return;
      }
    }
    const expiredResult = () => ({
      ok: false,
      code: "pair_expired",
      expired: true,
      error: (PROTOCOL.errors.pair_expired && PROTOCOL.errors.pair_expired.message) || "链接码已过期，请重新生成",
    });
    let done = false;
    let ws;
    let expiryTimer = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
      try {
        ws && ws.close();
      } catch {}
      resolve(result);
    };
    const hardTimer = setTimeout(() => finish({ ok: false, code: "timeout", error: "relay 没有回应链接请求" }), timeoutMs);
    if (typeof registerAbort === "function") registerAbort(() => finish({ ok: false, code: "aborted", error: "已取消" }));
    try {
      ws = new WS(relay);
    } catch (e) {
      finish({ ok: false, code: "offline", error: "连不上 relay：" + (e && e.message ? e.message : e) });
      return;
    }
    const device = { name: deviceName || defaultDeviceName(platform), platform: platformId(platform) };
    if (deviceId) device.id = deviceId;
    // 重新链接已有设备时 relay 要核验旧令牌防接管：与 pair 帧同口径，device 内外各放一份
    if (deviceToken) device.deviceToken = String(deviceToken);
    // 带钥申请（阶段 1，relay 契约）：pop 必须绑一枚确定的码、而 relay 发码在申请之后——
    // 所以带钥时码由本机生成并随帧带上（frame.code），pop 签它；relay 验签后采用这枚码、
    // 核对字升级 SAS v2。不带钥的旧申请不带 code，relay 照旧发码、v1 核对字，逐字节不变。
    const selfCode = deviceKeys ? newDevicePairCode() : "";
    const onOpen = () => {
      try {
        const frame = { type: "pair_request", proto: PROTOCOL.proto, device };
        if (deviceToken) frame.deviceToken = String(deviceToken);
        if (deviceKeys) {
          frame.code = selfCode;
          frame.keys = { signPub: deviceKeys.sign.pub, boxPub: deviceKeys.box.pub, pop: signPairPop(deviceKeys, selfCode) };
        }
        ws.send(JSON.stringify(frame));
      } catch (e) {
        finish({ ok: false, code: "offline", error: "发送链接请求失败：" + (e && e.message ? e.message : e) });
      }
    };
    const onMessage = (data) => {
      let msg;
      try {
        msg = JSON.parse(typeof data === "string" ? data : String(data));
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== "string") return;
      if (msg.type === "pair_request_result") {
        // 失败形态（relay 契约）：{ok:false, code:错误码, error}——这里的 code 是错误码不是配对码，别当码解析
        if (msg.ok === false) {
          finish({ ok: false, code: typeof msg.code === "string" && msg.code ? msg.code : "pair_invalid", error: msg.error || "relay 拒绝了链接请求" });
          return;
        }
        clearTimeout(hardTimer);
        const code = String(msg.code || "").toUpperCase().replace(/[\s-]+/g, "");
        const expiresAt = Number(msg.expiresAt) || 0;
        if (!code || !expiresAt) {
          finish({ ok: false, code: "pair_invalid", error: "relay 回的链接码不完整" });
          return;
        }
        const info = { code, expiresAt, checkDigits: msg.checkDigits == null ? "" : String(msg.checkDigits) };
        try {
          if (onCode) onCode(info);
        } catch {}
        expiryTimer = setTimeout(() => finish(expiredResult()), Math.max(0, expiresAt - Date.now()));
        return;
      }
      if (msg.type === "pair_claimed") {
        try {
          if (onClaimed) onClaimed();
        } catch {}
        return;
      }
      if (msg.type === "pair_expired") {
        finish(expiredResult());
        return;
      }
      if (msg.type === "pair_result") {
        const r = pairResultFromMsg(msg);
        if (r && r.ok) finish(r);
        else if ((msg.code || "") === "pair_expired") finish(expiredResult());
        else finish(r);
        return;
      }
      if (msg.type === "error" && typeof msg.code === "string") {
        if (msg.code === "unknown_type") {
          finish({ ok: false, code: "unsupported", error: "relay 版本太旧，不支持扫码链接（先升级服务器上的 relay）" });
        } else if (msg.code === "pair_expired") {
          finish(expiredResult());
        } else {
          finish({ ok: false, code: msg.code, error: msg.error || "relay 拒绝了链接请求" });
        }
      }
    };
    const onClose = () => finish({ ok: false, code: "offline", error: "等待链接时 relay 断开了连接" });
    if (typeof ws.on === "function") {
      ws.on("open", onOpen);
      ws.on("message", onMessage);
      ws.on("close", onClose);
      ws.on("error", () => {});
    } else {
      ws.onopen = onOpen;
      ws.onmessage = (ev) => onMessage(ev && ev.data !== undefined ? ev.data : ev);
      ws.onclose = onClose;
      ws.onerror = () => {};
    }
  });
}

/** --link：向 relay 申请链接码 → 终端 + 本机窗口出示 → 等手机批准 → 复用 persistPairResult 落盘 */
async function linkMain(args, envPath, opts = {}) {
  const out = opts.writeOut || ((line) => console.log(line));
  const err = opts.writeErr || ((line) => console.error(line));
  const platform = opts.platform || HOST_PLATFORM;
  const cfg = loadConfig(envPath, opts.env || process.env, platform);
  const relay = args.relay || cfg.relay;
  if (!relay) {
    err("不知道 relay 地址：加上 --relay ws://<服务器>:7001，或先在 .env 里配 PI_REMOTE_RELAY");
    return 1;
  }
  if (opts.enforceSafety === true) {
    const relaySafety = attachRelaySafetyError(relay, { allowRemote: args.allowRemote });
    if (relaySafety) {
      err(relaySafety);
      return 2;
    }
    if (!isLocalRelayHost(relayHostOf(relay) || "")) printRemoteRelayWarning(relay, envPath);
  }
  // 身份钥（阶段 1）：与 --pair 同口径——出示前确保本机有钥，损坏直接报错，不静默退回令牌路
  let keyCtx = null;
  try {
    keyCtx = ensureDeviceKeys(envPath, { env: opts.env || process.env, deviceId: cfg.deviceId });
  } catch (e) {
    err(e && e.message ? e.message : String(e));
    return 1;
  }
  const deviceName = cfg.deviceName || defaultDeviceName(platform);
  const viewerPort = args.viewerPort || Number((opts.env || process.env).PI_REMOTE_VIEWER_PORT) || 7002;
  // 本地模式下会被管家的当前出示源覆盖（见下方管家接入段），故用 let
  let viewer = viewerUrlFromRelay(relay, viewerPort);
  const state = {
    phase: "connecting",
    deviceName,
    platformLabel: platformLabel(platform),
    code: "",
    codeFormatted: "",
    checkDigits: "",
    url: "",
    qrSvg: "",
    expiresAt: 0,
    ttlMs: 0,
    issuedAt: 0,
  };
  // 免服务器模式的管家（下方接入）：非本地模式恒为 null，link 行为与旧版完全一致
  let keeper = null;

  // 窗口页「重新生成」/ 成功页「再链接一台」的等待者：linkMain 主循环在收尾态等它
  let regenResolve = null;
  const pokeRegen = (why) => {
    if (regenResolve) regenResolve(why || "regen");
  };
  const waitRegen = (ms) =>
    new Promise((resolve) => {
      if (!(ms > 0)) {
        resolve("timeout");
        return;
      }
      const timer = setTimeout(() => {
        regenResolve = null;
        resolve("timeout");
      }, ms);
      regenResolve = (why) => {
        clearTimeout(timer);
        regenResolve = null;
        resolve(why || "regen");
      };
    });

  let win = null;
  if (opts.linkWindow !== false) {
    win = await startLinkWindowServer(state, { onRegen: () => pokeRegen("regen") });
    if (win && opts.openBrowser !== false) openBrowserDefault(win.url, platform, opts.spawnImpl || spawn);
  }

  let aborted = false;
  let abortAttempt = null;
  const signalSource = opts.signalSource || process;
  const onSignal = () => {
    aborted = true;
    if (abortAttempt) abortAttempt();
    pokeRegen("abort");
  };
  const bindSignals = opts.bindSignals !== false;
  if (bindSignals) {
    signalSource.on("SIGINT", onSignal);
    signalSource.on("SIGTERM", onSignal);
  }

  const terminalWidth = Number(opts.terminalWidth) || (process.stdout && process.stdout.columns) || 80;

  // 免服务器模式：先当管家把本机 relay 拉起来（就绪后才发 pair_request，否则必然连空端口）；
  // --tunnel 时顺带开隧道，网址就绪后出示源变了——同一枚码换新地址重出示（码与地址无关，
  // 手机已经打开的确认页照常批准）。opts.keeperFactory === null 时测试可显式关掉这段。
  if (opts.keeperFactory !== null) {
    const info = localModeInfo(relay, opts.root || ROOT);
    if (info.local || opts.keeperFactory) {
      const factory = opts.keeperFactory || ((o) => createLocalKeeper(o));
      keeper = factory({
        config: info.config || {},
        relay,
        root: opts.root || ROOT,
        platform,
        out,
        env: opts.env || process.env,
        stateFile: opts.stateFile,
        healthz: opts.healthz,
        spawnImpl: opts.keeperSpawnImpl,
        spawnSyncImpl: opts.spawnSyncImpl,
        readyTimeoutMs: opts.readyTimeoutMs,
        lanDeps: opts.lanDeps,
        resolveCloudflared: opts.resolveCloudflared,
        tunnelSpawnImpl: opts.tunnelSpawnImpl,
        tunnelHome: opts.tunnelHome,
        onTunnel: (t) => {
          if (t.status === "failed") err(tunnelStatusLine(t));
        },
      });
    }
    if (keeper) {
      try {
        await keeper.ensureRelay();
      } catch (e) {
        err("本地 relay 没能启动：" + (e && e.message ? e.message : e));
        if (bindSignals) {
          signalSource.removeListener("SIGINT", onSignal);
          signalSource.removeListener("SIGTERM", onSignal);
        }
        if (win) win.close();
        await keeper.stop();
        return 1;
      }
      viewer = keeper.origin();
      keeper.setOnOriginChange(() => {
        if (!state.code || (state.phase !== "waiting" && state.phase !== "processing")) return;
        const next = keeper.origin() + "#pair=" + state.code;
        if (next === state.url) return;
        state.url = next;
        out("访问地址已更新（公网隧道已就绪）：同一枚链接码，改扫这个新地址的二维码——");
        printLinkOffer(state, { out, terminalWidth });
      });
      if (args.tunnel) Promise.resolve(keeper.startTunnel()).catch(() => {});
    }
  }

  out(`正在向 ${relay} 申请链接码…`);
  if (win) out(`链接窗口：${win.url}（只在本机 127.0.0.1 打开；没自动弹出来就把这个地址粘到浏览器里，或直接看终端）`);

  let exitCode = 1;
  try {
    for (;;) {
      state.phase = "connecting";
      state.code = "";
      state.codeFormatted = "";
      state.checkDigits = "";
      state.url = "";
      state.qrSvg = "";
      state.expiresAt = 0;
      state.ttlMs = 0;
      const result = await requestLinkAttempt({
        relay,
        deviceId: cfg.deviceId,
        deviceName,
        deviceToken: cfg.deviceToken,
        deviceKeys: keyCtx.keys,
        platform,
        WebSocketImpl: opts.WebSocketImpl,
        timeoutMs: opts.timeoutMs,
        registerAbort: (fn) => {
          abortAttempt = fn;
        },
        onClaimed: () => {
          state.phase = "processing";
        },
        onCode: (info) => {
          state.phase = "waiting";
          state.code = info.code;
          state.codeFormatted = formatPairCode(info.code);
          state.checkDigits = info.checkDigits;
          state.expiresAt = info.expiresAt;
          state.issuedAt = Date.now();
          state.ttlMs = Math.max(0, info.expiresAt - state.issuedAt);
          state.url = (keeper ? keeper.origin() : viewer) + "#pair=" + info.code;
          printLinkOffer(state, { out, terminalWidth });
        },
      });
      abortAttempt = null;
      if (aborted || result.code === "aborted") {
        out("已取消链接。");
        exitCode = 130;
        break;
      }
      if (result.ok) {
        persistPairResult(args, envPath, cfg, result, keyCtx);
        state.phase = "done";
        if (result.keyRegistered) {
          out(`链接成功：设备 ${result.deviceId}，身份钥已登记（指纹 ${formatFingerprint(keyFingerprint(keyCtx.keys.sign.pub))}），本机不再使用设备令牌`);
          out(`钥文件：${keyCtx.file}（0600，含私钥，切勿外传）；.env 里只写了它的路径`);
          if (accountAckOf(keyCtx.keys, result.accountId)) out("本机持有本账号的内容钥 ACK（只存钥文件，从不打印）。");
          else if (result.hasKeyHolder === true) out("本账号已有持钥设备，本机尚未持有内容钥（ACK）：上线后会自动向持钥设备索取；若那台设备已不在，请在那台设备上处理，或走重新交付。");
          out("下一步：重启正在运行的 pi（扩展启动时读取钥文件），然后运行 attach 打开连接窗口。");
        } else {
          out(`链接成功：设备 ${result.deviceId}，令牌已写入 ${envPath}（令牌不打印，.env 权限 600）`);
          out("下一步：重启正在运行的 pi（扩展启动时读取令牌），然后运行 attach 打开连接窗口。");
        }
        const linger = opts.doneLingerMs == null ? 6000 : Number(opts.doneLingerMs);
        const why = await waitRegen(linger);
        if (why === "regen" && !aborted) continue;
        exitCode = aborted ? 130 : 0;
        break;
      }
      if (result.expired || result.code === "pair_expired") {
        state.phase = "expired";
        err("这枚链接码已过期，没有完成链接。");
        out("重新运行 " + linkHint(platform) + " 会生成新码；也可以改用手输配对码：" + pairHint(platform));
        const grace = opts.regenGraceMs == null ? (win ? 30000 : 0) : Number(opts.regenGraceMs);
        const why = grace > 0 ? await waitRegen(grace) : "timeout";
        if (why === "regen" && !aborted) {
          out("正在生成新的链接码…");
          continue;
        }
        exitCode = aborted ? 130 : 1;
        break;
      }
      err(`链接失败（${result.code}）：${result.error}`);
      if (result.code === "unsupported") err("改用手输配对码：" + pairHint(platform) + "（先在网页「添加设备」里生成配对码）");
      exitCode = 1;
      break;
    }
  } finally {
    if (bindSignals) {
      signalSource.removeListener("SIGINT", onSignal);
      signalSource.removeListener("SIGTERM", onSignal);
    }
    if (win) win.close();
    if (keeper) {
      try {
        await keeper.stop();
      } catch {}
    }
  }
  return exitCode;
}

/* ---------- 免服务器（本地）模式：attach 当管家 ----------
 * 设计 findings/local-tunnel-design.md §2/§3/§4/§5。模式判定：.env 的 relay 指向回环
 * 且仓库里有 relay/config.json（setup.cjs --local 的产物）。管家职责：拉起并看护本机 relay
 * （就绪之后才轮到控制器写状态文件放行扩展）、算局域网出示地址、按需（--tunnel / --share）
 * 开 Cloudflare quick tunnel 并换源重出示。relay 本体与协议零改动；隧道只穿 viewer 端口，
 * 本地通道（localPort）永不进隧道。隧道默认关：不开时行为与纯局域网完全一致。
 */

let cloudflaredLibCache;
function loadCloudflaredLib() {
  if (cloudflaredLibCache !== undefined) return cloudflaredLibCache;
  try {
    cloudflaredLibCache = require("./cloudflared.cjs");
  } catch {
    cloudflaredLibCache = null;
  }
  return cloudflaredLibCache;
}

const LOCAL_RELAY_READY_TIMEOUT_MS = 15000;
const RELAY_RESTART_MIN_MS = 2000;
const RELAY_RESTART_MAX_MS = 30000;
const KEEPER_STATE_NAME = "pi-remote-local.json";

/** 管家状态文件与连接窗口状态文件同目录（~/.pi/agent/）：记录自有 relay/隧道 pid 供残留清理与 doctor 核对 */
function keeperStatePath(environ = process.env) {
  return path.join(path.dirname(defaultAttachFile(environ)), KEEPER_STATE_NAME);
}

/** 读 relay/config.json（setup --local 的产物）；不存在/解析失败返回 null */
function readLocalRelayConfig(root = ROOT) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "relay", "config.json"), "utf8"));
    return cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : null;
  } catch {
    return null;
  }
}

/**
 * local 模式判定：有本地 relay 配置 + relay 地址是回环 + 端口与配置的 localPort 对得上。
 * 端口对不上说明 .env 指的是另一个本地 relay（开发调试等），attach 不接管、不拉起、不杀。
 */
function localModeInfo(relayUrl, root = ROOT) {
  const configPath = path.join(root, "relay", "config.json");
  const config = readLocalRelayConfig(root);
  const info = {
    local: false,
    configExists: !!config,
    configPath,
    config,
    localPort: config ? Number(config.localPort) || 7001 : 7001,
    viewerPort: config ? Number(config.viewerPort) || 7002 : 7002,
  };
  if (!config || !relayUrl) return info;
  const host = relayHostOf(relayUrl);
  if (!host || !isLocalRelayHost(host)) return info;
  let port = 7001;
  try {
    port = Number(new URL(relayUrl).port) || 7001;
  } catch {
    return info;
  }
  info.local = port === info.localPort;
  return info;
}

const VIRTUAL_IFACE_TOKENS = ["utun", "tun", "tap", "vmnet", "vbox", "wsl", "docker", "loopback", "vethernet", "hyper-v", "virtual"];

/** 网卡打分（纯函数）：剔内部/非 IPv4/link-local；默认路由源地址置顶；虚拟网卡降分。高分在前。 */
function rankLanCandidates(interfaces, routeAddress = "") {
  const out = [];
  for (const [name, list] of Object.entries(interfaces || {})) {
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || item.internal) continue;
      if (item.family !== "IPv4" && item.family !== 4) continue;
      const address = String(item.address || "");
      const m = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (!m || m.slice(1).some((n) => Number(n) > 255)) continue;
      if (address.startsWith("169.254.")) continue;
      let score = 100;
      const lower = String(name).toLowerCase();
      if (VIRTUAL_IFACE_TOKENS.some((t) => lower.includes(t))) score -= 500;
      if (routeAddress && address === routeAddress) score += 1000;
      out.push({ name, address, score });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** 默认路由源地址：UDP socket 只 connect 不发包，问操作系统「出门走哪块网卡」。失败/超时返回 "" */
function defaultRouteAddress(deps = {}) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = deps.createSocket ? deps.createSocket("udp4") : dgram.createSocket("udp4");
    } catch {
      resolve("");
      return;
    }
    let done = false;
    const finish = (addr) => {
      if (done) return;
      done = true;
      try {
        socket.close();
      } catch {}
      resolve(addr || "");
    };
    const timer = setTimeout(() => finish(""), deps.timeoutMs || 1000);
    try {
      socket.on("error", () => {
        clearTimeout(timer);
        finish("");
      });
      socket.connect(80, deps.target || "223.5.5.5", () => {
        clearTimeout(timer);
        let addr = "";
        try {
          addr = String(socket.address().address || "");
        } catch {}
        finish(addr);
      });
    } catch {
      clearTimeout(timer);
      finish("");
    }
  });
}

/** 局域网出示地址（只影响出示、不影响监听）：主地址 origin + 候选 origins + 备选 origins */
async function lanOrigin(viewerPort, deps = {}) {
  const port = Number(viewerPort) || 7002;
  const routeAddress = deps.defaultRouteAddress !== undefined ? deps.defaultRouteAddress : await defaultRouteAddress(deps);
  const interfaces = deps.networkInterfaces ? deps.networkInterfaces() : os.networkInterfaces();
  const ranked = rankLanCandidates(interfaces, routeAddress || "");
  let chosen = ranked.find((c) => routeAddress && c.address === routeAddress) || ranked[0] || null;
  if (!chosen && routeAddress) chosen = { name: "(默认路由)", address: routeAddress, score: 0 };
  const toOrigin = (address) => `http://${address}:${port}/`;
  return {
    address: chosen ? chosen.address : "",
    origin: chosen ? toOrigin(chosen.address) : "",
    candidates: ranked.map((c) => ({ name: c.name, address: c.address, origin: toOrigin(c.address) })),
    alternatives: ranked.filter((c) => !chosen || c.address !== chosen.address).map((c) => toOrigin(c.address)),
  };
}

/**
 * 当前出示源（纯函数，三级优先）：隧道网址 > 局域网地址（relay 在回环时） > viewerUrlFromRelay 推导。
 * lan 传 lanOrigin() 预先算好的 origin，保证本函数同步可用（状态行要同步调）。服务器模式行为与旧版一致。
 */
function currentViewerOrigin({ relay, viewerPort, tunnelUrl = "", lan = "" } = {}) {
  if (tunnelUrl) return String(tunnelUrl).replace(/\/?$/, "/");
  const derived = viewerUrlFromRelay(relay, viewerPort);
  if (lan && isLocalRelayHost(relayHostOf(relay) || "")) return lan;
  return derived;
}

/** GET http://127.0.0.1:<port>/healthz 是否 200（relay 的存活口径，不带任何令牌） */
function httpHealthz(port, timeoutMs = 1500, httpImpl = http) {
  return new Promise((resolve) => {
    let req;
    try {
      req = httpImpl.get({ host: "127.0.0.1", port: Number(port), path: "/healthz", timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
    } catch {
      resolve(false);
      return;
    }
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === "EPERM");
  }
}

/** 进程命令行（核对残留 pid 是不是我们拉起的那个进程，防 pid 复用误杀）：Linux 读 /proc，darwin 用 ps，其他平台返回 ""=核对不了 */
function processCmdline(pid, platform = HOST_PLATFORM, spawnSyncImpl = spawnSync) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return "";
  try {
    if (platform === "linux") return fs.readFileSync(`/proc/${n}/cmdline`, "utf8").replace(/\0/g, " ");
    if (platform === "darwin") {
      const r = spawnSyncImpl("ps", ["-p", String(n), "-o", "command="], { encoding: "utf8", timeout: 3000 });
      return r && !r.error && r.status === 0 ? String(r.stdout || "") : "";
    }
  } catch {}
  return "";
}

/** 杀进程组（POSIX 子进程以 detached 拉起、自成一组；负 pid 连组收，不留孤儿）。win32 退回单进程 kill */
function killProcessGroup(child, signal, platform = HOST_PLATFORM, killImpl) {
  if (!child || child.pid == null) return;
  if (platform !== "win32") {
    try {
      (killImpl || ((pid, sig) => process.kill(pid, sig)))(-child.pid, signal);
      return;
    } catch {}
  }
  try {
    child.kill(signal);
  } catch {}
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null || child.signalCode != null) {
      resolve(true);
      return;
    }
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(false);
      }
    }, timeoutMs);
    child.once("exit", () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
}

/**
 * 本地 relay 管家。生命周期（设计 §2.2）：
 *   ensureRelay：清残留 → 探活（已有健康 relay 直接用、不接管不杀）→ spawn relay/server.js
 *                → 等 /healthz 就绪（超时抛错并带子进程输出尾巴）；自有 relay 退出按 2s→30s 退避重拉。
 *   startTunnel：按需开 quick tunnel（失败只报状态、绝不抛——隧道故障不影响局域网）。
 *   stop：先关隧道 → 再关自有 relay → 最后删管家状态文件。
 */
function createLocalKeeper(opts = {}) {
  const root = opts.root || ROOT;
  const config = opts.config || {};
  const platform = opts.platform || HOST_PLATFORM;
  const localPort = Number(config.localPort) || 7001;
  const viewerPort = Number(opts.viewerPort) || Number(config.viewerPort) || 7002;
  const relay = opts.relay || `ws://127.0.0.1:${localPort}`;
  const out = typeof opts.out === "function" ? opts.out : (line) => console.log(line);
  const spawnImpl = opts.spawnImpl || spawn;
  const healthz = opts.healthz || ((port) => httpHealthz(port, 1500, opts.httpImpl));
  const readyTimeoutMs = opts.readyTimeoutMs != null ? Number(opts.readyTimeoutMs) : LOCAL_RELAY_READY_TIMEOUT_MS;
  const stateFile = opts.stateFile || keeperStatePath(opts.env || process.env);
  const relayEntry = path.join(root, "relay", "server.js");

  let active = false;
  let stopped = false;
  let relayChild = null;
  let relayOwned = false;
  let foreignOwner = false;
  let relayExitInfo = null;
  let outputTail = [];
  let restartTimer = null;
  let restartDelay = RELAY_RESTART_MIN_MS;
  let lan = { address: "", origin: "", candidates: [], alternatives: [] };
  let tunnel = null;
  let tunnelUrlValue = "";
  let tunnelStatus = "off";
  let wroteState = false;
  let originChangeCb = typeof opts.onOriginChange === "function" ? opts.onOriginChange : null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function pushTail(chunk) {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line) continue;
      outputTail.push(line);
      if (outputTail.length > 30) outputTail.shift();
    }
  }
  function tailText() {
    return outputTail.slice(-12).join("\n");
  }
  function notifyTunnel(info) {
    if (typeof opts.onTunnel === "function") {
      try {
        opts.onTunnel(info);
      } catch {}
    }
  }
  function fireOriginChange() {
    if (originChangeCb) {
      try {
        originChangeCb(origin());
      } catch {}
    }
  }
  function writeState() {
    try {
      writeJsonAtomic(stateFile, {
        ownerPid: process.pid,
        root,
        localPort,
        viewerPort,
        relayPid: relayChild ? relayChild.pid : 0,
        relayOwned,
        tunnelPid: tunnel && tunnel.child() ? tunnel.child().pid : 0,
        tunnelUrl: tunnelUrlValue,
        tunnelArgs: tunnel ? tunnel.args || [] : [],
        updatedAt: Date.now(),
      });
      wroteState = true;
    } catch {}
  }

  /** §5.4 残留清理：上个管家已死时，它拉起的 relay/cloudflared 是孤儿——命令行核对无误才收；
      管家还活着 → 标 foreign 不抢；核对不上（pid 复用/无关进程）→ 绝不误杀，只清记录。 */
  async function cleanupStale() {
    let rec = null;
    try {
      rec = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      return;
    }
    if (!rec || typeof rec !== "object") {
      removeQuiet(stateFile);
      return;
    }
    if (Number(rec.ownerPid) === process.pid) return;
    if (pidAlive(rec.ownerPid)) {
      foreignOwner = true;
      return;
    }
    const killed = [];
    const relayPid = Number(rec.relayPid);
    if (pidAlive(relayPid)) {
      const cmd = processCmdline(relayPid, platform, opts.spawnSyncImpl || spawnSync);
      if (cmd && cmd.includes(relayEntry)) {
        try {
          process.kill(relayPid, "SIGTERM");
          killed.push(relayPid);
          out(`清理上次残留的本地 relay（pid ${relayPid}，上一个连接窗口已不在）`);
        } catch {}
      }
    }
    const tunnelPid = Number(rec.tunnelPid);
    if (pidAlive(tunnelPid)) {
      const cmd = processCmdline(tunnelPid, platform, opts.spawnSyncImpl || spawnSync);
      if (cmd && cmd.includes("cloudflared")) {
        try {
          process.kill(tunnelPid, "SIGTERM");
          killed.push(tunnelPid);
        } catch {}
      }
    }
    removeQuiet(stateFile);
    // 等孤儿真的退场，免得探活/拉起撞上正在关闭的旧进程
    for (const pid of killed) {
      const deadline = Date.now() + 3000;
      while (pidAlive(pid) && Date.now() < deadline) await sleep(100);
    }
  }

  async function spawnRelayChild() {
    outputTail = [];
    relayExitInfo = null;
    const child = spawnImpl(process.execPath, [relayEntry], {
      cwd: root,
      detached: platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...(opts.env || process.env) },
    });
    relayChild = child;
    relayOwned = true;
    if (child.stdout && typeof child.stdout.on === "function") child.stdout.on("data", pushTail);
    if (child.stderr && typeof child.stderr.on === "function") child.stderr.on("data", pushTail);
    if (typeof child.unref === "function") child.unref();
    child.on("error", () => {});
    child.on("exit", (code, signal) => {
      if (relayChild === child) relayChild = null;
      relayExitInfo = { code, signal };
      writeState();
      if (!stopped && active && relayOwned) scheduleRestart();
    });
    writeState();
    return child;
  }

  async function waitRelayReady() {
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      if (relayExitInfo) throw new Error(`本地 relay 启动后立刻退出（code ${relayExitInfo.code}）：\n${tailText()}`);
      if (await healthz(viewerPort)) return;
      if (Date.now() > deadline) throw new Error(`本地 relay ${Math.round(readyTimeoutMs / 1000)}s 内没就绪（http://127.0.0.1:${viewerPort}/healthz 没通）：\n${tailText()}`);
      await sleep(250);
    }
  }

  function scheduleRestart() {
    if (restartTimer || stopped || !active) return;
    const delay = restartDelay;
    restartDelay = Math.min(RELAY_RESTART_MAX_MS, restartDelay * 2);
    out(`本地 relay 退出了，${Math.round(delay / 1000)}s 后自动重拉（窗口不关，扩展会自己重连）`);
    restartTimer = setTimeout(async () => {
      restartTimer = null;
      if (stopped || !active) return;
      try {
        await spawnRelayChild();
        await waitRelayReady();
        restartDelay = RELAY_RESTART_MIN_MS;
        out("本地 relay 已恢复");
      } catch (e) {
        out("本地 relay 重拉失败：" + (e && e.message ? e.message : e));
        if (relayChild) {
          try {
            relayChild.kill("SIGKILL");
          } catch {}
          relayChild = null;
        }
        scheduleRestart();
      }
    }, delay);
    if (restartTimer.unref) restartTimer.unref();
  }

  async function killRelayChild() {
    const child = relayChild;
    relayChild = null;
    if (!child) return;
    killProcessGroup(child, "SIGTERM", platform, opts.killImpl);
    const exited = await waitForExit(child, 3000);
    if (!exited) {
      killProcessGroup(child, "SIGKILL", platform, opts.killImpl);
      await waitForExit(child, 1000);
    }
  }

  async function ensureRelay() {
    if (active) return { owned: relayOwned, healthy: await healthz(viewerPort), foreignOwner };
    active = true;
    await cleanupStale();
    lan = await lanOrigin(viewerPort, opts.lanDeps);
    if (await healthz(viewerPort)) {
      relayOwned = false;
      return { owned: false, healthy: true, foreignOwner };
    }
    if (foreignOwner) {
      out("另一个连接窗口正在管理本地 relay，等它拉起即可（本窗口不重复拉）");
      return { owned: false, healthy: false, foreignOwner: true };
    }
    await spawnRelayChild();
    try {
      await waitRelayReady();
    } catch (e) {
      await killRelayChild();
      relayOwned = false;
      throw e;
    }
    return { owned: true, healthy: true, foreignOwner: false };
  }

  async function startTunnel() {
    if (tunnel) return { status: tunnelStatus, url: tunnelUrlValue };
    const cf = loadCloudflaredLib();
    if (!cf) {
      tunnelStatus = "failed";
      notifyTunnel({ status: "failed", url: "", error: "cloudflared 模块缺失（部署包里没有 deploy/cloudflared.cjs）" });
      return { status: "failed", url: "" };
    }
    tunnelStatus = "starting";
    notifyTunnel({ status: "starting", url: "" });
    let resolved;
    try {
      resolved = await (opts.resolveCloudflared || ((o) => cf.resolveCloudflared(o)))({ log: out });
    } catch (e) {
      tunnelStatus = "failed";
      notifyTunnel({ status: "failed", url: "", error: e && e.message ? e.message : String(e) });
      return { status: "failed", url: "" };
    }
    if (stopped) return { status: "failed", url: "" };
    out(`隧道启动中（cloudflared ${resolved.version || cf.CLOUDFLARED_VERSION}，来源：${resolved.source === "path" ? "系统已装" : resolved.source}）…`);
    tunnel = (opts.tunnelStartImpl || ((o) => cf.startTunnel(o)))({
      bin: resolved.bin,
      viewerPort,
      localPort,
      home: opts.tunnelHome || path.join(os.homedir(), ".pi-remote", "cloudflared", "tunnel-home"),
      spawnImpl: opts.tunnelSpawnImpl,
      onUrl: (url) => {
        tunnelUrlValue = url;
        writeState();
        fireOriginChange();
      },
      onReady: (url) => {
        tunnelStatus = "ready";
        notifyTunnel({ status: "ready", url: url || tunnelUrlValue });
      },
      onExit: () => {
        if (stopped) return;
        const had = tunnelUrlValue;
        tunnelUrlValue = "";
        writeState();
        // 就绪后掉线只有这一条通报路径；启动阶段退出不在这里报——ready 的拒绝带
        // cloudflared 输出尾巴（原因更具体），紧接着会到，别把同一件事报两遍
        if (tunnelStatus === "ready") {
          tunnelStatus = "failed";
          notifyTunnel({ status: "failed", url: "", error: "隧道进程退出了，已回落局域网地址" });
        }
        if (had) fireOriginChange();
      },
    });
    writeState();
    tunnel.ready.then(
      () => {},
      (e) => {
        if (stopped) return;
        if (tunnelStatus === "failed") return; // 已由 onExit（就绪后掉线）报过
        tunnelStatus = "failed";
        notifyTunnel({ status: "failed", url: "", error: e && e.message ? e.message : String(e) });
      },
    );
    return { status: tunnelStatus, url: tunnelUrlValue };
  }

  function origin() {
    return currentViewerOrigin({ relay, viewerPort, tunnelUrl: tunnelUrlValue, lan: lan.origin });
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    active = false;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    // 退出顺序（设计 §2.2）：先关隧道 → 再关自有 relay → 最后删管家状态文件
    if (tunnel) {
      const t = tunnel;
      tunnel = null;
      tunnelUrlValue = "";
      try {
        await t.stop();
      } catch {}
    }
    if (relayOwned) await killRelayChild();
    relayOwned = false;
    if (wroteState) {
      removeQuiet(stateFile);
      wroteState = false;
    }
  }

  /** 进程 exit 时的同步兜底：来不及 await stop() 时至少把信号发出去，不留孤儿进程 */
  function killAllSync() {
    try {
      if (tunnel && tunnel.child()) killProcessGroup(tunnel.child(), "SIGKILL", platform, opts.killImpl);
    } catch {}
    try {
      if (relayOwned && relayChild) killProcessGroup(relayChild, "SIGKILL", platform, opts.killImpl);
    } catch {}
  }

  return {
    ensureRelay,
    startTunnel,
    stop,
    killAllSync,
    origin,
    setOnOriginChange: (fn) => {
      originChangeCb = typeof fn === "function" ? fn : null;
    },
    lanInfo: () => lan,
    tunnelUrl: () => tunnelUrlValue,
    tunnelState: () => ({ status: tunnelStatus, url: tunnelUrlValue }),
    isRelayOwned: () => relayOwned,
    localPort,
    viewerPort,
    stateFile,
  };
}

/** 隧道状态 → 一句人话（ready/failed 才值得出声，starting 由调用方按场景决定） */
function tunnelStatusLine(t) {
  if (!t) return "";
  if (t.status === "ready") return `公网隧道已就绪：${t.url}（每次重启网址都会变；关掉窗口即关）`;
  if (t.status === "failed") return `公网隧道没开起来：${t.error || "未知原因"}（不影响局域网使用，手机连同一 Wi-Fi 照样能打开）`;
  if (t.status === "starting") return "公网隧道启动中…";
  return "";
}

/** 本地模式开窗时打印的访问地址行：局域网主地址 + 备选 + 无局域网时的兜底说明 */
function printLocalAccessLines(keeper, out) {
  const lan = keeper.lanInfo();
  if (lan.origin) {
    out(`局域网地址（手机连同一个 Wi-Fi 打开）：${lan.origin}`);
    if (lan.alternatives && lan.alternatives.length) out(`  手机打不开时试试：${lan.alternatives.join(" 、 ")}`);
  } else {
    out(`没探到可用的局域网地址（没连 Wi-Fi/网线？）：本机先用 http://127.0.0.1:${keeper.viewerPort}/ ，出门改用 --tunnel`);
  }
}

/* ---------- --share：只出示访问地址（不配对） ----------
 * 免服务器模式专用：管家拉起本机 relay + 按需开隧道，窗口页与终端并列出示
 * 局域网地址与隧道网址（各带二维码）。窗口骨架与 /state 轮询沿用 link 窗口的做法，
 * 样式令牌同一套（不另起设计体系）。窗口开着地址才有效，关窗即全停。
 */

function shareQrSvg(state, key, url) {
  if (!url) return "";
  state._svgCache = state._svgCache || {};
  const hit = state._svgCache[key];
  if (hit && hit.url === url) return hit.svg;
  let svg = "";
  const qr = loadQrLib();
  if (qr) {
    try {
      svg = qr.matrixToSvg(qr.createQrMatrix(url).modules);
    } catch {}
  }
  state._svgCache[key] = { url, svg };
  return svg;
}

/** 分享窗口 /state 数据面：双源地址 + 隧道状态；令牌永不进这个通道 */
function shareWindowStateJson(state) {
  const tunnelUrl = state.tunnel ? state.tunnel.url || "" : "";
  return {
    deviceName: state.deviceName || "",
    platformLabel: state.platformLabel || "",
    lanUrl: state.lanUrl || "",
    lanCandidates: state.lanCandidates || [],
    lanQrSvg: shareQrSvg(state, "lan", state.lanUrl || ""),
    tunnelStatus: state.tunnel ? state.tunnel.status || "off" : "off",
    tunnelUrl,
    tunnelQrSvg: shareQrSvg(state, "tunnel", tunnelUrl),
    tunnelError: state.tunnel && state.tunnel.error ? state.tunnel.error : "",
    serverNow: Date.now(),
  };
}

function renderSharePage(state) {
  const initial = JSON.stringify(shareWindowStateJson(state)).replace(/</g, "\\u003c");
  const deviceName = escapeHtml(state.deviceName || "");
  const platform = escapeHtml(state.platformLabel || "");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pi-Remote · 分享访问地址</title>
<style>
  :root{
    --page-bg:#0e0e10; --main-bg:rgba(20,20,23,.55);
    --t1:#ededf0; --t2:#c9c9cf; --t3:#a9a9b1; --t4:#7c7c84; --t5:#5f5f66;
    --ic:#8e8e96; --ink:#ececf1;
    --line:rgba(255,255,255,.08); --card-line:rgba(255,255,255,.07);
    --accent:#a78bfa; --wait:#e0a63f; --ok:#3fb96f;
    --font:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif;
    --mono:ui-monospace,"SF Mono","Cascadia Mono",Consolas,"Roboto Mono",monospace;
  }
  *{margin:0;padding:0;box-sizing:border-box;}
  body{ font-family:var(--font); color:var(--t1); background:var(--page-bg); -webkit-font-smoothing:antialiased; }
  .stage{
    min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:34px 20px 56px;
    background:
      radial-gradient(880px 520px at 10% -8%, rgba(106,74,224,.16), rgba(106,74,224,0) 60%),
      radial-gradient(760px 520px at 96% 108%, rgba(47,90,160,.12), rgba(47,90,160,0) 62%),
      linear-gradient(160deg,#17181b 0%,#0e0e10 58%,#101013 100%);
  }
  .win{
    width:400px; max-width:92vw; border-radius:16px; overflow:hidden; background:var(--main-bg);
    -webkit-backdrop-filter:blur(28px) saturate(1.2); backdrop-filter:blur(28px) saturate(1.2);
    border:1px solid var(--line); box-shadow:0 24px 64px rgba(0,0,0,.5), 0 4px 16px rgba(0,0,0,.35);
  }
  .whead{ display:flex; align-items:flex-start; padding:20px 22px 0; }
  .whead .tt{ flex:1; min-width:0; }
  .whead h1{ font-size:15px; font-weight:600; color:var(--t1); line-height:21px; }
  .whead .sub{ margin-top:3px; font-size:12.5px; line-height:17px; color:var(--t3); }
  .devrow{ margin:16px 22px 0; display:flex; align-items:center; gap:10px; background:rgba(255,255,255,.05); border-radius:10px; padding:9px 12px; }
  .devtile{ width:30px; height:30px; flex:none; border-radius:8px; background:rgba(255,255,255,.09); color:#dcdce0; display:flex; align-items:center; justify-content:center; }
  .devrow .dn{ flex:1; min-width:0; }
  .devrow .dn .n{ font-size:13.5px; font-weight:600; color:var(--t1); line-height:18px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .devrow .dn .m{ font-size:11.5px; color:var(--t4); line-height:15px; margin-top:1px; }
  .ondot{ width:7px; height:7px; border-radius:50%; background:var(--ok); flex:none; }
  .devrow .st{ font-size:11.5px; color:var(--t3); flex:none; }
  .wbody{ padding:20px 22px 22px; }
  .seclab{ display:flex; align-items:baseline; justify-content:space-between; margin-bottom:10px; }
  .seclab .lb{ font-size:11px; letter-spacing:.12em; color:var(--t4); text-transform:uppercase; }
  .seclab .alt{ font-size:11.5px; color:var(--t5); }
  .seclab .alt.ready{ color:var(--ok); }
  .seclab .alt.waiting{ color:var(--wait); }
  .qrcard{ position:relative; width:260px; margin:0 auto; border-radius:12px; background:#f4f4f5; padding:26px; box-shadow:0 2px 10px rgba(0,0,0,.35); }
  .qrbox{ width:208px; height:208px; }
  .qrbox svg{ display:block; width:208px; height:208px; }
  .qrbox .empty{ width:208px; height:208px; display:flex; align-items:center; justify-content:center; color:#55555c; font-size:12.5px; text-align:center; padding:0 18px; line-height:19px; }
  .urlbox{
    margin-top:12px; text-align:center; font-family:var(--mono); font-size:13px; color:var(--ink);
    background:rgba(255,255,255,.04); border:1px solid var(--card-line); border-radius:10px; padding:9px 8px;
    word-break:break-all; line-height:19px;
  }
  .urlbox.dim{ color:var(--t5); font-family:var(--font); }
  .divider{ height:1px; background:var(--card-line); margin:22px 0 18px; }
  .cand{ margin-top:8px; text-align:center; font-size:11.5px; line-height:17px; color:var(--t5); word-break:break-all; }
  .foot{ margin-top:14px; font-size:11.5px; line-height:16px; color:var(--t5); }
</style>
</head>
<body>
<div class="stage">
  <section class="win" aria-label="分享访问地址窗口">
    <div class="whead">
      <div class="tt">
        <h1>分享访问地址</h1>
        <div class="sub">这台电脑正以免服务器模式运行 Pi-Remote。出门用公网地址，在家用局域网地址，手机扫码或输入网址打开。</div>
      </div>
    </div>
    <div class="devrow">
      <div class="devtile">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 14h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      </div>
      <div class="dn">
        <div class="n">${deviceName}</div>
        <div class="m">${platform} · 免服务器（本地）模式</div>
      </div>
      <span class="ondot" title="在线"></span><span class="st">在线</span>
    </div>
    <div class="wbody">
      <div class="seclab"><span class="lb">公网地址 · 出门用</span><span class="alt" id="tstatus">隧道启动中…</span></div>
      <div class="qrcard"><div class="qrbox" id="tqr"><div class="empty">隧道就绪后这里会出现二维码</div></div></div>
      <div class="urlbox dim" id="turl">正在向 Cloudflare 申请这次的网址…</div>
      <div class="foot">公网网址每次重启都会变，变了请重新看这个页面；关掉 attach 窗口，隧道立即关闭，网址随即失效。</div>
      <div class="divider"></div>
      <div class="seclab"><span class="lb">局域网地址 · 同一 Wi-Fi</span><span class="alt">在家用这个，不用等隧道</span></div>
      <div class="qrcard"><div class="qrbox" id="lqr"><div class="empty">没有可用的局域网地址</div></div></div>
      <div class="urlbox" id="lurl"></div>
      <div class="cand" id="lcand"></div>
      <div class="foot">只有 viewer 端口会经隧道对外，本地通道永远只留在这台电脑上。打开页面要输入的 viewer 令牌就是门锁：地址只给信任的人。</div>
    </div>
  </section>
</div>
<script>
  var S = ${initial};
  function el(id){ return document.getElementById(id); }
  function setQr(id, svg){
    var box = el(id);
    if (!box) return;
    if (svg){
      if (box.getAttribute('data-svg') !== svg){ box.innerHTML = svg; box.setAttribute('data-svg', svg); }
    }
  }
  function applyState(s){
    S = s;
    var ts = el('tstatus'), tu = el('turl');
    if (s.tunnelStatus === 'ready'){
      ts.textContent = '已就绪'; ts.className = 'alt ready';
      tu.textContent = s.tunnelUrl; tu.className = 'urlbox';
      setQr('tqr', s.tunnelQrSvg);
    } else if (s.tunnelStatus === 'failed'){
      ts.textContent = '没开起来'; ts.className = 'alt waiting';
      tu.textContent = s.tunnelError || '隧道没能建立，局域网地址照常可用'; tu.className = 'urlbox dim';
    } else if (s.tunnelStatus === 'starting'){
      ts.textContent = '启动中…'; ts.className = 'alt waiting';
    } else {
      ts.textContent = '未开启'; ts.className = 'alt';
      tu.textContent = '隧道未开启'; tu.className = 'urlbox dim';
    }
    if (s.lanUrl){
      el('lurl').textContent = s.lanUrl;
      setQr('lqr', s.lanQrSvg);
      el('lcand').textContent = (s.lanCandidates && s.lanCandidates.length)
        ? '打不开时试试：' + s.lanCandidates.join(' 、 ') : '';
    } else {
      el('lurl').textContent = '没有可用的局域网地址（没连 Wi-Fi/网线？）';
      el('lurl').className = 'urlbox dim';
    }
  }
  setInterval(function(){
    fetch('/state').then(function(r){ return r.json(); }).then(applyState).catch(function(){});
  }, 900);
  applyState(S);
</script>
</body>
</html>`;
}

/** 分享窗口服务：与 link 窗口同一骨架（只绑 127.0.0.1 随机端口，/state 轮询） */
function startShareWindowServer(state) {
  const server = http.createServer((req, res) => {
    try {
      const u = new URL(String(req.url || "/"), "http://127.0.0.1");
      if (req.method === "GET" && u.pathname === "/state") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(shareWindowStateJson(state)));
        return;
      }
      if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(renderSharePage(state));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    } catch {
      try {
        res.writeHead(500);
        res.end();
      } catch {}
    }
  });
  return new Promise((resolve) => {
    server.once("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}/`,
        close: () => {
          try {
            server.close();
          } catch {}
        },
      });
    });
  });
}

/** 终端打印一条网址的字符二维码（太长/太窄时降级为只印网址） */
function printUrlQr(url, { out, terminalWidth }) {
  const qr = loadQrLib();
  if (!qr || !url) return;
  try {
    const m = qr.createQrMatrix(url);
    if (m.version > 16) return;
    const lines = qr.matrixToTerminalLines(m.modules, { quiet: 4 });
    if (lines.length && lines[0].length <= terminalWidth) {
      for (const line of lines) out(line);
    }
  } catch {}
}

function printShareOffer(state, { out, terminalWidth }) {
  out("");
  if (state.lanUrl) {
    out("局域网地址（手机连同一个 Wi-Fi，扫一扫或输入网址）：");
    printUrlQr(state.lanUrl, { out, terminalWidth });
    out("  " + state.lanUrl);
    if (state.lanCandidates && state.lanCandidates.length) out(`  手机打不开时试试：${state.lanCandidates.join(" 、 ")}`);
  } else {
    out("没探到可用的局域网地址（没连 Wi-Fi/网线？），先用下面的公网地址。");
  }
}

function printTunnelOffer(url, { out, terminalWidth }) {
  out("");
  out("公网地址（出门也能打开，手机扫一扫）：");
  printUrlQr(url, { out, terminalWidth });
  out("  " + url);
  out("这个网址每次重启都会变；关掉 attach 窗口，隧道立即关闭、网址随即失效。");
}

/** --share：本地模式专用。管家拉起 relay + 开隧道，只出示双源地址，常驻到 Ctrl-C */
async function shareMain(args, envPath, opts = {}) {
  const out = opts.writeOut || ((line) => console.log(line));
  const err = opts.writeErr || ((line) => console.error(line));
  const platform = opts.platform || HOST_PLATFORM;
  const root = opts.root || ROOT;
  const terminalWidth = Number(opts.terminalWidth) || (process.stdout && process.stdout.columns) || 80;
  const cfg = loadConfig(envPath, opts.env || process.env, platform);
  const relay = args.relay || cfg.relay;
  if (!relay) {
    err("不知道 relay 地址：先运行 node deploy/setup.cjs --local 初始化免服务器模式");
    return 1;
  }
  const info = localModeInfo(relay, root);
  if (!info.local) {
    err("--share 只用于免服务器（本地 relay）模式：当前 .env 的 relay 不是本机本地模式。");
    err("  先运行 node deploy/setup.cjs --local 生成本地配置，再运行 attach --share。");
    return 1;
  }
  const state = {
    deviceName: cfg.deviceName || defaultDeviceName(platform),
    platformLabel: platformLabel(platform),
    lanUrl: "",
    lanCandidates: [],
    tunnel: { status: "off", url: "", error: "" },
  };
  let tunnelPrinted = false;
  const factory = opts.keeperFactory || ((o) => createLocalKeeper(o));
  const keeper = factory({
    config: info.config,
    relay,
    root,
    platform,
    out,
    env: opts.env || process.env,
    stateFile: opts.stateFile,
    healthz: opts.healthz,
    spawnImpl: opts.spawnImpl,
    spawnSyncImpl: opts.spawnSyncImpl,
    readyTimeoutMs: opts.readyTimeoutMs,
    lanDeps: opts.lanDeps,
    resolveCloudflared: opts.resolveCloudflared,
    tunnelSpawnImpl: opts.tunnelSpawnImpl,
    tunnelHome: opts.tunnelHome,
    onTunnel: (t) => {
      state.tunnel.status = t.status;
      if (t.url) state.tunnel.url = t.url;
      if (t.error) state.tunnel.error = t.error;
      const line = tunnelStatusLine(t);
      if (line) out(line);
      if (t.status === "ready" && t.url && !tunnelPrinted) {
        tunnelPrinted = true;
        printTunnelOffer(t.url, { out, terminalWidth });
      }
    },
  });

  let win = null;
  let aborted = false;
  const signalSource = opts.signalSource || process;
  const bindSignals = opts.bindSignals !== false;
  let resolveWait = null;
  const waitPromise = new Promise((resolve) => {
    resolveWait = resolve;
  });
  const onSignal = () => {
    aborted = true;
    if (resolveWait) resolveWait();
  };
  if (bindSignals) {
    signalSource.on("SIGINT", onSignal);
    signalSource.on("SIGTERM", onSignal);
  }
  try {
    let ensured;
    try {
      ensured = await keeper.ensureRelay();
    } catch (e) {
      err("本地 relay 没能启动：" + (e && e.message ? e.message : e));
      return 1;
    }
    const lan = keeper.lanInfo();
    state.lanUrl = lan.origin;
    state.lanCandidates = lan.alternatives;
    out(ensured.owned ? "免服务器模式：本地 relay 已拉起" : "免服务器模式：本地 relay 已在运行（不是本窗口拉起的，不接管）");
    if (opts.shareWindow !== false) {
      win = await startShareWindowServer(state);
      if (win && opts.openBrowser !== false) openBrowserDefault(win.url, platform, opts.spawnImplForBrowser || spawn);
    }
    printShareOffer(state, { out, terminalWidth });
    if (win) out(`分享窗口：${win.url}（只在本机 127.0.0.1 打开；隧道网址就绪后页面会自动更新）`);
    state.tunnel.status = "starting";
    await keeper.startTunnel();
    out("分享中：这个窗口开着，上面两个地址就有效；按 Ctrl-C 关闭（隧道与本地 relay 一并停）。");
    await waitPromise;
  } finally {
    if (bindSignals) {
      signalSource.removeListener("SIGINT", onSignal);
      signalSource.removeListener("SIGTERM", onSignal);
    }
    if (win) win.close();
    await keeper.stop();
  }
  return aborted ? 130 : 0;
}

module.exports = {
  parseArgs,
  parseEnv,
  splitProjects,
  loadConfig,
  initEnvFile,
  macComputerName,
  defaultAttachFile,
  encodeCwdDir,
  normalizeDir,
  cwdAllowed,
  parseBrowseRoots,
  insideRoots,
  matchedRoot,
  parseHarnessArgs,
  findSessionFile,
  findSessionFileAnywhere,
  defaultSessionFindAnywhere,
  sessionIdFromFileName,
  readSessionHeader,
  insideDir,
  hasTrashCommand,
  deleteLikePi,
  archiveBody,
  sealAckText,
  archiveWireBody,
  manifestWireRow,
  defaultSessionLookup,
  listSessionsCached,
  buildSpawnSpec,
  probeTmux,
  tmuxArg,
  resolveLauncher,
  shellQuote,
  displayPathOf,
  deviceRegisterFrame,
  platformId,
  defaultDeviceName,
  startPiFor,
  formatRemain,
  viewerUrlFromRelay,
  statusText,
  AttachController,
  UNSAFE_PATH,
  START_PI,
  normalizePairCode,
  writeEnvVars,
  attachAuthFrame,
  attachKeyAuthFrame,
  signAuthResponse,
  newClientNonce,
  keyFingerprint,
  formatFingerprint,
  deviceKeyFilePath,
  writeDeviceKeyFile,
  loadDeviceKeys,
  hasUsableDeviceKey,
  generateDeviceKeys,
  ensureDeviceKeys,
  signPairPop,
  newDevicePairCode,
  accountAckOf,
  storeAccountAck,
  ensureAccountAck,
  syncDeviceKeyId,
  finalizePairKeys,
  pairResultFromMsg,
  requestPairing,
  pairMain,
  pairHint,
  linkHint,
  formatPairCode,
  persistPairResult,
  requestLinkAttempt,
  linkMain,
  startLinkWindowServer,
  renderLinkPage,
  linkWindowStateJson,
  openBrowserDefault,
  doctorHint,
  doctorMain,
  tcpProbe,
  findPiBinary,
  findPiInfo,
  piBinaryProblem,
  isExecutableFile,
  keepAwakeWanted,
  platformLabel,
  tmuxInstallHint,
  currentLocale,
  localeIsUtf8,
  canonicalLocaleName,
  availableUtf8Locale,
  tmuxLocaleOverride,
  tmuxEnvWithLocale,
  nvmNodeBins,
  exitCodeDir,
  exitCodePath,
  writeExitCodePath,
  readExitCodePath,
  readExitCode,
  removeExitCode,
  isLocalRelayHost,
  relayHostOf,
  resolveEnvFile,
  attachRelaySafetyError,
  printRemoteRelayWarning,
  loadCloudflaredLib,
  keeperStatePath,
  readLocalRelayConfig,
  localModeInfo,
  rankLanCandidates,
  defaultRouteAddress,
  lanOrigin,
  currentViewerOrigin,
  httpHealthz,
  pidAlive,
  processCmdline,
  createLocalKeeper,
  tunnelStatusLine,
  printLocalAccessLines,
  shareMain,
  shareWindowStateJson,
  renderSharePage,
  startShareWindowServer,
  printShareOffer,
  printTunnelOffer,
};

if (require.main === module) {
  // 早期失败（缺 .env、参数不对）也会在构造 AttachController 之前退出：进程级落盘兜底一次。
  // 控制器正常收尾时已经写过同一个文件，这里再写同值无害；--help 之类退出 0 也写 0。
  const processExitFile = String(process.env.PI_REMOTE_EXIT_FILE || "").trim();
  if (processExitFile) {
    process.on("exit", () => {
      if (process.__piRemoteExitWritten) return;
      if (writeExitCodePath(processExitFile, process.exitCode == null ? 0 : process.exitCode)) process.__piRemoteExitWritten = true;
    });
  }
  main(process.argv.slice(2)).then(
    (code) => {
      if (code) process.exit(code);
    },
    (e) => {
      console.error(e && e.message ? e.message : e);
      process.exit(1);
    },
  );
}
