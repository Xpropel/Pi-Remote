// 第 4 章对话内容 P0：组模型 / 时间分隔 / 工具展示态 / 内容组件源码门禁。
// 纯 Node 测试；transcript.ts 不依赖 React / DOM，可直接 import（同 streaming-markdown.test.mjs）。
// P7 B2c（决定 17、13）：旧对话部件（chat/parts、style/faces、conversation/*.tsx、components/ui 的 markdown / code-block、conversation.css、皮肤 CSS）删了，
// 只读它们源码 / CSS 的用例删掉（75% 气泡、圆角 18、时间分隔线、ToolCard 34px 等是设计改动）；混合用例只去掉读旧文件的断言。
// transcript / diffModel / attachmentModel / messageActionsModel / remoteImage 的行为用例照旧。新部件的对图在 L1 / L2，灯箱交互在 ui-interact。
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  DIVIDER_GAP_MS,
  dividerFor,
  emptyTranscript,
  formatDivider,
  groupEndAt,
  groupItems,
  groupStartAt,
  isLiveText,
  isLiveThinking,
  reduceTranscript,
  durationOf,
  toolDisplayState,
} from "../ui/src/relay/transcript.ts"
import {
  buildHunkWordDiffs,
  diffFileFoldsByDefault,
  diffFileLabel,
  ellipsizeDiffPath,
  foldHunkLines,
  isDiffCandidate,
  isUnifiedDiff,
  parseUnifiedDiff,
  wordDiffPair,
} from "../ui/src/conversation/diffModel.ts"
import {
  attachmentEntries,
  attachmentLayout,
  attachmentsAreOnlyNotes,
  imageNote,
  isGifMime,
  lightboxImages,
} from "../ui/src/conversation/attachmentModel.ts"
import {
  assistantMarkdown,
  markdownToPlainText,
  messageActionKinds,
  messageCopyValues,
} from "../ui/src/conversation/messageActionsModel.ts"
import {
  REMOTE_IMAGE_LOAD,
  compressedImageText,
  imageLoadErrorText,
  imagePayloadState,
  loadRemoteImage,
  remoteImageCommandArgs,
  remoteImageRef,
} from "../ui/src/conversation/remoteImage.ts"
import {
  directorySummary,
  formatElapsed,
  formatTokenCount,
  languageForPath,
  outputLines,
  outputNeedsFold,
  outputScale,
  pathSummary,
  searchHitsOf,
  stderrLineSet,
  toolHeadline,
  toolKind,
  toolResultDigest,
  urlSummary,
} from "../ui/src/conversation/toolDisplay.ts"

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
/** 源码门禁只看代码，注释里提到“不做删除/引用”不算违规。 */
const codeOf = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const user = (text, timestamp) => ({ kind: "user", key: `u-${text}`, text, images: [], timestamp })
const assistant = (text, timestamp, extra = {}) => ({
  kind: "assistant",
  key: `a-${text}`,
  blocks: [{ kind: "text", text }],
  timestamp,
  ...extra,
})
const tool = (overrides = {}) => ({
  kind: "tool",
  id: "t1",
  name: "bash",
  argsText: "",
  outputText: "",
  state: "input-streaming",
  ...overrides,
})

test("组模型：同角色连续合并；角色切换、summary 独立成组", () => {
  const groups = groupItems([
    user("一", 1),
    user("二", 2),
    assistant("答", 3),
    { kind: "summary", key: "s1", title: "已重连", text: "" },
    { kind: "bash", key: "b1", command: "ls", output: "a", label: "完成" },
    assistant("再答", 4),
  ])
  assert.deepEqual(groups.map((group) => group.role), ["user", "assistant", "system", "assistant"])
  assert.deepEqual(groups.map((group) => group.items.length), [2, 1, 1, 2])
  assert.deepEqual(groups[0].items.map((item) => item.text), ["一", "二"])
  assert.equal(groups[3].items[0].kind, "bash", "bash 和相邻 assistant 同组")
})

test("组模型：assistant 组的时间范围取组内首/末 timestamp；缺失不补", () => {
  const groups = groupItems([user("问", 1000), assistant("答", 2000), assistant("补充", 5000)])
  assert.equal(groupStartAt(groups[0]), 1000)
  assert.equal(groupEndAt(groups[0]), 1000)
  assert.equal(groupStartAt(groups[1]), 2000)
  assert.equal(groupEndAt(groups[1]), 5000)
  const bare = groupItems([{ kind: "user", key: "u", text: "无时间", images: [] }])
  assert.equal(groupStartAt(bare[0]), undefined)
  assert.equal(groupEndAt(bare[0]), undefined)
})

