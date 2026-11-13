// 追问框的 @ 引用写进句子（desk-18：不再把词从句子里抽走）与「打开排队面板并直接编辑第 N 条」。
// 纯函数直接跑（components/pi/composer/mentionInline.ts）；接线看源码。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { inlineMentionRanges, insertMentionAt, mentionFitsInline, mentionPathsIn } from "../ui/src/components/pi/composer/mentionInline.ts"

const read = (p) => fs.readFileSync(new URL(`../ui/src/${p}`, import.meta.url), "utf8")
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
/** 光标用 | 标在字符串里 */
const at = (marked) => ({ draft: marked.replace("|", ""), caret: marked.indexOf("|") })
const show = ({ draft, caret }) => `${draft.slice(0, caret)}|${draft.slice(caret)}`
const pick = (marked, path) => {
  const { draft, caret } = at(marked)
  return show(insertMentionAt(draft, draft.lastIndexOf("@", caret - 1), caret, path))
}

describe("insertMentionAt：引用插在光标处，句子其余部分留着", () => {
  test("句中（后面是空格）：不补空格，光标跳过原有的空格", () => {
    assert.equal(pick("看看 @fo| 里的函数", "src/format.js"), "看看 @src/format.js |里的函数")
  })
  test("紧贴中文：补一个空格隔开，后面的中文一个字不少", () => {
    assert.equal(pick("看看@fo|里的函数", "src/format.js"), "看看@src/format.js |里的函数")
  })
  test("句尾：补空格，光标在最后（光标前不再是 @ 查询，菜单收起）", () => {
    assert.equal(pick("改一下 @fo|", "src/format.js"), "改一下 @src/format.js |")
  })
  test("刚打下 @（空查询）也行；前后文字都在", () => {
    assert.equal(pick("先读 @| 再改", "README.md"), "先读 @README.md |再改")
  })
  test("光标停在词中间：光标后紧接的路径字符算同一个词一起换掉，标点和中文不动", () => {
    assert.equal(pick("@fo|rmat.js，然后", "src/format.js"), "@src/format.js |，然后")
    assert.equal(pick("看 @fo|.ts 吧", "src/foo.ts"), "看 @src/foo.ts |吧")
  })
  test("后面是换行：补空格，光标不跳到下一行", () => {
    assert.equal(pick("@fo|\n第二行", "a.ts"), "@a.ts |\n第二行")
  })
  test("越界的 start / caret 收进草稿范围", () => {
    assert.deepEqual(insertMentionAt("ab", 5, 9, "x.ts"), { draft: "ab@x.ts ", caret: 8 })
  })
})

describe("mentionFitsInline：带空白的路径不写进句子", () => {
  test("普通路径可以，带空格 / 空串不行", () => {
    assert.equal(mentionFitsInline("src/a.ts"), true)
    assert.equal(mentionFitsInline("D:\\pi-e2e\\s4\\format.js"), true)
    assert.equal(mentionFitsInline("my notes.md"), false)
    assert.equal(mentionFitsInline(""), false)
  })
})

describe("inlineMentionRanges：句子里哪些 @ 是引用（给 pill 高亮层）", () => {
  const pool = ["src/a.ts", "b.md", "my notes.md"]
  const words = (draft, p = pool) => inlineMentionRanges(draft, p).map((r) => draft.slice(r.start, r.end))
  test("认出候选池里的路径；后面跟中文标点也算词界", () => {
    assert.deepEqual(words("看 @src/a.ts 和 @b.md。"), ["@src/a.ts", "@b.md"])
    assert.deepEqual(words("看看@src/a.ts里的"), ["@src/a.ts"])
  })
  test("邮箱型（@ 前紧贴 ASCII 字母）不算；只是前缀（@src/a.tsx）不算；池里没有的不算", () => {
    assert.deepEqual(words("me@src/a.ts"), [])
    assert.deepEqual(words("@src/a.tsx"), [])
    assert.deepEqual(words("@other.ts"), [])
  })
  test("同一处取最长的路径；带空白的路径不参与", () => {
    assert.deepEqual(words("@src/a.ts ok", ["src/a", "src/a.ts"]), ["@src/a.ts"])
    assert.deepEqual(words("@my notes.md"), [])
  })
  test("没有 @ 或池为空：空数组", () => {
    assert.deepEqual(inlineMentionRanges("没有引用", pool), [])
    assert.deepEqual(inlineMentionRanges("@src/a.ts", []), [])
  })
})

