/**
 * pi-remote Linux 设备（服务器式：无桌面、tmux 拉起）的日常命令。
 *
 *   deploy/linux/device.sh <命令> [参数]        等价于 node deploy/linux/device.cjs …
 *
 * 连接窗口（deploy/attach.cjs）放在 tmux 会话 pi-remote-attach 里跑：SSH 断开后窗口还在，
 * tmux attach -t pi-remote-attach 能看状态面板。网页「新建/启用」拉起的 pi 由 attach 自己另开
 * tmux 会话（pi-<目录>-<随机>）。只管本机：不改 relay、不读模型密钥；令牌只进本套件的 .env（600），不打印。
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const attach = require("../attach.cjs");
// 显示用路径还原（与 attach.cjs 同一实现）：device.sh 的输出、hint、白名单路径共用
const displayPathOf = attach.displayPathOf;

const KIT = path.resolve(__dirname, "..", "..");
const ATTACH_SESSION = "pi-remote-attach";
const LOOPBACK_RELAY = "ws://127.0.0.1:7001";
const DEFAULT_HOURS = 12;
const UP_WAIT_MS = 8000;
const DOWN_WAIT_MS = 3000;
const MIN_NODE = [22, 18];

class UsageError extends Error {}

function makeContext(options = {}) {
  const env = options.env || process.env;
  const home = options.home || env.HOME || os.homedir();
  const kit = options.kit || KIT;
  const agentHome = path.join(home, ".pi", "agent");
  return {
    env,
    home,
    kit,
    cwd: options.cwd || process.cwd(),
    platform: options.platform || process.platform,
    uid: options.uid !== undefined ? options.uid : typeof process.getuid === "function" ? process.getuid() : -1,
    user: options.user || env.USER || env.LOGNAME || "",
    envPath: path.join(kit, ".env"),
    attachCjs: path.join(kit, "deploy", "attach.cjs"),
    startPi: path.join(kit, "deploy", "start-pi.sh"),
    deviceSh: path.join(kit, "deploy", "linux", "device.sh"),
    extSrc: path.join(kit, "extension", "pi-remote-sync.ts"),
    extDst: path.join(env.PI_CODING_AGENT_DIR ? path.resolve(env.PI_CODING_AGENT_DIR) : agentHome, "extensions", "pi-remote-sync.ts"),
    // Same window-state file attach itself resolves: the kit .env may carry
    // the PI_REMOTE_ATTACH_FILE override, not just this process's env —
    // reading only the env here made status/up look at the wrong device file.
    stateFile: attach.resolveAttachFile(path.join(kit, ".env"), env, path.join(agentHome, "remote-attach.json")),
    logFile: env.PI_REMOTE_LOG || path.join(agentHome, "pi-remote-sync.log"),
    nodeBin: options.nodeBin || process.execPath,
    piFallbacks: options.piFallbacks || piFallbacks(home, env),
    // tmux 客户端环境由 runTmux 注入 UTF-8 locale；tmux 本身用这个壳（第二参数给 runTmux 传 env）
    tmux: options.tmux || ((argv, runOpts) => spawnSync("tmux", argv, { encoding: "utf8", env: (runOpts && runOpts.env) || env, timeout: 10000 })),
    // 探测本机 UTF-8 locale 用；测试可注入。undefined = 还没探，空串 = 探过但没有（走兼容解析）
    localeSpawn: options.localeSpawn || spawnSync,
    utf8Locale: options.utf8Locale,
    out: options.out || ((line) => process.stdout.write(line + "\n")),
    err: options.err || ((line) => process.stderr.write(line + "\n")),
    now: options.now || (() => Date.now()),
    sleep: options.sleep || ((ms) => new Promise((result) => setTimeout(result, ms))),
    upWaitMs: options.upWaitMs || UP_WAIT_MS,
    downWaitMs: options.downWaitMs || DOWN_WAIT_MS,
    WebSocketImpl: options.WebSocketImpl,
    pairTimeoutMs: options.pairTimeoutMs,
  };
}

/* ---------- 小工具 ---------- */

