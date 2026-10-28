// lane-realfix：真实模型测试（lane-real）留下的问题的回归（F-R4、O-R1、O-R2、O-R3、O-R5；F-R6 见 attach 的用例）
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { isOwnSendAppended, lastKeyOf, newItemsAfter } from "../ui/src/pi/model/transcriptWindow.ts"
import { hiddenUnconfiguredText, modelMenuListOf, PI_MODEL_MENU_UNCONFIGURED_MAX } from "../ui/src/pi/model/models.ts"

const read = (p) => fs.readFileSync(new URL(`../ui/src/${p}`, import.meta.url), "utf8")

describe("O-R1 吸底：新消息计数与本页发送", () => {
  test("记下的乐观气泡被 pi 的 user 消息原位换掉（key 变了）后，按记下时的下标接着数，不再一直是 0", () => {
    // 离开底部时最后一条是本页刚发的气泡 e3（下标 2）
    const before = [{ key: "u1" }, { key: "a2" }, { key: "e3" }]
    const mark = { key: lastKeyOf(before), at: before.length - 1 }
    // pi 的 user 消息到了：e3 换成 u4，随后回答 a5、a6 追加
    const after = [{ key: "u1" }, { key: "a2" }, { key: "u4" }, { key: "a5" }, { key: "a6" }]
    assert.equal(newItemsAfter(after, mark.key, mark.at), 2)
    // key 还在时照旧按 key 数；没有下标时退回 0（旧调用方）
    assert.equal(newItemsAfter([...before, { key: "a4" }], "e3", 0), 1)
    assert.equal(newItemsAfter(after, "e3"), 0)
    assert.equal(newItemsAfter(after, null, 1), 0)
  })
  test("本页发出的消息（from=local 的乐观气泡、outbox 卡）追加到末尾才算；别处发来的、流式更新同一条都不算", () => {
    const base = [{ key: "a1", kind: "assistant" }]
    assert.equal(isOwnSendAppended([...base, { key: "e2", kind: "user", from: "local" }], "a1"), true)
    assert.equal(isOwnSendAppended([...base, { key: "outbox-x", kind: "user", from: "remote", outbox: true }], "a1"), true)
    assert.equal(isOwnSendAppended([...base, { key: "r2", kind: "user", from: "remote" }], "a1"), false)
    assert.equal(isOwnSendAppended([...base, { key: "u2", kind: "user" }], "a1"), false)
    assert.equal(isOwnSendAppended([{ key: "e2", kind: "user", from: "local" }], "e2"), false)
    assert.equal(isOwnSendAppended([], null), false)
  })
  test("PiTranscript：mark 记 key + 下标；本页发送后 scrollToBottom", () => {
    const src = read("components/pi/conversation/PiTranscript.tsx")
    assert.match(src, /setMark\(\{ key: lastKey, at: items\.length - 1 \}\)/)
    assert.match(src, /newItemsAfter\(items, mark\?\.key \?\? null, mark\?\.at\)/)
    assert.match(src, /if \(isOwnSendAppended\(items, prev\)\) scrollToBottom\(\)/)
  })
})

