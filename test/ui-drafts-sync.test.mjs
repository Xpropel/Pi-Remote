// 草稿跨标签页同步回归（UI 低危：relay.md 低-2 / perf-drafts.md 低 L4）：
// 同房两个标签页时，陈旧标签页关页/切房不能把另一页刚改好的草稿冲回旧版本；
// storage 事件在不覆盖本地未落盘编辑的前提下同步远端草稿。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import {
  DRAFTS_STORAGE_KEY,
  DRAFT_IMAGES_STORAGE_KEY,
  clearDraftImages,
  onDraftPersistFailure,
  parseDraftTable,
  readDraftImages,
  readRoomDraft,
  reconcileRemoteDraft,
  roomDraftFromRaw,
  saveDraftImages,
  saveRoomDraft,
  shouldPersistDraft,
} from "../ui/src/relay/drafts.ts"
import { MAX_PENDING_IMAGES } from "../ui/src/chat/composerTools.ts"
import { SEND_IMAGE_MAX_CHARS } from "../ui/src/relay/transcript.ts"

function fakeStore(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get: (key) => (data.has(key) ? data.get(key) : null),
    set: (key, value) => {
      data.set(key, value)
      return true
    },
    remove: (key) => data.delete(key),
  }
}

test("roomDraftFromRaw：从 storage 事件的新值里读目标房间草稿，坏值降级为「无草稿」", () => {
  const raw = JSON.stringify({ "room-a": { text: "另一页写的", at: 1 }, "room-b": { text: "别的房", at: 2 } })
  assert.equal(roomDraftFromRaw(raw, "room-a"), "另一页写的")
  assert.equal(roomDraftFromRaw(raw, "room-missing"), "")
  assert.equal(roomDraftFromRaw(null, "room-a"), "")
  assert.equal(roomDraftFromRaw("{broken", "room-a"), "")
  assert.equal(roomDraftFromRaw(JSON.stringify({ "room-a": { text: "", at: 1 } }), "room-a"), "", "空文本条目视为无草稿")
})

test("reconcileRemoteDraft：本地干净才采纳远端；本地有未落盘编辑时保留本地", () => {
  // 本页没有改动（current === base）→ 采纳另一页的新草稿
  assert.deepEqual(reconcileRemoteDraft("旧稿", "旧稿", "另一页的新稿"), { adopt: true, draft: "另一页的新稿", base: "另一页的新稿" })
  // 本页正在输入（current !== base）→ 不覆盖本地，base 保持（之后由本地落盘按最后写入胜出）
  assert.deepEqual(reconcileRemoteDraft("本地改到一半", "旧稿", "另一页的新稿"), { adopt: false, draft: "本地改到一半", base: "旧稿" })
  // 远端与本地相同 → 只对齐基线，不触发重渲染
  assert.deepEqual(reconcileRemoteDraft("同一稿", "旧稿", "同一稿"), { adopt: false, draft: "同一稿", base: "同一稿" })
  // 远端删除草稿（""）且本地干净 → 采纳清空
  assert.deepEqual(reconcileRemoteDraft("旧稿", "旧稿", ""), { adopt: true, draft: "", base: "" })
})

test("shouldPersistDraft：只有与基线不同才写（防陈旧标签页覆盖新草稿）", () => {
  assert.equal(shouldPersistDraft("新稿", "旧稿"), true)
  assert.equal(shouldPersistDraft("旧稿", "旧稿"), false)
  assert.equal(shouldPersistDraft("", "旧稿"), true, "清空 = 删草稿，需要写")
})

test("陈旧标签页场景：另一页已把草稿改成 v2，本页（仍显示 v1）关页不落盘", () => {
  const tabA = fakeStore()
  const tabB = fakeStore()
  // 两个标签页最初都载入 v1（各自的 base 都是 v1）
  saveRoomDraft("room-x", "v1", tabA, 1000)
  saveRoomDraft("room-x", "v1", tabB, 1000)
  let baseB = "v1"
  let draftB = "v1"

  // A 页改成 v2 落盘（同一 localStorage：同步到 B 的 store 模拟共享存储）
  saveRoomDraft("room-x", "v2", tabA, 2000)
  tabB.set(DRAFTS_STORAGE_KEY, tabA.get(DRAFTS_STORAGE_KEY))
  assert.equal(readRoomDraft("room-x", tabB), "v2")

  // B 页收到 storage 事件：本地干净 → 采纳 v2
  const merged = reconcileRemoteDraft(draftB, baseB, roomDraftFromRaw(tabB.get(DRAFTS_STORAGE_KEY), "room-x"))
  baseB = merged.base
  if (merged.adopt) draftB = merged.draft
  assert.equal(draftB, "v2")

  // 关闭/切房：B 的草稿与 base 相同 → 不写，v2 不被冲回 v1
  if (shouldPersistDraft(draftB, baseB)) saveRoomDraft("room-x", draftB, tabB, 3000)
  assert.equal(readRoomDraft("room-x", tabB), "v2")
})

