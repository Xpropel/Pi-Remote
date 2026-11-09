import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { Check, Search } from "lucide-react"
import type { Relay } from "@/pi/containers/types"
import { paletteMatches } from "@/pi/model/composerInput"
import {
  contextWindowLabel,
  modelFactsLineOf,
  modelMenuEntriesOf,
  modelThinkingOptionsOf,
  type PiModelMenuEntry,
  type PiModelRow,
} from "@/pi/model/models"
import { ClaudeSwitch } from "../primitives/ClaudePrimitives"
import { selectModel, selectThinking } from "../model/logic"

/**
 * Claude shell model menu (redesign 2026-11-09, behavior aligned with the
 * standard shell's model menu, rendered with this variant's own classes and
 * --claude-* tokens):
 * - search -> Auto row -> configured models only; rows carry a name and a
 *   fixed tail column (current = check, active / editing = Edit), nothing else
 * - hovering (or keyboard-moving to) a row shows a facts-only intro card;
 *   Edit opens the parameter panel in the same slot (context section only
 *   for real context-variant groups, plus the thinking section)
 * - panel choices apply immediately; choosing on another model switches to it
 * - phone renders the same structure as a two-level sheet (Edit drills into
 *   the parameter page; tapping the current row opens its own page)
 */

export interface ClaudeModelMenuProps {
  relay: Relay
  /** Configured models only (the caller filters the unconfigured rows out) */
  rows: PiModelRow[]
  /** Live thinking levels of the session's current model (fallback for its panel) */
  segments: { value: string; label: string }[]
  /** True while the first models reply is still in flight */
  loading: boolean
  /** Device default model; null when the reply carries none (hides the Auto row) */
  defaultModel: { provider: string; modelId: string; key: string; name: string } | null
  auto: boolean
  onAutoChange: (next: boolean) => void
  onClose: () => void
  /** Empty-state action: jump to the settings page model section */
  onConfigureModels: () => void
  phone: boolean
}

type ClaudeModelEntry = PiModelMenuEntry<PiModelRow>

type ThinkingSection = { kind: "options"; options: { value: string; label: string }[] } | { kind: "unknown" } | { kind: "none" }

/** Whether an entry is the session's current model (any of its variants is current) */
function entryCurrent(entry: ClaudeModelEntry): boolean {
  return entry.representative.current === true || entry.variants.some((row) => row.current === true)
}

/** Whether an entry can show Edit: context variants, or a model that can think */
function entryEditable(entry: ClaudeModelEntry, currentSegments: { value: string; label: string }[]): boolean {
  if (entry.hasContextVariants) return true
  const row = entry.representative
  if (row.reasoning === false) return false
  if ((row.thinkingLevels?.length ?? 0) > 0) return true
  return entryCurrent(entry) && currentSegments.length > 0
}

/** Thinking section of one entry's panel: per-model levels when carried, else the current model's live levels, else the fallback note */
function thinkingSectionOf(entry: ClaudeModelEntry, currentSegments: { value: string; label: string }[]): ThinkingSection {
  const row = entry.representative
  if (row.reasoning === false) return { kind: "none" }
  const own = modelThinkingOptionsOf(row.thinkingLevels)
  if (own.length) return { kind: "options", options: own }
  if (entryCurrent(entry) && currentSegments.length) return { kind: "options", options: currentSegments }
  return { kind: "unknown" }
}

/** Configured entries folded into context-variant groups, filtered by the search query */
function entriesOf(rows: readonly PiModelRow[], query: string): ClaudeModelEntry[] {
  const matched = query.trim() ? rows.filter((row) => paletteMatches(query, row.name, row.modelId, row.provider)) : [...rows]
  return modelMenuEntriesOf(matched)
}

