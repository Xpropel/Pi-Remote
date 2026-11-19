/**
 * 设置 › 扩展。
 *
 *   ● MCP 清单、连接状态、工具曝光档：get_mcp_servers 读、toggle_mcp_server /
 *     upsert_mcp_server / delete_mcp_server 写入所连设备 mcp.json；
 *   ● 技能 / 提示词模板清单与「仅手动调用」标记：get_commands 呈现；
 *   ● 技能斜杠命令总闸：经 settings_set 写 enableSkillCommands；
 *   ◐ 逐条技能开关、模板开关、扩展开关、添加技能 / 模板 / 扩展 / 包：保持只读。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { commandErrorText } from "@/pi/containers/cShared"
import { useSettings } from "../SettingsContext"
import type { SettingsItemStatus } from "../types"
import {
  ExtensionResourceModal,
  McpServerModal,
  SettingsActionRow,
  SettingsHoverTitle,
  SettingsPageTitle,
  SettingsRow,
  SettingsStatusBadge,
  SettingsStatusDot,
  SettingsSwitch,
  type McpConfigServer,
  type UpsertMcpServerPayload,
} from "../ui"
import {
  BUILTIN_EXTENSION_SPECS,
  addPackageEntry,
  addResourceEntry,
  customResourceRowsOf,
  hostCommandsOf,
  isResourceEnabled,
  mcpServersOf,
  mcpStatusTextOf,
  mcpToneOf,
  packageRowsOf,
  promptDisplayNameOf,
  promptsOf,
  removePackageEntry,
  removeResourceEntry,
  skillDisplayNameOf,
  skillsOf,
  togglePackageEntry,
  toggleResourceEntry,
  type ExtensionResourceKind,
} from "./extensionsLogic"
import {
  SETTINGS_RESTART_APPLIED_TEXT,
  SETTINGS_WRITE_OK_TEXT,
  effectiveRawPackagesOf,
  effectiveSettingsArrayOf,
  effectiveSettingsBoolOf,
  extensionsPatch,
  packagesPatch,
  promptsPatch,
  settingsCommandsReady,
  settingsRunCommand,
  skillCommandsPatch,
  skillsPatch,
} from "./settingsWrite.ts"
import {
  readOnlyHintOf,
  useSettingsCommand,
  useSettingsDocument,
  useSettingsWriter,
  type SettingsWriteFeedback,
} from "./settingsWriteHooks.ts"
import { SettingsWriteNote } from "./settingsWriteFeedback.tsx"
import { useSettingsPiRestart } from "./useSettingsPiRestart.tsx"
import "./extensions.css"

/** 整组同一状态时，徽标挂在分组标题上，组内行不再重复挂（同审批页口径）。 */
function StatusGroup({
  label,
  tooltip,
  status,
  first = false,
  children,
}: {
  label: string
  tooltip?: string
  status?: SettingsItemStatus
  first?: boolean
  children: ReactNode
}) {
  return (
    <section className={first ? "settings-group settings-group--first" : "settings-group"}>
      <h2 className="settings-group-label settings-ext-group-label">
        <SettingsHoverTitle tooltip={tooltip}>{label}</SettingsHoverTitle>
        <SettingsStatusBadge status={status} />
      </h2>
      <div className="settings-card">{children}</div>
    </section>
  )
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <div className="settings-row settings-row--note">
      <span className="settings-ext-note">{children}</span>
    </div>
  )
}

