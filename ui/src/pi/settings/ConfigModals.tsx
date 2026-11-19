/**
 * 设置页配置弹窗（桌面 / 手机共用）。
 *
 * - ProviderConfigModal: 添加 / 编辑自定义供应商与 API 密钥（upsert_model_provider / delete_model_provider）
 * - ModelConfigModal:    添加 / 编辑供应商下模型（upsert_provider_model / delete_provider_model）
 * - McpServerModal:      添加 / 编辑 MCP 服务器（upsert_mcp_server / delete_mcp_server）
 *
 * 注意：密钥与 env/headers 只传写入值；已有配置只展示脱敏提示（hasApiKey / apiKeyHint / envKeys / headerKeys）。
 * 所有样式复用 `.settings-modal-*` 类名与 tokens.css 变量，不出现字面色值。
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { formatCommandArgs, splitCommandArgs } from "./pages/extensionsLogic.ts"

export { formatCommandArgs, splitCommandArgs }

export interface ModelConfigModel {
  id: string
  name?: string
  api?: string
  baseUrl?: string
  reasoning?: boolean
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  headerKeys?: string[]
}

export interface ModelConfigProvider {
  id: string
  name?: string
  baseUrl?: string
  api?: string
  authHeader?: boolean
  headerKeys?: string[]
  inModelsJson: boolean
  inAuthJson: boolean
  hasApiKey: boolean
  apiKeySource?: string | null
  apiKeyHint?: string | null
  models: ModelConfigModel[]
}

export type UpsertProviderPayload = {
  id: string
  name?: string
  baseUrl?: string
  api?: string
  authHeader?: boolean
  apiKey?: string
  clearApiKey?: boolean
  storage?: "models" | "auth" | "both"
}

export type UpsertModelPayload = {
  provider: string
  originalId?: string
  model: {
    id: string
    name?: string
    api?: string
    baseUrl?: string | null
    contextWindow?: number | null
    maxTokens?: number | null
    reasoning?: boolean
    input?: string[]
  }
}

export interface McpConfigServer {
  name: string
  transport: string
  exposure: string
  enabled: boolean
  command?: string
  args?: string[]
  url?: string
  hasUrlQuery?: boolean
  description?: string
  timeout?: number
  envKeys?: string[]
  headerKeys?: string[]
  connected?: boolean
  toolCount?: number | null
  error?: string
}

export type UpsertMcpServerPayload = {
  name: string
  originalName?: string
  transport: "stdio" | "http" | "sse"
  command?: string
  args?: string[] | null
  url?: string
  enabled?: boolean
  exposure?: "codemode" | "deferred" | "direct" | "hidden"
  description?: string
  timeout?: number | null
  env?: Record<string, string>
  clearEnv?: boolean
  headers?: Record<string, string>
  clearHeaders?: boolean
}

const API_TYPE_OPTIONS = [
  { value: "openai-completions", label: "OpenAI Completions (openai-completions)" },
  { value: "openai-responses", label: "OpenAI Responses (openai-responses)" },
  { value: "anthropic-messages", label: "Anthropic Messages (anthropic-messages)" },
  { value: "google-generative-ai", label: "Google Generative AI (google-generative-ai)" },
] as const

const MCP_TRANSPORT_OPTIONS = [
  { value: "stdio", label: "stdio（本地命令）" },
  { value: "http", label: "http（Streamable HTTP）" },
  { value: "sse", label: "sse（Server-Sent Events）" },
] as const

const MCP_EXPOSURE_OPTIONS = [
  { value: "codemode", label: "codemode（推荐 · 按需代码）" },
  { value: "deferred", label: "deferred（按需搜索）" },
  { value: "direct", label: "direct（全量注入）" },
  { value: "hidden", label: "hidden（仅存配置）" },
] as const

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",")

function visibleFocusablesOf(container: HTMLElement | null): HTMLElement[] {
  if (!container) return []
  const list: HTMLElement[] = []
  for (const el of container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
    const style = window.getComputedStyle(el)
    if (style.display === "none" || style.visibility === "hidden") continue
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    list.push(el)
  }
  return list
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === "string" && error.trim()) return error.trim()
  return "操作失败，请稍后重试"
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

function parseEnvLines(raw: string): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  const value: Record<string, string> = {}
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line) continue
    const eq = line.indexOf("=")
    if (eq <= 0) return { ok: false, error: `第 ${i + 1} 行环境变量格式需为 KEY=VALUE` }
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1)
    if (!key) return { ok: false, error: `第 ${i + 1} 行环境变量缺少键名` }
    value[key] = val
  }
  return { ok: true, value }
}

function parseHeaderLines(raw: string): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  const value: Record<string, string> = {}
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line) continue
    const colon = line.indexOf(":")
    const eq = line.indexOf("=")
    const sep = colon > 0 && (eq < 0 || colon < eq) ? colon : eq
    if (sep <= 0) return { ok: false, error: `第 ${i + 1} 行请求头格式需为 Name: Value` }
    const key = line.slice(0, sep).trim()
    const val = line.slice(sep + 1).trim()
    if (!key) return { ok: false, error: `第 ${i + 1} 行请求头缺少名称` }
    value[key] = val
  }
  return { ok: true, value }
}

export function SettingsModal({
  open,
  title,
  subtitle,
  busy = false,
  onClose,
  children,
}: {
  open: boolean
  title: string
  subtitle?: string
  busy?: boolean
  onClose: () => void
  children: ReactNode
}) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)
  const busyRef = useRef(busy)
  onCloseRef.current = onClose
  busyRef.current = busy

  useEffect(() => {
    if (!open || typeof document === "undefined") return
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const raf = window.requestAnimationFrame(() => {
      const panel = panelRef.current
      if (!panel) return
      const preferred = panel.querySelector<HTMLElement>(
        "input:not([disabled]):not([readonly]):not([type='hidden']), select:not([disabled]), textarea:not([disabled])",
      )
      const target = preferred ?? visibleFocusablesOf(panel)[0] ?? panel
      target.focus({ preventScroll: true })
    })

    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (event.isComposing) return
        event.preventDefault()
        event.stopPropagation()
        if (!busyRef.current) onCloseRef.current()
        return
      }
      if (event.key !== "Tab") return
      const panel = panelRef.current
      if (!panel) return
      const focusables = visibleFocusablesOf(panel)
      if (focusables.length === 0) {
        event.preventDefault()
        panel.focus({ preventScroll: true })
        return
      }
      const active = document.activeElement as HTMLElement | null
      const index = active ? focusables.indexOf(active) : -1
      if (event.shiftKey) {
        if (index <= 0) {
          event.preventDefault()
          focusables[focusables.length - 1].focus({ preventScroll: true })
        }
        return
      }
      if (index === -1 || index === focusables.length - 1) {
        event.preventDefault()
        focusables[0].focus({ preventScroll: true })
      }
    }

    window.addEventListener("keydown", onKeyDownCapture, true)
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener("keydown", onKeyDownCapture, true)
      if (prev && prev.isConnected) {
        window.requestAnimationFrame(() => {
          if (prev.isConnected) prev.focus({ preventScroll: true })
        })
      }
    }
  }, [open])

  if (!open || typeof document === "undefined") return null
  const settingsRoot = document.querySelector<HTMLElement>("[data-pi-settings]")
  const portalTarget = settingsRoot ?? document.body
  const fallbackAttrs = settingsRoot
    ? undefined
    : {
        "data-pi-settings": "",
        "data-pi-settings-style": "cursor",
        "data-pi-theme": document.documentElement.dataset.piTheme ?? "light",
      }

  return createPortal(
    <div
      className="settings-modal-backdrop"
      {...fallbackAttrs}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div
        ref={panelRef}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="settings-modal-head">
          <div className="settings-modal-titles">
            <h2 id={titleId} className="settings-modal-title">
              {title}
            </h2>
            {subtitle ? <p className="settings-modal-subtitle">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            className="settings-modal-close"
            aria-label="关闭弹窗"
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    portalTarget,
  )
}

/* ------------------------------------------------------------------ */
/* 1. 供应商配置弹窗                                                    */
/* ------------------------------------------------------------------ */

