/**
 * 手机端设置 · 扩展（移动压缩版）。
 *
 *   ● 技能总闸：经 settings_set 写 enableSkillCommands；
 *   ● MCP 服务器：get_mcp_servers 读、toggle_mcp_server / upsert_mcp_server / delete_mcp_server 写入 mcp.json；
 *   ◐ 逐条技能 / 模板开关 / 扩展本体与内置扩展 / 添加资源：继续只读 +「需扩展桥」；
 *   ● 技能清单、「仅手动调用」标记、提示词模板清单：只读呈现，不改写。
 */
import { useEffect, useMemo, useState } from "react"
import { commandErrorText } from "@/pi/containers/cShared"
import { useSettings } from "../../SettingsContext.tsx"
import { hostCommandsReady, useHostCommand } from "../data.ts"
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
} from "../../pages/extensionsLogic.ts"
import {
  SETTINGS_RESTART_APPLIED_TEXT,
  SETTINGS_WRITE_OK_TEXT,
  effectiveRawPackagesOf,
  effectiveSettingsArrayOf,
  effectiveSettingsBoolOf,
  extensionsPatch,
  packagesPatch,
  promptsPatch,
  settingsRunCommand,
  skillCommandsPatch,
  skillsPatch,
} from "../../pages/settingsWrite.ts"
import {
  readOnlyHintOf,
  useSettingsDocument,
  useSettingsWriter,
  type SettingsWriteFeedback,
} from "../../pages/settingsWriteHooks.ts"
import { MobileSettingsWriteNote } from "../../pages/settingsWriteFeedback.tsx"
import { useSettingsPiRestart } from "../../pages/useSettingsPiRestart.tsx"
import {
  ExtensionResourceModal,
  McpServerModal,
  type McpConfigServer,
  type UpsertMcpServerPayload,
} from "../../ui.tsx"
import {
  MobileActionRow,
  MobileEmpty,
  MobileGroup,
  MobilePageBody,
  MobileRow,
  MobileStatusLine,
  MobileSwitch,
  MobileSwitchRow,
  MobileTag,
} from "../atoms.tsx"

/** 主机 get_commands 给的是命令 id；设计稿展示的是中文技能名（认得的才映射，认不得原样）。 */
const SKILL_LABEL: Record<string, string> = {
  "code-review": "代码审查",
  literature: "文献检索",
  "web-fetch": "网页抓取",
}

