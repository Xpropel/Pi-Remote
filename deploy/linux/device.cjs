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

function makeContext(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || env.HOME || os.homedir();
  const kit = opts.kit || KIT;
  const agentHome = path.join(home, ".pi", "agent");
  return {
    env,
    home,
    kit,
    cwd: opts.cwd || process.cwd(),
    platform: opts.platform || process.platform,
    uid: opts.uid !== undefined ? opts.uid : typeof process.getuid === "function" ? process.getuid() : -1,
    user: opts.user || env.USER || env.LOGNAME || "",
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
    nodeBin: opts.nodeBin || process.execPath,
    piFallbacks: opts.piFallbacks || piFallbacks(home, env),
    // tmux 客户端环境由 runTmux 注入 UTF-8 locale；tmux 本身用这个壳（第二参数给 runTmux 传 env）
    tmux: opts.tmux || ((args, runOpts) => spawnSync("tmux", args, { encoding: "utf8", env: (runOpts && runOpts.env) || env, timeout: 10000 })),
    // 探测本机 UTF-8 locale 用；测试可注入。undefined = 还没探，空串 = 探过但没有（走兼容解析）
    localeSpawn: opts.localeSpawn || spawnSync,
    utf8Locale: opts.utf8Locale,
    out: opts.out || ((line) => process.stdout.write(line + "\n")),
    err: opts.err || ((line) => process.stderr.write(line + "\n")),
    now: opts.now || (() => Date.now()),
    sleep: opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    upWaitMs: opts.upWaitMs || UP_WAIT_MS,
    downWaitMs: opts.downWaitMs || DOWN_WAIT_MS,
    WebSocketImpl: opts.WebSocketImpl,
    pairTimeoutMs: opts.pairTimeoutMs,
  };
}

/* ---------- 小工具 ---------- */

function isExecutable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
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
function settings(ctx) {
  const file = readEnvFile(ctx.envPath);
  const pick = (key) => {
    const fromFile = file[key];
    if (fromFile != null && String(fromFile).trim() !== "") return String(fromFile).trim();
    const fromEnv = ctx.env[key];
    return fromEnv != null && String(fromEnv).trim() !== "" ? String(fromEnv).trim() : "";
  };
  return { file, pick, cfg: attach.loadConfig(ctx.envPath, ctx.env, ctx.platform) };
}

function tilde(ctx, p) {
  const s = displayPathOf(p);
  return ctx.home && (s === ctx.home || s.startsWith(ctx.home + "/")) ? "~" + s.slice(ctx.home.length) : s;
}

function hint(ctx, sub) {
  return `${tilde(ctx, ctx.deviceSh)} ${sub}`;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === "EPERM");
  }
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtLeft(ms) {
  const min = Math.max(0, Math.floor(ms / 60000));
  return min >= 60 ? `${Math.floor(min / 60)} 小时 ${min % 60} 分` : `${min} 分`;
}

