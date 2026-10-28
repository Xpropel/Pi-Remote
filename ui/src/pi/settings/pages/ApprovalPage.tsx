/**
 * 设置 › 审批与执行（设计册第 5 节，v3 定稿）。
 *
 * 口径（设计册 §5 引文，页首口径框逐字呈现）：
 *   pi 没有 Codex 式权限档位。「何时询问 / 能碰什么 / 高危解锁 / 免审名单」是设计预留 ◌，
 *   只保留形态、写不进去；本页真正有代码依据的只有「项目信任」（默认策略可写、当前项目状态只读）与「可用工具」（●）。
 *
 * 落地状态：
 *   ◌ 何时询问、能碰什么、高危解锁、免审命令名单：不可用形态 + 组级「设计预留」徽标；
 *   ● 项目信任默认：经 settings_set 写 defaultProjectTrust（先询问 / 总是信任 / 从不信任）；
 *     当前项目信任状态仍读 get_state.projectTrusted，两者分开显示；
 *   ● 可用工具：get_active_tools + get_all_tools 读、set_active_tools 写，改完即存，
 *     **作用域 = 当前会话**（不是持久默认）。
 *
 * 本页没有 ○ 本机项：不写 localStorage、不调 act.setPref。
 * 设计稿里这几组是「整组一项」，所以状态徽标挂在组标题上（组内每行不再重复挂徽标）。
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from "react"
import { Info } from "lucide-react"
import { commandErrorText, commandsReady, useRelayCommand } from "@/pi/containers/cShared"
import { useSettings } from "../SettingsContext"
import { settingsItemInert } from "../types"
import {
  APPROVAL_ALLOWLIST,
  APPROVAL_ALLOWLIST_NOTE,
  APPROVAL_ASK_DEFAULT,
  APPROVAL_ASK_OPTIONS,
  APPROVAL_BRIEF,
  APPROVAL_NETWORK_DESCRIPTION,
  APPROVAL_NETWORK_LABEL,
  APPROVAL_SCOPE_DEFAULT,
  APPROVAL_SCOPE_OPTIONS,
  APPROVAL_SEARCH_DEFAULT,
  APPROVAL_SEARCH_OPTIONS,
  APPROVAL_TOOLS_EMPTY_HINT,
  APPROVAL_TOOLS_NOTE,
  APPROVAL_TRUST_NOTE,
  APPROVAL_TRUST_OPTIONS,
  APPROVAL_TRUST_STATE_LABELS,
  APPROVAL_UNLOCK_DESCRIPTION,
  APPROVAL_UNLOCK_LABEL,
  approvalToolRowsOf,
  projectTrustOf,
  toggledToolSet,
  toolsFromResponse,
  type ApprovalToolRow,
} from "./approvalData"
import { defaultProjectTrustPatch, effectiveProjectTrustOf } from "./settingsWrite.ts"
import { readOnlyHintOf, useSettingsDocument, useSettingsWriter } from "./settingsWriteHooks.ts"
import { SettingsWriteNote } from "./settingsWriteFeedback.tsx"
import {
  SettingsActionRow,
  SettingsInlineRadio,
  SettingsNote,
  SettingsPageTitle,
  SettingsRow,
  SettingsStatusBadge,
  SettingsSwitch,
} from "../ui"

const MONO: CSSProperties = { fontFamily: "var(--st-font-mono)", fontSize: 12.5, letterSpacing: "0.01em" }

const BRIEF_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  marginTop: 14,
  padding: "10px 14px",
  border: "1px solid var(--st-border)",
  borderRadius: "var(--st-radius-card)",
  background: "var(--st-tile-bg)",
  color: "var(--st-text-3)",
  fontSize: 11.5,
  lineHeight: 1.55,
}

const BRIEF_ICON_STYLE: CSSProperties = { flex: "none", marginTop: 2, color: "var(--st-text-4)" }

/** 组标题带状态徽标（SettingsGroup 不支持徽标；这里用同一套 class 局部实现）。 */
function ApprovalGroup({
  label,
  status,
  first = false,
  note,
  children,
}: {
  label: string
  status?: "bridge" | "reserved"
  first?: boolean
  note?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={first ? "settings-group settings-group--first" : "settings-group"}>
      <h2 className="settings-group-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span>{label}</span>
        <SettingsStatusBadge status={status} />
      </h2>
      <div className="settings-card">{children}</div>
      {note ? <p className="settings-group-description">{note}</p> : null}
    </section>
  )
}

interface ChoiceOption {
  value: string
  label: string
  description?: string
  note?: string
  warn?: boolean
}

/**
 * 带说明的纵排单选（设计稿 .ropt.d）。整组是 ◐ / ◌ 时由 status 统一降级；
 * 复用 .settings-radio / .settings-radio-ring，只在本页补多行排版。
 */