export interface ProviderConfigModalProps {
  open: boolean
  initialProvider?: ModelConfigProvider | null
  onClose: () => void
  onSave: (payload: UpsertProviderPayload) => Promise<void>
  onDelete?: (providerId: string) => Promise<void>
}

export function ProviderConfigModal({ open, initialProvider, onClose, onSave, onDelete }: ProviderConfigModalProps) {
  const isEdit = Boolean(initialProvider)
  const [id, setId] = useState("")
  const [name, setName] = useState("")
  const [api, setApi] = useState("openai-completions")
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [clearApiKey, setClearApiKey] = useState(false)
  const [authHeader, setAuthHeader] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setId(initialProvider?.id ?? "")
    setName(initialProvider?.name && initialProvider.name !== initialProvider.id ? initialProvider.name : "")
    setApi(initialProvider ? (initialProvider.api ?? "") : "openai-completions")
    setBaseUrl(initialProvider?.baseUrl ?? "")
    setApiKey("")
    setClearApiKey(false)
    setAuthHeader(initialProvider ? initialProvider.authHeader !== false : true)
    setSaving(false)
    setDeleting(false)
    setConfirmDelete(false)
    setError(null)
  }, [open, initialProvider])

  const busy = saving || deleting
  const apiOptions = [...API_TYPE_OPTIONS]
  const extraApi = initialProvider?.api && !API_TYPE_OPTIONS.some((item) => item.value === initialProvider.api)
    ? initialProvider.api
    : null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const trimmedId = id.trim()
    const trimmedName = name.trim()
    const trimmedBaseUrl = baseUrl.trim()
    const trimmedKey = apiKey.trim()
    if (!trimmedId) {
      setError("请填写供应商 ID（例如 openai、deepseek 或自定义标识）")
      return
    }
    if (/[\s/\\]/.test(trimmedId)) {
      setError("供应商 ID 不能包含空格或斜杠")
      return
    }
    if (trimmedBaseUrl && !isValidHttpUrl(trimmedBaseUrl)) {
      setError("接口地址需以 http:// 或 https:// 开头")
      return
    }
    setError(null)
    setSaving(true)
    try {
      await onSave({
        id: trimmedId,
        ...(isEdit
          ? { name: trimmedName, baseUrl: trimmedBaseUrl, api }
          : {
              ...(trimmedName ? { name: trimmedName } : {}),
              ...(trimmedBaseUrl ? { baseUrl: trimmedBaseUrl } : {}),
              ...(api ? { api } : {}),
            }),
        authHeader,
        ...(trimmedKey ? { apiKey: trimmedKey } : clearApiKey ? { clearApiKey: true } : {}),
      })
      onClose()
    } catch (err) {
      setError(errorMessageOf(err))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!onDelete || !initialProvider || busy) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setError(null)
    setDeleting(true)
    try {
      await onDelete(initialProvider.id)
      onClose()
    } catch (err) {
      setError(errorMessageOf(err))
      setConfirmDelete(false)
    } finally {
      setDeleting(false)
    }
  }

  const keyHintParts = [
    initialProvider?.apiKeySource ? `来源：${initialProvider.apiKeySource}` : null,
    initialProvider?.apiKeyHint ? initialProvider.apiKeyHint : null,
  ].filter(Boolean)

  return (
    <SettingsModal
      open={open}
      title={isEdit ? `配置供应商 · ${initialProvider?.id}` : "添加供应商"}
      subtitle={isEdit ? "修改连接参数或更新 API 密钥；留空密钥将保持原值不变。" : "配置兼容 OpenAI / Anthropic / Google 接口的模型供应商"}
      busy={busy}
      onClose={onClose}
    >
      <form className="settings-modal-form" noValidate onSubmit={(e) => void submit(e)}>
        <div className="settings-modal-body">
          {error ? (
            <div className="settings-modal-error" role="alert">
              {error}
            </div>
          ) : null}

          <label className="settings-modal-field">
            <span className="settings-modal-label">供应商 ID *</span>
            <input
              type="text"
              className="settings-modal-input settings-modal-mono"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="例如 deepseek、my-relay"
              readOnly={isEdit}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className="settings-modal-field">
            <span className="settings-modal-label">显示名称（可选）</span>
            <input
              type="text"
              className="settings-modal-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如 DeepSeek 中转"
              disabled={busy}
            />
          </label>

          <label className="settings-modal-field">
            <span className="settings-modal-label">接口协议</span>
            <select
              className="settings-modal-select"
              value={api}
              onChange={(e) => setApi(e.target.value)}
              disabled={busy}
            >
              <option value="">自动 / 默认（仅内置供应商适用）</option>
              {extraApi ? <option value={extraApi}>{extraApi}</option> : null}
              {apiOptions.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-modal-field">
            <span className="settings-modal-label">接口地址（Base URL）</span>
            <input
              type="url"
              className="settings-modal-input settings-modal-mono"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className="settings-modal-field">
            <span className="settings-modal-label">API Key</span>
            <input
              type="password"
              className="settings-modal-input settings-modal-mono"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value)
                if (e.target.value.trim()) setClearApiKey(false)
              }}
              placeholder={initialProvider?.hasApiKey ? "已配置密钥（留空保持不变）" : "sk-..."}
              disabled={busy}
              autoComplete="new-password"
            />
            {keyHintParts.length > 0 ? <span className="settings-modal-hint">{keyHintParts.join(" · ")}</span> : null}
          </label>

          {initialProvider?.hasApiKey ? (
            <label className="settings-modal-check">
              <input
                type="checkbox"
                checked={clearApiKey}
                onChange={(e) => setClearApiKey(e.target.checked)}
                disabled={busy || apiKey.trim().length > 0}
              />
              <span>清除已存储的 API Key</span>
            </label>
          ) : null}

          <label className="settings-modal-check">
            <input
              type="checkbox"
              checked={authHeader}
              onChange={(e) => setAuthHeader(e.target.checked)}
              disabled={busy}
            />
            <span>发送 Authorization: Bearer 请求头（OpenAI 兼容端点推荐开启）</span>
          </label>
        </div>

        <div className="settings-modal-foot">
          {isEdit && onDelete ? (
            <button
              type="button"
              className="settings-modal-btn settings-modal-btn--danger"
              disabled={busy}
              onClick={() => void handleDelete()}
            >
              {deleting ? "删除中…" : confirmDelete ? "确认删除供应商？" : "删除供应商"}
            </button>
          ) : null}
          <span className="settings-modal-spacer" />
          <button type="button" className="settings-modal-btn settings-modal-btn--ghost" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" className="settings-modal-btn settings-modal-btn--primary" disabled={busy}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </SettingsModal>
  )
}