function md5File(p) {
  try {
    return crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex");
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
function findPi(ctx, pinned) {
  if (pinned) return { path: pinned, ok: isExecutable(pinned), from: "PI_REMOTE_PI_BIN" };
  for (const dir of String(ctx.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, "pi");
    if (isExecutable(p)) return { path: p, ok: true, from: "PATH" };
  }
  for (const p of ctx.piFallbacks) if (isExecutable(p)) return { path: p, ok: true, from: "常见位置" };
  return null;
}

/* ---------- tmux ---------- */

/**
 * tmux 3.4 的格式化输出会按**客户端** locale 净化：LANG=C / LC_ALL=C 时制表符变成下划线，
 * 整行字段塌成一条（会话名、死活、退出码、目录、创建时间全取不到）。本机存在 UTF-8 locale 时
 * 给每次 tmux 调用注入 LANG/LC_ALL；探不到就交给下面的兼容解析（以真实会话名锚定、丢幻影行）。
 */
function tmuxLocale(ctx) {
  if (ctx.utf8Locale === undefined) {
    const current = attach.currentLocale(ctx.env);
    ctx.utf8Locale = attach.localeIsUtf8(current) ? "" : attach.availableUtf8Locale(ctx.localeSpawn, ctx.env, ctx.platform);
  }
  return ctx.utf8Locale;
}

function tmuxEnv(ctx) {
  if (!ctx._tmuxEnv) ctx._tmuxEnv = attach.tmuxEnvWithLocale(ctx.env, tmuxLocale(ctx));
  return ctx._tmuxEnv;
}

function runTmux(ctx, args) {
  // 注意：tmux 服务端环境是启动时定死的，但输出净化发生在客户端；给客户端换 locale 就能修好已存在的服务
  const r = ctx.tmux(args, { env: tmuxEnv(ctx) }) || {};
  return {
    status: r.status == null ? -1 : r.status,
    stdout: String(r.stdout || ""),
    stderr: String(r.stderr || "").trim(),
    missing: !!(r.error && r.error.code === "ENOENT"),
    error: r.error || null,
  };
}

/** 没装 tmux 返回 null；keepFailed = 支持 remain-on-exit failed（3.2 起）。与 attach.cjs 同一个判断 */
function tmuxVersion(ctx) {
  const info = attach.probeTmux((_file, args) => ctx.tmux(args, { env: tmuxEnv(ctx) }));
  return info ? { text: info.version, keepFailed: info.keepFailed } : null;
}

const { tmuxArg } = attach;

/** -t 一律用 =名字 精确匹配：否则 tmux 会按前缀把 pi-remote-attach-xxx 这类 pi 会话当成窗口 */
function hasSession(ctx, name) {
  return runTmux(ctx, ["has-session", "-t", "=" + name]).status === 0;
}

/** 一条 list-panes 输出：正常是制表符分隔；tmux 3.4 非 UTF-8 时是 0_ / 1_1 这种下划线形态 */
function parsePaneRow(line) {
  if (line.includes("\t")) {
    const [dead, status] = line.split("\t");
    return { dead: dead === "1", status: status === "" || status == null ? null : Number(status) };
  }
  const m = /^([01])(?:_(.*))?$/.exec(line);
  if (!m) return null;
  const n = m[2] == null || m[2] === "" ? null : Number(m[2]);
  return { dead: m[1] === "1", status: Number.isFinite(n) ? n : null };
}

function sessionPanes(ctx, name) {
  const r = runTmux(ctx, ["list-panes", "-s", "-t", "=" + name, "-F", "#{pane_dead}\t#{pane_dead_status}"]);
  if (r.status !== 0) return null;
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map(parsePaneRow)
    .filter(Boolean);
}

function capturePane(ctx, name, max = 15) {
  const r = runTmux(ctx, ["capture-pane", "-p", "-J", "-t", `=${name}:`, "-S", "-60"]);
  if (r.status !== 0) return [];
  const lines = r.stdout.split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.filter((l, i, all) => l || (i > 0 && all[i - 1])).slice(-max);
}

/** 非 UTF-8 输出里的真实会话名：单独查一次（这个格式没有制表符，不受净化影响） */
function sessionNames(ctx) {
  const r = runTmux(ctx, ["list-sessions", "-F", "#{session_name}"]);
  if (r.status !== 0) return null;
  return r.stdout
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
  const m = /^([01])_(\d*)_(.*)_(\d+)$/.exec(line.slice(name.length + 1));
  if (!m) return null;
  return { name, dead: m[1] === "1", status: m[2] === "" ? null : Number(m[2]), cwd: m[3], created: Number(m[4]) * 1000 || 0 };
}

/** 所有 pi 的 tmux 会话（不含连接窗口）。没有 tmux 服务（一个会话都没有）时是空列表 */
function piSessions(ctx) {
  const r = runTmux(ctx, ["list-panes", "-a", "-F", "#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{session_path}\t#{session_created}"]);
  if (r.status !== 0) return [];
  const lines = r.stdout.split("\n").filter(Boolean);
  const collapsed = lines.length > 0 && !lines.some((line) => line.includes("\t"));
  const names = collapsed ? sessionNames(ctx) : null;
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
  for (const item of list) if (item.dead && item.status == null) item.status = attach.readExitCode(item.name, ctx.home);
  return list.sort((a, b) => a.created - b.created);
}

/* ---------- 窗口状态、扩展、relay ---------- */

function readWindow(ctx) {
  let raw;
  try {
    raw = fs.readFileSync(ctx.stateFile, "utf8");
  } catch {
    return null;
  }
  let st;
  try {
    st = JSON.parse(raw);
  } catch {
    return { broken: true, alive: false };
  }
  if (!st || typeof st !== "object") return { broken: true, alive: false };
  const pid = Number(st.pid);
  const expiresAt = Number(st.expiresAt) || 0;
  return {
    broken: false,
    pid,
    // 过期的按残留处理：pid 可能早被系统复用给了别的进程（attach 的 clearStaleState 同样这么判）
    alive: expiresAt > ctx.now() && pidAlive(pid),
    deviceId: String(st.deviceId || ""),
    startedAt: Number(st.startedAt) || 0,
    expiresAt,
  };
}

function extensionState(ctx) {
  const want = md5File(ctx.extSrc);
  const have = md5File(ctx.extDst);
  if (!want) return { synced: false, text: "套件里没有 extension/pi-remote-sync.ts（重新推一次套件）" };
  if (!have) return { synced: false, text: `扩展还没装到 ${tilde(ctx, ctx.extDst)}：${tilde(ctx, path.join(ctx.kit, "deploy", "sync-extension.sh"))}` };
  if (have !== want) return { synced: false, text: `装着的扩展不是这套件的版本：${tilde(ctx, path.join(ctx.kit, "deploy", "sync-extension.sh"))}，再重启 pi` };
  return { synced: true, text: `扩展已同步（md5 ${want.slice(0, 8)}…）` };
}

/** relay 的 /healthz 在 viewer 端口上：地址里写了端口就换成 viewer 端口（缺省 7002），没写（wss 反代）就同源 */
function healthUrl(relay, env) {
  const u = new URL(relay);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  if (u.port) u.port = String(Number(env.PI_REMOTE_VIEWER_PORT) > 0 ? Number(env.PI_REMOTE_VIEWER_PORT) : 7002);
  u.pathname = "/healthz";
  u.search = "";
  u.hash = "";
  return u.toString();
}

async function relayHealth(ctx, relay) {
  let url;
  try {
    url = healthUrl(relay, ctx.env);
  } catch {
    return { ok: false, error: "relay 地址不对：" + relay };
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, url, error: "HTTP " + res.status };
    return { ok: true, url, data: await res.json() };
  } catch (e) {
    const why = e && e.name === "TimeoutError" ? "3 秒没有回应" : (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || String(e);
    return { ok: false, url, error: why };
  }
}

/** 本机身份钥（阶段 1）：钥文件在且完好才返回钥对象；没有/损坏都返回 null（doctor 另有 attach 侧的损坏提示口径，这里只认「能不能用钥登录」） */
function deviceKeysOf(ctx) {
  try {
    return attach.loadDeviceKeys(attach.deviceKeyFilePath(ctx.envPath, { env: ctx.env }));
  } catch {
    return null;
  }
}

/** 拿 .env 里的身份向 relay 认一次证就断开：不登记窗口，不影响已经连着的窗口和扩展。
 * 有身份钥且已配对时走挑战-签名（钥设备按设计停用令牌，拿令牌去探只会换回拒绝）。 */
function probeAuth(ctx, cfg, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let WS = ctx.WebSocketImpl;
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
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws && ws.close();
      } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, code: "timeout", error: "relay 没有回应鉴权" }), timeoutMs);
    try {
      ws = new WS(cfg.relay);
    } catch (e) {
      finish({ ok: false, code: "offline", error: (e && e.message) || String(e) });
      return;
    }
    const keys = deviceKeysOf(ctx);
    const keyFrame = keys && cfg.deviceId ? attach.attachKeyAuthFrame({ deviceId: cfg.deviceId, keys, platform: ctx.platform }) : null;
    const onOpen = () => {
      try {
        ws.send(JSON.stringify(keyFrame || attach.attachAuthFrame({ token: cfg.token, deviceId: cfg.deviceId, deviceToken: cfg.deviceToken, platform: ctx.platform })));
      } catch (e) {
        finish({ ok: false, code: "offline", error: (e && e.message) || String(e) });
      }
    };
    const onMessage = (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data && data.data !== undefined ? data.data : data));
      } catch {
        return;
      }
      if (!msg) return;
      if (msg.type === "auth_challenge" && keyFrame) {
        try {
          ws.send(JSON.stringify({ type: "auth_response", sig: attach.signAuthResponse(keys, cfg.deviceId, msg.nonce, keyFrame.clientNonce) }));
        } catch (e) {
          finish({ ok: false, code: "auth_failed", error: "本机钥签名失败：" + ((e && e.message) || String(e)) });
        }
        return;
      }
      if (msg.type !== "auth_result") return;
      finish(msg.ok ? { ok: true, auth: msg.auth || null } : { ok: false, code: msg.code || "auth_failed", error: msg.error || "" });
    };
    const onClose = () => finish({ ok: false, code: "offline", error: "连接被关闭" });
    if (typeof ws.on === "function") {
      ws.on("open", onOpen);
      ws.on("message", onMessage);
      ws.on("close", onClose);
      ws.on("error", (e) => finish({ ok: false, code: "offline", error: (e && (e.code || e.message)) || "连不上" }));
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
function blockRoot(ctx) {
  if (ctx.uid !== 0) return false;
  if (String(readEnvFile(ctx.envPath).PI_REMOTE_ALLOW_ROOT || ctx.env.PI_REMOTE_ALLOW_ROOT || "") === "1") return false;
  ctx.err(
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
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) return { error: "--projects 至少给一个目录（多个用 ; 分隔）" };
  const out = [];
  for (const p of list) {
    if (/[\0\r\n]/.test(p)) return { error: "白名单路径不能含换行" };
    if (!path.isAbsolute(p)) return { error: `白名单要写绝对路径：${p}` };
    if (!isDir(p)) return { error: `目录不存在：${p}` };
    out.push(p.length > 1 ? p.replace(/\/+$/, "") : p);
  }
  return { list: out };
}

function validRelay(v) {
  return /^wss?:\/\/\S+$/.test(String(v));
}

function cmdInit(ctx, o = {}) {
  if (blockRoot(ctx)) return 2;
  let projects = null;
  if (o.projects != null) {
    const parsed = parseProjects(o.projects);
    if (parsed.error) {
      ctx.err(parsed.error);
      return 2;
    }
    projects = parsed.list;
  }
  if (o.relay != null && !validRelay(o.relay)) {
    ctx.err("--relay 需要 ws:// 或 wss:// 地址");
    return 2;
  }
  if (o.name != null && (!String(o.name).trim() || /[\0\r\n]/.test(o.name))) {
    ctx.err("--name 不能为空，也不能换行");
    return 2;
  }
  const fresh = !fs.existsSync(ctx.envPath);
  if (fresh) {
    const example = path.join(ctx.kit, ".env.example");
    const text = fs.existsSync(example) ? fs.readFileSync(example, "utf8") : "";
    fs.writeFileSync(ctx.envPath, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  const file = readEnvFile(ctx.envPath);
  const empty = (key) => !String(file[key] || "").trim();
  const vars = {};
  if (o.relay) vars.PI_REMOTE_RELAY = o.relay;
  else if (empty("PI_REMOTE_RELAY")) vars.PI_REMOTE_RELAY = LOOPBACK_RELAY;
  // 模板里的占位 token 会让扩展拿 change-me 去登录：服务器上只用配对换来的设备令牌
  if (String(file.PI_REMOTE_TOKEN || "").trim() === "change-me") vars.PI_REMOTE_TOKEN = "";
  if (fresh) vars.PI_REMOTE_LABEL = "";
  if (o.name) vars.PI_REMOTE_DEVICE_NAME = String(o.name).trim();
  if (projects) vars.PI_REMOTE_PROJECTS = projects.join(";");
  if (empty("PI_REMOTE_LAUNCHER")) vars.PI_REMOTE_LAUNCHER = "tmux";
  // tmux 拉起的 pi 拿到的 PATH 不一定有 ~/.local/bin：找到了就写死绝对路径
  if (empty("PI_REMOTE_PI_BIN")) {
    const pi = findPi(ctx, "");
    if (pi) vars.PI_REMOTE_PI_BIN = pi.path;
  }
  if (Object.keys(vars).length) attach.writeEnvVars(ctx.envPath, vars);
  fs.chmodSync(ctx.envPath, 0o600);

  const { cfg, pick } = settings(ctx);
  ctx.out(`${fresh ? "已生成" : "已补全"} ${tilde(ctx, ctx.envPath)}（权限 600）`);
  ctx.out(`  PI_REMOTE_RELAY       = ${cfg.relay}`);
  ctx.out(`  PI_REMOTE_DEVICE_NAME = ${cfg.deviceName}`);
  ctx.out(`  PI_REMOTE_PROJECTS    = ${cfg.projects.map(displayPathOf).join(";") || "（空：网页上不能新建会话，用 --projects 设）"}`);
  ctx.out(`  PI_REMOTE_PI_BIN      = ${displayPathOf(pick("PI_REMOTE_PI_BIN")) || "（没找到 pi：先装 pi，再跑一次 init）"}`);
  ctx.out(`  设备凭据              = ${cfg.deviceToken ? "已配对（设备令牌）" : deviceKeysOf(ctx) ? "已配对（身份钥）" : "未配对"}`);
  if (!cfg.deviceToken && !deviceKeysOf(ctx)) ctx.out(`下一步：网页「设备」→「添加设备」拿配对码，然后 ${hint(ctx, "pair XXXX-XXXX")}`);
  return 0;
}

async function cmdPair(ctx, o = {}) {
  if (blockRoot(ctx)) return 2;
  let code;
  try {
    code = attach.normalizePairCode(o.code);
  } catch (e) {
    ctx.err(e.message);
    return 2;
  }
  if (o.relay != null && !validRelay(o.relay)) {
    ctx.err("--relay 需要 ws:// 或 wss:// 地址");
    return 2;
  }
  if (!fs.existsSync(ctx.envPath)) {
    const rc = cmdInit(ctx, {});
    if (rc) return rc;
  }
  const { cfg } = settings(ctx);
  const relay = o.relay || cfg.relay || LOOPBACK_RELAY;
  const rc = await attach.pairMain({ pair: code, relay }, ctx.envPath, {
    env: ctx.env,
    platform: ctx.platform,
    writeOut: ctx.out,
    writeErr: ctx.err,
    WebSocketImpl: ctx.WebSocketImpl,
    timeoutMs: ctx.pairTimeoutMs,
  });
  try {
    fs.chmodSync(ctx.envPath, 0o600);
  } catch {}
  if (rc) return rc;
  if (hasSession(ctx, ATTACH_SESSION)) ctx.out(`连接窗口还拿着旧身份，重开一次：${hint(ctx, "down")} && ${hint(ctx, "up")}`);
  else ctx.out(`打开连接窗口：${hint(ctx, "up")}`);
  return 0;
}

function windowOpen(w) {
  return !!(w && !w.broken && w.alive);
}

function describeWindow(ctx, w, inTmux) {
  if (!windowOpen(w)) {
    if (inTmux) return `连接窗口的 tmux 会话 ${ATTACH_SESSION} 在，但还没连上 relay（tmux attach -t ${ATTACH_SESSION} 看状态）`;
    return w ? "连接窗口没开（状态文件是上次残留的，下次 up 会清掉）" : "连接窗口没开";
  }
  const where = inTmux ? `tmux 会话 ${ATTACH_SESSION}` : `不在 tmux 里，pid ${w.pid}：到它的终端里 Ctrl+C 关闭`;
  return `连接窗口开着（${where}），到 ${fmtTime(w.expiresAt)} 自动关闭（还剩 ${fmtLeft(w.expiresAt - ctx.now())}）`;
}

/** 连接窗口自己的退出码落盘位置；device.sh up 拉起时注入给 attach.cjs */
function attachExitFile(ctx) {
  return attach.exitCodePath(ATTACH_SESSION, ctx.home);
}

async function waitWindowUp(ctx, cfg, before, hours, dirs) {
  const deadline = ctx.now() + ctx.upWaitMs;
  for (;;) {
    const w = readWindow(ctx);
    // attach 认证通过才写状态文件：文件是这次开的（不是开之前就在的那份）、进程活着、设备对得上，才算窗口真的开了
    const fresh = w && (!before || w.pid !== before.pid || w.startedAt !== before.startedAt);
    if (windowOpen(w) && fresh && w.deviceId === cfg.deviceId) {
      ctx.out(`连接窗口已打开（tmux 会话 ${ATTACH_SESSION}），到 ${fmtTime(w.expiresAt)} 自动关闭（--max-hours ${hours}）`);
      if (dirs.length) ctx.out(`  窗口拿到会话列表后在 tmux 里拉起：${dirs.map((d) => tilde(ctx, d)).join("  ")}（${hint(ctx, "sessions")} 查看）`);
      ctx.out(`  看状态：tmux attach -t ${ATTACH_SESSION}（Ctrl+B 再按 D 离开，窗口不关）`);
      ctx.out(`  关闭：${hint(ctx, "down")}`);
      return 0;
    }
    const panes = sessionPanes(ctx, ATTACH_SESSION);
    if (!panes) {
      // 会话已经整个收掉时窗格字段也没了：读 attach 自己的落盘码再报
      const code = attach.readExitCode(ATTACH_SESSION, ctx.home);
      ctx.err(`连接窗口刚开就退出了${code == null ? "" : `（退出码 ${code}）`}。在前台跑一次看原因：${tilde(ctx, path.join(ctx.kit, "deploy", "attach.sh"))}`);
      removeQuiet(attachExitFile(ctx));
      return 1;
    }
    const dead = panes.find((p) => p.dead);
    if (dead) {
      const lines = capturePane(ctx, ATTACH_SESSION);
      runTmux(ctx, ["kill-session", "-t", "=" + ATTACH_SESSION]);
      // 窗格字段优先；tmux 3.4 丢字段时读 attach 自己落盘的退出码
      const code = dead.status == null ? attach.readExitCode(ATTACH_SESSION, ctx.home) : dead.status;
      ctx.err(`连接窗口退出了（退出码 ${code == null ? "?" : code}）：`);
      for (const line of lines) ctx.err("  " + line);
      removeQuiet(attachExitFile(ctx));
      return 1;
    }
    if (ctx.now() >= deadline) {
      ctx.err(`连接窗口在 tmux 里跑着，但 ${Math.round(ctx.upWaitMs / 1000)} 秒内没连上 relay（${cfg.relay}），它会一直重连。`);
      ctx.err(`  看状态：tmux attach -t ${ATTACH_SESSION}；relay 体检：${hint(ctx, "doctor")}`);
      return 1;
    }
    await ctx.sleep(100);
  }
}

async function cmdUp(ctx, o = {}) {
  if (blockRoot(ctx)) return 2;
  const { cfg } = settings(ctx);
  if (!cfg.deviceId || !cfg.relay || (!cfg.deviceToken && !cfg.token && !deviceKeysOf(ctx))) {
    ctx.err(`还没配对：网页「设备」→「添加设备」拿配对码，然后 ${hint(ctx, "pair XXXX-XXXX")}`);
    return 1;
  }
  const hours = o.maxHours == null ? DEFAULT_HOURS : Number(o.maxHours);
  if (!Number.isFinite(hours) || hours <= 0) {
    ctx.err("--max-hours 需要正数（小时）");
    return 2;
  }
  const dirs = [];
  for (const d of o.dirs || []) {
    // attach 在套件目录里跑：相对路径要按调用方的目录解开
    const abs = path.resolve(ctx.cwd, d);
    if (/[\0\r\n]/.test(abs) || !isDir(abs)) {
      ctx.err("目录不存在：" + abs);
      return 2;
    }
    dirs.push(abs);
  }
  const tv = tmuxVersion(ctx);
  if (!tv) {
    ctx.err("找不到 tmux：" + attach.tmuxInstallHint("linux", { exists: fs.existsSync }));
    return 1;
  }
  if (hasSession(ctx, ATTACH_SESSION)) {
    const panes = sessionPanes(ctx, ATTACH_SESSION) || [];
    if (panes.length && panes.every((p) => p.dead)) {
      // 上次 up 失败留下的现场（等待期间被 Ctrl+C 打断，没来得及收）：收掉重开
      runTmux(ctx, ["kill-session", "-t", "=" + ATTACH_SESSION]);
      removeQuiet(attachExitFile(ctx));
    } else {
      ctx.out(describeWindow(ctx, readWindow(ctx), true));
      if (dirs.length) ctx.out(`窗口已经开着，目录参数没用上：用 ${hint(ctx, "start <目录>")} 起 pi，或在网页上新建`);
      return 0;
    }
  }
  const before = readWindow(ctx);
  if (windowOpen(before)) {
    // 别处（前台终端）开着的窗口：再开一个会把它顶下线，让用户自己决定
    ctx.err(`${describeWindow(ctx, before, false)}。先关掉它再 up`);
    return 1;
  }
  const ext = extensionState(ctx);
  if (!ext.synced) ctx.out("[warn] " + ext.text);
  // 窗口自己的退出码也落盘：tmux 3.4 丢 #{pane_dead_status} 时还能报出真实原因
  const exitFile = attachExitFile(ctx);
  removeQuiet(exitFile);
  const args = [
    "new-session", "-d", "-s", ATTACH_SESSION, "-c", ctx.kit,
    "/usr/bin/env", `PI_REMOTE_EXIT_FILE=${exitFile}`,
    ctx.nodeBin, ctx.attachCjs, "--max-hours", String(hours), ...dirs,
  ].map(tmuxArg);
  // 窗口当场失败（令牌被撤销、缺配置）时窗格留着，下面把原因抓出来再收掉
  if (tv.keepFailed) args.push(";", "set-option", "-w", "-t", `=${ATTACH_SESSION}:`, "remain-on-exit", "failed");
  const r = runTmux(ctx, args);
  if (r.status !== 0) {
    ctx.err("tmux 没能开会话：" + (r.stderr || "退出码 " + r.status));
    return 1;
  }
  return waitWindowUp(ctx, cfg, before, hours, dirs);
}

async function cmdDown(ctx) {
  if (!hasSession(ctx, ATTACH_SESSION)) {
    const w = readWindow(ctx);
    if (w && w.alive) {
      ctx.err(`连接窗口不是 device.sh 开的（pid ${w.pid}）：到它的终端里 Ctrl+C，或 kill ${w.pid}`);
      return 1;
    }
    if (w) {
      removeQuiet(ctx.stateFile);
      removeQuiet(attachExitFile(ctx));
      ctx.out("清掉了上次残留的窗口状态文件");
    } else {
      removeQuiet(attachExitFile(ctx));
    }
    ctx.out("连接窗口没有在运行");
    return 0;
  }
  // kill-session 给窗格进程发 SIGHUP：attach 照 Ctrl+C 的路子收尾（删状态文件、断开）
  const r = runTmux(ctx, ["kill-session", "-t", "=" + ATTACH_SESSION]);
  if (r.status !== 0 && hasSession(ctx, ATTACH_SESSION)) {
    ctx.err("tmux 关不掉会话：" + (r.stderr || "退出码 " + r.status));
    return 1;
  }
  const deadline = ctx.now() + ctx.downWaitMs;
  let w = readWindow(ctx);
  while (w && w.alive && ctx.now() < deadline) {
    await ctx.sleep(100);
    w = readWindow(ctx);
  }
  if (w && w.alive) {
    ctx.err(`窗口进程 ${w.pid} 还没退出：kill ${w.pid}`);
    return 1;
  }
  if (w) removeQuiet(ctx.stateFile);
  removeQuiet(attachExitFile(ctx));
  ctx.out("连接窗口已关闭：扩展随即断开 relay，已经拉起的 pi 照常运行（" + hint(ctx, "sessions") + " 查看）");
  return 0;
}

function cmdStart(ctx, o = {}) {
  if (blockRoot(ctx)) return 2;
  if (!o.dir) {
    ctx.err("用法：" + hint(ctx, "start <目录> [--session <会话 id 或文件>]"));
    return 2;
  }
  const abs = path.resolve(ctx.cwd, o.dir);
  if (/[\0\r\n]/.test(abs) || !isDir(abs)) {
    ctx.err("目录不存在：" + abs);
    return 2;
  }
  if (o.session != null && (!String(o.session).trim() || /[\0\r\n]/.test(o.session))) {
    ctx.err("--session 需要会话 id 或会话文件路径");
    return 2;
  }
  const tv = tmuxVersion(ctx);
  if (!tv) {
    ctx.err("找不到 tmux：" + attach.tmuxInstallHint("linux", { exists: fs.existsSync }));
    return 1;
  }
  if (!fs.existsSync(ctx.startPi)) {
    ctx.err("套件里没有 " + ctx.startPi);
    return 1;
  }
  let cwd = abs;
  try {
    cwd = fs.realpathSync.native(abs);
  } catch {}
  // 和网页拉起同一个形状（attach.cjs 的 tmux 规则）：会话名、参数转义、失败留现场都一样
  const spec = attach.buildSpawnSpec({
    cwd,
    sessionPath: o.session ? String(o.session).trim() : null,
    startPi: ctx.startPi,
    platform: ctx.platform,
    launcher: "tmux",
    keepFailed: tv.keepFailed,
    // 和网页拉起同一契约：start-pi.sh 把退出码落盘，sessions / clean 读不到窗格字段时回落
    exitHome: ctx.home,
    // Same propagation contract as attach-launched pi: the pane gets the kit
    // .env's resolved config, not whatever env the tmux server happened to have.
    childEnv: attach.piChildEnv(ctx.envPath, ctx.env),
  });
  const name = spec.tmuxSession;
  const r = runTmux(ctx, spec.args);
  if (r.status !== 0) {
    ctx.err("tmux 没能开会话：" + (r.stderr || "退出码 " + r.status));
    return 1;
  }
  ctx.out(`已在 tmux 会话 ${name} 里起 pi：tmux attach -t ${name}`);
  const { cfg } = settings(ctx);
  if (!attach.cwdAllowed(cwd, cfg.projects, ctx.platform)) ctx.out("[warn] 这个目录不在 PI_REMOTE_PROJECTS 里：网页上看得到这份 pi，但不能从网页重新拉起它");
  if (!windowOpen(readWindow(ctx))) ctx.out(`[warn] 连接窗口没开：这份 pi 不会出现在网页上，${hint(ctx, "up")} 之后才连 relay`);
  return 0;
}

function sessionLine(ctx, s) {
  const state = s.dead ? `已退出（退出码 ${s.status == null ? "?" : s.status}）` : "运行中";
  return `  ${s.name}  ${tilde(ctx, s.cwd)}  ${state}`;
}

function cmdSessions(ctx) {
  const list = piSessions(ctx);
  if (!list.length) {
    ctx.out("没有 pi 的 tmux 会话");
    return 0;
  }
  ctx.out("pi 会话（tmux attach -t <名字> 进去，Ctrl+B 再按 D 离开）：");
  for (const s of list) ctx.out(sessionLine(ctx, s));
  if (list.some((s) => s.dead)) ctx.out(`已退出的会话留着现场，看完用 ${hint(ctx, "clean")} 收掉`);
  return 0;
}

function cmdClean(ctx) {
  const dead = piSessions(ctx).filter((s) => s.dead);
  for (const s of dead) {
    runTmux(ctx, ["kill-session", "-t", "=" + s.name]);
    attach.removeExitCode(s.name, ctx.home);
  }
  ctx.out(dead.length ? `收掉了 ${dead.length} 个已退出的 pi 会话：${dead.map((s) => s.name).join(" ")}` : "没有已退出的 pi 会话");
  return 0;
}

async function cmdStatus(ctx) {
  const { cfg } = settings(ctx);
  ctx.out(describeWindow(ctx, readWindow(ctx), hasSession(ctx, ATTACH_SESSION)));
  const who = cfg.deviceId ? `${cfg.deviceName}（${cfg.deviceId}）` : `${cfg.deviceName}（没有设备编号）`;
  ctx.out(`设备：${who} · ${cfg.deviceToken || deviceKeysOf(ctx) ? "已配对" : "未配对"}`);
  const relay = cfg.relay || LOOPBACK_RELAY;
  const h = await relayHealth(ctx, relay);
  if (h.ok && h.data) {
    const d = h.data;
    ctx.out(`relay：${relay} · proto ${d.proto} · ${d.version || "?"} · 在线设备 ${d.devices ? d.devices.online : "?"} · 在线会话 ${d.rooms ? d.rooms.online : "?"}`);
  } else {
    ctx.out(`relay：${relay} · 健康检查失败（${h.error}）`);
  }
  const list = piSessions(ctx);
  if (!list.length) ctx.out("pi 会话：无");
  else {
    ctx.out("pi 会话：");
    for (const s of list) ctx.out(sessionLine(ctx, s));
  }
  return 0;
}

async function cmdDoctor(ctx) {
  let fails = 0;
  const ok = (t) => ctx.out("[ok]   " + t);
  const warn = (t) => ctx.out("[warn] " + t);
  const fail = (t) => {
    fails++;
    ctx.out("[fail] " + t);
  };
  const { cfg, pick } = settings(ctx);

  if (ctx.uid === 0) {
    if (String(pick("PI_REMOTE_ALLOW_ROOT")) === "1") warn("以 root 运行（PI_REMOTE_ALLOW_ROOT=1）：网页能让 pi 以 root 执行命令");
    else fail("以 root 运行：服务器上的 pi 要用普通用户跑（见 deploy/README.md §3）");
  } else ok(`运行用户 ${ctx.user || "uid " + ctx.uid}`);

  if (nodeVersionOk()) ok(`node ${process.versions.node}`);
  else fail(`node ${process.versions.node} 太旧：要 ≥ ${MIN_NODE.join(".")}（扩展用内置 WebSocket）`);

  const tv = tmuxVersion(ctx);
  if (!tv) fail("找不到 tmux：" + attach.tmuxInstallHint("linux", { exists: fs.existsSync }));
  else if (!tv.keepFailed) warn(`${tv.text}：低于 3.2，pi 启动失败时 tmux 不保留现场`);
  else ok(tv.text);

  const pinned = pick("PI_REMOTE_PI_BIN");
  const pi = findPi(ctx, pinned);
  if (!pi) fail("找不到 pi：npm i -g --prefix ~/.local @earendil-works/pi-coding-agent，再 " + hint(ctx, "init"));
  else if (!pi.ok) {
    // 写错路径和没有执行位是两种排障：一律说「不可执行」会让人以为是权限问题
    const reason = fs.existsSync(pi.path) ? "没有可执行权限（或不是可执行文件）" : "路径不存在";
    fail(`PI_REMOTE_PI_BIN=${pi.path} ${reason}`);
  }
  else {
    const v = spawnSync(pi.path, ["--version"], { encoding: "utf8", timeout: 20000, env: { ...ctx.env, PI_OFFLINE: "1" } });
    const ver = String(v.stdout || "").trim().split("\n")[0];
    if (v.status === 0 && ver) ok(`pi ${ver}（${tilde(ctx, pi.path)}）`);
    else warn(`pi 在 ${tilde(ctx, pi.path)}，但 pi --version 没有正常返回`);
    if (!pinned && pi.from !== "PATH") warn(`pi 不在 PATH 里：${hint(ctx, "init")} 会把它写进 PI_REMOTE_PI_BIN`);
  }

  try {
    require.resolve("ws", { paths: [path.join(ctx.kit, "deploy")] });
    ok("依赖 ws 已装");
  } catch {
    fail(`缺依赖 ws：cd ${tilde(ctx, ctx.kit)} && npm ci --omit=dev`);
  }

  if (!fs.existsSync(ctx.envPath)) fail(`没有 ${tilde(ctx, ctx.envPath)}：${hint(ctx, "init --projects <目录>")}`);
  else {
    const mode = fs.statSync(ctx.envPath).mode & 0o777;
    if (mode & 0o077) warn(`.env 权限 ${mode.toString(8)}：里面有设备令牌，chmod 600 ${tilde(ctx, ctx.envPath)}`);
    else ok(".env 权限 600");
    let host = "";
    try {
      host = new URL(cfg.relay).hostname;
    } catch {}
    if (!cfg.relay) fail("PI_REMOTE_RELAY 没配");
    else if (!validRelay(cfg.relay) || !host) fail(`PI_REMOTE_RELAY 不对：${cfg.relay}`);
    else if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]") ok(`relay ${cfg.relay}（回环，令牌不出本机）`);
    else warn(`relay ${cfg.relay}：relay 就在这台服务器上时改成 ${LOOPBACK_RELAY}，令牌不走公网`);
    if (!cfg.projects.length) warn(`PI_REMOTE_PROJECTS 是空的：网页上不能新建会话（${hint(ctx, "init --projects <目录>")}）`);
    else {
      const missing = cfg.projects.filter((p) => !isDir(p));
      if (missing.length) warn("白名单里这些目录不存在：" + missing.map(displayPathOf).join(" "));
      else ok(`白名单 ${cfg.projects.length} 个目录`);
    }
  }

  let paired = false;
  let pairKind = "";
  const devKeys = deviceKeysOf(ctx);
  if (cfg.deviceId && cfg.deviceToken) {
    paired = true;
    pairKind = "token";
    ok(`已配对：设备 ${cfg.deviceId}`);
  } else if (cfg.deviceId && devKeys) {
    paired = true;
    pairKind = "key";
    ok(`已配对（身份钥）：设备 ${cfg.deviceId} · 指纹 ${attach.formatFingerprint(attach.keyFingerprint(devKeys.sign.pub))}`);
  } else if (cfg.deviceId && cfg.token) warn("只有共享令牌（PI_REMOTE_TOKEN），没配对：网页「添加设备」后 " + hint(ctx, "pair XXXX-XXXX"));
  else fail("还没配对：网页「设备」→「添加设备」拿配对码，然后 " + hint(ctx, "pair XXXX-XXXX"));

  const ext = extensionState(ctx);
  if (ext.synced) ok(ext.text);
  else fail(ext.text);

  const relay = cfg.relay || LOOPBACK_RELAY;
  const h = await relayHealth(ctx, relay);
  if (h.ok && h.data) {
    if (Number(h.data.proto) >= 4) ok(`relay 健康（proto ${h.data.proto}，${h.data.version || "?"}）`);
    else fail(`relay 协议版本 ${h.data.proto}：设备令牌要 v4 relay`);
  } else fail(`relay 健康检查失败：${h.url || relay}（${h.error}）`);

  if (paired && h.ok) {
    const a = await probeAuth(ctx, cfg);
    if (a.ok && a.auth === pairKind) ok(pairKind === "key" ? "设备身份钥有效" : "设备令牌有效");
    else if (a.ok) warn(`relay 按 ${a.auth || "旧"} 方式认了这台设备，不是${pairKind === "key" ? "身份钥" : "设备令牌"}`);
    else if (a.code === "device_revoked") fail("这台设备在网页上被撤销了：重新配对（" + hint(ctx, "pair XXXX-XXXX") + "）");
    else fail(`${pairKind === "key" ? "设备身份钥" : "设备令牌"}没通过（${a.code}${a.error ? "：" + a.error : ""}）：重新配对`);
  }

  const w = readWindow(ctx);
  const text = describeWindow(ctx, w, tv ? hasSession(ctx, ATTACH_SESSION) : false);
  if (windowOpen(w)) ok(text);
  else warn(`${text}：${hint(ctx, "up")}`);

  const locale = attach.currentLocale(ctx.env);
  if (attach.localeIsUtf8(locale)) ok(`语言环境 ${locale}`);
  else {
    const injected = tmuxLocale(ctx);
    if (injected) warn(`语言环境 ${locale || "未设置"}：tmux 调用已注入 ${injected}（tmux 3.4 在非 UTF-8 下会净化制表符）`);
    else warn(`语言环境 ${locale || "未设置"}：本机没有可用的 UTF-8 locale，tmux 输出按兼容格式解析（会话列表仍可用，中文可能乱码）；建议生成/导出 C.UTF-8`);
  }

  ctx.out(fails ? `${fails} 项要处理` : "全部通过");
  return fails ? 1 : 0;
}

function cmdLogs(ctx, o = {}) {
  const n = o.lines == null ? 40 : Number(o.lines);
  if (!Number.isInteger(n) || n <= 0) {
    ctx.err("-n 需要正整数");
    return 2;
  }
  // start-pi.sh 把 .env 导出给 pi：扩展日志的位置以 .env 为准
  const file = settings(ctx).pick("PI_REMOTE_LOG") || ctx.logFile;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    ctx.out(`还没有扩展日志（${tilde(ctx, file)}）：pi 在连接窗口里跑起来后才有`);
    return 0;
  }
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines.slice(-n)) ctx.out(line);
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

function parseOpts(args, spec) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === "--") {
      out._.push(...args.slice(i + 1).map(String));
      break;
    }
    if (a.length > 1 && a.startsWith("-")) {
      const eq = a.indexOf("=");
      const flag = eq > 0 ? a.slice(0, eq) : a;
      const key = spec[flag];
      if (!key) throw new UsageError("未知参数：" + flag);
      const val = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (val === undefined) throw new UsageError(flag + " 需要一个值");
      out[key] = String(val);
    } else out._.push(a);
  }
  return out;
}