test("时间分隔：无 next 不画；首组 resume；30 分钟/跨日判定", () => {
  const base = new Date(2026, 9, 22, 9, 0, 0).getTime()
  assert.equal(dividerFor(undefined, undefined), null)
  assert.equal(dividerFor(base, undefined), null)
  assert.equal(dividerFor(undefined, base), "resume")
  assert.equal(dividerFor(base, base + DIVIDER_GAP_MS - 1), null)
  assert.equal(dividerFor(base, base + DIVIDER_GAP_MS), "time")
  assert.equal(dividerFor(base, new Date(2026, 9, 23, 9, 0, 0).getTime()), "day", "跨日优先")
  assert.equal(dividerFor(new Date(2026, 9, 22, 23, 50, 0).getTime(), new Date(2026, 9, 23, 0, 5, 0).getTime()), "day")
})

test("时间分隔文案：今天/昨天/同年/跨年，只显示时间点", () => {
  const now = new Date(2026, 9, 22, 15, 30, 0).getTime()
  assert.equal(formatDivider(new Date(2026, 9, 22, 9, 5, 0).getTime(), now), "今天 09:05")
  assert.equal(formatDivider(new Date(2026, 9, 21, 18, 0, 0).getTime(), now), "昨天 18:00")
  assert.equal(formatDivider(new Date(2026, 2, 3, 8, 7, 0).getTime(), now), "3月3日 08:07")
  assert.equal(formatDivider(new Date(2025, 11, 31, 23, 59, 0).getTime(), now), "2025年12月31日 23:59")
  assert.doesNotMatch(formatDivider(new Date(2026, 9, 22, 9, 5, 0).getTime(), now), /分钟|小时|前/)
})

test("快照写入消息 timestamp，定稿后仍保留；TimeDivider 有真实数据可用", () => {
  const stamp = new Date(2026, 9, 22, 9, 0, 0).getTime()
  const state = reduceTranscript(emptyTranscript(), {
    type: "snapshot",
    messages: [
      { role: "user", content: "你好", timestamp: stamp },
      { role: "assistant", content: [{ type: "text", text: "在" }], timestamp: stamp + 1000 },
    ],
  })
  assert.equal(state.items[0].timestamp, stamp)
  assert.equal(state.items[1].timestamp, stamp + 1000)
  const groups = groupItems(state.items)
  assert.equal(dividerFor(undefined, groupStartAt(groups[0])), "resume")
})

test("助手 start/end 与用时：只读 message.timestamp + durationMs，缺失不补，usage 行才显示 m:ss", () => {
  const stamp = new Date(2026, 9, 22, 9, 0, 0).getTime()
  const state = reduceTranscript(emptyTranscript(), {
    type: "snapshot",
    messages: [
      { role: "user", content: "你好", timestamp: stamp },
      { role: "assistant", content: [{ type: "text", text: "在" }], timestamp: stamp + 250, durationMs: 5_300 },
    ],
  })
  const item = state.items[1]
  assert.equal(item.kind, "assistant")
  assert.equal(item.startedAt, stamp + 250)
  assert.equal(item.endedAt, stamp + 250 + 5_300)
  assert.equal(item.durationMs, 5_300)
  assert.equal(item.timestamp, stamp + 250)
  assert.equal(formatElapsed(item.durationMs), "0:05", "usage 与工具耗时统一 m:ss")
  assert.equal(formatElapsed(1_000), "0:01")
  assert.equal(formatElapsed(999), "0:01", "不足 1s 进到 0:01，不出现 0:00")
  assert.equal(formatElapsed(65_000), "1:05")
  assert.equal(formatElapsed(0), "0:00")
  assert.equal(formatElapsed(-1), "0:00")
  assert.equal(formatElapsed(Number.NaN), "0:00")
  assert.equal(durationOf("5300"), undefined, "字符串耗时不算真实字段")

  // 历史消息 / 旧 relay 没有 durationMs：start 仍有，end 与用时都不补。
  const legacy = reduceTranscript(emptyTranscript(), {
    type: "snapshot",
    messages: [{ role: "assistant", content: [{ type: "text", text: "旧消息" }], timestamp: stamp }],
  })
  const oldItem = legacy.items[0]
  assert.equal(oldItem.startedAt, stamp)
  assert.equal(oldItem.endedAt, undefined)
  assert.equal(oldItem.durationMs, undefined)

})

