/**
 * 设置 › 模型与会话。
 *
 *   ● 默认模型、默认思考等级、显示思考过程、enabledModels、modelThinkingLevels、compaction.*：
 *     经 settings_set 写全局 settings.json（有会话走房间命令，无会话走设备直连命令）；
 *   ● 供应商与自定义模型（get_models_config / upsert_model_provider / delete_model_provider /
 *     upsert_provider_model / delete_provider_model）：直写所连设备 models.json / auth.json；
 *   ○ 新会话默认模式、新会话自动生成标题：本机偏好（立即持久化并在新建会话首条消息生效）。
 */
import { Fragment, useEffect, useMemo, useState, type CSSProperties } from "react"
import { ChevronDown, Plus } from "lucide-react"
import { commandErrorText } from "@/pi/containers/cShared"
import { settingsDeviceOfflineOf } from "../model"
import { useSettings } from "../SettingsContext"
import {
  MODEL_NEW_SESSION_MODES,
  MODEL_PROVIDER_MODEL_LIMIT,
  MODEL_THINKING_LEVELS,
  MODEL_THINKING_LEVEL_LABELS,
  MODEL_THINKING_LEVELS_COPY,
  configuredModelChoicesOf,
  defaultModelGroupsOf,
  isBuiltInUnconfiguredProvider,
  providerModelOverflowOf,
  providerRowsOf,
  splitSettingsProviders,
  thinkingLevelLabelOf,
  tokenCountLabel,
  toggledEnabledModelsOf,
  type ProviderRow,
} from "./modelData"
import {
  SETTINGS_WRITE_PENDING_RESTART_TEXT,
  compactionEnabledPatch,
  defaultModelPatch,
  defaultThinkingLevelPatch,
  effectiveModelThinkingLevelsOf,
  effectiveSettingsArrayOf,
  effectiveSettingsBoolOf,
  effectiveSettingsIntOf,
  effectiveSettingsStringOf,
  enabledModelsPatch,
  hideThinkingBlockPatch,
  modelThinkingLevelsPatch,
  settingsCommandsReady,
  settingsRunCommand,
  thinkingLevelOf,
  tokenBudgetPatch,
  type SettingsThinkingLevel,
} from "./settingsWrite.ts"
import {
  readOnlyHintOf,
  settingsFeedbackFor,
  useSettingsCommand,
  useSettingsDocument,
  useSettingsWriter,
} from "./settingsWriteHooks.ts"
import { SettingsWriteNote } from "./settingsWriteFeedback.tsx"
import { settingsPiRestartBannerOf } from "./settingsPiRestart.ts"
import { SettingsPiRestartDialog, useSettingsPiRestart } from "./useSettingsPiRestart.tsx"
import {
  ModelConfigModal,
  ProviderConfigModal,
  SettingsActionBar,
  SettingsActionButton,
  SettingsActionRow,
  SettingsGroup,
  SettingsPageTitle,
  SettingsRadioGroup,
  SettingsRow,
  SettingsSelect,
  SettingsStatusDot,
  SettingsSwitch,
  type ModelConfigModel,
  type ModelConfigProvider,
  type UpsertModelPayload,
  type UpsertProviderPayload,
} from "../ui"
import "./model.css"

/** 模型名 / 数值用等宽（设计稿 .mono：12.5px、字距 -0.01em）。 */
const MONO: CSSProperties = { fontFamily: "var(--st-font-mono)", fontSize: 12.5, letterSpacing: "-0.01em" }

const NEW_SESSION_OPTIONS = MODEL_NEW_SESSION_MODES.map((mode) => ({ value: mode.value, label: mode.label }))

const THINKING_OPTIONS = MODEL_THINKING_LEVELS.map((level) => ({
  value: level,
  label: MODEL_THINKING_LEVEL_LABELS[level],
}))
const THINKING_UNSET = { value: "", label: "未设置（按模型兜底）" } as const

/** 压缩预算常用档位；当前值不在档位里时补一项，避免选择框显示为空。 */
const TOKEN_PRESETS = [0, 4096, 8192, 16384, 24576, 32768, 49152, 65536, 131072] as const

function tokenOptions(current: number | null): { value: string; label: string }[] {
  const values = new Set<number>(TOKEN_PRESETS)
  if (current !== null) values.add(current)
  const options = [...values]
    .sort((left, right) => left - right)
    .map((value) => ({ value: String(value), label: tokenCountLabel(value) }))
  if (current === null) options.unshift({ value: "", label: "未设置" })
  return options
}

