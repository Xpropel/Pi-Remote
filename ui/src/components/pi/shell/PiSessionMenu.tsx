import { useId, type KeyboardEvent, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { MenuItem, MenuLabel, MenuSeparator, MenuSurface } from "@/components/kit"
import {
  Copy,
  CopyPlus,
  Download,
  ExternalLink,
  Folder,
  FoldVertical,
  GitFork,
  ListTree,
  MessageSquare,
  Pencil,
  Play,
  Trash,
} from "@/components/kit/icons"
import { piShortId, usePiMenuSurface, usePiStatic, type PiOverlayControl } from "@/components/pi/shared"

export interface PiSessionMenuSession {
  title: string
  messageCount: number
  /** pi 会话文件里的 UUID（"复制会话 ID"） */
  sessionId: string
  /** false = 未载入的会话（只有本机记录）：首项"启用会话"，分叉写"分叉会话（未载入）…" */
  openable: boolean
  /** 当前会话（不可删，"删除…"禁用并写原因） */
  current?: boolean
  /** pi 正忙：会话操作禁用（灰字，悬停写原因） */
  busy?: boolean
}

/** 菜单项（onSelect 收到的值；也写在行的 data-pi-menu-item 上）。copy-cwd 只在顶栏 …（B04）的菜单里有 */
export type PiSessionMenuAction = "open" | "rename" | "fork" | "clone" | "export" | "tab" | "tree" | "compact" | "copy-cwd" | "copy-id" | "delete"

/** P5：一项的可用性（pi/model/sessionMenu.ts 的 PiSessionMenuItemState） */
export type PiSessionMenuItemState = { disabled: boolean; reason?: string }

/**
 * P4 契约（R2/p4-lanes.md §1）：这是菜单**内容**。桌面放进 PiMenu（行尾 … = dropdown、右键行 = context），
 * MenuSurface 展开 usePiMenuSurface() 就成了 Radix Content；手机放进 PiSheet，surface 是 static，可交互时行能用键盘操作。
 * 只收 PiOverlayControl 的 `static`（开合由外面的 PiMenu / PiSheet 管）。
 */
export interface PiSessionMenuProps extends Pick<PiOverlayControl, "static"> {
  variant: "desktop" | "phone"
  session: PiSessionMenuSession
  /** 删除武装（第一次点过）："再点一次删除" */
  deleteArmed?: boolean
  /** 帧态：高亮某一项（菜单项 key） */
  highlighted?: string
  /** P4：选中一项（点击 / Enter；禁用项不触发）。放在 PiMenu 里时选中后菜单自己关 */
  onSelect?: (action: PiSessionMenuAction) => void
  /**
   * P5：逐项的可用性与原因（容器用 sessionMenuOf 算，照旧界面 chat/sessionMenu.tsx 的规则）。给了就按它禁用，禁用原因经
   * aria-describedby 给读屏（Radix 的禁用项不收指针事件，悬停 tooltip 出不来）；不给 = 画廊口径（忙时 / 当前会话，见下）
   */
  state?: Partial<Record<PiSessionMenuAction, PiSessionMenuItemState>>
  /** P5（顶栏 …，B04）：多一项"复制工作目录" */
  copyCwd?: boolean
  className?: string
}

interface Item {
  key: PiSessionMenuAction
  icon: ReactNode
  label: string
  trailing?: ReactNode
  danger?: boolean
  disabled?: boolean
  /** P5：禁用原因（读屏经 aria-describedby 读到） */
  reason?: string
  desktopOnly?: boolean
}

const ENABLED_ITEM = '[role="menuitem"]:not([aria-disabled="true"])'

/**
 * sheet 里（surface 是 static）可交互时的键盘（design §4.7：sheet 的焦点进第一个可用项）：↑↓ / Home / End 在可用项之间移焦点（到头绕回），
 * Enter / 空格 = 点这一项。Radix 菜单（PiMenu 里）自己处理这些键，不走这里。
 */
function onSheetMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(ENABLED_ITEM))
  const at = items.indexOf(event.target as HTMLElement)
  if (at < 0) return
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault()
    items[at].click()
    return
  }
  const next =
    event.key === "ArrowDown" ? (at + 1) % items.length : event.key === "ArrowUp" ? (at - 1 + items.length) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1
  if (next < 0) return
  event.preventDefault()
  items[next].focus()
}

/**
 * 会话菜单（design C12 / B04 / J07；compose from kit: MenuSurface、MenuLabel、MenuItem、MenuSeparator；参照 kit RowContextMenu）。
 * 桌面 = 右键菜单 / 行尾 … 的下拉（宽 240）；手机 = PiSheet 里的同一组项（行 48，不含"在新标签页打开"）。
 * 静态态（画廊截图）是 static 模式，位置由屏幕给。可交互（P4.1）：放在 PiMenu 里时 MenuSurface 就是 Radix ContextMenu / DropdownMenu
 * 的 Content（焦点进菜单、↑↓、Enter 选中、Esc / 点外面关闭、焦点回触发元素）；在手机 sheet 里时首个可用项可 Tab 到，↑↓ / Enter / 空格可用。
 */
