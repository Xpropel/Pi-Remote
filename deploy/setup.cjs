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

const ROOT = path.resolve(__dirname, "..");
const examplePath = path.join(ROOT, ".env.example");
const envPath = path.join(ROOT, ".env");

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