const DEFAULT_MODEL_WRITE_IDS = ["defaultModel", "defaultThinkingLevel", "hideThinkingBlock"] as const
const PROVIDER_WRITE_IDS = ["enabledModels", "modelThinkingLevels"] as const
const COMPACTION_WRITE_IDS = ["compaction.enabled", "compaction.reserveTokens", "compaction.keepRecentTokens"] as const

function providerStateText(provider: ProviderRow): string {
  if (provider.state === "connected") return "已连接"
  if (provider.state === "disconnected") return "未连接"
  return "状态未知"
}

function providerStateTone(provider: ProviderRow): "online" | "offline" {
  return provider.state === "connected" ? "online" : "offline"
}

function providerKeyText(provider: ProviderRow): string {
  if (provider.configured === true) return "密钥已配置"
  if (provider.configured === false) return "密钥未配置"
  return "密钥状态未知"
}

function ProviderTitle({ provider }: { provider: ProviderRow }) {
  return (
    <span className="settings-model-provider" data-settings-provider={provider.id}>
      <span className="settings-model-provider-name">{provider.name}</span>
      <span className="settings-model-provider-state">
        <SettingsStatusDot tone={providerStateTone(provider)} />
        {providerStateText(provider)}
      </span>
    </span>
  )
}

function ProviderMeta({ provider }: { provider: ProviderRow }) {
  return (
    <>
      {provider.endpoint ? (
        <>
          接口地址 <span style={MONO}>{provider.endpoint}</span> ·{" "}
        </>
      ) : null}
      {providerKeyText(provider)}
    </>
  )
}

