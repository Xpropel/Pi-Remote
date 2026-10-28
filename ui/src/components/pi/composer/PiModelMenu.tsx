import { useCallback, useId, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type KeyboardEvent, type ReactNode } from "react"
import { MenuItem, MenuItemContent, menuItemClass, MenuLabel, MenuSearch, MenuSeparator, MenuSurface } from "@/components/kit"
import { Check } from "@/components/kit/icons"
import { usePiMenuSurface, usePiStatic } from "@/components/pi/shared/layers"
import { cn } from "@/lib/utils"
import { paletteMatches } from "@/pi/model/composerInput"
import { hiddenUnconfiguredText, modelMenuListOf } from "@/pi/model/models"
import { usePiMenuClose } from "./menuClose"
import type { CModel } from "./types"
import {
  C_SECONDARY,
  C_WARNING,
  rowText,
  SEGMENT_ITEM,
  SEGMENT_ITEM_PHONE,
  SEGMENT_ON,
  SEGMENT_TRACK,
  segmentTrackH,
  type CVariant,
} from "./styles"
import { useListNav } from "./useListNav"

export interface PiThinkingSegmentsProps extends ComponentProps<"div"> {
  variant: CVariant
  /** 档位（get_available_thinking_levels） */
  levels: { value: string; label: string }[]
  value: string
  /** P4：点一档 */
  onValueChange?: (value: string) => void
}

/** 思考级别分段行（E11、G02）：档位来自 get_available_thinking_levels；文字不再用橙色 */
export function PiThinkingSegments({ variant, levels, value, onValueChange, className, ...rest }: PiThinkingSegmentsProps) {
  const phone = variant === "phone"
  return (
    <div role="radiogroup" aria-label="思考级别" className={cn(SEGMENT_TRACK, segmentTrackH(variant), className)} {...rest}>
      {levels.map((l) => (
        <button
          key={l.value}
          type="button"
          role="radio"
          aria-checked={l.value === value}
          className={cn(SEGMENT_ITEM, phone ? SEGMENT_ITEM_PHONE : "text-(length:--cw-text-sm)", l.value === value && SEGMENT_ON)}
          onClick={onValueChange ? () => onValueChange(l.value) : undefined}
        >
          {l.label}
        </button>
      ))}
    </div>
  )
}

export interface PiModelMenuProps extends Omit<ComponentProps<"div">, "children"> {
  variant: CVariant
  models: CModel[]
  /** 思考级别档位与当前值（分段行） */
  thinkingLevels: { value: string; label: string }[]
  thinking: string
  /** 悬停行（桌面：出说明卡；静态态用） */
  hoverKey?: string
  /** 悬停行的说明卡（ch4/ModelExplainerCard）：浮在菜单右侧 8px、垂直居中对齐悬停行（静态态用） */
  explainer?: ReactNode
  /** 作为 sheet 内容（手机）：不画卡、行两行 */
  bare?: boolean
  /* ---------- P4 可交互（静态态不读） ---------- */
  /** true = 静态态；不传时取 PiStaticContext */
  static?: boolean
  /** 选中一个模型（未配置的 provider 不可选）；选中后菜单 / sheet 由宿主关（PiMenuCloseContext） */
  onSelectModel?: (key: string) => void
  /** 点思考级别的一档 */
  onThinkingChange?: (value: string) => void
  /** 桌面：选中行（↑↓ / 指针）的说明卡，浮在菜单右侧，用 aria-describedby 关联到 option；没有返回 null */
  explainerFor?: (key: string) => ReactNode
}

/** 模型行 id（aria-activedescendant 指向它） */
function modelRowId(base: string, key: string): string {
  return `${base}-model-${key.replace(/[^\w-]/g, "_")}`
}

/** 说明卡挂点：在 option 外面（option 的可访问名不带说明卡的文字，P3 交接），位置照旧 = 行右缘 + 菜单内距 4 + 间距 8 */
const EXPLAINER_ANCHOR = "absolute top-1/2 left-[calc(100%+12px)] z-(--cw-pi-z-raised) -translate-y-1/2"
/**
 * 可交互菜单的说明卡（F-R4）：模型列表在内部滚动，卡放在滚动区外、挂在菜单卡上（菜单卡右缘 + 8 = 行右缘 + 菜单内距 4 + 间距 8，同 EXPLAINER_ANCHOR），
 * 竖直方向由 useExplainerTop 对齐选中行的中线；不滚动时和 EXPLAINER_ANCHOR 的位置一样。
 */