function isExecutable(targetPath) {
  try {
    if (!fs.statSync(targetPath).isFile()) return false;
    fs.accessSync(targetPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDir(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function removeQuiet(file) {
  try {
    fs.unlinkSync(file);
  } catch {}
}

function readEnvFile(file) {
  try {
    return attach.parseEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** .env 优先、其次环境变量；.env 里留空的键不盖环境变量（与 start-pi.sh、attach.cjs 同一口径） */
function settings(context) {
  const file = readEnvFile(context.envPath);
  const pick = (key) => {
    const fromFile = file[key];
    if (fromFile != null && String(fromFile).trim() !== "") return String(fromFile).trim();
    const fromEnv = context.env[key];
    return fromEnv != null && String(fromEnv).trim() !== "" ? String(fromEnv).trim() : "";
  };
  return { file, pick, config: attach.loadConfig(context.envPath, context.env, context.platform) };
}

function tilde(context, targetPath) {
  const sessionRow = displayPathOf(targetPath);
  return context.home && (sessionRow === context.home || sessionRow.startsWith(context.home + "/")) ? "~" + sessionRow.slice(context.home.length) : sessionRow;
}

function hint(context, sub) {
  return `${tilde(context, context.deviceSh)} ${sub}`;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!(error && error.code === "EPERM");
  }
}

function fmtTime(ms) {
  const dateValue = new Date(ms);
  const targetPath = (countValue) => String(countValue).padStart(2, "0");
  return `${dateValue.getFullYear()}-${targetPath(dateValue.getMonth() + 1)}-${targetPath(dateValue.getDate())} ${targetPath(dateValue.getHours())}:${targetPath(dateValue.getMinutes())}`;
}

function fmtLeft(ms) {
  const min = Math.max(0, Math.floor(ms / 60000));
  return min >= 60 ? `${Math.floor(min / 60)} 小时 ${min % 60} 分` : `${min} 分`;
}

function md5File(targetPath) {
  try {
    return crypto.createHash("md5").update(fs.readFileSync(targetPath)).digest("hex");
  } catch {
    return null;
  }
}

function nodeVersionOk(version = process.versions.node) {
  const [major, minor] = String(version).split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

function piFallbacks(home, environ = process.env) {
  return [
    // 系统服务 / cron 的 PATH 不含 nvm：按 node 版本从新到旧找 nvm 全局 bin
    ...attach.nvmNodeBins(home, environ).map((dir) => path.join(dir, "pi")),
    path.join(home, ".local", "bin", "pi"),
    path.join(home, ".npm-global", "bin", "pi"),
    "/usr/local/bin/pi",
    "/opt/pi-remote/bin/pi",
  ];
}

/** 找 pi：PI_REMOTE_PI_BIN → PATH → 常见安装位置（npm --prefix ~/.local、~/.npm-global、/usr/local、服务器上 node 的前缀） */
function findPi(context, pinned) {
  if (pinned) return { path: pinned, ok: isExecutable(pinned), from: "PI_REMOTE_PI_BIN" };
  for (const dir of String(context.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const targetPath = path.join(dir, "pi");
    if (isExecutable(targetPath)) return { path: targetPath, ok: true, from: "PATH" };
  }
  for (const targetPath of context.piFallbacks) if (isExecutable(targetPath)) return { path: targetPath, ok: true, from: "常见位置" };
  return null;
}

/* ---------- tmux ---------- */

/**
 * tmux 3.4 的格式化输出会按**客户端** locale 净化：LANG=C / LC_ALL=C 时制表符变成下划线，
 * 整行字段塌成一条（会话名、死活、退出码、目录、创建时间全取不到）。本机存在 UTF-8 locale 时
 * 给每次 tmux 调用注入 LANG/LC_ALL；探不到就交给下面的兼容解析（以真实会话名锚定、丢幻影行）。
 */
function tmuxLocale(context) {
  if (context.utf8Locale === undefined) {
    const current = attach.currentLocale(context.env);
    context.utf8Locale = attach.localeIsUtf8(current) ? "" : attach.availableUtf8Locale(context.localeSpawn, context.env, context.platform);
  }
  return context.utf8Locale;
}

function tmuxEnv(context) {
  if (!context._tmuxEnv) context._tmuxEnv = attach.tmuxEnvWithLocale(context.env, tmuxLocale(context));
  return context._tmuxEnv;
}

function runTmux(context, argv) {
  // 注意：tmux 服务端环境是启动时定死的，但输出净化发生在客户端；给客户端换 locale 就能修好已存在的服务
  const result = context.tmux(argv, { env: tmuxEnv(context) }) || {};
  return {
    status: result.status == null ? -1 : result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "").trim(),
    missing: !!(result.error && result.error.code === "ENOENT"),
    error: result.error || null,
  };
}

/** 没装 tmux 返回 null；keepFailed = 支持 remain-on-exit failed（3.2 起）。与 attach.cjs 同一个判断 */
function tmuxVersion(context) {
  const info = attach.probeTmux((_file, argv) => context.tmux(argv, { env: tmuxEnv(context) }));
  return info ? { text: info.version, keepFailed: info.keepFailed } : null;
}

const { tmuxArg } = attach;

/** -t 一律用 =名字 精确匹配：否则 tmux 会按前缀把 pi-remote-attach-xxx 这类 pi 会话当成窗口 */
function hasSession(context, name) {
  return runTmux(context, ["has-session", "-t", "=" + name]).status === 0;
}

/** 一条 list-panes 输出：正常是制表符分隔；tmux 3.4 非 UTF-8 时是 0_ / 1_1 这种下划线形态 */
function parsePaneRow(line) {
  if (line.includes("\t")) {
    const [dead, status] = line.split("\t");
    return { dead: dead === "1", status: status === "" || status == null ? null : Number(status) };
  }
  const match = /^([01])(?:_(.*))?$/.exec(line);
  if (!match) return null;
  const countValue = match[2] == null || match[2] === "" ? null : Number(match[2]);
  return { dead: match[1] === "1", status: Number.isFinite(countValue) ? countValue : null };
}

function sessionPanes(context, name) {
  const result = runTmux(context, ["list-panes", "-s", "-t", "=" + name, "-F", "#{pane_dead}\t#{pane_dead_status}"]);
  if (result.status !== 0) return null;
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map(parsePaneRow)
    .filter(Boolean);
}

function capturePane(context, name, max = 15) {
  const result = runTmux(context, ["capture-pane", "-p", "-J", "-t", `=${name}:`, "-S", "-60"]);
  if (result.status !== 0) return [];
  const lines = result.stdout.split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.filter((line, index, all) => line || (index > 0 && all[index - 1])).slice(-max);
}

/** 非 UTF-8 输出里的真实会话名：单独查一次（这个格式没有制表符，不受净化影响） */
function sessionNames(context) {
  const result = runTmux(context, ["list-sessions", "-F", "#{session_name}"]);
  if (result.status !== 0) return null;
  return result.stdout
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * 兼容解析：tmux 3.4 在 C locale 下把 \t 净化为 _，行形如
 *   <name>_<dead>_<status>_<cwd>_<created>
 * 用真实会话名做锚（取最长匹配），解析不出字段的行按幻影丢弃。
 */
function parseCollapsedSessionRow(line, names) {
  let name = "";
  for (const candidate of names) {
    if (candidate.length > name.length && line.startsWith(candidate + "_")) name = candidate;
  }
  if (!name) return null;
  const match = /^([01])_(\d*)_(.*)_(\d+)$/.exec(line.slice(name.length + 1));
  if (!match) return null;
  return { name, dead: match[1] === "1", status: match[2] === "" ? null : Number(match[2]), cwd: match[3], created: Number(match[4]) * 1000 || 0 };
}

/** 所有 pi 的 tmux 会话（不含连接窗口）。没有 tmux 服务（一个会话都没有）时是空列表 */
function piSessions(context) {
  const result = runTmux(context, ["list-panes", "-a", "-F", "#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{session_path}\t#{session_created}"]);
  if (result.status !== 0) return [];
  const lines = result.stdout.split("\n").filter(Boolean);
  const collapsed = lines.length > 0 && !lines.some((line) => line.includes("\t"));
  const names = collapsed ? sessionNames(context) : null;
  // 探不到真实会话名就不猜：宁可列表为空，也不能把幻影行当成"运行中"的 pi
  if (collapsed && !names) return [];
  const byName = new Map();
  for (const line of lines) {
    let row = null;
    if (collapsed) row = parseCollapsedSessionRow(line, names);
    else {
      const [name, dead, status, cwd, created] = line.split("\t");
      row = { name, dead: dead === "1", status: status === "" || status == null ? null : Number(status), cwd: cwd || "", created: Number(created) * 1000 || 0 };
    }
    if (!row || !/^pi-/.test(row.name) || row.name === ATTACH_SESSION) continue;
    const cur = byName.get(row.name);
    if (cur) {
      if (!row.dead) cur.dead = false;
      if (cur.status == null && row.status != null) cur.status = row.status;
      continue;
    }
    byName.set(row.name, { name: row.name, cwd: row.cwd || "", created: row.created || 0, dead: row.dead, status: row.status });
  }
  const list = [...byName.values()];
  // 窗格字段丢了（tmux 3.4 约四成 / 按信号退出时必空）再读落盘退出码；窗格有值时以窗格为准
  for (const item of list) if (item.dead && item.status == null) item.status = attach.readExitCode(item.name, context.home);
  return list.sort((tokenText, rightRow) => tokenText.created - rightRow.created);
}

/* ---------- 窗口状态、扩展、relay ---------- */

function readWindow(context) {
  let raw;
  try {
    raw = fs.readFileSync(context.stateFile, "utf8");
  } catch {
    return null;
  }
  let stateDoc;
  try {
    stateDoc = JSON.parse(raw);
  } catch {
    return { broken: true, alive: false };
  }
  if (!stateDoc || typeof stateDoc !== "object") return { broken: true, alive: false };
  const pid = Number(stateDoc.pid);
  const expiresAt = Number(stateDoc.expiresAt) || 0;
  return {
    broken: false,
    pid,
    // 过期的按残留处理：pid 可能早被系统复用给了别的进程（attach 的 clearStaleState 同样这么判）
    alive: expiresAt > context.now() && pidAlive(pid),
    deviceId: String(stateDoc.deviceId || ""),
    startedAt: Number(stateDoc.startedAt) || 0,
    expiresAt,
  };
}

function extensionState(context) {
  const want = md5File(context.extSrc);
  const have = md5File(context.extDst);
  if (!want) return { synced: false, text: "套件里没有 extension/pi-remote-sync.ts（重新推一次套件）" };
  if (!have) return { synced: false, text: `扩展还没装到 ${tilde(context, context.extDst)}：${tilde(context, path.join(context.kit, "deploy", "sync-extension.sh"))}` };
  if (have !== want) return { synced: false, text: `装着的扩展不是这套件的版本：${tilde(context, path.join(context.kit, "deploy", "sync-extension.sh"))}，再重启 pi` };
  return { synced: true, text: `扩展已同步（md5 ${want.slice(0, 8)}…）` };
}

/** relay 的 /healthz 在 viewer 端口上：地址里写了端口就换成 viewer 端口（缺省 7002），没写（wss 反代）就同源 */
function healthUrl(relay, env) {
  const parsedUrl = new URL(relay);
  parsedUrl.protocol = parsedUrl.protocol === "wss:" ? "https:" : "http:";
  if (parsedUrl.port) parsedUrl.port = String(Number(env.PI_REMOTE_VIEWER_PORT) > 0 ? Number(env.PI_REMOTE_VIEWER_PORT) : 7002);
  parsedUrl.pathname = "/healthz";
  parsedUrl.search = "";
  parsedUrl.hash = "";
  return parsedUrl.toString();
}

async function relayHealth(context, relay) {
  let url;
  try {
    url = healthUrl(relay, context.env);
  } catch {
    return { ok: false, error: "relay 地址不对：" + relay };
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { ok: false, url, error: "HTTP " + response.status };
    return { ok: true, url, data: await response.json() };
  } catch (error) {
    const why = error && error.name === "TimeoutError" ? "3 秒没有回应" : (error && error.cause && (error.cause.code || error.cause.message)) || (error && error.message) || String(error);
    return { ok: false, url, error: why };
  }
}

/** 本机身份钥（阶段 1）：钥文件在且完好才返回钥对象；没有/损坏都返回 null（doctor 另有 attach 侧的损坏提示口径，这里只认「能不能用钥登录」） */
function deviceKeysOf(context) {
  try {
    return attach.loadDeviceKeys(attach.deviceKeyFilePath(context.envPath, { env: context.env }));
  } catch {
    return null;
  }
}

/** 拿 .env 里的身份向 relay 认一次证就断开：不登记窗口，不影响已经连着的窗口和扩展。
 * 有身份钥且已配对时走挑战-签名（钥设备按设计停用令牌，拿令牌去探只会换回拒绝）。 */
function probeAuth(context, config, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let WS = context.WebSocketImpl;
    if (!WS) {
      try {
        WS = require("ws");
      } catch {
        WS = globalThis.WebSocket;
      }
    }
    if (!WS) {
      resolve({ ok: false, code: "internal", error: "没有可用的 WebSocket" });
      return;
    }
    let ws = null;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws && ws.close();
      } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, code: "timeout", error: "relay 没有回应鉴权" }), timeoutMs);
    try {
      ws = new WS(config.relay);
    } catch (error) {
      finish({ ok: false, code: "offline", error: (error && error.message) || String(error) });
      return;
    }
    const keys = deviceKeysOf(context);
    const keyFrame = keys && config.deviceId ? attach.attachKeyAuthFrame({ deviceId: config.deviceId, keys, platform: context.platform }) : null;
    const onOpen = () => {
      try {
        ws.send(JSON.stringify(keyFrame || attach.attachAuthFrame({ token: config.token, deviceId: config.deviceId, deviceToken: config.deviceToken, platform: context.platform })));
      } catch (error) {
        finish({ ok: false, code: "offline", error: (error && error.message) || String(error) });
      }
    };
    const onMessage = (data) => {
      let frame;
      try {
        frame = JSON.parse(String(data && data.data !== undefined ? data.data : data));
      } catch {
        return;
      }
      if (!frame) return;
      if (frame.type === "auth_challenge" && keyFrame) {
        try {
          ws.send(JSON.stringify({ type: "auth_response", sig: attach.signAuthResponse(keys, config.deviceId, frame.nonce, keyFrame.clientNonce) }));
        } catch (error) {
          finish({ ok: false, code: "auth_failed", error: "本机钥签名失败：" + ((error && error.message) || String(error)) });
        }
        return;
      }
      if (frame.type !== "auth_result") return;
      finish(frame.ok ? { ok: true, auth: frame.auth || null } : { ok: false, code: frame.code || "auth_failed", error: frame.error || "" });
    };
    const onClose = () => finish({ ok: false, code: "offline", error: "连接被关闭" });
    if (typeof ws.on === "function") {
      ws.on("open", onOpen);
      ws.on("message", onMessage);
      ws.on("close", onClose);
      ws.on("error", (error) => finish({ ok: false, code: "offline", error: (error && (error.code || error.message)) || "连不上" }));
    } else {
      ws.onopen = onOpen;
      ws.onmessage = onMessage;
      ws.onclose = onClose;
      ws.onerror = () => finish({ ok: false, code: "offline", error: "连不上" });
    }
  });
}

/* ---------- 命令 ---------- */

/** 网页能让这台机器上的 pi 执行命令：root 等于把整台服务器（含 relay 的令牌文件）交出去 */
function blockRoot(context) {
  if (context.uid !== 0) return false;
  if (String(readEnvFile(context.envPath).PI_REMOTE_ALLOW_ROOT || context.env.PI_REMOTE_ALLOW_ROOT || "") === "1") return false;
  context.err(
    [
      "不要用 root 跑服务器上的 pi：网页能给它发提示词、让它执行命令，root 等于把整台服务器（连同 relay 的令牌）交出去。",
      "建一个普通用户再用它运行本命令，例如：",
      "  sudo adduser --disabled-password --gecos '' piagent",
      "确实要用 root：在 .env 里写 PI_REMOTE_ALLOW_ROOT=1。",
    ].join("\n"),
  );
  return true;
}

function parseProjects(raw) {
  const list = String(raw)
    .split(";")
    .map((sessionRow) => sessionRow.trim())
    .filter(Boolean);
  if (!list.length) return { error: "--projects 至少给一个目录（多个用 ; 分隔）" };
  const out = [];
  for (const targetPath of list) {
    if (/[\0\r\n]/.test(targetPath)) return { error: "白名单路径不能含换行" };
    if (!path.isAbsolute(targetPath)) return { error: `白名单要写绝对路径：${targetPath}` };
    if (!isDir(targetPath)) return { error: `目录不存在：${targetPath}` };
    out.push(targetPath.length > 1 ? targetPath.replace(/\/+$/, "") : targetPath);
  }
  return { list: out };
}

function validRelay(valueText) {
  return /^wss?:\/\/\S+$/.test(String(valueText));
}

function cmdInit(context, options = {}) {
  if (blockRoot(context)) return 2;
  let projects = null;
  if (options.projects != null) {
    const parsed = parseProjects(options.projects);
    if (parsed.error) {
      context.err(parsed.error);
      return 2;
    }
    projects = parsed.list;
  }
  if (options.relay != null && !validRelay(options.relay)) {
    context.err("--relay 需要 ws:// 或 wss:// 地址");
    return 2;
  }
  if (options.name != null && (!String(options.name).trim() || /[\0\r\n]/.test(options.name))) {
    context.err("--name 不能为空，也不能换行");
    return 2;
  }
  const fresh = !fs.existsSync(context.envPath);
  if (fresh) {
    const example = path.join(context.kit, ".env.example");
    const text = fs.existsSync(example) ? fs.readFileSync(example, "utf8") : "";
    fs.writeFileSync(context.envPath, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  const file = readEnvFile(context.envPath);
  const empty = (key) => !String(file[key] || "").trim();
  const vars = {};
  if (options.relay) vars.PI_REMOTE_RELAY = options.relay;
  else if (empty("PI_REMOTE_RELAY")) vars.PI_REMOTE_RELAY = LOOPBACK_RELAY;
  // 模板里的占位 token 会让扩展拿 change-me 去登录：服务器上只用配对换来的设备令牌
  if (String(file.PI_REMOTE_TOKEN || "").trim() === "change-me") vars.PI_REMOTE_TOKEN = "";
  if (fresh) vars.PI_REMOTE_LABEL = "";
  if (options.name) vars.PI_REMOTE_DEVICE_NAME = String(options.name).trim();
  if (projects) vars.PI_REMOTE_PROJECTS = projects.join(";");
  if (empty("PI_REMOTE_LAUNCHER")) vars.PI_REMOTE_LAUNCHER = "tmux";
  // tmux 拉起的 pi 拿到的 PATH 不一定有 ~/.local/bin：找到了就写死绝对路径
  if (empty("PI_REMOTE_PI_BIN")) {
    const pi = findPi(context, "");
    if (pi) vars.PI_REMOTE_PI_BIN = pi.path;
  }
  if (Object.keys(vars).length) attach.writeEnvVars(context.envPath, vars);
  fs.chmodSync(context.envPath, 0o600);

  const { config, pick } = settings(context);
  context.out(`${fresh ? "已生成" : "已补全"} ${tilde(context, context.envPath)}（权限 600）`);
  context.out(`  PI_REMOTE_RELAY       = ${config.relay}`);
  context.out(`  PI_REMOTE_DEVICE_NAME = ${config.deviceName}`);
  context.out(`  PI_REMOTE_PROJECTS    = ${config.projects.map(displayPathOf).join(";") || "（空：网页上不能新建会话，用 --projects 设）"}`);
  context.out(`  PI_REMOTE_PI_BIN      = ${displayPathOf(pick("PI_REMOTE_PI_BIN")) || "（没找到 pi：先装 pi，再跑一次 init）"}`);
  context.out(`  设备凭据              = ${config.deviceToken ? "已配对（设备令牌）" : deviceKeysOf(context) ? "已配对（身份钥）" : "未配对"}`);
  if (!config.deviceToken && !deviceKeysOf(context)) context.out(`下一步：网页「设备」→「添加设备」拿配对码，然后 ${hint(context, "pair XXXX-XXXX")}`);
  return 0;
}

async function cmdPair(context, options = {}) {
  if (blockRoot(context)) return 2;
  let code;
  try {
    code = attach.normalizePairCode(options.code);
  } catch (error) {
    context.err(error.message);
    return 2;
  }
  if (options.relay != null && !validRelay(options.relay)) {
    context.err("--relay 需要 ws:// 或 wss:// 地址");
    return 2;
  }
  if (!fs.existsSync(context.envPath)) {
    const exitCode = cmdInit(context, {});
    if (exitCode) return exitCode;
  }
  const { config } = settings(context);
  const relay = options.relay || config.relay || LOOPBACK_RELAY;
  const exitCode = await attach.pairMain({ pair: code, relay }, context.envPath, {
    env: context.env,
    platform: context.platform,
    writeOut: context.out,
    writeErr: context.err,
    WebSocketImpl: context.WebSocketImpl,
    timeoutMs: context.pairTimeoutMs,
  });
  try {
    fs.chmodSync(context.envPath, 0o600);
  } catch {}
  if (exitCode) return exitCode;
  if (hasSession(context, ATTACH_SESSION)) context.out(`连接窗口还拿着旧身份，重开一次：${hint(context, "down")} && ${hint(context, "up")}`);
  else context.out(`打开连接窗口：${hint(context, "up")}`);
  return 0;
}

function windowOpen(windowState) {
  return !!(windowState && !windowState.broken && windowState.alive);
}

function describeWindow(context, windowState, inTmux) {
  if (!windowOpen(windowState)) {
    if (inTmux) return `连接窗口的 tmux 会话 ${ATTACH_SESSION} 在，但还没连上 relay（tmux attach -t ${ATTACH_SESSION} 看状态）`;
    return windowState ? "连接窗口没开（状态文件是上次残留的，下次 up 会清掉）" : "连接窗口没开";
  }
  const where = inTmux ? `tmux 会话 ${ATTACH_SESSION}` : `不在 tmux 里，pid ${windowState.pid}：到它的终端里 Ctrl+C 关闭`;
  return `连接窗口开着（${where}），到 ${fmtTime(windowState.expiresAt)} 自动关闭（还剩 ${fmtLeft(windowState.expiresAt - context.now())}）`;
}

/** 连接窗口自己的退出码落盘位置；device.sh up 拉起时注入给 attach.cjs */
function attachExitFile(context) {
  return attach.exitCodePath(ATTACH_SESSION, context.home);
}

async function waitWindowUp(context, config, before, hours, dirs) {
  const deadline = context.now() + context.upWaitMs;
  for (;;) {
    const windowState = readWindow(context);
    // attach 认证通过才写状态文件：文件是这次开的（不是开之前就在的那份）、进程活着、设备对得上，才算窗口真的开了
    const fresh = windowState && (!before || windowState.pid !== before.pid || windowState.startedAt !== before.startedAt);
    if (windowOpen(windowState) && fresh && windowState.deviceId === config.deviceId) {
      context.out(`连接窗口已打开（tmux 会话 ${ATTACH_SESSION}），到 ${fmtTime(windowState.expiresAt)} 自动关闭（--max-hours ${hours}）`);
      if (dirs.length) context.out(`  窗口拿到会话列表后在 tmux 里拉起：${dirs.map((dateValue) => tilde(context, dateValue)).join("  ")}（${hint(context, "sessions")} 查看）`);
      context.out(`  看状态：tmux attach -t ${ATTACH_SESSION}（Ctrl+B 再按 D 离开，窗口不关）`);
      context.out(`  关闭：${hint(context, "down")}`);
      return 0;
    }
    const panes = sessionPanes(context, ATTACH_SESSION);
    if (!panes) {
      // 会话已经整个收掉时窗格字段也没了：读 attach 自己的落盘码再报
      const code = attach.readExitCode(ATTACH_SESSION, context.home);
      context.err(`连接窗口刚开就退出了${code == null ? "" : `（退出码 ${code}）`}。在前台跑一次看原因：${tilde(context, path.join(context.kit, "deploy", "attach.sh"))}`);
      removeQuiet(attachExitFile(context));
      return 1;
    }
    const dead = panes.find((targetPath) => targetPath.dead);
    if (dead) {
      const lines = capturePane(context, ATTACH_SESSION);
      runTmux(context, ["kill-session", "-t", "=" + ATTACH_SESSION]);
      // 窗格字段优先；tmux 3.4 丢字段时读 attach 自己落盘的退出码
      const code = dead.status == null ? attach.readExitCode(ATTACH_SESSION, context.home) : dead.status;
      context.err(`连接窗口退出了（退出码 ${code == null ? "?" : code}）：`);
      for (const line of lines) context.err("  " + line);
      removeQuiet(attachExitFile(context));
      return 1;
    }
    if (context.now() >= deadline) {
      context.err(`连接窗口在 tmux 里跑着，但 ${Math.round(context.upWaitMs / 1000)} 秒内没连上 relay（${config.relay}），它会一直重连。`);
      context.err(`  看状态：tmux attach -t ${ATTACH_SESSION}；relay 体检：${hint(context, "doctor")}`);
      return 1;
    }
    await context.sleep(100);
  }
}

async function cmdUp(context, options = {}) {
  if (blockRoot(context)) return 2;
  const { config } = settings(context);
  if (!config.deviceId || !config.relay || (!config.deviceToken && !config.token && !deviceKeysOf(context))) {
    context.err(`还没配对：网页「设备」→「添加设备」拿配对码，然后 ${hint(context, "pair XXXX-XXXX")}`);
    return 1;
  }
  const hours = options.maxHours == null ? DEFAULT_HOURS : Number(options.maxHours);
  if (!Number.isFinite(hours) || hours <= 0) {
    context.err("--max-hours 需要正数（小时）");
    return 2;
  }
  const dirs = [];
  for (const dateValue of options.dirs || []) {
    // attach 在套件目录里跑：相对路径要按调用方的目录解开
    const abs = path.resolve(context.cwd, dateValue);
    if (/[\0\r\n]/.test(abs) || !isDir(abs)) {
      context.err("目录不存在：" + abs);
      return 2;
    }
    dirs.push(abs);
  }
  const tmuxInfo = tmuxVersion(context);
  if (!tmuxInfo) {
    context.err("找不到 tmux：" + attach.tmuxInstallHint("linux", { exists: fs.existsSync }));
    return 1;
  }
  if (hasSession(context, ATTACH_SESSION)) {
    const panes = sessionPanes(context, ATTACH_SESSION) || [];
    if (panes.length && panes.every((targetPath) => targetPath.dead)) {
      // 上次 up 失败留下的现场（等待期间被 Ctrl+C 打断，没来得及收）：收掉重开
      runTmux(context, ["kill-session", "-t", "=" + ATTACH_SESSION]);
      removeQuiet(attachExitFile(context));
    } else {
      context.out(describeWindow(context, readWindow(context), true));
      if (dirs.length) context.out(`窗口已经开着，目录参数没用上：用 ${hint(context, "start <目录>")} 起 pi，或在网页上新建`);
      return 0;
    }
  }
  const before = readWindow(context);
  if (windowOpen(before)) {
    // 别处（前台终端）开着的窗口：再开一个会把它顶下线，让用户自己决定
    context.err(`${describeWindow(context, before, false)}。先关掉它再 up`);
    return 1;
  }
  const ext = extensionState(context);
  if (!ext.synced) context.out("[warn] " + ext.text);
  // 窗口自己的退出码也落盘：tmux 3.4 丢 #{pane_dead_status} 时还能报出真实原因
  const exitFile = attachExitFile(context);
  removeQuiet(exitFile);
  const tmuxArgs = [
    "new-session", "-d", "-s", ATTACH_SESSION, "-c", context.kit,
    "/usr/bin/env", `PI_REMOTE_EXIT_FILE=${exitFile}`,
    context.nodeBin, context.attachCjs, "--max-hours", String(hours), ...dirs,
  ].map(tmuxArg);
  // 窗口当场失败（令牌被撤销、缺配置）时窗格留着，下面把原因抓出来再收掉
  if (tmuxInfo.keepFailed) tmuxArgs.push(";", "set-option", "-w", "-t", `=${ATTACH_SESSION}:`, "remain-on-exit", "failed");
  const result = runTmux(context, tmuxArgs);
  if (result.status !== 0) {
    context.err("tmux 没能开会话：" + (result.stderr || "退出码 " + result.status));
    return 1;
  }
  return waitWindowUp(context, config, before, hours, dirs);
}

async function cmdDown(context) {
  if (!hasSession(context, ATTACH_SESSION)) {
    const windowState = readWindow(context);
    if (windowState && windowState.alive) {
      context.err(`连接窗口不是 device.sh 开的（pid ${windowState.pid}）：到它的终端里 Ctrl+C，或 kill ${windowState.pid}`);
      return 1;
    }
    if (windowState) {
      removeQuiet(context.stateFile);
      removeQuiet(attachExitFile(context));
      context.out("清掉了上次残留的窗口状态文件");
    } else {
      removeQuiet(attachExitFile(context));
    }
    context.out("连接窗口没有在运行");
    return 0;
  }
  // kill-session 给窗格进程发 SIGHUP：attach 照 Ctrl+C 的路子收尾（删状态文件、断开）
  const result = runTmux(context, ["kill-session", "-t", "=" + ATTACH_SESSION]);
  if (result.status !== 0 && hasSession(context, ATTACH_SESSION)) {
    context.err("tmux 关不掉会话：" + (result.stderr || "退出码 " + result.status));
    return 1;
  }
  const deadline = context.now() + context.downWaitMs;
  let windowState = readWindow(context);
  while (windowState && windowState.alive && context.now() < deadline) {
    await context.sleep(100);
    windowState = readWindow(context);
  }
  if (windowState && windowState.alive) {
    context.err(`窗口进程 ${windowState.pid} 还没退出：kill ${windowState.pid}`);
    return 1;
  }
  if (windowState) removeQuiet(context.stateFile);
  removeQuiet(attachExitFile(context));
  context.out("连接窗口已关闭：扩展随即断开 relay，已经拉起的 pi 照常运行（" + hint(context, "sessions") + " 查看）");
  return 0;
}

function cmdStart(context, options = {}) {
  if (blockRoot(context)) return 2;
  if (!options.dir) {
    context.err("用法：" + hint(context, "start <目录> [--session <会话 id 或文件>]"));
    return 2;
  }
  const abs = path.resolve(context.cwd, options.dir);
  if (/[\0\r\n]/.test(abs) || !isDir(abs)) {
    context.err("目录不存在：" + abs);
    return 2;
  }
  if (options.session != null && (!String(options.session).trim() || /[\0\r\n]/.test(options.session))) {
    context.err("--session 需要会话 id 或会话文件路径");
    return 2;
  }
  const tmuxInfo = tmuxVersion(context);
  if (!tmuxInfo) {
    context.err("找不到 tmux：" + attach.tmuxInstallHint("linux", { exists: fs.existsSync }));
    return 1;
  }
  if (!fs.existsSync(context.startPi)) {
    context.err("套件里没有 " + context.startPi);
    return 1;
  }
  let cwd = abs;
  try {
    cwd = fs.realpathSync.native(abs);
  } catch {}
  // 和网页拉起同一个形状（attach.cjs 的 tmux 规则）：会话名、参数转义、失败留现场都一样
  const spec = attach.buildSpawnSpec({
    cwd,
    sessionPath: options.session ? String(options.session).trim() : null,
    startPi: context.startPi,
    platform: context.platform,
    launcher: "tmux",
    keepFailed: tmuxInfo.keepFailed,
    // 和网页拉起同一契约：start-pi.sh 把退出码落盘，sessions / clean 读不到窗格字段时回落
    exitHome: context.home,
    // Same propagation contract as attach-launched pi: the pane gets the kit
    // .env's resolved config, not whatever env the tmux server happened to have.
    childEnv: attach.piChildEnv(context.envPath, context.env),
  });
  const name = spec.tmuxSession;
  const result = runTmux(context, spec.args);
  if (result.status !== 0) {
    context.err("tmux 没能开会话：" + (result.stderr || "退出码 " + result.status));
    return 1;
  }
  context.out(`已在 tmux 会话 ${name} 里起 pi：tmux attach -t ${name}`);
  const { config } = settings(context);
  if (!attach.cwdAllowed(cwd, config.projects, context.platform)) context.out("[warn] 这个目录不在 PI_REMOTE_PROJECTS 里：网页上看得到这份 pi，但不能从网页重新拉起它");
  if (!windowOpen(readWindow(context))) context.out(`[warn] 连接窗口没开：这份 pi 不会出现在网页上，${hint(context, "up")} 之后才连 relay`);
  return 0;
}

function sessionLine(context, sessionRow) {
  const state = sessionRow.dead ? `已退出（退出码 ${sessionRow.status == null ? "?" : sessionRow.status}）` : "运行中";
  return `  ${sessionRow.name}  ${tilde(context, sessionRow.cwd)}  ${state}`;
}

function cmdSessions(context) {
  const list = piSessions(context);
  if (!list.length) {
    context.out("没有 pi 的 tmux 会话");
    return 0;
  }
  context.out("pi 会话（tmux attach -t <名字> 进去，Ctrl+B 再按 D 离开）：");
  for (const sessionRow of list) context.out(sessionLine(context, sessionRow));
  if (list.some((sessionRow) => sessionRow.dead)) context.out(`已退出的会话留着现场，看完用 ${hint(context, "clean")} 收掉`);
  return 0;
}

function cmdClean(context) {
  const dead = piSessions(context).filter((sessionRow) => sessionRow.dead);
  for (const sessionRow of dead) {
    runTmux(context, ["kill-session", "-t", "=" + sessionRow.name]);
    attach.removeExitCode(sessionRow.name, context.home);
  }
  context.out(dead.length ? `收掉了 ${dead.length} 个已退出的 pi 会话：${dead.map((sessionRow) => sessionRow.name).join(" ")}` : "没有已退出的 pi 会话");
  return 0;
}

async function cmdStatus(context) {
  const { config } = settings(context);
  context.out(describeWindow(context, readWindow(context), hasSession(context, ATTACH_SESSION)));
  const who = config.deviceId ? `${config.deviceName}（${config.deviceId}）` : `${config.deviceName}（没有设备编号）`;
  context.out(`设备：${who} · ${config.deviceToken || deviceKeysOf(context) ? "已配对" : "未配对"}`);
  const relay = config.relay || LOOPBACK_RELAY;
  const health = await relayHealth(context, relay);
  if (health.ok && health.data) {
    const dateValue = health.data;
    context.out(`relay：${relay} · proto ${dateValue.proto} · ${dateValue.version || "?"} · 在线设备 ${dateValue.devices ? dateValue.devices.online : "?"} · 在线会话 ${dateValue.rooms ? dateValue.rooms.online : "?"}`);
  } else {
    context.out(`relay：${relay} · 健康检查失败（${health.error}）`);
  }
  const list = piSessions(context);
  if (!list.length) context.out("pi 会话：无");
  else {
    context.out("pi 会话：");
    for (const sessionRow of list) context.out(sessionLine(context, sessionRow));
  }
  return 0;
}

async function cmdDoctor(context) {
  let fails = 0;
  const ok = (text) => context.out("[ok]   " + text);
  const warn = (text) => context.out("[warn] " + text);
  const fail = (text) => {
    fails++;
    context.out("[fail] " + text);
  };
  const { config, pick } = settings(context);

  if (context.uid === 0) {
    if (String(pick("PI_REMOTE_ALLOW_ROOT")) === "1") warn("以 root 运行（PI_REMOTE_ALLOW_ROOT=1）：网页能让 pi 以 root 执行命令");
    else fail("以 root 运行：服务器上的 pi 要用普通用户跑（见 deploy/README.md §3）");
  } else ok(`运行用户 ${context.user || "uid " + context.uid}`);

  if (nodeVersionOk()) ok(`node ${process.versions.node}`);
  else fail(`node ${process.versions.node} 太旧：要 ≥ ${MIN_NODE.join(".")}（扩展用内置 WebSocket）`);

  const tmuxInfo = tmuxVersion(context);
  if (!tmuxInfo) fail("找不到 tmux：" + attach.tmuxInstallHint("linux", { exists: fs.existsSync }));
  else if (!tmuxInfo.keepFailed) warn(`${tmuxInfo.text}：低于 3.2，pi 启动失败时 tmux 不保留现场`);
  else ok(tmuxInfo.text);

  const pinned = pick("PI_REMOTE_PI_BIN");
  const pi = findPi(context, pinned);
  if (!pi) fail("找不到 pi：npm i -g --prefix ~/.local @earendil-works/pi-coding-agent，再 " + hint(context, "init"));
  else if (!pi.ok) {
    // 写错路径和没有执行位是两种排障：一律说「不可执行」会让人以为是权限问题
    const reason = fs.existsSync(pi.path) ? "没有可执行权限（或不是可执行文件）" : "路径不存在";
    fail(`PI_REMOTE_PI_BIN=${pi.path} ${reason}`);
  }
  else {
    const valueText = spawnSync(pi.path, ["--version"], { encoding: "utf8", timeout: 20000, env: { ...context.env, PI_OFFLINE: "1" } });
    const ver = String(valueText.stdout || "").trim().split("\n")[0];
    if (valueText.status === 0 && ver) ok(`pi ${ver}（${tilde(context, pi.path)}）`);
    else warn(`pi 在 ${tilde(context, pi.path)}，但 pi --version 没有正常返回`);
    if (!pinned && pi.from !== "PATH") warn(`pi 不在 PATH 里：${hint(context, "init")} 会把它写进 PI_REMOTE_PI_BIN`);
  }

  try {
    require.resolve("ws", { paths: [path.join(context.kit, "deploy")] });
    ok("依赖 ws 已装");
  } catch {
    fail(`缺依赖 ws：cd ${tilde(context, context.kit)} && npm ci --omit=dev`);
  }

  if (!fs.existsSync(context.envPath)) fail(`没有 ${tilde(context, context.envPath)}：${hint(context, "init --projects <目录>")}`);
  else {
    const mode = fs.statSync(context.envPath).mode & 0o777;
    if (mode & 0o077) warn(`.env 权限 ${mode.toString(8)}：里面有设备令牌，chmod 600 ${tilde(context, context.envPath)}`);
    else ok(".env 权限 600");
    let host = "";
    try {
      host = new URL(config.relay).hostname;
    } catch {}
    if (!config.relay) fail("PI_REMOTE_RELAY 没配");
    else if (!validRelay(config.relay) || !host) fail(`PI_REMOTE_RELAY 不对：${config.relay}`);
    else if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]") ok(`relay ${config.relay}（回环，令牌不出本机）`);
    else warn(`relay ${config.relay}：relay 就在这台服务器上时改成 ${LOOPBACK_RELAY}，令牌不走公网`);
    if (!config.projects.length) warn(`PI_REMOTE_PROJECTS 是空的：网页上不能新建会话（${hint(context, "init --projects <目录>")}）`);
    else {
      const missing = config.projects.filter((targetPath) => !isDir(targetPath));
      if (missing.length) warn("白名单里这些目录不存在：" + missing.map(displayPathOf).join(" "));
      else ok(`白名单 ${config.projects.length} 个目录`);
    }
  }

  let paired = false;
  let pairKind = "";
  const devKeys = deviceKeysOf(context);
  if (config.deviceId && config.deviceToken) {
    paired = true;
    pairKind = "token";
    ok(`已配对：设备 ${config.deviceId}`);
  } else if (config.deviceId && devKeys) {
    paired = true;
    pairKind = "key";
    ok(`已配对（身份钥）：设备 ${config.deviceId} · 指纹 ${attach.formatFingerprint(attach.keyFingerprint(devKeys.sign.pub))}`);
  } else if (config.deviceId && config.token) warn("只有共享令牌（PI_REMOTE_TOKEN），没配对：网页「添加设备」后 " + hint(context, "pair XXXX-XXXX"));
  else fail("还没配对：网页「设备」→「添加设备」拿配对码，然后 " + hint(context, "pair XXXX-XXXX"));

  const ext = extensionState(context);
  if (ext.synced) ok(ext.text);
  else fail(ext.text);

  const relay = config.relay || LOOPBACK_RELAY;
  const health = await relayHealth(context, relay);
  if (health.ok && health.data) {
    if (Number(health.data.proto) >= 4) ok(`relay 健康（proto ${health.data.proto}，${health.data.version || "?"}）`);
    else fail(`relay 协议版本 ${health.data.proto}：设备令牌要 v4 relay`);
  } else fail(`relay 健康检查失败：${health.url || relay}（${health.error}）`);

  if (paired && health.ok) {
    const tokenText = await probeAuth(context, config);
    if (tokenText.ok && tokenText.auth === pairKind) ok(pairKind === "key" ? "设备身份钥有效" : "设备令牌有效");
    else if (tokenText.ok) warn(`relay 按 ${tokenText.auth || "旧"} 方式认了这台设备，不是${pairKind === "key" ? "身份钥" : "设备令牌"}`);
    else if (tokenText.code === "device_revoked") fail("这台设备在网页上被撤销了：重新配对（" + hint(context, "pair XXXX-XXXX") + "）");
    else fail(`${pairKind === "key" ? "设备身份钥" : "设备令牌"}没通过（${tokenText.code}${tokenText.error ? "：" + tokenText.error : ""}）：重新配对`);
  }

  const windowState = readWindow(context);
  const text = describeWindow(context, windowState, tmuxInfo ? hasSession(context, ATTACH_SESSION) : false);
  if (windowOpen(windowState)) ok(text);
  else warn(`${text}：${hint(context, "up")}`);

  const locale = attach.currentLocale(context.env);
  if (attach.localeIsUtf8(locale)) ok(`语言环境 ${locale}`);
  else {
    const injected = tmuxLocale(context);
    if (injected) warn(`语言环境 ${locale || "未设置"}：tmux 调用已注入 ${injected}（tmux 3.4 在非 UTF-8 下会净化制表符）`);
    else warn(`语言环境 ${locale || "未设置"}：本机没有可用的 UTF-8 locale，tmux 输出按兼容格式解析（会话列表仍可用，中文可能乱码）；建议生成/导出 C.UTF-8`);
  }

  context.out(fails ? `${fails} 项要处理` : "全部通过");
  return fails ? 1 : 0;
}

function cmdLogs(context, options = {}) {
  const countValue = options.lines == null ? 40 : Number(options.lines);
  if (!Number.isInteger(countValue) || countValue <= 0) {
    context.err("-n 需要正整数");
    return 2;
  }
  // start-pi.sh 把 .env 导出给 pi：扩展日志的位置以 .env 为准
  const file = settings(context).pick("PI_REMOTE_LOG") || context.logFile;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    context.out(`还没有扩展日志（${tilde(context, file)}）：pi 在连接窗口里跑起来后才有`);
    return 0;
  }
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines.slice(-countValue)) context.out(line);
  return 0;
}

