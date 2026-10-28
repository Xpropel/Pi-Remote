/**
 * 从 .env.example 生成本机 .env（Windows 由 deploy/start-pi.cmd、macOS / Linux 由 deploy/start-pi.sh 读取）：
 * relay 地址取命令行参数，local token 从 PI_REMOTE_LOCAL_TOKEN 环境变量或 relay/config.json 取
 * 可选的 PI_REMOTE_BROWSE_ROOTS（浏览根目录）与 PI_REMOTE_LIBRARY_RESCAN_MS（反扫间隔）
 * 只有注释模板，需要时手动在 .env 里加一行（setup 不会覆盖已有 .env）。
 * （默认空 = 必须显式给，仓库不内置任何凭证）；PI_REMOTE_PROJECTS 留空时填成本项目目录。
 * 用法：node deploy/setup.cjs [relay地址]
 *   例：node deploy/setup.cjs ws://<你的relay地址>:7001
 * 注意：relay 不内置默认 token（代码默认是空串，缺 token 会直接退出）；secret 用环境变量或
 * /etc/pi-remote.env 提供，仓库里没有任何凭证。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const examplePath = path.join(ROOT, ".env.example");
const envPath = path.join(ROOT, ".env");

/* 旧流程（模板生成 .env）整体收进 legacyMain：文件被 require 时不许有副作用
 * （单测要 import 下面的 --local 纯函数；直接执行才走 main 分发）。函数体保持原样未缩进。 */
function legacyMain() {
const relayCfgPath = path.join(ROOT, "relay", "config.json");
let localToken = process.env.PI_REMOTE_LOCAL_TOKEN || "";
if (fs.existsSync(relayCfgPath)) {
  // 老配置还在：以它为准（兼容升级路径）
  try {
    const relayCfg = JSON.parse(fs.readFileSync(relayCfgPath, "utf8"));
    if (relayCfg.localToken) localToken = relayCfg.localToken;
  } catch (e) {
    console.error("relay/config.json 解析失败（忽略，用默认 token）:", e.message);
  }
}

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const relayUrl = argv.find((arg) => !arg.startsWith("--")) || undefined;

// .env 里有设备编号、设备令牌、项目白名单、拉起方式：用模板整份覆盖会静默抹掉它们。
// 只允许"没有 .env"或显式 --force；想改 relay 地址直接编辑对应一行即可。
if (fs.existsSync(envPath) && !force) {
  console.error("已存在 " + envPath + "，setup 会用模板整份覆盖，已拒绝。");
  console.error("  只改 relay 地址：直接编辑 .env 里的 PI_REMOTE_RELAY=...");
  console.error("  确实要从模板重建（会丢设备编号/令牌/白名单）：加 --force");
  process.exit(1);
}
let text = fs.readFileSync(examplePath, "utf8").replace(/^\uFEFF/, "");
const relayLine = `PI_REMOTE_RELAY=${relayUrl || extractUrl(text) || "ws://127.0.0.1:7001"}`;
// 函数式替换：token 里的 $&、$1 之类不能被当成替换模式
text = text.replace(/^PI_REMOTE_RELAY=.*$/m, () => relayLine);
text = text.replace(/^PI_REMOTE_TOKEN=.*$/m, () => `PI_REMOTE_TOKEN=${localToken}`);
text = text.replace(/^PI_REMOTE_PROJECTS=[ \t]*$/m, () => `PI_REMOTE_PROJECTS=${ROOT}`);

// .env 里有 local token / 设备令牌：新建时只给本人读写（0600）。已有文件保留内容，
// 但权限必须收紧；失败要明确告警，不能静默留下同机其他用户可读的令牌。
fs.writeFileSync(envPath, text, { encoding: "utf8", mode: 0o600 });
try {
  fs.chmodSync(envPath, 0o600);
} catch (e) {
  console.error("警告：无法把 " + envPath + " 的权限收紧到 0600（里面有令牌）：" + (e && e.message ? e.message : e));
  console.error("  请手动执行 chmod 600 " + envPath + "。");
}
console.log(".env 已生成：");
console.log("  PI_REMOTE_RELAY =", (text.match(/^PI_REMOTE_RELAY=(.*)$/m) || [])[1]);
console.log("  PI_REMOTE_PROJECTS =", (text.match(/^PI_REMOTE_PROJECTS=(.*)$/m) || [])[1]);
console.log("  PI_REMOTE_BROWSE_ROOTS = 未设置（缺省只浏览家目录；设 off 关闭浏览，设分号分隔的目录放开）");
console.log("  PI_REMOTE_LIBRARY_RESCAN_MS = 未设置（缺省 30000ms，最小 5000）");
// token 不明文回显：终端输出会被截图/复制到 issue 里。只说明有没有配上。
if (localToken) {
  console.log("  PI_REMOTE_TOKEN = 已写入（" + localToken.length + " 字符，值不打印）");
} else {
  console.log("  PI_REMOTE_TOKEN = 空。用 PI_REMOTE_LOCAL_TOKEN=xxx node deploy/setup.cjs <relay地址> 生成，或手动编辑 .env");
}
if (process.platform === "win32") {
  console.log("下一步：node deploy\\attach.cjs --init 生成设备编号；启动 pi：deploy\\start-pi.cmd");
} else {
  console.log("下一步：deploy/attach.sh --init 生成设备编号；启动 pi：deploy/start-pi.sh");
}

function extractUrl(t) {
  const m = t.match(/^PI_REMOTE_RELAY=(.*)$/m);
  return m ? m[1].trim() : "";
}
} /* legacyMain 结束 */

