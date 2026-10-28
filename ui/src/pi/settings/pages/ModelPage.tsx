/**
 * 设置 › 模型与会话（设计册第 4 节，v3 定稿）。
 *
 * 分组与文案逐条照设计图：默认模型 / 供应商 / 上下文压缩 / 新会话。
 * 落地状态（设计册 §4）：
 *   ● 默认模型、默认思考等级、显示思考过程：经 settings_set 写全局 settings.json；
 *     默认模型成对写 defaultProvider + defaultModel，保存后提示重启 pi；
 *   ● 自动压缩长对话、给回复预留、近期原文保留：compaction.enabled / reserveTokens / keepRecentTokens；
 *   ◐ 卡内模型开关、每模型默认思考、添加模型 / 添加供应商 / 密钥管理、新会话默认模式与自动生成标题：
 *     继续只读（写桥白名单未包含 enabledModels / modelThinkingLevels，pi 1.3 也没有新会话字段）；
 *   ● 供应商清单、登录状态、接口地址、密钥是否配置：读 get_provider_auth + 模型清单，只读；
 *   ● 刷新模型目录：真的重发 get_available_models（重新向 pi 读取，不联网下载）；
 *     读取中显示状态、失败保留上次成功读到的清单并提示。
 *
 * 本页没有任何本机偏好（没有 ○ 项），所以不写 localStorage、不调 act.setPref。
 * 读不到的值写「—」，不拿当前会话的模型 / 思考档冒充持久默认值。
 */
