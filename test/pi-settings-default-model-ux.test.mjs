import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")

const modelData = await import("../ui/src/pi/settings/pages/modelData.ts")
const mobileModel = await import("../ui/src/pi/settings/mobile/model.ts")

function builtInCatalogFixture(providerCount = 32, modelsPerProvider = 50) {
  const authProviders = []
  const allModels = []
  for (let p = 0; p < providerCount; p++) {
    const pid = `builtin-p${p}`
    authProviders.push({
      id: pid,
      name: `BuiltIn ${p}`,
      hasApiKey: false,
      hasOAuth: false,
      envVar: false,
      inModelsJson: false,
      configured: false,
    })
    for (let m = 0; m < modelsPerProvider; m++) {
      allModels.push({
        provider: pid,
        id: `model-${p}-${m}`,
        name: `BuiltIn ${p} Model ${m}`,
        key: `${pid}/model-${p}-${m}`,
      })
    }
  }
  return { authProviders, allModels }
}

test("Default Model filters out 1,600 unconfigured built-in models and surfaces configured friendly names + duplicate disambiguation", () => {
  const { authProviders, allModels } = builtInCatalogFixture(32, 50)
  authProviders.push({
    id: "deepseek",
    name: "DeepSeek",
    hasApiKey: true,
    hasOAuth: false,
    envVar: false,
    inModelsJson: true,
    configured: true,
    api: "openai-completions",
    baseUrl: "https://api.39api.example/v1",
  })
  const customModels = [
    {
      provider: "deepseek",
      id: "deepseek-v4.1-flash-1017",
      name: "DeepSeek V4.1 Flash 1017",
      key: "deepseek/deepseek-v4.1-flash-1017",
    },
    {
      provider: "deepseek",
      id: "deepseek-chat-a",
      name: "Shared Friendly Name",
      key: "deepseek/deepseek-chat-a",
    },
    {
      provider: "deepseek",
      id: "deepseek-chat-b",
      name: "Shared Friendly Name",
      key: "deepseek/deepseek-chat-b",
    },
  ]
  const modelsConfigData = {
    providers: [
      {
        id: "deepseek",
        baseUrl: "https://api.39api.example/v1",
        api: "openai-completions",
        inModelsJson: true,
        inAuthJson: true,
        hasApiKey: true,
        models: customModels.map(({ id, name }) => ({ id, name })),
      },
    ],
  }

  const rows = modelData.providerRowsOf(
    { providers: authProviders },
    { models: [...allModels, ...customModels], available: customModels },
    {},
    modelsConfigData,
    null,
  )

  const choices = modelData.configuredModelChoicesOf(rows, "deepseek", "deepseek-v4.1-flash-1017")
  assert.equal(choices.length, 3)
  assert.deepEqual(
    choices.map((c) => c.label),
    [
      "DeepSeek V4.1 Flash 1017",
      "Shared Friendly Name (deepseek-chat-a)",
      "Shared Friendly Name (deepseek-chat-b)",
    ],
  )

  const groups = modelData.defaultModelGroupsOf(rows, "deepseek/deepseek-v4.1-flash-1017")
  assert.equal(groups.length, 1)
  assert.equal(groups[0].options.length, 3)
  assert.deepEqual(
    groups[0].options.map((o) => o.label),
    [
      "DeepSeek V4.1 Flash 1017",
      "Shared Friendly Name (deepseek-chat-a)",
      "Shared Friendly Name (deepseek-chat-b)",
    ],
  )

  const dupSet = new Set(["same name"])
  assert.equal(
    modelData.defaultModelOptionLabelOf({ modelId: "m1", label: "m1", name: "Same Name" }, dupSet),
    "Same Name (m1)",
  )
  assert.equal(
    modelData.defaultModelOptionLabelOf({ modelId: "m1", label: "m1", name: "Unique Name" }, dupSet),
    "Unique Name",
  )
})

test("Disabled model under configured provider is excluded unless it is the saved defaultModel", () => {
  const providers = [
    {
      id: "deepseek",
      name: "DeepSeek",
      state: "connected",
      endpoint: "https://api.39api.example/v1",
      configured: true,
      models: [
        {
          key: "deepseek/m-enabled",
          provider: "deepseek",
          modelId: "m-enabled",
          label: "m-enabled",
          name: "Enabled Model",
          thinking: null,
          enabled: true,
        },
        {
          key: "deepseek/m-disabled",
          provider: "deepseek",
          modelId: "m-disabled",
          label: "m-disabled",
          name: "Disabled Model",
          thinking: null,
          enabled: false,
        },
      ],
    },
  ]

  assert.equal(modelData.isProviderModelSelectable(providers[0], providers[0].models[0]), true)
  assert.equal(modelData.isProviderModelSelectable(providers[0], providers[0].models[1]), false)

  const withoutSavedDisabled = modelData.defaultModelGroupsOf(providers, "deepseek/m-enabled")
  assert.deepEqual(
    withoutSavedDisabled.flatMap((g) => g.options.map((o) => o.value)),
    ["deepseek/m-enabled"],
  )

  const choicesWithoutDisabled = modelData.configuredModelChoicesOf(providers, "deepseek", "m-enabled")
  assert.deepEqual(choicesWithoutDisabled.map((c) => c.key), ["deepseek/m-enabled"])

  const withSavedDisabled = modelData.defaultModelGroupsOf(providers, "deepseek/m-disabled")
  assert.deepEqual(
    withSavedDisabled.flatMap((g) => g.options.map((o) => o.value)),
    ["deepseek/m-disabled", "deepseek/m-enabled"],
  )
})

