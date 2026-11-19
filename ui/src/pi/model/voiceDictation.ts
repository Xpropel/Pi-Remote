/**
 * Composer 语音听写（Web Speech API）纯逻辑（无 React / 无 DOM，node --test 直载）。
 */
import { chordOf, chordSignature, keycapOf, type ShortcutKeyInput } from "../settings/pages/shortcutsLogic.ts"

export interface SpeechRecognitionAlternativeLike {
  transcript?: string
}

export interface SpeechRecognitionResultLike {
  readonly isFinal?: boolean
  readonly length: number
  readonly [index: number]: SpeechRecognitionAlternativeLike | undefined
}

export interface SpeechRecognitionEventLike {
  readonly results: {
    readonly length: number
    readonly [index: number]: SpeechRecognitionResultLike | undefined
  }
}

export interface SpeechRecognitionErrorEventLike {
  readonly error?: string
  readonly message?: string
}

export interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

export interface DictationKeyEvent extends ShortcutKeyInput {
  isComposing?: boolean
  keyCode?: number
  repeat?: boolean
}

/** 从宿主对象取可用的 SpeechRecognition 构造器（优先标准，回落 webkit 前缀）。 */
export function speechRecognitionCtorOf(
  scope: { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown } | null | undefined,
): SpeechRecognitionConstructor | null {
  if (!scope) return null
  if (typeof scope.SpeechRecognition === "function") return scope.SpeechRecognition as SpeechRecognitionConstructor
  if (typeof scope.webkitSpeechRecognition === "function") return scope.webkitSpeechRecognition as SpeechRecognitionConstructor
  return null
}

/** 把语音识别结果列表拼成一段可读文本。 */
export function collectRecognitionTranscript(results: SpeechRecognitionEventLike["results"] | null | undefined): string {
  if (!results || typeof results.length !== "number") return ""
  const chunks: string[] = []
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i]
    const transcript = result?.[0]?.transcript
    if (typeof transcript === "string" && transcript.length > 0) chunks.push(transcript)
  }
  return chunks.join("").trim()
}

/** 将听写结果合入听写开始前的基础草稿，保留既有文本并在需要时补一个空格。 */
export function mergeDictationDraft(baseDraft: string, spoken: string): string {
  const clean = spoken.trim()
  if (!clean) return baseDraft
  if (!baseDraft) return clean
  if (/[\s\n]$/.test(baseDraft)) return `${baseDraft}${clean}`
  return `${baseDraft} ${clean}`
}

/** 规范化听写识别语言；"auto" 跟随浏览器语言并回落 zh-CN。 */
export function resolveRecognitionLang(language: string | undefined, browserLang?: string): string {
  const normalized = language?.trim()
  const lower = normalized?.toLowerCase()
  if (normalized === "zh" || normalized === "zh-CN" || lower?.startsWith("zh")) return "zh-CN"
  if (normalized === "en" || lower === "en-us") return "en-US"
  const fallback = (browserLang ?? "").trim()
  if (fallback.startsWith("en")) return fallback.includes("-") ? fallback : "en-US"
  if (fallback.startsWith("zh")) return fallback.includes("-") ? fallback : "zh-CN"
  return fallback || "zh-CN"
}

const SHORTCUT_MODIFIER_ALIASES: Record<string, string> = {
  alt: "⌥",
  option: "⌥",
  opt: "⌥",
  "⌥": "⌥",
  cmd: "⌘",
  command: "⌘",
  meta: "⌘",
  super: "⌘",
  win: "⌘",
  "⌘": "⌘",
  ctrl: "Ctrl",
  control: "Ctrl",
  "⌃": "Ctrl",
  shift: "⇧",
  "⇧": "⇧",
}

function normalizeShortcutPart(part: string): string {
  const mapped = SHORTCUT_MODIFIER_ALIASES[part.trim().toLowerCase()]
  return mapped ?? part.trim()
}

/** 判断一次 keydown 是否命中设置中的听写快捷键（兼容单键 Caps Lock 与组合键）。 */
export function dictationShortcutMatchesEvent(shortcut: string, event: DictationKeyEvent): boolean {
  if (!shortcut || event.isComposing || event.keyCode === 229 || event.repeat) return false
  const parts = shortcut
    .split(/\s+\+\s+/)
    .map(normalizeShortcutPart)
    .filter(Boolean)
  if (parts.length === 0) return false
  if (parts.length === 1 && parts[0].toLowerCase() === "caps lock") {
    return keycapOf(event.key) === "Caps Lock" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
  }
  const chord = chordOf(event)
  if (!chord) return false
  return chordSignature(chord) === chordSignature(parts)
}
