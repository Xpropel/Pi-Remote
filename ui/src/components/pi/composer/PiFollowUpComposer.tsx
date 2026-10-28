import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react"
import { FileChip, GhostIconButton, MediaImage, RoundIconButton, TextSelector } from "@/components/kit"
import { Square, X } from "@/components/kit/icons"
import { usePiFrame } from "@/components/pi/shared/frame"
import { usePiControllableOpen, usePiLayer, usePiStatic } from "@/components/pi/shared/layers"
import { cn } from "@/lib/utils"
import { composerBlockOf, composerButtonLabel } from "@/pi/model/composerButton"
import { useComposerEnter } from "@/pi/headless/useComposerEnter"
import { PiMenuCloseContext } from "./menuClose"
import { PiCMenu } from "./PiCMenu"
import { PiComposerAssistMenu } from "./PiComposerMenu"
import type { CImage, SlashGroup, SlashRow } from "./types"
import { C_SECONDARY, inputText, TOUCH_44_BOX, TOUCH_44_SELECTOR, type CVariant } from "./styles"
import { useComposerAssist } from "./useComposerAssist"

export type { PiComposerButton } from "@/pi/model/composerButton"

/** TextSelector 文案段改用需要读的灰（标签 span 自己设色，盖过按钮继承的 kit secondary 色） */
const C_SECONDARY_LABEL = "[&>[data-slot=text-selector-label]]:text-[color:var(--cw-pi-text-secondary,var(--cw-text-3))]"

/**
 * 手机引用 chip 的点击区（§4.4 ≥ 44，N8）：视觉高约 25，::after 高 44、下沿 = chip 下沿，只往上外扩约 19（框的上内距 12 和上一行之间）；
 * 不往下伸，免得压住下一行的待发图角标和输入框（P6 清单 E12，编排 10-25 17:44 定的方案 b：相邻目标隔 8，design §4.4）。
 * 比 44 窄的 chip 左右居中补到 44。
 * ::after 用 -z-10 压在 chip 行（isolate）里所有 chip 的下面：折成多行时外扩区只占行间空白，不盖住别的 chip。
 */
const CHIP_TOUCH_44 =
  "relative after:absolute after:left-1/2 after:bottom-0 after:-z-10 after:h-11 after:w-full after:min-w-11 after:-translate-x-1/2 after:content-['']"

/** 输入区状态机 S0–S7（design §1.6，产品里是 composerMachine.ts） */
export type PiComposerState = "S0" | "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7"

/** 默认占位；非默认只用 §1.6 的三种短句（"写好先排队""输入已禁用""发送时载入"），原因写进框下状态行 */
export const FOLLOW_UP_PLACEHOLDER = "继续追问…"
/** S7 和审批禁用的占位 */
export const BLOCKED_PLACEHOLDER = "输入已禁用"

/** 输入区最高（ComposerCard.tsx 的 INPUT_MAX_HEIGHT_PHONE / INPUT_MAX_HEIGHT），超出在框内滚动 */
const INPUT_MAX_PHONE = 132
const INPUT_MAX_DESKTOP = 200
/** 斜杠 / @ 菜单最高：手机键盘开着时限在可视视口里 288，桌面 360（design slash-menu） */
const ASSIST_MAX_PHONE = 288
const ASSIST_MAX_DESKTOP = 360
/** composer 上沿和浮层下沿的间距（菜单锚点的 mb-2） */
const MENU_GAP = 8
/** 按下时不抢输入框的焦点（手机：键盘不收，design §4.2 第 6、7 条） */
const keepFocus = (event: { preventDefault(): void }) => event.preventDefault()
/** 手机顶栏内容高（量不到顶栏时的兜底：安全区 + 52 = 舞台 99） */
const PHONE_TOPBAR_H = 52

/**
 * 手机 composer 上方的浮层能用多高（P6.3，design §4.2 第 7 条：限在 99…(可视视口高 − dock − 8)）：
 * 从顶栏下沿到 composer 上沿 − 8。可视视口变了（键盘、visualViewport 的 resize / scroll 经视口帧）或 composer 长高时重量。
 * active 为假（没有浮层开着）时返回 null。
 */
