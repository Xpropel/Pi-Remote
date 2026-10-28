// P4 b 线（R2/p4-lanes.md §6 b）：渲染窗 / 新消息计数、审批卡播报、语言显示名的纯函数，加几条源码契约检查。
// 交互行为本身（吸底、灯箱焦点、pane 切换）在 #/play 上由 R2/tools/ui-interact.mjs 的 interact-cases/p4-b.mjs 验，不在这里。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { lastKeyOf, newItemsAfter, PI_TRANSCRIPT_WINDOW, showEarlierText, transcriptWindowOf } from "../ui/src/pi/model/transcriptWindow.ts"
import {
  APPROVAL_ANNOUNCE_IDLE,
  APPROVAL_WARN_MS,
  approvalAnnounceStep,
  approvalQuestionOf,
} from "../ui/src/pi/model/approvalAnnounce.ts"
import { fileLangLabelOf, highlightLabelOf } from "../ui/src/pi/model/highlight.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8")
/** 去掉 /* *\/ 和 // 注释 */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
function walk(dir, pred, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, pred, out)
    else if (pred(p)) out.push(p)
  }
  return out
}
const items = (n, prefix = "k") => Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}` }))

describe("渲染窗与新消息计数（D01 / D21）", () => {
  // P7 B2h：旧界面 chat/parts.tsx 删了，不再拿它的 TRANSCRIPT_PAGE 对照，数值直接钉
  test("渲染窗每页 300 条（原来和旧界面 chat/parts.tsx 的 TRANSCRIPT_PAGE 一致）", () => {
    assert.equal(PI_TRANSCRIPT_WINDOW, 300)
  })

  test("不到 300 条：全挂，没有窗外", () => {
    const list = items(120)
    const w = transcriptWindowOf(list, PI_TRANSCRIPT_WINDOW)
    assert.equal(w.visible, list, "不切片时原样返回同一个数组")
    assert.equal(w.hidden, 0)
    assert.equal(w.nextPage, 0)
  })

  test("1 万条：挂最后 300 条，窗外 9700，下一页 300；最后一页不足 300 时按剩余条数", () => {
    const list = items(10_000)
    const w = transcriptWindowOf(list, 300)
    assert.equal(w.visible.length, 300)
    assert.equal(w.visible[0].key, "k9700")
    assert.equal(w.visible.at(-1).key, "k9999")
    assert.deepEqual([w.hidden, w.nextPage], [9700, 300])
    const tail = transcriptWindowOf(items(420), 300)
    assert.deepEqual([tail.hidden, tail.nextPage], [120, 120])
    assert.equal(showEarlierText(tail.nextPage), "显示更早的 120 条")
    const more = transcriptWindowOf(items(420), 600)
    assert.deepEqual([more.visible.length, more.hidden, more.nextPage], [420, 0, 0])
  })

  test("limit 非正数 / 小数：按 0 / 向下取整", () => {
    assert.equal(transcriptWindowOf(items(5), -3).visible.length, 0)
    assert.equal(transcriptWindowOf(items(5), 2.9).visible.length, 2)
  })

  test("新消息计数：从上滑时记下的最后一条往后数；同一条流式更新不算；记下的那条不在了按 0", () => {
    const before = items(5)
    const mark = lastKeyOf(before)
    assert.equal(mark, "k4")
    assert.equal(newItemsAfter(before, mark), 0)
    assert.equal(newItemsAfter([...before, { key: "n1" }, { key: "n2" }, { key: "n3" }], mark), 3)
    assert.equal(newItemsAfter([...before], mark), 0, "最后一条还在长（key 不变）不算新消息")
    assert.equal(newItemsAfter(items(3, "other"), mark), 0, "切了会话")
    assert.equal(newItemsAfter(before, null), 0, "在底部")
    assert.equal(lastKeyOf([]), null)
  })
})

describe("审批卡播报（design §4.7）", () => {
  const dialog = { title: "允许 pi 运行这条命令吗？", message: "npm test -- history-backfill" }
  const q = approvalQuestionOf(dialog)
  const input = (over) => ({ dialogId: "d1", active: true, question: q, remainingMs: 82_000, ...over })

  test("问题 = 标题，问题；空的跳过", () => {
    assert.equal(q, "允许 pi 运行这条命令吗？，npm test -- history-backfill")
    assert.equal(approvalQuestionOf({ title: "要继续吗？" }), "要继续吗？")
    assert.equal(approvalQuestionOf({ title: " ", message: "" }), "")
  })

  test("出现时播报一次；之后每秒走表都不变（返回同一个对象），剩 10 秒时报一次「还剩 10 秒」，再往后不变", () => {
    let s = approvalAnnounceStep(APPROVAL_ANNOUNCE_IDLE, input({}))
    assert.deepEqual(s, { dialogId: "d1", text: `pi 在等你回答：${q}`, warned: false })
    const texts = [s.text]
    for (let ms = 81_000; ms > 0; ms -= 1000) {
      const next = approvalAnnounceStep(s, input({ remainingMs: ms }))
      if (next !== s) texts.push(next.text)
      s = next
    }
    assert.deepEqual(texts, [`pi 在等你回答：${q}`, "还剩 10 秒"])
    assert.equal(s.warned, true)
  })

  test("时钟跳进 10 秒内时是 9.6 秒：秒数向上取整，仍报「还剩 10 秒」；稀疏的跳（7.2 秒）报实际秒数", () => {
    const s0 = approvalAnnounceStep(APPROVAL_ANNOUNCE_IDLE, input({}))
    assert.equal(approvalAnnounceStep(s0, input({ remainingMs: 9_600 })).text, "还剩 10 秒")
    assert.equal(approvalAnnounceStep(s0, input({ remainingMs: 7_200 })).text, "还剩 8 秒")
    assert.equal(approvalAnnounceStep(s0, input({ remainingMs: APPROVAL_WARN_MS })).text, "还剩 10 秒")
    assert.equal(approvalAnnounceStep(s0, input({ remainingMs: APPROVAL_WARN_MS + 1 })), s0, "10.001 秒还不报")
  })

  test("卡出现时就不到 10 秒：两句并成一次，不再单独报", () => {
    const s = approvalAnnounceStep(APPROVAL_ANNOUNCE_IDLE, input({ remainingMs: 6_500 }))
    assert.deepEqual(s, { dialogId: "d1", text: `pi 在等你回答：${q}。还剩 7 秒`, warned: true })
    assert.equal(approvalAnnounceStep(s, input({ remainingMs: 5_500 })), s)
  })

  test("没有超时（只显示已等多久）：只报出现那一次", () => {
    const s = approvalAnnounceStep(APPROVAL_ANNOUNCE_IDLE, input({ remainingMs: null }))
    assert.equal(s.text, `pi 在等你回答：${q}`)
    assert.equal(approvalAnnounceStep(s, input({ remainingMs: null })), s)
  })

  test("换了一张卡：重新播报，10 秒提醒重新算；收成回执（不可答）时不动", () => {
    let s = approvalAnnounceStep(APPROVAL_ANNOUNCE_IDLE, input({}))
    s = approvalAnnounceStep(s, input({ remainingMs: 9_000 }))
    assert.equal(s.warned, true)
    const other = approvalAnnounceStep(s, input({ dialogId: "d2", question: "选一个", remainingMs: 60_000 }))
    assert.deepEqual(other, { dialogId: "d2", text: "pi 在等你回答：选一个", warned: false })
    assert.equal(approvalAnnounceStep(other, input({ dialogId: "d2", active: false, remainingMs: 5_000 })), other)
    assert.equal(approvalAnnounceStep(APPROVAL_ANNOUNCE_IDLE, input({ active: false })), APPROVAL_ANNOUNCE_IDLE)
  })

  test("PiApprovalCard：卡头 role=group + aria-labelledby，播报区 polite、视觉隐藏，倒计时的可见文字 aria-hidden；用 approvalAnnounceStep，不在 effect 里同步 setState", () => {
    const src = code(read("ui/src/components/pi/conversation/PiApprovalCard.tsx"))
    assert.match(src, /role="group"\s+aria-labelledby=\{headId\}/)
    assert.match(src, /data-pi-part="approval-live" role="status" aria-live="polite" aria-atomic="true" className="sr-only"/)
    assert.match(src, /<span aria-hidden className=\{cn\("shrink-0 tabular-nums"/)
    assert.match(src, /approvalAnnounceStep\(/)
    assert.match(src, /window\.setTimeout\(\(\) => setSaid\(/)
  })
})

describe("代码高亮的语言显示名（PLAN 4.4）", () => {
  test("shiki 语言和 kit 语言都有显示名；plain 写纯文本；认不出返回 null", () => {
    assert.equal(highlightLabelOf("py"), "Python")
    assert.equal(highlightLabelOf("python"), "Python")
    assert.equal(highlightLabelOf("sh"), "Shell")
    assert.equal(highlightLabelOf("go"), "Go")
    assert.equal(highlightLabelOf("ts"), "TypeScript")
    assert.equal(highlightLabelOf("tsx"), "TypeScript JSX")
    assert.equal(highlightLabelOf("text"), "纯文本")
    assert.equal(highlightLabelOf(""), "纯文本")
    assert.equal(highlightLabelOf("cobol-85"), null)
  })

  test("文件视图：具体 mime 先查表（画廊 mock 不变），笼统 mime 按扩展名，认不出原样写 mime", () => {
    assert.equal(fileLangLabelOf("text/typescript", "ui/src/mobile/useMobileViewport.ts"), "TypeScript")
    assert.equal(fileLangLabelOf("text/x-python", "scripts/viewport.py"), "Python")
    assert.equal(fileLangLabelOf("text/plain", "main.go"), "Go")
    assert.equal(fileLangLabelOf("text/plain", "deploy/push.sh"), "Shell")
    assert.equal(fileLangLabelOf("text/plain", "notes.txt"), "纯文本")
    assert.equal(fileLangLabelOf("text/plain", "Makefile"), "Makefile")
    assert.equal(fileLangLabelOf("application/x-cobol", "a.cbl"), "application/x-cobol")
  })
})

describe("P4 b 线源码契约", () => {
  test("PiLightbox：可交互态用 PiOverlay（focus=content、无压暗、不 portal），不在 document / window 上挂监听；静态态 z 用 --cw-pi-z-modal", () => {
    const src = code(read("ui/src/components/pi/conversation/PiLightbox.tsx"))
    assert.doesNotMatch(src, /(document|window)\.addEventListener/)
    assert.match(src, /<PiOverlay\b[\s\S]*?focus="content"[\s\S]*?portal=\{false\}[\s\S]*?backdrop=\{false\}/)
    assert.match(src, /returnFocus=\{returnFocus\}/)
    assert.match(src, /z-\(--cw-pi-z-modal\)/)
    assert.doesNotMatch(src, /\bz-50\b/)
    assert.match(src, /export interface PiLightboxProps extends PiOverlayControl/)
  })

  test("PiTranscript：可交互态接 use-stick-to-bottom（减少动效时 instant），手机不另套滚动容器", () => {
    const hook = code(read("ui/src/pi/hooks/usePiStickToBottom.ts"))
    assert.match(hook, /from "use-stick-to-bottom"/)
    assert.match(hook, /usePiMotion\(\)/)
    assert.match(hook, /resize: instant \? "instant" : undefined/)
    const src = code(read("ui/src/components/pi/conversation/PiTranscript.tsx"))
    assert.match(src, /usePiStickToBottom\(\)/)
    assert.match(src, /usePiStatic\(props\.static\)/)
    assert.match(src, /closest<HTMLElement>\(phone \? "\[data-pi-scroller\]" : "\[data-cw-scroller\]"\)/)
    assert.match(src, /const PHONE_ROOT = "flow-root px-4 pt-1 pb-3"/)
    assert.doesNotMatch(src, /overflow-y-(auto|scroll)/)
  })

  test("PiCodeBlock / PiFilePane 按 highlightRouteOf 分流，不静态 import shiki（shiki 只经 highlight.ts 的动态 import）", () => {
    for (const f of ["ui/src/components/pi/conversation/PiCodeBlock.tsx", "ui/src/components/pi/conversation/PiFilePane.tsx", "ui/src/pi/hooks/useHighlightLines.ts"]) {
      const src = code(read(f))
      assert.doesNotMatch(src, /from\s+["']shiki["']/, f)
    }
    assert.match(code(read("ui/src/components/pi/conversation/PiCodeBlock.tsx")), /highlightRouteOf\(lang\)/)
    // 复制钮的 44 点击区只在可交互态加（静态态和冻结版逐像素一致）
    assert.match(code(read("ui/src/components/pi/conversation/PiCodeBlock.tsx")), /!isStatic && COPY_HIT_44/)
    assert.match(code(read("ui/src/components/pi/conversation/PiFilePane.tsx")), /highlightLangOfPath\(file\.path\)/)
    assert.match(code(read("ui/src/pi/model/highlight.ts")), /import\("shiki"\)/)
  })

  test("b 区画廊屏：PiTranscript、PiLightbox 的每处用法都显式传 static", () => {
    const missing = []
    for (const file of walk(path.join(ROOT, "ui/src/pi/dev/screens/b"), (p) => p.endsWith(".tsx"))) {
      const src = code(fs.readFileSync(file, "utf8"))
      for (const m of src.matchAll(/<(PiTranscript|PiLightbox)\b([^>]*)>/g)) if (!/\sstatic\b/.test(m[2])) missing.push(`${path.relative(ROOT, file)}: <${m[1]}>`)
    }
    assert.deepEqual(missing, [])
  })

  test("压力屏：1 万条 = relay/transcript.ts 的 TRANSCRIPT_MAX_ITEMS；开发屏在下划线目录、area b", () => {
    assert.match(read("ui/src/relay/transcript.ts"), /export const TRANSCRIPT_MAX_ITEMS = 10_000\b/)
    assert.match(read("ui/src/pi/dev/screens/_stress/stressData.ts"), /export const STRESS_ITEMS = 10_000\b/)
    for (const id of ["long-transcript", "code-langs", "approval-countdown"]) {
      const src = read(`ui/src/pi/dev/screens/_stress/${id}.tsx`)
      assert.match(src, new RegExp(`id: "${id}",\\s*area: "b"`), id)
    }
  })
})
