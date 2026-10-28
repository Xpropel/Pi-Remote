"use strict";
/**
 * relay 中-10 回归测试：图片降级必须有"本次合计预算"，且深层嵌套图片不能被深度早退绕过。
 * 直接测 relay/rooms.js 的纯函数，不启动 relay、不落盘、不涉及 UI。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  shrinkImagesDeep,
  IMAGE_MAX_CHARS,
  IMAGE_TOTAL_MAX_CHARS,
} = require("../relay/rooms.js");

function image(chars, extra = {}) {
  return { type: "image", mimeType: "image/png", data: "A".repeat(chars), ...extra };
}

/** 占位形态与原有单图降级完全一致：data 清空、omitted、omittedBytes 记原始体积。 */
function assertOmitted(img, originalChars) {
  assert.equal(img.data, "", "占位图的 data 必须清空");
  assert.equal(img.omitted, true, "占位图必须带 omitted");
  assert.equal(img.omittedBytes, Math.floor((originalChars * 3) / 4), "omittedBytes 要记下原图体积");
}

test("relay 中-10：几十张卡线图按合计预算降级，保留总量不越界", () => {
  const perImage = 20 * 1024;
  const count = 40;
  const content = Array.from({ length: count }, (_, i) =>
    image(perImage, { entryId: `e${i}`, blockIndex: i, note: "非图片字段不能被改" }),
  );
  const event = { type: "message_end", message: { role: "toolResult", content } };

  const hit = shrinkImagesDeep(event);
  const kept = content.filter((x) => !x.omitted);
  const omitted = content.filter((x) => x.omitted);

  assert.equal(hit, omitted.length, "返回值是本次降级的图片数");
  assert.equal(kept.length, Math.floor(IMAGE_TOTAL_MAX_CHARS / perImage), "合计预算内能留几张就留几张");
  assert.ok(omitted.length > 0, "几十张图不能原样穿过");
  const keptChars = kept.reduce((n, x) => n + x.data.length, 0);
  assert.ok(keptChars <= IMAGE_TOTAL_MAX_CHARS, "保留的图片合计不能超过预算");
  assert.ok(Buffer.byteLength(JSON.stringify(event)) < 256 * 1024, "降级后整帧应能进 viewer 默认单帧预算");

  for (const [i, img] of content.entries()) {
    if (img.omitted) {
      assertOmitted(img, perImage);
      assert.equal(img.entryId, `e${i}`, "占位保留 entryId");
      assert.equal(img.blockIndex, i, "占位保留 blockIndex");
      assert.equal(img.note, "非图片字段不能被改", "占位保留其它元数据");
    } else {
      assert.equal(img.data.length, perImage);
    }
  }

  // 预算按每次调用重新计算，不能跨事件累计把后续正常图片也挤掉。
  const fresh = { content: [image(96 * 1024), image(96 * 1024)] };
  assert.equal(shrinkImagesDeep(fresh), 0);
  assert.equal(fresh.content[0].data.length, 96 * 1024);
  assert.equal(fresh.content[1].data.length, 96 * 1024);
});

test("relay 中-10：超过 12 层的深层图片仍被降级，并计入合计预算", () => {
  // 单张超限：限深早退以前会让它在 13 层之后原样穿过。
  const deepBig = image(IMAGE_MAX_CHARS + 1, { entryId: "deep-big" });
  let oversized = { type: "message_end", message: { role: "toolResult", content: [deepBig] } };
  for (let i = 0; i < 40; i++) oversized = { type: "wrapper", level: i, child: oversized };

  assert.equal(shrinkImagesDeep(oversized), 1);
  assertOmitted(deepBig, IMAGE_MAX_CHARS + 1);
  assert.equal(deepBig.entryId, "deep-big");

  // 单张都没超限，但深层那张要和前面的图合计，超预算照样换占位。
  const shallow = image(100 * 1024);
  const deep = image(100 * 1024, { entryId: "deep-budget" });
  let nested = { type: "message_end", message: { role: "toolResult", content: [shallow, { nested: [deep] }] } };
  for (let i = 0; i < 40; i++) nested = { type: "wrapper", level: i, child: nested };

  assert.equal(shrinkImagesDeep(nested), 1);
  assert.equal(shallow.data.length, 100 * 1024, "先到的浅层图占用预算");
  assert.equal(shallow.omitted, undefined);
  assertOmitted(deep, 100 * 1024);
  assert.equal(deep.entryId, "deep-budget");
});

test("relay 中-10：单图大小边界不变（恰好上限保留，超 1 字符降级）", () => {
  const atLimit = image(IMAGE_MAX_CHARS, { entryId: "at-limit" });
  const overLimit = image(IMAGE_MAX_CHARS + 1, { entryId: "over-limit" });
  const after = image(8 * 1024);

  assert.equal(shrinkImagesDeep({ content: [atLimit, overLimit, after] }), 1);
  assert.equal(atLimit.data.length, IMAGE_MAX_CHARS, "等于单图上限不降级");
  assert.equal(atLimit.omitted, undefined);
  assertOmitted(overLimit, IMAGE_MAX_CHARS + 1);
  assert.equal(after.data.length, 8 * 1024, "前面有超限图时，后面的小图仍按合计预算处理");
  assert.equal(after.omitted, undefined);
});

test("relay 中-10：非图片的深层节点保持原样", () => {
  const content = [
    { type: "text", text: "正常文本" },
    { type: "text", text: "B".repeat(IMAGE_TOTAL_MAX_CHARS * 2) },
    { type: "toolCall", arguments: { nested: { list: [1, 2, { deep: "value" }], flag: false } } },
  ];
  let root = { type: "message_end", message: { role: "assistant", content } };
  for (let i = 0; i < 50; i++) root = { type: "wrapper", level: i, child: root };
  const before = JSON.stringify(root);

  assert.equal(shrinkImagesDeep(root), 0, "没有图片就不产生占位");
  assert.equal(JSON.stringify(root), before, "深层非图片结构一个字节都不能改");
});
