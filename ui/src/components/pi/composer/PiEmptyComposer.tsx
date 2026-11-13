import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from "react"
import { RoundIconButton, TextSelector } from "@/components/kit"
import { Folder, Laptop, Monitor, Server } from "@/components/kit/icons"
import { usePiStatic } from "@/components/pi/shared/layers"
import { PiSpinner } from "@/components/pi/shared/PiSpinner"
import { useComposerEnter } from "@/pi/headless/useComposerEnter"
import { cn } from "@/lib/utils"
import { PiCMenu } from "./PiCMenu"
import { inputText, SEND_MUTED_STILL, TOUCH_44, type CVariant } from "./styles"

/** 空状态 composer 里能打开的菜单。"model" 只为旧调用方保留：模型现在只读显示，不再有菜单 */
export type PiEmptyMenu = "device" | "folder" | "plus" | "model"

export interface PiEmptyComposerProps extends Omit<ComponentProps<"div">, "children"> {
  variant: CVariant
  /** 设备段：名称 + platform（darwin → 笔记本、win32 → 显示器、linux → 服务器）；null = 只有一台设备，不出现设备段 */
  device?: { name: string; platform: string; offline?: boolean } | null
  /** 目录段：目录名；null = 还没选目录（"选择目录 ∨"，发送不可点） */
  folder?: string | null
  /** 哪个选择器呈打开态（静态态：只认 device / folder，menu 垂在它下面；可交互：受控的打开菜单，配 onOpenChange） */
  open?: PiEmptyMenu | null
  /** 新会话将用的模型（设备默认模型），只读显示：harness_start 不能指定模型，这里不能切 */
  model: { name: string; thinking: string }
  /** 模型名下面的一句说明 */
  modelNote?: string
  draft?: string
  placeholder?: string
  /** 框下内容（建议 pill；或启动中 / 失败的说明） */
  below?: ReactNode
  /** 静态态：打开中的选择器下方垂下的菜单（桌面：PiFolderPicker / PiDeviceMenu），绝对定位、不占高度 */
  menu?: ReactNode
  /* ---------- P4 可交互（静态态不读） ---------- */
  /** true = 静态态；不传时取 PiStaticContext */
  static?: boolean
  onDraftChange?: (draft: string) => void
  /** 发送第一条（发送时才启动 pi，待用户确认 12）：桌面 Enter（⇧Enter 换行）、点黑圆钮；手机只靠黑圆钮 */
  onSend?: () => void
  /** 打开 / 关掉某个菜单（不给时自己记） */
  onOpenChange?: (open: PiEmptyMenu | null) => void
  /** 桌面三个锚定菜单的内容（PiDeviceMenu、PiFolderPicker、PiAttachMenu）；手机由容器开 sheet，只回调 onOpenChange */
  deviceMenu?: ReactNode
  folderMenu?: ReactNode
  plusMenu?: ReactNode
  /** 菜单由容器开底部 sheet（默认 = 手机） */
  menusAsSheet?: boolean
  /** 第一条已发出、正在启动 pi：黑圆钮换成转圈，不能再点 */
  sending?: boolean
}

function platformIcon(platform: string) {
  if (platform === "win32") return <Monitor />
  if (platform === "linux") return <Server />
  return <Laptop />
}

/** 新会话的第一条只能是文字任务：这里没有斜杠 / @ 菜单（会话起来后的追问框才有），占位不提它们 */
export const EMPTY_PLACEHOLDER = "要 pi 做什么？"

/** 拿不到设备默认模型的名字时写这个 */
export const EMPTY_MODEL_FALLBACK = "设备默认模型"
export const EMPTY_MODEL_NOTE = "开始后可在输入框里切换"

/** 框下沿和往下开的菜单之间的间距（同 follow-up composer 上方浮层的 8） */
const MENU_GAP = 8

/**
 * 空状态 composer（design §1.6，empty-state-composer、full-window-empty-state#6–#8）：
 * 框上是选择器（文字 + ∨，不画框，段间只有空隙），中间是大输入框（圆角 10、最少 98 高），框内底行 + / 模型 …… 黑圆钮，框下建议 pill。
 * 先选目录、写第一条，发送时才启动 pi（待用户确认 12）。
 * compose from kit: TextSelector, RoundIconButton；参照 kit Composer(empty)（它的圆钮没有 send-muted 态，所以不直接用）。
 * P4 可交互：真输入框（data-cw-id="pi-new-input"，手机 16px、Enter 换行），设备 / 目录 / + 在桌面是锚定菜单（PiCMenu），
 * 手机由容器开 sheet；输入框在 data-slot="pi-empty-composer" 里（外壳的 Esc 分层据此认 composer 焦点）。
 */
