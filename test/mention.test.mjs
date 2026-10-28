// P3-4 @提及（路径引用注入）：触发解析 / 候选过滤 / transcript 收集 /
// P7 B2e（决定 17）：读 ComposerCard.tsx 的接线用例删了，改查新界面 ComposerContainer（末尾一条）；mention.ts 的行为用例照旧。
// 定版展开格式 / hasContent 口径的纯逻辑测试。不启动浏览器、不依赖 React；
// Node ≥22.18 直接剥离 TS 类型 import .ts 源文件（与 chapter5-composer 同法）。
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  collectTranscriptFiles,
  expandMentionText,
  filterMentionFiles,
  mentionLabel,
  mergeMentionCandidates,
  MENTION_CANDIDATE_MAX,
  noteViewedFile,
  parseMentionTrigger,
  setViewedRoomKey,
  viewedMentionFiles,
} from "../ui/src/chat/composer/mention.ts"
import { deriveComposer } from "../ui/src/chat/composerMachine.ts"

const file = (path) => ({ path, label: mentionLabel(path) })

/* ---------------- parseMentionTrigger ---------------- */

test("提及触发：行首 @ 与空查询", () => {
  assert.deepEqual(parseMentionTrigger("@", 1), { start: 0, query: "" })
  assert.deepEqual(parseMentionTrigger("@sr", 3), { start: 0, query: "sr" })
})

test("提及触发：空白/中文后的 @ 触发，含路径字符的查询", () => {
  const text = "打开 @src/App.tsx"
  assert.deepEqual(parseMentionTrigger(text, text.length), { start: 3, query: "src/App.tsx" })
  const cjk = "看@sr"
  assert.deepEqual(parseMentionTrigger(cjk, cjk.length), { start: 1, query: "sr" })
})

test("提及触发：邮箱型（ASCII 紧贴）不触发；token 后有空白即闭合", () => {
  const mail = "mail a@b.com"
  assert.equal(parseMentionTrigger(mail, mail.length), null)
  const closed = "@a b"
  assert.equal(parseMentionTrigger(closed, closed.length), null)
  assert.equal(parseMentionTrigger("没有提及", 4), null)
  assert.equal(parseMentionTrigger("", 0), null)
})

test("提及触发：光标在 token 中间时只看到光标前", () => {
  const text = "@src/App.tsx 后文"
  assert.deepEqual(parseMentionTrigger(text, 4), { start: 0, query: "src" })
})

/* ---------------- filterMentionFiles ---------------- */

const CANDIDATES = [file("src/App.tsx"), file("docs/apple.md"), file("src/banana.ts")]

test("候选过滤：空查询回前 N 条（入参顺序）", () => {
  assert.deepEqual(filterMentionFiles(CANDIDATES, "").map((f) => f.path), CANDIDATES.map((f) => f.path))
  assert.equal(filterMentionFiles(CANDIDATES, "", 2).length, 2)
})

test("候选过滤：文件名开头 > 文件名包含 > 路径包含，同档保序", () => {
  assert.deepEqual(
    filterMentionFiles(CANDIDATES, "app").map((f) => f.path),
    ["src/App.tsx", "docs/apple.md"],
  )
  assert.deepEqual(
    filterMentionFiles(CANDIDATES, "src").map((f) => f.path),
    ["src/App.tsx", "src/banana.ts"],
  )
  assert.deepEqual(filterMentionFiles(CANDIDATES, "zzz"), [])
})

/* ---------------- collectTranscriptFiles ---------------- */

function toolBlock(input) {
  return { kind: "tool", id: Math.random().toString(36), name: "read", argsText: "", input, outputText: "", state: "output-available" }
}

test("transcript 收集：最近优先、去重，只认像文件的路径键", () => {
  const items = [
    {
      kind: "assistant",
      key: "a1",
      blocks: [toolBlock({ path: "src/App.tsx" }), toolBlock({ pattern: "foo", path: "src" })],
    },
    { kind: "user", key: "u1", blocks: [] },
    {
      kind: "assistant",
      key: "a2",
      blocks: [
        toolBlock({ file_path: "docs/guide.md" }),
        toolBlock({ path: "src/App.tsx" }),
        toolBlock({ path: "https://example.com/x.ts" }),
        toolBlock({ path: "src/*.ts" }),
        toolBlock({ target: "9f8be4d3a2ca" }),
      ],
    },
  ]
  assert.deepEqual(
    collectTranscriptFiles(items).map((f) => f.path),
    ["docs/guide.md", "src/App.tsx"],
  )
})

test("transcript 收集：无工具入参时为空，不虚构", () => {
  assert.deepEqual(collectTranscriptFiles([]), [])
  assert.deepEqual(collectTranscriptFiles([{ kind: "assistant", key: "a", blocks: [{ kind: "text", text: "看 src/App.tsx" }] }]), [])
})

/* ---------------- viewed 记录与合并 ---------------- */

