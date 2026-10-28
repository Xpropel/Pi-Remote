/** 会话树复制正文。不改入参，不收预览、书签和工具参数。 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** 字符串整段留下；数组只按顺序拼接文本块。思考块和工具调用没有 type=text，自然跳过。 */
function extractText(content: unknown): string | null | undefined {
  if (typeof content === "string") return content
  if (content === null || content === undefined) return content
  if (!Array.isArray(content)) return ""
  let result = ""
  for (const block of content) {
    if (!isPlainObject(block) || block.type !== "text" || typeof block.text !== "string") continue
    result += block.text
  }
  return result
}

function kept(text: unknown): string | null {
  if (typeof text !== "string") return null
  return text.trim() ? text : null
}

/**
 * 自己有 content 才抽取。拼出来是 ""、null 或 undefined，且角色是 assistant、errorMessage 是字符串时，改用 errorMessage。
 * 没有 content 这个键时不用 errorMessage。
 */
function contentCopy(host: Record<string, unknown>): string | null {
  if (!Object.hasOwn(host, "content")) return null
  let text: unknown = extractText(host.content)
  if ((text === "" || text === null || text === undefined) && host.role === "assistant" && typeof host.errorMessage === "string") {
    text = host.errorMessage
  }
  return kept(text)
}

export function entryCopyText(entry: unknown): string | null {
  if (!isPlainObject(entry)) return null
  if (entry.type === "message") {
    const message = entry.message
    if (!isPlainObject(message)) return null
    if (message.role === "bashExecution") {
      return typeof message.command === "string" ? kept(message.command) : null
    }
    return contentCopy(message)
  }
  if (entry.type === "custom_message") return contentCopy(entry)
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return typeof entry.summary === "string" ? kept(entry.summary) : null
  }
  return null
}