test("工具展示态 8 态：既有 4 态行为不变，queued/审批/拒绝/取消只在数据出现时映射", () => {
  // 既有 4 态：行为必须与收口前完全一致。
  assert.equal(toolDisplayState(tool()), "preparing")
  assert.equal(toolDisplayState(tool({ argsText: '{"command":' })), "preparing", "参数还在流式到达：准备中")
  assert.equal(toolDisplayState(tool({ state: "input-available", input: { command: "ls" } })), "running")
  assert.equal(toolDisplayState(tool({ state: "output-available", outputText: "ok" })), "succeeded")
  assert.equal(toolDisplayState(tool({ state: "output-error", errorText: "bad" })), "failed")
  assert.equal(toolDisplayState(tool({ state: "input-available" })), "running", "没 input 的 input-available 仍是运行中")

  // 未来数据态：一一映射到同名展示态，不从空字段推断。
  assert.equal(toolDisplayState(tool({ state: "queued" })), "queued")
  assert.equal(toolDisplayState(tool({ state: "waiting_approval", input: { command: "rm -rf" } })), "waiting_approval")
  assert.equal(toolDisplayState(tool({ state: "denied", errorText: "用户拒绝" })), "denied")
  assert.equal(toolDisplayState(tool({ state: "cancelled" })), "cancelled")
  assert.equal(toolDisplayState(tool({ state: "unknown-future" })), "preparing", "未知态仍按无参数降级")


})

test("思考/正文的 live 只属于活动尾部，历史 thinking 不跟着后续流式常亮", () => {
  const thinking = { kind: "thinking", text: "想" }
  const text = { kind: "text", text: "答" }
  const toolBlock = tool({ id: "t", state: "output-available", outputText: "ok" })
  assert.equal(isLiveThinking([thinking], 0, true), true)
  assert.equal(isLiveThinking([thinking, text], 0, true), false, "后面有正文：思考已结束")
  assert.equal(isLiveThinking([thinking, toolBlock], 0, true), false, "后面有工具：思考已结束")
  assert.equal(isLiveThinking([text, thinking], 1, false), false)
  assert.equal(isLiveText([text], 0, true), true)
  assert.equal(isLiveText([text, toolBlock], 0, true), false)
  assert.equal(isLiveText([text, { kind: "text", text: "  " }], 0, true), true, "尾部空白文本不抢 live")
})










// ---------------------------------------------------------------------------
// 第 4 章 P2：DiffView / AttachmentGrid / MessageActions
// ---------------------------------------------------------------------------

