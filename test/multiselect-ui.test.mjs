// G3 多选 UI 侧纯函数（design-ask-cards.md §5/§6）：dialog_open 归约带 min/maxSelect、
// caps 声明含 dialog.multiselect、状态短语给多选具名文案。
import test from "node:test"
import assert from "node:assert/strict"
import { dialogsAfterEvent, normalizeDialogCard } from "../ui/src/chat/composer/promptModel.ts"
import { VIEWER_CAPS } from "../ui/src/relay/protocol.ts"
import { dialogStatusPhrase } from "../ui/src/relay/roomStatus.ts"

const MULTI_OPEN = {
  type: "dialog_open",
  dialogId: "dlg-m1",
  kind: "multiselect",
  title: "选哪些？",
  options: ["甲", "乙", "丙"],
  minSelect: 1,
  maxSelect: 2,
  answerable: true,
  timeout: 120000,
  startedAt: 4242,
}

test("G3 UI：multiselect 的 dialog_open 归约带 options 与 min/maxSelect", () => {
  const card = normalizeDialogCard(MULTI_OPEN, 9999)
  assert.ok(card)
  assert.equal(card.kind, "multiselect")
  assert.deepEqual(card.options, ["甲", "乙", "丙"])
  assert.equal(card.minSelect, 1)
  assert.equal(card.maxSelect, 2)
  assert.equal(card.answerable, true)
  assert.equal(card.startedAt, 4242, "startedAt 用帧内值（多端计时同锚）")
})

test("G3 UI：min/maxSelect 坏值不进卡（负数/NaN/字符串），小数向下取整", () => {
  const bad = normalizeDialogCard({ ...MULTI_OPEN, dialogId: "d2", minSelect: -1, maxSelect: "2" }, 1)
  assert.equal(bad.minSelect, undefined)
  assert.equal(bad.maxSelect, undefined)
  const frac = normalizeDialogCard({ ...MULTI_OPEN, dialogId: "d3", minSelect: 0.6, maxSelect: 2.9 }, 1)
  assert.equal(frac.minSelect, 0)
  assert.equal(frac.maxSelect, 2)
})

test("G3 UI：既有 kind 的归约不受影响（select 不带 min/max 字段）", () => {
  const card = normalizeDialogCard({ type: "dialog_open", dialogId: "d4", kind: "select", title: "选", options: ["甲", "乙"], startedAt: 5 }, 1)
  assert.equal(card.kind, "select")
  assert.equal("minSelect" in card, false)
  assert.equal("maxSelect" in card, false)
})

test("G3 UI：dialogsAfterEvent 多选开→关往返；同 id 重放原位更新不新增", () => {
  let dialogs = dialogsAfterEvent([], MULTI_OPEN, 5000)
  assert.equal(dialogs.length, 1)
  assert.equal(dialogs[0].kind, "multiselect")
  dialogs = dialogsAfterEvent(dialogs, { ...MULTI_OPEN, title: "改后的题" }, 6000)
  assert.equal(dialogs.length, 1, "重连补发同 id 不新增卡")
  assert.equal(dialogs[0].title, "改后的题")
  dialogs = dialogsAfterEvent(dialogs, { type: "dialog_close", dialogId: "dlg-m1" }, 7000)
  assert.deepEqual(dialogs, [], "close 按 id 摘卡")
})

test("G3 UI：VIEWER_CAPS 声明 dialog.multiselect（与 relay 门控同轮落地）", () => {
  assert.ok(VIEWER_CAPS.includes("dialog.multiselect"))
  assert.ok(VIEWER_CAPS.includes("dialog.respond"), "多选应答面前置的 respond cap 仍在")
})

test("G3 UI：状态短语——多选有具名文案，与 select/confirm 同表", () => {
  assert.equal(dialogStatusPhrase("multiselect"), "等你多选")
  assert.equal(dialogStatusPhrase("select"), "等你选择")
  assert.equal(dialogStatusPhrase("confirm"), "等你确认")
})