function useMenuRoom(rootRef: RefObject<HTMLDivElement | null>, active: boolean): number | null {
  const frame = usePiFrame()
  const [room, setRoom] = useState<number | null>(null)
  const { vvHeight, vvOffsetTop, safeTop, keyboardOpen } = frame
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!active || !el) {
      setRoom(null)
      return
    }
    const measure = () => {
      const bar = el.closest("[data-pi-shell]")?.querySelector("[data-pi-topbar]")
      const limit = bar ? bar.getBoundingClientRect().bottom : vvOffsetTop + safeTop + PHONE_TOPBAR_H
      const next = Math.max(0, Math.floor(el.getBoundingClientRect().top - MENU_GAP - limit))
      setRoom((prev) => (prev === next ? prev : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [rootRef, active, vvHeight, vvOffsetTop, safeTop, keyboardOpen])
  return room
}

/**
 * 手机键盘开着时的 + / 模型菜单（P6.3，design §4.2 第 7 条）：输入框上方的浮层（宽 = composer 宽），不是 sheet——
 * sheet 会被键盘挡住、或者一打开就把键盘收掉。按下浮层里的任何地方都不抢输入框的焦点（键盘不收）；
 * 点浮层和 + / 模型钮以外的地方关闭（登记为 menu 层：有外壳 Esc 分层时 Esc 也关它）。
 * 内容（PiAttachMenu bare、手机 PiModelMenu）选中后经 PiMenuCloseContext 关。
 */
function KeyboardMenu({ kind, maxHeight, onClose, children }: { kind: "plus" | "model"; maxHeight: number | null; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useLayoutEffect(() => {
    close.current = onClose
  })
  usePiLayer(true, "menu", () => close.current())
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target || ref.current?.contains(target) || target.closest('[data-cw-id="pi-composer-plus"],[data-cw-id="pi-composer-model"]')) return
      close.current()
    }
    document.addEventListener("pointerdown", onDown, true)
    return () => document.removeEventListener("pointerdown", onDown, true)
  }, [])
  return (
    <div data-slot="pi-composer-menu-anchor" className="absolute inset-x-0 bottom-full z-(--cw-pi-z-popover) mb-2">
      <div
        ref={ref}
        data-pi-composer-popover={kind}
        className="overflow-y-auto overscroll-contain rounded-[12px] bg-(--cw-surface) p-2 shadow-(--cw-shadow-menu) [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={maxHeight != null ? { maxHeight } : undefined}
        onPointerDown={keepFocus}
        onMouseDown={keepFocus}
      >
        <PiMenuCloseContext.Provider value={() => close.current()}>{children}</PiMenuCloseContext.Provider>
      </div>
    </div>
  )
}

export interface PiFollowUpComposerProps extends Omit<ComponentProps<"div">, "children"> {
  variant: CVariant
  state: PiComposerState
  draft?: string
  images?: CImage[]
  /** @ 引用的路径（框内显示文件名 chip） */
  mentions?: string[]
  model: { name: string; thinking: string }
  /** 两层形态（聚焦或多行时）；有草稿换行、图片或引用时自动两层 */
  layered?: boolean
  placeholder?: string
  /** 文字末尾的静态光标（聚焦中） */
  caret?: boolean
  /** 模型菜单打开（静态态：选择器呈打开态；可交互：受控的打开状态，配 onModelOpenChange） */
  modelOpen?: boolean
  /** + 菜单打开（静态态：+ 呈按下态；可交互：受控的打开状态，配 onPlusOpenChange） */
  plusOpen?: boolean
  /** 替换模型选择器（例如外层包了菜单触发器） */
  modelSlot?: ReactNode
  /** v1.2（D-08）：可答审批卡在等回答（见 PiComposerDock.blockedBy） */
  blockedBy?: "approval" | null
  /** v1.2（D-02）：键盘开着时的原因，放两层上层首行（13px、secondary、单行截断，在引用 chip 行之上） */
  topNote?: string
  /* ---------- P4 可交互（静态态不读） ---------- */
  /** true = 静态态（画廊截图，和冻结版逐像素一致）；不传时取 PiStaticContext（画廊舞台 = true，#/play 与产品 = false） */
  static?: boolean
  /** 改草稿（给了就受控：输入框的值 = draft；不给时输入框自己记） */
  onDraftChange?: (draft: string) => void
  /** 发送：桌面 Enter（⇧Enter 换行）、点黑圆钮；手机只靠黑圆钮（design §4.2 第 8 条） */
  onSend?: () => void
  /** 停止生成：点黑圆停止（S3）或裸停止图标（S4） */
  onStop?: () => void
  /** + 菜单的内容：桌面放进锚定菜单 PiMenu（PiAttachMenu）；手机键盘开着时放进输入框上方的浮层（PiAttachMenu phone bare） */
  plusMenu?: ReactNode
  onPlusOpenChange?: (open: boolean) => void
  /** 模型菜单的内容（PiModelMenu）：桌面锚定菜单；手机键盘开着时输入框上方的浮层 */
  modelMenu?: ReactNode
  onModelOpenChange?: (open: boolean) => void
  /**
   * + / 模型由容器开底部 PiSheet（手机键盘收起时，design §4.2 第 7 条），这里只回调 on…OpenChange；默认 = 手机。
   * 手机传 false（键盘开着）：+ / 模型是输入框上方的浮层（内容 = plusMenu / modelMenu），按下不抢输入框焦点
   */
  menusAsSheet?: boolean
  /** 斜杠菜单：空查询的浏览分组；不给 = 不弹 */
  slashGroups?: SlashGroup[]
  /** 选中一条斜杠命令；不给 = 把"/命令 "填进输入框 */
  onSlashCommand?: (row: SlashRow) => void
  /** @ 候选池（本会话出现过的文件）；不给 = 不弹 */
  mentionPool?: readonly string[]
  /** 改引用（选中 @ 候选、空输入框里退格删最后一个）；不给时自己记 */
  onMentionsChange?: (paths: string[]) => void
  /** 移除第 i 张待发图 */
  onRemoveImage?: (index: number) => void
  /**
   * P5 桌面 ↑ / ↓ 提示词历史（design K04）：只在桌面、不在输入法组字、没按修饰键、输入框可输入（不是 S7、不是审批只读）、
   * 斜杠 / @ 菜单没拦下时回调；返回 true = 已经换了草稿（拦掉默认的移动光标，光标放到末尾）。手机不回调。不给 = 方向键照常
   */
  onHistoryKey?: (key: { direction: "older" | "newer"; value: string; selectionStart: number | null; selectionEnd: number | null }) => boolean
}

