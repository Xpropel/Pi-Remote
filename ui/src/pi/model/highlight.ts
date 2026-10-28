/**
 * 代码高亮（PLAN 4.4、D12）：kit tokenizer 不支持的语言走 shiki，颜色一律是 `--cw-syntax-*` 的 CSS 变量。
 *
 * 分流（highlightRouteOf）：
 * - kit：ts / tsx / js / jsx / json / html（含 typescript、mjs 等别名）。仍走 kit 的 tokenizeLines + SyntaxTokens，
 *   和画廊 L1 像素一致；本文件不碰这条路。
 * - plain：空、text、plaintext 等。直接渲染纯文本。
 * - shiki：其余语言（python、bash、go …）。调 highlightToLines；shiki 不认识的语言返回 null，调用方按纯文本渲染。
 *
 * 懒加载：写法参照 components/ui/code-block.tsx（只读，不改它），但 shiki 本身也用动态 import()，
 * 所以产品入口（index.html）的主 chunk 不静态引入 shiki；语言包、主题、正则引擎由 shiki 的 bundledLanguages 按需再拆 chunk。
 *
 * 主题：PI_SYNTAX_THEME 的每个颜色都是 CSS 变量字符串（shiki 原样写进 token.color），取值与 kit 的 SYNTAX_COLOR
 * 共用一份，深浅主题跟着 pi-theme.css 对 `--cw-syntax-*` 的重设变，不需要重新高亮。
 * 没命中任何规则的记号用默认前景色，toHighlightLines 把它转成 color = undefined（继承容器字色，等同 kit 的 plain）。
 *
 * test/*.test.mjs 用 node 直接跑 .ts 源文件，所以相对导入带扩展名、只用类型导入 shiki。
 */
import type { BundledLanguage, ThemeRegistration, ThemedToken } from "shiki"
import { SYNTAX_COLOR, type SyntaxKind, type SyntaxLang } from "../../components/kit/diff/syntax.ts"

export type HighlightRoute =
  | { via: "kit"; lang: Exclude<SyntaxLang, "text"> }
  | { via: "shiki"; lang: string }
  | { via: "plain" }

export interface HighlightToken {
  text: string
  /** CSS 颜色值，总是 `var(--cw-syntax-*…)`；undefined = 继承容器字色 */
  color?: string
  italic?: boolean
}

export type HighlightLine = HighlightToken[]

/** kit tokenizer 支持的 6 种语言及别名 */
const KIT_LANGS: Record<string, Exclude<SyntaxLang, "text">> = {
  ts: "ts",
  typescript: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  javascript: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  json: "json",
  html: "html",
  htm: "html",
}

const PLAIN_LANGS = new Set(["", "text", "txt", "plain", "plaintext"])

/** 常见别名统一成 shiki 的主名，便于缓存和展示；其余原样交给 shiki（它自己也认很多别名） */
const SHIKI_ALIASES: Record<string, string> = {
  py: "python",
  python3: "python",
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  zsh: "bash",
  golang: "go",
  yml: "yaml",
  rs: "rust",
  rb: "ruby",
  md: "markdown",
}

/** 语言名 → 走哪条路。大小写、首尾空白不敏感；markdown 围栏的 "py title=a.py" 只取第一个词。 */
export function highlightRouteOf(lang: string | null | undefined): HighlightRoute {
  const name = (lang ?? "").trim().split(/\s+/)[0].toLowerCase()
  if (PLAIN_LANGS.has(name)) return { via: "plain" }
  const kit = KIT_LANGS[name]
  if (kit) return { via: "kit", lang: kit }
  return { via: "shiki", lang: SHIKI_ALIASES[name] ?? name }
}

/** 没有扩展名、靠文件名认语言的几个常见文件 */
const NAME_LANGS: Record<string, string> = {
  dockerfile: "docker",
  makefile: "make",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".profile": "bash",
}

/**
 * 文件路径 → 语言名（交给 highlightRouteOf）。给 PiFilePane 用：kit 的 langOf 只认 6 种，其余都成了 text。
 * 结果是扩展名本身（shiki 认 py / go / sh / rs 等扩展名式别名），没有扩展名时返回 "text"。
 */
