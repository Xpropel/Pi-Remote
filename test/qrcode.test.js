"use strict";
/**
 * deploy/qrcode.js（vendored qrcode-generator 1.4.4 + Pi-Remote 门面）的编码健全性：
 * 已知字符串的版本/尺寸稳定、定位图案结构正确、多次编码结果一致；
 * SVG / 终端半块两种渲染的形状（viewBox、静区、行宽）符合窗口与终端出示的预期。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const qr = require("../deploy/qrcode.js");

const SAMPLE = "https://example.com/#pair=K7Q4MX2P"; // 34 字节，Byte 模式 + 纠错 M 应落在版本 3（容量 42）

test("createQrMatrix：已知字符串版本与尺寸稳定，定位图案结构正确", () => {
  const m = qr.createQrMatrix(SAMPLE);
  assert.equal(m.version, 3);
  assert.equal(m.size, 29); // 17 + 4 * 3
  assert.equal(m.modules.length, 29);
  assert.ok(m.modules.every((row) => row.length === 29 && row.every((v) => typeof v === "boolean")));
  // 左上定位图案：外框深、内圈浅、核心深；分隔带浅
  assert.equal(m.modules[0][0], true);
  assert.equal(m.modules[0][6], true);
  assert.equal(m.modules[6][0], true);
  assert.equal(m.modules[1][1], false);
  assert.equal(m.modules[3][3], true);
  assert.equal(m.modules[7][0], false);
  assert.equal(m.modules[0][7], false);
  // 右上 / 左下定位图案的外角同样为深
  assert.equal(m.modules[0][m.size - 1], true);
  assert.equal(m.modules[m.size - 1][0], true);
  // 定时图案：第 6 行/列从 (8,6) 起深浅交替
  assert.equal(m.modules[6][8], true);
  assert.equal(m.modules[6][9], false);
  assert.equal(m.modules[8][6], true);
});

test("createQrMatrix：同一字符串多次编码结果逐模块一致；不同字符串结果不同", () => {
  const a = qr.createQrMatrix(SAMPLE);
  const b = qr.createQrMatrix(SAMPLE);
  assert.deepEqual(a.modules, b.modules);
  const c = qr.createQrMatrix(SAMPLE.replace("K7Q4", "K7Q5"));
  assert.notDeepEqual(c.modules, a.modules);
});

test("createQrMatrix：UTF-8 文本按字节编码（中文链接不截断成低 8 位）", () => {
  // 35 个 ASCII + 3 个汉字：按 UTF-8 是 44 字节 → 版本 4（V3-M 容量 42）；
  // 若按 charCode 低 8 位截断只有 38 字节，会错落到版本 3
  const m = qr.createQrMatrix("https://example.com/x#pair=K7Q4MX2P设备链");
  assert.equal(m.version, 4);
});

test("matrixToSvg：viewBox 含 4 模块静区，深色模块合并为 path", () => {
  const m = qr.createQrMatrix(SAMPLE);
  const svg = qr.matrixToSvg(m.modules);
  assert.match(svg, /viewBox="0 0 37 37"/); // 29 + 4*2
  assert.match(svg, /<rect width="37" height="37"/);
  assert.match(svg, /<path d="M/);
  const custom = qr.matrixToSvg(m.modules, { quiet: 2, dark: "#000000", light: "#ffffff" });
  assert.match(custom, /viewBox="0 0 33 33"/);
  assert.match(custom, /fill="#ffffff"/);
});

test("matrixToTerminalLines：半块渲染行数/行宽正确，静区是空白", () => {
  const m = qr.createQrMatrix(SAMPLE);
  const lines = qr.matrixToTerminalLines(m.modules);
  assert.equal(lines.length, 19); // ceil((29 + 8) / 2)
  assert.ok(lines.every((line) => line.length === 37)); // 29 + 4*2
  assert.equal(lines[0].trim(), "", "第一行应是纯静区");
  assert.equal(lines[1].trim(), "", "第二行仍在静区内（上下各 4 模块 = 2 字符行）");
  assert.match(lines[2], /^ {4}█/, "第三行起进入码面，左边是 4 字符静区");
  assert.ok(lines.some((line) => line.includes("▀") || line.includes("▄")), "半块字符应出现");
});
