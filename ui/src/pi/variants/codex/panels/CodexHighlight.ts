/** 极简语法着色（CX-PANEL-02 / [X-§5]：「真语法高亮」的最小实现，零依赖、样式走 --codex-* token）。
 *  支持 // 与 # 行注释、块注释、单双引号字符串、数字、常见关键字；未知语言按纯文本。 */
const KEYWORDS = new Set([
  "import","from","export","default","const","let","var","function","return","if","else","for","while","switch","case","break","continue",
  "class","extends","interface","type","enum","new","this","super","async","await","try","catch","finally","throw","typeof","instanceof",
  "public","private","protected","static","readonly","as","in","of","null","undefined","true","false","void","never","any","string","number","boolean",
  "def","self","elif","elif","elif","none","and","or","not","with","lambda","pass","raise","yield","global","nonlocal","assert","del",
  "package","func","struct","map","chan","go","defer","range","select","case","fallthrough",
])

export type CodexToken = { text: string; tone: "kw" | "str" | "num" | "com" | "plain" }

function tokenizeLine(line: string): CodexToken[] {
  const out: CodexToken[] = []
  let i = 0
  while (i < line.length) {
    const rest = line.slice(i)
    const comment = rest.startsWith("//") || rest.startsWith("#") ? rest : null
    if (comment) {
      out.push({ text: comment, tone: "com" })
      return out
    }
    const str = /^("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)/.exec(rest)
    if (str) {
      out.push({ text: str[0], tone: "str" })
      i += str[0].length
      continue
    }
    const num = /^\d+(?:\.\d+)?/.exec(rest)
    if (num) {
      out.push({ text: num[0], tone: "num" })
      i += num[0].length
      continue
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest)
    if (word) {
      out.push({ text: word[0], tone: KEYWORDS.has(word[0]) ? "kw" : "plain" })
      i += word[0].length
      continue
    }
    out.push({ text: rest[0], tone: "plain" })
    i += 1
  }
  return out
}

/** 按行切分并着色；返回逐行 token（行号由渲染方加） */
export function codexHighlight(code: string): CodexToken[][] {
  return code.split("\n").map((line) => tokenizeLine(line))
}