/* ------------------------------------------------------------------ */
/* 2. 模型配置弹窗                                                      */
/* ------------------------------------------------------------------ */

export interface ModelConfigModalProps {
  open: boolean
  providerId: string
  providerLabel?: string
  initialModel?: ModelConfigModel | null
  onClose: () => void
  onSave: (payload: UpsertModelPayload) => Promise<void>
  onDelete?: (providerId: string, modelId: string) => Promise<void>
}

export function ModelConfigModal({
  open,
  providerId,
  providerLabel,
  initialModel,
  onClose,
  onSave,
  onDelete,
}: ModelConfigModalProps) {
  const isEdit = Boolean(initialModel)
  const [id, setId] = useState("")
  const [name, setName] = useState("")
  const [api, setApi] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [reasoning, setReasoning] = useState(false)
  const [supportsImage, setSupportsImage] = useState(false)
  const [contextWindow, setContextWindow] = useState("")
  const [maxTokens, setMaxTokens] = useState("")
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setId(initialModel?.id ?? "")
    setName(initialModel?.name && initialModel.name !== initialModel.id ? initialModel.name : "")
    setApi(initialModel?.api ?? "")
    setBaseUrl(initialModel?.baseUrl ?? "")
    setReasoning(Boolean(initialModel?.reasoning))
    setSupportsImage(Array.isArray(initialModel?.input) ? initialModel.input.includes("image") : false)
    setContextWindow(typeof initialModel?.contextWindow === "number" ? String(initialModel.contextWindow) : "")
    setMaxTokens(typeof initialModel?.maxTokens === "number" ? String(initialModel.maxTokens) : "")
    setSaving(false)
    setDeleting(false)
    setConfirmDelete(false)
    setError(null)
  }, [open, initialModel, providerId])

  const busy = saving || deleting
  const extraApi = initialModel?.api && !API_TYPE_OPTIONS.some((item) => item.value === initialModel.api)
    ? initialModel.api
    : null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const trimmedId = id.trim()
    if (!trimmedId) {
      setError("请填写模型 ID")
      return
    }
    if (/\s/.test(trimmedId)) {
      setError("模型 ID 不能包含空格")
      return
    }
    const trimmedBaseUrl = baseUrl.trim()
    if (trimmedBaseUrl && !isValidHttpUrl(trimmedBaseUrl)) {
      setError("接口地址需为完整的 http:// 或 https:// URL")
      return
    }
    let parsedCw: number | undefined
    if (contextWindow.trim()) {
      const n = Number(contextWindow.trim())
      if (!Number.isSafeInteger(n) || n <= 0 || n > 10_000_000) {
        setError("上下文窗口需为正整数（1 - 10,000,000）")
        return
      }
      parsedCw = n
    }
    let parsedMt: number | undefined
    if (maxTokens.trim()) {
      const n = Number(maxTokens.trim())
      if (!Number.isSafeInteger(n) || n <= 0 || n > 2_000_000) {
        setError("最大输出 Token 需为正整数（1 - 2,000,000）")
        return
      }
      parsedMt = n
    }
    const inputModalities = supportsImage ? ["text", "image"] : ["text"]
    setError(null)
    setSaving(true)
    try {
      await onSave({
        provider: providerId,
        ...(isEdit && initialModel ? { originalId: initialModel.id } : {}),
        model: {
          id: trimmedId,
          ...(isEdit
            ? {
                name: name.trim(),
                api,
                baseUrl: trimmedBaseUrl,
                contextWindow: parsedCw ?? null,
                maxTokens: parsedMt ?? null,
              }
            : {
                ...(name.trim() ? { name: name.trim() } : {}),
                ...(api ? { api } : {}),
                ...(trimmedBaseUrl ? { baseUrl: trimmedBaseUrl } : {}),
                ...(parsedCw !== undefined ? { contextWindow: parsedCw } : {}),
                ...(parsedMt !== undefined ? { maxTokens: parsedMt } : {}),
              }),
          reasoning,
          input: inputModalities,
        },
      })
      onClose()
    } catch (err) {
      setError(errorMessageOf(err))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!onDelete || !initialModel || busy) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setError(null)
    setDeleting(true)
    try {
      await onDelete(providerId, initialModel.id)
      onClose()
    } catch (err) {
      setError(errorMessageOf(err))
      setConfirmDelete(false)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <SettingsModal
      open={open}
      title={isEdit ? `编辑模型 · ${initialModel?.id}` : "添加模型"}
      subtitle={`所属供应商：${providerLabel || providerId}`}
      busy={busy}
      onClose={onClose}
    >
      <form className="settings-modal-form" noValidate onSubmit={(e) => void submit(e)}>
        <div className="settings-modal-body">
          {error ? (
            <div className="settings-modal-error" role="alert">
              {error}
            </div>
          ) : null}

          <label className="settings-modal-field">
            <span className="settings-modal-label">模型 ID *</span>
            <input
              type="text"
              className="settings-modal-input settings-modal-mono"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="例如 deepseek-chat、gpt-4o"
              readOnly={isEdit}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className="settings-modal-field">
            <span className="settings-modal-label">显示名称（可选）</span>
            <input
              type="text"
              className="settings-modal-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="留空则显示模型 ID"
              disabled={busy}
            />
          </label>

          <label className="settings-modal-field">
            <span className="settings-modal-label">接口协议（可选覆盖）</span>
            <select
              className="settings-modal-select"
              value={api}
              onChange={(e) => setApi(e.target.value)}
              disabled={busy}
            >
              <option value="">继承供应商默认</option>
              {extraApi ? <option value={extraApi}>{extraApi}</option> : null}
              {API_TYPE_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-modal-field">
            <span className="settings-modal-label">接口地址 Base URL（可选覆盖）</span>
            <input
              type="url"
              className="settings-modal-input settings-modal-mono"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="留空继承供应商地址，例如 https://39api.cn"
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <div className="settings-modal-row2">
            <label className="settings-modal-field">
              <span className="settings-modal-label">上下文窗口（可选）</span>
              <input
                type="number"
                min={1}
                step={1}
                className="settings-modal-input settings-modal-mono"
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value)}
                placeholder="例如 128000"
                disabled={busy}
              />
            </label>
            <label className="settings-modal-field">
              <span className="settings-modal-label">最大输出 Token（可选）</span>
              <input
                type="number"
                min={1}
                step={1}
                className="settings-modal-input settings-modal-mono"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                placeholder="例如 8192"
                disabled={busy}
              />
            </label>
          </div>

          <label className="settings-modal-check">
            <input
              type="checkbox"
              checked={reasoning}
              onChange={(e) => setReasoning(e.target.checked)}
              disabled={busy}
            />
            <span>支持推理 / Thinking 模式</span>
          </label>

          <label className="settings-modal-check">
            <input
              type="checkbox"
              checked={supportsImage}
              onChange={(e) => setSupportsImage(e.target.checked)}
              disabled={busy}
            />
            <span>支持图片输入（Vision）</span>
          </label>
        </div>

        <div className="settings-modal-foot">
          {isEdit && onDelete ? (
            <button
              type="button"
              className="settings-modal-btn settings-modal-btn--danger"
              disabled={busy}
              onClick={() => void handleDelete()}
            >
              {deleting ? "删除中…" : confirmDelete ? "确认删除模型？" : "删除模型"}
            </button>
          ) : null}
          <span className="settings-modal-spacer" />
          <button type="button" className="settings-modal-btn settings-modal-btn--ghost" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" className="settings-modal-btn settings-modal-btn--primary" disabled={busy}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </SettingsModal>
  )
}