export function PiSessionMenu({ variant, session, deleteArmed = false, highlighted, onSelect, state, copyCwd = false, static: staticProp, className }: PiSessionMenuProps) {
  const isStatic = usePiStatic(staticProp)
  const context = usePiMenuSurface()
  const reasonBase = useId()
  // 静态态一律 static（不看外面有没有 PiMenu）；可交互时在 PiMenu 里 = Radix Content，其余（手机 sheet）仍是 static，加上键盘
  const surface = isStatic ? undefined : context
  const keyboard = !isStatic && context.kind === "static"
  const phone = variant === "phone"
  const ops = session.busy ? "pi 正忙，等这一轮结束" : undefined
  const groups: Item[][] = [
    [
      session.openable
        ? { key: "open", icon: <MessageSquare />, label: "打开会话" }
        : { key: "open", icon: <Play />, label: "启用会话" },
      { key: "rename", icon: <Pencil />, label: "重命名…", disabled: !!ops },
      { key: "fork", icon: <GitFork />, label: session.openable ? "从消息分叉…" : "分叉会话（未载入）…", disabled: !!ops },
      { key: "clone", icon: <CopyPlus />, label: "克隆当前分支…", disabled: !!ops },
      { key: "export", icon: <Download />, label: "导出会话…" },
      { key: "tab", icon: <ExternalLink />, label: "在新标签页打开", desktopOnly: true },
    ],
    [
      { key: "tree", icon: <ListTree />, label: "会话树…" },
      { key: "compact", icon: <FoldVertical />, label: "压缩上下文…", disabled: !!ops },
    ],
    [
      ...(copyCwd ? [{ key: "copy-cwd" as const, icon: <Folder />, label: "复制工作目录" }] : []),
      {
        key: "copy-id",
        icon: <Copy />,
        label: "复制会话 ID",
        // 行尾会话 id 也是要读的字（复制前核对用）：--cw-text-3 在菜单底 #FDFDFD 上只有 3.78 → secondary（P3 #3 R2-A-m2）
        trailing: <span className="font-mono text-(length:--cw-text-xs) text-(--cw-pi-text-secondary)">{piShortId(session.sessionId)}</span>,
      },
      {
        key: "delete",
        icon: <Trash />,
        label: deleteArmed ? "再点一次删除" : "删除…",
        danger: true,
        disabled: session.current,
      },
    ],
  ]
  // P5：容器给了逐项的可用性就按它（画廊口径的忙时 / 当前会话规则让位）；禁用原因记下来给读屏
  const shown = groups.map((g) =>
    g
      .filter((item) => !(phone && item.desktopOnly))
      .map((item) => {
        const s = state?.[item.key]
        return s ? { ...item, disabled: s.disabled, reason: s.disabled ? s.reason : undefined } : item
      }),
  )
  const reasonId = (key: PiSessionMenuAction) => `${reasonBase}-${key}`
  const reasons = shown.flat().filter((item): item is Item & { reason: string } => !!item.disabled && !!item.reason)
  // sheet 里键盘可达：第一个可用项进 Tab 顺序（其余 tabIndex -1，↑↓ 移过去）
  const firstEnabled = keyboard ? shown.flat().find((item) => !item.disabled)?.key : undefined
  return (
    <MenuSurface
      {...surface}
      data-pi-session-menu=""
      aria-label={`${session.title} 的会话菜单`}
      // Radix DropdownMenu 默认用触发钮（"会话菜单"）给菜单命名，aria-labelledby 会盖过上面这个更具体的名字
      {...(surface && surface.kind !== "static" ? { "aria-labelledby": undefined } : {})}
      onKeyDown={keyboard ? onSheetMenuKeyDown : undefined}
      className={cn(phone ? "w-full bg-transparent p-0 shadow-none" : "w-60", className)}
    >
      {!phone && (
        // 头部副行要读（R2-A-m2）：标题与条数用 --cw-pi-text-secondary；「复制会话 ID」行尾的 id 同样用 secondary（P3）
        <MenuLabel className="min-w-0 gap-1 text-(--cw-pi-text-secondary)">
          <span className="min-w-0 truncate">{session.title}</span>
          {/* 清单里没有条数（0，§1.9）就不写 */}
          {session.messageCount > 0 && <span className="shrink-0">· {session.messageCount} 条</span>}
        </MenuLabel>
      )}
      {shown.map((group, gi) => (
        <div key={gi} className="contents">
          {gi > 0 && <MenuSeparator />}
          {group.map((item) => (
            <MenuItem
              key={item.key}
              data-pi-menu-item={item.key}
              icon={item.icon}
              trailing={item.trailing}
              disabled={item.disabled}
              highlighted={highlighted === item.key}
              {...(item.key === firstEnabled ? { tabIndex: 0 } : {})}
              {...(item.reason ? { "aria-describedby": reasonId(item.key) } : {})}
              onSelect={onSelect && (() => onSelect(item.key))}
              className={cn(
                phone && "[&_[data-slot=menu-item-icon]>svg]:size-5",
                item.danger && !item.disabled && "text-(--cw-pi-error) [&_[data-slot=menu-item-icon]]:text-(--cw-pi-error)",
              )}
            >
              {item.label}
            </MenuItem>
          ))}
        </div>
      ))}
      {/*
        禁用原因只给 aria-describedby：放在 hidden 容器里（被 aria-describedby 直接引用的隐藏节点照样参与描述计算），
        不放进菜单项里（免得混进项的名字），也不在菜单里多出一段游离文字
      */}
      {reasons.length > 0 && (
        <div hidden data-pi-menu-reasons="">
          {reasons.map((item) => (
            <span key={item.key} id={reasonId(item.key)}>
              {item.reason}
            </span>
          ))}
        </div>
      )}
    </MenuSurface>
  )
}
