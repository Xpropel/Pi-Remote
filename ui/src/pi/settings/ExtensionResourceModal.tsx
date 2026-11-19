/**
 * 添加资源弹窗：用于设置 › 扩展（添加技能 / 提示词模板 / 扩展 / Pi 包）。
 * 复用 SettingsModal 与 `.settings-modal-*` 样式，不引入任何色值字面量。
 */
import { useEffect, useState, type FormEvent } from "react"
import { SettingsModal } from "./ConfigModals.tsx"
import type { ExtensionResourceKind } from "./pages/extensionsLogic.ts"

const RESOURCE_META: Record<
  ExtensionResourceKind,
  {
    title: string
    subtitle: string
    fieldLabel: string
    placeholder: string
    hint: string
    emptyError: string
  }
> = {
  skill: {
    title: "添加技能",
    subtitle: "写入设备 settings.json 的 skills 清单",
    fieldLabel: "技能路径或匹配规则 *",
    placeholder: "~/.pi/skills/my-skill 或 ./skills/review",
    hint: "支持本地目录、SKILL.md 文件路径或 glob 匹配模式。",
    emptyError: "请输入技能路径或匹配规则",
  },
  prompt: {
    title: "添加模板",
    subtitle: "写入设备 settings.json 的 prompts 清单",
    fieldLabel: "模板路径或匹配规则 *",
    placeholder: "~/.pi/prompts/review.md",
    hint: "模板文件名即斜杠命令名，支持 .md 文件、目录或 glob 模式。",
    emptyError: "请输入模板路径或匹配规则",
  },
  extension: {
    title: "添加扩展",
    subtitle: "写入设备 settings.json 的 extensions 清单",
    fieldLabel: "扩展路径或来源 *",
    placeholder: "~/.pi/extensions/my-ext.ts 或 npm:@scope/pi-ext",
    hint: "扩展拥有完整系统权限，请仅添加可信来源。",
    emptyError: "请输入扩展路径或来源",
  },
  package: {
    title: "添加 Pi 包",
    subtitle: "写入设备 settings.json 的 packages 清单",
    fieldLabel: "包来源（npm / git / 本地路径）*",
    placeholder: "npm:@scope/pi-package 或 git:https://github.com/...",
    hint: "整包导入扩展、技能与模板，保存后重启 pi 安装并生效。",
    emptyError: "请输入包来源（npm: / git: / 本地路径）",
  },
}

function validateResourceInput(raw: string, emptyError: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw.trim()
  if (!value) return { ok: false, error: emptyError }
  if (value.length > 400) return { ok: false, error: "路径或来源过长（最多 400 个字符）" }
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return { ok: false, error: "不能包含换行或控制字符" }
  }
  return { ok: true, value }
}

export interface ExtensionResourceModalProps {
  open: boolean
  kind: ExtensionResourceKind | null
  onClose: () => void
  onAdd: (kind: ExtensionResourceKind, source: string) => Promise<boolean | void> | boolean | void
}

export function ExtensionResourceModal({ open, kind, onClose, onAdd }: ExtensionResourceModalProps) {
  const [source, setSource] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setSource("")
    setError(null)
    setSaving(false)
  }, [open, kind])

  const meta = kind ? RESOURCE_META[kind] : RESOURCE_META.extension

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!kind || saving) return
    const checked = validateResourceInput(source, meta.emptyError)
    if (!checked.ok) {
      setError(checked.error)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const ok = await onAdd(kind, checked.value)
      if (ok !== false) onClose()
    } catch (err: unknown) {
      setError(err instanceof Error && err.message ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsModal open={open && kind !== null} title={meta.title} subtitle={meta.subtitle} busy={saving} onClose={onClose}>
      <form className="settings-modal-form" noValidate onSubmit={(event) => void submit(event)}>
        <div className="settings-modal-body">
          {error ? (
            <div className="settings-modal-error" role="alert">
              {error}
            </div>
          ) : null}

          <label className="settings-modal-field">
            <span className="settings-modal-label">{meta.fieldLabel}</span>
            <input
              type="text"
              className="settings-modal-input settings-modal-mono"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              placeholder={meta.placeholder}
              disabled={saving}
            />
            <span className="settings-modal-hint">{meta.hint}</span>
          </label>
        </div>

        <div className="settings-modal-foot">
          <span className="settings-modal-spacer" />
          <button type="button" className="settings-modal-btn settings-modal-btn--ghost" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button type="submit" className="settings-modal-btn settings-modal-btn--primary" disabled={saving}>
            {saving ? "保存中…" : "添加"}
          </button>
        </div>
      </form>
    </SettingsModal>
  )
}
