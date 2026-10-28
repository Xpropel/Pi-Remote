// P3-5 slash 菜单可发现性：slashUsage 计数存储（只记命令名、绝不记参数）+
// P7 B2e（决定 17）：读 chat/slash.tsx / dialogs.tsx 的 6 个接线 / 令牌化用例删了，接线改查新界面 ComposerContainer（末尾一条）；纯逻辑用例照旧。
// 空查询分组 groupSlashBrowse（常用置顶 / 资源命令可浏览 / 前缀过滤不干扰）的纯逻辑测试。
// Node ≥22.18 直接剥离 TS 类型 import .ts 源文件（与 mention.test.mjs 同法）。
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  frequentSlashNames,
  loadSlashUsage,
  normalizeSlashName,
  noteSlashCommandUsed,
  parseSlashUsage,
  recordSlashUsage,
  serializeSlashUsage,
  SLASH_USAGE_EVENT,
  SLASH_USAGE_MAX_ENTRIES,
  SLASH_USAGE_STORAGE_KEY,
} from "../ui/src/chat/slashUsage.ts"
import { groupSlashBrowse, SLASH_GROUP_FREQUENT, SLASH_GROUP_RESOURCES } from "../ui/src/chat/slashParse.ts"

/* ---------------- normalizeSlashName ---------------- */

test("命令名归一：去斜杠/小写/去空白；含空白与空名拒绝", () => {
  assert.equal(normalizeSlashName("/Model"), "model")
  assert.equal(normalizeSlashName("  skill:Review "), "skill:review")
  assert.equal(normalizeSlashName("session"), "session")
  assert.equal(normalizeSlashName(""), "")
  assert.equal(normalizeSlashName("/"), "")
  assert.equal(normalizeSlashName("name 新名字"), "")
  assert.equal(normalizeSlashName(null), "")
  assert.equal(normalizeSlashName(42), "")
})

/* ---------------- recordSlashUsage / parseSlashUsage ---------------- */

test("记账：计数累加、最近时间更新、不改入参表", () => {
  const t0 = {}
  const t1 = recordSlashUsage(t0, "/session", 100)
  assert.deepEqual(t0, {})
  assert.deepEqual(t1, { session: { count: 1, at: 100 } })
  const t2 = recordSlashUsage(t1, "session", 250)
  assert.deepEqual(t2.session, { count: 2, at: 250 })
  // 归一失败的名记空账：整行草稿误传进来也不能落盘
  assert.equal(recordSlashUsage(t2, "name 一段参数", 300), t2)
})

test("记账：超上限按最久未用淘汰", () => {
  let table = {}
  for (let i = 0; i < SLASH_USAGE_MAX_ENTRIES + 5; i++) table = recordSlashUsage(table, `cmd${i}`, i + 1)
  assert.equal(Object.keys(table).length, SLASH_USAGE_MAX_ENTRIES)
  assert.equal(table.cmd0, undefined)
  assert.equal(table.cmd4, undefined)
  assert.ok(table[`cmd${SLASH_USAGE_MAX_ENTRIES + 4}`])
})

test("解析：往返一致；脏条目逐条丢弃，不毒化整表", () => {
  const table = { model: { count: 3, at: 9 }, "skill:x": { count: 1, at: 5 } }
  assert.deepEqual(parseSlashUsage(serializeSlashUsage(table)), table)
  assert.deepEqual(parseSlashUsage(null), {})
  assert.deepEqual(parseSlashUsage("不是 json"), {})
  assert.deepEqual(parseSlashUsage(JSON.stringify([1, 2])), {})
  const dirty = JSON.stringify({
    good: { count: 2, at: 3 },
    zero: { count: 0, at: 3 },
    neg: { count: -1, at: 3 },
    "Has Space": { count: 5, at: 3 },
    UPPER: { count: 5, at: 3 },
    shapeless: 7,
    nocount: { at: 3 },
  })
  assert.deepEqual(parseSlashUsage(dirty), { good: { count: 2, at: 3 } })
})

/* ---------------- frequentSlashNames ---------------- */