/** 静态光标：1px 竖线，跟在文字末尾 */
function Caret() {
  return <span aria-hidden data-slot="pi-composer-caret" className="ml-px inline-block h-[1.1em] w-px bg-(--cw-text) align-[-0.18em]" />
}

const INTERACTIVE_TARGET = "button, a, input, textarea, select, [role='option'], [role='menuitem'], [contenteditable='true']"

/**
 * follow-up composer（design §1.6）：空闲时单行胶囊，聚焦或多行时长成两层。
 * 框内槽位固定：左 +，其右"模型 · 思考级别 ∨"，最右黑圆钮（S4 时其左多一个裸停止图标）。
 * 视觉尺寸：桌面单行 46 / 两层 ≥ 98，圆钮 26；手机单行 52 / 两层 ≥ 92，圆钮 40（点击区 48）、+ 32（点击区 44）。
 * 两层形态的圆角 20 是推断（Cursor 只拍到单行胶囊和空状态大框）。
 * 黑圆钮的状态与名称按 composerBlockOf（pi/model/composerButton.ts）："发送 / 停止 / 发送（不可用）"（§4.7）。
 *
 * P4 可交互（不是静态态时）：真输入框 textarea（data-cw-id="pi-composer-input"，手机 16px、Enter 换行）；
 * 输入框聚焦时长成两层（单行 / 两层切换时输入框不重建：子元素带 key，焦点和光标都留着）；
 * 斜杠 / @ 菜单挂在输入框上（useComposerAssist）；+ / 模型桌面是锚定菜单（PiCMenu），手机由容器开 sheet。
 * P6.3（design §4.2 第 7 条）：手机键盘开着时 + / 模型是输入框上方的浮层（KeyboardMenu），斜杠 / @ 菜单同一个位置；
 * 这几个浮层都限在顶栏下沿 … composer 上沿 − 8 之间（useMenuRoom）。点击区按邻居间距收窄（TOUCH_44_BOX / SELECTOR，清单 E12）。
 */