const HELP = `pi-remote Linux 设备（服务器式，tmux 拉起）

  device.sh init [--projects 目录[;目录…]] [--name 显示名] [--relay ws://…]
      生成或补全 .env（relay 缺省 ${LOOPBACK_RELAY}；找到的 pi 写进 PI_REMOTE_PI_BIN）
  device.sh pair XXXX-XXXX [--relay ws://…]
      用网页「添加设备」给的配对码换这台设备的令牌（写进 .env，不打印）
  device.sh up [--max-hours ${DEFAULT_HOURS}] [项目目录…]
      在 tmux 会话 ${ATTACH_SESSION} 里打开连接窗口；带目录就顺带各起一份 pi
  device.sh down
      关闭连接窗口：扩展断开 relay，已经拉起的 pi 不关
  device.sh start 目录 [--session 会话id或文件]
      在新的 tmux 会话里起一份 pi（和网页「新建/启用」同样的拉起方式）
  device.sh status     窗口、设备、relay、pi 会话一览
  device.sh sessions   pi 的 tmux 会话（含启动失败留下的现场）
  device.sh clean      收掉已经退出的 pi 会话
  device.sh doctor     逐项体检：用户、node、tmux、pi、依赖、.env、配对、扩展、relay
  device.sh logs [-n 40]   扩展日志末尾

看窗口：tmux attach -t ${ATTACH_SESSION}（Ctrl+B 再按 D 离开，窗口不关）
进某个 pi：tmux attach -t <会话名>（名字见 device.sh sessions）`;