const MULTI_FILE_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 import x
-const a = 1
+const a = 2
+const b = 3
 export default a
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-bye
-gone
diff --git a/src/before.ts b/src/after.ts
similarity index 100%
rename from src/before.ts
rename to src/after.ts
diff --git a/assets/logo.png b/assets/logo.png
index 5555555..6666666 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`

test("Diff 解析：多文件、新增/删除/重命名/二进制、双行号与增删统计", () => {
  const diff = parseUnifiedDiff(MULTI_FILE_DIFF)
  assert.ok(diff, "完整 unified diff 应能解析")
  assert.equal(diff.files.length, 5)
  assert.deepEqual(diff.files.map((file) => file.status), ["modified", "added", "deleted", "renamed", "binary"])
  assert.equal(diff.files[0].oldPath, "src/app.ts")
  assert.equal(diff.files[0].newPath, "src/app.ts")
  assert.equal(diff.files[1].oldPath, null, "新建文件旧侧为 /dev/null")
  assert.equal(diff.files[2].newPath, null, "删除文件新侧为 /dev/null")
  assert.equal(diff.files[3].oldPath, "src/before.ts")
  assert.equal(diff.files[3].newPath, "src/after.ts")
  assert.equal(diff.files[3].hunks.length, 0)
  assert.equal(diff.files[4].binary, true)
  assert.equal(diff.additions, 4)
  assert.equal(diff.deletions, 3)
  assert.equal(diff.hunkCount, 3)
  assert.equal(diff.binaryFiles, 1)

  const lines = diff.files[0].hunks[0].lines
  const removed = lines.find((line) => line.kind === "remove")
  const added = lines.filter((line) => line.kind === "add")
  assert.deepEqual({ old: removed.oldLine, next: removed.newLine }, { old: 2, next: null })
  assert.deepEqual(added.map((line) => ({ old: line.oldLine, next: line.newLine })), [
    { old: null, next: 2 },
    { old: null, next: 3 },
  ])
  assert.equal(lines[0].oldLine, 1)
  assert.equal(lines[0].newLine, 1)
  assert.equal(lines.at(-1).oldLine, 3)
  assert.equal(lines.at(-1).newLine, 4)
  assert.equal(diffFileLabel(diff.files[2]), "src/old.ts")
  assert.equal(diffFileLabel(diff.files[3]), "src/after.ts")
})

test("Diff 解析失败：普通代码/解释文字/行数不符/空 diff 一律返回 null，不猜", () => {
  assert.equal(parseUnifiedDiff("const value = 1\nconsole.log(value)\n"), null)
  assert.equal(parseUnifiedDiff("Applied changes:\ndiff --git a/a.ts b/a.ts\n"), null, "前置解释文字不吞掉当 diff")
  assert.equal(
    parseUnifiedDiff("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n only one\n"),
    null,
    "hunk 行数与声明不符时降级",
  )
  assert.equal(parseUnifiedDiff("diff --git a/a.ts b/a.ts\nindex 1..2\n"), null, "没有任何变更事实")
  assert.equal(parseUnifiedDiff("@@ -1 +1 @@\n-x\n+y\n"), null, "没有文件头")
  assert.equal(parseUnifiedDiff(""), null)
  assert.equal(isUnifiedDiff("plain code"), false)
  assert.equal(isUnifiedDiff(MULTI_FILE_DIFF), true)
  assert.equal(isDiffCandidate("const value = 1"), false)
  assert.equal(isDiffCandidate("\n\ndiff --git a/a b/a"), true)
  assert.equal(isDiffCandidate("--- a/a"), true)
  assert.ok(parseUnifiedDiff(MULTI_FILE_DIFF.replace(/\n/g, "\r\n")), "CRLF diff 也可解析")

  const noNewline = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "\\ No newline at end of file",
    "+new",
    "\\ No newline at end of file",
  ].join("\n")
  const parsed = parseUnifiedDiff(noNewline)
  assert.ok(parsed)
  assert.equal(parsed.files[0].hunks[0].lines.length, 2)
})

test("Diff 上下文折叠：超过 2×context 的连续 context 变成可展开 gap", () => {
  const lines = []
  for (let index = 1; index <= 12; index += 1) {
    lines.push({ kind: "context", text: `ctx-${index}`, oldLine: index, newLine: index })
  }
  lines.push({ kind: "add", text: "new", oldLine: null, newLine: 13 })
  for (let index = 13; index <= 24; index += 1) {
    lines.push({ kind: "context", text: `ctx-${index}`, oldLine: index, newLine: index + 1 })
  }
  const rows = foldHunkLines(lines, 3)
  const gaps = rows.filter((row) => row.kind === "gap")
  assert.equal(gaps.length, 2)
  assert.deepEqual(gaps.map((gap) => gap.count), [6, 6])
  assert.equal(gaps.reduce((total, gap) => total + gap.hidden.length, 0), 12, "隐藏的上下文可在原地展开")
  assert.equal(rows.filter((row) => row.kind === "line").length, 13)
  assert.equal(foldHunkLines(lines, 7).filter((row) => row.kind === "gap").length, 0, "上下文阈值变大则全部显示")
})

test("Diff 文件头：路径中间省略、默认折叠阈值、删除文件默认收起", () => {
  assert.equal(ellipsizeDiffPath("src/app.ts"), "src/app.ts")
  assert.equal(ellipsizeDiffPath("src/features/chat/components/App.tsx"), "src/…/components/App.tsx")
  const deleted = { oldPath: "src/old.ts", newPath: null, binary: false, hunks: [], additions: 0, deletions: 3 }
  assert.equal(diffFileFoldsByDefault(deleted, 0, 1), true)
  const huge = { oldPath: "src/a.ts", newPath: "src/a.ts", binary: false, hunks: [], additions: 150, deletions: 51 }
  assert.equal(diffFileFoldsByDefault(huge, 0, 1), true)
  const small = { oldPath: "src/a.ts", newPath: "src/a.ts", binary: false, hunks: [], additions: 3, deletions: 1 }
  assert.equal(diffFileFoldsByDefault(small, 0, 1), false)
  assert.equal(diffFileFoldsByDefault(small, 5, 6), true, "第 6 个文件起默认折叠")
  assert.equal(diffFileFoldsByDefault({ ...small, binary: true }, 0, 1), false, "二进制文件头不折叠")
})

test("附件布局：1 张单图 / 2–4 两列 / 5+ 首图跨列；占位文案与 GIF 有数据来源", () => {
  assert.equal(attachmentLayout(1), "single")
  assert.equal(attachmentLayout(2), "grid")
  assert.equal(attachmentLayout(4), "grid")
  assert.equal(attachmentLayout(5), "hero")
  assert.equal(attachmentLayout(9), "hero")

  const image = { data: "QUJD", mimeType: "image/png" }
  const gif = { data: "R0lGOD", mimeType: "image/gif" }
  const huge = { data: "", mimeType: "image/jpeg", omitted: true, bytes: 1_258_291 }
  const missing = { data: "", mimeType: "image/png" }
  const entries = attachmentEntries([image, gif, huge, missing])
  assert.equal(entries[0].kind, "image")
  assert.match(entries[0].src, /^data:image\/png;base64,/)
  assert.equal(entries[1].gif, true)
  assert.equal(isGifMime("IMAGE/GIF"), true)
  assert.equal(entries[2].kind, "omitted")
  assert.match(entries[2].note, /图片过大未传输（1\.2 MB），请在本机查看/)
  assert.equal(entries[3].kind, "omitted")
  assert.equal(entries[3].note, "图片未传输")
  assert.equal(imageNote(huge), "图片过大未传输（1.2 MB），请在本机查看")
  assert.equal(attachmentsAreOnlyNotes(entries), false)
  assert.equal(attachmentsAreOnlyNotes([{ kind: "omitted", key: "a", note: "图片未传输", mimeType: "image/png" }]), true)
  assert.equal(lightboxImages(entries).length, 2, "占位条目不能进 Lightbox 翻页")
})

test("按需补拉：entryId+blockIndex 原样发 get_image；成功替换 data URL，失败/压缩给可读说明", async () => {
  const ref = { entryId: "e1", blockIndex: 2 }
  assert.deepEqual(remoteImageCommandArgs(ref), { entryId: "e1", blockIndex: 2 })
  assert.deepEqual(remoteImageRef({ entryId: " e1 ", blockIndex: "2" }), ref, "空白 entryId 与数字字符串按后端口径归一")

  const seen = []
  const ready = await loadRemoteImage(ref, async (lookup) => {
    seen.push(remoteImageCommandArgs(lookup))
    return { entryId: "e1", blockIndex: 2, mimeType: "image/png", bytes: 3, data: "QUJD", compressed: false }
  })
  assert.deepEqual(seen, [{ entryId: "e1", blockIndex: 2 }], "只发 entryId/blockIndex，不夹带其他字段")
  assert.equal(ready.phase, "ready")
  assert.equal(ready.src, "data:image/png;base64,QUJD", "成功后替换成真正的原图 data URL")
  assert.equal(ready.mimeType, "image/png")

  const tooLarge = Object.assign(new Error("结果过大"), { code: "payload_too_large" })
  const failed = await loadRemoteImage(ref, async () => {
    throw tooLarge
  })
  assert.equal(failed.phase, "error")
  assert.match(failed.error, /单帧上限/)
  assert.equal(failed.src, undefined, "失败时不生成假图")

  const missing = await loadRemoteImage(ref, async () => {
    throw Object.assign(new Error("not found"), { code: "not_found" })
  })
  assert.equal(missing.phase, "error")
  assert.match(missing.error, /找不到这张原图/)

  const compressed = await loadRemoteImage(ref, async () => ({
    entryId: "e1",
    blockIndex: 2,
    mimeType: "image/jpeg",
    bytes: 9_000_000,
    data: "",
    omitted: true,
    omittedBytes: 9_000_000,
    compressed: true,
  }))
  assert.equal(compressed.phase, "compressed")
  assert.equal(compressed.src, undefined, "compressed 占位绝不拼 data URL")
  assert.match(compressed.error, /超过网页端单帧上限/)
  assert.match(compressed.error, /8\.6 MB/)
  assert.equal(imagePayloadState({ compressed: true, mimeType: "image/png", data: "QUJD" }).src, undefined, "标了 compressed 就不伪造原图")
  assert.equal(imagePayloadState({ omitted: true, mimeType: "image/png", data: "" }).phase, "error")
  assert.match(imageLoadErrorText(Object.assign(new Error("x"), { code: "unknown_command" })), /更新扩展/)
  const offline = await loadRemoteImage(ref, null)
  assert.match(offline.error, /还没有连上会话/)
})

test("按需补拉只在定位完整时给动作：无 entryId/坏 blockIndex 仍是不可点的本机占位", () => {
  const omitted = { data: "", mimeType: "image/png", omitted: true, bytes: 1_258_291 }
  assert.equal(remoteImageRef(omitted), null)
  assert.equal(remoteImageRef({ ...omitted, entryId: "e1" }), null)
  assert.equal(remoteImageRef({ ...omitted, blockIndex: 0 }), null)
  assert.equal(remoteImageRef({ ...omitted, entryId: "e1", blockIndex: 1.5 }), null)
  assert.equal(remoteImageRef({ ...omitted, entryId: "e1", blockIndex: -1 }), null)

  const staticEntry = attachmentEntries([omitted])[0]
  assert.equal(staticEntry.kind, "omitted")
  assert.equal(staticEntry.remote, undefined)
  assert.equal(staticEntry.shotIndex, undefined)
  assert.equal(staticEntry.note, "图片过大未传输（1.2 MB），请在本机查看")
  assert.equal(attachmentsAreOnlyNotes([staticEntry]), true, "无定位时整组保持 readonly 占位")

  const loadable = attachmentEntries([{ ...omitted, entryId: "e1", blockIndex: 2 }])
  assert.equal(loadable[0].kind, "omitted")
  assert.deepEqual(loadable[0].remote, { entryId: "e1", blockIndex: 2 })
  assert.equal(loadable[0].shotIndex, 0, "可补拉占位进 Lightbox 翻页表")
  assert.equal(loadable[0].note, "图片过大未传输（1.2 MB）", "有补拉动作时不再显示“请在本机查看”")
  assert.equal(attachmentsAreOnlyNotes(loadable), false)
  assert.equal(lightboxImages(loadable).length, 1)
  assert.deepEqual(lightboxImages(loadable)[0].remote, { entryId: "e1", blockIndex: 2 })
  assert.equal(lightboxImages(loadable)[0].src, "", "Lightbox 打开前没有原图数据")
  assert.match(compressedImageText(1_258_291), /1\.2 MB/)

  const mixed = attachmentEntries([
    { data: "QUJD", mimeType: "image/png" },
    { ...omitted, entryId: "e1", blockIndex: 2 },
    omitted,
  ])
  assert.equal(mixed[0].shotIndex, 0)
  assert.equal(mixed[1].shotIndex, 1)
  assert.equal(mixed[2].shotIndex, undefined)
  assert.equal(lightboxImages(mixed).length, 2, "只有真实图和可定位占位进查看器")
})

test("按需补拉源码：占位命令 get_image、Lightbox 加载/错误/压缩态、移动端与不预取", () => {
  const relay = source("../ui/src/relay/useRelay.ts")
  const remote = source("../ui/src/conversation/remoteImage.ts")

  assert.match(relay, /const getImage = useCallback/)
  assert.match(relay, /runCommand\("get_image", \{ entryId: id, blockIndex \}\)/)
  assert.match(relay, /setRemoteImageLoader/)
  assert.match(relay, /Number\.isInteger\(blockIndex\)/, "前端也拒绝坏 blockIndex")
  assert.match(relay, /\n\s+getImage,/)
  assert.match(remote, /export function remoteImageRef/)
  assert.match(remote, /export async function loadRemoteImage/)
  assert.match(remote, /export function compressedImageText/)
})

test("操作行文案：助手复制 Markdown/纯文本，用户复制原文；动作白名单不伪造命令", () => {
  const blocks = [
    { kind: "thinking", text: "内部推理" },
    { kind: "text", text: "## 标题" },
    { kind: "tool", text: "工具输出" },
    { kind: "text", text: "正文 **重点** 与 [文档](https://example.com)" },
  ]
  assert.equal(assistantMarkdown(blocks), "## 标题\n\n正文 **重点** 与 [文档](https://example.com)")
  assert.equal(markdownToPlainText("## 标题\n\n正文 **重点** 与 [文档](https://example.com)"), "标题\n\n正文 重点 与 文档 (https://example.com)")
  assert.deepEqual(messageCopyValues("user", "  原样  "), { markdown: "  原样  ", plain: "  原样  " })
  assert.deepEqual(messageCopyValues("assistant", blocks), {
    markdown: "## 标题\n\n正文 **重点** 与 [文档](https://example.com)",
    plain: "标题\n\n正文 重点 与 文档 (https://example.com)",
  })

  assert.deepEqual(messageActionKinds({ kind: "assistant", live: true }), [], "流式中不出操作行")
  assert.deepEqual(messageActionKinds({ kind: "assistant", hasPlainDifference: true }), ["copy", "copy-plain"])
  assert.deepEqual(messageActionKinds({ kind: "user" }), ["copy"])
  assert.deepEqual(messageActionKinds({ kind: "user", failed: true, canRetry: true }), ["copy", "retry"])
  assert.deepEqual(messageActionKinds({ kind: "user", failed: true, canRetry: false }), ["copy"], "不能重试时不放禁用假动作")
  assert.deepEqual(messageActionKinds({ kind: "assistant", hasImages: true }), ["copy", "open-image"])
  assert.deepEqual(messageActionKinds({ kind: "assistant", hasContent: false }), [], "空回复不画复制按钮")
  assert.deepEqual(messageActionKinds({ kind: "user", hasContent: false }), [], "纯图片用户消息没有可复制正文")
  assert.deepEqual(
    messageActionKinds({ kind: "user", failed: true, canRetry: true, hasContent: false }),
    ["retry"],
    "空正文的失败消息仍保留重试",
  )
  for (const action of messageActionKinds({ kind: "assistant", hasPlainDifference: true, failed: true, canRetry: true, hasImages: true })) {
    assert.equal(["copy", "copy-plain", "retry", "open-image"].includes(action), true, `${action} 必须有真实能力`)
  }
})





// ---------------------------------------------------------------------------
// 第 2/3 章 V2：工具展示模型、输出折叠、词级 diff
// ---------------------------------------------------------------------------

test("工具文法：动词 + 对象、路径/命令/搜索/URL 摘要，未知工具退回真名", () => {
  assert.equal(toolKind("read_file"), "read")
  assert.equal(toolKind("write_file"), "write")
  assert.equal(toolKind("apply_patch"), "edit")
  assert.equal(toolKind("ripgrep"), "search")
  assert.equal(toolKind("list_dir"), "list")
  assert.equal(toolKind("fetch_url"), "fetch")
  assert.equal(toolKind("mcp__calendar__list"), "other")

  assert.deepEqual(
    toolHeadline({ name: "bash", input: { command: "npm  run\n  test" } }, "running"),
    { verb: "运行", object: "npm run", fallback: false, muted: false },
    "命令取首行、空白折叠",
  )
  assert.deepEqual(
    toolHeadline({ name: "read", input: { path: "ui/src/components/ui/faces.tsx" } }, "succeeded"),
    { verb: "读取", object: "ui/src/…/faces.tsx", fallback: false, muted: false },
  )
  assert.equal(pathSummary("src/relay/store.ts"), "src/relay/store.ts", "三段以内不省略")
  assert.equal(directorySummary("deploy"), "deploy/")
  assert.equal(urlSummary("https://example.com/docs/start"), "example.com/docs")
  assert.deepEqual(
    toolHeadline({ name: "bash", argsText: '{"command":' }, "preparing"),
    { verb: null, object: "准备参数…", fallback: false, muted: true },
    "半截 JSON 不当摘要",
  )
  assert.deepEqual(
    toolHeadline({ name: "mcp__calendar__list" }, "running"),
    { verb: null, object: "mcp__calendar__list", fallback: true, muted: false },
  )
})

test("结果摘要：退出码/stderr 只在有数据时出现，空输出/搜索/读写各按真实字段", () => {
  const base = { name: "bash", outputText: "a\nb\nc" }
  assert.equal(toolResultDigest({ ...base, exitCode: 0 }, "succeeded"), "3 行 · 5 B")
  assert.equal(toolResultDigest({ ...base, exitCode: 1 }, "succeeded"), "退出 1 · 3 行 · 5 B")
  assert.equal(toolResultDigest({ ...base, exitCode: 0, stderr: "warn" }, "succeeded"), "退出 0 · 3 行 · 5 B")
  assert.equal(toolResultDigest({ name: "bash", outputText: "" }, "succeeded"), "无输出")
  assert.equal(toolResultDigest({ name: "bash", outputText: "" }, "running"), null)
  assert.equal(toolResultDigest({ name: "bash", outputText: "bad", exitCode: 2 }, "failed"), "退出 2 · 1 行")
  assert.equal(toolResultDigest({ name: "read", outputText: "x\ny" }, "succeeded"), "2 行")
  assert.equal(toolResultDigest({ name: "edit", outputText: "" }, "succeeded", { additions: 12, deletions: 3 }), "+12 −3")
  assert.equal(
    toolResultDigest(
      { name: "grep", outputText: "src/a.ts:3: hit\nsrc/a.ts:8: hit\nsrc/b.ts:1: x" },
      "succeeded",
    ),
    "3 处 · 2 个文件",
  )
  assert.deepEqual(searchHitsOf("src/a.ts:3: hit\nsrc/b.ts:1: x"), { hits: 2, files: 2 })
  assert.equal(searchHitsOf("no structured matches"), null)
})

test("输出区：>10 行 / >6000 字符折叠，stderr 行级标记，语言从路径来", () => {
  assert.deepEqual(outputLines("a\n\nb\n"), ["a", "", "b"])
  assert.equal(outputNeedsFold(Array.from({ length: 10 }, (_, i) => `L${i}`).join("\n")), false)
  assert.equal(outputNeedsFold(Array.from({ length: 11 }, (_, i) => `L${i}`).join("\n")), true)
  assert.equal(outputNeedsFold("x".repeat(6001)), true)
  assert.deepEqual([...stderrLineSet("warn\nbad")], ["warn", "bad"])
  assert.equal(stderrLineSet(undefined).size, 0)
  assert.equal(outputScale("a\nb\n").lines, 2)
  assert.equal(outputScale("a\nb\n").size, "4 B")
  assert.equal(languageForPath("src/App.tsx"), "tsx")
  assert.equal(languageForPath("README.md"), "markdown")
  assert.equal(languageForPath("unknown"), "plaintext")
  assert.equal(formatElapsed(320), "0:01")
  assert.equal(formatElapsed(3200), "0:03")
  assert.equal(formatElapsed(65000), "1:05")
  assert.equal(formatTokenCount(999), "999")
  assert.equal(formatTokenCount(1000), "1k")
  assert.equal(formatTokenCount(3200), "3.2k")
  assert.equal(formatTokenCount(12345), "12.3k")
  assert.equal(formatTokenCount(123456), "123k")
  assert.equal(formatTokenCount(0), "")
})

test("词级 diff：公共前后缀保留、相似度 <0.5 不配对、粘性槽源码", () => {
  const pair = wordDiffPair("const total = 1", "const total = 2")
  assert.ok(pair)
  assert.equal(pair.old.map((segment) => segment.text).join(""), "const total = 1")
  assert.equal(pair.new.map((segment) => segment.text).join(""), "const total = 2")
  assert.deepEqual(
    pair.old.filter((segment) => segment.changed).map((segment) => segment.text),
    ["1"],
  )
  assert.deepEqual(
    pair.new.filter((segment) => segment.changed).map((segment) => segment.text),
    ["2"],
  )
  assert.equal(wordDiffPair("aaaa", "bbbb"), null, "整行重写不做悬空词高亮")

  const diff = parseUnifiedDiff(MULTI_FILE_DIFF)
  assert.ok(diff)
  const map = buildHunkWordDiffs(diff.files[0].hunks[0].lines)
  assert.ok(map.size >= 2)
  const added = diff.files[0].hunks[0].lines.find((line) => line.kind === "add")
  assert.ok(map.get(added)?.some((segment) => segment.changed))
  for (const contextLine of diff.files[0].hunks[0].lines.filter((line) => line.kind === "context")) {
    assert.equal(map.has(contextLine), false, "上下文行没有词高亮")
  }

})




test("工具结果展示字段：只透出真实 exitCode/stderr，缺失不猜", () => {
  const state = reduceTranscript(emptyTranscript(), {
    type: "snapshot",
    messages: [
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }] },
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "bash",
        content: [{ type: "text", text: "oops" }],
        details: { exit_code: 2, stderr: "oops" },
        isError: true,
      },
    ],
  })
  const toolBlock = state.items.flatMap((item) => (item.kind === "assistant" ? item.blocks : [])).find((block) => block.kind === "tool")
  assert.equal(toolBlock.exitCode, 2)
  assert.equal(toolBlock.stderr, "oops")

  const bare = reduceTranscript(emptyTranscript(), {
    type: "snapshot",
    messages: [
      { role: "assistant", content: [{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "ls" } }] },
      { role: "toolResult", toolCallId: "t2", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false },
    ],
  })
  const bareBlock = bare.items.flatMap((item) => (item.kind === "assistant" ? item.blocks : [])).find((block) => block.kind === "tool")
  assert.equal(bareBlock.exitCode, undefined)
  assert.equal(bareBlock.stderr, undefined)
})