function ChoiceGroup({
  label,
  status,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  status?: "bridge" | "reserved"
  value: string
  options: readonly ChoiceOption[]
  onChange?: (value: string) => void
  disabled?: boolean
}) {
  const inert = settingsItemInert(status, disabled)
  return (
    <div
      className="settings-row settings-row--stack"
      data-settings-status={status}
      data-settings-inert={inert ? "true" : undefined}
      aria-disabled={inert || undefined}
    >
      <div className="settings-radio-group" role="radiogroup" aria-label={label} inert={inert || undefined}>
        {options.map((option) => {
          const on = option.value === value
          const multiline = Boolean(option.description || option.note)
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={inert}
              className={on ? "settings-radio is-on" : "settings-radio"}
              onClick={() => {
                if (!inert) onChange?.(option.value)
              }}
              style={
                multiline
                  ? { alignItems: "flex-start", height: "auto", marginTop: 6, whiteSpace: "normal" }
                  : undefined
              }
            >
              <span
                className="settings-radio-ring"
                style={multiline ? { marginTop: 2 } : undefined}
                aria-hidden="true"
              />
              <span style={{ display: "block", minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13, lineHeight: 1.35 }}>{option.label}</span>
                {option.description ? <span className="settings-row-description">{option.description}</span> : null}
                {option.note ? (
                  <span
                    className="settings-row-description"
                    style={option.warn ? { color: "var(--st-wait)" } : undefined}
                  >
                    {option.note}
                  </span>
                ) : null}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** 行尾弱签（设计稿 .tag：「默认关」）。 */
function TagChip({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        display: "inline-block",
        marginLeft: 7,
        padding: "0 5px",
        height: 16,
        lineHeight: "15px",
        fontSize: 10.5,
        fontWeight: 400,
        color: "var(--st-text-4)",
        border: "1px solid var(--st-border)",
        borderRadius: 5,
        verticalAlign: "2px",
      }}
    >
      {children}
    </span>
  )
}

function ToolTitle({ row }: { row: ApprovalToolRow }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
      <span>{row.label}</span>
      {row.mono ? <span style={{ ...MONO, marginLeft: 6 }}>{row.displayName}</span> : null}
      {row.note ? <TagChip>{row.note}</TagChip> : null}
    </span>
  )
}

export function ApprovalPage() {
  const { p, act } = useSettings()
  const { relay } = p
  const ready = commandsReady(relay) && relay.browserOnline
  const roomKey = relay.roomId ?? ""
  const settingsDoc = useSettingsDocument(relay)
  const writer = useSettingsWriter(relay)
  const activeQuery = useRelayCommand(relay.runCommand, ready ? "get_active_tools" : null, undefined, roomKey)
  const allQuery = useRelayCommand(relay.runCommand, ready ? "get_all_tools" : null, undefined, roomKey)
  const stateQuery = useRelayCommand(relay.runCommand, ready ? "get_state" : null, undefined, roomKey)

  const toolView = useMemo(() => approvalToolRowsOf(activeQuery.data, allQuery.data), [activeQuery.data, allQuery.data])
  const trust = projectTrustOf(stateQuery.data)
  // 两条只读命令都拿到才算读全：注册表没读到时不冒充「未注册」，也不做半套写入。
  const registryReady = allQuery.phase === "ready"
  const canEdit = ready && activeQuery.phase === "ready" && registryReady

  // 即时生效：先乐观更新，写失败回滚并提示；键不变 = 同一份主机清单。
  const [pending, setPending] = useState<{ key: string; tools: string[] } | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const toolsKey = `${roomKey}|${toolView.enabled.join(",")}`
  const enabled = pending?.key === toolsKey ? pending.tools : toolView.enabled

  const toggleTool = (row: ApprovalToolRow) => {
    if (!row.toolName || !canEdit || saving) return
    const name = row.toolName
    const next = toggledToolSet(enabled, name, !enabled.includes(name))
    setPending({ key: toolsKey, tools: next })
    setSaving(row.id)
    relay.runCommand("set_active_tools", { tools: next }).then(
      (data) => {
        setPending({ key: toolsKey, tools: toolsFromResponse(data, next) })
        setSaving(null)
      },
      (error: unknown) => {
        setPending(null)
        setSaving(null)
        act.notify(`保存失败：${commandErrorText(error)}`, "bad")
      },
    )
  }

  const defaultTrust = effectiveProjectTrustOf(settingsDoc.data, writer.applied)
  const defaultTrustLabel = APPROVAL_TRUST_OPTIONS.find((option) => option.value === defaultTrust)?.label ?? "未知"
  const writeHint = readOnlyHintOf(settingsDoc, writer)
  const trustWriteDisabled = !writer.canWrite || settingsDoc.phase !== "ready" || writer.saving !== null
  const trustNote = `当前项目：${APPROVAL_TRUST_STATE_LABELS[trust]} · 新项目默认策略：${defaultTrustLabel} · ${APPROVAL_TRUST_NOTE}`

  return (
    <div className="settings-page" data-settings-page="approval">
      <SettingsPageTitle title="审批与执行" />

      {/* 口径框：如实说明本页哪些是真机制、哪些只是设计预留 */}
      <div style={BRIEF_STYLE} role="note" data-settings-brief="">
        <Info size={13} strokeWidth={1.8} aria-hidden="true" style={BRIEF_ICON_STYLE} />
        <span>{APPROVAL_BRIEF}</span>
      </div>

      {/* ◌ 何时询问 */}
      <ApprovalGroup label="何时询问" status="reserved" first>
        <ChoiceGroup
          label="何时询问"
          status="reserved"
          value={APPROVAL_ASK_DEFAULT}
          options={APPROVAL_ASK_OPTIONS}
        />
      </ApprovalGroup>

      {/* ● 项目信任默认策略（写 defaultProjectTrust）；当前项目状态仍只读 */}
      <ApprovalGroup label="项目信任" note={trustNote}>
        <ChoiceGroup
          label="项目信任"
          value={defaultTrust ?? ""}
          options={APPROVAL_TRUST_OPTIONS}
          disabled={trustWriteDisabled}
          onChange={(value) => {
            void writer.save("defaultProjectTrust", defaultProjectTrustPatch(value))
          }}
        />
      </ApprovalGroup>
      <SettingsWriteNote feedback={writer.feedback} fallback={writeHint} />

      {/* ◌ 能碰什么 */}
      <ApprovalGroup label="能碰什么" status="reserved">
        <ChoiceGroup
          label="能碰什么"
          status="reserved"
          value={APPROVAL_SCOPE_DEFAULT}
          options={APPROVAL_SCOPE_OPTIONS}
        />
        <SettingsRow title={APPROVAL_NETWORK_LABEL} description={APPROVAL_NETWORK_DESCRIPTION}>
          <SettingsSwitch label={`${APPROVAL_NETWORK_LABEL}（设计预留）`} checked={false} disabled />
        </SettingsRow>
        <SettingsInlineRadio
          label="网页搜索"
          value={APPROVAL_SEARCH_DEFAULT}
          options={APPROVAL_SEARCH_OPTIONS}
          disabled
        />
      </ApprovalGroup>

      {/* ◌ 高危解锁 */}
      <ApprovalGroup label="高危解锁" status="reserved">
        <SettingsRow title={APPROVAL_UNLOCK_LABEL} description={APPROVAL_UNLOCK_DESCRIPTION}>
          <SettingsSwitch label={`${APPROVAL_UNLOCK_LABEL}（设计预留）`} checked={false} disabled />
        </SettingsRow>
      </ApprovalGroup>

      {/* ◌ 免审命令名单 */}
      <ApprovalGroup label="免审命令名单" status="reserved" note={APPROVAL_ALLOWLIST_NOTE}>
        {APPROVAL_ALLOWLIST.map((command) => (
          <SettingsRow key={command} title={<span style={MONO}>{command}</span>}>
            <span aria-hidden="true" style={{ padding: "0 2px", color: "var(--st-text-5)", fontSize: 16, lineHeight: 1 }}>
              ×
            </span>
          </SettingsRow>
        ))}
        <SettingsActionRow title="添加命令" disabled />
      </ApprovalGroup>

      {/* ● 可用工具：作用域 = 当前会话，改完即存 */}
      <ApprovalGroup label="可用工具">
        {toolView.rows.map((row) => {
          const on = row.toolName !== null && enabled.includes(row.toolName)
          const lock = !canEdit || saving !== null || !row.available
          return (
            <SettingsRow
              key={row.id}
              title={<ToolTitle row={row} />}
              description={!canEdit || row.available ? undefined : "本机未注册这个工具"}
            >
              <SettingsSwitch
                label={`${row.label}（当前会话）`}
                checked={on}
                disabled={lock}
                onChange={() => toggleTool(row)}
              />
            </SettingsRow>
          )
        })}
      </ApprovalGroup>
      {canEdit ? null : <SettingsNote>{APPROVAL_TOOLS_EMPTY_HINT}</SettingsNote>}
      <SettingsNote>{APPROVAL_TOOLS_NOTE}</SettingsNote>
      <SettingsNote>
        仍只读：何时询问 / 能碰什么 / 高危解锁 / 免审命令名单没有对应的 pi 设置字段（设计预留），写桥只开放了「项目信任默认」。
      </SettingsNote>
    </div>
  )
}