const EXPLAINER_FLOAT = "absolute left-[calc(100%+8px)] z-(--cw-pi-z-raised) -translate-y-1/2"
/**
 * 可交互菜单的高度（F-R4）：菜单卡不超过 Radix 给的可用高度（模型选择器上沿到视口上沿，减去碰撞内距），
 * 模型列表最高 360（同斜杠菜单），超出在列表里滚动；搜索框和思考级别留在上面不动。
 */
const MENU_MAX_H = "max-h-(--radix-dropdown-menu-content-available-height)"
const LIST_SCROLL = "relative min-h-0 max-h-[360px] overflow-y-auto overscroll-contain [scrollbar-width:thin]"
/** 「还有 N 个未配置的模型」：和未配置行的灰字同色，不可选（不在 listbox 里） */
const HIDDEN_ROW = "flex min-h-7 items-center px-2 text-(length:--cw-text-sm) text-(--cw-text-4)"

/**
 * 说明卡的 top（相对菜单卡的内边距盒）：选中行的中线，限在列表滚动区的可见范围里（行滚出去时卡停在滚动区上 / 下沿）。
 * 用 getBoundingClientRect 量（菜单开合动画的缩放按 offsetHeight 换回来）；滚动、选中行变化时重算。没有卡时 null。
 */
function useExplainerTop(surfaceRef: { current: HTMLElement | null }, scrollRef: { current: HTMLElement | null }, rowId: string | null) {
  const [top, setTop] = useState<number | null>(null)
  const place = useCallback(() => {
    const surface = surfaceRef.current
    const scroller = scrollRef.current
    const row = rowId ? document.getElementById(rowId)?.parentElement : null
    if (!surface || !scroller || !row) {
      setTop(null)
      return
    }
    const s = surface.getBoundingClientRect()
    const scale = surface.offsetHeight > 0 ? s.height / surface.offsetHeight : 1
    const y = (rect: DOMRect, at: number) => (rect.top + rect.height * at - s.top) / scale - surface.clientTop
    const r = row.getBoundingClientRect()
    const box = scroller.getBoundingClientRect()
    setTop(Math.min(Math.max(y(r, 0.5), y(box, 0)), y(box, 1)))
  }, [surfaceRef, scrollRef, rowId])
  // 每次提交后重量（列表因搜索变了、选中行没变时行的位置也会变）；值不变时 setTop 不触发重渲染
  useLayoutEffect(() => place())
  return { top, place }
}

/**
 * 模型与思考级别菜单（E10 E11 G02）：搜索 → 思考级别分段 → 模型列表（当前 ✓；未配置的 provider 灰字不可选）。
 * 桌面从模型选择器向上弹出，宽 300，悬停行的说明卡（ch4/ModelExplainerCard）由屏幕放在右侧 8px。
 * 手机作为 PiSheet 的内容：模型行两行（名称 + 灰字规格），Gemini 行多一行橙字费用说明（全产品唯一的橙色）。
 * compose from kit: MenuSurface, MenuSearch, MenuLabel, MenuItem, MenuSeparator；参照 ch4/ModelMenu（它写死了 MAX Mode 等 Cursor 项）。
 * 无障碍（§4.7）：模型列表是 listbox，选中行用 aria-activedescendant 标出（aria-selected）、当前模型用 aria-checked；
 * 说明卡在 option 外面，用 aria-describedby 关联。P4 可交互：桌面焦点进搜索框（combobox），↑↓ 移动选中行、Enter 选中；
 * 手机 sheet 里焦点进模型列表本身（data-pi-autofocus），↑↓ / Enter 同样。
 */
export function PiModelMenu({
  variant,
  models,
  thinkingLevels,
  thinking,
  hoverKey,
  explainer,
  bare,
  static: staticProp,
  onSelectModel,
  onThinkingChange,
  explainerFor,
  className,
  ...rest
}: PiModelMenuProps) {
  const isStatic = usePiStatic(staticProp)
  const common = { variant, models, thinkingLevels, thinking, className, div: rest }
  if (variant === "phone" || bare) {
    return <ModelSheetList {...common} interactive={!isStatic} onSelectModel={onSelectModel} onThinkingChange={onThinkingChange} />
  }
  if (isStatic) return <ModelMenuStatic {...common} hoverKey={hoverKey} explainer={explainer} />
  return <ModelMenuInteractive {...common} onSelectModel={onSelectModel} onThinkingChange={onThinkingChange} explainerFor={explainerFor} />
}

interface ModelMenuPartProps {
  variant: CVariant
  models: CModel[]
  thinkingLevels: { value: string; label: string }[]
  thinking: string
  className?: string
  /** 调用方给的其余 div 属性 */
  div: Omit<ComponentProps<"div">, "children">
}

