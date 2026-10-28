import type { ComponentPropsWithoutRef, ReactNode } from "react"
import { Collapsible } from "radix-ui"
import { ChevronDown, ICON } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { STREAM_INSET, STREAM_LINE_GAP, STREAM_TEXT } from "./styles"
import { subId } from "./util"

export interface ThinkingBlockProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /**
   * done：思考结束，标题 "Thought" 深 + 时长浅（#8 "Thought for 1s"、#28 "Thought briefly"）；
   * live：思考中，标题 "Thinking" 浅灰 + ∨（#28 展开态）。
   */
  status?: "done" | "live"
  /** done 态标题后半段："for 1s"、"briefly" */
  duration?: ReactNode
  /** 覆盖标题动词（默认 done = "Thought"，live = "Thinking"） */
  label?: ReactNode
  /** 展开态的阶段小标题（600，--cw-thinking-phase）："Implementing timer effect" */
  phase?: ReactNode
  /** 展开态的推理正文（全场最浅的灰，--cw-thinking-body） */
  children?: ReactNode
  /** 受控展开 */
  open?: boolean
  /** 非受控初始展开（帧页面静态复现 #28 展开态用） */
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** done 态有正文、收起时在标题后画 ›（展开时仍是 ∨）；默认 false = 收起不画箭头（现状，#8 #28；kit-requests pi b） */
  collapsedChevron?: boolean
}

/**
 * 思考块（Radix Collapsible）。
 * - 没有 phase / children：只渲染一行收据（#8、#28 的折叠态都没有箭头，也没有可展开正文的证据）。
 * - 有 phase / children：标题行是开关。live 态始终带箭头（展开 ∨；收起转成 ›，推断）；
 *   done 态收起时不画箭头（与帧一致），展开时画 ∨（推断）。
 * 标题按钮的 data-cw-id 自动取根节点 data-cw-id + "-toggle"（例："thinking-live" → "thinking-live-toggle"）。
 */
export function ThinkingBlock({
  status = "done",
  duration,
  label,
  phase,
  children,
  open,
  defaultOpen,
  onOpenChange,
  collapsedChevron = false,
  className,
  ...rest
}: ThinkingBlockProps) {
  const live = status === "live"
  const header = live ? (
    <span className="text-(--cw-text-3)">{label ?? "Thinking"}</span>
  ) : (
    <>
      <span className="text-(--cw-text-2)">{label ?? "Thought"}</span>
      {duration != null && (
        <>
          {" "}
          <span className="text-(--cw-text-3)">{duration}</span>
        </>
      )}
    </>
  )
  const root = cn(STREAM_TEXT, STREAM_INSET, STREAM_LINE_GAP, className)
  const hasBody = phase != null || children != null

  if (!hasBody) {
    return (
      <div data-status={status} className={cn(root, "truncate")} {...rest}>
        {header}
      </div>
    )
  }

  return (
    <Collapsible.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      data-status={status}
      className={root}
      {...rest}
    >
      <Collapsible.Trigger
        data-cw-id={subId(rest, "toggle")}
        className="group inline-flex max-w-full cursor-pointer items-center gap-(--cw-space-1-5) text-left outline-none focus-visible:rounded-(--cw-radius-xs) focus-visible:ring-1 focus-visible:ring-(--cw-border-strong)"
      >
        <span className="truncate">{header}</span>
        <ChevronDown
          aria-hidden
          size={ICON.sizeSm}
          strokeWidth={ICON.stroke}
          className={cn(
            "shrink-0 text-(--cw-text-3) transition-transform",
            live || collapsedChevron ? "group-data-[state=closed]:-rotate-90" : "group-data-[state=closed]:hidden",
          )}
        />
      </Collapsible.Trigger>
      <Collapsible.Content>
        {phase != null && (
          <div className="mt-(--cw-space-1-5) font-(--cw-weight-semibold) text-(--cw-thinking-phase)">{phase}</div>
        )}
        {children != null && <div className="mt-(--cw-space-1-5) text-(--cw-thinking-body)">{children}</div>}
      </Collapsible.Content>
    </Collapsible.Root>
  )
}
