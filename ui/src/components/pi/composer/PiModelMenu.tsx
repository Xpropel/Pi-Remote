import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import {
  MENU_DIVIDER_BG,
  MENU_DIVIDER_BORDER,
  MENU_ROW_HL,
  MENU_ROW_HL_HOVER,
  MenuItem,
  MenuItemContent,
  menuItemClass,
  MenuLabel,
  MenuSearch,
  MenuSeparator,
  MenuSurface,
  menuShadowClass,
  menuSurfaceClass,
} from "@/components/kit"
import { ModelExplainerCard } from "@/components/kit/menu/ModelExplainerCard"
import { Switch } from "@/components/kit/controls/Switch"
import { Check, ChevronLeft } from "@/components/kit/icons"
import { usePiMenuSurface, usePiStatic } from "@/components/pi/shared/layers"
import { PiSpinner } from "@/components/pi/shared/PiSpinner"
import { cn } from "@/lib/utils"
import { paletteMatches } from "@/pi/model/composerInput"
import { explainerSideOf, type ExplainerSide } from "./explainerPlacement"
import { modelAutoOn } from "./modelAuto"
import { contextWindowLabel, modelExplainerOf, modelFactsLineOf, modelMenuEntriesOf, modelThinkingOptionsOf, type PiModelMenuEntry, type PiModelRow } from "@/pi/model/models"
import { usePiMenuClose } from "./menuClose"
import { PiSheetSearch } from "./PiSheetSearch"
import type { CModel } from "./types"
import {
  C_ERROR,
  C_EXPLAINER_ORANGE,
  C_SECONDARY,
  C_WARNING,
  rowText,
  SEGMENT_ITEM,
  SEGMENT_ITEM_PHONE,
  SEGMENT_ON,
  SEGMENT_TRACK,
  segmentTrackH,
  TOUCH_44,
  TOUCH_44_BOX,
  type CVariant,
} from "./styles"
import { useListNav } from "./useListNav"

/**
 * A menu row as the menu sees it: CModel plus the per-model fields the bridge
 * may carry (models.ts). The bridge work that attaches thinkingLevels and the
 * default model is parallel to this change; every read below tolerates their
 * absence (redesign section 2.3 fallback).
 */
export type PiModelMenuRow = CModel & { provider: string; name: string; contextWindow?: number; thinkingLevels?: string[]; reasoning?: boolean; supportsImage?: boolean }

/** Device default model identity for the Auto row (redesign section 2.5) */
export interface PiModelDefault {
  provider: string
  modelId: string
  name?: string
}

export interface PiThinkingSegmentsProps extends ComponentProps<"div"> {
  variant: CVariant
  /** Levels (get_available_thinking_levels) */
  levels: { value: string; label: string }[]
  value: string
  /** P4: pick one level */
  onValueChange?: (value: string) => void
}

/** Thinking level segment row (E11, G02): levels from get_available_thinking_levels; text no longer orange */
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
  /** Thinking levels and current value (segment row) */
  thinkingLevels: { value: string; label: string }[]
  thinking: string
  /** Hovered row (desktop: shows the explainer card; static states use it) */
  hoverKey?: string
  /** Explainer card of the hovered row (ch4/ModelExplainerCard): floats to the right of the menu, vertically centered on the hovered row (static states use it) */
  explainer?: ReactNode
  /** As sheet content (phone): no card, two-line rows */
  bare?: boolean
  /* ---------- P4 interactive (static states do not read these) ---------- */
  /** true = static state; when omitted, read PiStaticContext */
  static?: boolean
  /** Pick a model (an unconfigured provider is not selectable); the host closes the menu / sheet after picking (PiMenuCloseContext) */
  onSelectModel?: (key: string) => void
  /** Pick one thinking level */
  onThinkingChange?: (value: string) => void
  /** Desktop: explainer card of the picked row, floating to the right of the menu, linked to the option with aria-describedby; null means no card from the host (the menu falls back to its own facts card) */
  explainerFor?: (key: string) => ReactNode
  /** Device default model (redesign section 2.5): present = render the Auto row; absent = hide it, never guess a default */
  defaultModel?: PiModelDefault | null
  /** Controlled Auto state; uncontrolled when omitted (seeded from whether the current model is the default) */
  auto?: boolean
  onAutoChange?: (next: boolean) => void
  /** Empty-state action: jump to the settings page model section (redesign section 7) */
  onConfigureModels?: () => void
  /**
   * 模型列表还在读 / 读失败（菜单每次打开都重新问设备）：列表空着时显示读取行，不冒充「还没有配置任何模型」。
   * 不传 = 已就绪
   */
  listPhase?: "loading" | "error"
  /** listPhase = error 时的原因 */
  listError?: string
  /** listPhase = error 时的"重试" */
  onRetry?: () => void
}

/** Model row id (aria-activedescendant points at it) */
function modelRowId(base: string, key: string): string {
  return `${base}-model-${key.replace(/[^\w-]/g, "_")}`
}

/**
 * Explainer anchor: outside the option (the option's accessible name does not carry the card's text, P3 handover), positioned as before = row right edge + menu padding 4 + gap 8.
 * Side classes: the float opens on the right by default and flips to the left when the viewport
 * leaves no room on the right (useExplainerSide / explainerPlacement.ts).
 */