test("常用排序：计数降序、同计数按最近使用、受上限截断", () => {
  const table = {
    a: { count: 2, at: 100 },
    b: { count: 5, at: 50 },
    c: { count: 5, at: 200 },
    d: { count: 1, at: 999 },
  }
  assert.deepEqual(frequentSlashNames(table, 10), ["c", "b", "a", "d"])
  assert.deepEqual(frequentSlashNames(table, 2), ["c", "b"])
  assert.deepEqual(frequentSlashNames({}, 5), [])
})

/* ---------------- 存储往返与隐私 ---------------- */

function fakeStore() {
  const data = new Map()
  return {
    data,
    get: (key) => (data.has(key) ? data.get(key) : null),
    set: (key, value) => (data.set(key, value), true),
    remove: (key) => data.delete(key),
  }
}

test("落盘往返：记账后可读回；清掉存储后归零、菜单数据为空表", () => {
  const store = fakeStore()
  noteSlashCommandUsed("session", store, 1000)
  noteSlashCommandUsed("session", store, 2000)
  noteSlashCommandUsed("/compact", store, 3000)
  assert.deepEqual(loadSlashUsage(store), {
    session: { count: 2, at: 2000 },
    compact: { count: 1, at: 3000 },
  })
  store.remove(SLASH_USAGE_STORAGE_KEY)
  assert.deepEqual(loadSlashUsage(store), {})
})

test("隐私：存储里只有命令名与计数/时间，构造带参数执行后查不到参数", () => {
  const store = fakeStore()
  // 模拟 /name 机密新名字、/follow 一段私密正文 的执行成功：接线层只把命令名交给计数 API。
  noteSlashCommandUsed("name", store, 100)
  noteSlashCommandUsed("follow", store, 200)
  const raw = store.get(SLASH_USAGE_STORAGE_KEY)
  assert.ok(raw)
  assert.ok(!raw.includes("机密"), "参数绝不落盘")
  const parsed = JSON.parse(raw)
  for (const [key, value] of Object.entries(parsed)) {
    assert.ok(!/\s/.test(key), `键必须是纯命令名：${key}`)
    assert.deepEqual(Object.keys(value).sort(), ["at", "count"])
    assert.equal(typeof value.count, "number")
    assert.equal(typeof value.at, "number")
  }
  // 万一有调用方把整行草稿误传进 API，带空白的名被拒绝，参数片段仍进不了存储。
  noteSlashCommandUsed("name 机密新名字", store, 300)
  assert.ok(!store.get(SLASH_USAGE_STORAGE_KEY).includes("机密"))
  assert.deepEqual(loadSlashUsage(store).name, { count: 1, at: 100 })
})

test("存储不可用时静默降级：get/set 抛错不冒泡", () => {
  const broken = {
    get() { throw new Error("denied") },
    set() { throw new Error("denied") },
    remove() { throw new Error("denied") },
  }
  assert.deepEqual(loadSlashUsage(broken), {})
  assert.deepEqual(noteSlashCommandUsed("model", broken, 1), { model: { count: 1, at: 1 } })
})

/* ---------------- groupSlashBrowse（空查询分组呈现） ---------------- */

const row = (name) => ({ name })
const BUILTINS = [row("/model"), row("/thinking"), row("/name"), row("/compact"), row("/session"), row("/copy")]
const RESOURCES = [row("/review"), row("/skill:deep"), row("/session")] // /session 与内置同名，应被内置优先口径挡下

test("空查询分组：无计数时 = 内置主组（无标题）+ 资源命令组（带标题）", () => {
  const groups = groupSlashBrowse(BUILTINS, RESOURCES, [], 5)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].title, null)
  assert.deepEqual(groups[0].rows.map((r) => r.name), BUILTINS.map((r) => r.name))
  assert.equal(groups[1].title, SLASH_GROUP_RESOURCES)
  assert.deepEqual(groups[1].rows.map((r) => r.name), ["/review", "/skill:deep"])
})

test("空查询分组：无资源无计数时只有内置一组，与改造前平铺一致", () => {
  const groups = groupSlashBrowse(BUILTINS, [], [], 5)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].title, null)
  assert.deepEqual(groups[0].rows, BUILTINS)
  assert.deepEqual(groupSlashBrowse([], [], [], 5), [])
})

