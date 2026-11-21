export const SUPPORTED_LANGUAGES = ["zh-CN", "en", "ja", "ko", "es", "fr"] as const
export type Language = (typeof SUPPORTED_LANGUAGES)[number]
export const LANGUAGE_LABELS: Record<Language, string> = { "zh-CN": "简体中文", en: "English", ja: "日本語", ko: "한국어", es: "Español", fr: "Français" }
export const LANGUAGE_STORAGE_KEY = "pi_remote_pi_settings_v2"
export const LANGUAGE_SETTINGS_EVENT = "pi-remote:settings-prefs"

const BROWSER_LANGUAGE_PREFIXES: readonly (readonly [string, Language])[] = [
  ["zh", "zh-CN"], ["ja", "ja"], ["ko", "ko"], ["es", "es"], ["fr", "fr"], ["en", "en"],
]

/** Saved preference wins; otherwise follow the browser, with English as fallback. */
export function resolveLanguage(stored: unknown, browserLanguage = "en"): Language {
  if ((SUPPORTED_LANGUAGES as readonly unknown[]).includes(stored)) return stored as Language
  const browser = browserLanguage.toLowerCase()
  for (const [prefix, language] of BROWSER_LANGUAGE_PREFIXES) if (browser.startsWith(prefix)) return language
  return "en"
}

export function browserLanguage(): Language {
  return resolveLanguage(undefined, typeof navigator === "undefined" ? "en" : navigator.language)
}

export function readLanguage(): Language {
  let stored: unknown
  try {
    const envelope = JSON.parse(window.localStorage.getItem(LANGUAGE_STORAGE_KEY) || "null")
    if (envelope?.v === 1) stored = envelope.prefs?.language
  } catch { /* Storage can be disabled or malformed. */ }
  return resolveLanguage(stored, browserLanguage())
}

// Module-level option lists are localized once. Keep all surfaces in the same
// language until a saved language change reloads the app (drafts stay persisted).
const activeLanguage = readLanguage()
export function getLanguage(): Language { return activeLanguage }

export function installLanguageSync(): () => void {
  if (typeof window === "undefined") return () => {}
  document.documentElement.lang = activeLanguage
  const update = () => {
    if (readLanguage() !== activeLanguage) window.location.reload()
  }
  const storage = (event: StorageEvent) => {
    if (event.key === LANGUAGE_STORAGE_KEY || event.key === null) update()
  }
  window.addEventListener(LANGUAGE_SETTINGS_EVENT, update)
  window.addEventListener("storage", storage)
  return () => {
    window.removeEventListener(LANGUAGE_SETTINGS_EVENT, update)
    window.removeEventListener("storage", storage)
  }
}
