import {
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react"
import { cn } from "@/lib/utils"
import { Button, GhostIconButton, type ButtonProps } from "@/components/kit"
import { Eye, Search, X } from "@/components/kit/icons"
import { usePiStatic } from "@/components/pi/shared/layers"

/**
 * a 区的小件：按钮、输入框、静态截图用的定位钩子。都只用 kit 组件和 --cw-* / --cw-pi-* token。
 */

/**
 * 登录卡的按钮 / 输入框尺寸：md = 32；field = 40（桌面登录卡）；lg = 48（手机登录卡，design §3 login）。
 * 弹窗 / sheet 底部的按钮用 shared PiButton（三区同一套几何）。
 */
export type AButtonScale = "md" | "field" | "lg"

const SCALE: Record<AButtonScale, string> = {
  md: "h-8 rounded-(--cw-radius-input) px-3 text-(length:--cw-text-md)",
  field: "h-10 rounded-(--cw-radius-input) px-4 text-(length:--cw-text-base)",
  lg: "h-12 rounded-[12px] px-4 text-[16px]",
}

export interface APrimaryButtonProps extends Omit<ButtonProps, "size" | "variant"> {
  scale?: AButtonScale
}

/** 黑色主按钮（kit Button solid-black，只放大尺寸）。禁用 = --cw-primary-pending 灰底 */
export function APrimaryButton({ scale = "md", className, ...rest }: APrimaryButtonProps) {
  return <Button variant="solid-black" className={cn(SCALE[scale], "font-medium", className)} {...rest} />
}

export interface ATextButtonProps extends ComponentProps<"button"> {
  /** default = 次级灰；link = 链接蓝；danger = 红（撤销、删除） */
  tone?: "default" | "link" | "danger"
  /** 手机：点击区 44 高 */
  touch?: boolean
}

/** 文字按钮（无底，悬停浅灰底） */
export function ATextButton({ tone = "default", touch = false, className, type = "button", ...rest }: ATextButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1 rounded-(--cw-radius-button) px-1.5 whitespace-nowrap outline-none select-none hover:bg-(--cw-text)/5",
        // P5：禁用（没有管理员令牌时的"重新生成""撤销"等）= 浅灰字、不出悬停底
        "disabled:pointer-events-none disabled:text-(--cw-text-4)",
        touch ? "h-11 px-2" : "h-7",
        tone === "danger" ? "text-(--cw-pi-error)" : tone === "link" ? "text-(--cw-link)" : "text-(--cw-pi-text-secondary)",
        className,
      )}
      {...rest}
    />
  )
}

export interface ATokenInputProps {
  /** 无障碍名称 */
  label: string
  placeholder?: string
  /** 已输入的值（显示成圆点） */
  value?: string
  scale?: AButtonScale
  className?: string
  /** P5（可交互）：输入变化，value 受控。不传 = 静态（defaultValue，画廊截图） */
  onValueChange?: (value: string) => void
  autoFocus?: boolean
  /** 输入框下的说明 / 错误（aria-describedby） */
  describedBy?: string
  invalid?: boolean
  /** 眼睛钮的名字（默认"显示 token"；管理员令牌写"显示令牌"） */
  revealLabel?: string
  autoComplete?: string
  /** P4 契约：静态态（画廊截图）。不传时取 PiStaticContext */
  static?: boolean
}

/** 密码式输入框 + 行尾"显示"眼睛钮（GhostIconButton）。手机字号 16，防止 iOS 聚焦放大 */
export function ATokenInput({
  label,
  placeholder,
  value = "",
  scale = "field",
  className,
  onValueChange,
  autoFocus,
  describedBy,
  invalid,
  revealLabel = "显示 token",
  autoComplete = "current-password",
  static: staticProp,
}: ATokenInputProps) {
  const isStatic = usePiStatic(staticProp)
  const live = !isStatic && onValueChange != null
  // 可交互时眼睛钮切换明文 / 圆点（按下态 = 正在显示）
  const [reveal, setReveal] = useState(false)
  return (
    <div
      className={cn(
        "flex min-w-0 items-center border border-solid border-(--cw-border) bg-(--cw-surface) pr-1 pl-3 focus-within:border-(--cw-pi-field-focus-border)",
        SCALE[scale],
        "px-0 pr-1 pl-3",
        className,
      )}
    >
      <input
        type={live && reveal ? "text" : "password"}
        aria-label={label}
        placeholder={placeholder}
        {...(live
          ? {
              value,
              autoFocus,
              onChange: (event: ChangeEvent<HTMLInputElement>) => onValueChange(event.target.value),
              "aria-describedby": describedBy,
              "aria-invalid": invalid || undefined,
            }
          : { defaultValue: value })}
        autoComplete={autoComplete}
        spellCheck={false}
        className={cn(
          "h-full min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 [font-family:inherit] text-(--cw-text) outline-none placeholder:text-(--cw-text-4)",
          scale === "lg" ? "text-[16px]" : "text-(length:--cw-text-base)",
        )}
      />
      {/* 手机（48 高框）：眼睛钮 44×44（design §4.4；视觉审查第 1 轮 A1，之前 40） */}
      <GhostIconButton
        label={live && reveal ? revealLabel.replace("显示", "隐藏") : revealLabel}
        icon={<Eye />}
        className={scale === "lg" ? "size-11 [&>svg]:size-5" : undefined}
        {...(live ? { onClick: () => setReveal((on) => !on), "aria-pressed": reveal } : {})}
      />
    </div>
  )
}

