/**
 * 把 protocol/v4.json（唯一事实源）同步到需要随包部署的副本：
 *   relay/protocol.json                  relay 部署只带 relay/ 目录
 *   extension/pi-remote-sync.ts 的 PROTOCOL 块   扩展是单文件安装，不能在运行时 require 仓库里的文件
 * 用法：node protocol/sync.cjs          写入副本
 *       node protocol/sync.cjs --check  只检查，不一致时退出码 1（test/protocol.test.js 用）
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(__dirname, "v4.json");
const RELAY_COPY = path.join(ROOT, "relay", "protocol.json");
const EXTENSION = path.join(ROOT, "extension", "pi-remote-sync.ts");
const BEGIN = "// @@PROTOCOL_BEGIN（由 protocol/sync.cjs 生成，勿手改）";
const END = "// @@PROTOCOL_END";

function canonical() {
  return JSON.stringify(JSON.parse(fs.readFileSync(SOURCE, "utf8")), null, 2) + "\n";
}

function extensionBlock(json) {
  return `${BEGIN}\nconst PROTOCOL = ${json.trimEnd()} as const;\n${END}`;
}

/**
 * 找 PROTOCOL 块的范围。标记缺失/重复/顺序颠倒都算损坏：调用方必须报错而不是跳过，
 * 否则扩展里的协议快照会永远停在旧版本，--check 却显示绿色。
 */
function blockRange(text) {
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a < 0 && b < 0) return { error: `找不到 ${BEGIN} / ${END} 标记` };
  if (a < 0) return { error: `找不到 ${BEGIN} 标记（只有 ${END}）` };
  if (b < 0) return { error: `找不到 ${END} 标记` };
  if (b < a + BEGIN.length) return { error: `${END} 标记在 ${BEGIN} 之前` };
  const extraBegin = text.indexOf(BEGIN, a + BEGIN.length);
  const extraEnd = text.indexOf(END, b + END.length);
  if (extraBegin >= 0 || extraEnd >= 0) return { error: "PROTOCOL 块标记重复" };
  return { begin: a, end: b };
}

function replaceBlock(text, block) {
  const range = blockRange(text);
  if (range.error) throw new Error(`扩展 PROTOCOL 块标记损坏：${range.error}`);
  return text.slice(0, range.begin) + block + text.slice(range.end + END.length);
}

function plan() {
  const json = canonical();
  const out = [{ file: RELAY_COPY, want: json, have: fs.existsSync(RELAY_COPY) ? fs.readFileSync(RELAY_COPY, "utf8") : null }];
  if (fs.existsSync(EXTENSION)) {
    const have = fs.readFileSync(EXTENSION, "utf8");
    const want = replaceBlock(have, extensionBlock(json));
    out.push({ file: EXTENSION, want, have });
  }
  return out;
}

if (require.main === module) {
  const check = process.argv.includes("--check");
  let items;
  try {
    items = plan();
  } catch (e) {
    // 标记损坏时写入模式也不能写了一半再报错：plan() 在任何写盘之前抛出。
    console.error("协议同步失败：" + (e && e.message ? e.message : e));
    process.exit(1);
  }
  let stale = 0;
  for (const item of items) {
    if (item.have === item.want) continue;
    stale += 1;
    if (check) console.error("协议副本过期：" + path.relative(ROOT, item.file));
    else {
      fs.writeFileSync(item.file, item.want, "utf8");
      console.log("已同步 " + path.relative(ROOT, item.file));
    }
  }
  if (check && stale) process.exit(1);
  if (!check && !stale) console.log("协议副本已是最新");
}

module.exports = { plan, canonical, replaceBlock, blockRange, BEGIN, END };