const EXPLAINER_ANCHOR = "absolute top-1/2 z-(--cw-pi-z-raised) -translate-y-1/2"
const EXPLAINER_ANCHOR_RIGHT = "left-[calc(100%+12px)]"
const EXPLAINER_ANCHOR_LEFT = "right-[calc(100%+12px)]"
/**
 * Interactive menu explainer (F-R4): the model list scrolls inside, so the card sits outside the scroll
 * area, anchored on the menu card (menu right edge + 8 = row right edge + menu padding 4 + gap 8, same as
 * EXPLAINER_ANCHOR); vertically, useExplainerTop aligns it with the anchored row's center line.
 * The parameter panel uses the same slot and anchor. The side (right / flipped left) comes from
 * useExplainerSide, so the card and the panel always share one placement computation.
 */
const EXPLAINER_FLOAT = "absolute z-(--cw-pi-z-raised) -translate-y-1/2"
const EXPLAINER_FLOAT_RIGHT = "left-[calc(100%+8px)]"
const EXPLAINER_FLOAT_LEFT = "right-[calc(100%+8px)]"
/** Gap between the menu card's edge and the side float (both menu states) */
const EXPLAINER_GAP = 8
/**
 * Interactive menu height (F-R4): the menu card stays within the height Radix allows
 * (from the model picker up to the viewport top, minus collision padding); the model
 * list scrolls at most 360 (same as the slash menu); the search box and the Auto row stay pinned above it.
 */
const MENU_MAX_H = "max-h-(--radix-dropdown-menu-content-available-height)"
const LIST_SCROLL = "relative min-h-0 max-h-[360px] overflow-y-auto overscroll-contain [scrollbar-width:thin]"
/** Fixed tail column of a model row (redesign section 3): holds either the current-row check or the Edit affordance */
const TAIL = "flex w-9 shrink-0 items-center justify-end"
/** 参数面板的单选行：和菜单行同高、同圆角、同一种悬停底 */
const PARAM_ROW = cn(
  "flex min-h-7 w-full items-center rounded-[var(--cw-menu-item-radius,6px)] px-2 text-left text-(length:--cw-text-md) text-(--cw-text)",
  MENU_ROW_HL_HOVER,
)
/** 手机参数页的单选行（44 高、行间细线，和模型列表同一种分隔线） */
const SHEET_OPTION_ROW = cn("flex min-h-[44px] items-center gap-3 border-b border-solid px-1 py-2 text-left last:border-b-0", MENU_DIVIDER_BORDER)

/**
 * The card's top (relative to the menu card's padding box): the anchored row's center line,
 * clamped to the visible range of the list scroll area (when the row scrolls out, the card stops
 * at the scroll area's top / bottom edge). Measured with getBoundingClientRect (the open/close
 * animation scale is divided back out via offsetHeight); recomputed on scroll and on anchored-row
 * changes. Null when there is no card.
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
  // Re-measure after every commit (the list changes with the search query, so a row's
  // position moves even when the anchored row does not); an unchanged value does not re-render
  useLayoutEffect(() => place())
  return { top, place }
}

/**
 * Which side of the menu card the side float (explainer card / parameter panel) opens on:
 * the right while the viewport leaves room for the 248-wide float past the menu's right
 * edge, the left otherwise (the shared formula lives in explainerPlacement.ts). Measured
 * from the menu card's rect after every commit, like useExplainerTop; an unchanged side
 * does not re-render.
 */
function useExplainerSide(surfaceRef: { current: HTMLElement | null }, gap: number): ExplainerSide {
  const [side, setSide] = useState<ExplainerSide>("right")
  useLayoutEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const next = explainerSideOf(surface.getBoundingClientRect().right, window.innerWidth, gap)
    setSide((prev) => (prev === next ? prev : next))
  })
  return side
}

/** Whether an entry is the session's current model (any of its variants is current) */
function entryCurrent(entry: PiModelMenuEntry<PiModelMenuRow>): boolean {
  return entry.representative.current === true || entry.variants.some((row) => row.current === true)
}

/** Whether an entry can show Edit (redesign section 2.3): context variants, or a model that can think */
function entryEditable(entry: PiModelMenuEntry<PiModelMenuRow>, currentSegments: { value: string; label: string }[]): boolean {
  if (entry.hasContextVariants) return true
  const row = entry.representative
  if (row.reasoning === false) return false
  if ((row.thinkingLevels?.length ?? 0) > 0) return true
  return entryCurrent(entry) && currentSegments.length > 0
}

type ThinkingSection = { kind: "options"; options: { value: string; label: string }[] } | { kind: "unknown" } | { kind: "none" }

/** Thinking section of one entry's parameter panel: per-model levels when carried, else the current model's live levels, else the fallback note */
function thinkingSectionOf(entry: PiModelMenuEntry<PiModelMenuRow>, currentSegments: { value: string; label: string }[]): ThinkingSection {
  const row = entry.representative
  if (row.reasoning === false) return { kind: "none" }
  const own = modelThinkingOptionsOf(row.thinkingLevels)
  if (own.length) return { kind: "options", options: own }
  if (entryCurrent(entry) && currentSegments.length) return { kind: "options", options: currentSegments }
  return { kind: "unknown" }
}

/** Available-only entries for the menu, filtered by the search query (redesign sections 2.1, 3) */
function entriesOf(models: readonly PiModelMenuRow[], query: string): PiModelMenuEntry<PiModelMenuRow>[] {
  const available = models.filter((model) => !model.unconfigured)
  const matched = query.trim() ? available.filter((model) => paletteMatches(query, model.name, model.modelId, model.provider)) : available
  return modelMenuEntriesOf(matched)
}