/* ---------------- --local：免服务器模式一次初始化（设计 §2.3） ----------------
 * 一次生成两边：relay/config.json（本机 relay 的三令牌配置）+ 设备 .env（指向 ws://127.0.0.1:7001）。
 * 任一文件已存在就整体拒绝（不写一半）；--force 才重建，并明确警告令牌全轮换、要重新配对。
 * 令牌只报告「已生成」，永不回显全文（与旧流程同一口径）。
 */

/** 服务器显示名清洗（与 relay 的 cleanServerName 同口径：去控制符、截 64） */
function cleanLocalServerName(raw) {
  const value = String(raw == null ? "" : raw).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return value.slice(0, 64);
}

function randomToken(randomBytes = crypto.randomBytes) {
  return randomBytes(32).toString("base64url");
}

/** 本地 relay 的 config.json 内容（三令牌互不相同；tunnel 字段为 named tunnel 预留，本版只写 quick） */
function buildLocalRelayConfig({ root = ROOT, hostname = os.hostname(), randomBytes = crypto.randomBytes } = {}) {
  const tokens = new Set();
  while (tokens.size < 3) tokens.add(randomToken(randomBytes));
  const [localToken, viewerToken, adminToken] = [...tokens];
  return {
    localPort: 7001,
    viewerPort: 7002,
    localHost: "127.0.0.1",
    viewerHost: "0.0.0.0",
    localToken,
    viewerToken,
    adminToken,
    serverName: cleanLocalServerName(hostname),
    dataDir: path.join(root, "data", "rooms"),
    accountsDir: path.join(root, "data", "accounts"),
    // 隧道配置预留：本版只实现 mode:"quick"（免账号快速隧道，网址每次变）；
    // named tunnel（自有域名）将来在此加 mode:"named" 与 name/hostname 字段，本版不读不实现。
    tunnel: { mode: "quick" },
  };
}

function setupLocal(opts = {}) {
  const root = opts.root || ROOT;
  const force = opts.force === true;
  const out = opts.writeOut || ((line) => console.log(line));
  const err = opts.writeErr || ((line) => console.error(line));
  const configPath = path.join(root, "relay", "config.json");
  const localEnvPath = path.join(root, ".env");
  const localExamplePath = path.join(root, ".env.example");

  const existing = [];
  if (fs.existsSync(configPath)) existing.push(configPath);
  if (fs.existsSync(localEnvPath)) existing.push(localEnvPath);
  if (existing.length && !force) {
    err("免服务器模式初始化已拒绝：下列文件已存在，setup 不会覆盖：");
    for (const f of existing) err("  " + f);
    err("  只想改某一项：直接编辑对应文件；确实要整套重建（令牌全部轮换、已配对设备需要重新配对）：加 --force");
    return { code: 1, configPath, envPath: localEnvPath };
  }
  if (existing.length && force) {
    err("⚠️  --force 重建：relay 的三个令牌将全部轮换，之前配对/登录用的令牌立即失效，设备需要重新走 attach --link 配对。");
  }

  const config = buildLocalRelayConfig({ root, hostname: opts.hostname, randomBytes: opts.randomBytes });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch (e) {
    err("警告：无法把 " + configPath + " 的权限收紧到 0600（里面有三个令牌）：" + (e && e.message ? e.message : e));
  }

  // 设备 .env：复用模板整份生成（替换口径与旧流程一致），relay 固定回环、token 填刚生成的 localToken
  let text = fs.readFileSync(localExamplePath, "utf8").replace(/^\uFEFF/, "");
  text = text.replace(/^PI_REMOTE_RELAY=.*$/m, () => "PI_REMOTE_RELAY=ws://127.0.0.1:7001");
  const localToken = config.localToken;
  text = text.replace(/^PI_REMOTE_TOKEN=.*$/m, () => "PI_REMOTE_TOKEN=" + localToken);
  text = text.replace(/^PI_REMOTE_PROJECTS=[ \t]*$/m, () => `PI_REMOTE_PROJECTS=${root}`);
  fs.writeFileSync(localEnvPath, text, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(localEnvPath, 0o600);
  } catch (e) {
    err("警告：无法把 " + localEnvPath + " 的权限收紧到 0600（里面有令牌）：" + (e && e.message ? e.message : e));
  }

  out("免服务器（本地）模式已初始化：");
  out("  relay 配置 = " + configPath + "（权限 600；localToken / viewerToken / adminToken 三个令牌已随机生成，互不相同，不回显）");
  out("  设备 .env = " + localEnvPath + "（PI_REMOTE_RELAY=ws://127.0.0.1:7001，PI_REMOTE_TOKEN 已填本地令牌）");
  out("下一步：");
  out("  1) deploy/attach.sh --link   扫码把这台设备换成正式设备令牌（与服务器模式同一条正规路径）");
  out("  2) deploy/attach.sh          打开连接窗口（attach 会自己拉起本机 relay；窗口关掉整套就停）");
  out("  出门时想从公网访问：开窗口时加 --tunnel，或单独运行 deploy/attach.sh --share 只出示公网网址");
  return { code: 0, configPath, envPath: localEnvPath, config };
}

function main(argv) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes("--local")) {
    return setupLocal({ force: args.includes("--force") }).code;
  }
  legacyMain();
  return 0;
}

module.exports = { main, legacyMain, setupLocal, buildLocalRelayConfig, cleanLocalServerName };

if (require.main === module) {
  const code = main(process.argv.slice(2));
  if (code) process.exit(code);
}
