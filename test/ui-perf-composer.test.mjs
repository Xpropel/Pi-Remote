// UI·perf 中-2（Composer 全史派生：改动数增量缓存 + @ 候选按需扫描）/ 中-6（队列编辑竞态：作废编辑、失败行无操作钮、
// 「立即发送」按 id 在飞锁）的回归。纯逻辑 + 源码契约，不启动浏览器、不依赖 React。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { changesOfSessionCached, createChangesCache, PI_CHANGES_CACHE_MAX } from "../ui/src/components/pi/composer/sessionChanges.ts"
import { createSendNowLock, queueEditInvalidationOf } from "../ui/src/components/pi/composer/queueGuard.ts"
import { changesOfSession } from "../ui/src/pi/model/changes.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8")
/** 去掉 /* *\/ 和 // 注释（不碰字符串里的 "https://"） */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")

/* ---------------- 造条目（只带 changes 派生真正读到的字段） ---------------- */
let seq = 0
const tool = (name, input, extra = {}) => ({ kind: "tool", id: `t${(seq += 1)}`, name, state: "output-available", input, ...extra })
const assistant = (key, blocks) => ({ kind: "assistant", key, blocks })
const user = (key) => ({ kind: "user", key, text: "x", images: [] })

const PATCH = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,2 @@", " const a = 1", "-const b = 2", "+const b = 3", " context"].join("\n")

const CORPUS = [
  // patch 优先（带文件行号）
  [assistant("a1", [tool("edit", { path: "src/a.ts" }, { patch: PATCH })])],
  // write：args.content 全是增行
  [assistant("a1", [tool("write", { path: "src/new.ts", content: "a\nb\nc" })])],
  // edit：args 的 oldText / newText 走行级 diff
  [assistant("a1", [tool("edit", { file_path: "src/b.ts", oldText: "one\ntwo", newText: "one\nTWO" })])],
  // multi_edit 的 edits[]
  [
    assistant("a1", [
      tool("multi_edit", {
        path: "src/c.ts",
        edits: [
          { oldText: "x", newText: "y" },
          { oldText: "p\nq", newText: "p" },
        ],
      }),
    ]),
  ],
  // 同一文件多次编辑：行依次接上、计数相加
  [
    user("u1"),
    assistant("a1", [tool("edit", { path: "src/a.ts" }, { patch: PATCH })]),
    assistant("a2", [tool("write", { path: "src/a.ts", content: "d" })]),
  ],
  // patch 被截断：truncated 标记
  [assistant("a1", [tool("edit", { path: "src/a.ts" }, { patch: PATCH, patchTruncated: true })])],
  // 不算的：非编辑工具 / 失败状态 / 没有路径 / 推不出 diff
  [
    assistant("a1", [
      tool("read", { path: "src/a.ts" }),
      tool("edit", { path: "src/a.ts" }, { state: "output-error" }),
      tool("edit", { path: "" }),
      tool("edit", { nope: true }),
    ]),
  ],
]

const call = (items) => changesOfSessionCached(items, createChangesCache())

describe("中-2：改动数与 changesOfSession 同口径（增量缓存不改变结果）", () => {
  for (const [index, items] of CORPUS.entries()) {
    test(`语料 #${index}：changesOfSessionCached === changesOfSession`, () => {
      assert.deepEqual(call(items), changesOfSession(items))
    })
  }

  test("一次都没有改动时返回 null（tray 的改动 pill 不出现）", () => {
    assert.equal(call([user("u1")]), null)
    assert.equal(call([]), null)
    assert.equal(call(null), null)
  })

  test("同一份 items 再算一次：命中缓存、不重跑 diff，结果不变", () => {
    const items = [assistant("a1", [tool("edit", { path: "src/a.ts" }, { patch: PATCH })])]
    const cache = createChangesCache()
    const first = changesOfSessionCached(items, cache)
    const computes = cache.computes
    const hits = cache.hits
    assert.ok(computes >= 1)
    const second = changesOfSessionCached(items, cache)
    assert.deepEqual(second, first)
    assert.equal(cache.computes, computes, "没有重跑 diff")
    assert.ok(cache.hits > hits)
  })

  test("流式：items 每批换引用、最后一条重新造 blocks，但落定的编辑不重算", () => {
    // 已落定的编辑 + 正在长的助手消息（每批都是新对象）
    const settled = assistant("a1", [tool("edit", { path: "src/a.ts" }, { patch: PATCH })])
    const cache = createChangesCache()
    let computes = 0
    for (let frame = 0; frame < 20; frame += 1) {
      const live = assistant("a2", [{ kind: "text", text: "x".repeat(100 + frame) }])
      const items = [settled, live]
      changesOfSessionCached(items, cache)
      if (frame === 0) computes = cache.computes
      else assert.equal(cache.computes, computes, `第 ${frame} 帧不该重算已落定编辑的 diff`)
    }
    // 结果与全量口径一致（最后一条没有编辑块，不影响）
    assert.deepEqual(
      changesOfSessionCached([settled, assistant("a2", [{ kind: "text", text: "x" }])], cache),
      changesOfSession([settled, assistant("a2", [{ kind: "text", text: "x" }])]),
    )
  })

  test("patch 后来才到（同一工具 id，先 args 后 patch）：签名变了就重算，结果换成 patch 口径", () => {
    const cache = createChangesCache()
    const input = { path: "src/a.ts", oldText: "a", newText: "b" }
    const before = [assistant("a1", [tool("edit", input)])]
    const argsDiff = changesOfSessionCached(before, cache)
    assert.deepEqual(argsDiff, changesOfSession(before))
    assert.equal(argsDiff.files[0].rows[0].n, null, "args 推算没有文件行号")
    const after = [assistant("a1", [tool("edit", input, { patch: PATCH })])]
    const patchDiff = changesOfSessionCached(after, cache)
    assert.deepEqual(patchDiff, changesOfSession(after))
    assert.notDeepEqual(patchDiff, argsDiff, "patch 到了以后换成 patch 的结果")
  })

  test("缓存上限：超过 PI_CHANGES_CACHE_MAX 条只清空缓存，不改变结果", () => {
    assert.ok(PI_CHANGES_CACHE_MAX > 0)
    const items = [assistant("a1", [tool("edit", { path: "src/a.ts" }, { patch: PATCH })])]
    const cache = createChangesCache()
    for (let i = 0; i < PI_CHANGES_CACHE_MAX - 1; i += 1) cache.blocks.set(`filler-${i}`, { sig: "x", diff: null })
    changesOfSessionCached(items, cache)
    assert.deepEqual(changesOfSessionCached(items, cache), changesOfSession(items))
  })
})

