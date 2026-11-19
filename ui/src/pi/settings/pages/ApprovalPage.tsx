/**
 * 设置 › 审批与执行（设计册第 5 节，v3 定稿）。
 *
 * 落地状态：
 *   ● 何时询问 / 能碰什么（活动范围）/ 高危解锁 / 免审命令名单：实时同步到当前会话（set_approval_policy）；
 *   ● 项目信任默认：经 settings_set 写 defaultProjectTrust（先询问 / 总是信任 / 从不信任）；
 *     当前项目信任状态读 get_state.projectTrusted，两者分开显示；
 *   ● 可用工具：get_active_tools + get_all_tools 读、set_active_tools 写，改完即存，
 *     **作用域 = 当前会话**；无会话时可写设备默认 defaultTools。
 */
import { useMemo, useState, type ReactNode } from "react"
import { X } from "lucide-react"
import { commandErrorText, commandsReady, usePrefsWriter, useRelayCommand, useSettingsPrefs } from "@/pi/containers/cShared"
import { switchDisplayStateOf } from "@/pi/model/switchSync"
import { useSettings } from "../SettingsContext"
import { settingsItemInert } from "../types"
import {
  APPROVAL_ASK_OPTIONS,
  APPROVAL_SCOPE_OPTIONS,
  APPROVAL_TOOLS_EMPTY_HINT,
  APPROVAL_TOOLS_NOTE,
  APPROVAL_TRUST_NOTE,
  APPROVAL_TRUST_OPTIONS,
  APPROVAL_TRUST_STATE_LABELS,
  APPROVAL_UNLOCK_LABEL,
  approvalAskModeOf,
  approvalDefaultToolRowsOf,
  approvalToolRowsOf,
  projectTrustOf,
  toggledToolSet,
  toolsFromResponse,
  validateAllowlistCommand,
  type ApprovalToolRow,
} from "./approvalData"
import {
  defaultProjectTrustPatch,
  defaultToolsPatch,
  effectiveProjectTrustOf,
  effectiveSettingsArrayOf,
} from "./settingsWrite.ts"
import { readOnlyHintOf, useSettingsDocument, useSettingsWriter } from "./settingsWriteHooks.ts"
import { SettingsWriteNote } from "./settingsWriteFeedback.tsx"
import {
  SettingsActionRow,
  SettingsHoverTitle,
  SettingsNote,
  SettingsPageTitle,
  SettingsRow,
  SettingsStatusBadge,
  SettingsSwitch,
} from "../ui"

