/**
 * 手机端设置 · 模型与会话（移动压缩版）。
 *
 *   ● 默认模型 / 默认思考等级 / 显示思考过程 / enabledModels / modelThinkingLevels / compaction.*：
 *     经 settings_set 写全局 settings.json（有会话走房间命令，无会话走设备直连命令）；
 *   ● 供应商与自定义模型（get_models_config / upsert_model_provider / delete_model_provider /
 *     upsert_provider_model / delete_provider_model）：直写所连设备 models.json / auth.json；
 *   ○ 新会话默认模式与自动标题：本机偏好（立即生效并持久化）。
 */
import { useEffect, useMemo, useState } from "react"
import { Plus } from "lucide-react"
import { commandErrorText } from "@/pi/containers/cShared"
import { thinkingLevelZh } from "@/pi/model/models"
import { useSettings } from "../../SettingsContext.tsx"
import { hostCommandsReady, useHostCommand } from "../data.ts"
import {
  MODEL_NEW_SESSION_MODES,
  MODEL_PROVIDER_MODEL_LIMIT,
  MODEL_THINKING_LEVELS,
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
} from "../../pages/modelData.ts"
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
  settingsRunCommand,
  thinkingLevelOf,
  tokenBudgetPatch,
  type SettingsThinkingLevel,
} from "../../pages/settingsWrite.ts"
import { readOnlyHintOf, settingsFeedbackFor, useSettingsDocument, useSettingsWriter } from "../../pages/settingsWriteHooks.ts"
import { MobileSettingsWriteNote } from "../../pages/settingsWriteFeedback.tsx"
import { settingsPiRestartBannerOf } from "../../pages/settingsPiRestart.ts"
import { SettingsPiRestartDialog, useSettingsPiRestart } from "../../pages/useSettingsPiRestart.tsx"
import {
  ModelConfigModal,
  ProviderConfigModal,
  type ModelConfigModel,
  type ModelConfigProvider,
  type UpsertModelPayload,
  type UpsertProviderPayload,
} from "../../ui.tsx"
import {
  MobileActionBar,
  MobileActionButton,
  MobileActionRow,
  MobileCard,
  MobileEmpty,
  MobileField,
  MobileGroup,
  MobileNote,
  MobilePageBody,
  MobileRow,
  MobileSelect,
  MobileStatusLine,
  MobileSwitch,
  MobileSwitchRow,
} from "../atoms.tsx"

const NEW_SESSION_MODES = MODEL_NEW_SESSION_MODES.map((m) => ({ value: m.value, label: m.label }))

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

const MODEL_WRITE_IDS = ["defaultModel", "defaultThinkingLevel", "hideThinkingBlock"] as const
const PROVIDER_WRITE_IDS = ["enabledModels", "modelThinkingLevels"] as const
const COMPACTION_WRITE_IDS = ["compaction.enabled", "compaction.reserveTokens", "compaction.keepRecentTokens"] as const

