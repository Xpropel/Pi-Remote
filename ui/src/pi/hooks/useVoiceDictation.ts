/**
 * Composer 语音听写 Hook：按偏好开关、快捷键与浏览器 SpeechRecognition API 实时写入草稿。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  collectRecognitionTranscript,
  dictationShortcutMatchesEvent,
  mergeDictationDraft,
  resolveRecognitionLang,
  speechRecognitionCtorOf,
  type SpeechRecognitionLike,
} from "@/pi/model/voiceDictation"

export interface UseVoiceDictationOptions {
  enabled: boolean
  draft: string
  onDraftChange: (next: string) => void
  shortcut: string
  language?: string
  disabled?: boolean
  overlayBlocked?: boolean
  onNotify?: (text: string, tone?: "warn" | "bad") => void
}

export interface UseVoiceDictationResult {
  supported: boolean
  listening: boolean
  toggle: () => void
  stop: () => void
}

export function useVoiceDictation({
  enabled,
  draft,
  onDraftChange,
  shortcut,
  language,
  disabled = false,
  overlayBlocked = false,
  onNotify,
}: UseVoiceDictationOptions): UseVoiceDictationResult {
  const ctor = useMemo(
    () => speechRecognitionCtorOf(typeof window !== "undefined" ? (window as unknown as Record<string, unknown>) : null),
    [],
  )
  const supported = ctor !== null
  const [listening, setListening] = useState(false)

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const baseDraftRef = useRef(draft)
  const draftRef = useRef(draft)
  const listeningRef = useRef(listening)
  const onDraftChangeRef = useRef(onDraftChange)
  const onNotifyRef = useRef(onNotify)

  useLayoutEffect(() => {
    draftRef.current = draft
    listeningRef.current = listening
    onDraftChangeRef.current = onDraftChange
    onNotifyRef.current = onNotify
  })

  const abortSession = useCallback(() => {
    const rec = recognitionRef.current
    recognitionRef.current = null
    if (rec) {
      rec.onresult = null
      rec.onerror = null
      rec.onend = null
      try {
        rec.abort()
      } catch {
        // ignore abort errors after teardown
      }
    }
    setListening(false)
  }, [])

  const stop = useCallback(() => {
    const rec = recognitionRef.current
    if (!rec) {
      setListening(false)
      return
    }
    try {
      rec.stop()
    } catch {
      abortSession()
    }
  }, [abortSession])

  const start = useCallback(() => {
    if (!ctor || !enabled || disabled) return
    abortSession()
    try {
      const rec = new ctor()
      baseDraftRef.current = draftRef.current
      rec.continuous = true
      rec.interimResults = true
      rec.lang = resolveRecognitionLang(language, typeof navigator !== "undefined" ? navigator.language : undefined)
      rec.onresult = (event) => {
        const spoken = collectRecognitionTranscript(event.results)
        if (!spoken) return
        onDraftChangeRef.current(mergeDictationDraft(baseDraftRef.current, spoken))
      }
      rec.onerror = (event) => {
        const code = event.error ?? ""
        if (code === "not-allowed" || code === "service-not-allowed") {
          onNotifyRef.current?.("麦克风权限被拒绝，请在浏览器地址栏允许访问", "warn")
        } else if (code && code !== "aborted" && code !== "no-speech") {
          onNotifyRef.current?.("语音听写不可用", "warn")
        }
        recognitionRef.current = null
        setListening(false)
      }
      rec.onend = () => {
        if (recognitionRef.current === rec) recognitionRef.current = null
        setListening(false)
      }
      recognitionRef.current = rec
      rec.start()
      setListening(true)
    } catch {
      recognitionRef.current = null
      setListening(false)
      onNotifyRef.current?.("无法启动语音听写", "warn")
    }
  }, [ctor, enabled, disabled, language, abortSession])

  const toggle = useCallback(() => {
    if (listeningRef.current) stop()
    else start()
  }, [stop, start])

  useEffect(() => {
    if (!enabled || disabled) abortSession()
  }, [enabled, disabled, abortSession])

  useEffect(() => abortSession, [abortSession])

  useEffect(() => {
    if (!enabled || !supported || disabled || overlayBlocked || !shortcut) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!dictationShortcutMatchesEvent(shortcut, event)) return
      event.preventDefault()
      toggle()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled, supported, disabled, overlayBlocked, shortcut, toggle])

  return { supported, listening, toggle, stop }
}