/** The row's tail: Edit when the row is the active / editing one, else the current-row check, else empty */
function ModelTail({ current, showEdit, onEdit, interactive }: { current?: boolean; showEdit: boolean; onEdit?: () => void; interactive: boolean }) {
  return (
    <span className={TAIL} data-slot="pi-model-tail">
      {showEdit ? (
        interactive ? (
          <button
            type="button"
            data-slot="pi-model-edit"
            aria-label="编辑模型参数"
            className="rounded px-1 py-0.5 text-(length:--cw-text-sm) text-(--cw-text-2) hover:text-(--cw-text)"
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.stopPropagation()
              onEdit?.()
            }}
          >
            编辑
          </button>
        ) : (
          <span className="px-1 py-0.5 text-(length:--cw-text-sm) text-(--cw-text-2)">编辑</span>
        )
      ) : current ? (
        <Check aria-hidden strokeWidth={1.5} className="size-(--cw-icon-size-sm) text-(--cw-icon-fg)" />
      ) : null}
    </span>
  )
}

/** Auto row (redesign section 4): label, default-model sublabel, switch */
function ModelAutoRow({ defaultName, autoOn, onToggle, interactive }: { defaultName: string; autoOn: boolean; onToggle: (next: boolean) => void; interactive: boolean }) {
  return (
    <div data-slot="pi-model-auto" data-on={autoOn ? "" : undefined} className="flex min-h-8 items-center gap-2 px-2" role="presentation">
      <span className="shrink-0 text-(length:--cw-text-md) text-(--cw-text)">Auto</span>
      <span className={cn("min-w-0 truncate text-(length:--cw-text-sm)", C_SECONDARY)}>设备默认 · {defaultName}</span>
      <span className="ml-auto flex shrink-0 items-center pl-1">
        <Switch size="sm" checked={autoOn} onCheckedChange={interactive ? onToggle : undefined} disabled={!interactive} aria-label="Auto：使用设备默认模型" />
      </span>
    </div>
  )
}

/** 列表组名：Auto 开着时列表置灰（CHANGELOG「列表置灰」），组名顺带说明怎么回到手选 */
function modelListLabel(autoOn: boolean): string {
  return autoOn ? "模型 · 关掉 Auto 才能手选" : "模型"
}

/** 列表还没到（转圈 + 灰字）/ 读失败（红字 + 重试）：占空态的位置 */
function ModelListStatus({ phase, error, onRetry, phone }: { phase: "loading" | "error"; error?: string; onRetry?: () => void; phone: boolean }) {
  const box = cn("flex items-center", phone ? "min-h-[52px] px-1 text-[13px] leading-[18px]" : "min-h-7 px-2 text-(length:--cw-text-sm)")
  if (phase === "loading") {
    return (
      <div data-slot="pi-model-status" data-phase="loading" className={cn(box, "gap-2", C_SECONDARY)}>
        <PiSpinner className="size-3.5" label="正在读取模型" />
        正在读取模型…
      </div>
    )
  }
  return (
    <div data-slot="pi-model-status" data-phase="error" role="alert" className={cn(box, "flex-wrap gap-x-2", C_ERROR)}>
      <span className="min-w-0">读取模型失败{error ? ` · ${error}` : ""}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className={cn("shrink-0 font-(--cw-weight-medium) underline", phone && TOUCH_44)}>
          重试
        </button>
      )}
    </div>
  )
}

/** Empty states (redesign section 7): zero configured models, or no search match */
function ModelEmptyState({ query, onConfigureModels }: { query?: string; onConfigureModels?: () => void }) {
  if (query?.trim()) {
    return <div className={cn("px-2 py-1.5 text-(length:--cw-text-sm)", C_SECONDARY)}>没有匹配的模型</div>
  }
  return (
    <div className="flex flex-col items-start gap-2 px-2 py-4">
      <span className={cn("text-(length:--cw-text-sm)", C_SECONDARY)}>这台设备还没有配置任何模型</span>
      {onConfigureModels && (
        <button type="button" className="rounded-full bg-(--cw-text) px-3 py-1 text-(length:--cw-text-sm) text-(--cw-surface)" onClick={onConfigureModels}>
          去配置模型
        </button>
      )}
    </div>
  )
}

/** The parameter panel that replaces the explainer card once Edit is clicked (redesign section 5.2) */
function ModelParamsPanel({
  entry,
  isCurrent,
  thinking,
  section,
  onContext,
  onThinking,
}: {
  entry: PiModelMenuEntry<PiModelMenuRow>
  isCurrent: boolean
  thinking: string
  section: ThinkingSection
  onContext: (row: PiModelMenuRow) => void
  onThinking: (value: string) => void
}) {
  return (
    <div data-slot="pi-model-params" role="group" aria-label={`${entry.representative.name} 的参数`} className={cn(menuSurfaceClass, menuShadowClass("popover"), "w-[212px] text-left")}>
      {entry.hasContextVariants && (
        <>
          <MenuLabel className={C_SECONDARY}>上下文</MenuLabel>
          {entry.variants.map((variant) => (
            <button
              key={variant.key}
              type="button"
              role="menuitemradio"
              aria-checked={!!variant.current}
              className={PARAM_ROW}
              onClick={() => onContext(variant)}
            >
              {contextWindowLabel(variant.contextWindow ?? 0)}
              <span className={cn(TAIL, "pl-2")}>{variant.current ? <Check aria-hidden strokeWidth={1.5} className="size-(--cw-icon-size-sm) text-(--cw-icon-fg)" /> : null}</span>
            </button>
          ))}
          <MenuSeparator />
        </>
      )}
      {section.kind === "options" && (
        <>
          <MenuLabel className={C_SECONDARY}>思考级别</MenuLabel>
          {section.options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={isCurrent && option.value === thinking}
              className={PARAM_ROW}
              onClick={() => onThinking(option.value)}
            >
              {option.label}
              <span className={cn(TAIL, "pl-2")}>{isCurrent && option.value === thinking ? <Check aria-hidden strokeWidth={1.5} className="size-(--cw-icon-size-sm) text-(--cw-icon-fg)" /> : null}</span>
            </button>
          ))}
        </>
      )}
      {section.kind === "unknown" && (
        <>
          <MenuLabel className={C_SECONDARY}>思考级别</MenuLabel>
          <div className={cn("px-2 py-1 text-(length:--cw-text-sm)", C_SECONDARY)}>切换到该模型后可调</div>
        </>
      )}
      {section.kind === "none" && !entry.hasContextVariants && <div className={cn("px-2 py-1 text-(length:--cw-text-sm)", C_SECONDARY)}>这个模型没有可调的参数</div>}
    </div>
  )
}