test("hasUserProviderConfig, isBuiltInUnconfiguredProvider, and splitSettingsProviders handle custom, zero-configured, and unknown sorting", () => {
  const rowsFromConfig = modelData.providerRowsOf(
    { providers: [] },
    { models: [], available: [] },
    {},
    {
      providers: [
        {
          id: "custom-api",
          name: "Custom API",
          baseUrl: "https://custom.local/v1",
          api: "openai-completions",
          inModelsJson: true,
          inAuthJson: false,
          hasApiKey: false,
          models: [],
        },
      ],
    },
    null,
  )
  const customNoKey = rowsFromConfig[0]

  const builtInUnconf = (n) => ({
    id: `builtin-${n}`,
    name: `BuiltIn ${n}`,
    state: "disconnected",
    endpoint: null,
    configured: false,
    models: [],
  })
  const unknownProv = {
    id: "unknown-prov",
    name: "Unknown",
    state: "unknown",
    endpoint: null,
    configured: null,
    models: [{ key: "unknown-prov/u1", provider: "unknown-prov", modelId: "u1", label: "u1", thinking: null, enabled: true }],
  }
  const connectedProv = {
    id: "connected-prov",
    name: "Connected",
    state: "connected",
    endpoint: null,
    configured: true,
    models: [{ key: "connected-prov/c1", provider: "connected-prov", modelId: "c1", label: "c1", thinking: null, enabled: true }],
  }

  assert.equal(modelData.hasUserProviderConfig(customNoKey), true)
  assert.equal(modelData.isBuiltInUnconfiguredProvider(customNoKey), false)
  assert.equal(modelData.hasUserProviderConfig(builtInUnconf(1)), false)
  assert.equal(modelData.isBuiltInUnconfiguredProvider(builtInUnconf(1)), true)

  // 0 configured providers + >=4 built-in unconfigured -> primary is [], all built-ins move to folded
  const zeroConfiguredSplit = modelData.splitSettingsProviders([
    builtInUnconf(1),
    builtInUnconf(2),
    builtInUnconf(3),
    builtInUnconf(4),
  ])
  assert.deepEqual(zeroConfiguredSplit.primary, [])
  assert.equal(zeroConfiguredSplit.folded.length, 4)

  // customNoKey stays in primary; connected + custom sort ahead of unknown
  const mixedSplit = modelData.splitSettingsProviders([
    unknownProv,
    builtInUnconf(1),
    builtInUnconf(2),
    builtInUnconf(3),
    builtInUnconf(4),
    customNoKey,
    connectedProv,
  ])
  assert.equal(mixedSplit.folded.length, 4)
  assert.deepEqual(
    mixedSplit.primary.map((p) => p.id),
    ["custom-api", "connected-prov", "unknown-prov"],
  )
})

test("Mobile modelChoicesOf, modelGroupsOf, and availableModelCountOf prefer available, preserve display names, and filter unconfigured providers", () => {
  const payload = {
    models: [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", key: "openai/gpt-4o" },
      { provider: "deepseek", id: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash 1017", key: "deepseek/deepseek-v4.1-flash-1017" },
    ],
    available: [
      { provider: "deepseek", id: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash 1017", key: "deepseek/deepseek-v4.1-flash-1017" },
    ],
  }

  assert.equal(mobileModel.availableModelCountOf(payload), 1)
  assert.equal(mobileModel.availableModelCountOf({ models: [{}, {}, {}] }), 3)

  const choices = mobileModel.modelChoicesOf(payload)
  assert.deepEqual(choices, [
    {
      key: "deepseek/deepseek-v4.1-flash-1017",
      provider: "deepseek",
      modelId: "deepseek-v4.1-flash-1017",
      label: "DeepSeek V4.1 Flash 1017",
    },
  ])

  const groups = mobileModel.modelGroupsOf(
    [
      ...choices,
      { key: "openai/gpt-4o", provider: "openai", modelId: "gpt-4o", label: "GPT-4o" },
    ],
    [
      { id: "deepseek", name: "DeepSeek", connected: true, configured: true, models: 1, authSource: "auth.json" },
      { id: "openai", name: "OpenAI", connected: false, configured: false, models: 1, authSource: null },
    ],
  )
  assert.deepEqual(groups.map((g) => g.label), ["DeepSeek"])
  assert.deepEqual(groups[0].options.map((o) => o.value), ["deepseek/deepseek-v4.1-flash-1017"])
})

test("ConfigModals defaults new provider API to openai-completions and PiModelMenu exposes configure entry", () => {
  const configModalsSrc = read("ui/src/pi/settings/ConfigModals.tsx")
  assert.match(configModalsSrc, /"openai-completions"/)
  assert.match(configModalsSrc, /自动\s*\/\s*默认（仅内置供应商适用）/)

  const modelMenuSrc = read("ui/src/components/pi/composer/PiModelMenu.tsx")
  assert.match(modelMenuSrc, /data-cw-id="pi-model-configure"/)
})