export interface ASearchFieldProps {
  value: string
  placeholder?: string
  variant: "desktop" | "phone"
  className?: string
  /** P4（可交互）：输入变化，value 受控。不传 = 静态（defaultValue，画廊截图） */
  onValueChange?: (value: string) => void
  /** P4：点 ×（清空搜索，焦点留在输入框） */
  onClear?: () => void
  /** P4：输入框里按 Esc = 退出搜索（design C10）。处理了就 preventDefault，外壳的 Esc 分层不再往下走 */
  onEscape?: () => void
  /** P4：挂上后聚焦输入框（点"搜索"行 / 手机搜索钮进来时） */
  autoFocus?: boolean
  /** P4 契约：静态态（画廊截图）。不传时取 PiStaticContext */
  static?: boolean
}

/** 搜索框（左栏入口行下方 / 手机顶栏）：放大镜 + 输入 + 清空 ×。聚焦态描边加深一档（推断） */
export function ASearchField({
  value,
  placeholder = "搜索会话",
  variant,
  className,
  onValueChange,
  onClear,
  onEscape,
  autoFocus,
  static: staticProp,
}: ASearchFieldProps) {
  const isStatic = usePiStatic(staticProp)
  const live = !isStatic && onValueChange != null
  const inputRef = useRef<HTMLInputElement>(null)
  const phone = variant === "phone"
  return (
    <div
      data-pi-search-field=""
      className={cn(
        "flex min-w-0 items-center gap-2 border border-solid border-(--cw-border-strong) bg-(--cw-surface) focus-within:border-(--cw-pi-field-focus-border)",
        // 手机高 --cw-pi-field-h（44，视觉审查第 1 轮 A3，之前 40）
        phone ? "h-(--cw-pi-field-h) flex-1 rounded-[10px] pr-1 pl-3" : "h-8 rounded-(--cw-radius-input) pr-1 pl-2.5",
        className,
      )}
    >
      <Search aria-hidden size={phone ? 17 : 14} strokeWidth={1.5} className="shrink-0 text-(--cw-text-3)" />
      <input
        ref={inputRef}
        type="search"
        aria-label="搜索会话"
        placeholder={placeholder}
        {...(live
          ? {
              value,
              autoFocus,
              onChange: (event: ChangeEvent<HTMLInputElement>) => onValueChange(event.target.value),
              onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
                // search 输入框的 Esc 默认是清空；这里改成退出搜索（只退出，不往外壳的 Esc 分层走）
                if (event.key !== "Escape" || !onEscape || event.nativeEvent.isComposing) return
                event.preventDefault()
                onEscape()
              },
            }
          : { defaultValue: value })}
        spellCheck={false}
        className={cn(
          "min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 [font-family:inherit] text-(--cw-text) outline-none placeholder:text-(--cw-text-4) [&::-webkit-search-cancel-button]:hidden",
          // 手机：输入区盖住框的上下 1px 描边，点击区 = 框高 44
          phone ? "-my-px h-[calc(100%+2px)] text-[16px]" : "h-full text-(length:--cw-text-md)",
        )}
      />
      {/* 手机：视觉 36 圆不变，点击区 ::after 外扩到 44×44（A3） */}
      <GhostIconButton
        size="sm"
        label="清空搜索"
        icon={<X />}
        onClick={
          live && onClear
            ? () => {
                onClear()
                inputRef.current?.focus()
              }
            : undefined
        }
        className={phone ? "relative size-9 rounded-full after:absolute after:-inset-1 after:content-[''] [&>svg]:size-4" : undefined}
      />
    </div>
  )
}

export interface AAnchoredProps {
  /** 锚点元素（在同一个 PiRoot 里查） */
  selector: string
  /** 由锚点位置算浮层左上角（相对本层，本层铺满父容器） */
  place: (rect: AAnchorRect) => { left: number; top: number }
  children: ReactNode
}

/**
 * 静态截图里的锚定浮层（右键菜单、悬停卡）：铺满父容器、不挡指针，量到锚点后把 children 放到 place() 给的位置。
 * 产品里换成 Radix（MenuSurface kind="context" 等）自己定位。
 */
export function AAnchored({ selector, place, children }: AAnchoredProps) {
  const ref = useRef<HTMLDivElement>(null)
  const rect = useAnchorRect(ref, selector)
  const pos = rect ? place(rect) : null
  return (
    <div ref={ref} data-pi-anchored={selector} className="pointer-events-none absolute inset-0">
      {pos && (
        <div className="pointer-events-auto absolute" style={{ left: pos.left, top: pos.top }}>
          {children}
        </div>
      )}
    </div>
  )
}

/** 分组小标题（菜单 / 弹窗 / sheet 里的分段名） */
export function ASectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-pi-text-secondary)", className)}>{children}</div>
  )
}

export interface AAnchorRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * 静态截图里给浮层定位：量出 PiRoot 里匹配 selector 的元素相对 container 的位置（行高是固定值，不受字体影响）。
 * container 尺寸变化时重量。
 */
export function useAnchorRect(containerRef: RefObject<HTMLElement | null>, selector: string): AAnchorRect | null {
  const [rect, setRect] = useState<AAnchorRect | null>(null)
  useLayoutEffect(() => {
    const box = containerRef.current
    if (!box) return
    const scope: ParentNode = box.closest("[data-pi-root]") ?? document
    const measure = () => {
      const el = scope.querySelector(selector)
      if (!el) return
      const a = el.getBoundingClientRect()
      const b = box.getBoundingClientRect()
      setRect((prev) => {
        const next = { left: a.left - b.left, top: a.top - b.top, width: a.width, height: a.height }
        if (prev && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height) return prev
        return next
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    return () => ro.disconnect()
  }, [containerRef, selector])
  return rect
}