export function ExtensionsPage() {
  const { p, act } = useSettings()
  const { relay } = p
  const ready = hostCommandsReady(relay)
  const targetKey = `${relay.selectedDeviceId ?? ""}:${relay.roomId ?? ""}`
  const settingsDoc = useSettingsDocument(relay)
  const writer = useSettingsWriter(relay)
  const restart = useSettingsPiRestart(relay, act.notify)
  const mcpQuery = useHostCommand(relay, "get_mcp_servers", ready, targetKey)
  const commandsQuery = useHostCommand(relay, "get_commands", ready, targetKey)
  const commandList = useMemo(() => hostCommandsOf(commandsQuery.data), [commandsQuery.data])
  const skillCommands = useMemo(() => skillsOf(commandList), [commandList])
  const promptCommands = useMemo(() => promptsOf(commandList), [commandList])
  const mcpServers = useMemo(() => mcpServersOf(mcpQuery.data), [mcpQuery.data])
  const skillGate = effectiveSettingsBoolOf(settingsDoc.data, writer.applied, "enableSkillCommands")
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
        skillCommands.flatMap((s) =>
          s.sourcePath ? [s.sourcePath, s.name, skillDisplayNameOf(s.name)] : [s.name, skillDisplayNameOf(s.name)],
        ),
      ),
    [skillsConfig, skillCommands],
  )
  const customPrompts = useMemo(
    () =>
      customResourceRowsOf(
        promptsConfig,
        promptCommands.flatMap((cmd) => {
          const clean = cmd.name.replace(/^\/+/, "")
          return cmd.sourcePath ? [cmd.sourcePath, clean] : [clean]
        }),
      ),
    [promptsConfig, promptCommands],
  )
  const customExtensions = useMemo(
    () => customResourceRowsOf(extensionsConfig, ["pi-remote", "remote"]),
    [extensionsConfig],
  )
  const packageRows = useMemo(() => packageRowsOf(packagesConfig), [packagesConfig])
  const writeHint = readOnlyHintOf(settingsDoc, writer)
  const writeDisabled = !writer.canWrite || settingsDoc.phase !== "ready" || writer.saving !== null

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

  const skills = skillCommands.map((command) => {
    const shortName = skillDisplayNameOf(command.name)
    const target = command.sourcePath || shortName
    const candidates = command.sourcePath ? [command.sourcePath, command.name, shortName] : [command.name, shortName]
    return {
      key: command.name,
      name: SKILL_LABEL[shortName] ?? shortName,
      description: command.description,
      manualOnly: command.manualOnly,
      target,
      candidates,
      on: isResourceEnabled(skillsConfig, candidates, true),
    }
  })
  const prompts = promptCommands.map((command) => {
    const clean = command.name.replace(/^\/+/, "")
    const target = command.sourcePath || clean
    const candidates = command.sourcePath ? [command.sourcePath, clean] : [clean]
    return {
      key: command.name,
      name: promptDisplayNameOf(command.name),
      description: command.description,
      target,
      candidates,
      on: isResourceEnabled(promptsConfig, candidates, true),
    }
  })
  const skillsEmpty = !ready
    ? "连接主机后显示技能清单"
    : commandsQuery.phase === "loading"
      ? "正在读取技能清单…"
      : commandsQuery.phase === "error"
        ? "技能清单读取失败，可稍后重新打开设置"
        : "尚未发现技能"
  const promptsEmpty = !ready
    ? "连接主机后显示提示词模板"
    : commandsQuery.phase === "loading"
      ? "正在读取提示词模板…"
      : commandsQuery.phase === "error"
        ? "提示词模板读取失败，可稍后重新打开设置"
        : "尚未发现提示词模板"
  const mcpEmpty = !ready
    ? "连接主机后显示 MCP 服务器"
    : mcpQuery.phase === "loading"
      ? "正在读取 MCP 服务器…"
      : mcpQuery.phase === "error"
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
        mcpQuery.reload()
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
      mcpQuery.reload()
      markMcpSaved()
      act.notify(`已保存 MCP 服务器「${payload.name}」`)
    } catch (error) {
      throw new Error(commandErrorText(error))
    }
  }

  const handleDeleteMcp = async (name: string) => {
    try {
      await settingsRunCommand(relay, "delete_mcp_server", { name })
      mcpQuery.reload()
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
    <MobilePageBody page="extensions">
      <MobileGroup label="技能">
        <MobileSwitchRow
          title="技能斜杠命令"
          tooltip="把技能注册成 /skill:名字 命令；关闭后仍可手动输入调用"
          checked={skillGate === true}
          disabled={writeDisabled || skillGate === null}
          onChange={(checked) => {
            void writer.save("enableSkillCommands", skillCommandsPatch(checked))
          }}
        />
        {skills.length === 0 && customSkills.length === 0 ? (
          <MobileEmpty title="技能清单" body={skillsEmpty} />
        ) : (
          <>
            {skills.map((skill) => (
              <MobileRow
                key={skill.key}
                title={
                  <>
                    {skill.name}
                    {skill.manualOnly ? <MobileTag>仅手动调用</MobileTag> : null}
                  </>
                }
                description={skill.description}
              >
                <MobileSwitch
                  label={skill.name}
                  checked={skill.on}
                  disabled={writeDisabled}
                  onChange={(checked) => {
                    const next = toggleResourceEntry(skillsConfig, skill.target, checked, true, skill.candidates)
                    void writer.save("skills", skillsPatch(next))
                  }}
                />
              </MobileRow>
            ))}
            {customSkills.map((row) => (
              <MobileRow
                key={`skill-cfg:${row.target}`}
                title={row.target}
                description={
                  <span className="sm-inline-controls">
                    <button
                      type="button"
                      className="sm-inline-btn"
                      disabled={writeDisabled}
                      onClick={() => {
                        const next = removeResourceEntry(skillsConfig, row.target)
                        void writer.save("skills", skillsPatch(next))
                      }}
                    >
                      移除
                    </button>
                  </span>
                }
              >
                <MobileSwitch
                  label={row.target}
                  checked={row.enabled}
                  disabled={writeDisabled}
                  onChange={(checked) => {
                    const next = toggleResourceEntry(skillsConfig, row.target, checked, true, [row.target])
                    void writer.save("skills", skillsPatch(next))
                  }}
                />
              </MobileRow>
            ))}
          </>
        )}
        <MobileActionRow
          title="添加技能"
          disabled={writeDisabled}
          onClick={() => setResourceModal("skill")}
        />
      </MobileGroup>

      <MobileGroup label="MCP 服务器" tooltip="连接外部工具与数据源；通过启动命令或服务端点接入">
        {mcpServers.length === 0 ? (
          <MobileEmpty title="MCP 服务器" body={mcpEmpty} />
        ) : (
          mcpServers.map((server) => (
            <MobileRow
              key={server.name}
              title={server.name}
              description={
                <span className="sm-inline-controls">
                  <MobileStatusLine tone={mcpToneOf(server)}>{mcpStatusTextOf(server)}</MobileStatusLine>
                  <button
                    type="button"
                    className="sm-inline-btn"
                    disabled={!ready || togglingMcp !== null}
                    onClick={() => setMcpModal({ open: true, initial: server })}
                  >
                    编辑
                  </button>
                </span>
              }
            >
              <MobileSwitch
                label={`启用 ${server.name}`}
                checked={server.enabled}
                disabled={!ready || togglingMcp !== null}
                onChange={(checked) => toggleMcp(server.name, checked)}
              />
            </MobileRow>
          ))
        )}
        <MobileActionRow
          title="添加 MCP 服务器"
          disabled={!ready || togglingMcp !== null}
          onClick={() => setMcpModal({ open: true, initial: null })}
        />
      </MobileGroup>
      <MobileSettingsWriteNote feedback={mcpFeedback} />

      <MobileGroup label="提示词模板">
        {prompts.length === 0 && customPrompts.length === 0 ? (
          <MobileEmpty title="提示词模板" body={promptsEmpty} />
        ) : (
          <>
            {prompts.map((prompt) => (
              <MobileRow key={prompt.key} title={prompt.name} description={prompt.description}>
                <MobileSwitch
                  label={prompt.name}
                  checked={prompt.on}
                  disabled={writeDisabled}
                  onChange={(checked) => {
                    const next = toggleResourceEntry(promptsConfig, prompt.target, checked, true, prompt.candidates)
                    void writer.save("prompts", promptsPatch(next))
                  }}
                />
              </MobileRow>
            ))}
            {customPrompts.map((row) => (
              <MobileRow
                key={`prompt-cfg:${row.target}`}
                title={row.target}
                description={
                  <span className="sm-inline-controls">
                    <button
                      type="button"
                      className="sm-inline-btn"
                      disabled={writeDisabled}
                      onClick={() => {
                        const next = removeResourceEntry(promptsConfig, row.target)
                        void writer.save("prompts", promptsPatch(next))
                      }}
                    >
                      移除
                    </button>
                  </span>
                }
              >
                <MobileSwitch
                  label={row.target}
                  checked={row.enabled}
                  disabled={writeDisabled}
                  onChange={(checked) => {
                    const next = toggleResourceEntry(promptsConfig, row.target, checked, true, [row.target])
                    void writer.save("prompts", promptsPatch(next))
                  }}
                />
              </MobileRow>
            ))}
          </>
        )}
        <MobileActionRow
          title="添加模板"
          disabled={writeDisabled}
          onClick={() => setResourceModal("prompt")}
        />
      </MobileGroup>

      <MobileGroup label="扩展本体" tooltip="扩展拥有完整系统权限，请仅安装可信来源">
        <MobileRow title="pi-remote 远程" status="existing">
          <span className="sm-value">内置</span>
        </MobileRow>
        {customExtensions.map((row) => (
          <MobileRow
            key={`ext-cfg:${row.target}`}
            title={row.target}
            description={
              <span className="sm-inline-controls">
                <button
                  type="button"
                  className="sm-inline-btn"
                  disabled={writeDisabled}
                  onClick={() => {
                    const next = removeResourceEntry(extensionsConfig, row.target)
                    void writer.save("extensions", extensionsPatch(next))
                  }}
                >
                  移除
                </button>
              </span>
            }
          >
            <MobileSwitch
              label={row.target}
              checked={row.enabled}
              disabled={writeDisabled}
              onChange={(checked) => {
                const next = toggleResourceEntry(extensionsConfig, row.target, checked, true, [row.target])
                void writer.save("extensions", extensionsPatch(next))
              }}
            />
          </MobileRow>
        ))}
        {BUILTIN_EXTENSION_SPECS.map((spec) => {
          const enabled = isResourceEnabled(extensionsConfig, [spec.target, spec.id], spec.defaultEnabled)
          return (
            <MobileRow
              key={spec.id}
              title={
                <>
                  {spec.label}
                  <MobileTag>内置</MobileTag>
                </>
              }
            >
              <MobileSwitch
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
            </MobileRow>
          )
        })}
        <MobileActionRow
          title="添加扩展"
          disabled={writeDisabled}
          onClick={() => setResourceModal("extension")}
        />
      </MobileGroup>

      <MobileGroup label="Pi 包" tooltip="从 npm、git 或本地文件夹整包安装扩展、技能与模板">
        {packageRows.length === 0 ? (
          <MobileEmpty title="Pi 包" body="尚未安装任何包（从 npm、git 或本地文件夹整包安装）" />
        ) : (
          packageRows.map((pkg) => (
            <MobileRow
              key={pkg.key}
              title={pkg.source}
              description={
                <span className="sm-inline-controls">
                  <button
                    type="button"
                    className="sm-inline-btn"
                    disabled={writeDisabled}
                    onClick={() => {
                      const next = removePackageEntry(packagesConfig, pkg.index)
                      void writer.save("packages", packagesPatch(next))
                    }}
                  >
                    移除
                  </button>
                </span>
              }
            >
              <MobileSwitch
                label={pkg.source}
                checked={pkg.enabled}
                disabled={writeDisabled}
                onChange={(checked) => {
                  const next = togglePackageEntry(packagesConfig, pkg.index, checked)
                  void writer.save("packages", packagesPatch(next))
                }}
              />
            </MobileRow>
          ))
        )}
        <MobileActionRow
          title="添加包"
          disabled={writeDisabled}
          onClick={() => setResourceModal("package")}
        />
      </MobileGroup>

      <MobileSettingsWriteNote feedback={writer.feedback} fallback={writeHint} />

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
    </MobilePageBody>
  )
}
