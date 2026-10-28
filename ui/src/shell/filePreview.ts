/**
 * 聊天里的文件路径判定：Markdown 行内代码与工具卡共用，避免命令 / URL / 普通标识符误判（新界面 PiProse 用）。
 *
 * P7 B3a：旧界面"点路径 → 右侧 Agent Window 文件 tab"的 openFilePreview、兼容导出 useFilePreviewRequest / FilePreviewRequest
 * 随 shell/agentWindow.ts、旧 Inspector 一起删了；新界面点文件开 PaneContainer 的文件页（读取仍走本机 get_file，cwd 监狱在后端）。
 */
/** 行内代码里可识别的文件扩展名。只用于判断“像不像文件”，不限制 get_file。 */
const FILE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "jsonc",
  "json5",
  "md",
  "mdx",
  "markdown",
  "css",
  "scss",
  "sass",
  "less",
  "styl",
  "html",
  "htm",
  "vue",
  "svelte",
  "astro",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "properties",
  "env",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",
  "py",
  "pyi",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "scala",
  "swift",
  "c",
  "cc",
  "cpp",
  "cxx",
  "h",
  "hpp",
  "hh",
  "cs",
  "fs",
  "fsx",
  "lua",
  "pl",
  "pm",
  "php",
  "r",
  "ex",
  "exs",
  "erl",
  "hrl",
  "clj",
  "cljs",
  "cljc",
  "dart",
  "proto",
  "graphql",
  "gql",
  "sql",
  "xml",
  "svg",
  "csv",
  "tsv",
  "txt",
  "text",
  "log",
  "lock",
  "pem",
  "crt",
  "key",
  "gradle",
  "cmake",
  "mk",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "pdf",
])

/** 没有扩展名、但几乎总是文件的常见名字（小写比较）。 */
const KNOWN_FILENAMES = new Set([
  "makefile",
  "gnumakefile",
  "dockerfile",
  "containerfile",
  "procfile",
  "gemfile",
  "rakefile",
  "brewfile",
  "vagrantfile",
  "caddyfile",
  "justfile",
  "jenkinsfile",
  "license",
  "licence",
  "copying",
  "readme",
  "changelog",
  "changes",
  "contributing",
  "authors",
  "notice",
])

/** 无扩展名的 dotfile 白名单；.map / .toString 这类成员访问不会被当成文件。 */
const KNOWN_DOTFILES = new Set([
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".npmrc",
  ".nvmrc",
  ".prettierrc",
  ".prettierignore",
  ".eslintrc",
  ".eslintignore",
  ".editorconfig",
  ".dockerignore",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".profile",
  ".vimrc",
  ".env",
])

/** 行号后缀只影响编辑器定位，get_file 需要的是纯路径。 */
const LINE_SUFFIX = /(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/i
const URL_PREFIX = /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:mailto|tel|data|javascript|file):|www\.)/i
const SHELL_META = /[|&;<>$`*?{}\[\]()=!\u0000-\u001f]/
const DOTFILE = /^\.(?=[A-Za-z])[A-Za-z0-9._-]*$/

/** 去掉包裹引号与 `:12` / `#L12` 行号，得到可交给 get_file 的路径。 */
export function normalizeFileTarget(value: unknown): string {
  if (typeof value !== "string") return ""
  let text = value.trim()
  if (text.length > 1) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' || first === "'" || first === "`") && first === last) {
      text = text.slice(1, -1).trim()
    }
  }
  return text.replace(LINE_SUFFIX, "").trim()
}

/**
 * 工具卡的结构化 path：只挡空串、换行与 URL，不要求扩展名（后端可能读无扩展名文件）。
 * 允许空格——工具参数里的路径是可信结构，不是一段自然语言。
 */
export function filePathTarget(value: unknown): string | null {
  const text = normalizeFileTarget(value)
  if (!text || text.length > 240) return null
  if (/[\r\n\u0000]/.test(text)) return null
  if (URL_PREFIX.test(text)) return null
  return text
}

function baseNameOf(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || ""
}

/**
 * Markdown 行内代码里的路径判定：
 *  - 有白名单扩展名（可带目录）或常见无扩展名文件；
 *  - 拒绝 URL、命令行、通配符、普通标识符与纯版本号。
 */
export function looksLikeFilePath(value: string): boolean {
  const text = filePathTarget(value)
  if (!text) return false
  if (/\s/.test(text)) return false
  if (SHELL_META.test(text)) return false
  if (text.startsWith("-")) return false
  const base = baseNameOf(text)
  if (!base || base === "." || base === "..") return false
  if (KNOWN_FILENAMES.has(base.toLowerCase())) return true
  if (DOTFILE.test(base)) {
    if (KNOWN_DOTFILES.has(base.toLowerCase())) return true
    if (/^\.env(?:\..+)?$/i.test(base)) return true
  }
  const match = /\.([A-Za-z0-9]+)$/.exec(base)
  if (!match) return false
  if (!FILE_EXTENSIONS.has(match[1].toLowerCase())) return false
  if (/^\d+(?:\.\d+)+$/.test(base)) return false
  return true
}