test("漏掉 storage 事件也不冲掉另一页：本页仍是旧值但基线相同 → 不落盘", () => {
  const store = fakeStore()
  saveRoomDraft("room-y", "v2", store, 2000) // 另一页刚写的新稿；本页没收到事件
  let draft = "v1"
  let base = "v1"
  if (shouldPersistDraft(draft, base)) saveRoomDraft("room-y", draft, store, 3000)
  assert.equal(readRoomDraft("room-y", store), "v2", "旧标签页不能把新稿覆盖成旧稿")

  // 本页确实编辑过（draft !== base）才写，最后写入胜出
  draft = "v1 + 本页新增"
  assert.equal(shouldPersistDraft(draft, base), true)
  saveRoomDraft("room-y", draft, store, 3000)
  assert.equal(readRoomDraft("room-y", store), "v1 + 本页新增")
})

test("既有草稿行为不回退：写/读/清空/淘汰仍按原口径", () => {
  const store = fakeStore()
  saveRoomDraft("room-a", "写了一半", store, 1000)
  saveRoomDraft("room-b", "另一间的话", store, 2000)
  assert.equal(readRoomDraft("room-a", store), "写了一半")
  assert.equal(readRoomDraft("room-b", store), "另一间的话")
  saveRoomDraft("room-a", "", store, 3000)
  assert.equal(readRoomDraft("room-a", store), "")
  assert.equal(readRoomDraft("room-b", store), "另一间的话")
  assert.equal(parseDraftTable(store.get(DRAFTS_STORAGE_KEY))["room-b"].text, "另一间的话")
})

test("接线：useRelay 监听 storage 并用基线防冲突；切房/关页落盘带 shouldPersistDraft 闸门", () => {
  const relay = fs.readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  assert.match(relay, /window\.addEventListener\("storage", onStorage\)/)
  assert.match(relay, /event\.key === DRAFTS_STORAGE_KEY/, "storage 事件必须处理草稿键")
  assert.match(relay, /roomDraftFromRaw\(event\.newValue, key\)/)
  assert.match(relay, /reconcileRemoteDraft\(draftRef\.current, draftBaseRef\.current, remote\)/)
  assert.match(relay, /draftBaseRef\.current = merged\.base/)
  assert.match(relay, /if \(merged\.adopt\) setDraft\(merged\.draft\)/)
  // 两条落盘路径都必须先比较 baseline：persistDraftNow 与 300ms 防抖
  assert.match(relay, /if \(!shouldPersistDraft\(text, draftBaseRef\.current\)\) return/)
  assert.match(relay, /if \(!shouldPersistDraft\(draft, draftBaseRef\.current\)\) return/)
  // 归属切换后重新对账
  assert.match(relay, /owner === draftBaseOwnerRef\.current/)
  assert.match(relay, /draftBaseRef\.current = owner \? readRoomDraft\(owner\) : ""/)
})

/* ── UI 低危 16：草稿落盘失败不再彻底静默 ───────────────────────────────── */