describe("F-R4 模型菜单：未配置的折叠、限高、说明卡在滚动区外", () => {
  const rows = (configured, unconfigured) => [
    ...Array.from({ length: configured }, (_, i) => ({ key: `s/c${i}`, name: `Step ${i}` })),
    ...Array.from({ length: unconfigured }, (_, i) => ({ key: `x/u${i}`, name: i === 7 ? "Gemini Flash" : `Other ${i}`, unconfigured: true })),
  ]
  const by = (q) => (r) => r.name.toLowerCase().includes(q.trim().toLowerCase())
  test("未配置的不超过 5 个时照旧全列（画廊 c/model-menu 不变）", () => {
    const r = rows(5, PI_MODEL_MENU_UNCONFIGURED_MAX)
    assert.deepEqual(modelMenuListOf(r, "", by("")), { list: r, hiddenUnconfigured: 0 })
  })
  test("超过 5 个：只列已配置的，未配置的折成一行「还有 N 个未配置的模型」", () => {
    const r = rows(5, 1614)
    const out = modelMenuListOf(r, "", by(""))
    assert.equal(out.list.length, 5)
    assert.ok(out.list.every((m) => !m.unconfigured))
    assert.equal(out.hiddenUnconfigured, 1614)
    assert.equal(hiddenUnconfiguredText(1614), "还有 1614 个未配置的模型")
  })
  test("搜索时命中的未配置模型展开，排在已配置的后面，不折", () => {
    const r = [...rows(2, 10)].reverse()
    const out = modelMenuListOf(r, " gemini ", by("gemini"))
    assert.deepEqual(out.list.map((m) => m.key), ["x/u7"])
    assert.equal(out.hiddenUnconfigured, 0)
    const all = modelMenuListOf(r, "e", by("e"))
    const firstUn = all.list.findIndex((m) => m.unconfigured)
    assert.ok(firstUn > 0 && all.list.slice(0, firstUn).every((m) => !m.unconfigured) && all.list.slice(firstUn).every((m) => m.unconfigured))
  })
  test("可交互菜单：菜单卡限在 Radix 可用高度里、模型列表最高 360 内部滚动，说明卡挂在滚动区外、跟着选中行", () => {
    const src = read("components/pi/composer/PiModelMenu.tsx")
    assert.match(src, /const MENU_MAX_H = "max-h-\(--radix-dropdown-menu-content-available-height\)"/)
    assert.match(src, /const LIST_SCROLL = "relative min-h-0 max-h-\[360px\] overflow-y-auto/)
    const inter = src.slice(src.indexOf("function ModelMenuInteractive("), src.indexOf("const HIDDEN_STYLE"))
    const scroll = inter.indexOf("data-slot=\"pi-model-list-scroll\"")
    const anchor = inter.indexOf("data-slot=\"pi-model-explainer-anchor\"")
    const scrollEnd = inter.indexOf("{activeCard != null && (")
    assert.ok(scroll > 0 && scrollEnd > scroll && anchor > scrollEnd, "说明卡在滚动区闭合之后（不被 overflow 裁掉）")
    assert.match(inter, /onScroll=\{explainer\.place\}/)
    assert.match(src, /Math\.min\(Math\.max\(y\(r, 0\.5\), y\(box, 0\)\), y\(box, 1\)\)/, "卡的竖直位置 = 选中行中线，限在滚动区可见范围")
  })
})

describe("O-R2 / O-R3 / O-R5 正文层与改动 pane", () => {
  test("O-R2：Pi 正文的表格单元格可以换行，有最小列宽，表格仍在横滚容器里", () => {
    const src = read("components/pi/conversation/PiProse.tsx")
    const cells = src.slice(src.indexOf("const TABLE ="), src.indexOf("const QUOTE"))
    assert.doesNotMatch(cells, /whitespace-nowrap/)
    assert.match(cells, /const TABLE_CELL_MIN = "min-w-\[7em\]"/)
    assert.match(src, /const TABLE_WRAP = "my-\(--cw-space-2-5\) overflow-x-auto"/)
  })
  test("O-R3：代码块的横滚区右边让出复制钮那一栏", () => {
    const src = read("components/pi/conversation/PiCodeBlock.tsx")
    assert.match(src, /const CODE_SCROLL = "mr-7 overflow-x-auto py-2 pr-1 pl-3/)
    assert.match(src, /className=\{CODE_SCROLL\}/)
    assert.match(src, /absolute top-1\.5 right-1\.5/)
  })
  test("O-R5：改动 pane 的「N 行未改动」折叠条不画把手、没有 hover 加深；「第 N 次编辑」分隔条照旧", () => {
    const src = read("pi/containers/PaneContainer.tsx")
    assert.match(src, /\[&>\[data-slot=unmodified-lines-handle\]\]:hidden/)
    assert.match(src, /\{ kind: "fold", count: row\.count, label: row\.label, className: PANE_FOLD_STATIC \}/)
    assert.match(src, /row\.variant \? \{ kind: "fold", count: row\.count, label: row\.label, variant: row\.variant \}/)
  })
})

describe("F-R6 正文搜索按房间寻址（P8 8.1b 起扩成选中设备的各项目并发，纯函数见 test/pi-search-fanout.test.mjs）", () => {
  test("在线房间按房间发 search_session_bodies（打开的房间在它那组优先）；没有在线房间才按设备", () => {
    const src = read("relay/useRelay.ts")
    const at = src.indexOf("const searchSessionBodies = useCallback(")
    const fn = src.slice(at, src.indexOf("const sessionNameForPath", at))
    assert.match(fn, /bodySearchTargetsOf\(deviceId, authedRef\.current \? roomsRef\.current : \[\], roomRef\.current\)/)
    assert.match(fn, /channel\.command\(target\.roomId, "search_session_bodies", \{ query \}/)
    assert.ok(fn.indexOf('runDeviceCommand(deviceId, "search_session_bodies"') < fn.indexOf("channel.command(target.roomId"), "没有房间目标时先走按设备的退路")
    assert.match(fn, /if \(!roomTargets\.length\) return runDeviceCommand\(deviceId, "search_session_bodies", \{ query \}\)/, "按设备是退路")
  })
})