describe("mentionPathsIn：会话目录里的文件用相对路径", () => {
  test("Windows：目录内的绝对路径改相对、正斜杠；大小写、分隔符、目录末尾斜杠都不计", () => {
    assert.deepEqual(mentionPathsIn(["D:\\pi-e2e\\s4\\src\\format.js"], "D:\\pi-e2e\\s4", "windows"), ["src/format.js"])
    assert.deepEqual(mentionPathsIn(["d:/PI-E2E/s4/README.md"], "D:\\pi-e2e\\s4\\", "windows"), ["README.md"])
  })
  test("目录外的、相对的、目录本身、只是同前缀的兄弟目录：原样留着", () => {
    const cwd = "D:\\pi-e2e\\s4"
    assert.deepEqual(
      mentionPathsIn(["D:\\other\\a.ts", "src\\b.ts", "D:\\pi-e2e\\s4", "D:\\pi-e2e\\s40\\c.ts"], cwd, "windows"),
      ["D:\\other\\a.ts", "src\\b.ts", "D:\\pi-e2e\\s4", "D:\\pi-e2e\\s40\\c.ts"],
    )
  })
  test("改完重复的只留第一条（工具入参写相对、文件视图写绝对）", () => {
    assert.deepEqual(mentionPathsIn(["src/a.ts", "D:\\proj\\src\\a.ts", "D:\\proj\\b.ts"], "D:\\proj", "windows"), ["src/a.ts", "b.ts"])
  })
  test("Linux 区分大小写、反斜杠不当分隔符；macOS 不分大小写", () => {
    assert.deepEqual(mentionPathsIn(["/home/u/proj/src/a.ts", "/home/u/Proj/b.ts"], "/home/u/proj", "linux"), ["src/a.ts", "/home/u/Proj/b.ts"])
    assert.deepEqual(mentionPathsIn(["/Users/u/Proj/a.ts"], "/Users/u/proj/", "macos"), ["a.ts"])
  })
  test("没有会话目录：原样返回", () => {
    assert.deepEqual(mentionPathsIn(["D:\\proj\\a.ts"], "", "windows"), ["D:\\proj\\a.ts"])
    assert.deepEqual(mentionPathsIn(["/a.ts"], null), ["/a.ts"])
  })
  test("接线：ComposerContainer 的候选池按当前会话的目录和设备平台改写（菜单、句子里的 pill、chip 同一个池）", () => {
    const src = code(read("pi/containers/ComposerContainer.tsx"))
    assert.match(src, /const sessionCwd = sessionRoom\?\.cwd \?\? sessionLazy\?\.cwd \?\? ""/)
    assert.match(src, /mentionPathsIn\(mergeMentionCandidates\(collectTranscriptFiles\(items\), viewedMentionFiles\(roomId\)\)\.map\(\(f\) => f\.path\), sessionCwd, sessionPlatform\)/)
    assert.match(src, /mentionPool=\{mentionPool\}/)
  })
})