test("低危 16：落盘失败返回 false 并上报；同一房间连续失败只报一次，成功写入后重新武装", () => {
  const failing = fakeStore()
  failing.set = () => false
  const seen = []
  const off = onDraftPersistFailure((failure) => seen.push(failure.roomKey))
  try {
    assert.equal(saveRoomDraft("room-a", "写了一半", failing, 1), false)
    assert.equal(saveRoomDraft("room-a", "又写了一半", failing, 2), false)
    assert.deepEqual(seen, ["room-a"], "同一房间的连续失败不刷屏")
    assert.equal(saveRoomDraft("room-b", "别的房间", failing, 3), false)
    assert.deepEqual(seen, ["room-a", "room-b"], "不同房间各自提示一次")
  } finally {
    off()
  }
  assert.equal(saveRoomDraft("room-c", "退订后", failing, 4), false)
  assert.deepEqual(seen, ["room-a", "room-b"], "退订后不再收到")

  // 先成功一次会清掉失败标记；之后再次失败要重新提示（不是一次失败永久静音）
  const healthy = fakeStore()
  const seen2 = []
  const off2 = onDraftPersistFailure((failure) => seen2.push(failure.roomKey))
  try {
    assert.equal(saveRoomDraft("room-d", "先成功", healthy, 5), true)
    const failingAgain = fakeStore()
    failingAgain.set = () => false
    assert.equal(saveRoomDraft("room-d", "后失败", failingAgain, 6), false)
    assert.deepEqual(seen2, ["room-d"])
  } finally {
    off2()
  }
  // 既有读写口径不变：写成功的返回值 / 内容都照旧
  const store = fakeStore()
  assert.equal(saveRoomDraft("room-e", "正常", store, 7), true)
  assert.equal(readRoomDraft("room-e", store), "正常")
})

test("低危 16/17 接线：ComposerContainer 订阅落盘失败，并负责待发图片的恢复/副本/清理", () => {
  const src = fs.readFileSync(new URL("../ui/src/pi/containers/ComposerContainer.tsx", import.meta.url), "utf8")
  assert.match(src, /onDraftPersistFailure\(/, "失败提示必须接在 composer 上")
  assert.match(src, /readDraftImages\(roomId\)/, "挂载/换房时恢复刷新前的待发图片")
  assert.match(src, /addPendingImages\(saved\)/, "恢复走 relay 已有的图片入口（额度仍由它把关）")
  assert.match(src, /saveDraftImages\(roomId, pendingImages\)/, "图片变化时写会话级副本")
  assert.match(src, /clearDraftImages\(\)/, "图片清空/发完时删副本，避免下次复活")
})

/* ── UI 低危 17：草稿只存文本，待发图片刷新后静默消失 ─────────────────── */

test("低危 17：待发图片按房间存会话级副本，刷新可恢复；错房 / 坏值 / 未知 mime 都丢弃", () => {
  const s = fakeStore()
  const png = { mimeType: "image/png", data: "QUJD" }
  const jpg = { mimeType: "image/jpg", data: "REVG" }
  assert.equal(saveDraftImages("room-a", [png, jpg], s, 10), true)
  // image/jpg 与发送路径同口径归一成 image/jpeg
  assert.deepEqual(readDraftImages("room-a", s), [
    { mimeType: "image/png", data: "QUJD" },
    { mimeType: "image/jpeg", data: "REVG" },
  ])
  assert.deepEqual(readDraftImages("room-b", s), [], "别的房间不能捡到本房的图")
  assert.equal(s.get(DRAFT_IMAGES_STORAGE_KEY) !== null, true)

  // 坏记录一律降级为"没有可恢复的图"，不抛
  s.set(DRAFT_IMAGES_STORAGE_KEY, "{broken")
  assert.deepEqual(readDraftImages("room-a", s), [])
  s.set(DRAFT_IMAGES_STORAGE_KEY, JSON.stringify({ room: "room-a", images: [{ mimeType: "text/plain", data: "x" }, { mimeType: "image/png", data: "" }, "junk", null] }))
  assert.deepEqual(readDraftImages("room-a", s), [], "未知 mime / 空数据 / 非对象全丢")

  saveDraftImages("room-a", [png], s)
  clearDraftImages(s)
  assert.deepEqual(readDraftImages("room-a", s), [])
})

test("低危 17：图片副本有条数与合计预算上限；写失败返回 false（调用方据此提示刷新会丢）", () => {
  const s = fakeStore()
  const many = Array.from({ length: MAX_PENDING_IMAGES + 3 }, (_, index) => ({ mimeType: "image/png", data: `img-${index}` }))
  assert.equal(saveDraftImages("room-a", many, s), true)
  assert.equal(readDraftImages("room-a", s).length, MAX_PENDING_IMAGES, "最多恢复输入条允许的张数")

  // 单张超过发送上限的图不进副本（与 prepareSendImage 同口径）
  saveDraftImages("room-a", [{ mimeType: "image/png", data: "x".repeat(SEND_IMAGE_MAX_CHARS + 1) }], s)
  assert.deepEqual(readDraftImages("room-a", s), [])

  const failing = fakeStore()
  failing.set = () => false
  assert.equal(saveDraftImages("room-a", [{ mimeType: "image/png", data: "QUJD" }], failing), false)
})