export function PiEmptyComposer({
  variant,
  device,
  folder,
  open,
  model,
  modelNote = EMPTY_MODEL_NOTE,
  draft = "",
  placeholder = EMPTY_PLACEHOLDER,
  below,
  menu,
  static: staticProp,
  onDraftChange,
  onSend,
  onOpenChange,
  deviceMenu,
  folderMenu,
  plusMenu,
  menusAsSheet,
  sending = false,
  className,
  ...rest
}: PiEmptyComposerProps) {
  const isStatic = usePiStatic(staticProp)
  const phone = variant === "phone"
  const sheetMenus = menusAsSheet ?? phone
  const [innerDraft, setInnerDraft] = useState(draft)
  const value = isStatic || onDraftChange ? draft : innerDraft
  const [innerOpen, setInnerOpen] = useState<PiEmptyMenu | null>(null)
  const current = isStatic ? (open ?? null) : onOpenChange ? (open ?? null) : innerOpen
  const setOpen = (next: PiEmptyMenu | null) => (onOpenChange ? onOpenChange(next) : setInnerOpen(next))
  const canSend = folder != null && value.trim().length > 0 && !device?.offline && !sending
  const selectorSize = phone ? "lg" : "md"
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  // 输入区随内容长高（最高 132 / 200，超出框内滚动）
  useLayoutEffect(() => {
    const el = inputRef.current
    if (isStatic || !el) return
    el.style.height = ""
    el.style.height = `${el.scrollHeight}px`
  }, [isStatic, value])

  // 框内底行的 + 菜单往下开，落在框下沿以下 MENU_GAP，不盖住正在写的字：
  // Radix 从触发钮量 sideOffset，所以要加上触发钮下沿到框下沿的距离，打开时量
  const [triggerRise, setTriggerRise] = useState(0)
  const plusOpen = !isStatic && !sheetMenus && current === "plus"
  useLayoutEffect(() => {
    const box = boxRef.current
    const trigger = plusOpen ? box?.querySelector<HTMLElement>('[data-cw-id="pi-new-plus"]') : null
    if (!box || !trigger) return
    const next = Math.max(0, Math.round(box.getBoundingClientRect().bottom - trigger.getBoundingClientRect().bottom))
    setTriggerRise((prev) => (prev === next ? prev : next))
  }, [plusOpen, value])
  const modelLabel = model.thinking ? `${model.name} · ${model.thinking}` : model.name

  const menuNode = (which: "device" | "folder") =>
    isStatic && menu != null && open === which ? (
      <div data-slot="pi-empty-selector-menu" className="absolute top-full left-0 z-(--cw-pi-z-popover) mt-1.5">
        {menu}
      </div>
    ) : null
  /** 可交互：桌面包一层锚定菜单；手机（sheet）点一下只回调 */
  const withMenu = (which: PiEmptyMenu, trigger: ReactElement, content: ReactNode, side: "top" | "bottom", align: "start" | "end", sideOffset = 6) =>
    isStatic || sheetMenus || content == null ? (
      trigger
    ) : (
      <PiCMenu trigger={trigger} open={current === which} onOpenChange={(o) => setOpen(o ? which : null)} side={side} align={align} sideOffset={sideOffset}>
        {content}
      </PiCMenu>
    )
  const sheetClick = (which: PiEmptyMenu, content: ReactNode) =>
    isStatic || (!sheetMenus && content != null) ? undefined : () => setOpen(current === which ? null : which)

  // 发送键偏好（Enter / Ctrl+Enter）与设置页 v2 同一决策；手机 Enter 仍换行。
  const onKeyDown = useComposerEnter({
    value,
    setValue: (next) => (onDraftChange ? onDraftChange(next) : setInnerDraft(next)),
    send: () => onSend?.(),
    canSend,
    mobile: phone,
  })

  return (
    <div data-slot="pi-empty-composer" className={cn("flex w-full min-w-0 flex-col", className)} {...rest}>
      <div data-slot="pi-empty-selectors" className={cn("mb-2.5 flex min-w-0 items-center", phone ? "gap-5 px-1" : "gap-4 px-0.5")}>
        {device && (
          <span className="relative inline-flex min-w-0">
            {withMenu(
              "device",
              <TextSelector
                data-cw-id="pi-new-device"
                icon={platformIcon(device.platform)}
                label={device.offline ? `${device.name} · 未连接` : device.name}
                size={selectorSize}
                open={isStatic ? open === "device" : current === "device"}
                aria-haspopup={!isStatic && sheetMenus ? "dialog" : undefined}
                className={cn(phone && TOUCH_44)}
                onClick={sheetClick("device", deviceMenu)}
              />,
              deviceMenu,
              "bottom",
              "start",
            )}
            {menuNode("device")}
          </span>
        )}
        <span className="relative inline-flex min-w-0">
          {withMenu(
            "folder",
            <TextSelector
              data-cw-id="pi-new-folder"
              icon={<Folder />}
              label={folder ?? "选择目录"}
              size={selectorSize}
              open={isStatic ? open === "folder" : current === "folder"}
              aria-haspopup={!isStatic && sheetMenus ? "dialog" : undefined}
              className={cn(phone && TOUCH_44)}
              onClick={sheetClick("folder", folderMenu)}
            />,
            folderMenu,
            "bottom",
            "start",
          )}
          {menuNode("folder")}
        </span>
      </div>
      <div
        ref={boxRef}
        data-slot="pi-empty-box"
        className={cn(
          "flex min-w-0 flex-col rounded-(--cw-radius-composer-new) border border-solid border-(--cw-border) bg-(--cw-surface) shadow-(--cw-shadow-composer) focus-within:border-(--cw-pi-field-focus-border)",
          phone ? "min-h-[108px]" : "min-h-(--cw-composer-new-min-h)",
        )}
      >
        {isStatic ? (
          <div
            role="textbox"
            aria-multiline="true"
            aria-label={placeholder}
            data-cw-id="pi-new-input"
            className={cn(
              "min-w-0 flex-1 px-3.5 pt-2.5 break-words whitespace-pre-wrap",
              inputText(variant),
              draft ? "text-(--cw-text)" : "text-(--cw-text-4)",
            )}
          >
            {draft || placeholder}
          </div>
        ) : (
          <textarea
            ref={inputRef}
            data-cw-id="pi-new-input"
            rows={2}
            value={value}
            placeholder={placeholder}
            aria-label={placeholder}
            enterKeyHint={phone ? "enter" : "send"}
            spellCheck={false}
            onChange={(event) => (onDraftChange ? onDraftChange(event.currentTarget.value) : setInnerDraft(event.currentTarget.value))}
            onKeyDown={onKeyDown}
            className={cn(
              "block min-w-0 flex-1 resize-none border-0 bg-transparent px-3.5 pt-2.5 text-(--cw-text) placeholder:text-(--cw-text-4)",
              inputText(variant),
              "overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            )}
            style={{ maxHeight: phone ? 132 : 200 }}
          />
        )}
        <div className={cn("flex shrink-0 items-center px-2 pb-2", phone ? "gap-3" : "gap-3.5")}>
          {withMenu(
            "plus",
            <RoundIconButton
              variant="plus"
              data-cw-id="pi-new-plus"
              aria-label="添加图片、文件或命令"
              aria-haspopup={!isStatic && sheetMenus ? "dialog" : "menu"}
              size={phone ? 32 : "md"}
              className={cn(phone && TOUCH_44, phone && "[&>svg]:size-[18px]")}
              onClick={sheetClick("plus", plusMenu)}
            />,
            plusMenu,
            "bottom",
            "start",
            triggerRise + MENU_GAP,
          )}
          {/* 只读：harness_start 不能指定模型，新会话用设备默认模型，会话起来后才能在追问框里切 */}
          <div data-cw-id="pi-new-model" data-slot="pi-new-model" className="flex min-w-0 flex-col leading-(--cw-leading-tight)">
            <span className={cn("truncate text-(--cw-text-2)", phone ? "text-(length:--cw-text-base)" : "text-(length:--cw-text-md)")}>
              <span className="sr-only">新会话使用的模型：</span>
              {modelLabel}
            </span>
            <span className={cn("truncate text-(--cw-text-3)", phone ? "text-(length:--cw-text-sm)" : "text-(length:--cw-text-xs)")}>{modelNote}</span>
          </div>
          <RoundIconButton
            variant={canSend || sending ? "send" : "send-muted"}
            data-cw-id={sending ? "pi-new-sending" : canSend ? "pi-new-send" : "pi-new-send-muted"}
            aria-label={sending ? "正在启动 pi" : canSend ? "发送" : "发送（不可用）"}
            aria-disabled={!canSend || undefined}
            size={phone ? 40 : "md"}
            icon={sending ? <PiSpinner size={phone ? 16 : 12} strokeWidth={phone ? 2 : 1.75} label="正在启动 pi" className="text-(--cw-primary-fg)" /> : undefined}
            className={cn(
              "ml-auto",
              !canSend && !sending && SEND_MUTED_STILL,
              sending && "cursor-default hover:bg-(--cw-primary)",
              phone && "relative after:absolute after:inset-[-4px] after:content-[''] [&>svg]:size-[18px]",
            )}
            {...(isStatic
              ? {}
              : {
                  onPointerDown: (event: { preventDefault(): void }) => event.preventDefault(),
                  onClick: () => {
                    if (canSend) onSend?.()
                  },
                })}
          />
        </div>
      </div>
      {below != null && <div className="mt-3 min-w-0">{below}</div>}
    </div>
  )
}