export function highlightLangOfPath(path: string): string {
  const base = (path.split(/[\\/]/).pop() ?? "").toLowerCase()
  const byName = NAME_LANGS[base]
  if (byName) return byName
  const dot = base.lastIndexOf(".")
  if (dot <= 0 || dot === base.length - 1) return "text"
  return base.slice(dot + 1)
}

/**
 * 语言 → 文件视图右上角"3 KB · Python"里的显示名（PLAN 4.4）。键是 highlightRouteOf 归一后的名字（kit 的 6 种 + shiki 主名）；
 * kit 那几种和 PiFilePane 原来按 mime 查的写法一致（TypeScript、TypeScript JSX…），所以画廊里 .ts 文件的显示不变。
 */
const LANG_LABELS: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript JSX",
  js: "JavaScript",
  jsx: "JavaScript JSX",
  json: "JSON",
  html: "HTML",
  python: "Python",
  bash: "Shell",
  go: "Go",
  rust: "Rust",
  ruby: "Ruby",
  java: "Java",
  kotlin: "Kotlin",
  swift: "Swift",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  php: "PHP",
  lua: "Lua",
  sql: "SQL",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  vue: "Vue",
  svelte: "Svelte",
  xml: "XML",
  yaml: "YAML",
  toml: "TOML",
  ini: "INI",
  markdown: "Markdown",
  docker: "Dockerfile",
  make: "Makefile",
  nginx: "Nginx",
  diff: "Diff",
  powershell: "PowerShell",
}

/** 语言名 → 显示名；plain 一类写"纯文本"；表里没有的返回 null（调用方退回 mime） */
export function highlightLabelOf(lang: string | null | undefined): string | null {
  const route = highlightRouteOf(lang)
  if (route.via === "plain") return "纯文本"
  return LANG_LABELS[route.lang] ?? null
}

/** 文件视图按 mime 认语言（get_file 回的 mime）；这几种太笼统，交给扩展名判断 */
const MIME_LABELS: Record<string, string> = {
  "text/typescript": "TypeScript",
  "text/tsx": "TypeScript JSX",
  "text/javascript": "JavaScript",
  "application/json": "JSON",
  "text/html": "HTML",
  "text/markdown": "Markdown",
}
const GENERIC_MIMES = new Set(["", "text/plain", "application/octet-stream"])

/**
 * 文件视图右上角的语言名：具体的 mime 先按表查（画廊 mock 的 text/typescript → TypeScript，和原来一样）；
 * mime 笼统（text/plain 等）或表里没有时按扩展名（highlightLangOfPath → highlightLabelOf）；都认不出就原样写 mime。
 */
export function fileLangLabelOf(mime: string, path: string): string {
  const byMime = GENERIC_MIMES.has(mime) ? undefined : MIME_LABELS[mime]
  return byMime ?? highlightLabelOf(highlightLangOfPath(path)) ?? (mime || "纯文本")
}

/** 默认前景色：没命中规则的记号会是这个值，toHighlightLines 再把它换成 undefined */
export const PI_SYNTAX_FOREGROUND = "var(--cw-text)"

const c = (kind: SyntaxKind) => SYNTAX_COLOR[kind] as string

/** TextMate scope → 颜色。shiki 按 scope 的具体程度选规则（越长越优先），与数组顺序无关。 */
const SCOPE_RULES: { scope: string[]; kind: SyntaxKind; italic?: boolean }[] = [
  { scope: ["comment", "punctuation.definition.comment"], kind: "comment", italic: true },
  {
    scope: ["string", "constant.character", "string.regexp", "punctuation.definition.string", "markup.inline.raw"],
    kind: "string",
  },
  { scope: ["constant.numeric"], kind: "number" },
  {
    scope: [
      "keyword",
      "storage",
      "storage.type",
      "storage.modifier",
      "constant.language",
      "variable.language",
      "support.type.primitive",
      "keyword.type",
    ],
    kind: "keyword",
  },
  { scope: ["keyword.operator", "punctuation", "meta.brace"], kind: "punct" },
  {
    scope: [
      "entity.name.function",
      "support.function",
      "variable.function",
      "meta.function-call.generic",
      "entity.name.command",
    ],
    kind: "func",
  },
  {
    scope: [
      "variable",
      "variable.other",
      "variable.parameter",
      "entity.name.type",
      "entity.name.class",
      "entity.name.namespace",
      "entity.name.package",
      "support.type",
      "support.class",
      "entity.other.inherited-class",
      "support.variable",
    ],
    kind: "ident",
  },
  { scope: ["entity.name.tag", "punctuation.definition.tag"], kind: "tag" },
  { scope: ["entity.other.attribute-name", "meta.decorator", "entity.name.function.decorator"], kind: "attr" },
]