function ModelMenuStatic({ variant, models, thinkingLevels, thinking, hoverKey, explainer, className, div }: ModelMenuPartProps & Pick<PiModelMenuProps, "hoverKey" | "explainer">) {
  // 选中行用 aria-activedescendant 标出：悬停 / ↑↓ 行（没有就是当前模型）
  const base = useId()
  const rowId = (key: string) => modelRowId(base, key)
  const activeKey = hoverKey ?? models.find((m) => m.current)?.key
  const explainerId = `${base}-explainer`
  const { list: shown, hiddenUnconfigured } = modelMenuListOf(models, "", () => true)
  return (
    <MenuSurface
      data-slot="pi-model-menu"
      data-cw-id="pi-model-menu"
      role="group"
      aria-label="模型与思考级别"
      className={cn("w-[300px]", className)}
      {...div}
    >
      <MenuSearch placeholder="搜索模型…" aria-label="搜索模型" />
      {/* 组名、模型说明要读（§4.6，R2-C-m1）：菜单底 --cw-surface 上 secondary 浅 / 深都 ≥ 4.5 */}
      <MenuLabel className={C_SECONDARY}>思考级别</MenuLabel>
      <div className="px-2 pt-0.5 pb-2">
        <PiThinkingSegments variant={variant} levels={thinkingLevels} value={thinking} />
      </div>
      <MenuSeparator />
      <MenuLabel id={rowId("label")} className={C_SECONDARY}>
        模型
      </MenuLabel>
      {/* R2-C-m2：模型列表是 listbox，activedescendant 指向的行 aria-selected=true；当前模型（✓）另用 aria-checked */}
      <div role="listbox" aria-labelledby={rowId("label")} aria-activedescendant={activeKey ? rowId(activeKey) : undefined} tabIndex={-1} className="flex flex-col">
        {shown.map((m) => {
          const card = m.key === hoverKey && explainer != null
          return (
            <div key={m.key} role="none" className="relative flex shrink-0 flex-col">
              <MenuItem
                id={rowId(m.key)}
                role="option"
                aria-selected={m.key === activeKey}
                aria-checked={!!m.current}
                aria-describedby={card ? explainerId : undefined}
                checked={m.current}
                highlighted={m.key === hoverKey}
                weak={m.unconfigured}
                // N3：未配置的 provider 不可选（design §3 model-menu），是真禁用行：aria-disabled（§4.6 豁免禁用文字的 text-4），和手机行一致
                disabled={m.unconfigured}
                detail={m.unconfigured ? undefined : m.spec}
                trailing={m.unconfigured ? <span className="text-(length:--cw-text-xs) text-(--cw-text-4)">未配置</span> : undefined}
                className="min-h-7 [&_[data-slot=menu-item-detail]]:text-(--cw-pi-text-secondary)"
              >
                {m.name}
              </MenuItem>
              {/* 说明卡的包含块是行的外层（relative，和行同一个框）：left = 行右缘 + 菜单内距 4 + 间距 8 */}
              {card && (
                <span id={explainerId} data-slot="pi-model-explainer-anchor" className={cn(EXPLAINER_ANCHOR, "text-left whitespace-nowrap")}>
                  {explainer}
                </span>
              )}
            </div>
          )
        })}
      </div>
      {hiddenUnconfigured > 0 && <div className={HIDDEN_ROW}>{hiddenUnconfiguredText(hiddenUnconfigured)}</div>}
    </MenuSurface>
  )
}