export function ModelPage() {
  const { p, prefs, act } = useSettings()
  const { relay } = p
  const ready = hostCommandsReady(relay)
  const targetKey = `${relay.selectedDeviceId ?? ""}:${relay.roomId ?? ""}`
  const settingsDoc = useSettingsDocument(relay)
  const writer = useSettingsWriter(relay)
  const providersQuery = useHostCommand(relay, "get_provider_auth", ready, targetKey)
  const modelsQuery = useHostCommand(relay, "get_available_models", ready, targetKey)
  const modelsConfigQuery = useHostCommand(relay, "get_models_config", ready, targetKey)

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

  const writeHint = readOnlyHintOf(settingsDoc, writer)
  const writeDisabled = !writer.canWrite || settingsDoc.phase !== "ready" || writer.saving !== null
  const defaultProvider = effectiveSettingsStringOf(settingsDoc.data, writer.applied, "defaultProvider")
  const defaultModel = effectiveSettingsStringOf(settingsDoc.data, writer.applied, "defaultModel")
  const defaultModelKey = defaultProvider && defaultModel ? `${defaultProvider}/${defaultModel}` : null
  const thinking = thinkingLevelOf(effectiveSettingsStringOf(settingsDoc.data, writer.applied, "defaultThinkingLevel"))
  const hideThinking = effectiveSettingsBoolOf(settingsDoc.data, writer.applied, "hideThinkingBlock")
  const autoCompaction = effectiveSettingsBoolOf(settingsDoc.data, writer.applied, "compaction.enabled")
  const reserveTokens = effectiveSettingsIntOf(settingsDoc.data, writer.applied, "compaction.reserveTokens")
  const keepRecentTokens = effectiveSettingsIntOf(settingsDoc.data, writer.applied, "compaction.keepRecentTokens")

  // 刷新时保留上一次成功读到的模型清单（loading / error 不把旧数据清空）。
  const [lastModels, setLastModels] = useState<{ key: string; data: unknown } | null>(null)
  useEffect(() => {
    if (modelsQuery.phase === "ready") setLastModels({ key: targetKey, data: modelsQuery.data })
  }, [modelsQuery.phase, modelsQuery.data, targetKey])
  const lastModelsData = lastModels?.key === targetKey ? lastModels.data : undefined
  const modelsData = modelsQuery.phase === "ready" ? modelsQuery.data : lastModelsData

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
  const modelGroups = useMemo(() => defaultModelGroupsOf(providers, defaultModelKey ?? ""), [providers, defaultModelKey])
  const emptyModelLabel = !ready
    ? "未连上主机"
    : modelsQuery.phase === "loading" || (!providersSettled && !providersFailed)
      ? "正在读取已配置模型…"
      : providersFailed
        ? "读不到可选模型"
        : "暂无已配置模型（请先在下方配置供应商）"
  const modelOptions = modelChoices.length
    ? [...(defaultModelKey ? [] : [{ value: "", label: "未设置（按 pi 兜底）" }])]
    : [{ value: "", label: emptyModelLabel }]
  const thinkingOptions = [
    { value: "", label: "未设置（按模型兜底）" },
    ...MODEL_THINKING_LEVELS.map((level) => ({ value: level, label: ChineseThinking(level) })),
  ]
  const modelFeedback = settingsFeedbackFor(writer.feedback, MODEL_WRITE_IDS)
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

  const modelCount = modelChoices.length
  const modelsLoading = modelsQuery.phase === "loading"
  const modelsValue = modelsLoading
    ? "正在读取…"
    : lastModelsData != null
      ? modelCount > 0
        ? `${modelCount} 个可用模型`
        : "暂无可用模型"
      : undefined
  const refreshHint = !ready
    ? "连接主机后可重新读取模型清单"
    : modelsLoading
      ? "正在读取模型清单…"
      : modelsQuery.phase === "error"
        ? `读取失败：${modelsQuery.error}${lastModelsData != null ? "；仍显示上次读取的清单" : ""}`
        : undefined

  const providersEmpty = !ready
    ? "未连上主机，读不到供应商与登录状态"
    : providersQuery.phase === "loading" || modelsConfigQuery.phase === "loading"
      ? "正在读取供应商与登录状态…"
      : providersQuery.phase === "error" && modelsConfigQuery.phase === "error"
        ? "读不到供应商与登录状态（命令不可用）"
        : "本机没有已配置的供应商"

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
    <MobilePageBody page="model">
      <MobileGroup label="默认模型">
        <MobileSelect
          label="默认模型"
          tooltip="成对写入设备 settings.json 的 defaultProvider 与 defaultModel，仅对新建会话生效。"
          value={defaultModelKey ?? ""}
          options={modelOptions}
          groups={modelChoices.length ? modelGroups : undefined}
          disabled={writeDisabled || modelChoices.length === 0}
          onChange={(value) => {
            const choice = modelChoices.find((item) => item.key === value)
            if (choice) void writer.save("defaultModel", defaultModelPatch(choice.provider, choice.modelId))
          }}
        />
        <MobileSelect
          label="默认思考等级"
          tooltip={MODEL_THINKING_LEVELS_COPY}
          value={thinking ?? ""}
          options={thinkingOptions}
          disabled={writeDisabled}
          onChange={(value) => {
            void writer.save("defaultThinkingLevel", defaultThinkingLevelPatch(value || null))
          }}
        />
        <MobileSwitchRow
          title="显示思考过程"
          tooltip="控制是否在对话流中展示模型的推理思考块；修改后需重启 Pi 生效。"
          checked={hideThinking === false}
          disabled={writeDisabled || hideThinking === null}
          onChange={(checked) => {
            void writer.save("hideThinkingBlock", hideThinkingBlockPatch(!checked))
          }}
        />
      </MobileGroup>
      <MobileSettingsWriteNote feedback={modelFeedback} fallback={topWriteHint} />

      <MobileGroup label="供应商" stacked>
        {providers.length === 0 ? (
          <MobileCard>
            <MobileEmpty title="供应商清单" body={providersEmpty} />
          </MobileCard>
        ) : (
          <>
            {visibleProviders.length === 0 ? (
              <MobileCard>
                <MobileEmpty
                  title="尚未配置模型供应商"
                  body="点击下方「添加供应商」配置自定义接口，或展开内置供应商填入 API 密钥"
                />
              </MobileCard>
            ) : null}
            {visibleProviders.map((provider) => {
              const compactUnconfigured = isBuiltInUnconfiguredProvider(provider)
              if (compactUnconfigured) {
                return (
                  <MobileCard key={provider.id}>
                    <MobileActionRow
                      title={
                        <span className="sm-provider-head">
                          <span className="sm-provider-name">{provider.name}</span>
                          <MobileStatusLine tone="offline">未连接</MobileStatusLine>
                        </span>
                      }
                      description={
                        `${provider.endpoint ? `${provider.endpoint} · ` : ""}未配置密钥${provider.models.length > 0 ? ` · 内置 ${provider.models.length} 个模型` : ""}`
                      }
                      value="配置"
                      disabled={!ready}
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
                  </MobileCard>
                )
              }
              const overflow = providerModelOverflowOf(provider)
              const isExpanded = expandedProviders[provider.id] === true
              const shown = isExpanded ? provider.models : provider.models.slice(0, MODEL_PROVIDER_MODEL_LIMIT)
              return (
                <MobileCard key={provider.id}>
                  <MobileActionRow
                    title={
                      <span className="sm-provider-head">
                        <span className="sm-provider-name">{provider.name}</span>
                        <MobileStatusLine tone={provider.state === "connected" ? "online" : "offline"}>
                          {provider.state === "connected" ? "已连接" : provider.state === "disconnected" ? "未连接" : "状态未知"}
                        </MobileStatusLine>
                      </span>
                    }
                    description={
                      `${provider.endpoint ? `${provider.endpoint} · ` : ""}${provider.configured ? "密钥已配置" : "未配置密钥"}`
                    }
                    value="配置"
                    disabled={!ready}
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
                    <MobileRow title="尚未添加模型" description="点击下方「添加模型」填入模型 ID 后即可使用" />
                  ) : null}
                  {shown.map((model) => {
                    const perModelLevel = effectiveThinkingMap[model.key] ?? ""
                    return (
                      <MobileRow
                        key={model.key}
                        title={model.label}
                        description={
                          <span className="sm-inline-controls">
                            <select
                              aria-label={`${model.label} 思考等级`}
                              className="sm-inline-select"
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
                              {MODEL_THINKING_LEVELS.map((lvl) => (
                                <option key={lvl} value={lvl}>
                                  Thinking · {ChineseThinking(lvl)}
                                </option>
                              ))}
                            </select>
                            {model.customModel ? (
                              <button
                                type="button"
                                className="sm-inline-btn"
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
                          </span>
                        }
                      >
                        <MobileSwitch
                          label={`启用 ${model.label}`}
                          checked={model.enabled}
                          disabled={writeDisabled}
                          onChange={(checked) => {
                            const next = toggledEnabledModelsOf(providers, configuredEnabledModels, model.key, checked)
                            void writer.save("enabledModels", enabledModelsPatch(next))
                          }}
                        />
                      </MobileRow>
                    )
                  })}
                  <MobileActionBar>
                    {overflow > 0 ? (
                      <MobileActionButton
                        title={isExpanded ? "收起模型列表" : `展开另外 ${overflow} 个模型`}
                        ariaExpanded={isExpanded}
                        onClick={() =>
                          setExpandedProviders((prev) => ({
                            ...prev,
                            [provider.id]: !prev[provider.id],
                          }))
                        }
                      />
                    ) : null}
                    <MobileActionButton
                      title="添加模型"
                      hint="添加该供应商下的模型 ID"
                      leading={<Plus size={14} strokeWidth={2} aria-hidden="true" />}
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
                  </MobileActionBar>
                </MobileCard>
              )
            })}
          </>
        )}
        {providerFold.folded.length > 0 ? (
          <MobileCard>
            <MobileActionRow
              title={providersExpanded ? "收起未配置的供应商" : `另有 ${providerFold.folded.length} 个未配置的供应商`}
              value={providersExpanded ? "收起" : "展开"}
              onClick={() => setProvidersExpanded((open) => !open)}
            />
          </MobileCard>
        ) : null}
        <MobileCard>
          <MobileActionBar
            description={
              restartBanner.title !== "重启 Pi"
                ? `${restartBanner.title} · ${restartBanner.description}`
                : refreshHint
            }
          >
            <MobileActionButton
              title="添加供应商"
              leading={<Plus size={14} strokeWidth={2} aria-hidden="true" />}
              disabled={!ready}
              onClick={() => setProviderModal({ open: true, initial: null })}
            />
            <MobileActionButton
              title="刷新模型目录"
              label={modelsValue}
              hint={refreshHint}
              disabled={!ready || modelsLoading}
              onClick={reloadAllCatalog}
            />
            <MobileActionButton
              title="重启 Pi"
              label={restart.running ? "重启中…" : restartBanner.buttonLabel}
              hint={restartBanner.description}
              disabled={restartBanner.buttonDisabled}
              onClick={restart.requestRestart}
            />
          </MobileActionBar>
        </MobileCard>
      </MobileGroup>
      <SettingsPiRestartDialog viewport="phone" restart={restart} />
      <MobileSettingsWriteNote feedback={providerFeedback} />

      <MobileGroup label="上下文压缩">
        <MobileSwitchRow
          title="自动压缩长对话"
          tooltip="上下文接近模型窗口上限时，自动将早期历史消息归纳为摘要以释放窗口空间。"
          checked={autoCompaction === true}
          disabled={writeDisabled || autoCompaction === null}
          onChange={(checked) => {
            void writer.save("compaction.enabled", compactionEnabledPatch(checked))
          }}
        />
        <MobileSelect
          label="给回复预留"
          tooltip="触发上下文压缩时为模型下一轮输出与工具调用预留的安全缓冲 Token 数（上下文超「窗口上限 − 预留值」即触发压缩）。"
          value={reserveTokens === null ? "" : String(reserveTokens)}
          options={tokenOptions(reserveTokens)}
          disabled={writeDisabled}
          onChange={(value) => {
            if (value) void writer.save("compaction.reserveTokens", tokenBudgetPatch("reserveTokens", Number(value)))
          }}
        />
        <MobileSelect
          label="近期原文保留"
          tooltip="执行上下文压缩时在末尾完整保留最近多少 Token 的原始对话不参与摘要，避免丢失近期细节。"
          value={keepRecentTokens === null ? "" : String(keepRecentTokens)}
          options={tokenOptions(keepRecentTokens)}
          disabled={writeDisabled}
          onChange={(value) => {
            if (value) void writer.save("compaction.keepRecentTokens", tokenBudgetPatch("keepRecentTokens", Number(value)))
          }}
        />
      </MobileGroup>
      <MobileSettingsWriteNote feedback={compactionFeedback} />

      <MobileGroup label="新会话">
        <MobileField
          title="默认模式"
          tooltip="选择「仅提问」时，会在新会话发送首条消息时自动切换为只读工具集。"
          value={prefs.newSessionMode}
          options={NEW_SESSION_MODES}
          onChange={(value) => act.setPref("newSessionMode", value)}
        />
        <MobileSwitchRow
          title="新会话自动生成标题"
          checked={prefs.newSessionAutoTitle}
          onChange={(checked) => act.setPref("newSessionAutoTitle", checked)}
        />
      </MobileGroup>

      {settingsDoc.phase === "error" && settingsDoc.error ? (
        <MobileNote>设置读取失败：{settingsDoc.error}</MobileNote>
      ) : null}
      {providersQuery.phase === "error" && providersQuery.error ? (
        <MobileNote>供应商读取失败：{providersQuery.error}</MobileNote>
      ) : null}
      {modelsQuery.phase === "error" && modelsQuery.error && lastModelsData == null ? (
        <MobileNote>模型目录读取失败：{modelsQuery.error}</MobileNote>
      ) : null}

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
    </MobilePageBody>
  )
}

/** 七档英文名（与 pi 的 level id 对齐；不认识的档位原样显示）。 */
function ChineseThinking(level: string): string {
  return thinkingLevelZh(level)
}
