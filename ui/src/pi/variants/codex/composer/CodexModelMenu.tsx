import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react"
import {
  contextWindowLabel,
  modelFactsLineOf,
  modelMenuEntriesOf,
  modelThinkingOptionsOf,
  type PiModelMenuEntry,
  type PiModelRow,
} from "@/pi/model/models"
import { paletteMatches } from "@/pi/model/composerInput"

import { CodexSpinner } from "../primitives/primitives"

/** Device default model identity for the Auto row (redesign section 2.5), as resolved by modelDefaultOf */
export type CodexModelDefault = { provider: string; modelId: string; key: string; name: string }

type ThinkingSection = { kind: "options"; options: { value: string; label: string }[] } | { kind: "unknown" } | { kind: "none" }

/** Whether an entry is the session's current model (any of its variants is current) */
function entryCurrentOf(entry: PiModelMenuEntry<PiModelRow>): boolean {
  return entry.representative.current === true || entry.variants.some((row) => row.current === true)
}

/** Whether an entry can show Edit (redesign section 2.3): context variants, or a model that can think */
function entryEditableOf(entry: PiModelMenuEntry<PiModelRow>, currentSegments: readonly { value: string; label: string }[]): boolean {
  if (entry.hasContextVariants) return true
  const row = entry.representative
  if (row.reasoning === false) return false
  if ((row.thinkingLevels?.length ?? 0) > 0) return true
  return entryCurrentOf(entry) && currentSegments.length > 0
}

/** Thinking section of one entry's parameter panel: per-model levels when carried, else the current model's live levels, else the fallback note */
function thinkingSectionOf(entry: PiModelMenuEntry<PiModelRow>, currentSegments: readonly { value: string; label: string }[]): ThinkingSection {
  const row = entry.representative
  if (row.reasoning === false) return { kind: "none" }
  const own = modelThinkingOptionsOf(row.thinkingLevels)
  if (own.length) return { kind: "options", options: own }
  if (entryCurrentOf(entry) && currentSegments.length) return { kind: "options", options: [...currentSegments] }
  return { kind: "unknown" }
}

/** Available-only entries, folded into context-variant groups and filtered by the search query (redesign sections 2.1, 2.2, 3) */
function entriesOf(rows: readonly PiModelRow[], query: string): PiModelMenuEntry<PiModelRow>[] {
  const available = rows.filter((row) => !row.unconfigured)
  const matched = query.trim() ? available.filter((row) => paletteMatches(query, row.name, row.modelId, row.provider)) : available
  return modelMenuEntriesOf(matched)
}

/**
 * Model menu (redesign 2026-11-09, Cursor-style, behavior aligned with the standard shell):
 * search -> Auto row -> configured models only (name + fixed tail column: current check, or
 * Edit on the hovered / active row). Hovering shows a facts-only intro card; Edit pins the
 * parameter panel in the same slot (context section only for real variant groups, thinking
 * levels per model). Panel choices apply immediately; choosing on another model switches
 * to it. Phone renders the same pop as a two-level list (Edit always visible, no card).
 * Data comes from @/pi/model/models; commands run through the composer's callbacks.
 */
