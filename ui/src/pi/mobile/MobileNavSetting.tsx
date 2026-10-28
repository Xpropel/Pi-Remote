import { useRef } from "react"
import { IconCheck } from "./icons"
import { PI_MOBILE_NAV_COPY, type PiMobileNavMode, type PiMobileNavSettingProps } from "./types.ts"

const OPTIONS: readonly { value: PiMobileNavMode; title: string; desc: string }[] = [
  { value: "drawer", title: PI_MOBILE_NAV_COPY.drawerName, desc: PI_MOBILE_NAV_COPY.drawerDesc },
  { value: "list", title: PI_MOBILE_NAV_COPY.listName, desc: PI_MOBILE_NAV_COPY.listDesc },
]

/** P11-MOB-10 设置项「移动端交互 UI」：两卡 84/gap10，默认 list；文案逐字取 PI_MOBILE_NAV_COPY。 */
export function MobileNavSetting({ value, onChange, disabled = false }: PiMobileNavSettingProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const move = (delta: number) => {
    if (disabled) return
    const index = OPTIONS.findIndex((option) => option.value === value)
    const next = OPTIONS[(index + delta + OPTIONS.length) % OPTIONS.length]
    onChange(next.value)
    requestAnimationFrame(() => refs.current[OPTIONS.indexOf(next)]?.focus())
  }
  return (
    <div className="pi-mobile pm-nav-setting pm-setting-embed" data-pi-mobile-surface="P11-MOB-10">
      <div className="pm-nav-setting-head">{PI_MOBILE_NAV_COPY.title}</div>
      <div className="pm-nav-setting-cards" role="radiogroup" aria-label={PI_MOBILE_NAV_COPY.title}>
        {OPTIONS.map((option, optionIndex) => {
          const checked = value === option.value
          return (
            <button
              key={option.value}
              ref={(el) => { refs.current[optionIndex] = el }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              className="pm-nav-setting-card"
              data-active={checked ? "" : undefined}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                  event.preventDefault()
                  move(1)
                } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                  event.preventDefault()
                  move(-1)
                }
              }}
            >
              <span className="pm-nav-setting-preview" data-mode={option.value} aria-hidden>
                {option.value === "drawer" ? (
                  <>
                    <span className="pm-pv-drawer" />
                    <span className="pm-pv-content">
                      <i />
                      <i />
                      <i />
                    </span>
                  </>
                ) : (
                  <>
                    <span className="pm-pv-row pm-pv-row-first">
                      <span className="pm-pv-dot" />
                      <i />
                    </span>
                    <span className="pm-pv-row" />
                    <span className="pm-pv-row" />
                  </>
                )}
              </span>
              <span className="pm-nav-setting-text">
                <span className="pm-nav-setting-title">{option.title}</span>
                <span className="pm-nav-setting-desc">{option.desc}</span>
              </span>
              <span className="pm-nav-setting-radio" aria-hidden>
                {checked ? <IconCheck size={14} /> : null}
              </span>
            </button>
          )
        })}
      </div>
      <p className="pm-nav-setting-foot">{PI_MOBILE_NAV_COPY.footnote}</p>
    </div>
  )
}

/** spec 7.1 建议名别名 */
export const MobileSettingsPicker = MobileNavSetting