export function ClaudeModelMenu({ relay, rows, segments, loading, defaultModel, auto, onAutoChange, onClose, onConfigureModels, phone }: ClaudeModelMenuProps) {
  const thinking = relay.thinkingLevel
  const [query, setQuery] = useState("")
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [pageKey, setPageKey] = useState<string | null>(null)
  const [cardBox, setCardBox] = useState<{ top: number; side: "right" | "left" } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const allEntries = useMemo(() => entriesOf(rows, ""), [rows])
  const entries = useMemo(() => entriesOf(rows, query), [rows, query])
  const showAuto = !!defaultModel && allEntries.some((entry) => entry.variants.some((row) => row.key === defaultModel.key))
  const fallbackActive = query.trim() ? entries[0] : (entries.find((entry) => entryCurrent(entry)) ?? entries[0])
  const activeEntry = (activeKey ? entries.find((entry) => entry.key === activeKey) : undefined) ?? fallbackActive ?? null
  const editingEntry = editingKey ? (entries.find((entry) => entry.key === editingKey) ?? null) : null
  const pageEntry = pageKey ? (entries.find((entry) => entry.key === pageKey) ?? allEntries.find((entry) => entry.key === pageKey) ?? null) : null
  const anchorEntry = editingEntry ?? activeEntry

  // The intro card / parameter panel floats beside the menu, vertically
  // centered on the anchored row (clamped to the list's visible range) and
  // flipped to the left when the right side would overflow the viewport.
  const measureCard = () => {
    const root = rootRef.current
    const scroller = scrollRef.current
    if (phone || !root || !scroller || !anchorEntry || auto) {
      setCardBox((prev) => (prev === null ? prev : null))
      return
    }
    const rowElement = root.querySelector(`[data-claude-model-entry="${anchorEntry.key}"]`)
    if (!rowElement) {
      setCardBox((prev) => (prev === null ? prev : null))
      return
    }
    const rootRect = root.getBoundingClientRect()
    const rowRect = rowElement.getBoundingClientRect()
    const scrollRect = scroller.getBoundingClientRect()
    const center = rowRect.top + rowRect.height / 2 - rootRect.top
    const top = Math.min(Math.max(center, scrollRect.top - rootRect.top), scrollRect.bottom - rootRect.top)
    const side: "right" | "left" = rootRect.right + 10 + 248 <= window.innerWidth - 8 ? "right" : "left"
    setCardBox((prev) => (prev && Math.abs(prev.top - top) < 0.5 && prev.side === side ? prev : { top, side }))
  }
  useLayoutEffect(measureCard)

  const revealEntry = (entry: ClaudeModelEntry) => {
    const root = rootRef.current
    if (!root) return
    root.querySelector(`[data-claude-model-entry="${entry.key}"]`)?.scrollIntoView({ block: "nearest" })
  }

  const moveActive = (delta: number) => {
    if (entries.length === 0) return
    const index = activeEntry ? entries.indexOf(activeEntry) : -1
    const next = entries[Math.min(entries.length - 1, Math.max(0, index + delta))]
    if (next) {
      setActiveKey(next.key)
      requestAnimationFrame(() => revealEntry(next))
    }
  }

  const pickEntry = (entry: ClaudeModelEntry) => {
    if (auto) return
    if (!entryCurrent(entry)) selectModel(relay, entry.representative)
    onClose()
  }

  const openPanel = (entry: ClaudeModelEntry) => {
    if (auto || !entryEditable(entry, segments)) return
    setActiveKey(entry.key)
    setEditingKey(entry.key)
  }

  const pickContext = (entry: ClaudeModelEntry, variantRow: PiModelRow, fromPage: boolean) => {
    if (variantRow.current) {
      if (fromPage) setPageKey(null)
      return
    }
    selectModel(relay, variantRow)
    if (entryCurrent(entry)) {
      if (fromPage) setPageKey(null)
    } else {
      onClose()
    }
  }

  const pickThinking = (entry: ClaudeModelEntry, value: string, fromPage: boolean) => {
    if (entryCurrent(entry)) {
      selectThinking(relay, value)
      if (fromPage) setPageKey(null)
      return
    }
    selectModel(relay, entry.representative)
    selectThinking(relay, value)
    onClose()
  }

  const toggleAuto = (next: boolean) => {
    onAutoChange(next)
    if (next && defaultModel) {
      selectModel(relay, { provider: defaultModel.provider, modelId: defaultModel.modelId })
      setEditingKey(null)
    }
  }

  const onQueryChange = (value: string) => {
    setQuery(value)
    setEditingKey(null)
    setActiveKey(null)
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      if (editingKey) setEditingKey(null)
      else onClose()
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      moveActive(event.key === "ArrowDown" ? 1 : -1)
      return
    }
    if (event.key === "ArrowRight" && activeEntry && !editingKey) {
      event.preventDefault()
      openPanel(activeEntry)
      return
    }
    if (event.key === "ArrowLeft" && editingKey) {
      event.preventDefault()
      setEditingKey(null)
      return
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing && activeEntry) {
      event.preventDefault()
      pickEntry(activeEntry)
    }
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      moveActive(event.key === "ArrowDown" ? 1 : -1)
      return
    }
    if (event.key === "Enter" && activeEntry) {
      event.preventDefault()
      if (entryCurrent(activeEntry)) setPageKey(activeEntry.key)
      else pickEntry(activeEntry)
    }
  }

  const renderPanelSections = (entry: ClaudeModelEntry, fromPage: boolean) => {
    const section = thinkingSectionOf(entry, segments)
    const isCurrent = entryCurrent(entry)
    return (
      <>
        {entry.hasContextVariants ? (
          <>
            <p className="claude-model-panel-label">上下文</p>
            {entry.variants.map((variantRow) => (
              <button
                key={variantRow.key}
                type="button"
                role="menuitemradio"
                aria-checked={!!variantRow.current}
                className="claude-model-option"
                onClick={() => pickContext(entry, variantRow, fromPage)}
              >
                <span className="claude-model-option-name">{contextWindowLabel(variantRow.contextWindow ?? 0)}</span>
                <span className="claude-model-tail">{variantRow.current ? <Check size={14} strokeWidth={2} aria-hidden /> : null}</span>
              </button>
            ))}
            <div className="claude-menu-sep" role="separator" />
          </>
        ) : null}
        {section.kind === "options" ? (
          <>
            <p className="claude-model-panel-label">思考级别</p>
            {section.options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={isCurrent && option.value === thinking}
                className="claude-model-option"
                onClick={() => pickThinking(entry, option.value, fromPage)}
              >
                <span className="claude-model-option-name">{option.label}</span>
                <span className="claude-model-tail">{isCurrent && option.value === thinking ? <Check size={14} strokeWidth={2} aria-hidden /> : null}</span>
              </button>
            ))}
          </>
        ) : null}
        {section.kind === "unknown" ? (
          <>
            <p className="claude-model-panel-label">思考级别</p>
            <p className="claude-menu-note">切换到该模型后可调</p>
          </>
        ) : null}
        {section.kind === "none" && !entry.hasContextVariants ? <p className="claude-menu-note">这个模型没有可调的参数</p> : null}
      </>
    )
  }

  const searchRow = (
    <div className="claude-model-search">
      <Search size={14} strokeWidth={2} aria-hidden className="claude-model-search-icon" />
      <input
        type="text"
        className="claude-model-search-input"
        placeholder="搜索模型…"
        aria-label="搜索模型"
        value={query}
        autoFocus={!phone}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={phone ? undefined : onSearchKeyDown}
      />
    </div>
  )

  const autoRow = showAuto && defaultModel ? (
    <>
      <div className="claude-model-auto">
        <span className="claude-model-auto-name">Auto</span>
        <span className="claude-model-auto-sub">设备默认 · {defaultModel.name}</span>
        <span className="claude-model-auto-switch">
          <ClaudeSwitch checked={auto} onChange={toggleAuto} label="Auto：使用设备默认模型" />
        </span>
      </div>
      <div className="claude-menu-sep" role="separator" />
    </>
  ) : null

  if (phone && pageEntry) {
    const row = pageEntry.representative
    const facts = modelFactsLineOf(row)
    return (
      <div className="claude-composer-popover claude-model-popover claude-model-popover-phone" role="dialog" aria-label="模型参数">
        <div className="claude-model-page-head">
          <button type="button" className="claude-model-page-back" onClick={() => setPageKey(null)}>
            ‹ 模型
          </button>
          <span className="claude-model-page-title">{row.name}</span>
        </div>
        {facts ? <p className="claude-model-page-facts">{facts}</p> : null}
        {row.costNote ? <p className="claude-model-page-cost">{row.costNote}</p> : null}
        {renderPanelSections(pageEntry, true)}
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className={`claude-composer-popover claude-model-popover${phone ? " claude-model-popover-phone" : ""}`}
      role="dialog"
      aria-label="模型"
    >
      {searchRow}
      {autoRow}
      {loading && allEntries.length === 0 ? <p className="claude-menu-note">正在读取模型清单…</p> : null}
      {!loading && allEntries.length === 0 ? (
        <div className="claude-model-empty">
          <p className="claude-menu-note">这台设备还没有配置任何模型</p>
          <button type="button" className="claude-model-configure" onClick={onConfigureModels}>
            去配置模型
          </button>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className={`claude-model-list${auto ? " claude-model-list-inert" : ""}`}
          role="listbox"
          aria-label="模型"
          tabIndex={phone ? 0 : undefined}
          onKeyDown={phone ? onListKeyDown : undefined}
          onScroll={measureCard}
        >
          {entries.length === 0 ? <p className="claude-menu-note">没有匹配的模型</p> : null}
          {entries.map((entry) => {
            const row = entry.representative
            const isCurrent = entryCurrent(entry)
            const isActive = activeEntry?.key === entry.key
            const isEditing = editingEntry?.key === entry.key
            const editable = entryEditable(entry, segments)
            const showEdit = phone ? !isCurrent && !auto && editable : (isActive || isEditing) && !auto && editable
            return (
              <div
                key={entry.key}
                role="option"
                aria-selected={isActive}
                aria-checked={isCurrent}
                aria-disabled={auto || undefined}
                data-claude-model-entry={entry.key}
                className="claude-model-row"
                data-current={isCurrent ? "" : undefined}
                data-active={isActive ? "" : undefined}
                data-editing={isEditing ? "" : undefined}
                onPointerMove={() => {
                  if (!phone && !isActive) setActiveKey(entry.key)
                }}
                onClick={() => {
                  if (phone && isCurrent) setPageKey(entry.key)
                  else pickEntry(entry)
                }}
              >
                <span className="claude-model-row-name">{row.name}</span>
                <span className="claude-model-tail">
                  {showEdit ? (
                    <button
                      type="button"
                      className="claude-model-edit"
                      aria-label={`编辑 ${row.name} 的参数`}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                      }}
                      onClick={(event) => {
                        event.stopPropagation()
                        if (phone) setPageKey(entry.key)
                        else openPanel(entry)
                      }}
                    >
                      Edit
                    </button>
                  ) : isCurrent ? (
                    <Check size={14} strokeWidth={2} className="claude-model-row-check" aria-hidden />
                  ) : null}
                </span>
              </div>
            )
          })}
        </div>
      )}
      {!phone && cardBox && anchorEntry && !auto ? (
        editingEntry ? (
          <div className="claude-model-panel" data-side={cardBox.side} style={{ top: cardBox.top }} role="group" aria-label={`${anchorEntry.representative.name} 的参数`}>
            {renderPanelSections(anchorEntry, false)}
          </div>
        ) : (
          <div className="claude-model-card" data-side={cardBox.side} style={{ top: cardBox.top }} role="note">
            <p className="claude-model-card-title">{anchorEntry.representative.name}</p>
            {modelFactsLineOf(anchorEntry.representative) ? <p className="claude-model-card-facts">{modelFactsLineOf(anchorEntry.representative)}</p> : null}
            {anchorEntry.representative.costNote ? <p className="claude-model-card-cost">{anchorEntry.representative.costNote}</p> : null}
          </div>
        )
      ) : null}
    </div>
  )
}
