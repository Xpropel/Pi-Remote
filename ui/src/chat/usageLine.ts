import type { Block } from "@/relay/transcript"

/** 只关心判定需要的最小形状；React 组件与单测都能直接用 Item 传进来。 */
type UsageItem = { blocks: readonly (Block | null | undefined)[]; live?: boolean }

/**
 * token 用量行只在「这一轮助手回复的最后一个有效内容块是文本」时显示。
 *
 * pi 每跑一步工具都会落一条独立的 assistant 消息，这些中间消息同样带 usage；
 * 如果每条都渲染，同一轮会在工具卡后出现一次、最终回答后又一次。
 * 这里从尾部跳过空 thinking / 空文本，找到第一个有效块：
 *   - text   → 这是最终回答，显示；
 *   - tool   → 工具调用段（可能前面还有 text），不显示；
 *   - thinking（有内容）→ 没有可展示的最终文本，不显示。
 * 流式中的 live 消息一律不显示，等定稿后再按同一规则判断。
 */
export function shouldShowUsage(item: UsageItem): boolean {
  if (item.live) return false
  for (let i = item.blocks.length - 1; i >= 0; i -= 1) {
    const block = item.blocks[i]
    if (!block) continue
    if (block.kind === "text") return block.text.trim().length > 0
    if (block.kind === "thinking") {
      if (block.text.trim()) return false
      continue
    }
    return false
  }
  return false
}