function ModelMenuInteractive({
  variant,
  models,
  thinkingLevels,
  thinking,
  onSelectModel,
  onThinkingChange,
  explainerFor,
  className,
  div,
}: ModelMenuPartProps & Pick<PiModelMenuProps, "onSelectModel" | "onThinkingChange" | "explainerFor">) {
  const surface = usePiMenuSurface()
  const close = usePiMenuClose()
  const base = useId()
  const listId = `${base}-list`
  const labelId = `${base}-label`
  const explainerId = `${base}-explainer`
  const [query, setQuery] = useState("")
  const { list, hiddenUnconfigured } = modelMenuListOf(models, query, (m) => paletteMatches(query, m.name, m.modelId, m.provider))
  const nav = useListNav(
    list.map((m) => !m.unconfigured),
    Math.max(0, list.findIndex((m) => m.current)),
  )
  const active = list[nav.active]
  const searchRef = useRef<HTMLInputElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeCard = active ? (explainerFor?.(active.key) ?? null) : null
  const activeRowId = active ? modelRowId(base, active.key) : null
  // 打开时、键盘 ↑↓ 之后：选中行滚进列表的可见范围（指针移过的行本来就看得见，不滚）
  const reveal = useRef(true)
  useLayoutEffect(() => {
    if (!reveal.current) return
    reveal.current = false
    const scroller = scrollRef.current
    const row = activeRowId ? document.getElementById(activeRowId)?.parentElement : null
    if (!scroller || !row) return
    if (row.offsetTop < scroller.scrollTop) scroller.scrollTop = row.offsetTop
    else if (row.offsetTop + row.offsetHeight > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = row.offsetTop + row.offsetHeight - scroller.clientHeight
  }, [activeRowId])
  const explainer = useExplainerTop(surfaceRef, scrollRef, activeCard != null ? activeRowId : null)
  const select = (m: CModel | undefined) => {
    if (!m || m.unconfigured) return
    onSelectModel?.(m.key)
    close?.()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (nav.onKeyDown(event)) {
      reveal.current = true
      return
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault()
      select(active)
    }
  }
  // 有 MenuSearch 的锚定菜单，打开时焦点进搜索框（design §4.7 焦点表）；Radix 默认会把焦点放在菜单本身
  const focusSearch = (event: Event) => {
    event.preventDefault()
    searchRef.current?.focus({ preventScroll: true })
  }
  return (
    <MenuSurface
      {...surface}
      ref={surfaceRef}
      onOpenAutoFocus={focusSearch}
      data-slot="pi-model-menu"
      data-cw-id="pi-model-menu"
      role="group"
      aria-label="模型与思考级别"
      className={cn("relative w-[300px]", MENU_MAX_H, className)}
      {...div}
    >
      <MenuSearch
        ref={searchRef}
        placeholder="搜索模型…"
        aria-label="搜索模型"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active ? modelRowId(base, active.key) : undefined}
        value={query}
        onValueChange={(v) => {
          setQuery(v)
          nav.setActive(0)
          reveal.current = true
        }}
        onKeyDown={onKeyDown}
      />
      <MenuLabel className={C_SECONDARY}>思考级别</MenuLabel>
      <div className="px-2 pt-0.5 pb-2">
        <PiThinkingSegments variant={variant} levels={thinkingLevels} value={thinking} onValueChange={onThinkingChange} />
      </div>
      <MenuSeparator />
      <MenuLabel id={labelId} className={C_SECONDARY}>
        模型
      </MenuLabel>
      <div ref={scrollRef} data-slot="pi-model-list-scroll" className={LIST_SCROLL} onScroll={explainer.place}>
      <div role="listbox" id={listId} aria-labelledby={labelId} className="flex flex-col">
        {list.length === 0 && <div className={cn("px-2 py-1.5 text-(length:--cw-text-sm)", C_SECONDARY)}>没有匹配的模型</div>}
        {list.map((m, i) => {
          const on = i === nav.active
          const card = on ? activeCard : null
          return (
            <div key={m.key} role="none" className="relative flex shrink-0 flex-col">
              <div
                id={modelRowId(base, m.key)}
                role="option"
                aria-selected={on}
                aria-checked={!!m.current}
                aria-disabled={m.unconfigured || undefined}
                aria-describedby={card != null ? explainerId : undefined}
                data-highlighted={on ? "" : undefined}
                className={cn(
                  menuItemClass({ kind: "dropdown", weak: m.unconfigured, dim: false, forcedOn: on, twoLine: false }),
                  "min-h-7 [&_[data-slot=menu-item-detail]]:text-(--cw-pi-text-secondary)",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onPointerMove={() => {
                  if (!on) nav.setActive(i)
                }}
                onClick={() => select(m)}
              >
                <MenuItemContent
                  label={m.name}
                  detail={m.unconfigured ? undefined : m.spec}
                  trailing={m.unconfigured ? <span className="text-(length:--cw-text-xs) text-(--cw-text-4)">未配置</span> : undefined}
                  checked={m.current}
                  weak={m.unconfigured}
                  dim={false}
                  forcedOn={on}
                />
              </div>
            </div>
          )
        })}
      </div>
      {hiddenUnconfigured > 0 && <div className={HIDDEN_ROW}>{hiddenUnconfiguredText(hiddenUnconfigured)}</div>}
      </div>
      {activeCard != null && (
        <span
          id={explainerId}
          data-slot="pi-model-explainer-anchor"
          className={cn(EXPLAINER_FLOAT, "text-left whitespace-nowrap")}
          style={explainer.top == null ? HIDDEN_STYLE : { top: explainer.top }}
        >
          {activeCard}
        </span>
      )}
    </MenuSurface>
  )
}

const HIDDEN_STYLE: CSSProperties = { visibility: "hidden" }

/** 手机 sheet 里的模型菜单（两种态共用排版；可交互时列表可聚焦、↑↓ / Enter，点行选中） */
function ModelSheetList({
  variant,
  models,
  thinkingLevels,
  thinking,
  onSelectModel,
  onThinkingChange,
  className,
  div,
  interactive,
}: ModelMenuPartProps & Pick<PiModelMenuProps, "onSelectModel" | "onThinkingChange"> & { interactive: boolean }) {
  const t = rowText(variant)
  const close = usePiMenuClose()
  const base = useId()
  const rowId = (key: string) => modelRowId(base, key)
  // 未配置的超过 5 个折成一行（F-R4，同桌面；sheet 没有搜索框，未配置的本来也不能选）
  const { list, hiddenUnconfigured } = modelMenuListOf(models, "", () => true)
  const current = Math.max(0, list.findIndex((m) => m.current))
  const nav = useListNav(
    list.map((m) => !m.unconfigured),
    current,
  )
  // 静态态：activedescendant = 当前模型；可交互：↑↓ 选中的行
  const activeKey = interactive ? list[nav.active]?.key : list.find((m) => m.current)?.key
  const activeId = activeKey ? rowId(activeKey) : undefined
  const select = (m: CModel | undefined) => {
    if (!interactive || !m || m.unconfigured) return
    onSelectModel?.(m.key)
    close?.()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (nav.onKeyDown(event, true)) return
    if ((event.key === "Enter" || event.key === " ") && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      select(list[nav.active])
    }
  }
  return (
    <div data-slot="pi-model-menu" data-cw-id="pi-model-menu" role="group" aria-label="模型与思考" className={cn("flex flex-col", className)} {...div}>
      <div className={cn("px-1 pb-2", t.sub, C_SECONDARY)}>思考级别</div>
      <PiThinkingSegments
        variant={variant}
        levels={thinkingLevels}
        value={thinking}
        onValueChange={interactive ? onThinkingChange : undefined}
        className="mx-0.5"
      />
      <div id={rowId("label")} className={cn("mt-4 px-1 pb-1", t.sub, C_SECONDARY)}>
        模型
      </div>
      {/* R2-C-m2：模型列表是 listbox，activedescendant 指向的行 aria-selected=true（读屏报「已选中」）；当前模型另用 aria-checked */}
      <div
        role="listbox"
        aria-labelledby={rowId("label")}
        aria-activedescendant={activeId}
        tabIndex={interactive ? 0 : -1}
        // 可交互：sheet 打开时焦点进模型列表本身（piInitialFocusOf 认 data-pi-autofocus），↑↓ 立刻能用
        data-pi-autofocus={interactive ? "" : undefined}
        onKeyDown={interactive ? onKeyDown : undefined}
        className="flex flex-col"
      >
        {list.map((m) => (
          <div
            key={m.key}
            id={rowId(m.key)}
            role="option"
            aria-selected={m.key === activeKey}
            aria-checked={!!m.current}
            aria-disabled={m.unconfigured || undefined}
            className={cn(
              "flex min-h-[52px] items-center gap-3 border-b border-solid border-(--cw-divider-soft) px-1 py-2 last:border-b-0",
              interactive && m.key === activeKey && "bg-(--cw-row-hover)",
            )}
            onClick={interactive ? () => select(m) : undefined}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn(t.main, m.unconfigured ? "text-(--cw-text-4)" : "text-(--cw-text)")}>{m.name}</span>
              <span className={cn(t.sub, m.unconfigured ? "text-(--cw-text-4)" : C_SECONDARY)}>{m.unconfigured ? "未配置" : m.spec}</span>
              {m.costNote && <span className={cn(t.sub, C_WARNING)}>{m.costNote}</span>}
            </span>
            {/* 选中只靠素勾（与桌面菜单一致，ch4 run-on-menu #17） */}
            {m.current && <Check aria-hidden strokeWidth={1.75} className="size-5 shrink-0 text-(--cw-icon-fg)" />}
          </div>
        ))}
      </div>
      {hiddenUnconfigured > 0 && <div className={cn("flex min-h-[52px] items-center px-1", t.sub, "text-(--cw-text-4)")}>{hiddenUnconfiguredText(hiddenUnconfigured)}</div>}
    </div>
  )
}