describe("中-6：立即发送按 id 在飞锁", () => {
  test("同一 id 连点：只有第一次放行；结束后可再发", () => {
    const lock = createSendNowLock()
    assert.equal(lock.begin("q1"), true)
    assert.equal(lock.begin("q1"), false)
    assert.equal(lock.has("q1"), true)
    lock.end("q1")
    assert.equal(lock.has("q1"), false)
    assert.equal(lock.begin("q1"), true)
  })

  test("不同 id 互不影响；空 id 不放行", () => {
    const lock = createSendNowLock()
    assert.equal(lock.begin("q1"), true)
    assert.equal(lock.begin("q2"), true)
    lock.end("q1")
    assert.equal(lock.has("q2"), true)
    assert.equal(lock.begin(""), false)
  })

  test("失败也要解锁（end 幂等），用户可以重试", () => {
    const lock = createSendNowLock()
    assert.equal(lock.begin("q1"), true)
    lock.end("q1")
    lock.end("q1")
    assert.equal(lock.begin("q1"), true)
  })
})

describe("中-6：条目离开 pending 即作废编辑", () => {
  const items = (...states) => states.map((status, i) => ({ id: `q${i + 1}`, status }))

  test("pending：编辑稿还有落点", () => {
    assert.equal(queueEditInvalidationOf(items("pending"), "q1"), null)
  })

  test("注入 / 失败（都已离开 pending）：作废，原因是 sent", () => {
    assert.equal(queueEditInvalidationOf(items("injected"), "q1"), "sent")
    assert.equal(queueEditInvalidationOf(items("failed"), "q1"), "sent")
    assert.equal(queueEditInvalidationOf(items("pending", "injected"), "q2"), "sent")
  })

  test("条目不在清单里了：作废，原因是 gone", () => {
    assert.equal(queueEditInvalidationOf(items("pending"), "q9"), "gone")
    assert.equal(queueEditInvalidationOf([], "q1"), "gone")
  })
})

describe("源码契约：中-2 接线与中-6 的行内行为", () => {
  const composer = code(read("ui/src/pi/containers/ComposerContainer.tsx"))

  test("改动数走增量缓存（不再每批全史重跑行级 diff）", () => {
    assert.match(composer, /const \[changesCache\] = useState\(createChangesCache\)/)
    assert.match(composer, /const changes = useMemo\(\(\) => changesOfSessionCached\(items, changesCache\), \[items, changesCache\]\)/)
    assert.doesNotMatch(composer, /changesOfSession\(items\)/)
  })

  test("@ 候选只在草稿里真有 @ 时才扫历史（流式期间不再每帧全扫）", () => {
    assert.match(composer, /const poolWanted = isStatic \|\| draft\.includes\("@"\)/)
    assert.match(composer, /poolWanted \? mergeMentionCandidates\(collectTranscriptFiles\(items\), viewedMentionFiles\(roomId\)\)\.map\(\(f\) => f\.path\) : EMPTY_MENTION_POOL/)
    assert.match(composer, /\[poolWanted, items, roomId\]/)
    assert.match(composer, /const EMPTY_MENTION_POOL: string\[\] = \[\]/)
  })

  test("编辑稿失效：effect 里作废并给出原因文案", () => {
    assert.match(composer, /const editInvalid = editingId == null \? null : queueEditInvalidationOf\(remoteItems, editingId\)/)
    assert.match(composer, /notify\(editInvalid === "sent" \? "这条已经发出去了，编辑稿没有保存" : "这条已经不在队列里，编辑稿没有保存", "warn"\)/)
    assert.match(composer, /setEditing\(null\)/)
  })

  test("立即发送先抢在飞锁，成功 / 失败都解锁", () => {
    assert.match(composer, /const \[sendNowLock\] = useState\(createSendNowLock\)/)
    assert.match(composer, /if \(!sendNowLock\.begin\(id\)\) return/)
    assert.match(composer, /\(\) => sendNowLock\.end\(id\)/)
    assert.match(composer, /sendNowLock\.end\(id\)\s*\n\s*fail\(error\)/)
  })

  test("排队面板：失败条目（终态）不渲染立即发送 / 编辑 / 取消这一排", () => {
    const panel = code(read("ui/src/components/pi/composer/PiQueuePanel.tsx"))
    assert.match(panel, /const actionable = item\.status === "pending"/)
    assert.match(panel, /\{!phone && actionable && <Actions variant=\{variant\} on=\{actionsOf\(item\.id\)\} \/>\}/)
    assert.match(panel, /\{phone && actionable && \(/)
    assert.doesNotMatch(panel, /\{!phone && <Actions variant=\{variant\} on=\{actionsOf\(item\.id\)\} \/>\}/)
  })
})
