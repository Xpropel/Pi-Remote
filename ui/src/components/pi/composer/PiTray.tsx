import type { ComponentProps } from "react"
import { DiffStat, Pill, RoundIconButton } from "@/components/kit"
import { PiSpinner } from "@/components/pi/shared/PiSpinner"
import { usePiStatic } from "@/components/pi/shared/layers"
import { cn } from "@/lib/utils"
import type { CVariant } from "./styles"

/** 功能 tray 的一颗 pill（design §6.4 PiTrayItem，跨区契约：只许加可选字段） */
export interface PiTrayItem {
  kind: "tasks" | "queue" | "terminal" | "changes"
  /** pill 文字："任务 2/4"、"排队 2"、"排队 1 · 等重连"、"终端 1"、"改动" */
  label: string
  /** 行首半圆 spinner（终端运行中） */
  running?: boolean
  /** 改动 pill 的 +N / −M（Review +54 −5 的版式，full-window-idle-cloud#7） */
  added?: number
  removed?: number
  /** 对应面板打开：选中态（浅灰底 + 深字，推断） */
  active?: boolean
}

export interface PiTrayProps extends Omit<ComponentProps<"div">, "children"> {
  variant: CVariant
  items: PiTrayItem[]
  /** 最右的圆形描边"回到底部"钮（只在用户上滑后出现，hunt-og-render#8） */
  scrollDown?: boolean
  /** 回到底部钮旁的新消息计数（"3 条新消息"，推断） */
  newCount?: number
  /** P4：true = 静态态；不传时取 PiStaticContext */
  static?: boolean
  /** P4：点 pill（任务 / 排队开关 tray 上方的面板，终端 / 改动开右 pane） */
  onItemClick?: (kind: PiTrayItem["kind"]) => void
  /** P4：点"回到底部" */
  onScrollDown?: () => void
}

/** 点开的是 tray 上方的面板（任务、排队）：pill 是展开钮（aria-expanded）；终端、改动开的是 pane（aria-pressed） */
const PANEL_KINDS: ReadonlySet<PiTrayItem["kind"]> = new Set(["tasks", "queue"])

/**
 * 功能 tray（design §1.7，规则 5）：一排 pill，点开才出面板；pill 只在有内容时出现。
 * 桌面行高 36、pill 30；手机行高 44、pill 32（上下外扩成 44 点击区），横排可左右滑。
 * compose from kit: ActionPillRow 的排法（这里自己排，因为回到底部钮要推到最右）、Pill、Spinner、DiffStat、RoundIconButton(scroll-down)。
 */
export function PiTray({ variant, items, scrollDown, newCount, static: staticProp, onItemClick, onScrollDown, className, ...rest }: PiTrayProps) {
  const isStatic = usePiStatic(staticProp)
  const phone = variant === "phone"
  if (items.length === 0 && !scrollDown) return null
  return (
    <div
      data-slot="pi-tray"
      className={cn("flex min-w-0 items-center gap-2", phone ? "h-11" : "h-9", className)}
      {...rest}
    >
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2",
          // 滚动容器撑满 tray 的 44 高（self-stretch）：overflow-x-auto 也会裁 y，容器只有 32 高时 pill 上下外扩的点击区被裁掉
          phone && "-mx-4 self-stretch overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        {items.map((item) => (
          <Pill
            key={item.kind}
            variant="outline"
            data-cw-id={`pi-tray-${item.kind}`}
            data-active={item.active ? "" : undefined}
            aria-pressed={isStatic || !PANEL_KINDS.has(item.kind) ? item.active : undefined}
            aria-expanded={!isStatic && PANEL_KINDS.has(item.kind) ? !!item.active : undefined}
            onClick={isStatic ? undefined : () => onItemClick?.(item.kind)}
            icon={item.running ? <PiSpinner size={phone ? 14 : 12} arc={0.5} tone="muted" label="运行中" /> : undefined}
            className={cn(
              "shrink-0",
              // 点击区 44：absolute 的 ::after 以内边距盒为准，pill 有 1px 描边，所以上下外扩 7（= 6 + 描边 1）
              phone ? "relative h-8 px-3.5 text-[14px] after:absolute after:inset-x-0 after:-inset-y-[7px] after:content-['']" : "h-[30px]",
              item.active && "border-(--cw-border-strong) bg-(--cw-row-selected) text-(--cw-text)",
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              {item.label}
              {(item.added != null || item.removed != null) && (
                <DiffStat added={item.added} removed={item.removed} minusSign="−" />
              )}
            </span>
          </Pill>
        ))}
      </div>
      {scrollDown && (
        <span className="ml-auto inline-flex shrink-0 items-center gap-2">
          {newCount ? (
            <span className="text-(length:--cw-text-sm) text-[color:var(--cw-pi-text-secondary,var(--cw-text-3))]">
              {newCount} 条新消息
            </span>
          ) : null}
          <RoundIconButton
            variant="scroll-down"
            aria-label="回到底部"
            data-cw-id="pi-tray-scroll-down"
            size={phone ? 36 : "md"}
            onClick={isStatic ? undefined : onScrollDown}
          />
        </span>
      )}
    </div>
  )
}
