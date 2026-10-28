/**
 * 手机端设置 · 交互（手机专属第 13 页）。
 *
 * 唯一设置项 = 移动端交互 UI 二选一；写的是宿主 ui.prefs.mobileNav（不是设置页自己的
 * pi_remote_pi_settings_v2），默认列表式，切换立即生效、仅影响移动端。
 * 文案逐字取 @/pi/mobile/types 的 PI_MOBILE_NAV_COPY（三套共用，不得改写）。
 */
import { Check } from "lucide-react"
import { PI_MOBILE_NAV_COPY, type PiMobileNavMode } from "@/pi/mobile/types"
import { useSettings } from "../../SettingsContext.tsx"
import { MOBILE_NAV_DEFAULT } from "../types.ts"
import { MobileGroup, MobileNote, MobilePageBody } from "../atoms.tsx"

const OPTIONS: readonly { value: PiMobileNavMode; title: string; description: string }[] = [
  { value: "list", title: PI_MOBILE_NAV_COPY.listName, description: PI_MOBILE_NAV_COPY.listDesc },
  { value: "drawer", title: PI_MOBILE_NAV_COPY.drawerName, description: PI_MOBILE_NAV_COPY.drawerDesc },
]

function NavPreview({ mode }: { mode: PiMobileNavMode }) {
  if (mode === "drawer") {
    return (
      <span className="sm-nav-preview" data-mode="drawer" aria-hidden="true">
        <span className="sm-nav-pv-drawer" />
        <span className="sm-nav-pv-content">
          <i />
          <i />
          <i />
        </span>
      </span>
    )
  }
  return (
    <span className="sm-nav-preview" data-mode="list" aria-hidden="true">
      <span className="sm-nav-pv-row sm-nav-pv-row--first">
        <span className="sm-nav-pv-dot" />
        <i />
      </span>
      <span className="sm-nav-pv-row" />
      <span className="sm-nav-pv-row" />
    </span>
  )
}

export function InteractionPage() {
  const { p } = useSettings()
  const value = p.ui.prefs.mobileNav ?? MOBILE_NAV_DEFAULT

  return (
    <MobilePageBody page="interaction">
      <MobileGroup label={PI_MOBILE_NAV_COPY.title} stacked>
        <div className="sm-nav-cards" role="radiogroup" aria-label={PI_MOBILE_NAV_COPY.title}>
          {OPTIONS.map((option) => {
            const on = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={on}
                data-mobile-nav-option={option.value}
                className={on ? "sm-nav-card is-on" : "sm-nav-card"}
                onClick={() => {
                  if (!on) p.act.setPref("mobileNav", option.value)
                }}
              >
                <NavPreview mode={option.value} />
                <span className="sm-nav-card-copy">
                  <span className="sm-nav-card-title">{option.title}</span>
                  <span className="sm-nav-card-desc">{option.description}</span>
                </span>
                {on ? (
                  <span className="sm-nav-card-check" aria-hidden="true">
                    <Check size={14} strokeWidth={2.6} />
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </MobileGroup>
      <MobileNote>{PI_MOBILE_NAV_COPY.footnote}</MobileNote>
    </MobilePageBody>
  )
}
