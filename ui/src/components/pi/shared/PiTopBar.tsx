import type { FocusEvent, ReactNode } from "react"
import { cn } from "@/lib/utils"
import { GhostIconButton, TitleBar } from "@/components/kit"
import { ChevronLeft, Ellipsis, PanelRight, Plus, Search } from "@/components/kit/icons"
import { PiIconButton, PiMark, PiPlatformIcon } from "./PiMark"
import { usePiControllableOpen, usePiLayer, usePiStatic } from "./layers"

export interface PiTopBarProps {
  /**
   * desktop：主区顶栏 44（kit TitleBar variant=main）；phone-list：列表页（PiMark + Pi-Remote，右侧搜索 / 新建）；
   * phone-chat：对话页（‹ 返回 + 计数、居中标题 + 设备图标、…）；phone-page：推入页（‹ + 页名）。
   */
  variant: "desktop" | "phone-list" | "phone-chat" | "phone-page"
  /** 会话标题 / 页名（phone-page 可传 TextSelector 等节点） */
  title?: ReactNode
  /** 标题后的设备小图标（Device.platform） */
  platform?: string
  /** phone-chat：返回键旁的蓝色计数（其他会话的注意力条数），0 / 不传 = 不显示 */
  backCount?: number
  /** desktop：标题悬停卡（PiSessionInfoCard） */
  hoverCard?: ReactNode
  /** desktop：悬停卡打开。静态态 = 静态打开（session-info 屏）；可交互时给了就受控，不给就由 Radix HoverCard 按悬停开合 */
  hoverCardOpen?: boolean
  /** desktop：悬停卡开合（可交互） */
  onHoverCardOpenChange?: (open: boolean) => void
  /** desktop：右 pane 打开（分屏钮呈按下态） */
  paneOpen?: boolean
  /** desktop：点分屏钮（= ⌘.） */
  onTogglePane?: () => void
  /** 右端动作，替换默认按钮 */
  actions?: ReactNode
  /** desktop：false = 不要右端动作槽（主区没有会话时的空顶栏；kit TitleBar showActions） */
  showActions?: boolean
  /** phone-list：整条换成搜索框（session-search 屏） */
  search?: ReactNode
  /** phone-list：点搜索 / 新建 */
  onSearch?: () => void
  onNewSession?: () => void
  /** phone-chat / phone-page：点 ‹ */
  onBack?: () => void
  /** phone-chat：点标题（打开会话信息 sheet，design B06）。可交互时标题渲染成按钮 */
  onTitleClick?: () => void
  /** P4 契约：静态态（画廊截图）。不传时取 PiStaticContext */
  static?: boolean
  className?: string
}

/**
 * phone-chat / phone-page 的返回键：‹ + 可选蓝色计数，点击区 48 高。
 * 计数不播报，写进名称（design §4.7）：phone-chat"返回会话列表，3 个会话需要处理"；phone-page"返回"。
 */
function BackButton({ count, toList = false, onClick }: { count?: number; toList?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      aria-label={toList ? (count ? `返回会话列表，${count} 个会话需要处理` : "返回会话列表") : "返回"}
      data-pi-back=""
      onClick={onClick}
      className="inline-flex h-12 min-w-12 shrink-0 items-center rounded-full pr-2 pl-1.5 text-(--cw-text) outline-none select-none"
    >
      <ChevronLeft aria-hidden size={26} strokeWidth={2} />
      {count ? (
        <span data-pi-back-count="" className="-ml-0.5 text-[16px] leading-5 font-medium text-(--cw-pi-attention-text) tabular-nums">
          {count}
        </span>
      ) : null}
    </button>
  )
}

/**
 * 可交互时给标题加焦点兜底标记（design §4.7：弹窗 / sheet 的触发元素不在了，焦点回顶栏标题）。
 * tabIndex -1：只能被程序聚焦，不进 Tab 顺序。静态态不加，DOM 与冻结版一致。
 */
function fallbackProps(interactive: boolean) {
  return interactive
    ? {
        "data-pi-focus-fallback": "",
        tabIndex: -1,
        // 焦点被送回这里（弹窗关了、触发元素没了）时不要顺带弹出标题悬停卡：Radix HoverCard.Trigger 的 onFocus 会跳过已 preventDefault 的事件
        onFocus: (event: FocusEvent) => event.preventDefault(),
      }
    : {}
}

/**
 * 顶栏（design §6.3）。桌面用 kit TitleBar（标题胶囊 + 悬停卡 + 右端 … / 分屏），高改成 44；
 * 手机三种形态 compose from kit GhostIconButton（点击区 48×48，design §4.4）。
 * 可交互（P4.1）：桌面标题悬停卡 = TitleBar 的 Radix HoverCard（打开期间登记为 overlay 层，Esc 由 Radix 关）；手机点标题回调 onTitleClick。
 */