test("空查询分组：常用置顶——内置与资源混合计次、排序按频次/最近、原组摘除不重复", () => {
  let table = {}
  for (let i = 0; i < 3; i++) table = recordSlashUsage(table, "session", 100 + i)
  for (let i = 0; i < 2; i++) table = recordSlashUsage(table, "review", 200 + i)
  table = recordSlashUsage(table, "model", 300)
  const order = frequentSlashNames(table, SLASH_USAGE_MAX_ENTRIES)
  const groups = groupSlashBrowse(BUILTINS, RESOURCES, order, 5)
  assert.equal(groups[0].title, SLASH_GROUP_FREQUENT)
  assert.deepEqual(groups[0].rows.map((r) => r.name), ["/session", "/review", "/model"])
  const rest = groups.slice(1).flatMap((g) => g.rows.map((r) => r.name))
  assert.deepEqual(rest, ["/thinking", "/name", "/compact", "/copy", "/skill:deep"])
  const all = groups.flatMap((g) => g.rows.map((r) => r.name))
  assert.equal(new Set(all).size, all.length, "任一行不得重复出现")
})

test("空查询分组：常用组受上限截断，溢出的名回到原组", () => {
  const order = ["session", "review", "model"]
  const groups = groupSlashBrowse(BUILTINS, RESOURCES, order, 2)
  assert.deepEqual(groups[0].rows.map((r) => r.name), ["/session", "/review"])
  const rest = groups.slice(1).flatMap((g) => g.rows.map((r) => r.name))
  assert.ok(rest.includes("/model"), "被截断的常用名仍在内置组可达")
})

test("空查询分组：计数里不存在的名（别房资源/已删命令）静默跳过；同名以内置为准", () => {
  const groups = groupSlashBrowse(BUILTINS, RESOURCES, ["ghost", "session"], 5)
  assert.deepEqual(groups[0].rows.map((r) => r.name), ["/session"])
  assert.ok(BUILTINS.includes(groups[0].rows[0]), "取到的是内置行本体，不是同名资源行")
})

/* ---------------- 接线（源码级，与 ui-sync 同法） ---------------- */





/* ---------------- 跨实例同步（B-4） ---------------- */

test("跨实例同步：记账后广播 SLASH_USAGE_EVENT，同页其他实例据此重读", () => {
  assert.equal(SLASH_USAGE_EVENT, "pi-slash-usage")
  const seen = []
  globalThis.window = { dispatchEvent: (event) => (seen.push(event.type), true) }
  try {
    noteSlashCommandUsed("model", fakeStore(), 500)
  } finally {
    delete globalThis.window
  }
  assert.deepEqual(seen, [SLASH_USAGE_EVENT])
  // 无 window 环境（SSR/测试）记账照常，不抛
  assert.deepEqual(noteSlashCommandUsed("model", fakeStore(), 600), { model: { count: 1, at: 600 } })
})


/* ---------------- 对话框路径计次（B-2） ---------------- */
test("接线（P7 B2e 改查新界面）：ComposerContainer 计次只经 noteSlashCommandUsed，监听同页广播 + storage 重读计数；内置清单在 chat/slashCommands.ts", () => {
  const container = readFileSync(new URL("../ui/src/pi/containers/ComposerContainer.tsx", import.meta.url), "utf8")
  assert.match(container, /noteSlashCommandUsed\(/, "计次经唯一接缝")
  assert.match(container, /window\.addEventListener\(SLASH_USAGE_EVENT, refresh\)/, "同页广播")
  assert.match(container, /window\.addEventListener\("storage", onStorage\)/, "别的标签页")
  assert.match(container, /frequentSlashNames\(usage, SLASH_USAGE_MAX_ENTRIES\)/)
  const commands = readFileSync(new URL("../ui/src/chat/slashCommands.ts", import.meta.url), "utf8")
  assert.match(commands, /export const COMMANDS: readonly SlashCommandRow\[\] = \[/)
  assert.equal((commands.match(/\{ key: "/g) || []).length, 19)
})
