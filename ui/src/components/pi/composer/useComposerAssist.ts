import { useId, useState, type KeyboardEvent } from "react"
import { usePiLayer } from "@/components/pi/shared/layers"
import {
  activeOptionIndex,
  composerTriggerOf,
  nextOptionIndex,
  removeMentionQuery,
  slashMenuGroups,
  triggerSignature,
  type PiComposerTrigger,
} from "@/pi/model/composerInput"
import { filterMentions } from "./options"
import type { SlashGroup, SlashRow } from "./types"

/** 斜杠菜单行的 id（输入框的 aria-activedescendant 指向它） */
export function slashRowId(listId: string, key: string): string {
  return `${listId}-slash-${key}`
}

/** @ 菜单第 i 行的 id */
export function mentionRowId(listId: string, index: number): string {
  return `${listId}-mention-${index}`
}

export interface ComposerAssistOptions {
  /** 输入可用（不是只读 / 禁用）、菜单能开（composerBlockOf 的 menusEnabled） */
  enabled: boolean
  /** 手机：Enter 永远换行（design §4.2 第 8 条），菜单里也不用 Enter 选中，靠点 */
  phone: boolean
  draft: string
  /** 光标位置（输入框的 selectionStart） */
  caret: number
  /** 改草稿，并把光标放到 caret */
  setDraft: (next: string, caret: number) => void
  /** 空查询浏览分组；不给 = 不弹斜杠菜单 */
  slashGroups?: SlashGroup[]
  /** 选中一条斜杠命令；不给 = 把"/命令 "填进输入框 */
  onSlashCommand?: (row: SlashRow) => void
  /** @ 候选池；不给 = 不弹 @ 菜单 */
  mentionPool?: readonly string[]
  /** 已挂上的引用 */
  mentions: readonly string[]
  addMention: (path: string) => void
}

/**
 * 挂在 composer 输入框上的斜杠 / @ 菜单（P4 c 线，PLAN 4.1 / 4.5；design E08 E09、§4.7 焦点表"斜杠 / @ 菜单"）：
 *   - 由输入内容打开（composerTriggerOf），焦点一直留在输入框，选中行用输入框的 aria-activedescendant 标出；
 *   - ↑↓ 移动、Enter / Tab 选中（手机不拦 Enter）、Esc 关菜单，处理了的键都 preventDefault（外壳的 Esc 分层就不会再停止生成）；
 *   - 打开期间 usePiLayer(open, "menu") 登记：⌘ 快捷键不触发；焦点不在输入框时 Esc 由外壳按层关它。
 * 菜单本身由 PiComposerAssistMenu 画（PiComposerMenu.tsx）。
 */
export function useComposerAssist(o: ComposerAssistOptions) {
  const listId = useId()
  const trigger: PiComposerTrigger | null = o.enabled
    ? composerTriggerOf(o.draft, o.caret, { slash: o.slashGroups != null, mention: o.mentionPool != null, mentionCount: o.mentions.length })
    : null
  const sig = triggerSignature(trigger)
  // Esc 关掉的那个菜单：签名不变（没再打字、光标没挪）就不再弹
  const [dismissed, setDismissed] = useState<string | null>(null)
  const open = trigger != null && sig !== dismissed
  const groups = trigger?.kind === "slash" ? slashMenuGroups(o.slashGroups ?? [], trigger.query) : []
  const slashRows = groups.flatMap((g) => g.rows)
  const mentionRows = trigger?.kind === "mention" ? filterMentions(o.mentionPool ?? [], trigger.query, o.mentions) : []
  const count = trigger?.kind === "slash" ? slashRows.length : mentionRows.length
  const enabledRows = Array.from({ length: count }, () => true)
  // 选中行跟着菜单签名走：换了查询就回到第一行
  const [wanted, setWanted] = useState<{ sig: string; index: number }>({ sig: "", index: 0 })
  const activeIndex = open ? activeOptionIndex(enabledRows, wanted.sig === sig ? wanted.index : 0) : -1
  const activeId =
    activeIndex < 0
      ? undefined
      : trigger?.kind === "slash"
        ? slashRowId(listId, slashRows[activeIndex]!.key)
        : mentionRowId(listId, activeIndex)

  const dismiss = () => setDismissed(sig)
  usePiLayer(open, "menu", dismiss)

  const select = (index: number) => {
    if (!trigger) return
    if (trigger.kind === "slash") {
      const row = slashRows[index]
      if (!row) return
      if (o.onSlashCommand) o.onSlashCommand(row)
      else o.setDraft(`${row.name} `, row.name.length + 1)
      return
    }
    const path = mentionRows[index]
    if (!path) return
    const next = removeMentionQuery(o.draft, trigger.start, o.caret)
    o.setDraft(next.draft, next.caret)
    o.addMention(path)
  }

  /** 输入框的 onKeyDown 先调它；处理了返回 true（已 preventDefault） */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false
    if (event.nativeEvent.isComposing || event.keyCode === 229) return false
    const plain = !event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey
    if (event.key === "Escape" && plain) {
      event.preventDefault()
      dismiss()
      return true
    }
    if (activeIndex < 0 || !plain) return false
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      setWanted({ sig, index: nextOptionIndex(enabledRows, activeIndex, event.key) })
      return true
    }
    if ((event.key === "Enter" && !o.phone) || event.key === "Tab") {
      event.preventDefault()
      select(activeIndex)
      return true
    }
    return false
  }

  return {
    listId,
    open,
    trigger,
    groups,
    mentionRows,
    activeIndex,
    activeId,
    setActiveIndex: (index: number) => setWanted({ sig, index }),
    select,
    onKeyDown,
    /** 给输入框的属性（textbox 支持 aria-activedescendant / aria-controls / aria-autocomplete） */
    inputAria: {
      "aria-autocomplete": "list" as const,
      "aria-controls": open ? listId : undefined,
      "aria-activedescendant": activeId,
    },
  }
}

export type ComposerAssist = ReturnType<typeof useComposerAssist>
