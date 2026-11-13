/**
 * @ 引用写在句子里（desk-18：选中候选不再把词抽走变成框上的 chip）。
 * 发出去的就是草稿原文，"@路径" 留在用户写的位置；带空白的路径在句子里分不清边界，仍挂成 chip、发送时按行展开（expandMentionText）。
 */
import { underRoots } from "../../../relay/devices.ts"

/**
 * 候选池里落在会话目录内的绝对路径改成相对路径（正斜杠）："D:\proj\src\a.ts" → "src/a.ts"：pi 按会话目录解析，句子里也短。
 * 在不在目录内同 relay 的口径（underRoots：Windows / macOS 不分大小写，Windows 反斜杠算分隔符）；
 * 目录外的、本来就是相对的路径原样留着；改完重复的只留第一条。
 */
export function mentionPathsIn(paths: readonly string[], cwd: string | null | undefined, platform?: string | null): string[] {
  const base = (cwd ?? "").replace(/[\\/]+$/, "")
  if (!base) return [...paths]
  const windowsStyle = /^[A-Za-z]:|\\/.test(base)
  const out: string[] = []
  for (const path of paths) {
    const inside = path.length > base.length + 1 && underRoots([base], path, platform)
    const rel = inside ? path.slice(base.length + 1) : path
    const shown = inside && windowsStyle ? rel.replace(/\\/g, "/") : rel
    if (!out.includes(shown)) out.push(shown)
  }
  return out
}

/** 能写进句子的路径：不带空白 */
export function mentionFitsInline(path: string): boolean {
  return path.length > 0 && !/\s/.test(path)
}

/**
 * 选中 @ 候选：把 "@查询" 换成 "@路径"，句子其余部分原样留着。
 * 光标停在词中间（"@fo|rmat.js"）时，光标后紧接的路径字符（ASCII 字母数字 . _ - / \）算同一个词一起换掉；中文、空白、其它标点不动。
 * 路径后补一个空格，光标落在空格后（后面本来就是空格 / Tab 时不补、光标跳过它），这样光标前不再是 @ 查询，菜单自然收起。
 */
export function insertMentionAt(draft: string, start: number, caret: number, path: string): { draft: string; caret: number } {
  const s = Math.max(0, Math.min(start, draft.length))
  const e = Math.max(s, Math.min(caret, draft.length))
  const tail = /^[\w.\-/\\]*/.exec(draft.slice(e))?.[0].length ?? 0
  const token = `@${path}`
  const after = draft.slice(e + tail)
  const gap = /^[ \t]/.test(after) ? "" : " "
  return { draft: draft.slice(0, s) + token + gap + after, caret: s + token.length + 1 }
}

/** "@" 前：行首、空白或非 ASCII 字符（同 @ 菜单的触发口径）；路径后：结尾、空白、非 ASCII，或不会接在路径里的标点 */
const BEFORE_OK = (ch: string | undefined) => ch === undefined || /\s/.test(ch) || ch.charCodeAt(0) >= 128
const AFTER_OK = (ch: string | undefined) => ch === undefined || /\s/.test(ch) || ch.charCodeAt(0) >= 128 || /[,;:!?)\]}"'`]/.test(ch)

/** 草稿里写在句子中的引用（"@" + 候选池里的路径）的位置，给输入框底下的 pill 高亮层；同一处取最长的路径 */
export function inlineMentionRanges(draft: string, pool: readonly string[]): Array<{ start: number; end: number }> {
  const paths = pool.filter(mentionFitsInline)
  if (!paths.length || !draft.includes("@")) return []
  const out: Array<{ start: number; end: number }> = []
  for (let at = draft.indexOf("@"); at >= 0; at = draft.indexOf("@", at + 1)) {
    if (!BEFORE_OK(draft[at - 1])) continue
    let best = 0
    for (const p of paths) {
      if (p.length > best && draft.startsWith(p, at + 1) && AFTER_OK(draft[at + 1 + p.length])) best = p.length
    }
    if (!best) continue
    out.push({ start: at, end: at + 1 + best })
    at += best
  }
  return out
}