describe("接线：@ 菜单选中走行内插入，chip 只留给写不进句子的路径", () => {
  test("useComposerAssist.select：能写进句子 → insertMentionAt；否则去掉查询 + addMention", () => {
    const src = code(read("components/pi/composer/useComposerAssist.ts"))
    const sel = src.slice(src.indexOf("const select = (index: number) => {"), src.indexOf("const onKeyDown ="))
    assert.match(sel, /if \(mentionFitsInline\(path\)\) \{\s*const next = insertMentionAt\(o\.draft, trigger\.start, o\.caret, path\)\s*o\.setDraft\(next\.draft, next\.caret\)\s*return\s*\}/)
    assert.match(sel, /removeMentionQuery\(o\.draft, trigger\.start, o\.caret\)[\s\S]*o\.addMention\(path\)/)
  })
  test("PiFollowUpComposer：输入框底下垫 pill 层（读屏不读、不挡点击），输入框 relative 画在上面，滚动同步", () => {
    const src = code(read("components/pi/composer/PiFollowUpComposer.tsx"))
    assert.match(src, /inlineMentionRanges\(value, mentionPool \?\? \[\]\)/)
    const layer = src.slice(src.indexOf('data-slot="pi-composer-field"'), src.indexOf("<textarea", src.indexOf('data-slot="pi-composer-field"')))
    assert.match(layer, /aria-hidden/)
    assert.match(layer, /data-slot="pi-composer-mention-pills"/)
    assert.match(layer, /pointer-events-none absolute inset-0 overflow-hidden text-transparent/)
    assert.match(layer, /twoLayer \? "break-words whitespace-pre-wrap" : "py-\[11px\] whitespace-pre"/, "折行与内距同输入框")
    assert.match(layer, /<mark className=\{MENTION_PILL\}>/)
    assert.match(src, /"relative block w-full min-w-0 resize-none/)
    assert.match(src, /onScroll=\{syncPills\}/)
    assert.match(src, /const MENTION_PILL = "[^"]*bg-\(--cw-link-chip-bg\)[^"]*"/, "pill 用引用 chip 的蓝底变量")
  })
})

describe("「打开排队面板并直接编辑第 N 条」", () => {
  test("cShared.openQueueEdit：手机开排队 sheet、桌面开排队面板，arg = 条目 id", () => {
    const src = code(read("pi/containers/cShared.ts"))
    const start = src.indexOf("export function openQueueEdit(")
    const fn = src.slice(start, src.indexOf("\n}\n", start))
    assert.match(fn, /if \(variant === "phone"\) act\.openSheet\(\{ id: C_IDS\.queue, arg: queueId \}\)/)
    assert.match(fn, /else act\.openMenu\(\{ id: C_IDS\.queue, arg: queueId \}\)/)
  })
  test("桌面 dock 读 ui.menu.arg、手机 sheet 读 ui.sheet.arg：进入那一条的编辑后去掉 arg（同一条可以再点）", () => {
    const src = code(read("pi/containers/ComposerContainer.tsx"))
    assert.match(src, /useQueueEditRequest\(!phone && menuId === C_IDS\.queue \? ui\.menu\?\.arg : undefined, queue, \(\) => act\.openMenu\(\{ id: C_IDS\.queue \}\)\)/)
    assert.match(src, /useQueueEditRequest\(sheetId === C_IDS\.queue \? ui\.sheet\?\.arg : undefined, queue, \(\) => act\.openSheet\(\{ id: C_IDS\.queue \}\)\)/)
    const hook = src.slice(src.indexOf("function useQueueEditRequest("), src.indexOf("const EMPTY_MENTION_POOL"))
    assert.match(hook, /if \(!arg\) return/)
    assert.match(hook, /if \(q\.editing\?\.id !== arg\) q\.beginEdit\(arg\)\s*drop\(\)/)
    assert.match(hook, /\}, \[arg\]\)/)
    assert.match(src, /^\s*beginEdit,$/m, "useQueue 交出 beginEdit")
  })
  test("PiQueuePanel：编辑框就绪（新进入 / 全文拉到 / 保存失败回来）时拿到焦点、光标在末尾", () => {
    const src = code(read("components/pi/composer/PiQueuePanel.tsx"))
    assert.match(src, /const editReadyId = !isStatic && editing\?\.phase === "ready" \? editing\.id : null/)
    assert.match(src, /el\.focus\(\)\s*el\.setSelectionRange\(el\.value\.length, el\.value\.length\)\s*\}, \[editReadyId\]\)/)
    assert.match(src, /<textarea\s+ref=\{editRef\}\s+data-cw-id="pi-queue-edit"/)
  })
})