import { Fragment, useEffect, useMemo, useState, type CSSProperties } from "react"
import { Plus } from "lucide-react"
import { commandsReady, useRelayCommand } from "@/pi/containers/cShared"
import { settingsDeviceOfflineOf } from "../model"
import { useSettings } from "../SettingsContext"
import {
  MODEL_NEW_SESSION_DEFAULT,
  MODEL_NEW_SESSION_MODES,
  MODEL_PROVIDER_MODEL_LIMIT,
  MODEL_THINKING_LEVELS,
  MODEL_THINKING_LEVEL_LABELS,
  MODEL_THINKING_LEVELS_COPY,
  modelSettingsOf,
  providerModelOverflowOf,
  providerRowsOf,
  tokenCountLabel,
  type ModelNewSessionMode,
  type ProviderRow,
} from "./modelData"
import {
  SETTINGS_WRITE_REMAINING_READONLY_NOTE,
  compactionEnabledPatch,
  defaultModelPatch,
  defaultThinkingLevelPatch,
  effectiveSettingsBoolOf,
  effectiveSettingsIntOf,
  effectiveSettingsStringOf,
  hideThinkingBlockPatch,
  thinkingLevelOf,
  tokenBudgetPatch,
} from "./settingsWrite.ts"
import { readOnlyHintOf, settingsFeedbackFor, useSettingsDocument, useSettingsWriter } from "./settingsWriteHooks.ts"
import { SettingsWriteNote } from "./settingsWriteFeedback.tsx"
import {
  SettingsActionRow,
  SettingsGroup,
  SettingsNote,
  SettingsPageTitle,
  SettingsRadioGroup,
  SettingsRow,
  SettingsSelect,
  SettingsStatusDot,
  SettingsSwitch,
} from "../ui"

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
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}
      data-settings-provider={provider.id}
    >
      <span style={{ fontSize: 14, fontWeight: 600 }}>{provider.name}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--st-text-3)" }}>
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
  const { p } = useSettings()
  const { relay } = p
  const ready = commandsReady(relay) && relay.browserOnline
  // 设备心跳离线时命令发不出去：刷新模型目录必须禁用并说清原因，不能点了没反应。
  const deviceOffline = settingsDeviceOfflineOf(relay)
  const refreshReady = ready && !deviceOffline
  const roomKey = relay.roomId ?? ""

  const settingsDoc = useSettingsDocument(relay)
  const writer = useSettingsWriter(relay)
  const providersQuery = useRelayCommand(relay.runCommand, ready ? "get_provider_auth" : null, undefined, roomKey)
  const modelsQuery = useRelayCommand(relay.runCommand, ready ? "get_available_models" : null, undefined, roomKey)

  // 刷新时保留上一次成功读到的模型清单（loading / error 不把旧数据清空）。
  const [lastModels, setLastModels] = useState<{ room: string; data: unknown } | null>(null)
  useEffect(() => {
    if (modelsQuery.phase === "ready") setLastModels({ room: roomKey, data: modelsQuery.data })
  }, [modelsQuery.phase, modelsQuery.data, roomKey])
  const lastModelsData = lastModels?.room === roomKey ? lastModels.data : undefined
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
          : "重新向 pi 读取模型清单"

  const settingsView = useMemo(() => modelSettingsOf(settingsDoc.data), [settingsDoc.data])
  const providers = useMemo(
    () => providerRowsOf(providersQuery.data, modelsData, settingsView.modelThinkingLevels),
    [providersQuery.data, modelsData, settingsView.modelThinkingLevels],
  )
  const newSessionMode: ModelNewSessionMode = MODEL_NEW_SESSION_DEFAULT

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

  // 默认模型下拉：以本机认证可用的模型清单为准；当前默认值不在清单里时补一项（仍可原样保留）。
  const modelChoices = useMemo(() => {
    const choices: { key: string; provider: string; modelId: string; label: string }[] = []
    for (const provider of providers) {
      for (const model of provider.models) {
        choices.push({ key: model.key, provider: model.provider, modelId: model.modelId, label: model.label })
      }
    }
    if (defaultProvider && defaultModel && !choices.some((choice) => choice.key === defaultModelKey)) {
      choices.unshift({ key: defaultModelKey, provider: defaultProvider, modelId: defaultModel, label: defaultModelKey })
    }
    return choices
  }, [providers, defaultProvider, defaultModel, defaultModelKey])
  const defaultModelOptions = modelChoices.length
    ? [
        ...(defaultModelKey ? [] : [{ value: "", label: "未设置（按 pi 兜底）" }]),
        ...modelChoices.map((choice) => ({ value: choice.key, label: choice.label })),
      ]
    : [{ value: "", label: "读不到可选模型" }]
  const defaultModelFeedback = settingsFeedbackFor(writer.feedback, DEFAULT_MODEL_WRITE_IDS)
  const compactionFeedback = settingsFeedbackFor(writer.feedback, COMPACTION_WRITE_IDS)

  const providersSettled =
    providersQuery.phase === "ready" ||
    providersQuery.phase === "error" ||
    modelsQuery.phase === "ready" ||
    modelsQuery.phase === "error"
  const providersFailed = providersQuery.phase === "error" && (modelsQuery.phase === "error" || modelsQuery.phase === "idle")
  const noProviderHint = !ready
    ? "未连上主机，读不到供应商与登录状态"
    : providersFailed && providers.length === 0
      ? "读不到供应商与登录状态（只读命令不可用）"
      : !providersSettled
        ? "正在读取供应商与登录状态…"
        : providers.length === 0
          ? "本机没有已配置的供应商"
          : ""

  return (
    <div className="settings-page" data-settings-page="model">
      <SettingsPageTitle title="模型与会话" />

      {/* 组 1：默认模型（写 settings_set；默认模型成对写 provider + model） */}
      <SettingsGroup label="默认模型" first>
        <SettingsSelect
          label="默认模型"
          description="成对保存 defaultProvider + defaultModel；只影响新会话"
          value={defaultModelKey}
          options={defaultModelOptions}
          disabled={writeDisabled || modelChoices.length === 0}
          onChange={(value) => {
            const choice = modelChoices.find((item) => item.key === value)
            if (choice) void writer.save("defaultModel", defaultModelPatch(choice.provider, choice.modelId))
          }}
        />
        <SettingsSelect
          label="默认思考等级"
          description={MODEL_THINKING_LEVELS_COPY}
          value={thinking ?? ""}
          options={[THINKING_UNSET, ...THINKING_OPTIONS]}
          disabled={writeDisabled}
          onChange={(value) => {
            if (value) void writer.save("defaultThinkingLevel", defaultThinkingLevelPatch(value))
          }}
        />
        <SettingsRow title="显示思考过程" description="关闭后不显示模型的思考过程；保存后需重启 pi 生效">
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
      <SettingsWriteNote feedback={defaultModelFeedback} fallback={writeHint} />

      {/* 组 2：供应商 */}
      <SettingsGroup label="供应商">
        {providers.length === 0 ? (
          <SettingsRow title="供应商清单" description={noProviderHint} status="existing">
            <span className="settings-value">—</span>
          </SettingsRow>
        ) : (
          providers.map((provider) => {
            const shown = provider.models.slice(0, MODEL_PROVIDER_MODEL_LIMIT)
            const overflow = providerModelOverflowOf(provider)
            return (
              <Fragment key={provider.id}>
                {/* 登录状态 ● 只读；「管理」（密钥管理）是 ◐，所以整行按只读动作呈现。 */}
                <SettingsActionRow
                  title={<ProviderTitle provider={provider} />}
                  description={<ProviderMeta provider={provider} />}
                  status="bridge"
                  value="管理"
                />
                {shown.map((model) => (
                  <SettingsRow key={model.key} title={<span style={MONO}>{model.label}</span>} status="bridge">
                    {model.thinking ? <span className="settings-value">思考·{model.thinking}</span> : null}
                    {/* 只读：开关反映 pi 的「认证可用」清单；持久启停名单（enabledModels）要扩展桥才读得到。 */}
                    <SettingsSwitch
                      label={`${model.label}（只读，反映认证可用；精确启停需扩展桥）`}
                      checked={model.enabled}
                      disabled
                    />
                  </SettingsRow>
                ))}
                {overflow > 0 ? (
                  <SettingsRow
                    title={`另有 ${overflow} 个模型`}
                    description={`本页只列前 ${MODEL_PROVIDER_MODEL_LIMIT} 个；完整清单在会话内的模型选择器里`}
                    status="existing"
                  />
                ) : null}
                {/* 卡内模型开关 / 添加模型都是 ◐：不可编辑，保留设计形态。 */}
                <SettingsRow
                  title={
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <Plus size={13} strokeWidth={2} aria-hidden="true" />
                      添加模型
                    </span>
                  }
                  status="bridge"
                >
                  <span className="settings-value">手动填入模型名</span>
                </SettingsRow>
              </Fragment>
            )
          })
        )}
      </SettingsGroup>

      {/* 添加供应商 / 刷新模型目录：设计稿里各占一张独立卡 */}
      <div style={{ marginTop: 10 }}>
        <SettingsGroup first>
          <SettingsActionRow
            title={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Plus size={13} strokeWidth={1.8} aria-hidden="true" />
                添加供应商
              </span>
            }
            description="填入名称、接口地址与 API 密钥；支持 OpenAI 兼容端点"
            status="bridge"
          />
        </SettingsGroup>
      </div>
      <div style={{ marginTop: 10 }}>
        <SettingsGroup first>
          <SettingsActionRow
            title="刷新模型目录"
            description={modelsHint}
            disabled={!refreshReady || modelsLoading}
            value={modelsLoading ? "正在读取…" : undefined}
            onClick={() => modelsQuery.reload()}
          />
        </SettingsGroup>
      </div>

      {/* 组 3：上下文压缩（写 compaction.*） */}
      <SettingsGroup label="上下文压缩">
        <SettingsRow
          title="自动压缩长对话"
          description="对话太长时自动把旧消息总结成摘要，腾出空间"
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
          description="压缩时为模型回复预留的 token 预算"
          value={reserveTokens === null ? "" : String(reserveTokens)}
          options={tokenOptions(reserveTokens)}
          disabled={writeDisabled}
          onChange={(value) => {
            if (value) void writer.save("compaction.reserveTokens", tokenBudgetPatch("reserveTokens", Number(value)))
          }}
        />
        <SettingsSelect
          label="近期原文保留"
          description="压缩时保留最近多少 token 的原文"
          value={keepRecentTokens === null ? "" : String(keepRecentTokens)}
          options={tokenOptions(keepRecentTokens)}
          disabled={writeDisabled}
          onChange={(value) => {
            if (value) void writer.save("compaction.keepRecentTokens", tokenBudgetPatch("keepRecentTokens", Number(value)))
          }}
        />
      </SettingsGroup>
      <SettingsWriteNote feedback={compactionFeedback} />

      {/* 组 4：新会话（pi 1.3 没有持久字段 / 写桥白名单未开放，保持只读） */}
      <SettingsGroup
        label="新会话"
        description="仍只读：pi 1.3 的 settings 没有新会话默认模式 / 自动生成标题字段，写桥白名单也未开放这两项。"
      >
        <SettingsRadioGroup
          label="默认模式"
          description="新会话默认使用 Agent 还是仅提问"
          value={newSessionMode}
          options={NEW_SESSION_OPTIONS}
          status="bridge"
        />
        <SettingsRow title="新会话自动生成标题" description="按首条消息内容命名" status="bridge">
          <SettingsSwitch label="新会话自动生成标题（只读，无对应字段）" checked disabled />
        </SettingsRow>
      </SettingsGroup>
      <SettingsNote>{SETTINGS_WRITE_REMAINING_READONLY_NOTE}</SettingsNote>
    </div>
  )
}