/**
 * Model menu (redesign 2026-11-09, Cursor-style): search -> Auto row -> available models only
 * (name + fixed tail column; no context-size column, no unconfigured rows). Desktop hovers show
 * Edit in the tail column plus a facts explainer card; Edit opens the parameter panel.
 * Phone renders as a PiSheet with two levels (redesign section 6). Static states keep the old
 * frame (gallery screens) with the new list.
 * compose from kit: MenuSurface, MenuSearch, MenuLabel, MenuItem, MenuSeparator; the intro card
 * reuses ch4/ModelExplainerCard. Accessibility (section 4.7): the model list is a listbox, the
 * active row is marked with aria-activedescendant (aria-selected), the current model with
 * aria-checked; the card sits outside the option and is linked with aria-describedby.
 * P4 interactive: desktop focus goes into the search box (combobox), Up/Down move the active
 * row, Enter picks it, Right opens the panel, Left closes it, Esc closes panel first, then menu;
 * the phone sheet focuses the model list itself (data-pi-autofocus), Up/Down / Enter work the same.
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
  defaultModel,
  auto,
  onAutoChange,
  onConfigureModels,
  listPhase,
  listError,
  onRetry,
  className,
  ...rest
}: PiModelMenuProps) {
  const isStatic = usePiStatic(staticProp)
  const rows = models as PiModelMenuRow[]
  const common = { variant, models: rows, thinkingLevels, thinking, defaultModel, auto, onAutoChange, onConfigureModels, listPhase, listError, onRetry, className, div: rest }
  if (variant === "phone" || bare) {
    return <ModelSheetList {...common} interactive={!isStatic} onSelectModel={onSelectModel} onThinkingChange={onThinkingChange} />
  }
  if (isStatic) return <ModelMenuStatic {...common} hoverKey={hoverKey} explainer={explainer} />
  return <ModelMenuInteractive {...common} onSelectModel={onSelectModel} onThinkingChange={onThinkingChange} explainerFor={explainerFor} />
}

interface ModelMenuPartProps {
  variant: CVariant
  models: PiModelMenuRow[]
  thinkingLevels: { value: string; label: string }[]
  thinking: string
  defaultModel?: PiModelDefault | null
  auto?: boolean
  onAutoChange?: (next: boolean) => void
  onConfigureModels?: () => void
  listPhase?: PiModelMenuProps["listPhase"]
  listError?: string
  onRetry?: () => void
  className?: string
  /** Extra div attributes passed by the caller */
  div: Omit<ComponentProps<"div">, "children">
}