function parseOpts(argv, spec) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const tokenText = String(argv[index]);
    if (tokenText === "--") {
      out._.push(...args.slice(index + 1).map(String));
      break;
    }
    if (tokenText.length > 1 && tokenText.startsWith("-")) {
      const eq = tokenText.indexOf("=");
      const flag = eq > 0 ? tokenText.slice(0, eq) : tokenText;
      const key = spec[flag];
      if (!key) throw new UsageError("未知参数：" + flag);
      const flagValue = eq > 0 ? tokenText.slice(eq + 1) : argv[++index];
      if (flagValue === undefined) throw new UsageError(flag + " 需要一个值");
      out[key] = String(flagValue);
    } else out._.push(tokenText);
  }
  return out;
}

function onlyPositional(options, max, usage) {
  if (options._.length > max) throw new UsageError("多余的参数：" + options._.slice(max).join(" ") + "\n用法：" + usage);
}

async function main(argv, context = makeContext()) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "init": {
        const options = parseOpts(rest, { "--projects": "projects", "--name": "name", "--relay": "relay" });
        onlyPositional(options, 0, "device.sh init [--projects …] [--name …] [--relay …]");
        return cmdInit(context, options);
      }
      case "pair": {
        const options = parseOpts(rest, { "--relay": "relay" });
        onlyPositional(options, 1, "device.sh pair XXXX-XXXX [--relay ws://…]");
        return await cmdPair(context, { code: options._[0], relay: options.relay });
      }
      case "up": {
        const options = parseOpts(rest, { "--max-hours": "maxHours" });
        return await cmdUp(context, { maxHours: options.maxHours, dirs: options._ });
      }
      case "down":
        onlyPositional(parseOpts(rest, {}), 0, "device.sh down");
        return await cmdDown(context);
      case "start": {
        const options = parseOpts(rest, { "--session": "session" });
        onlyPositional(options, 1, "device.sh start <目录> [--session …]");
        return cmdStart(context, { dir: options._[0], session: options.session });
      }
      case "status":
        onlyPositional(parseOpts(rest, {}), 0, "device.sh status");
        return await cmdStatus(context);
      case "sessions":
      case "ls":
        onlyPositional(parseOpts(rest, {}), 0, "device.sh sessions");
        return cmdSessions(context);
      case "clean":
        onlyPositional(parseOpts(rest, {}), 0, "device.sh clean");
        return cmdClean(context);
      case "doctor":
        onlyPositional(parseOpts(rest, {}), 0, "device.sh doctor");
        return await cmdDoctor(context);
      case "logs": {
        const options = parseOpts(rest, { "-n": "lines", "--lines": "lines" });
        onlyPositional(options, 0, "device.sh logs [-n 40]");
        return cmdLogs(context, options);
      }
      case undefined:
      case "help":
      case "-h":
      case "--help":
        context.out(HELP);
        return 0;
      default:
        context.err(`未知命令：${cmd}\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      context.err(error.message);
      return 2;
    }
    throw error;
  }
}

module.exports = {
  ATTACH_SESSION,
  LOOPBACK_RELAY,
  makeContext,
  main,
  parseOpts,
  parseProjects,
  tmuxVersion,
  tmuxLocale,
  tmuxEnv,
  sessionPanes,
  piSessions,
  attachExitFile,
  findPi,
  piFallbacks,
  healthUrl,
  nodeVersionOk,
  readWindow,
  extensionState,
  probeAuth,
  displayPathOf,
};

if (require.main === module) {
  // 不直接 process.exit：stdout 是管道时（macOS 上异步）会截掉还没写完的输出
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code || 0;
    },
    (error) => {
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
    },
  );
}