function onlyPositional(o, max, usage) {
  if (o._.length > max) throw new UsageError("多余的参数：" + o._.slice(max).join(" ") + "\n用法：" + usage);
}

async function main(argv, ctx = makeContext()) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "init": {
        const o = parseOpts(rest, { "--projects": "projects", "--name": "name", "--relay": "relay" });
        onlyPositional(o, 0, "device.sh init [--projects …] [--name …] [--relay …]");
        return cmdInit(ctx, o);
      }
      case "pair": {
        const o = parseOpts(rest, { "--relay": "relay" });
        onlyPositional(o, 1, "device.sh pair XXXX-XXXX [--relay ws://…]");
        return await cmdPair(ctx, { code: o._[0], relay: o.relay });
      }
      case "up": {
        const o = parseOpts(rest, { "--max-hours": "maxHours" });
        return await cmdUp(ctx, { maxHours: o.maxHours, dirs: o._ });
      }
      case "down":
        onlyPositional(parseOpts(rest, {}), 0, "device.sh down");
        return await cmdDown(ctx);
      case "start": {
        const o = parseOpts(rest, { "--session": "session" });
        onlyPositional(o, 1, "device.sh start <目录> [--session …]");
        return cmdStart(ctx, { dir: o._[0], session: o.session });
      }
      case "status":
        onlyPositional(parseOpts(rest, {}), 0, "device.sh status");
        return await cmdStatus(ctx);
      case "sessions":
      case "ls":
        onlyPositional(parseOpts(rest, {}), 0, "device.sh sessions");
        return cmdSessions(ctx);
      case "clean":
        onlyPositional(parseOpts(rest, {}), 0, "device.sh clean");
        return cmdClean(ctx);
      case "doctor":
        onlyPositional(parseOpts(rest, {}), 0, "device.sh doctor");
        return await cmdDoctor(ctx);
      case "logs": {
        const o = parseOpts(rest, { "-n": "lines", "--lines": "lines" });
        onlyPositional(o, 0, "device.sh logs [-n 40]");
        return cmdLogs(ctx, o);
      }
      case undefined:
      case "help":
      case "-h":
      case "--help":
        ctx.out(HELP);
        return 0;
      default:
        ctx.err(`未知命令：${cmd}\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.err(e.message);
      return 2;
    }
    throw e;
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
    (e) => {
      console.error(e && e.stack ? e.stack : e);
      process.exitCode = 1;
    },
  );
}