function ModelMenuStatic({
  models,
  thinkingLevels,
  defaultModel,
  auto,
  onConfigureModels,
  hoverKey,
  explainer,
  className,
  div,
}: ModelMenuPartProps & Pick<PiModelMenuProps, "hoverKey" | "explainer">) {
  // The active row is marked with aria-activedescendant: the hovered / Up-Down row (falling back to the current model)
  const base = useId()
  const rowId = (key: string) => modelRowId(base, key)
  const allEntries = entriesOf(models, "")
  const entries = allEntries
  const defaultKey = defaultModel ? `${defaultModel.provider}/${defaultModel.modelId}` : null
  const defaultAvailable = defaultKey ? allEntries.some((entry) => entry.variants.some((row) => row.key === defaultKey)) : false
  const defaultName = defaultModel?.name ?? defaultModel?.modelId ?? ""
  const currentIsDefault = defaultKey ? allEntries.some((entry) => entryCurrent(entry) && entry.variants.some((row) => row.key === defaultKey)) : false
  const showAuto = !!defaultModel && defaultAvailable
  const autoOn = modelAutoOn({ showAuto, auto, currentIsDefault })
  const activeEntry = hoverKey ? entries.find((entry) => entry.key === hoverKey || entry.variants.some((row) => row.key === hoverKey)) : undefined
  const activeKey = activeEntry?.key ?? entries.find((entry) => entryCurrent(entry))?.key
  const explainerId = `${base}-explainer`
  const surfaceRef = useRef<HTMLDivElement>(null)
  const side = useExplainerSide(surfaceRef, EXPLAINER_GAP)
  return (
    <MenuSurface
      ref={surfaceRef}
      data-slot="pi-model-menu"
      data-cw-id="pi-model-menu"
      role="group"
      aria-label="模型"
      className={cn("w-[300px]", className)}
      {...div}
    >
      <MenuSearch placeholder="搜索模型…" aria-label="搜索模型" />
      {showAuto && (
        <>
          <ModelAutoRow defaultName={defaultName} autoOn={autoOn} onToggle={() => undefined} interactive={false} />
          <MenuSeparator />
        </>
      )}
      <MenuLabel id={rowId("label")} className={C_SECONDARY}>
        {modelListLabel(autoOn)}
      </MenuLabel>
      {/* R2-C-m2: the model list is a listbox, activedescendant points at the row with aria-selected=true; the current model (check) also uses aria-checked */}
      {entries.length === 0 ? (
        <ModelEmptyState onConfigureModels={onConfigureModels} />
      ) : (
        <div
          role="listbox"
          aria-labelledby={rowId("label")}
          aria-activedescendant={activeKey ? rowId(activeKey) : undefined}
          aria-disabled={autoOn || undefined}
          tabIndex={-1}
          className={cn("flex flex-col", autoOn && "opacity-40")}
        >
          {entries.map((entry) => {
            const row = entry.representative
            const isActive = entry.key === activeKey
            const card = isActive && explainer != null && !autoOn
            const showEdit = isActive && !autoOn && entryEditable(entry, thinkingLevels)
            return (
              <div key={entry.key} role="none" className="relative flex shrink-0 flex-col">
                <MenuItem
                  id={rowId(entry.key)}
                  role="option"
                  aria-selected={isActive}
                  aria-checked={entryCurrent(entry)}
                  aria-describedby={card ? explainerId : undefined}
                  highlighted={isActive && !autoOn}
                  className="min-h-7"
                  trailing={<ModelTail current={entryCurrent(entry)} showEdit={showEdit} interactive={false} />}
                >
                  {row.name}
                </MenuItem>
                {/* The card's containing block is the row's outer layer (relative, same box as the row): left = row right edge + menu padding 4 + gap 8 */}
                {card && (
                  <span id={explainerId} data-slot="pi-model-explainer-anchor" className={cn(EXPLAINER_ANCHOR, side === "left" ? EXPLAINER_ANCHOR_LEFT : EXPLAINER_ANCHOR_RIGHT, "text-left whitespace-nowrap")}>
                    {explainer}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </MenuSurface>
  )
}

function ModelMenuInteractive({
  models,
  thinkingLevels,
  thinking,
  defaultModel,
  auto,
  onAutoChange,
  onConfigureModels,
  listPhase,
  listError,
  onRetry,
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
  const [autoInternal, setAutoInternal] = useState<boolean | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const allEntries = useMemo(() => entriesOf(models, ""), [models])
  const entries = useMemo(() => entriesOf(models, query), [models, query])
  const defaultKey = defaultModel ? `${defaultModel.provider}/${defaultModel.modelId}` : null
  const defaultAvailable = defaultKey ? allEntries.some((entry) => entry.variants.some((row) => row.key === defaultKey)) : false
  const defaultName = defaultModel?.name ?? defaultModel?.modelId ?? ""
  const currentIsDefault = defaultKey ? allEntries.some((entry) => entryCurrent(entry) && entry.variants.some((row) => row.key === defaultKey)) : false
  const showAuto = !!defaultModel && defaultAvailable
  const autoOn = modelAutoOn({ showAuto, auto, internal: autoInternal, currentIsDefault })
  const nav = useListNav(
    entries.map(() => !autoOn),
    Math.max(0, entries.findIndex((entry) => entryCurrent(entry))),
  )
  const active = entries[nav.active]
  const editingEntry = editingKey ? entries.find((entry) => entry.key === editingKey) ?? null : null
  const searchRef = useRef<HTMLInputElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fallbackCard = (entry: PiModelMenuEntry<PiModelMenuRow>): ReactNode => {
    // Facts only (redesign section 2.4): the explainer is built from the row's own
    // fields -- no invented tagline; the cost line comes from the row when present.
    // The facts line uses modelFactsLineOf instead of modelExplainerOf's
    // longer context phrasing.
    const row = entry.representative as PiModelRow
    const data = modelExplainerOf(row, row.contextWindow ?? null)
    const facts = modelFactsLineOf(row)
    return <ModelExplainerCard data-cw-id="pi-model-explainer" explainer={{ ...data, context: facts || data.context, version: undefined }} className={C_EXPLAINER_ORANGE} />
  }
  const activeCard: ReactNode = useMemo(() => {
    if (autoOn) return null
    if (editingEntry) {
      const section = thinkingSectionOf(editingEntry, thinkingLevels)
      return (
        <ModelParamsPanel
          entry={editingEntry}
          isCurrent={entryCurrent(editingEntry)}
          thinking={thinking}
          section={section}
          onContext={(variant) => {
            if (variant.current) return
            onSelectModel?.(variant.key)
            if (!entryCurrent(editingEntry)) close?.()
          }}
          onThinking={(value) => {
            if (entryCurrent(editingEntry)) {
              onThinkingChange?.(value)
              return
            }
            onSelectModel?.(editingEntry.representative.key)
            onThinkingChange?.(value)
            close?.()
          }}
        />
      )
    }
    if (!active) return null
    return explainerFor?.(active.representative.key) ?? fallbackCard(active)
  }, [autoOn, editingEntry, active, explainerFor, thinkingLevels, thinking, onSelectModel, onThinkingChange, close])
  const anchorEntry = editingEntry ?? active ?? null
  const activeRowId = activeCard != null && anchorEntry ? modelRowId(base, anchorEntry.representative.key) : null
  // After opening, and after keyboard Up/Down: scroll the active row into the list's visible range (pointer-hovered rows are already visible, so they do not scroll)
  const reveal = useRef(true)
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    const row = activeRowId ? document.getElementById(activeRowId)?.parentElement : null
    // 列表还没到时先不消耗这次滚动，等行出来再滚到当前模型
    if (!reveal.current || !scroller || !row) return
    reveal.current = false
    if (row.offsetTop < scroller.scrollTop) scroller.scrollTop = row.offsetTop
    else if (row.offsetTop + row.offsetHeight > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = row.offsetTop + row.offsetHeight - scroller.clientHeight
  }, [activeRowId])
  const explainer = useExplainerTop(surfaceRef, scrollRef, activeCard != null ? activeRowId : null)
  const side = useExplainerSide(surfaceRef, EXPLAINER_GAP)
  const select = (entry: PiModelMenuEntry<PiModelMenuRow> | undefined) => {
    if (!entry || autoOn) return
    onSelectModel?.(entry.representative.key)
    close?.()
  }
  const toggleAuto = (next: boolean) => {
    if (onAutoChange) onAutoChange(next)
    else setAutoInternal(next)
    if (next && defaultKey) onSelectModel?.(defaultKey)
  }
  const openPanel = (entry: PiModelMenuEntry<PiModelMenuRow>) => {
    if (autoOn || !entryEditable(entry, thinkingLevels)) return
    setEditingKey(entry.key)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && editingEntry) {
      event.preventDefault()
      event.stopPropagation()
      setEditingKey(null)
      return
    }
    if (event.key === "ArrowRight" && active && !editingEntry && entryEditable(active, thinkingLevels)) {
      event.preventDefault()
      setEditingKey(active.key)
      return
    }
    if (event.key === "ArrowLeft" && editingEntry) {
      event.preventDefault()
      setEditingKey(null)
      return
    }
    if (nav.onKeyDown(event)) {
      reveal.current = true
      return
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault()
      select(active)
    }
  }
  // With a MenuSearch anchored menu, focus goes into the search box on open (design section 4.7 focus table); Radix would otherwise focus the menu itself
  const focusSearch = (event: Event) => {
    event.preventDefault()
    searchRef.current?.focus({ preventScroll: true })
  }
  const empty = allEntries.length === 0
  return (
    <MenuSurface
      {...surface}
      ref={surfaceRef}
      onOpenAutoFocus={focusSearch}
      data-slot="pi-model-menu"
      data-cw-id="pi-model-menu"
      role="group"
      aria-label="模型"
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
        aria-activedescendant={active ? modelRowId(base, active.representative.key) : undefined}
        value={query}
        onValueChange={(v) => {
          setQuery(v)
          setEditingKey(null)
          nav.setActive(0)
          reveal.current = true
        }}
        onKeyDown={onKeyDown}
      />
      {showAuto && (
        <>
          <ModelAutoRow defaultName={defaultName} autoOn={autoOn} onToggle={toggleAuto} interactive />
          <MenuSeparator />
        </>
      )}
      {empty ? (
        listPhase ? (
          <ModelListStatus phase={listPhase} error={listError} onRetry={onRetry} phone={false} />
        ) : (
          <ModelEmptyState onConfigureModels={onConfigureModels} />
        )
      ) : (
        <>
          <MenuLabel id={labelId} className={C_SECONDARY}>
            {modelListLabel(autoOn)}
          </MenuLabel>
          <div ref={scrollRef} data-slot="pi-model-list-scroll" className={cn(LIST_SCROLL, autoOn && "pointer-events-none opacity-40")} onScroll={explainer.place}>
            <div role="listbox" id={listId} aria-labelledby={labelId} className="flex flex-col">
              {entries.length === 0 && <ModelEmptyState query={query} />}
              {entries.map((entry, i) => {
                const on = i === nav.active
                const isEditing = editingEntry?.key === entry.key
                const card = on && !editingEntry ? activeCard : null
                const showEdit = (on || isEditing) && !autoOn && entryEditable(entry, thinkingLevels)
                return (
                  <div key={entry.key} role="none" className="relative flex shrink-0 flex-col">
                    <div
                      id={modelRowId(base, entry.representative.key)}
                      role="option"
                      aria-selected={on}
                      aria-checked={entryCurrent(entry)}
                      aria-disabled={autoOn || undefined}
                      aria-describedby={card != null ? explainerId : undefined}
                      data-highlighted={on || isEditing ? "" : undefined}
                      className={cn(
                        menuItemClass({ kind: "dropdown", weak: false, dim: false, forcedOn: on || isEditing, twoLine: false }),
                        "min-h-7",
                      )}
                      onMouseDown={(event) => event.preventDefault()}
                      onPointerMove={() => {
                        if (!on) nav.setActive(i)
                      }}
                      onClick={() => select(entry)}
                    >
                      <MenuItemContent
                        label={entry.representative.name}
                        trailing={<ModelTail current={entryCurrent(entry)} showEdit={showEdit} onEdit={() => openPanel(entry)} interactive />}
                        checked={false}
                        weak={false}
                        dim={false}
                        forcedOn={on || isEditing}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
      {activeCard != null && (
        <span
          id={explainerId}
          data-slot="pi-model-explainer-anchor"
          className={cn(EXPLAINER_FLOAT, side === "left" ? EXPLAINER_FLOAT_LEFT : EXPLAINER_FLOAT_RIGHT, "text-left whitespace-nowrap")}
          style={explainer.top == null ? HIDDEN_STYLE : { top: explainer.top }}
        >
          {activeCard}
        </span>
      )}
    </MenuSurface>
  )
}

const HIDDEN_STYLE: CSSProperties = { visibility: "hidden" }

/** Phone sheet model menu (redesign section 6): level 1 list, level 2 parameter page (two levels shared by static and interactive states) */
function ModelSheetList({
  variant,
  models,
  thinkingLevels,
  thinking,
  defaultModel,
  auto,
  onAutoChange,
  onConfigureModels,
  listPhase,
  listError,
  onRetry,
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
  const [query, setQuery] = useState("")
  const [autoInternal, setAutoInternal] = useState<boolean | null>(null)
  const [pageKey, setPageKey] = useState<string | null>(null)
  const allEntries = useMemo(() => entriesOf(models, ""), [models])
  const entries = useMemo(() => entriesOf(models, query), [models, query])
  const defaultKey = defaultModel ? `${defaultModel.provider}/${defaultModel.modelId}` : null
  const defaultAvailable = defaultKey ? allEntries.some((entry) => entry.variants.some((row) => row.key === defaultKey)) : false
  const defaultName = defaultModel?.name ?? defaultModel?.modelId ?? ""
  const currentIsDefault = defaultKey ? allEntries.some((entry) => entryCurrent(entry) && entry.variants.some((row) => row.key === defaultKey)) : false
  const showAuto = !!defaultModel && defaultAvailable
  const autoOn = modelAutoOn({ showAuto, auto, internal: autoInternal, currentIsDefault })
  const pageEntry = pageKey ? entries.find((entry) => entry.key === pageKey) ?? allEntries.find((entry) => entry.key === pageKey) ?? null : null
  const current = Math.max(0, entries.findIndex((entry) => entryCurrent(entry)))
  const nav = useListNav(
    entries.map(() => !autoOn),
    current,
  )
  // Static state: activedescendant = the current model; interactive: the Up/Down row
  const activeKey = interactive ? entries[nav.active]?.key : entries.find((entry) => entryCurrent(entry))?.key
  const activeId = activeKey ? rowId(activeKey) : undefined
  const toggleAuto = (next: boolean) => {
    if (onAutoChange) onAutoChange(next)
    else setAutoInternal(next)
    if (next && defaultKey) onSelectModel?.(defaultKey)
  }
  const select = (entry: PiModelMenuEntry<PiModelMenuRow> | undefined) => {
    if (!interactive || !entry || autoOn) return
    onSelectModel?.(entry.representative.key)
    close?.()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (pageEntry) return
    if (nav.onKeyDown(event, true)) return
    if ((event.key === "Enter" || event.key === " ") && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      select(entries[nav.active])
    }
  }
  const pickContext = (entry: PiModelMenuEntry<PiModelMenuRow>, variantRow: PiModelMenuRow) => {
    if (!interactive) return
    if (variantRow.current) {
      setPageKey(null)
      return
    }
    onSelectModel?.(variantRow.key)
    if (entryCurrent(entry)) setPageKey(null)
    else close?.()
  }
  const pickThinking = (entry: PiModelMenuEntry<PiModelMenuRow>, value: string) => {
    if (!interactive) return
    if (entryCurrent(entry)) {
      onThinkingChange?.(value)
      setPageKey(null)
      return
    }
    onSelectModel?.(entry.representative.key)
    onThinkingChange?.(value)
    close?.()
  }
  if (pageEntry) {
    const row = pageEntry.representative
    const section = thinkingSectionOf(pageEntry, thinkingLevels)
    const facts = modelFactsLineOf(row) || row.spec
    return (
      <div data-slot="pi-model-menu" data-cw-id="pi-model-menu" role="group" aria-label="模型参数" className={cn("flex flex-col", className)} {...div}>
        <div className="flex min-h-11 items-center gap-1 pb-1">
          <button
            type="button"
            aria-label="返回模型列表"
            className={cn("-ml-1.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full text-(--cw-icon-fg)", TOUCH_44_BOX, MENU_ROW_HL_HOVER)}
            onClick={() => setPageKey(null)}
          >
            <ChevronLeft aria-hidden strokeWidth={1.75} className="size-5" />
          </button>
          <span className={cn(t.main, "min-w-0 truncate font-(--cw-weight-semibold) text-(--cw-text)")}>{row.name}</span>
        </div>
        {facts && <div className={cn("px-1 pb-2", t.sub, C_SECONDARY)}>{facts}</div>}
        {row.costNote && <div className={cn("px-1 pb-2", t.sub, C_WARNING)}>{row.costNote}</div>}
        {pageEntry.hasContextVariants && (
          <>
            <div className={cn("mt-2 px-1 pb-1", t.sub, C_SECONDARY)}>上下文</div>
            {pageEntry.variants.map((variantRow) => (
              <button
                key={variantRow.key}
                type="button"
                className={SHEET_OPTION_ROW}
                onClick={() => pickContext(pageEntry, variantRow)}
              >
                <span className={cn(t.main, "flex-1 text-(--cw-text)")}>{contextWindowLabel(variantRow.contextWindow ?? 0)}</span>
                {variantRow.current && <Check aria-hidden strokeWidth={1.75} className="size-5 shrink-0 text-(--cw-icon-fg)" />}
              </button>
            ))}
          </>
        )}
        {section.kind === "options" && (
          <>
            <div className={cn("mt-4 px-1 pb-1", t.sub, C_SECONDARY)}>思考级别</div>
            {section.options.map((option) => (
              <button
                key={option.value}
                type="button"
                className={SHEET_OPTION_ROW}
                onClick={() => pickThinking(pageEntry, option.value)}
              >
                <span className={cn(t.main, "flex-1 text-(--cw-text)")}>{option.label}</span>
                {entryCurrent(pageEntry) && option.value === thinking && <Check aria-hidden strokeWidth={1.75} className="size-5 shrink-0 text-(--cw-icon-fg)" />}
              </button>
            ))}
          </>
        )}
        {section.kind === "unknown" && (
          <>
            <div className={cn("mt-4 px-1 pb-1", t.sub, C_SECONDARY)}>思考级别</div>
            <div className={cn("px-1 py-2", t.sub, C_SECONDARY)}>切换到该模型后可调</div>
          </>
        )}
        {section.kind === "none" && !pageEntry.hasContextVariants && <div className={cn("px-1 py-2", t.sub, C_SECONDARY)}>这个模型没有可调的参数</div>}
      </div>
    )
  }
  return (
    <div data-slot="pi-model-menu" data-cw-id="pi-model-menu" role="group" aria-label="模型" className={cn("flex flex-col", className)} {...div}>
      <PiSheetSearch
        placeholder="搜索模型…"
        aria-label="搜索模型"
        value={query}
        onChange={(event) => {
          setQuery(event.currentTarget.value)
          nav.setActive(0)
        }}
        className="mb-2"
      />
      {showAuto && (
        <>
          <div data-slot="pi-model-auto" data-on={autoOn ? "" : undefined} className="flex min-h-[52px] items-center gap-2 px-1" role="presentation">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn(t.main, "font-(--cw-weight-medium) text-(--cw-text)")}>Auto</span>
              <span className={cn("min-w-0 truncate", t.sub, C_SECONDARY)}>设备默认 · {defaultName}</span>
            </span>
            <span className="flex shrink-0 items-center">
              <Switch size="sm" checked={autoOn} onCheckedChange={interactive ? toggleAuto : undefined} disabled={!interactive} aria-label="Auto：使用设备默认模型" />
            </span>
          </div>
          <div className={cn("h-px", MENU_DIVIDER_BG)} />
        </>
      )}
      {allEntries.length === 0 && listPhase !== "loading" ? (
        listPhase === "error" ? (
          <ModelListStatus phase="error" error={listError} onRetry={onRetry} phone />
        ) : (
          <ModelEmptyState onConfigureModels={onConfigureModels} />
        )
      ) : (
        <>
          <div id={rowId("label")} className={cn("mt-3 px-1 pb-1", t.sub, C_SECONDARY)}>
            {modelListLabel(autoOn)}
          </div>
          {/* R2-C-m2: the model list is a listbox, activedescendant points at the row with aria-selected=true (screen readers say "selected"); the current model also uses aria-checked */}
          <div
            role="listbox"
            aria-labelledby={rowId("label")}
            aria-activedescendant={activeId}
            tabIndex={interactive ? 0 : -1}
            // Interactive: focus goes into the model list itself when the sheet opens (piInitialFocusOf recognises data-pi-autofocus), so Up/Down work right away.
            // The list is already here while the models are still loading, so focus never falls back to the search box (no keyboard on open)
            data-pi-autofocus={interactive ? "" : undefined}
            onKeyDown={interactive ? onKeyDown : undefined}
            className={cn("flex flex-col", autoOn && "pointer-events-none opacity-40")}
          >
            {allEntries.length === 0 ? <ModelListStatus phase="loading" phone /> : entries.length === 0 && <ModelEmptyState query={query} />}
            {entries.map((entry) => {
              const row = entry.representative
              const isCurrent = entryCurrent(entry)
              const showEdit = !isCurrent && !autoOn && entryEditable(entry, thinkingLevels)
              return (
                <div
                  key={entry.key}
                  id={rowId(entry.key)}
                  role="option"
                  aria-selected={entry.key === activeKey}
                  aria-checked={isCurrent}
                  aria-disabled={autoOn || undefined}
                  className={cn(
                    "flex min-h-[52px] items-center gap-3 border-b border-solid px-1 py-2 last:border-b-0",
                    MENU_DIVIDER_BORDER,
                    interactive && entry.key === activeKey && MENU_ROW_HL,
                  )}
                  onClick={
                    interactive
                      ? () => {
                          if (isCurrent) setPageKey(entry.key)
                          else select(entry)
                        }
                      : undefined
                  }
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={cn(t.main, "text-(--cw-text)")}>{row.name}</span>
                  </span>
                  {showEdit ? (
                    interactive ? (
                      <button
                        type="button"
                        data-slot="pi-model-edit"
                        aria-label={`编辑 ${row.name} 的参数`}
                        className={cn(t.main, TOUCH_44, "shrink-0 px-2 py-1 text-(--cw-text-2)")}
                        onClick={(event: MouseEvent<HTMLButtonElement>) => {
                          event.stopPropagation()
                          setPageKey(entry.key)
                        }}
                      >
                        编辑
                      </button>
                    ) : (
                      <span data-slot="pi-model-edit" className={cn(t.main, "shrink-0 px-2 py-1 text-(--cw-text-2)")}>
                        编辑
                      </span>
                    )
                  ) : isCurrent ? (
                    <Check aria-hidden strokeWidth={1.75} className="size-5 shrink-0 text-(--cw-icon-fg)" />
                  ) : null}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
