/**
 * 消息操作行的纯模型：复制内容与可用动作。
 * 只承认已有能力（复制 / 失败重试 / 打开图片）；删除、引用、朗读等
 * 没有协议或命令来源的动作永远不出现在这里。
 */

export type CopyKind = "markdown" | "plain"
export type MessageActionKind = "copy" | "copy-plain" | "retry" | "open-image"

export type MessageBlockLike = {
  kind: string
  text?: string
}

export type MessageActionInput = {
  kind: "user" | "assistant"
  live?: boolean
  failed?: boolean
  canRetry?: boolean
  hasImages?: boolean
  hasPlainDifference?: boolean
  /** 空回复/纯图片消息没有可复制正文时，不显示复制假按钮。 */
  hasContent?: boolean
}

/** 助手消息复制的是 Markdown 原文：按出现顺序取文本块，以空行拼接。 */
export function assistantMarkdown(blocks: readonly MessageBlockLike[]): string {
  return blocks
    .filter((block) => block.kind === "text" && typeof block.text === "string" && block.text.trim().length > 0)
    .map((block) => block.text as string)
    .join("\n\n")
    .trim()
}

/**
 * 把 Markdown 粗略降级为纯文本（复制纯文本用）。只去标记，不改写词句；
 * 代码围栏去掉 ``` 但保留代码，链接保留文字与 URL。
 */
export function markdownToPlainText(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, "\n")
  text = text.replace(/^```[^\n]*\n([\s\S]*?)^```\s*$/gm, "$1")
  text = text.replace(/^~~~[^\n]*\n([\s\S]*?)^~~~\s*$/gm, "$1")
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "")
  text = text.replace(/^\s{0,3}>\s?/gm, "")
  text = text.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "")
  text = text.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, "")
  text = text.replace(/`([^`\n]+)`/g, "$1")
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "$1")
  text = text.replace(/__([^_\n]+)__/g, "$1")
  text = text.replace(/~~([^~\n]+)~~/g, "$1")
  text = text.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
  text = text.replace(/[ \t]+\n/g, "\n")
  text = text.replace(/\n{3,}/g, "\n\n")
  return text.trim()
}

/** 消息级复制值：用户 = 原文；助手 = 文本块 Markdown / 其纯文本降级。 */
export function messageCopyValues(kind: "user" | "assistant", content: string | readonly MessageBlockLike[]): {
  markdown: string
  plain: string
} {
  if (kind === "user") {
    const text = typeof content === "string" ? content : ""
    return { markdown: text, plain: text }
  }
  const markdown = typeof content === "string" ? content : assistantMarkdown(content)
  return { markdown, plain: markdownToPlainText(markdown) }
}

/**
 * 可用动作白名单。流式中不出操作行；没有失败/图片/纯文本差异时
 * 对应动作不出现，不占用位置、不置灰假按钮。
 */
export function messageActionKinds(input: MessageActionInput): MessageActionKind[] {
  if (input.live) return []
  const actions: MessageActionKind[] = []
  if (input.hasContent !== false) actions.push("copy")
  if (input.kind === "assistant" && input.hasPlainDifference) actions.push("copy-plain")
  if (input.failed && input.canRetry) actions.push("retry")
  if (input.hasImages) actions.push("open-image")
  return actions
}
