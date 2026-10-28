/**
 * 设置 › 快捷键（设计册 §10，源码 settings-set-shortcuts-v3.html）。
 *
 * 整页 ○ 纯新建：网页应用自己的键位体系，与 pi 的 keybindings.json 无关。
 * 五组 16 个动作逐字照设计稿；每行右侧键位可点，按下新组合即改并立即写本机偏好。
 * Esc 取消录制；同一组合落到两个动作上时两行都提示冲突（不静默吞掉）。
 *
 * 动作映射见 shortcutsLogic.ts 的 SHORTCUT_ACTION_ROUTES；本页只负责录制 / 校验 / 持久化，
 * 全局分发由外壳读取同一份 prefs.shortcuts 后接线（本阶段不改共享壳）。
 */
import { useMemo, useState, type KeyboardEvent } from "react"
import { Pencil, Search } from "lucide-react"
import { useSettings } from "../SettingsContext"
import {
  SETTINGS_SHORTCUT_ACTIONS,
  SETTINGS_SHORTCUT_GROUP_LABELS,
  type SettingsShortcutAction,
  type SettingsShortcutGroupId,
  type SettingsShortcutId,
} from "../types"
import { SettingsGroup, SettingsKeycaps, SettingsPageTitle } from "../ui"
import {
  SHORTCUT_ACTION_ROUTES,
  chordOf,
  isModifierKey,
  matchesShortcutQuery,
  shortcutConflictTextOf,
  shortcutConflictsOf,
} from "./shortcutsLogic"
import "./shortcuts.css"

const ACTION_LABELS = Object.fromEntries(
  SETTINGS_SHORTCUT_ACTIONS.map((action) => [action.id, action.label]),
) as Record<string, string>

function groupIdsOf(actions: readonly SettingsShortcutAction[]): SettingsShortcutGroupId[] {
  const seen = new Set<SettingsShortcutGroupId>()
  const out: SettingsShortcutGroupId[] = []
  for (const action of actions) {
    if (seen.has(action.group)) continue
    seen.add(action.group)
    out.push(action.group)
  }
  return out
}

export function ShortcutsPage() {
  const { prefs, act } = useSettings()
  const [query, setQuery] = useState("")
  const [recording, setRecording] = useState<SettingsShortcutId | null>(null)
  const conflicts = useMemo(() => shortcutConflictsOf(prefs.shortcuts), [prefs.shortcuts])
  const visible = useMemo(
    () =>
      SETTINGS_SHORTCUT_ACTIONS.filter((action) =>
        matchesShortcutQuery(
          action.label,
          SETTINGS_SHORTCUT_GROUP_LABELS[action.group],
          prefs.shortcuts[action.id],
          query,
        ),
      ),
    [prefs.shortcuts, query],
  )
  const groupIds = useMemo(() => groupIdsOf(visible), [visible])

  const restart = (id: SettingsShortcutId) => {
    setRecording((current) => (current === id ? null : id))
  }

  const capture = (event: KeyboardEvent<HTMLButtonElement>, id: SettingsShortcutId) => {
    if (recording !== id) return
    // 录制期间按键不再冒泡给外壳快捷键；Esc 只取消，不写键位。
    event.preventDefault()
    event.stopPropagation()
    if (event.key === "Escape") {
      setRecording(null)
      return
    }
    if (isModifierKey(event.key)) return
    const keys = chordOf(event)
    if (!keys) return
    setRecording(null)
    act.setPref("shortcuts", { ...prefs.shortcuts, [id]: keys })
  }

  return (
    <div className="settings-page settings-shortcuts" data-settings-page="shortcuts">
      <SettingsPageTitle title="快捷键" />

      <div className="settings-shortcut-search">
        <Search size={15} strokeWidth={1.9} aria-hidden="true" className="settings-shortcut-search-icon" />
        <input
          className="settings-shortcut-search-input"
          aria-label="搜索快捷键"
          placeholder="搜索快捷键"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setRecording(null)
          }}
        />
      </div>
      <p className="settings-shortcut-hint">点任意一行右侧的键位即可改键。</p>
      {visible.length === 0 ? <p className="settings-shortcut-empty">没有匹配的快捷键</p> : null}

      {groupIds.map((groupId, index) => {
        const actions = visible.filter((action) => action.group === groupId)
        return (
          <SettingsGroup key={groupId} label={SETTINGS_SHORTCUT_GROUP_LABELS[groupId]} first={index === 0}>
            {actions.map((action) => {
              const active = recording === action.id
              const conflictLabels = (conflicts[action.id] ?? []).map((id) => ACTION_LABELS[id]).filter(Boolean)
              return (
                <div
                  className="settings-shortcut-item"
                  key={action.id}
                  data-shortcut-action={action.id}
                  data-shortcut-route={SHORTCUT_ACTION_ROUTES[action.id]}
                >
                  <div className="settings-shortcut-row">
                    <span className="settings-shortcut-name">{action.label}</span>
                    <button
                      type="button"
                      className={
                        active
                          ? "settings-keycap-capture settings-shortcut-keys is-recording"
                          : "settings-keycap-capture settings-shortcut-keys"
                      }
                      aria-label={active ? "按下新的快捷键组合，Esc 取消" : `${action.label}，点击改键`}
                      aria-pressed={active}
                      onClick={() => restart(action.id)}
                      onBlur={() => {
                        if (active) setRecording(null)
                      }}
                      onKeyDown={(event) => capture(event, action.id)}
                    >
                      {active ? (
                        <span className="settings-keycap-recording">按下新键… · Esc 取消</span>
                      ) : (
                        <>
                          <SettingsKeycaps keys={prefs.shortcuts[action.id]} />
                          <Pencil size={13} strokeWidth={1.8} aria-hidden="true" className="settings-shortcut-pen" />
                        </>
                      )}
                    </button>
                  </div>
                  {conflictLabels.length > 0 ? (
                    <p className="settings-shortcut-conflict" role="status">
                      {shortcutConflictTextOf(conflictLabels)}
                    </p>
                  ) : null}
                </div>
              )
            })}
          </SettingsGroup>
        )
      })}
    </div>
  )
}
