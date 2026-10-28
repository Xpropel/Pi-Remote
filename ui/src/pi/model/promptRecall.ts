/**
 * 桌面输入框的 ↑ / ↓ 提示词历史（design K04「接到产品输入框」、PLAN §7.3 composer-keyboard 行；P5 第 2 轮，审查 P5-R1-2）。
 *
 * 口径照旧界面 style/faces.tsx 的 ComposerBody：历史、翻页和"什么时候拦下方向键"都是 chat/promptHistory.ts 的纯函数
 * （promptHistoryFromItems / recallPrompt / shouldRecallOlder / shouldRecallNewer），这里只把"正在浏览"的状态收成一个小状态机，
 * 给 ComposerContainer 和 node 测试共用：
 *  - ↑ 从走进历史前的草稿开始，一档档往更早翻；↓ 往回翻，翻过最新一条回到原草稿；
 *  - 光标不在首 / 末行时不拦（多行草稿里方向键照常移动光标），单行时浏览中一直拦；
 *  - 草稿被改成别的（用户自己改字、斜杠命令 / 分叉回填）就退出浏览；换会话、历史变了（发出了新的一条）由容器重置。
 * 只在桌面接：手机不传回调（design K04 写的是"PiFollowUpComposer 桌面 ↑ / ↓"）。
 * node --test 直接加载：相对导入带 .ts 扩展名。
 */
import { promptHistoryFromItems, recallPrompt, shouldRecallNewer, shouldRecallOlder } from "../../chat/promptHistory.ts"

export interface PromptRecall {
  /** -1 = 没在浏览；0 = 最新一条 */
  index: number
  /** 走进历史之前的草稿（翻回 -1 时还原） */
  savedDraft: string | null
  /** 浏览时自己填进输入框的那一段：草稿变成别的就退出浏览 */
  shown: string | null
}

export const PROMPT_RECALL_IDLE: PromptRecall = { index: -1, savedDraft: null, shown: null }

/** 一次方向键：方向 + 输入框当时的值和选区 */
export interface PromptRecallKey {
  direction: "older" | "newer"
  value: string
  selectionStart: number | null
  selectionEnd: number | null
}

/**
 * 按一次 ↑ / ↓：能翻就返回新状态和要填进输入框的文字；不该拦（光标不在首 / 末行、没有历史、翻到头了）返回 null，
 * 按键照常交给输入框（移动光标）。items = relay.transcript.items（只认 kind 为 user 的正文）。
 */
export function promptRecallStep(state: PromptRecall, items: unknown, key: PromptRecallKey): { state: PromptRecall; text: string } | null {
  const browsing = state.index >= 0
  const allow =
    key.direction === "older"
      ? shouldRecallOlder(browsing, key.value, key.selectionStart, key.selectionEnd)
      : shouldRecallNewer(browsing, key.value, key.selectionStart, key.selectionEnd)
  if (!allow) return null
  const next = recallPrompt(promptHistoryFromItems(items), state.index, state.savedDraft, key.value, key.direction)
  if (!next) return null
  if (next.index < 0) return { state: PROMPT_RECALL_IDLE, text: next.text }
  return { state: { index: next.index, savedDraft: next.savedDraft, shown: next.text }, text: next.text }
}

/** 草稿变了：还是浏览时自己填的那段就接着浏览，否则退出（不还原草稿：用户改过的字就是新草稿） */
export function promptRecallAfterDraft(state: PromptRecall, draft: string): PromptRecall {
  if (state.index < 0 || draft === state.shown) return state
  return PROMPT_RECALL_IDLE
}

/** 历史的指纹（换了内容才变）：发出新的一条后下标的含义变了，容器据此退出浏览；助手流式更新不改它 */
export function promptHistoryKey(items: unknown): string {
  return promptHistoryFromItems(items).join("\u0001")
}
