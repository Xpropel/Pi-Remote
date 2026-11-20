import { useState } from "react"
import { loadSettingsLocal, saveSettingsLocal, setSettingsPref } from "../settings/model.ts"
import { translate } from "../../i18n/index.ts"
import { getLanguage, LANGUAGE_LABELS, LANGUAGE_SETTINGS_EVENT, SUPPORTED_LANGUAGES, type Language } from "../../i18n/locale.ts"

/** Available before authentication on both phone and desktop. */
export function LanguagePicker() {
  const [error, setError] = useState(false)
  const change = (language: Language) => {
    if (language === getLanguage()) return
    try {
      const prefs = setSettingsPref(loadSettingsLocal(window.localStorage).prefs, "language", language)
      if (!saveSettingsLocal(window.localStorage, prefs)) { setError(true); return }
      window.dispatchEvent(new Event(LANGUAGE_SETTINGS_EVENT))
    } catch { setError(true) }
  }
  return (
    <div className="absolute right-4 top-4 z-10 flex flex-col items-end gap-1 text-sm">
      <label className="flex items-center gap-2">
        <span>{translate("界面语言")}</span>
        <select
          aria-label={translate("界面语言")}
          value={getLanguage()}
          onChange={(event) => change(event.target.value as Language)}
          className="rounded border border-(--cw-border) bg-(--cw-surface) px-2 py-1 text-(--cw-text)"
        >
          {SUPPORTED_LANGUAGES.map((language) => <option key={language} value={language}>{LANGUAGE_LABELS[language]}</option>)}
        </select>
      </label>
      {error && <span role="alert">{translate("无法保存语言设置，请允许浏览器存储。")}</span>}
    </div>
  )
}