export function CodexModelMenu({
  rows,
  phase,
  phone,
  thinking,
  currentSegments,
  defaultModel,
  autoOn,
  onToggleAuto,
  onSelectModel,
  onSelectThinking,
  onConfigureModels,
  onClose,
}: {
  rows: readonly PiModelRow[]
  phase: string
  phone: boolean
  /** Current session thinking level value */
  thinking: string
  /** Levels of the current session model (get_available_thinking_levels), for its panel fallback */
  currentSegments: readonly { value: string; label: string }[]
  defaultModel: CodexModelDefault | null
  autoOn: boolean
  onToggleAuto: (next: boolean) => void
  onSelectModel: (row: PiModelRow) => void
  onSelectThinking: (level: string) => void
  onConfigureModels: () => void
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [pageKey, setPageKey] = useState<string | null>(null)
  const interacted = useRef(false)
  const popRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const allEntries = useMemo(() => entriesOf(rows, ""), [rows])
  const entries = useMemo(() => entriesOf(rows, query), [rows, query])
  const defaultAvailable = defaultModel ? allEntries.some((entry) => entry.variants.some((row) => row.key === defaultModel.key)) : false
  const showAuto = !!defaultModel && defaultAvailable
  const clampedActive = entries.length ? Math.min(activeIndex, entries.length - 1) : 0
  const activeEntry = entries[clampedActive] ?? null
  const editingEntry = editingKey ? entries.find((entry) => entry.key === editingKey) ?? null : null
  const pageEntry = pageKey ? allEntries.find((entry) => entry.key === pageKey) ?? null : null

  // Until the user moves around, the active row tracks the current model (rows may load after the menu opens)
  useEffect(() => {
    if (interacted.current) return
    const currentIndex = entries.findIndex((entry) => entryCurrentOf(entry))
    if (currentIndex >= 0) setActiveIndex(currentIndex)
  }, [entries])

  useEffect(() => {
    if (!phone) searchRef.current?.focus({ preventScroll: true })
  }, [phone])

  const anchorEntry = editingEntry ?? activeEntry
  const [cardTop, setCardTop] = useState<number | null>(null)
  const placeCard = useCallback(() => {
    const pop = popRef.current
    const scroller = scrollRef.current
    const rowElement = anchorEntry ? [...(pop?.querySelectorAll("[data-model-entry]") ?? [])].find((element) => element.getAttribute("data-model-entry") === anchorEntry.key) : null
    if (!pop || !scroller || !rowElement) {
      setCardTop(null)
      return
    }
    const popRect = pop.getBoundingClientRect()
    const rowRect = rowElement.getBoundingClientRect()
    const scrollRect = scroller.getBoundingClientRect()
    const center = rowRect.top + rowRect.height / 2 - popRect.top
    const topEdge = scrollRect.top - popRect.top
    const bottomEdge = scrollRect.bottom - popRect.top
    setCardTop(Math.min(Math.max(center, topEdge), bottomEdge))
  }, [anchorEntry])
  useLayoutEffect(() => {
    placeCard()
  })

  const selectEntry = (entry: PiModelMenuEntry<PiModelRow> | null) => {
    if (!entry || autoOn) return
    onSelectModel(entry.representative)
    onClose()
  }
  const openPanel = (entry: PiModelMenuEntry<PiModelRow>) => {
    if (autoOn || !entryEditableOf(entry, currentSegments)) return
    setEditingKey(entry.key)
  }
  const pickContext = (entry: PiModelMenuEntry<PiModelRow>, variantRow: PiModelRow) => {
    if (variantRow.current) return
    onSelectModel(variantRow)
    if (!entryCurrentOf(entry)) onClose()
  }
  const pickThinking = (entry: PiModelMenuEntry<PiModelRow>, value: string) => {
    if (entryCurrentOf(entry)) {
      onSelectThinking(value)
      return
    }
    onSelectModel(entry.representative)
    onSelectThinking(value)
    onClose()
  }
  const pickContextPhone = (entry: PiModelMenuEntry<PiModelRow>, variantRow: PiModelRow) => {
    if (variantRow.current) {
      setPageKey(null)
      return
    }
    onSelectModel(variantRow)
    if (entryCurrentOf(entry)) setPageKey(null)
    else onClose()
  }
  const pickThinkingPhone = (entry: PiModelMenuEntry<PiModelRow>, value: string) => {
    if (entryCurrentOf(entry)) {
      onSelectThinking(value)
      setPageKey(null)
      return
    }
    onSelectModel(entry.representative)
    onSelectThinking(value)
    onClose()
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (editingKey) {
        event.preventDefault()
        event.stopPropagation()
        setEditingKey(null)
      }
      return
    }
    if (phone || pageEntry) return
    // Row navigation keys belong to the search box; the same keys on a panel
    // button keep their native button behavior instead of also moving the list.
    if (event.target !== searchRef.current) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      interacted.current = true
      const delta = event.key === "ArrowDown" ? 1 : -1
      setActiveIndex((index) => Math.min(Math.max(index + delta, 0), Math.max(entries.length - 1, 0)))
      return
    }
    if (event.key === "ArrowRight" && activeEntry && !editingEntry) {
      if (entryEditableOf(activeEntry, currentSegments)) {
        event.preventDefault()
        setEditingKey(activeEntry.key)
      }
      return
    }
    if (event.key === "ArrowLeft" && editingEntry) {
      event.preventDefault()
      setEditingKey(null)
      return
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault()
      selectEntry(activeEntry)
    }
  }

  const renderThinkingSection = (entry: PiModelMenuEntry<PiModelRow>, onPick: (entry: PiModelMenuEntry<PiModelRow>, value: string) => void, optionClass: string) => {
    const section = thinkingSectionOf(entry, currentSegments)
    const isCurrent = entryCurrentOf(entry)
    if (section.kind === "options") {
      return (
        <>
          <div className="cx-model-section-label">思考级别</div>
          {section.options.map((option) => (
            <button key={option.value} type="button" role="menuitemradio" aria-checked={isCurrent && option.value === thinking} className={optionClass} onClick={() => onPick(entry, option.value)}>
              <span className="cx-model-option-main">{option.label}</span>
              <span className="cx-model-tail">{isCurrent && option.value === thinking ? "✓" : null}</span>
            </button>
          ))}
        </>
      )
    }
    if (section.kind === "unknown") {
      return (
        <>
          <div className="cx-model-section-label">思考级别</div>
          <div className="cx-model-note">切换到该模型后可调</div>
        </>
      )
    }
    return null
  }

  const renderContextSection = (entry: PiModelMenuEntry<PiModelRow>, onPick: (entry: PiModelMenuEntry<PiModelRow>, variantRow: PiModelRow) => void, optionClass: string) => {
    if (!entry.hasContextVariants) return null
    return (
      <>
        <div className="cx-model-section-label">上下文</div>
        {entry.variants.map((variantRow) => (
          <button key={variantRow.key} type="button" role="menuitemradio" aria-checked={!!variantRow.current} className={optionClass} onClick={() => onPick(entry, variantRow)}>
            <span className="cx-model-option-main">{contextWindowLabel(variantRow.contextWindow ?? 0)}</span>
            <span className="cx-model-tail">{variantRow.current ? "✓" : null}</span>
          </button>
        ))}
      </>
    )
  }

  const autoRow = showAuto ? (
    <div className="cx-model-auto" role="presentation">
      <span className="cx-model-auto-label">Auto</span>
      <span className="cx-model-auto-sub">设备默认 · {defaultModel.name}</span>
      <button
        type="button"
        role="switch"
        aria-checked={autoOn}
        aria-label="Auto：使用设备默认模型"
        className="cx-switch cx-model-auto-switch"
        data-on={autoOn ? "" : undefined}
        onClick={() => onToggleAuto(!autoOn)}
      >
        <span className="cx-switch-thumb" aria-hidden />
      </button>
    </div>
  ) : null

  if (phase === "loading" || phase === "idle") {
    return (
      <div className="cx-composer-pop cx-composer-pop-model" role="menu" aria-label="模型" data-p4-surface="CX-COMP-03" data-p4-ready="">
        <div className="cx-pop-loading">
          <CodexSpinner size={12} /> 正在读取模型…
        </div>
      </div>
    )
  }
  if (phase === "error") {
    return (
      <div className="cx-composer-pop cx-composer-pop-model" role="menu" aria-label="模型" data-p4-surface="CX-COMP-03" data-p4-ready="">
        <div className="cx-pop-loading">没有可用的模型（pi 未配置或设备离线）</div>
      </div>
    )
  }

  // Phone level 2: one model's parameter page (redesign section 6)
  if (phone && pageEntry) {
    const row = pageEntry.representative
    const facts = modelFactsLineOf(row)
    const section = thinkingSectionOf(pageEntry, currentSegments)
    return (
      <div className="cx-composer-pop cx-composer-pop-model" role="menu" aria-label="模型参数" data-p4-surface="CX-COMP-03" data-p4-ready="">
        <div className="cx-model-page-head">
          <button type="button" className="cx-model-back" onClick={() => setPageKey(null)}>
            ‹ 模型
          </button>
          <span className="cx-model-page-title">{row.name}</span>
        </div>
        {facts ? <div className="cx-model-page-facts">{facts}</div> : null}
        {row.costNote ? <div className="cx-model-page-cost">{row.costNote}</div> : null}
        <div className="cx-model-page-body">
          {renderContextSection(pageEntry, pickContextPhone, "cx-model-option cx-model-option-phone")}
          {pageEntry.hasContextVariants && section.kind !== "none" ? <div className="cx-model-sep" /> : null}
          {renderThinkingSection(pageEntry, pickThinkingPhone, "cx-model-option cx-model-option-phone")}
          {section.kind === "none" && !pageEntry.hasContextVariants ? <div className="cx-model-note">这个模型没有可调的参数</div> : null}
        </div>
      </div>
    )
  }

  const cardEntry = !phone && !autoOn ? anchorEntry : null
  return (
    <div
      ref={popRef}
      className="cx-composer-pop cx-composer-pop-model"
      role="menu"
      aria-label="模型"
      data-p4-surface="CX-COMP-03"
      data-p4-ready=""
      data-phone={phone ? "" : undefined}
      onKeyDown={onMenuKeyDown}
    >
      <div className="cx-model-search">
        <input
          ref={searchRef}
          type="text"
          placeholder="搜索模型…"
          aria-label="搜索模型"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setEditingKey(null)
            interacted.current = true
            setActiveIndex(0)
          }}
        />
      </div>
      {autoRow}
      {showAuto ? <div className="cx-model-sep" /> : null}
      {allEntries.length === 0 ? (
        <div className="cx-model-empty">
          <span>这台设备还没有配置任何模型</span>
          <button type="button" className="cx-model-configure" onClick={onConfigureModels}>
            去配置模型
          </button>
        </div>
      ) : (
        <div ref={scrollRef} className={autoOn ? "cx-model-scroll cx-model-scroll-dim" : "cx-model-scroll"} onScroll={placeCard}>
          {entries.length === 0 ? <div className="cx-model-note">没有匹配的模型</div> : null}
          {entries.map((entry, index) => {
            const row = entry.representative
            const isCurrent = entryCurrentOf(entry)
            const isActive = index === clampedActive
            const isEditing = editingEntry?.key === entry.key
            const showEdit = !phone
              ? (isActive || isEditing) && !autoOn && entryEditableOf(entry, currentSegments)
              : !isCurrent && !autoOn && entryEditableOf(entry, currentSegments)
            return (
              <div
                key={entry.key}
                data-model-entry={entry.key}
                role="option"
                aria-selected={isActive}
                aria-checked={isCurrent}
                aria-disabled={autoOn || undefined}
                className="cx-model-row"
                data-active={isActive || isEditing ? "" : undefined}
                data-editing={isEditing ? "" : undefined}
                data-current={isCurrent ? "" : undefined}
                onPointerMove={() => {
                  if (!phone && !isActive) {
                    interacted.current = true
                    setActiveIndex(index)
                  }
                }}
                onClick={() => {
                  if (phone && isCurrent) {
                    setPageKey(entry.key)
                    return
                  }
                  selectEntry(entry)
                }}
              >
                <span className="cx-model-row-name">{row.name || row.key}</span>
                <span className="cx-model-tail">
                  {showEdit ? (
                    <button
                      type="button"
                      className="cx-model-edit"
                      aria-label={`编辑 ${row.name} 的参数`}
                      onMouseDown={(event: MouseEvent<HTMLButtonElement>) => {
                        event.preventDefault()
                        event.stopPropagation()
                      }}
                      onClick={(event: MouseEvent<HTMLButtonElement>) => {
                        event.stopPropagation()
                        if (phone) setPageKey(entry.key)
                        else openPanel(entry)
                      }}
                    >
                      Edit
                    </button>
                  ) : isCurrent ? (
                    <span className="cx-model-check" aria-hidden>
                      ✓
                    </span>
                  ) : null}
                </span>
              </div>
            )
          })}
        </div>
      )}
      {cardEntry ? (
        <div className="cx-model-card-anchor" style={cardTop == null ? { visibility: "hidden" } : { top: cardTop }}>
          {editingEntry ? (
            <div className="cx-model-panel" role="group" aria-label={`${editingEntry.representative.name} 的参数`}>
              {renderContextSection(editingEntry, pickContext, "cx-model-option")}
              {editingEntry.hasContextVariants && thinkingSectionOf(editingEntry, currentSegments).kind !== "none" ? <div className="cx-model-sep" /> : null}
              {renderThinkingSection(editingEntry, pickThinking, "cx-model-option")}
              {thinkingSectionOf(editingEntry, currentSegments).kind === "none" && !editingEntry.hasContextVariants ? (
                <div className="cx-model-note">这个模型没有可调的参数</div>
              ) : null}
            </div>
          ) : (
            <div className="cx-model-card">
              <div className="cx-model-card-title">{cardEntry.representative.name}</div>
              {modelFactsLineOf(cardEntry.representative) ? <div className="cx-model-card-facts">{modelFactsLineOf(cardEntry.representative)}</div> : null}
              <div className="cx-model-card-key">{cardEntry.representative.key}</div>
              {cardEntry.representative.costNote ? <div className="cx-model-card-cost">{cardEntry.representative.costNote}</div> : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
