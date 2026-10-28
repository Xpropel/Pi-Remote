/**
 * 手机端设置 · 快捷键（整页 ○ 纯本地）。
 *
 * 网页应用自建的键位体系，与 pi 的 keybindings.json 无关。
 * 手机端主要给外接键盘用；点按行右侧键位即可录制新组合，写本机偏好。
 */
import { useSettings } from "../../SettingsContext.tsx"
import { SETTINGS_SHORTCUT_ACTIONS, SETTINGS_SHORTCUT_GROUP_LABELS, type SettingsShortcutId } from "../../types.ts"
import { SettingsShortcutCapture } from "../../ui.tsx"
import { MobileBanner, MobileGroup, MobilePageBody, MobileRow } from "../atoms.tsx"

const GROUP_ORDER = ["session", "navigation", "send", "model", "queue"] as const

export function ShortcutsPage() {
  const { prefs, act } = useSettings()

  const setKeys = (id: SettingsShortcutId, keys: string[]) => {
    act.setPref("shortcuts", { ...prefs.shortcuts, [id]: keys })
  }

  return (
    <MobilePageBody page="shortcuts">
      <MobileBanner>以下键位在外接键盘时可用；点按任意一行即可改键。</MobileBanner>

      {GROUP_ORDER.map((group) => {
        const actions = SETTINGS_SHORTCUT_ACTIONS.filter((action) => action.group === group)
        if (actions.length === 0) return null
        return (
          <MobileGroup key={group} label={SETTINGS_SHORTCUT_GROUP_LABELS[group]}>
            {actions.map((action) => (
              <MobileRow key={action.id} title={action.label} className="sm-shortcut-row">
                <SettingsShortcutCapture
                  label={action.label}
                  keys={prefs.shortcuts[action.id]}
                  onChange={(keys) => setKeys(action.id, keys)}
                />
              </MobileRow>
            ))}
          </MobileGroup>
        )
      })}
    </MobilePageBody>
  )
}