/** 读 `--cw-syntax-*` 的 shiki 主题；type 写 light 只影响 shiki 内部默认值，实际颜色全来自 CSS 变量 */
export const PI_SYNTAX_THEME: ThemeRegistration = {
  name: "pi-cw-syntax",
  type: "light",
  colors: {
    "editor.background": "transparent",
    "editor.foreground": PI_SYNTAX_FOREGROUND,
  },
  settings: [
    { settings: { foreground: PI_SYNTAX_FOREGROUND } },
    ...SCOPE_RULES.map((rule) => ({
      scope: rule.scope,
      settings: { foreground: c(rule.kind), ...(rule.italic ? { fontStyle: "italic" } : {}) },
    })),
  ],
}

/** shiki 记号里本文件用到的字段 */
export type ShikiTokenLike = Pick<ThemedToken, "content"> & Partial<Pick<ThemedToken, "color" | "fontStyle">>

/** shiki FontStyle.Italic */
const FONT_ITALIC = 1

/**
 * shiki 的记号行 → HighlightLine：默认前景色换成 undefined；斜体位转成 italic；相邻同样式的记号合并。
 * 纯函数，Node 单测直接测。
 */
export function toHighlightLines(
  lines: readonly (readonly ShikiTokenLike[])[],
  foreground: string = PI_SYNTAX_FOREGROUND,
): HighlightLine[] {
  return lines.map((line) => {
    const out: HighlightLine = []
    for (const token of line) {
      if (!token.content) continue
      const color = token.color && token.color.toLowerCase() !== foreground.toLowerCase() ? token.color : undefined
      const italic = ((token.fontStyle ?? 0) & FONT_ITALIC) !== 0 ? true : undefined
      const prev = out[out.length - 1]
      if (prev && prev.color === color && prev.italic === italic) {
        prev.text += token.content
      } else {
        out.push({ text: token.content, ...(color ? { color } : {}), ...(italic ? { italic } : {}) })
      }
    }
    return out
  })
}

type ShikiModule = typeof import("shiki")
let shikiModule: Promise<ShikiModule> | null = null

/** shiki 只在第一次需要时加载；加载失败时清掉缓存，下次再试 */
export function loadShiki(): Promise<ShikiModule> {
  if (!shikiModule) {
    shikiModule = import("shiki").catch((error: unknown) => {
      shikiModule = null
      throw error
    })
  }
  return shikiModule
}

/**
 * 代码 + 语言 → 带 CSS 变量颜色的记号行（行数 = 按 "\n" 切开的行数，\r\n 视同 \n）。
 * 走 shiki，不看分流：调用方先用 highlightRouteOf 判断，kit / plain 的语言不必调用这里。
 * 语言不认识、shiki 加载失败时返回 null，调用方渲染纯文本。
 */
export async function highlightToLines(code: string, lang: string): Promise<HighlightLine[] | null> {
  const route = highlightRouteOf(lang)
  const name = route.via === "shiki" ? route.lang : route.via === "kit" ? route.lang : "text"
  const source = code.replace(/\r\n?/g, "\n")
  try {
    const shiki = await loadShiki()
    if (name !== "text" && !Object.hasOwn(shiki.bundledLanguages, name)) return null
    const result = await shiki.codeToTokens(source, { lang: name as BundledLanguage | "text", theme: PI_SYNTAX_THEME })
    return toHighlightLines(result.tokens)
  } catch {
    return null
  }
}