export function ExtensionsPage() {
  const { p, act } = useSettings()
  const { relay } = p
  const ready = settingsCommandsReady(relay) && relay.browserOnline
  const targetKey = `${relay.selectedDeviceId ?? ""}:${relay.roomId ?? ""}`
  const settingsDoc = useSettingsDocument(relay)
  const writer = useSettingsWriter(relay)
  const restart = useSettingsPiRestart(relay, act.notify)
  const commands = useSettingsCommand(relay, "get_commands", ready, targetKey)
  const mcp = useSettingsCommand(relay, "get_mcp_servers", ready, targetKey)

  const [mcpFeedback, setMcpFeedback] = useState<SettingsWriteFeedback | null>(null)
  const [togglingMcp, setTogglingMcp] = useState<string | null>(null)
  const [mcpModal, setMcpModal] = useState<{ open: boolean; initial: McpConfigServer | null }>({
    open: false,
    initial: null,
  })
  const [resourceModal, setResourceModal] = useState<ExtensionResourceKind | null>(null)

  useEffect(() => {
    if (restart.phase === "succeeded") {
      setMcpFeedback((prev) =>
        prev && prev.text === SETTINGS_WRITE_OK_TEXT
          ? { id: prev.id, tone: "ok", text: SETTINGS_RESTART_APPLIED_TEXT }
          : prev,
      )
    }
  }, [restart.phase])

  const commandList = useMemo(() => hostCommandsOf(commands.data), [commands.data])
  const skills = useMemo(() => skillsOf(commandList), [commandList])
  const prompts = useMemo(() => promptsOf(commandList), [commandList])
  const mcpServers = useMemo(() => mcpServersOf(mcp.data), [mcp.data])
  const skillCommandsEnabled = effectiveSettingsBoolOf(settingsDoc.data, writer.applied, "enableSkillCommands")
  const skillsConfig = useMemo(
    () => effectiveSettingsArrayOf(settingsDoc.data, writer.applied, "skills"),
    [settingsDoc.data, writer.applied],
  )
  const promptsConfig = useMemo(
    () => effectiveSettingsArrayOf(settingsDoc.data, writer.applied, "prompts"),
    [settingsDoc.data, writer.applied],
  )
  const extensionsConfig = useMemo(
    () => effectiveSettingsArrayOf(settingsDoc.data, writer.applied, "extensions"),
    [settingsDoc.data, writer.applied],
  )
  const packagesConfig = useMemo(
    () => effectiveRawPackagesOf(settingsDoc.data, writer.applied),
    [settingsDoc.data, writer.applied],
  )
  const customSkills = useMemo(
    () =>
      customResourceRowsOf(
        skillsConfig,
        skills.flatMap((s) => (s.sourcePath ? [s.sourcePath, s.name, skillDisplayNameOf(s.name)] : [s.name, skillDisplayNameOf(s.name)])),
      ),
    [skillsConfig, skills],
  )
  const customPrompts = useMemo(
    () =>
      customResourceRowsOf(
        promptsConfig,
        prompts.flatMap((p) => {
          const clean = p.name.replace(/^\/+/, "")
          return p.sourcePath ? [p.sourcePath, clean] : [clean]
        }),
      ),
    [promptsConfig, prompts],
  )
  const customExtensions = useMemo(
    () => customResourceRowsOf(extensionsConfig, ["pi-remote", "remote"]),
    [extensionsConfig],
  )
  const packageRows = useMemo(() => packageRowsOf(packagesConfig), [packagesConfig])
  const writeHint = readOnlyHintOf(settingsDoc, writer)
  const writeDisabled = !writer.canWrite || settingsDoc.phase !== "ready" || writer.saving !== null

  const skillsEmpty = !ready
    ? "连接主机后显示技能清单"
    : commands.phase === "loading"
      ? "正在读取技能清单…"
      : commands.phase === "error"
        ? "技能清单读取失败，可稍后重新打开设置"
        : "尚未发现技能"
  const promptsEmpty = !ready
    ? "连接主机后显示提示词模板"
    : commands.phase === "loading"
      ? "正在读取提示词模板…"
      : commands.phase === "error"
        ? "提示词模板读取失败，可稍后重新打开设置"
        : "尚未发现提示词模板"
  const mcpEmpty = !ready
    ? "连接主机后显示 MCP 服务器"
    : mcp.phase === "loading"
      ? "正在读取 MCP 服务器…"
      : mcp.phase === "error"
        ? "MCP 清单读取失败，可稍后重新打开设置"
        : "尚未配置 MCP 服务器"

  const markMcpSaved = () => {
    restart.resetFeedback()
    setMcpFeedback({
      id: "mcp",
      tone: "ok",
      text: SETTINGS_WRITE_OK_TEXT,
      hint: "MCP 配置已写入 mcp.json，重启 Pi 后新的工具与连接配置立即生效",
    })
  }

  const toggleMcp = (name: string, enabled: boolean) => {
    if (!ready || togglingMcp) return
    setTogglingMcp(name)
    void settingsRunCommand(relay, "toggle_mcp_server", { name, enabled }).then(
      () => {
        setTogglingMcp(null)
        mcp.reload()
        markMcpSaved()
        act.notify(`已${enabled ? "启用" : "停用"} MCP 服务器「${name}」`)
      },
      (error: unknown) => {
        setTogglingMcp(null)
        act.notify(`保存失败：${commandErrorText(error)}`, "bad")
      },
    )
  }

  const handleSaveMcp = async (payload: UpsertMcpServerPayload) => {
    try {
      await settingsRunCommand(relay, "upsert_mcp_server", payload)
      mcp.reload()
      markMcpSaved()
      act.notify(`已保存 MCP 服务器「${payload.name}」`)
    } catch (error) {
      throw new Error(commandErrorText(error))
    }
  }

  const handleDeleteMcp = async (name: string) => {
    try {
      await settingsRunCommand(relay, "delete_mcp_server", { name })
      mcp.reload()
      markMcpSaved()
      act.notify(`已删除 MCP 服务器「${name}」`)
    } catch (error) {
      throw new Error(commandErrorText(error))
    }
  }

  const handleAddResource = async (kind: ExtensionResourceKind, source: string) => {
    let ok = false
    if (kind === "skill") {
      const next = addResourceEntry(skillsConfig, source)
      if (!next) return false
      ok = await writer.save("skills", skillsPatch(next))
    } else if (kind === "prompt") {
      const next = addResourceEntry(promptsConfig, source)
      if (!next) return false
      ok = await writer.save("prompts", promptsPatch(next))
    } else if (kind === "extension") {
      const next = addResourceEntry(extensionsConfig, source)
      if (!next) return false
      ok = await writer.save("extensions", extensionsPatch(next))
    } else if (kind === "package") {
      const next = addPackageEntry(packagesConfig, source)
      if (!next) return false
      ok = await writer.save("packages", packagesPatch(next))
    }
    if (!ok) throw new Error("保存失败，请确认设备在线并查看页面提示")
    act.notify(`已添加「${source}」，重启 pi 后生效`)
    return true
  }

  return (
    <div className="settings-page settings-extensions" data-settings-page="extensions">
      <SettingsPageTitle title="扩展" />

      <StatusGroup label="技能" first>
        <SettingsRow
          title="技能斜杠命令"
          tooltip="把技能注册成 /skill:名字 命令；关闭后仍可手动输入调用"
        >
          <SettingsSwitch
            label="技能斜杠命令"
            checked={skillCommandsEnabled === true}
            disabled={writeDisabled || skillCommandsEnabled === null}
            onChange={(checked) => {
              void writer.save("enableSkillCommands", skillCommandsPatch(checked))
            }}
          />
        </SettingsRow>
        {skills.length === 0 && customSkills.length === 0 ? (
          <EmptyRow>{skillsEmpty}</EmptyRow>
        ) : (
          <>
            {skills.map((skill) => {
              const shortName = skillDisplayNameOf(skill.name)
              const target = skill.sourcePath || shortName
              const candidates = skill.sourcePath ? [skill.sourcePath, skill.name, shortName] : [skill.name, shortName]
              const enabled = isResourceEnabled(skillsConfig, candidates, true)
              return (
                <SettingsRow
                  key={`skill:${skill.name}`}
                  title={
                    <>
                      {shortName}
                      {skill.manualOnly ? <span className="settings-ext-tag">仅手动调用</span> : null}
                    </>
                  }
                  description={skill.description || undefined}
                >
                  <SettingsSwitch
                    label={shortName}
                    checked={enabled}
                    disabled={writeDisabled}
                    onChange={(checked) => {
                      const next = toggleResourceEntry(skillsConfig, target, checked, true, candidates)
                      void writer.save("skills", skillsPatch(next))
                    }}
                  />
                </SettingsRow>
              )
            })}
            {customSkills.map((row) => (
              <SettingsRow key={`skill-cfg:${row.target}`} title={<span className="settings-ext-mono">{row.target}</span>}>
                <span className="settings-ext-controls">
                  <button
                    type="button"
                    className="settings-inline-btn"
                    disabled={writeDisabled}
                    onClick={() => {
                      const next = removeResourceEntry(skillsConfig, row.target)
                      void writer.save("skills", skillsPatch(next))
                    }}
                  >
                    移除
                  </button>
                  <SettingsSwitch
                    label={row.target}
                    checked={row.enabled}
                    disabled={writeDisabled}
                    onChange={(checked) => {
                      const next = toggleResourceEntry(skillsConfig, row.target, checked, true, [row.target])
                      void writer.save("skills", skillsPatch(next))
                    }}
                  />
                </span>
              </SettingsRow>
            ))}
          </>
        )}
        <SettingsActionRow
          title="添加技能"
          disabled={writeDisabled}
          onClick={() => setResourceModal("skill")}
        />
      </StatusGroup>
      <SettingsWriteNote feedback={writer.feedback} fallback={writeHint} />

      <StatusGroup label="MCP 服务器" tooltip="连接外部工具与数据源；通过启动命令或服务端点接入">
        {mcpServers.length === 0 ? (
          <EmptyRow>{mcpEmpty}</EmptyRow>
        ) : (
          mcpServers.map((server) => (
            <SettingsRow
              key={`mcp:${server.name}`}
              title={<span className="settings-ext-mono">{server.name}</span>}
              description={
                <span className="settings-ext-inline">
                  <SettingsStatusDot tone={mcpToneOf(server)} />
                  <span>{mcpStatusTextOf(server)}</span>
                </span>
              }
            >
              <span className="settings-ext-controls">
                <button
                  type="button"
                  className="settings-inline-btn"
                  disabled={!ready || togglingMcp !== null}
                  onClick={() => setMcpModal({ open: true, initial: server })}
                >
                  编辑
                </button>
                <SettingsSwitch
                  label={`启用 ${server.name}`}
                  checked={server.enabled}
                  disabled={!ready || togglingMcp !== null}
                  onChange={(checked) => toggleMcp(server.name, checked)}
                />
              </span>
            </SettingsRow>
          ))
        )}
        <SettingsActionRow
          title="添加 MCP 服务器"
          disabled={!ready || togglingMcp !== null}
          onClick={() => setMcpModal({ open: true, initial: null })}
        />
      </StatusGroup>
      <SettingsWriteNote feedback={mcpFeedback} />

      <StatusGroup label="提示词模板">
        {prompts.length === 0 && customPrompts.length === 0 ? (
          <EmptyRow>{promptsEmpty}</EmptyRow>
        ) : (
          <>
            {prompts.map((prompt) => {
              const shortName = prompt.name.replace(/^\/+/, "")
              const target = prompt.sourcePath || shortName
              const candidates = prompt.sourcePath ? [prompt.sourcePath, shortName] : [shortName]
              const enabled = isResourceEnabled(promptsConfig, candidates, true)
              return (
                <SettingsRow
                  key={`prompt:${prompt.name}`}
                  title={<span className="settings-ext-mono">{promptDisplayNameOf(prompt.name)}</span>}
                  description={prompt.description || undefined}
                >
                  <SettingsSwitch
                    label={`${promptDisplayNameOf(prompt.name)} 启用`}
                    checked={enabled}
                    disabled={writeDisabled}
                    onChange={(checked) => {
                      const next = toggleResourceEntry(promptsConfig, target, checked, true, candidates)
                      void writer.save("prompts", promptsPatch(next))
                    }}
                  />
                </SettingsRow>
              )
            })}
            {customPrompts.map((row) => (
              <SettingsRow key={`prompt-cfg:${row.target}`} title={<span className="settings-ext-mono">{row.target}</span>}>
                <span className="settings-ext-controls">
                  <button
                    type="button"
                    className="settings-inline-btn"
                    disabled={writeDisabled}
                    onClick={() => {
                      const next = removeResourceEntry(promptsConfig, row.target)
                      void writer.save("prompts", promptsPatch(next))
                    }}
                  >
                    移除
                  </button>
                  <SettingsSwitch
                    label={row.target}
                    checked={row.enabled}
                    disabled={writeDisabled}
                    onChange={(checked) => {
                      const next = toggleResourceEntry(promptsConfig, row.target, checked, true, [row.target])
                      void writer.save("prompts", promptsPatch(next))
                    }}
                  />
                </span>
              </SettingsRow>
            ))}
          </>
        )}
        <SettingsActionRow
          title="添加模板"
          disabled={writeDisabled}
          onClick={() => setResourceModal("prompt")}
        />
      </StatusGroup>

      <StatusGroup label="扩展本体" tooltip="扩展拥有完整系统权限，请仅安装可信来源">
        <SettingsRow title="pi-remote 远程">
          <span className="settings-value">内置 · 运行中</span>
        </SettingsRow>
        {customExtensions.map((row) => (
          <SettingsRow key={`ext-cfg:${row.target}`} title={<span className="settings-ext-mono">{row.target}</span>}>
            <span className="settings-ext-controls">
              <button
                type="button"
                className="settings-inline-btn"
                disabled={writeDisabled}
                onClick={() => {
                  const next = removeResourceEntry(extensionsConfig, row.target)
                  void writer.save("extensions", extensionsPatch(next))
                }}
              >
                移除
              </button>
              <SettingsSwitch
                label={row.target}
                checked={row.enabled}
                disabled={writeDisabled}
                onChange={(checked) => {
                  const next = toggleResourceEntry(extensionsConfig, row.target, checked, true, [row.target])
                  void writer.save("extensions", extensionsPatch(next))
                }}
              />
            </span>
          </SettingsRow>
        ))}
        <div className="settings-row settings-row--subhead">
          <span className="settings-ext-subhead">内置</span>
        </div>
        {BUILTIN_EXTENSION_SPECS.map((spec) => {
          const enabled = isResourceEnabled(extensionsConfig, [spec.target, spec.id], spec.defaultEnabled)
          return (
            <SettingsRow
              key={spec.id}
              title={
                <>
                  {spec.label}
                  <span className="settings-ext-tag">内置</span>
                </>
              }
            >
              <SettingsSwitch
                label={spec.label}
                checked={enabled}
                disabled={writeDisabled}
                onChange={(checked) => {
                  const next = toggleResourceEntry(
                    extensionsConfig,
                    spec.target,
                    checked,
                    spec.defaultEnabled,
                    [spec.target, spec.id],
                  )
                  void writer.save("extensions", extensionsPatch(next))
                }}
              />
            </SettingsRow>
          )
        })}
        <SettingsActionRow
          title="添加扩展"
          disabled={writeDisabled}
          onClick={() => setResourceModal("extension")}
        />
      </StatusGroup>

      <StatusGroup label="Pi 包" tooltip="从 npm、git 或本地文件夹整包安装扩展、技能与模板">
        {packageRows.length === 0 ? (
          <EmptyRow>尚未安装任何包</EmptyRow>
        ) : (
          packageRows.map((pkg) => (
            <SettingsRow key={pkg.key} title={<span className="settings-ext-mono">{pkg.source}</span>}>
              <span className="settings-ext-controls">
                <button
                  type="button"
                  className="settings-inline-btn"
                  disabled={writeDisabled}
                  onClick={() => {
                    const next = removePackageEntry(packagesConfig, pkg.index)
                    void writer.save("packages", packagesPatch(next))
                  }}
                >
                  移除
                </button>
                <SettingsSwitch
                  label={pkg.source}
                  checked={pkg.enabled}
                  disabled={writeDisabled}
                  onChange={(checked) => {
                    const next = togglePackageEntry(packagesConfig, pkg.index, checked)
                    void writer.save("packages", packagesPatch(next))
                  }}
                />
              </span>
            </SettingsRow>
          ))
        )}
        <SettingsActionRow
          title="添加包"
          disabled={writeDisabled}
          onClick={() => setResourceModal("package")}
        />
      </StatusGroup>

      <McpServerModal
        open={mcpModal.open}
        initialServer={mcpModal.initial}
        onClose={() => setMcpModal({ open: false, initial: null })}
        onSave={handleSaveMcp}
        onDelete={mcpModal.initial ? handleDeleteMcp : undefined}
      />

      <ExtensionResourceModal
        open={resourceModal !== null}
        kind={resourceModal}
        onClose={() => setResourceModal(null)}
        onAdd={handleAddResource}
      />
    </div>
  )
}