/** 组标题带状态徽标（SettingsGroup 不支持徽标；这里用同一套 class 局部实现）。 */
function ApprovalGroup({
  label,
  tooltip,
  status,
  first = false,
  note,
  children,
}: {
  label: string
  tooltip?: string
  status?: "bridge" | "reserved"
  first?: boolean
  note?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={first ? "settings-group settings-group--first" : "settings-group"}>
      <h2 className="settings-group-label settings-group-label--badge">
        <SettingsHoverTitle tooltip={tooltip}>{label}</SettingsHoverTitle>
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
  disabled?: boolean
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
          const optOff = inert || option.disabled === true
          const multiline = Boolean(option.description || option.note)
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={optOff}
              className={`settings-radio${on ? " is-on" : ""}${multiline ? " settings-radio--multiline" : ""}`}
              onClick={() => {
                if (!optOff) onChange?.(option.value)
              }}
            >
              <span className="settings-radio-ring" aria-hidden="true" />
              <span className="settings-radio-text">
                <span className="settings-radio-title">{option.label}</span>
                {option.description ? <span className="settings-row-description">{option.description}</span> : null}
                {option.note ? (
                  <span className={option.warn ? "settings-row-description settings-radio-warn" : "settings-row-description"}>
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
  return <span className="settings-tag">{children}</span>
}

function ToolTitle({ row }: { row: ApprovalToolRow }) {
  return (
    <span className="settings-inline-title">
      <span>{row.label}</span>
      {row.mono ? <span className="settings-mono">{row.displayName}</span> : null}
      {row.note ? <TagChip>{row.note}</TagChip> : null}
    </span>
  )
}

export function ApprovalPage() {
  const { p, prefs, act } = useSettings()
  const { relay } = p
  const ready = commandsReady(relay) && relay.browserOnline
  const roomKey = relay.roomId ?? ""
  const settingsDoc = useSettingsDocument(relay)
  const writer = useSettingsWriter(relay)
  const conversation = useSettingsPrefs(p)
  const writeConversation = usePrefsWriter(p)
  const switchesPending = relay.switchSyncView.mode === "pending" && Boolean(relay.roomId)
  const identityRequired = switchDisplayStateOf(relay.switchSyncView, relay.viewerIdentity) === "identity-required"
  const activeQuery = useRelayCommand(relay.runCommand, ready ? "get_active_tools" : null, undefined, roomKey)
  const allQuery = useRelayCommand(relay.runCommand, ready ? "get_all_tools" : null, undefined, roomKey)
  const stateQuery = useRelayCommand(relay.runCommand, ready ? "get_state" : null, undefined, roomKey)

  const defaultTools = useMemo(
    () => effectiveSettingsArrayOf(settingsDoc.data, writer.applied, "defaultTools"),
    [settingsDoc.data, writer.applied],
  )
  const registryReady = allQuery.phase === "ready"
  const canEditRoomTools = ready && activeQuery.phase === "ready" && registryReady
  const canEditDefaultTools = !canEditRoomTools && writer.canWrite && settingsDoc.phase === "ready" && writer.saving === null

  const toolView = useMemo(
    () =>
      canEditRoomTools
        ? approvalToolRowsOf(activeQuery.data, allQuery.data)
        : approvalDefaultToolRowsOf(defaultTools),
    [canEditRoomTools, activeQuery.data, allQuery.data, defaultTools],
  )
  const trust = projectTrustOf(stateQuery.data)

  // 即时生效：先乐观更新，写失败回滚并提示；键不变 = 同一份主机清单。
  const [pending, setPending] = useState<{ key: string; tools: string[] } | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [addingCommand, setAddingCommand] = useState(false)
  const [newCommand, setNewCommand] = useState("")
  const [commandError, setCommandError] = useState<string | null>(null)
  const toolsKey = `${roomKey}|${toolView.enabled.join(",")}`
  const enabled = canEditRoomTools && pending?.key === toolsKey ? pending.tools : toolView.enabled

  const askMode = approvalAskModeOf(conversation.approvalGate, prefs.approvalUseAllowlist)
  const askSwitchDisabled = switchesPending || identityRequired
  const askOptions = useMemo(
    () =>
      APPROVAL_ASK_OPTIONS.map((option) => ({
        ...option,
        disabled: option.value === "never" && !prefs.approvalUnlockHighRisk,
      })),
    [prefs.approvalUnlockHighRisk],
  )
  const effectiveScope = prefs.approvalScope === "full" && !prefs.approvalUnlockHighRisk ? "workspace" : prefs.approvalScope
  const scopeOptions = useMemo(
    () =>
      APPROVAL_SCOPE_OPTIONS.map((option) => ({
        ...option,
        disabled: option.value === "full" && !prefs.approvalUnlockHighRisk,
      })),
    [prefs.approvalUnlockHighRisk],
  )

  const handleAskChange = (value: string) => {
    if (askSwitchDisabled) return
    if (value === "ask") {
      act.setPref("approvalUseAllowlist", false)
      if (!conversation.approvalGate) writeConversation({ approvalGate: true })
    } else if (value === "allowlist") {
      act.setPref("approvalUseAllowlist", true)
      if (!conversation.approvalGate) writeConversation({ approvalGate: true })
    } else if (value === "never") {
      if (!prefs.approvalUnlockHighRisk) return
      act.setPref("approvalUseAllowlist", false)
      if (conversation.approvalGate) writeConversation({ approvalGate: false })
    }
  }

  const handleUnlockChange = (checked: boolean) => {
    act.setPref("approvalUnlockHighRisk", checked)
    if (!checked) {
      if (prefs.approvalScope === "full") act.setPref("approvalScope", "workspace")
      if (!conversation.approvalGate && !askSwitchDisabled) writeConversation({ approvalGate: true })
    }
  }

  const submitAddCommand = () => {
    const checked = validateAllowlistCommand(newCommand)
    if (!checked.ok) {
      setCommandError(checked.error)
      return
    }
    if (!prefs.approvalAllowlist.includes(checked.value)) {
      act.setPref("approvalAllowlist", [...prefs.approvalAllowlist, checked.value])
    }
    setNewCommand("")
    setCommandError(null)
    setAddingCommand(false)
  }

  const toggleTool = (row: ApprovalToolRow) => {
    if (!row.toolName) return
    if (canEditRoomTools) {
      if (saving) return
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
      return
    }
    if (!canEditDefaultTools) return
    const next = toggledToolSet(toolView.enabled, row.toolName, !row.enabled)
    void writer.save("defaultTools", defaultToolsPatch(next))
  }

  const defaultTrust = effectiveProjectTrustOf(settingsDoc.data, writer.applied)
  const defaultTrustLabel = APPROVAL_TRUST_OPTIONS.find((option) => option.value === defaultTrust)?.label ?? "未知"
  const writeHint = readOnlyHintOf(settingsDoc, writer)
  const trustWriteDisabled = !writer.canWrite || settingsDoc.phase !== "ready" || writer.saving !== null
  const trustNote = `当前项目：${APPROVAL_TRUST_STATE_LABELS[trust]} · 新项目默认策略：${defaultTrustLabel}`
  const askNote = identityRequired
    ? "需先在「设备」启用浏览器身份，才能远程切换审批门开关。"
    : switchesPending
      ? "正在与设备同步当前会话审批门状态…"
      : undefined

  return (
    <div className="settings-page" data-settings-page="approval">
      <SettingsPageTitle
        title="审批与执行"
        tooltip="通过扩展的 tool_call 权限门与项目信任实施执行边界；何时询问、范围与免审名单实时同步到当前会话。"
      />

      {/* ● 何时询问（实时联动审批门开关 + 免审名单标志） */}
      <ApprovalGroup
        label="何时询问"
        tooltip="实时控制当前会话工具调用的拦截策略；切换至「永不询问」需先开启下方高危解锁。"
        first
        note={askNote}
      >
        <ChoiceGroup
          label="何时询问"
          value={askMode}
          options={askOptions}
          disabled={askSwitchDisabled}
          onChange={handleAskChange}
        />
      </ApprovalGroup>

      {/* ● 项目信任默认策略（写 defaultProjectTrust）；当前项目状态仍只读 */}
      <ApprovalGroup label="项目信任" tooltip={APPROVAL_TRUST_NOTE} note={trustNote}>
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

      {/* ● 活动范围实时联动 set_approval_policy */}
      <ApprovalGroup
        label="能碰什么"
        tooltip="限制当前会话允许读写的文件范围；切换至「完全访问」需先开启下方高危解锁。"
      >
        <ChoiceGroup
          label="能碰什么"
          value={effectiveScope}
          options={scopeOptions}
          onChange={(value) => {
            if (value === "read-only" || value === "workspace" || (value === "full" && prefs.approvalUnlockHighRisk)) {
              act.setPref("approvalScope", value)
            }
          }}
        />
      </ApprovalGroup>

      {/* ● 高危解锁 */}
      <ApprovalGroup label="高危解锁">
        <SettingsRow
          title={APPROVAL_UNLOCK_LABEL}
          tooltip="防误触安全锁：开启后才允许在上方选择「完全访问」或「永不询问」高危档位。"
        >
          <SettingsSwitch
            label={APPROVAL_UNLOCK_LABEL}
            checked={prefs.approvalUnlockHighRisk}
            onChange={handleUnlockChange}
          />
        </SettingsRow>
      </ApprovalGroup>

      {/* ● 免审命令名单 */}
      <ApprovalGroup
        label="免审命令名单"
        tooltip="上方选择「名单内自动通过」时匹配的命令直接放行；仅支持单条命令或通配前缀，禁止管道与串接符。"
      >
        {prefs.approvalAllowlist.length === 0 ? (
          <SettingsRow title="尚未添加免审命令" description="仅在上方选「名单内自动通过」时生效" />
        ) : (
          prefs.approvalAllowlist.map((command) => (
            <SettingsRow key={command} title={<span className="settings-mono">{command}</span>}>
              <button
                type="button"
                className="settings-inline-btn"
                aria-label={`移除 ${command}`}
                onClick={() =>
                  act.setPref(
                    "approvalAllowlist",
                    prefs.approvalAllowlist.filter((item) => item !== command),
                  )
                }
              >
                <X size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            </SettingsRow>
          ))
        )}
        {addingCommand ? (
          <div className="settings-row settings-row--stack">
            <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
              <input
                type="text"
                className="settings-modal-input settings-mono"
                style={{ flex: 1, minWidth: 0 }}
                value={newCommand}
                onChange={(event) => {
                  setNewCommand(event.target.value)
                  setCommandError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    submitAddCommand()
                  }
                }}
                placeholder="例如 git status 或 npm run test"
                aria-label="新增免审命令"
                autoFocus
              />
              <button type="button" className="settings-inline-btn" onClick={submitAddCommand}>
                添加
              </button>
              <button
                type="button"
                className="settings-inline-btn"
                onClick={() => {
                  setAddingCommand(false)
                  setNewCommand("")
                  setCommandError(null)
                }}
              >
                关闭
              </button>
            </div>
            {commandError ? <p className="settings-row-description">{commandError}</p> : null}
          </div>
        ) : (
          <SettingsActionRow
            title="添加命令"
            onClick={() => {
              setAddingCommand(true)
              setCommandError(null)
            }}
          />
        )}
      </ApprovalGroup>

      {/* ● 可用工具：打开会话改当前会话；未打开会话时改新会话默认 defaultTools */}
      <ApprovalGroup
        label="可用工具"
        tooltip={
          canEditRoomTools
            ? APPROVAL_TOOLS_NOTE
            : canEditDefaultTools
              ? "当前未打开会话，开关将写入设备默认可用工具（defaultTools）；仅对新会话生效。"
              : APPROVAL_TOOLS_NOTE
        }
      >
        {toolView.rows.map((row) => {
          const on = canEditRoomTools ? row.toolName !== null && enabled.includes(row.toolName) : row.enabled
          const lock = canEditRoomTools
            ? saving !== null || !row.available
            : !canEditDefaultTools || !row.available
          const scopeLabel = canEditRoomTools ? "当前会话" : "新会话默认"
          return (
            <SettingsRow
              key={row.id}
              title={<ToolTitle row={row} />}
              description={canEditRoomTools && !row.available ? "本机未注册这个工具" : undefined}
            >
              <SettingsSwitch
                label={`${row.label}（${scopeLabel}）`}
                checked={on}
                disabled={lock}
                onChange={() => toggleTool(row)}
              />
            </SettingsRow>
          )
        })}
      </ApprovalGroup>
      {canEditRoomTools || canEditDefaultTools ? null : <SettingsNote>{APPROVAL_TOOLS_EMPTY_HINT}</SettingsNote>}
    </div>
  )
}
