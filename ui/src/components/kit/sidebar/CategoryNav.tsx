// CategoryNav（实施计划 D5、P2.2 / P3.1）：取自 replica 的 ch5/marketplace.tsx 的 MarketplaceNav，只改名（MarketplaceNav → CategoryNav，Group / Props 同）。
// P3.1（kit-requests pi c4）：颜色直接读 kit token（标题 --cw-text-3、项 --cw-text-2、悬停 / 选中 --cw-text、分隔 --cw-divider），
// 不再有 ch5 章节的 mp-nav 变量和 category-nav.css。
import { useState, type ComponentProps, type ReactNode } from "react"
import { cn } from "@/lib/utils"


export interface CategoryNavGroup {
  items: { id: string; label: string }[]
}

export interface CategoryNavProps extends Omit<ComponentProps<"nav">, "onSelect" | "title"> {
  title?: ReactNode
  /** 小标题的额外 class（默认字色 --cw-text-3；Pi 设置页要读的标题可以换成 secondary，P3） */
  titleClassName?: string
  groups: CategoryNavGroup[]
  /** 行距（CSS px），默认 27.6（#29 28.2 源 px） */
  rowHeight?: number
  /** 受控点选项；null = 无（#29 帧态：所有项同色） */
  selectedId?: string | null
  /** 非受控初始点选项，默认 null（帧态） */
  defaultSelectedId?: string | null
  onSelect?: (id: string) => void
}

/**
 * 中列纯文字分类导航：小标题 "Marketplace" → 来源 → 分隔线 → 分类 → 分隔线 → Documentation。
 * 无图标、无描边；帧态无选中项（#29 所有项同色）。hover 与点选后文字变深（点选另加 500 字重，二者均推断）；
 * 点击回调 onSelect（屏幕把卡片流滚到对应组，推断）。项的 data-cw-id = 根 id + "-" + 项 id。
 */
export function CategoryNav({
  title = "Marketplace",
  titleClassName,
  groups,
  rowHeight = 27.6,
  selectedId,
  defaultSelectedId = null,
  onSelect,
  className,
  ...rest
}: CategoryNavProps) {
  const [inner, setInner] = useState<string | null>(defaultSelectedId)
  const current = selectedId !== undefined ? selectedId : inner
  const rootId = (rest as Record<string, unknown>)["data-cw-id"] as string | undefined
  return (
    <nav data-slot="marketplace-nav" className={cn("flex w-[181px] flex-col", className)} {...rest}>
      <div className={cn("flex h-[24px] items-center pl-[2px] text-[13px] leading-none text-(--cw-text-3)", titleClassName)}>{title}</div>
      {groups.map((g, gi) => (
        <div key={gi} className={cn("flex flex-col", gi === 0 ? "mt-[25px]" : "")}>
          {gi > 0 && <div aria-hidden className="my-[7.6px] h-px bg-(--cw-divider)" />}
          {g.items.map((it) => {
            const on = it.id === current
            return (
              <button
                key={it.id}
                type="button"
                data-cw-id={rootId ? `${rootId}-${it.id}` : undefined}
                data-selected={on ? "" : undefined}
                aria-current={on ? "true" : undefined}
                onClick={() => {
                  if (selectedId === undefined) setInner(it.id)
                  onSelect?.(it.id)
                }}
                className="flex items-center pl-[2px] text-left text-[13px] leading-none whitespace-nowrap text-(--cw-text-2) outline-none hover:text-(--cw-text) focus-visible:text-(--cw-text) data-[selected]:font-medium data-[selected]:text-(--cw-text)"
                style={{ height: rowHeight }}
              >
                {it.label}
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