export function PiFollowUpComposer({
  variant,
  state,
  draft = "",
  images = [],
  mentions = [],
  model,
  layered,
  placeholder,
  caret,
  modelOpen,
  plusOpen,
  modelSlot,
  blockedBy,
  topNote,
  static: staticProp,
  onDraftChange,
  onSend,
  onStop,
  plusMenu,
  onPlusOpenChange,
  modelMenu,
  onModelOpenChange,
  menusAsSheet,
  slashGroups,
  onSlashCommand,
  mentionPool,
  onMentionsChange,
  onRemoveImage,
  onHistoryKey,
  className,
  ...rest
}: PiFollowUpComposerProps) {
  const isStatic = usePiStatic(staticProp)
  const phone = variant === "phone"
  const sheetMenus = menusAsSheet ?? phone

  /* ---------- 草稿、光标、引用（可交互：受控或自己记；静态态：只读 props） ---------- */
  const [innerDraft, setInnerDraft] = useState(draft)
  const value = isStatic || onDraftChange ? draft : innerDraft
  const [innerMentions, setInnerMentions] = useState(mentions)
  const mentionList = isStatic || onMentionsChange ? mentions : innerMentions
  const setMentions = (next: string[]) => (onMentionsChange ? onMentionsChange(next) : setInnerMentions(next))
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [caretAt, setCaretAt] = useState(value.length)
  const pendingCaret = useRef<number | null>(null)
  const setDraftValue = (next: string, nextCaret: number) => {
    if (onDraftChange) onDraftChange(next)
    else setInnerDraft(next)
    setCaretAt(nextCaret)
    pendingCaret.current = nextCaret
  }
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el || pendingCaret.current == null) return
    const at = Math.min(pendingCaret.current, el.value.length)
    pendingCaret.current = null
    el.setSelectionRange(at, at)
  })

  const hasContent = value.trim().length > 0 || images.length > 0
  const disabled = state === "S7"
  // v1.2 D-08：审批禁用不是 S7。输入只读（草稿保留），+ / / / @ 不响应；停止不受影响
  const blocked = blockedBy === "approval"
  const block = composerBlockOf(state, blockedBy ?? null, hasContent)
  const btn = block.button
  const canSend = btn.variant === "send" && !btn.disabled
  const hint = blocked ? BLOCKED_PLACEHOLDER : (placeholder ?? FOLLOW_UP_PLACEHOLDER)
  // 非默认短占位（§1.6 的"写好先排队""输入已禁用""发送时载入"）用需要读的灰字（§4.6）
  const reasonHint = !value && hint !== FOLLOW_UP_PLACEHOLDER
  // 手机 S7 和审批禁用：输入不可用，模型选择器没用，隐藏；胶囊仍是单行（§1.6）
  const hideModel = phone && block.hideModelOnPhone && modelSlot == null
  const hintColor = reasonHint ? C_SECONDARY : "text-(--cw-text-4)"

  /* ---------- 菜单 ---------- */
  const [plusIsOpen, setPlusOpen] = usePiControllableOpen(isStatic ? undefined : plusOpen, onPlusOpenChange)
  const [modelIsOpen, setModelOpen] = usePiControllableOpen(isStatic ? undefined : modelOpen, onModelOpenChange)
  const plusPressed = (isStatic ? plusOpen : plusIsOpen) && !blocked
  const modelPressed = isStatic ? modelOpen : modelIsOpen
  const assist = useComposerAssist({
    enabled: !isStatic && block.menusEnabled,
    phone,
    draft: value,
    caret: Math.min(caretAt, value.length),
    setDraft: setDraftValue,
    slashGroups,
    onSlashCommand,
    mentionPool,
    mentions: mentionList,
    addMention: (path) => setMentions([...mentionList, path]),
  })
  // P6.3（design §4.2 第 7 条）：手机键盘开着（menusAsSheet 为假）时 + / 模型是输入框上方的浮层（KeyboardMenu），按下不抢输入框焦点；
  // 键盘收起回到 sheet（容器开）。桌面照旧是锚定菜单（PiCMenu）
  const popoverMenus = !isStatic && phone && !sheetMenus
  const plusPopover = popoverMenus && !assist.open && plusIsOpen && plusMenu != null && !disabled && !blocked
  const modelPopover = popoverMenus && !assist.open && !plusPopover && modelIsOpen && modelMenu != null && !disabled && !hideModel
  // 键盘收起（浮层换成 sheet）、或键盘开着时斜杠 / @ 菜单打开（同一个位置）：开着的 + / 模型浮层关掉
  const lastMode = useRef({ popover: popoverMenus, assist: assist.open })
  useEffect(() => {
    const was = lastMode.current
    lastMode.current = { popover: popoverMenus, assist: assist.open }
    const leftPopover = was.popover && !popoverMenus
    const assistOpened = popoverMenus && assist.open && !was.assist
    if (!leftPopover && !assistOpened) return
    if (plusIsOpen) setPlusOpen(false)
    if (modelIsOpen) setModelOpen(false)
  }, [popoverMenus, assist.open, plusIsOpen, modelIsOpen, setPlusOpen, setModelOpen])

  /* ---------- 聚焦时两层（可交互） ---------- */
  const rootRef = useRef<HTMLDivElement>(null)
  // 手机上 composer 上方的浮层（斜杠 / @、键盘开着时的 + / 模型）能用的高度：顶栏下沿 … composer 上沿 − 8
  const menuRoom = useMenuRoom(rootRef, !isStatic && phone && (assist.open || plusPopover || modelPopover))
  // 输入框聚焦 → expanded；焦点留在框里（含 + / 模型钮）或菜单开着时保持两层；都不是了就收回单行。
  // 菜单开着时焦点在 portal 出去的菜单里，焦点离开 composer 也不收；菜单关上、焦点没回来时按 focusLayer 收回。
  const [focusWithin, setFocusWithin] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const pointerInside = useRef(false)
  // 指针此刻按着没有（document 捕获阶段记）：框外按下导致的失焦等抬起再收，见 onBlur
  const pointerPressed = useRef(false)
  useEffect(() => {
    if (isStatic) return
    const down = () => {
      pointerPressed.current = true
    }
    const up = () => {
      pointerPressed.current = false
    }
    document.addEventListener("pointerdown", down, true)
    window.addEventListener("pointerup", up, true)
    window.addEventListener("pointercancel", up, true)
    return () => {
      document.removeEventListener("pointerdown", down, true)
      window.removeEventListener("pointerup", up, true)
      window.removeEventListener("pointercancel", up, true)
    }
  }, [isStatic])
  const anyMenuOpen = plusIsOpen || modelIsOpen || assist.open
  const menuOpenRef = useRef(anyMenuOpen)
  useLayoutEffect(() => {
    menuOpenRef.current = anyMenuOpen
  })
  const focusLayer = !isStatic && expanded && (focusWithin || anyMenuOpen)
  const leave = () => {
    setFocusWithin(false)
    if (!menuOpenRef.current) setExpanded(false)
  }
  // v1.2 撤回 fix-c 的"手机 S5 / 未载入自动两层"：两层只在聚焦、多行、有附件 / 引用或键盘打开（layered）时出现
  const twoLayer = layered || value.includes("\n") || images.length > 0 || mentionList.length > 0 || focusLayer

  // 两层时输入区随内容长高（最高 132 / 200，超出框内滚动）；单行时一行
  useLayoutEffect(() => {
    const el = inputRef.current
    if (isStatic || !el) return
    el.style.height = ""
    if (twoLayer) el.style.height = `${el.scrollHeight}px`
  }, [isStatic, twoLayer, value])

  const rootInteractive = isStatic
    ? {}
    : {
        ref: rootRef,
        onFocus: (event: FocusEvent<HTMLDivElement>) => {
          // 从外面直接聚焦到 + / 模型钮（不是输入框）：不长成两层（清掉上一轮遗留的 expanded）
          if ((event.target as Element) !== inputRef.current && !focusWithin && !anyMenuOpen) setExpanded(false)
          setFocusWithin(true)
        },
        onBlur: (event: FocusEvent<HTMLDivElement>) => {
          const next = event.relatedTarget as Node | null
          if ((next && event.currentTarget.contains(next)) || pointerInside.current) return
          // 指针在框外按下（框上方的审批卡「允许」、tray 的 pill）：等这一下抬起、click 发完再收回单行。
          // 按下就收的话框先变矮，上方的按钮跟着往下挪，抬起时已不在指针下，这一下点不中（L3 L09 / L25）
          if (pointerPressed.current) {
            const done = () => {
              window.removeEventListener("pointerup", done)
              window.removeEventListener("pointercancel", done)
              window.setTimeout(() => {
                if (!rootRef.current?.contains(document.activeElement)) leave()
              }, 0)
            }
            window.addEventListener("pointerup", done)
            window.addEventListener("pointercancel", done)
            return
          }
          leave()
        },
        // 指针在框里按下的这一下（Safari 点按钮不给焦点）不算离开：等抬起后再看焦点在不在框里
        onPointerDownCapture: () => {
          pointerInside.current = true
          window.addEventListener(
            "pointerup",
            () =>
              window.setTimeout(() => {
                pointerInside.current = false
                if (!rootRef.current?.contains(document.activeElement)) leave()
              }, 0),
            { once: true },
          )
        },
        // 点框里的空白处 = 聚焦输入框
        onMouseDown: (event: MouseEvent<HTMLDivElement>) => {
          if ((event.target as HTMLElement).closest(INTERACTIVE_TARGET)) return
          event.preventDefault()
          inputRef.current?.focus()
        },
      }

  /* ---------- 部件 ---------- */
  // 浮层模式（手机键盘开着）：按下 + / 模型不抢输入框的焦点，键盘不收（同黑圆钮）；点一下开关浮层
  const keepInputFocus = popoverMenus ? { onPointerDown: keepFocus, onMouseDown: keepFocus } : {}
  const plusButton = (
    <RoundIconButton
      variant="plus"
      data-cw-id="pi-composer-plus"
      aria-label="添加图片、文件或命令"
      aria-haspopup={!isStatic && sheetMenus ? "dialog" : "menu"}
      aria-expanded={plusPressed ? true : false}
      disabled={disabled || blocked}
      forced={plusPressed ? "pressed" : undefined}
      size={phone ? 32 : "md"}
      className={cn(phone && TOUCH_44_BOX, phone && "[&>svg]:size-[18px]")}
      onClick={!isStatic && (sheetMenus || popoverMenus || plusMenu == null) ? () => setPlusOpen(!plusIsOpen) : undefined}
      {...keepInputFocus}
    />
  )
  const plus =
    !isStatic && !sheetMenus && !popoverMenus && plusMenu != null && !disabled && !blocked ? (
      <PiCMenu trigger={plusButton} open={plusIsOpen} onOpenChange={setPlusOpen} side="top" align="start" sideOffset={8}>
        {plusMenu}
      </PiCMenu>
    ) : (
      plusButton
    )
  const selector = (
    <TextSelector
      data-cw-id="pi-composer-model"
      tone="secondary"
      size={phone ? "lg" : "md"}
      // P5：模型不支持思考级别时（thinking 为空）只写模型名
      label={model.thinking ? `${model.name} · ${model.thinking}` : model.name}
      aria-label={model.thinking ? `模型 ${model.name}，思考级别 ${model.thinking}，切换模型` : `模型 ${model.name}，切换模型`}
      aria-haspopup={!isStatic && sheetMenus ? "dialog" : "menu"}
      aria-expanded={modelPressed ? true : false}
      open={modelPressed}
      disabled={disabled}
      // C6：模型名是用户判断当前模型的唯一可见信息，文字用 --cw-pi-text-secondary（kit secondary 是 --cw-text-3，3.8:1）
      className={cn("min-w-0", C_SECONDARY_LABEL, phone && TOUCH_44_SELECTOR)}
      onClick={!isStatic && (sheetMenus || popoverMenus || modelMenu == null) ? () => setModelOpen(!modelIsOpen) : undefined}
      {...keepInputFocus}
    />
  )
  const modelNode = hideModel
    ? null
    : (modelSlot ??
      (!isStatic && !sheetMenus && !popoverMenus && modelMenu != null && !disabled ? (
        <PiCMenu trigger={selector} open={modelIsOpen} onOpenChange={setModelOpen} side="top" align="end" sideOffset={8}>
          {modelMenu}
        </PiCMenu>
      ) : (
        selector
      )))
  const ghostStop = btn.ghostStop ? (
    <GhostIconButton
      data-cw-id="pi-composer-ghost-stop"
      label="停止生成"
      icon={<Square />}
      className={cn(phone && cn(TOUCH_44_BOX, "size-8 [&>svg]:size-5"))}
      onClick={isStatic ? undefined : onStop}
    />
  ) : null
  const action = (
    <RoundIconButton
      variant={btn.variant}
      data-cw-id={`pi-composer-${btn.variant}`}
      aria-label={composerButtonLabel(btn)}
      disabled={btn.disabled && btn.variant !== "send-muted"}
      aria-disabled={btn.disabled || undefined}
      size={phone ? 40 : "md"}
      className={cn(
        phone && "relative after:absolute after:inset-[-4px] after:content-['']",
        phone && btn.variant !== "stop" && "[&>svg]:size-[18px]",
        phone && btn.variant === "stop" && "[&>span]:size-[12px] [&>span]:rounded-[3px]",
      )}
      {...(isStatic
        ? {}
        : {
            // 点发送不抢输入框的焦点（手机：不收键盘，design §4.2 第 6 条）
            onPointerDown: (event: { preventDefault(): void }) => event.preventDefault(),
            onClick: () => {
              if (btn.variant === "stop") onStop?.()
              else if (canSend) onSend?.()
            },
          })}
    />
  )

  // 发送键偏好（Enter / Ctrl+Enter）：与设置页 v2 的 prefs.sendKey 同一决策；
  // 光标由本组件自己的 pendingCaret 恢复，所以 restoreCaret=false。
  const onComposerEnter = useComposerEnter({
    value,
    setValue: (next, caret) => setDraftValue(next, caret),
    send: () => onSend?.(),
    canSend,
    mobile: phone,
    disabled,
    readOnly: blocked,
    restoreCaret: false,
  })

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (assist.onKeyDown(event)) return
    if (onComposerEnter(event)) return
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
    const el = event.currentTarget
    // K04 桌面 ↑ / ↓ 提示词历史：拦不拦（光标在首 / 末行）由容器按 chat/promptHistory.ts 判断；换了草稿就把光标放到末尾
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && plain && !phone && onHistoryKey && !disabled && !blocked) {
      const handled = onHistoryKey({
        direction: event.key === "ArrowUp" ? "older" : "newer",
        value: el.value,
        selectionStart: el.selectionStart,
        selectionEnd: el.selectionEnd,
      })
      if (handled) {
        event.preventDefault()
        setCaretAt(Number.MAX_SAFE_INTEGER)
        pendingCaret.current = Number.MAX_SAFE_INTEGER
        return
      }
    }
    // 空输入框（光标在最前）里退格：去掉最后一个引用 chip
    if (event.key === "Backspace" && plain && mentionList.length > 0 && el.selectionStart === 0 && el.selectionEnd === 0) {
      event.preventDefault()
      setMentions(mentionList.slice(0, -1))
    }
  }

  const text = isStatic ? (
    <div
      role="textbox"
      aria-multiline={twoLayer}
      aria-label={hint}
      aria-disabled={disabled || undefined}
      aria-readonly={blocked || undefined}
      data-cw-id="pi-composer-input"
      className={cn(
        "min-w-0 break-words whitespace-pre-wrap",
        inputText(variant),
        draft ? "text-(--cw-text)" : hintColor,
        // 单行胶囊：一般占位截断；手机 S7 的原因占位最多两行（胶囊跟着长高）
        !twoLayer && (hideModel && reasonHint ? "line-clamp-2" : "truncate whitespace-nowrap"),
        // 输入区上限（INPUT_MAX_HEIGHT：手机 132、桌面 200）只管文字，超出在框内滚动；引用 chip 行和缩略图不算在内
        twoLayer && (phone ? "max-h-[132px]" : "max-h-[200px]"),
        twoLayer && "overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
      )}
    >
      {draft || (caret ? null : hint)}
      {caret && <Caret />}
      {!draft && caret && <span className={hintColor}>{hint}</span>}
    </div>
  ) : (
    <textarea
      ref={inputRef}
      data-cw-id="pi-composer-input"
      rows={1}
      wrap={twoLayer ? "soft" : "off"}
      value={value}
      placeholder={hint}
      aria-label={hint}
      readOnly={blocked}
      aria-readonly={blocked || undefined}
      disabled={disabled}
      enterKeyHint={phone ? "enter" : "send"}
      spellCheck={false}
      onChange={(event) => {
        const el = event.currentTarget
        if (onDraftChange) onDraftChange(el.value)
        else setInnerDraft(el.value)
        setCaretAt(el.selectionStart ?? el.value.length)
      }}
      onSelect={(event) => setCaretAt(event.currentTarget.selectionStart ?? 0)}
      onFocus={(event) => {
        setExpanded(true)
        // 草稿可能是外面改的（斜杠命令填进来、"命令…"）：聚焦时按输入框的真实光标对齐一次
        setCaretAt(event.currentTarget.selectionStart ?? value.length)
      }}
      onKeyDown={onKeyDown}
      {...assist.inputAria}
      className={cn(
        "block w-full min-w-0 resize-none border-0 bg-transparent p-0 text-(--cw-text)",
        inputText(variant),
        reasonHint ? "placeholder:text-[color:var(--cw-pi-text-secondary,var(--cw-text-3))]" : "placeholder:text-(--cw-text-4)",
        // 单行胶囊里输入框只有一行高（22）：上下各补 11 的内距、再用负外距抵掉，点击区 44（§4.4），胶囊高度和文字位置不变
        twoLayer ? "overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "-my-[11px] overflow-hidden py-[11px]",
        disabled && "cursor-not-allowed",
      )}
      style={{ maxHeight: twoLayer ? (phone ? INPUT_MAX_PHONE : INPUT_MAX_DESKTOP) : undefined }}
    />
  )

  // 子元素都带 key：单行 ↔ 两层切换时 top（里面是输入框）留在原地不重建，焦点和光标不丢
  const top = (
    <div
      key="top"
      data-slot={twoLayer ? "pi-composer-top" : undefined}
      className={twoLayer ? "flex min-w-0 flex-col gap-2 px-3.5 pt-3" : "min-w-0 flex-1"}
    >
      {twoLayer && topNote && (
        <div role="status" data-slot="pi-composer-top-note" className={cn("min-w-0 truncate text-[13px] leading-[18px]", C_SECONDARY)}>
          {topNote}
        </div>
      )}
      {twoLayer && mentionList.length > 0 && (
        <div data-slot="pi-composer-mentions" className={cn("flex min-w-0 flex-wrap items-center gap-1.5", phone && "isolate")}>
          {mentionList.map((path) => (
            <FileChip key={path} tone="blue" title={path} className={cn(phone && cn("text-[13px]", CHIP_TOUCH_44))}>
              {path.split("/").pop()}
            </FileChip>
          ))}
        </div>
      )}
      {twoLayer && images.length > 0 && (
        <div data-slot="pi-composer-images" className="flex min-w-0 items-center gap-2">
          {images.map((img, i) => (
            <div key={i} className="relative size-12 shrink-0">
              <MediaImage
                placeholder="screenshot"
                aria-label={`待发图片 ${i + 1}（${img.mimeType.replace("image/", "")}）`}
                className="m-0 size-12 aspect-auto rounded-[8px] border-(--cw-border)"
              >
                {/* P5：有真实像素时画缩略图；没有（画廊屏、fixture）用占位 */}
                {img.src ? <img src={img.src} alt="" className="absolute inset-0 size-full object-cover" /> : undefined}
              </MediaImage>
              <button
                type="button"
                aria-label="移除这张图"
                className={cn(
                  "absolute inline-flex size-[18px] items-center justify-center rounded-full bg-(--cw-primary) text-(--cw-primary-fg) shadow-(--cw-shadow-float)",
                  // 桌面照冻结版式上探 6。手机（P6 清单 E12，编排 10-25 17:44 方案 b）：角标收进缩略图右上角，不上探
                  // （原来离上一行的引用 chip 只隔 2px）；点击区 44×44 从角标右上角只往左、往下外扩，不伸进 chip 行。
                  // 不能用 TOUCH_44：它带 relative，会盖掉这里的 absolute
                  phone ? "top-1 right-1 after:absolute after:top-0 after:right-0 after:size-11 after:content-['']" : "-top-1.5 -right-1.5",
                )}
                onClick={isStatic ? undefined : () => onRemoveImage?.(i)}
              >
                <X aria-hidden size={11} strokeWidth={2.5} />
              </button>
            </div>
          ))}
        </div>
      )}
      {text}
    </div>
  )
  // 斜杠 / @ 菜单：浮在 composer 上沿（宽 = composer 宽），不占高度；手机再限在顶栏下沿以下（menuRoom）
  const assistMenu = assist.open ? (
    <div key="assist" data-slot="pi-composer-menu-anchor" className="absolute inset-x-0 bottom-full z-(--cw-pi-z-popover) mb-2">
      <PiComposerAssistMenu
        assist={assist}
        variant={variant}
        pool={mentionPool}
        selected={mentionList}
        maxHeight={phone ? Math.min(ASSIST_MAX_PHONE, menuRoom ?? ASSIST_MAX_PHONE) : ASSIST_MAX_DESKTOP}
      />
    </div>
  ) : null
  // 手机键盘开着时的 + / 模型浮层（同一个位置，和斜杠 / @ 菜单互斥）
  const keyboardMenu = plusPopover ? (
    <KeyboardMenu key="keyboard-menu" kind="plus" maxHeight={menuRoom} onClose={() => setPlusOpen(false)}>
      {plusMenu}
    </KeyboardMenu>
  ) : modelPopover ? (
    <KeyboardMenu key="keyboard-menu" kind="model" maxHeight={menuRoom} onClose={() => setModelOpen(false)}>
      {modelMenu}
    </KeyboardMenu>
  ) : null

  if (!twoLayer) {
    return (
      <div
        data-slot="pi-follow-up-composer"
        data-state={state}
        data-layered="false"
        className={cn(
          "flex min-w-0 items-center rounded-(--cw-radius-composer) border border-solid border-(--cw-border) bg-(--cw-surface) shadow-(--cw-shadow-composer) focus-within:border-(--cw-pi-field-focus-border)",
          phone ? "min-h-[52px] gap-2 py-1 pr-1.5 pl-2.5" : "h-(--cw-composer-min-h) gap-2 px-2.5",
          disabled && "bg-(--cw-bg)",
          !isStatic && "relative",
          className,
        )}
        {...rootInteractive}
        {...rest}
      >
        {[
          <Fragment key="plus">{plus}</Fragment>,
          top,
          <div key="controls" className="flex shrink-0 items-center gap-2.5">
            {modelNode}
            {ghostStop}
            {action}
          </div>,
          assistMenu,
          keyboardMenu,
        ]}
      </div>
    )
  }

  return (
    <div
      data-slot="pi-follow-up-composer"
      data-state={state}
      data-layered="true"
      className={cn(
        "flex min-w-0 flex-col rounded-[20px] border border-solid border-(--cw-border) bg-(--cw-surface) shadow-(--cw-shadow-composer) focus-within:border-(--cw-pi-field-focus-border)",
        phone ? "min-h-[92px]" : "min-h-(--cw-composer-new-min-h)",
        disabled && "bg-(--cw-bg)",
        !isStatic && "relative",
        className,
      )}
      {...rootInteractive}
      {...rest}
    >
      {[
        // 上层：引用 chip 行 → 待发缩略图 → 文字（文字区最高 132 / 200，超出框内滚动）
        top,
        // 下层：+ / 模型 · 思考级别 ∨ …… [裸停止] 黑圆钮
        <div key="bottom" className={cn("mt-auto flex min-w-0 items-center gap-2.5 px-2 pt-2 pb-2", phone && "gap-3 px-2 pb-2")}>
          {plus}
          <div className="flex min-w-0 flex-1 items-center">{modelNode}</div>
          {ghostStop}
          {action}
        </div>,
        assistMenu,
        keyboardMenu,
      ]}
    </div>
  )
}
