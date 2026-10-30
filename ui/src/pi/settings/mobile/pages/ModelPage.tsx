/**
 * 手机端设置 · 模型与会话（移动压缩版）。
 *
 * 状态口径（设计册第 4 节）：
 *   ● 默认模型 / 默认思考等级 / 显示思考过程 / 自动压缩长对话 / 给回复预留 / 近期原文保留：
 *     经 settings_set 写全局 settings.json（默认模型成对写 provider + model）；
 *   ◐ 模型开关 / 每模型思考 / 添加模型与供应商 / 新会话默认模式与自动标题：
 *     继续只读（写桥白名单未包含 enabledModels / modelThinkingLevels，pi 1.3 也没有新会话字段）；
 *   ● 供应商清单与登录状态只读（get_provider_auth）、模型目录（get_available_models；
 *     「刷新模型目录」真的重发这条命令）。
 *
 * 读不到主机回包时显示「—」/ 空态 /「连接主机后…」，不拿当前会话模型或设计稿示例值冒充真实设置。
 */
import { useEffect, useMemo, useState } from "react"
import { Plus } from "lucide-react"
import { thinkingLevelZh } from "@/pi/model/models"
import { useSettings } from "../../SettingsContext.tsx"
import {
  availableModelCountOf,
  hostSettingsOf,
  modelChoicesOf,
  modelGroupsOf,
  modelThinkingRowsOf,
  providersOf,
  settingBool,
} from "../model.ts"
import { hostCommandsReady, useHostCommand } from "../data.ts"
import { MODEL_THINKING_LEVELS, tokenCountLabel } from "../../pages/modelData.ts"
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
} from "../../pages/settingsWrite.ts"
import { readOnlyHintOf, settingsFeedbackFor, useSettingsDocument, useSettingsWriter } from "../../pages/settingsWriteHooks.ts"
import { MobileSettingsWriteNote } from "../../pages/settingsWriteFeedback.tsx"
import {
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

const THINKING_LEVELS_NOTE = "共七档：关 / 最小 / 低 / 中 / 高 / 超高 / 最高"
const NEW_SESSION_MODES = [
  { value: "agent", label: "Agent" },
  { value: "ask", label: "仅提问" },
] as const

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
const COMPACTION_WRITE_IDS = ["compaction.enabled", "compaction.reserveTokens", "compaction.keepRecentTokens"] as const

export function ModelPage() {
  const { p } = useSettings()
  const { relay } = p
  const ready = hostCommandsReady(relay)
  const settingsDoc = useSettingsDocument(relay)
  const writer = useSettingsWriter(relay)
  const providersQuery = useHostCommand(relay, "get_provider_auth", ready, relay.roomId)
  const modelsQuery = useHostCommand(relay, "get_available_models", ready, relay.roomId)
  const settings = hostSettingsOf(settingsDoc.data)
  const providers = providersOf(providersQuery.data)

  // 设置只认 get_settings：读不到就是 —，不拿当前会话的模型 / 思考档冒充持久默认。
  const settingsReady = settingsDoc.phase === "ready"
  const thinkingRows = settingsReady ? modelThinkingRowsOf(settings) : []
  const newSessionAutoTitle = settingBool(settings, ["newSessionAutoTitle", "autoSessionTitle"], true)
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
  const roomKey = relay.roomId ?? ""
  const [lastModels, setLastModels] = useState<{ room: string; data: unknown } | null>(null)
  useEffect(() => {
    if (modelsQuery.phase === "ready") setLastModels({ room: roomKey, data: modelsQuery.data })
  }, [modelsQuery.phase, modelsQuery.data, roomKey])
  const lastModelsData = lastModels?.room === roomKey ? lastModels.data : undefined
  const modelsData = modelsQuery.phase === "ready" ? modelsQuery.data : lastModelsData
  const modelChoices = useMemo(() => {
    const choices = modelChoicesOf(modelsData)
    if (defaultProvider && defaultModel && !choices.some((choice) => choice.key === defaultModelKey)) {
      choices.unshift({ key: `${defaultProvider}/${defaultModel}`, provider: defaultProvider, modelId: defaultModel, label: defaultModel })
    }
    return choices
  }, [modelsData, defaultProvider, defaultModel, defaultModelKey])
  // F7: the default-model options render grouped by provider (see
  // modelGroupsOf in ../model.ts); the flat list keeps only the placeholder.
  const modelGroups = useMemo(() => modelGroupsOf(modelChoices, providers), [modelChoices, providers])
  const modelOptions = modelChoices.length
    ? [...(defaultModelKey ? [] : [{ value: "", label: "未设置（按 pi 兜底）" }])]
    : [{ value: "", label: "读不到可选模型" }]
  const thinkingOptions = [
    { value: "", label: "未设置（按模型兜底）" },
    ...MODEL_THINKING_LEVELS.map((level) => ({ value: level, label: ChineseThinking(level) })),
  ]
  const modelFeedback = settingsFeedbackFor(writer.feedback, MODEL_WRITE_IDS)
  const compactionFeedback = settingsFeedbackFor(writer.feedback, COMPACTION_WRITE_IDS)
  const modelCount = availableModelCountOf(modelsData)
  const modelsLoading = modelsQuery.phase === "loading"
  const modelsValue = modelsLoading
    ? "正在读取…"
    : lastModelsData != null
      ? modelCount > 0
        ? `${modelCount} 个模型`
        : "模型清单为空"
      : undefined
  const refreshHint = !ready
    ? "连接主机后可重新读取模型清单"
    : modelsLoading
      ? "正在读取模型清单…"
      : modelsQuery.phase === "error"
        ? `读取失败：${modelsQuery.error}${lastModelsData != null ? "；仍显示上次读取的清单" : ""}`
        : "重新向 pi 读取模型清单"

  const providersEmpty = !ready
    ? "未连上主机，读不到供应商与登录状态"
    : providersQuery.phase === "loading"
      ? "正在读取供应商与登录状态…"
      : providersQuery.phase === "error"
        ? "读不到供应商与登录状态（只读命令不可用）"
        : "本机没有已配置的供应商"

  return (
    <MobilePageBody page="model">
      <MobileGroup label="默认模型">
        <MobileSelect
          label="默认模型"
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
          value={thinking ?? ""}
          options={thinkingOptions}
          disabled={writeDisabled}
          onChange={(value) => {
            if (value) void writer.save("defaultThinkingLevel", defaultThinkingLevelPatch(value))
          }}
        />
        <MobileSwitchRow
          title="显示思考过程"
          description="关闭后不显示模型的思考过程；保存后需重启 pi 生效"
          checked={hideThinking === false}
          disabled={writeDisabled || hideThinking === null}
          onChange={(checked) => {
            void writer.save("hideThinkingBlock", hideThinkingBlockPatch(!checked))
          }}
        />
      </MobileGroup>
      <MobileNote>{THINKING_LEVELS_NOTE}；默认模型成对保存 defaultProvider + defaultModel，只影响新会话。</MobileNote>
      <MobileSettingsWriteNote feedback={modelFeedback} fallback={writeHint} />

      <MobileGroup label="供应商" stacked>
        <MobileCard>
          {providers.length === 0 ? (
            <MobileEmpty title="供应商清单" body={providersEmpty} />
          ) : (
            providers.map((provider) => (
              <div key={provider.id} className="sm-provider">
                <div className="sm-provider-head">
                  <span className="sm-provider-name">{provider.name}</span>
                  <MobileStatusLine tone={provider.connected ? "online" : "offline"}>
                    {provider.connected ? "已连接" : "未连接"}
                  </MobileStatusLine>
                </div>
                <div className="sm-provider-meta">
                  {provider.models > 0 ? `${provider.models} 个模型 · ` : ""}
                  {provider.configured ? "密钥已配置" : "未配置密钥"}
                  {provider.authSource ? ` · 来源 ${provider.authSource}` : ""}
                </div>
                {thinkingRows.map((row) => (
                  <MobileRow key={row.model} title={row.model} description={`思考·${ChineseThinking(row.level)}`} status="bridge">
                    <MobileSwitch label={`${row.model}（只读）`} checked disabled />
                  </MobileRow>
                ))}
              </div>
            ))
          )}
        </MobileCard>
        <MobileCard>
          <MobileActionRow title="添加模型" description="手动填入模型名" status="bridge" disabled leading={<Plus size={16} strokeWidth={2} aria-hidden="true" />} />
        </MobileCard>
        <MobileCard>
          <MobileActionRow title="添加供应商" description="填入名称、接口地址与 API 密钥；支持 OpenAI 兼容端点" status="bridge" disabled />
        </MobileCard>
        <MobileCard>
          <MobileActionRow
            title="刷新模型目录"
            description={refreshHint}
            value={modelsValue}
            disabled={!ready || modelsLoading}
            onClick={modelsQuery.reload}
          />
        </MobileCard>
      </MobileGroup>

      <MobileGroup label="上下文压缩">
        <MobileSwitchRow
          title="自动压缩长对话"
          description="对话太长时自动把旧消息总结成摘要，腾出空间"
          checked={autoCompaction === true}
          disabled={writeDisabled || autoCompaction === null}
          onChange={(checked) => {
            void writer.save("compaction.enabled", compactionEnabledPatch(checked))
          }}
        />
        <MobileSelect
          label="给回复预留"
          value={reserveTokens === null ? "" : String(reserveTokens)}
          options={tokenOptions(reserveTokens)}
          disabled={writeDisabled}
          onChange={(value) => {
            if (value) void writer.save("compaction.reserveTokens", tokenBudgetPatch("reserveTokens", Number(value)))
          }}
        />
        <MobileSelect
          label="近期原文保留"
          value={keepRecentTokens === null ? "" : String(keepRecentTokens)}
          options={tokenOptions(keepRecentTokens)}
          disabled={writeDisabled}
          onChange={(value) => {
            if (value) void writer.save("compaction.keepRecentTokens", tokenBudgetPatch("keepRecentTokens", Number(value)))
          }}
        />
      </MobileGroup>
      <MobileSettingsWriteNote feedback={compactionFeedback} />

      <MobileGroup
        label="新会话"
        footnote="仍只读：pi 1.3 的 settings 没有新会话默认模式 / 自动生成标题字段，写桥白名单也未开放这两项。"
      >
        <MobileField
          title="默认模式"
          description="新会话默认使用 Agent 还是仅提问（无对应持久字段）"
          status="bridge"
          disabled
          value="agent"
          options={NEW_SESSION_MODES}
        />
        <MobileRow title="新会话自动生成标题" description="按首条消息内容命名" status="bridge">
          <MobileSwitch label="新会话自动生成标题（只读）" checked={newSessionAutoTitle} disabled />
        </MobileRow>
      </MobileGroup>

      <MobileNote>{SETTINGS_WRITE_REMAINING_READONLY_NOTE}</MobileNote>
      {settingsDoc.phase === "error" && settingsDoc.error ? (
        <MobileNote>设置读取失败：{settingsDoc.error}</MobileNote>
      ) : null}
      {providersQuery.phase === "error" && providersQuery.error ? (
        <MobileNote>供应商读取失败：{providersQuery.error}</MobileNote>
      ) : null}
      {modelsQuery.phase === "error" && modelsQuery.error && lastModelsData == null ? (
        <MobileNote>模型目录读取失败：{modelsQuery.error}</MobileNote>
      ) : null}
    </MobilePageBody>
  )
}

/** 设计册七档中文名（与 pi 的 level id 对齐；不认识的档位原样显示）。 */
function ChineseThinking(level: string): string {
  const zh = thinkingLevelZh(level)
  if (level === "minimal") return "最小"
  if (level === "xhigh") return "超高"
  return zh
}
