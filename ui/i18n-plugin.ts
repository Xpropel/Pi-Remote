import path from "node:path"
import MagicString from "magic-string"
import ts from "typescript"
import type { Plugin } from "vite"
import { EN } from "./src/i18n/en.ts"
import { JA } from "./src/i18n/ja.ts"
import { KO } from "./src/i18n/ko.ts"
import { ES } from "./src/i18n/es.ts"
import { FR } from "./src/i18n/fr.ts"

const helpers = 'import { translate as __piTranslate, template as __piTemplate, getLanguage as __piLocale } from "@/i18n";\n'
const MESSAGE_KEYS = new Set([...Object.keys(EN), ...Object.keys(JA), ...Object.keys(KO), ...Object.keys(ES), ...Object.keys(FR)])
const own = (text: string) => MESSAGE_KEYS.has(text) || MESSAGE_KEYS.has(text.trim())

/** JSX entities are decoded by React's compiler, including in Chinese mode. */
function jsxEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" }
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name: string) => {
    if (!name.startsWith("#")) return named[name.toLowerCase()] ?? entity
    const point = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1))
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity
  })
}

/** Match React's JSX line folding while preserving significant inline spaces. */
export function jsxText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  let lastNonEmpty = 0
  for (let index = 0; index < lines.length; index++) if (/[^\t ]/.test(lines[index])) lastNonEmpty = index
  let result = ""
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index].replace(/\t/g, " ")
    if (index) line = line.replace(/^ +/, "")
    if (index !== lines.length - 1) line = line.replace(/ +$/, "")
    if (line) result += line + (index !== lastNonEmpty ? " " : "")
  }
  return jsxEntities(result)
}

/** All translation candidates come from source syntax, never from rendered DOM. */
export function sourceMessage(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.parent && ts.isJsxAttribute(node.parent) ? jsxEntities(node.text) : node.text
  if (ts.isJsxText(node)) return jsxText(node.text)
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span, index) => `{${index}}${span.literal.text}`).join("")
  }
  return null
}

export function productModule(id: string): boolean {
  const file = id.split("?")[0].replaceAll("\\", "/")
  return /\/src\/.*\.tsx?$/.test(file) && !/\/src\/(?:i18n\/|pi\/dev\/)/.test(file) && !file.endsWith(".d.ts")
}

/** Literal types, object keys, imports and tagged code templates are not UI copy. */
export function excludedNode(node: ts.Node): boolean {
  const parent = node.parent
  if (!parent) return false
  if (ts.isTypeNode(node) || ts.isTypeNode(parent)) return true
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return true
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isTaggedTemplateExpression(parent)) return true
  // CSS selectors and original-language error matching must remain structural.
  if ((ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || ts.isJsxText(node)) && node.getFullText().includes("i18n-ignore")) return true
  if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === "translate") return true
  if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
    const method = parent.expression.name.text
    if (["querySelector", "querySelectorAll", "closest", "matches"].includes(method)) return true
  }
  return false
}

/**
 * Retrofit the existing source-owned copy without editing hundreds of components.
 * Both development and production use the same transform. Interpolation values
 * remain expressions; catalog lookup never touches remote text, code or names.
 */
export function transformMessages(code: string, id: string): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  if (!productModule(id)) return null
  const file = id.split("?")[0]
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const output = new MagicString(code)
  let changed = false
  const visit = (node: ts.Node): void => {
    if (excludedNode(node)) return
    const message = sourceMessage(node)
    const start = node.getStart(source)
    if (message !== null && own(message)) {
      if (ts.isTemplateExpression(node)) output.prependLeft(start, "__piTemplate")
      else if (ts.isJsxText(node)) output.overwrite(node.pos, node.end, `{__piTranslate(${JSON.stringify(message)})}`)
      else if (ts.isStringLiteral(node) && ts.isJsxAttribute(node.parent)) output.overwrite(start, node.end, `{__piTranslate(${JSON.stringify(message)})}`)
      else {
        output.prependLeft(start, "__piTranslate(")
        output.appendRight(node.end, ")")
      }
      changed = true
    } else if (ts.isStringLiteral(node) && ["zh-CN", "zh-Hans-CN"].includes(node.text) && ts.isCallExpression(node.parent) && ts.isPropertyAccessExpression(node.parent.expression)) {
      const method = node.parent.expression.name.text
      if (method === "toLocaleString" || method === "localeCompare") {
        output.overwrite(start, node.end, "__piLocale()")
        changed = true
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!changed) return null
  output.prepend(helpers)
  return { code: output.toString(), map: output.generateMap({ source: path.resolve(file), includeContent: true, hires: true }) }
}

export function piI18n(): Plugin {
  return { name: "pi-source-i18n", enforce: "pre", transform: transformMessages }
}