export function PiTopBar({
  variant,
  title,
  platform,
  backCount,
  hoverCard,
  hoverCardOpen,
  onHoverCardOpenChange,
  paneOpen,
  onTogglePane,
  actions,
  showActions = true,
  search,
  onSearch,
  onNewSession,
  onBack,
  onTitleClick,
  static: staticProp,
  className,
}: PiTopBarProps) {
  const isStatic = usePiStatic(staticProp)
  const interactive = !isStatic
  const [cardOpen, setCardOpen] = usePiControllableOpen(hoverCardOpen, onHoverCardOpenChange)
  usePiLayer(interactive && hoverCard != null && cardOpen, "overlay", () => setCardOpen(false))

  if (variant === "desktop") {
    const titleNode =
      title != null ? (
        <span className="inline-flex min-w-0 items-center" {...fallbackProps(interactive)}>
          <span className="min-w-0 truncate">{title}</span>
          {platform && <PiPlatformIcon platform={platform} size={14} className="ml-[9px]" />}
        </span>
      ) : undefined
    return (
      <TitleBar
        data-pi-topbar="desktop"
        variant="main"
        title={titleNode}
        titleMaxWidth={560}
        hoverCard={hoverCard}
        {...(isStatic ? { hoverCardOpen } : { hoverCardOpen: cardOpen, onHoverCardOpenChange: setCardOpen })}
        // 悬停卡距标题 6（design §3.3 session-info；kit 默认 10，kit-requests pi a3）
        hoverCardOffset={6}
        showActions={showActions}
        actions={
          actions ?? (
            <>
              <GhostIconButton label="更多" icon={<Ellipsis />} />
              <GhostIconButton
                label="打开 / 关闭右侧面板 ⌘."
                icon={<PanelRight />}
                forced={paneOpen ? "pressed" : undefined}
                onClick={onTogglePane}
                aria-pressed={interactive ? !!paneOpen : undefined}
              />
            </>
          )
        }
        className={cn("h-(--cw-pi-topbar-h) pb-0", className)}
      />
    )
  }

  const bar = "relative flex h-(--cw-pi-topbar-h-phone) shrink-0 items-center"

  if (variant === "phone-list") {
    if (search != null) {
      return (
        <div data-pi-topbar="phone-search" className={cn(bar, "gap-2 pr-2 pl-4", className)}>
          {search}
        </div>
      )
    }
    return (
      <div data-pi-topbar="phone-list" className={cn(bar, "pr-1 pl-4", className)}>
        <PiMark size={22} />
        <span className="ml-2.5 text-[17px] leading-[22px] font-semibold text-(--cw-text)" {...fallbackProps(interactive)}>
          Pi-Remote
        </span>
        <span className="ml-auto flex items-center">
          {actions ?? (
            <>
              <PiIconButton label="搜索会话" icon={<Search />} onClick={onSearch} />
              <PiIconButton label="新建会话" icon={<Plus />} onClick={onNewSession} />
            </>
          )}
        </span>
      </div>
    )
  }

  if (variant === "phone-chat") {
    const titleClass = "min-w-0 truncate text-[17px] leading-[22px] font-semibold text-(--cw-text)"
    return (
      <div data-pi-topbar="phone-chat" className={cn(bar, "grid grid-cols-[92px_minmax(0,1fr)_92px] px-1", className)}>
        <span className="flex items-center">
          <BackButton count={backCount} toList onClick={onBack} />
        </span>
        <span className="flex min-w-0 items-center justify-center">
          {interactive && onTitleClick ? (
            // 点标题出会话信息 sheet（design B06）；按钮本身就能被程序聚焦，兜底标记直接挂在它上面。
            // 点击区高 44（design §4.4）：按钮 h-11 竖向居中，字的位置和静态态一样；截断放在里面的 span 上
            <button
              type="button"
              aria-haspopup="dialog"
              data-pi-focus-fallback=""
              onClick={onTitleClick}
              className="inline-flex h-11 min-w-0 items-center text-[17px] leading-[22px] font-semibold text-(--cw-text) outline-none select-none"
            >
              <span className="min-w-0 truncate">{title}</span>
            </button>
          ) : (
            <span className={titleClass} {...fallbackProps(interactive)}>
              {title}
            </span>
          )}
          {platform && <PiPlatformIcon platform={platform} size={15} className="ml-1.5 text-(--cw-pi-text-secondary)" />}
        </span>
        <span className="flex items-center justify-end">{actions ?? <PiIconButton label="会话菜单" icon={<Ellipsis />} />}</span>
      </div>
    )
  }

  return (
    <div data-pi-topbar="phone-page" className={cn(bar, "pr-1 pl-1", className)}>
      <BackButton onClick={onBack} />
      <span className="min-w-0 flex-1 truncate text-[17px] leading-[22px] font-semibold text-(--cw-text)" {...fallbackProps(interactive)}>
        {title}
      </span>
      {actions != null && <span className="ml-auto flex items-center">{actions}</span>}
    </div>
  )
}