/* ------------------------------------------------------------------ */
/* 3. MCP 服务器配置弹窗                                                */
/* ------------------------------------------------------------------ */

export interface McpServerModalProps {
  open: boolean
  initialServer?: McpConfigServer | null
  onClose: () => void
  onSave: (payload: UpsertMcpServerPayload) => Promise<void>
  onDelete?: (name: string) => Promise<void>
}

function normalizeTransport(raw?: string): "stdio" | "http" | "sse" {
  const lower = (raw ?? "").trim().toLowerCase()
  if (lower === "http" || lower === "sse") return lower
  return "stdio"
}

function normalizeExposure(raw?: string): "codemode" | "deferred" | "direct" | "hidden" {
  const lower = (raw ?? "").trim().toLowerCase()
  if (lower === "deferred" || lower === "direct" || lower === "hidden") return lower
  return "codemode"
}

export function McpServerModal({ open, initialServer, onClose, onSave, onDelete }: McpServerModalProps) {
  const isEdit = Boolean(initialServer)
  const [name, setName] = useState("")
  const [transport, setTransport] = useState<"stdio" | "http" | "sse">("stdio")
  const [command, setCommand] = useState("")
  const [argsText, setArgsText] = useState("")
  const [url, setUrl] = useState("")
  const [exposure, setExposure] = useState<"codemode" | "deferred" | "direct" | "hidden">("codemode")
  const [timeout, setTimeout] = useState("")
  const [description, setDescription] = useState("")
  const [envText, setEnvText] = useState("")
  const [clearEnv, setClearEnv] = useState(false)
  const [headersText, setHeadersText] = useState("")
  const [clearHeaders, setClearHeaders] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(initialServer?.name ?? "")
    setTransport(normalizeTransport(initialServer?.transport))
    setCommand(initialServer?.command ?? "")
    setArgsText(formatCommandArgs(initialServer?.args))
    setUrl(initialServer?.url ?? "")
    setExposure(normalizeExposure(initialServer?.exposure))
    setTimeout(typeof initialServer?.timeout === "number" ? String(initialServer.timeout) : "")
    setDescription(initialServer?.description ?? "")
    setEnvText("")
    setClearEnv(false)
    setHeadersText("")
    setClearHeaders(false)
    setEnabled(initialServer ? initialServer.enabled : true)
    setSaving(false)
    setDeleting(false)
    setConfirmDelete(false)
    setError(null)
  }, [open, initialServer])

  const busy = saving || deleting

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError("请填写服务器名称")
      return
    }
    if (/\s/.test(trimmedName)) {
      setError("服务器名称不能包含空格")
      return
    }

    let parsedTimeout: number | undefined
    if (timeout.trim()) {
      const n = Number(timeout.trim())
      if (!Number.isSafeInteger(n) || n <= 0 || n > 600_000) {
        setError("超时时间需为正整数（1 - 600,000 毫秒）")
        return
      }
      parsedTimeout = n
    }

    if (transport === "stdio") {
      const trimmedCmd = command.trim()
      if (!trimmedCmd) {
        setError("stdio 传输需填写启动命令")
        return
      }
      const envParsed = parseEnvLines(envText)
      if (!envParsed.ok) {
        setError(envParsed.error)
        return
      }
      const parsedArgs = splitCommandArgs(argsText)
      setError(null)
      setSaving(true)
      try {
        await onSave({
          name: trimmedName,
          ...(isEdit && initialServer && initialServer.name !== trimmedName ? { originalName: initialServer.name } : {}),
          transport: "stdio",
          command: trimmedCmd,
          args: parsedArgs.length > 0 ? parsedArgs : isEdit ? null : [],
          enabled,
          exposure,
          ...(isEdit
            ? { description: description.trim(), timeout: parsedTimeout ?? null }
            : {
                ...(description.trim() ? { description: description.trim() } : {}),
                ...(parsedTimeout !== undefined ? { timeout: parsedTimeout } : {}),
              }),
          ...(Object.keys(envParsed.value).length > 0 ? { env: envParsed.value } : clearEnv ? { clearEnv: true } : {}),
        })
        onClose()
      } catch (err) {
        setError(errorMessageOf(err))
      } finally {
        setSaving(false)
      }
      return
    }

    const trimmedUrl = url.trim()
    if (!trimmedUrl || !isValidHttpUrl(trimmedUrl)) {
      setError("请填写以 http:// 或 https:// 开头的服务器地址")
      return
    }
    const keepRedactedUrl = isEdit && Boolean(initialServer?.hasUrlQuery) && trimmedUrl === (initialServer?.url ?? "").trim()
    const headersParsed = parseHeaderLines(headersText)
    if (!headersParsed.ok) {
      setError(headersParsed.error)
      return
    }
    setError(null)
    setSaving(true)
    try {
      await onSave({
        name: trimmedName,
        ...(isEdit && initialServer && initialServer.name !== trimmedName ? { originalName: initialServer.name } : {}),
        transport,
        ...(keepRedactedUrl ? {} : { url: trimmedUrl }),
        enabled,
        exposure,
        ...(isEdit
          ? { description: description.trim(), timeout: parsedTimeout ?? null }
          : {
              ...(description.trim() ? { description: description.trim() } : {}),
              ...(parsedTimeout !== undefined ? { timeout: parsedTimeout } : {}),
            }),
        ...(Object.keys(headersParsed.value).length > 0
          ? { headers: headersParsed.value }
          : clearHeaders
            ? { clearHeaders: true }
            : {}),
      })
      onClose()
    } catch (err) {
      setError(errorMessageOf(err))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!onDelete || !initialServer || busy) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setError(null)
    setDeleting(true)
    try {
      await onDelete(initialServer.name)
      onClose()
    } catch (err) {
      setError(errorMessageOf(err))
      setConfirmDelete(false)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <SettingsModal
      open={open}
      title={isEdit ? `配置 MCP 服务器 · ${initialServer?.name}` : "添加 MCP 服务器"}
      subtitle="写入所连设备的 mcp.json；保存后新建会话或重连生效。"
      busy={busy}
      onClose={onClose}
    >
      <form className="settings-modal-form" noValidate onSubmit={(e) => void submit(e)}>
        <div className="settings-modal-body">
          {error ? (
            <div className="settings-modal-error" role="alert">
              {error}
            </div>
          ) : null}

          <div className="settings-modal-row2">
            <label className="settings-modal-field">
              <span className="settings-modal-label">服务器名称 *</span>
              <input
                type="text"
                className="settings-modal-input settings-modal-mono"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如 filesystem、github"
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="settings-modal-field">
              <span className="settings-modal-label">传输方式</span>
              <select
                className="settings-modal-select"
                value={transport}
                onChange={(e) => setTransport(normalizeTransport(e.target.value))}
                disabled={busy}
              >
                {MCP_TRANSPORT_OPTIONS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {transport === "stdio" ? (
            <>
              <label className="settings-modal-field">
                <span className="settings-modal-label">启动命令 *</span>
                <input
                  type="text"
                  className="settings-modal-input settings-modal-mono"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="例如 npx、uvx、node"
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>

              <label className="settings-modal-field">
                <span className="settings-modal-label">命令参数（空格分隔，支持引号）</span>
                <input
                  type="text"
                  className="settings-modal-input settings-modal-mono"
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder="例如 -y @modelcontextprotocol/server-filesystem /path"
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>

              <label className="settings-modal-field">
                <span className="settings-modal-label">环境变量（每行 KEY=VALUE，可选）</span>
                <textarea
                  rows={2}
                  className="settings-modal-textarea settings-modal-mono"
                  value={envText}
                  onChange={(e) => {
                    setEnvText(e.target.value)
                    if (e.target.value.trim()) setClearEnv(false)
                  }}
                  placeholder={
                    initialServer?.envKeys?.length
                      ? `已配置键：${initialServer.envKeys.join(", ")}（留空保持不变）`
                      : "API_TOKEN=..."
                  }
                  disabled={busy}
                />
              </label>
              {initialServer?.envKeys?.length ? (
                <label className="settings-modal-check">
                  <input
                    type="checkbox"
                    checked={clearEnv}
                    onChange={(e) => setClearEnv(e.target.checked)}
                    disabled={busy || envText.trim().length > 0}
                  />
                  <span>清除已有环境变量（{initialServer.envKeys.join(", ")}）</span>
                </label>
              ) : null}
            </>
          ) : (
            <>
              <label className="settings-modal-field">
                <span className="settings-modal-label">服务器 URL *</span>
                <input
                  type="url"
                  className="settings-modal-input settings-modal-mono"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/mcp"
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                />
                {isEdit && initialServer?.hasUrlQuery && url.trim() === (initialServer.url ?? "").trim() ? (
                  <span className="settings-modal-hint">当前 URL 含已脱敏的查询参数；不改动此项将保留原完整地址。</span>
                ) : null}
              </label>

              <label className="settings-modal-field">
                <span className="settings-modal-label">请求头（每行 Name: Value，可选）</span>
                <textarea
                  rows={2}
                  className="settings-modal-textarea settings-modal-mono"
                  value={headersText}
                  onChange={(e) => {
                    setHeadersText(e.target.value)
                    if (e.target.value.trim()) setClearHeaders(false)
                  }}
                  placeholder={
                    initialServer?.headerKeys?.length
                      ? `已配置请求头：${initialServer.headerKeys.join(", ")}（留空保持不变）`
                      : "Authorization: Bearer ..."
                  }
                  disabled={busy}
                />
              </label>
              {initialServer?.headerKeys?.length ? (
                <label className="settings-modal-check">
                  <input
                    type="checkbox"
                    checked={clearHeaders}
                    onChange={(e) => setClearHeaders(e.target.checked)}
                    disabled={busy || headersText.trim().length > 0}
                  />
                  <span>清除已有请求头（{initialServer.headerKeys.join(", ")}）</span>
                </label>
              ) : null}
            </>
          )}

          <div className="settings-modal-row2">
            <label className="settings-modal-field">
              <span className="settings-modal-label">工具曝光档</span>
              <select
                className="settings-modal-select"
                value={exposure}
                onChange={(e) => setExposure(normalizeExposure(e.target.value))}
                disabled={busy}
              >
                {MCP_EXPOSURE_OPTIONS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-modal-field">
              <span className="settings-modal-label">超时（毫秒，可选）</span>
              <input
                type="number"
                min={1}
                step={1}
                className="settings-modal-input settings-modal-mono"
                value={timeout}
                onChange={(e) => setTimeout(e.target.value)}
                placeholder="例如 30000"
                disabled={busy}
              />
            </label>
          </div>

          <label className="settings-modal-field">
            <span className="settings-modal-label">说明（可选）</span>
            <input
              type="text"
              className="settings-modal-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="用途备注"
              disabled={busy}
            />
          </label>

          <label className="settings-modal-check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={busy}
            />
            <span>保存后启用此服务器</span>
          </label>
        </div>

        <div className="settings-modal-foot">
          {isEdit && onDelete ? (
            <button
              type="button"
              className="settings-modal-btn settings-modal-btn--danger"
              disabled={busy}
              onClick={() => void handleDelete()}
            >
              {deleting ? "删除中…" : confirmDelete ? "确认删除服务器？" : "删除服务器"}
            </button>
          ) : null}
          <span className="settings-modal-spacer" />
          <button type="button" className="settings-modal-btn settings-modal-btn--ghost" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" className="settings-modal-btn settings-modal-btn--primary" disabled={busy}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </SettingsModal>
  )
}