test("FileViewer 查看记录：最近优先、重复只刷新次序", () => {
  noteViewedFile("x/one.ts")
  noteViewedFile("y/two.ts")
  noteViewedFile("x/one.ts")
  const viewed = viewedMentionFiles()
  assert.deepEqual(viewed.slice(0, 2).map((f) => f.path), ["x/one.ts", "y/two.ts"])
  assert.equal(viewed[0].label, "one.ts")
})

test("候选合并：先到先得、按 path 去重", () => {
  const merged = mergeMentionCandidates([file("a/x.ts")], [file("a/x.ts"), file("b/y.ts")])
  assert.deepEqual(merged.map((f) => f.path), ["a/x.ts", "b/y.ts"])
})

test("查看记录按会话隔离（B-4）：A 房看过的文件不进 B 房", () => {
  noteViewedFile("proj-a/only-a.ts", "room-a")
  noteViewedFile("proj-b/only-b.ts", "room-b")
  assert.deepEqual(viewedMentionFiles("room-a").map((f) => f.path), ["proj-a/only-a.ts"])
  assert.deepEqual(viewedMentionFiles("room-b").map((f) => f.path), ["proj-b/only-b.ts"])
  // 无房号登记走环境房槽（setViewedRoomKey 同步），不落到别的房
  setViewedRoomKey("room-b")
  noteViewedFile("proj-b/second.ts")
  assert.deepEqual(viewedMentionFiles("room-b").map((f) => f.path), ["proj-b/second.ts", "proj-b/only-b.ts"])
  assert.deepEqual(viewedMentionFiles("room-a").map((f) => f.path), ["proj-a/only-a.ts"])
  setViewedRoomKey("")
})

test("候选池整体截断（B-5）：多来源合并后不超过上限 20，先到先得", () => {
  const many = (prefix, n) => Array.from({ length: n }, (_, i) => file(`${prefix}/${i}.ts`))
  const merged = mergeMentionCandidates(many("va", 15), many("vb", 15))
  assert.equal(merged.length, MENTION_CANDIDATE_MAX)
  assert.equal(MENTION_CANDIDATE_MAX, 20)
  assert.deepEqual(merged.slice(0, 15).map((f) => f.path), many("va", 15).map((f) => f.path))
  assert.deepEqual(merged.slice(15).map((f) => f.path), many("vb", 15).slice(0, 5).map((f) => f.path))
})

/* ---------------- expandMentionText（定版格式） ---------------- */

test("展开格式：正文后空一行逐行 @路径引用行", () => {
  assert.equal(expandMentionText("正文", [file("src/App.tsx")]), "正文\n\n@src/App.tsx")
  assert.equal(
    expandMentionText("正文", [file("a/x.ts"), file("b/y.ts")]),
    "正文\n\n@a/x.ts\n@b/y.ts",
  )
})

test("展开格式：正文为空只有引用行；无引用原文返回", () => {
  assert.equal(expandMentionText("", [file("a/x.ts")]), "@a/x.ts")
  assert.equal(expandMentionText("正文", []), "正文")
  assert.equal(expandMentionText("", []), "")
})

/* ---------------- hasContent 口径（composerMachine） ---------------- */

test("hasContent：只有引用 chip、正文为空也可发送", () => {
  const only = deriveComposer({ draft: "", pendingFiles: 1 })
  assert.equal(only.state, "S1")
  assert.equal(only.canSend, true)
})

test("hasContent：引用清空后回落既有口径", () => {
  const none = deriveComposer({ draft: "", pendingFiles: 0 })
  assert.equal(none.state, "S0")
  assert.equal(none.canSend, false)
  assert.equal(none.blockReason, "empty")
})

test("hasContent：引用计入生成中/离线分流（S4/S5）", () => {
  assert.equal(deriveComposer({ draft: "", pendingFiles: 2, generating: true }).state, "S4")
  assert.equal(deriveComposer({ draft: "", pendingFiles: 1, online: false }).state, "S5")
})

/* ---------------- 接线形状（源码断言，与 ui-sync 同法） ---------------- */

test("接线：useRelay 发送区按定版格式展开、facts 带 pendingFiles", () => {
  const source = readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  assert.ok(source.includes("expandMentionText(text, attachedFiles)"), "sendText 应展开引用行")
  assert.ok(source.includes("pendingFiles: pendingFiles.length"), "composerFacts 应带 pendingFiles 计数")
  assert.ok(source.includes("pendingFilesRef.current.length > 0"), "纯引用应放行空正文守卫")
})
test("接线（P7 B2e 改查新界面）：ComposerContainer 用 mention.ts 的候选与引用文案", () => {
  const container = readFileSync(new URL("../ui/src/pi/containers/ComposerContainer.tsx", import.meta.url), "utf8")
  assert.match(container, /import \{ collectTranscriptFiles, mentionLabel, mergeMentionCandidates, viewedMentionFiles \} from "@\/chat\/composer\/mention"/)
})