export function ModelPage() {
  const { p, prefs, act } = useSettings()
  const { relay } = p
  const ready = settingsCommandsReady(relay) && relay.browserOnline
  const deviceOffline = settingsDeviceOfflineOf(relay)
  const refreshReady = ready && !deviceOffline
  const targetKey = `${relay.selectedDeviceId ?? ""}:${relay.roomId ?? ""}`

  const settingsDoc = useSettingsDocument(relay)
  const writer = useSettingsWriter(relay)
  const providersQuery = useSettingsCommand(relay, "get_provider_auth", ready, targetKey)
  const modelsQuery = useSettingsCommand(relay, "get_available_models", ready, targetKey)
  const modelsConfigQuery = useSettingsCommand(relay, "get_models_config", ready, targetKey)

  // 刷新时保留上一次成功读到的模型清单（loading / error 不把旧数据清空）。
  const [lastModels, setLastModels] = useState<{ key: string; data: unknown } | null>(null)
  useEffect(() => {
    if (modelsQuery.phase === "ready") setLastModels({ key: targetKey, data: modelsQuery.data })
  }, [modelsQuery.phase, modelsQuery.data, targetKey])
  const lastModelsData = lastModels?.key === targetKey ? lastModels.data : undefined
  const modelsData = modelsQuery.phase === "ready" ? modelsQuery.data : lastModelsData
  const modelsLoading = modelsQuery.phase === "loading"
  const modelsHint = deviceOffline
    ? "设备离线，无法刷新模型目录；设备恢复连接后可重新读取"
    : !ready
      ? "连接主机后可重新读取模型清单"
      : modelsLoading
        ? "正在读取模型清单…"
        : modelsQuery.phase === "error"
          ? `读取失败：${modelsQuery.error}${lastModelsData != null ? "；仍显示上次读取的清单" : ""}`
          : undefined

  const configuredEnabledModels = useMemo(
    () => effectiveSettingsArrayOf(settingsDoc.data, writer.applied, "enabledModels"),
    [settingsDoc.data, writer.applied],
  )
  const effectiveThinkingMap = useMemo(
    () => effectiveModelThinkingLevelsOf(settingsDoc.data, writer.applied),
    [settingsDoc.data, writer.applied],
  )
  const thinkingLabelMap = useMemo(() => {
    const out: Record<string, string> = {}
    for (const [key, level] of Object.entries(effectiveThinkingMap)) {
      const label = thinkingLevelLabelOf(level)
      if (label) out[key] = label
    }
    return out
  }, [effectiveThinkingMap])

  const providers = useMemo(
    () =>
      providerRowsOf(
        providersQuery.data,
        modelsData,
        thinkingLabelMap,
        modelsConfigQuery.data,
        configuredEnabledModels,
      ),
    [providersQuery.data, modelsData, thinkingLabelMap, modelsConfigQuery.data, configuredEnabledModels],
  )
  const providerFold = useMemo(() => splitSettingsProviders(providers), [providers])
  const [providersExpanded, setProvidersExpanded] = useState(false)
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({})
  const [providerModal, setProviderModal] = useState<{ open: boolean; initial: ModelConfigProvider | null }>({
    open: false,
    initial: null,
  })
  const [modelModal, setModelModal] = useState<{
    open: boolean
    providerId: string
    providerLabel?: string
    initial: ModelConfigModel | null
  }>({ open: false, providerId: "", initial: null })

  const visibleProviders = providersExpanded ? [...providerFold.primary, ...providerFold.folded] : providerFold.primary

  // 写侧：值优先用本次保存成功的 applied（不回读旧 get_settings）。
  const writeHint = readOnlyHintOf(settingsDoc, writer)
  const busy = writer.saving !== null
  const writeDisabled = !writer.canWrite || settingsDoc.phase !== "ready" || busy
  const defaultProvider = effectiveSettingsStringOf(settingsDoc.data, writer.applied, "defaultProvider")
  const defaultModel = effectiveSettingsStringOf(settingsDoc.data, writer.applied, "defaultModel")
  const defaultModelKey = defaultProvider && defaultModel ? `${defaultProvider}/${defaultModel}` : ""
  const thinking = thinkingLevelOf(effectiveSettingsStringOf(settingsDoc.data, writer.applied, "defaultThinkingLevel"))
  const hideThinking = effectiveSettingsBoolOf(settingsDoc.data, writer.applied, "hideThinkingBlock")
  const compactionEnabled = effectiveSettingsBoolOf(settingsDoc.data, writer.applied, "compaction.enabled")
  const reserveTokens = effectiveSettingsIntOf(settingsDoc.data, writer.applied, "compaction.reserveTokens")
  const keepRecentTokens = effectiveSettingsIntOf(settingsDoc.data, writer.applied, "compaction.keepRecentTokens")

  const providersSettled =
    providersQuery.phase === "ready" ||
    providersQuery.phase === "error" ||
    modelsQuery.phase === "ready" ||
    modelsQuery.phase === "error" ||
    modelsConfigQuery.phase === "ready" ||
    modelsConfigQuery.phase === "error"
  const providersFailed =
    providersQuery.phase === "error" &&
    (modelsQuery.phase === "error" || modelsQuery.phase === "idle") &&
    (modelsConfigQuery.phase === "error" || modelsConfigQuery.phase === "idle")

  const modelChoices = useMemo(
    () => configuredModelChoicesOf(providers, defaultProvider, defaultModel),
    [providers, defaultProvider, defaultModel],
  )
  const modelGroups = useMemo(() => defaultModelGroupsOf(providers, defaultModelKey), [providers, defaultModelKey])
  const emptyModelOptionLabel = !ready
    ? "未连上主机"
    : modelsLoading || (!providersSettled && !providersFailed)
      ? "正在读取已配置模型…"
      : providersFailed
        ? "读不到可选模型"
        : "暂无已配置模型（请先在下方配置供应商）"
  const defaultModelOptions = modelChoices.length
    ? [...(defaultModelKey ? [] : [{ value: "", label: "未设置（按 pi 兜底）" }])]
    : [{ value: "", label: emptyModelOptionLabel }]
  const defaultModelFeedback = settingsFeedbackFor(writer.feedback, DEFAULT_MODEL_WRITE_IDS)
  const providerFeedback = settingsFeedbackFor(writer.feedback, PROVIDER_WRITE_IDS)
  const compactionFeedback = settingsFeedbackFor(writer.feedback, COMPACTION_WRITE_IDS)
  const topWriteHint =
    writeHint === SETTINGS_WRITE_PENDING_RESTART_TEXT && writer.feedback ? null : writeHint
  const restart = useSettingsPiRestart(relay, act.notify)
  const restartBanner = settingsPiRestartBannerOf({
    pendingRestart: restart.pendingRestart,
    phase: restart.phase,
    error: restart.error,
    canRestart: restart.target.canRestart,
    unsupportedReason: restart.target.reason,
  })

  const noProviderHint = !ready
    ? "未连上主机，读不到供应商与登录状态"
    : providersFailed && providers.length === 0
      ? "读不到供应商与登录状态（命令不可用）"
      : !providersSettled
        ? "正在读取供应商与登录状态…"
        : providers.length === 0
          ? "本机没有已配置的供应商"
          : ""

  const reloadAllCatalog = () => {
    providersQuery.reload()
    modelsQuery.reload()
    modelsConfigQuery.reload()
  }

  const handleSaveProvider = async (payload: UpsertProviderPayload) => {
    try {
      await settingsRunCommand(relay, "upsert_model_provider", payload)
      reloadAllCatalog()
      act.notify(`已保存供应商「${payload.id}」`)
    } catch (error) {
      throw new Error(commandErrorText(error))
    }
  }

  const handleDeleteProvider = async (providerId: string) => {
    try {
      const res = (await settingsRunCommand(relay, "delete_model_provider", { id: providerId })) as { deleted?: boolean } | undefined
      reloadAllCatalog()
      if (res?.deleted === false) act.notify("该供应商来自环境变量或内置目录，无法从配置文件删除", "warn")
      else act.notify(`已删除供应商「${providerId}」`)
    } catch (error) {
      throw new Error(commandErrorText(error))
    }
  }

  const handleSaveModel = async (payload: UpsertModelPayload) => {
    try {
      await settingsRunCommand(relay, "upsert_provider_model", payload)
      reloadAllCatalog()
      act.notify(`已保存模型「${payload.model.id}」`)
    } catch (error) {
      throw new Error(commandErrorText(error))
    }
  }

  const handleDeleteModel = async (providerId: string, modelId: string) => {
    try {
      await settingsRunCommand(relay, "delete_provider_model", { provider: providerId, modelId })
      reloadAllCatalog()
      act.notify(`已删除模型「${modelId}」`)
    } catch (error) {
      throw new Error(commandErrorText(error))
    }
  }

  return (
    <div className="settings-page" data-settings-page="model">
      <SettingsPageTitle title="模型与会话" />

      {/* 组 1：默认模型 */}
      <SettingsGroup label="默认模型" first>
        <SettingsSelect
          label="默认模型"
          tooltip="成对写入设备 settings.json 的 defaultProvider 与 defaultModel，仅对新建会话生效。"
          value={defaultModelKey}
          options={defaultModelOptions}
          groups={modelChoices.length ? modelGroups : undefined}
          disabled={writeDisabled || modelChoices.length === 0}
          onChange={(value) => {
            const choice = modelChoices.find((item) => item.key === value)
            if (choice) void writer.save("defaultModel", defaultModelPatch(choice.provider, choice.modelId))
          }}
        />
        <SettingsSelect
          label="默认思考等级"
          tooltip={MODEL_THINKING_LEVELS_COPY}
          value={thinking ?? ""}
          options={[THINKING_UNSET, ...THINKING_OPTIONS]}
          disabled={writeDisabled}
          onChange={(value) => {
            void writer.save("defaultThinkingLevel", defaultThinkingLevelPatch(value || null))
          }}
        />
        <SettingsRow
          title="显示思考过程"
          tooltip="控制是否在对话流中展示模型的推理思考块；修改后需重启 Pi 生效。"
        >
          <SettingsSwitch
            label="显示思考过程"
            checked={hideThinking === false}
            disabled={writeDisabled || hideThinking === null}
            onChange={(checked) => {
              void writer.save("hideThinkingBlock", hideThinkingBlockPatch(!checked))
            }}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsWriteNote feedback={defaultModelFeedback} fallback={topWriteHint} />

      {/* 组 2：供应商与模型管理 */}
      <SettingsGroup label="供应商">
        {providers.length === 0 ? (
          <SettingsRow title="供应商清单" description={noProviderHint} status="existing">
            <span className="settings-value">—</span>
          </SettingsRow>
        ) : (
          <>
            {visibleProviders.length === 0 ? (
              <SettingsRow
                title="尚未配置模型供应商"
                description="点击下方「添加供应商」配置自定义接口，或展开内置目录填入 API 密钥"
              />
            ) : null}
            {visibleProviders.map((provider) => {
              const compactUnconfigured = isBuiltInUnconfiguredProvider(provider)
              if (compactUnconfigured) {
                return (
                  <SettingsActionRow
                    key={provider.id}
                    title={<ProviderTitle provider={provider} />}
                    description={
                      <>
                        <ProviderMeta provider={provider} />
                        {provider.models.length > 0 ? ` · 内置 ${provider.models.length} 个模型` : null}
                      </>
                    }
                    disabled={!ready}
                    value="配置"
                    onClick={() =>
                      setProviderModal({
                        open: true,
                        initial: provider.customConfig ?? {
                          id: provider.id,
                          name: provider.name,
                          inModelsJson: false,
                          inAuthJson: false,
                          hasApiKey: provider.configured === true,
                          models: [],
                        },
                      })
                    }
                  />
                )
              }
              const overflow = providerModelOverflowOf(provider)
              const isExpanded = expandedProviders[provider.id] === true
              const shown = isExpanded ? provider.models : provider.models.slice(0, MODEL_PROVIDER_MODEL_LIMIT)
              return (
                <Fragment key={provider.id}>
                  <SettingsActionRow
                    title={<ProviderTitle provider={provider} />}
                    description={<ProviderMeta provider={provider} />}
                    disabled={!ready}
                    value="配置"
                    onClick={() =>
                      setProviderModal({
                        open: true,
                        initial: provider.customConfig ?? {
                          id: provider.id,
                          name: provider.name,
                          inModelsJson: false,
                          inAuthJson: false,
                          hasApiKey: provider.configured === true,
                          models: [],
                        },
                      })
                    }
                  />
                  {provider.models.length === 0 && !modelsLoading && modelsConfigQuery.phase !== "loading" ? (
                    <SettingsRow
                      title="尚未添加模型"
                      description="点击下方「添加模型」填入模型 ID（如 deepseek-chat、gpt-4o）后即可在对话与默认模型中使用"
                    />
                  ) : null}
                  {shown.map((model) => {
                    const perModelLevel = effectiveThinkingMap[model.key] ?? ""
                    return (
                      <SettingsRow key={model.key} title={<span style={MONO}>{model.label}</span>}>
                        <span className="settings-model-row-controls">
                          <span className="settings-select-wrap">
                            <select
                              aria-label={`${model.label} 思考等级`}
                              className="settings-inline-select"
                              value={perModelLevel}
                              disabled={writeDisabled}
                              onChange={(event) => {
                                const nextVal = event.target.value as SettingsThinkingLevel | ""
                                const nextMap: Record<string, SettingsThinkingLevel | null> = { ...effectiveThinkingMap }
                                nextMap[model.key] = nextVal || null
                                void writer.save("modelThinkingLevels", modelThinkingLevelsPatch(nextMap))
                              }}
                            >
                              <option value="">Thinking · Default</option>
                              {THINKING_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  Thinking · {opt.label}
                                </option>
                              ))}
                            </select>
                            <ChevronDown size={13} strokeWidth={2} aria-hidden="true" className="settings-select-chevron" />
                          </span>
                          {model.customModel ? (
                            <button
                              type="button"
                              className="settings-inline-btn"
                              disabled={!ready}
                              onClick={() =>
                                setModelModal({
                                  open: true,
                                  providerId: provider.id,
                                  providerLabel: provider.name,
                                  initial: model.customModel ?? null,
                                })
                              }
                            >
                              编辑
                            </button>
                          ) : null}
                          <SettingsSwitch
                            label={`启用 ${model.label}`}
                            checked={model.enabled}
                            disabled={writeDisabled}
                            onChange={(checked) => {
                              const next = toggledEnabledModelsOf(providers, configuredEnabledModels, model.key, checked)
                              void writer.save("enabledModels", enabledModelsPatch(next))
                            }}
                          />
                        </span>
                      </SettingsRow>
                    )
                  })}
                  <SettingsActionBar>
                    {overflow > 0 ? (
                      <SettingsActionButton
                        title={isExpanded ? "收起模型列表" : `展开另外 ${overflow} 个模型`}
                        hint={isExpanded ? undefined : `共 ${provider.models.length} 个模型，点击查看并逐个配置`}
                        ariaExpanded={isExpanded}
                        onClick={() =>
                          setExpandedProviders((prev) => ({
                            ...prev,
                            [provider.id]: !prev[provider.id],
                          }))
                        }
                      />
                    ) : null}
                    <SettingsActionButton
                      title="添加模型"
                      leading={<Plus size={13} strokeWidth={2} aria-hidden="true" />}
                      disabled={!ready}
                      onClick={() =>
                        setModelModal({
                          open: true,
                          providerId: provider.id,
                          providerLabel: provider.name,
                          initial: null,
                        })
                      }
                    />
                  </SettingsActionBar>
                </Fragment>
              )
            })}
          </>
        )}
        {providerFold.folded.length > 0 ? (
          <SettingsActionRow
            title={providersExpanded ? "收起未配置的供应商" : `另有 ${providerFold.folded.length} 个未配置的供应商`}
            value={providersExpanded ? "收起" : "展开"}
            onClick={() => setProvidersExpanded((open) => !open)}
          />
        ) : null}
      </SettingsGroup>
      <SettingsWriteNote feedback={providerFeedback} />

      <SettingsGroup>
        <SettingsActionBar
          description={
            restartBanner.title !== "重启 Pi"
              ? `${restartBanner.title} · ${restartBanner.description}`
              : modelsHint
          }
        >
          <SettingsActionButton
            title="添加供应商"
            leading={<Plus size={13} strokeWidth={1.8} aria-hidden="true" />}
            disabled={!ready}
            onClick={() => setProviderModal({ open: true, initial: null })}
          />
          <SettingsActionButton
            title="刷新模型目录"
            label={modelsLoading ? "正在读取…" : undefined}
            hint={modelsHint}
            disabled={!refreshReady || modelsLoading}
            onClick={reloadAllCatalog}
          />
          <SettingsActionButton
            title="重启 Pi"
            label={restart.running ? "重启中…" : restartBanner.buttonLabel}
            hint={restartBanner.description}
            disabled={restartBanner.buttonDisabled}
            onClick={restart.requestRestart}
          />
        </SettingsActionBar>
      </SettingsGroup>
      <SettingsPiRestartDialog viewport="desktop" restart={restart} />

      {/* 组 3：上下文压缩（写 compaction.*） */}
      <SettingsGroup label="上下文压缩">
        <SettingsRow
          title="自动压缩长对话"
          tooltip="上下文接近模型窗口上限时，自动将早期历史消息归纳为摘要以释放窗口空间。"
        >
          <SettingsSwitch
            label="自动压缩长对话"
            checked={compactionEnabled === true}
            disabled={writeDisabled || compactionEnabled === null}
            onChange={(checked) => {
              void writer.save("compaction.enabled", compactionEnabledPatch(checked))
            }}
          />
        </SettingsRow>
        <SettingsSelect
          label="给回复预留"
          tooltip="触发上下文压缩时为模型下一轮输出与工具调用预留的安全缓冲 Token 数（上下文超「窗口上限 − 预留值」即触发压缩）。"
          value={reserveTokens === null ? "" : String(reserveTokens)}
          options={tokenOptions(reserveTokens)}
          disabled={writeDisabled}
          onChange={(value) => {
            if (value) void writer.save("compaction.reserveTokens", tokenBudgetPatch("reserveTokens", Number(value)))
          }}
        />
        <SettingsSelect
          label="近期原文保留"
          tooltip="执行上下文压缩时在末尾完整保留最近多少 Token 的原始对话不参与摘要，避免丢失近期细节。"
          value={keepRecentTokens === null ? "" : String(keepRecentTokens)}
          options={tokenOptions(keepRecentTokens)}
          disabled={writeDisabled}
          onChange={(value) => {
            if (value) void writer.save("compaction.keepRecentTokens", tokenBudgetPatch("keepRecentTokens", Number(value)))
          }}
        />
      </SettingsGroup>
      <SettingsWriteNote feedback={compactionFeedback} />

      {/* 组 4：新会话（本机偏好，写入 localStorage 并应用于新建会话首条消息） */}
      <SettingsGroup label="新会话">
        <SettingsRadioGroup
          label="默认模式"
          tooltip="选择「仅提问」时，会在新会话发送首条消息时自动切换为只读工具集。"
          value={prefs.newSessionMode}
          options={NEW_SESSION_OPTIONS}
          onChange={(value) => act.setPref("newSessionMode", value)}
        />
        <SettingsRow title="新会话自动生成标题">
          <SettingsSwitch
            label="新会话自动生成标题"
            checked={prefs.newSessionAutoTitle}
            onChange={(checked) => act.setPref("newSessionAutoTitle", checked)}
          />
        </SettingsRow>
      </SettingsGroup>

      <ProviderConfigModal
        open={providerModal.open}
        initialProvider={providerModal.initial}
        onClose={() => setProviderModal({ open: false, initial: null })}
        onSave={handleSaveProvider}
        onDelete={
          providerModal.initial && (providerModal.initial.inModelsJson || providerModal.initial.inAuthJson)
            ? handleDeleteProvider
            : undefined
        }
      />
      <ModelConfigModal
        open={modelModal.open}
        providerId={modelModal.providerId}
        providerLabel={modelModal.providerLabel}
        initialModel={modelModal.initial}
        onClose={() => setModelModal({ open: false, providerId: "", initial: null })}
        onSave={handleSaveModel}
        onDelete={modelModal.initial ? handleDeleteModel : undefined}
      />
    </div>
  )
}
