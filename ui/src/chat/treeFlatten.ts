/** 会话树展开（纯函数，不依赖 React，便于单测）。 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export type FlatNode = {
  id: string
  label: string
  depth: number
  current: boolean
  /** entry.type，只给筛选用 */
  entryType: string
  /** 轻量条目的 role；完整条目退回 message.role */
  role: string
  /** 节点自身 label 不是 undefined（书签）。空字符串也算有书签 */
  bookmarked: boolean
  /** 书签、preview、type、role、id 拼成的小写文本 */
  search: string
}

export type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all"

/** 跳转方式：与 pi 终端 /tree 的 “Summarize branch?” 对应。默认直接跳转（终端首个选项也是 No summary）。 */
export type TreeJumpMode = "direct" | "summarize"
export const DEFAULT_TREE_JUMP_MODE: TreeJumpMode = "direct"
export const TREE_JUMP_MODES: readonly { id: TreeJumpMode; label: string }[] = [
  { id: "direct", label: "直接跳转" },
  { id: "summarize", label: "跳转并总结" },
]

/** navigate_tree 参数：只有明确选“跳转并总结”才带 summarize:true，不伪造上游没有的字段。 */
export function treeJumpArgs(mode: TreeJumpMode, targetId: string): { targetId: string; summarize?: true } {
  return mode === "summarize" ? { targetId, summarize: true } : { targetId }
}

/** 默认视图藏掉的记账/设置类条目。usage 在五种模式里另外一律隐藏。 */
const DEFAULT_HIDDEN = new Set(["label", "context_edit", "custom", "model_change", "thinking_level_change", "session_info"])

function entryRole(entry: Record<string, unknown>): string {
  if (typeof entry.role === "string") return entry.role
  const message = isRecord(entry.message) ? entry.message : null
  return message && typeof message.role === "string" ? message.role : ""
}

function passesMode(node: FlatNode, mode: TreeFilterMode): boolean {
  // 五种模式都不显示 usage，当前叶也不加回来
  if (node.entryType === "usage") return false
  if (mode === "all") return true
  if (mode === "user-only") return node.entryType === "message" && node.role === "user"
  if (mode === "labeled-only") return node.bookmarked
  if (DEFAULT_HIDDEN.has(node.entryType)) return false
  // 不要工具 = 默认再去掉 toolResult。只有工具调用的 assistant 仍保留
  if (mode === "no-tools" && node.entryType === "message" && node.role === "toolResult") return false
  return true
}

/** 在已展开的树上筛选。不改 id、标题、缩进和 current，也不再向本机要一次树。 */
export function filterTree(nodes: FlatNode[], mode: TreeFilterMode, query: string): FlatNode[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return nodes.filter((node) => {
    if (!passesMode(node, mode)) return false
    return words.every((word) => node.search.includes(word))
  })
}

/** 迭代展开（原来是递归）：pi 把线性对话存成层层嵌套的树，长会话会爆栈。 */
export function flattenTree(value: unknown, leafId: string): FlatNode[] {
  const out: FlatNode[] = []
  const stack: { node: unknown; depth: number }[] = [{ node: value, depth: 0 }]
  while (stack.length) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number }
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) stack.push({ node: node[i], depth })
      continue
    }
    if (!isRecord(node)) continue
    const entry = isRecord(node.entry) ? node.entry : null
    const id = entry && typeof entry.id === "string" ? entry.id : ""
    const label = String(node.label || (entry && (entry.preview || entry.type || entry.role)) || "节点").replace(/\s+/g, " ").trim().slice(0, 80)
    if (id) {
      const entryType = entry && typeof entry.type === "string" ? entry.type : ""
      const role = entry ? entryRole(entry) : ""
      const bookmark = typeof node.label === "string" ? node.label : ""
      const preview = entry && typeof entry.preview === "string" ? entry.preview : ""
      out.push({
        id,
        label: label || "节点",
        depth,
        current: id === leafId,
        entryType,
        role,
        bookmarked: node.label !== undefined,
        search: [bookmark, preview, entryType, role, id].join(" ").toLowerCase(),
      })
    }
    if (Array.isArray(node.children)) {
      // 只有分叉处才加一级缩进：pi 把线性对话存成一层套一层的树，按层数缩进会变成越来越深的台阶
      const childDepth = node.children.length > 1 ? depth + 1 : depth
      for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push({ node: node.children[i], depth: childDepth })
    }
  }
  return out
}
