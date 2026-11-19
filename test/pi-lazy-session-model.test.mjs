import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  extractLazyCatalog,
  stageLazyModel,
  stageLazyThinking,
} from "../ui/src/relay/lazySession.ts";
import {
  modelDefaultOf,
  modelMenuEntriesOf,
  modelRowsOf,
  modelThinkingOptionsOf,
} from "../ui/src/pi/model/models.ts";

const require = createRequire(import.meta.url);
const attach = require("../deploy/attach.cjs");

const SHARED_SESSION_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lazy-model-session-root-"));
process.env.PI_CODING_AGENT_SESSION_DIR = SHARED_SESSION_ROOT;
process.on("exit", () => {
  try {
    fs.rmSync(SHARED_SESSION_ROOT, { recursive: true, force: true });
  } catch {}
});

function makeTmpDir(prefix = "pi-lazy-model-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor(condition, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timed out");
}

function makeController(agentDir, extra = {}) {
  const ctlDir = makeTmpDir("pi-lazy-ctl-");
  const frames = [];
  const ctl = new attach.AttachController({
    platform: "darwin",
    relay: "ws://127.0.0.1:7001",
    deviceId: "dev-lazy-test",
    accountId: "admin",
    deviceName: "Mac",
    agentDir,
    projects: [ctlDir],
    attachFile: path.join(ctlDir, "remote-attach.json"),
    maxHours: 12,
    existsDir: () => true,
    exitHome: ctlDir,
    launchWaitMs: 0,
    spawnImpl: () => ({ unref() {}, on() {} }),
    spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "" }),
    sessionLookup: async () => null,
    writeOut: () => {},
    exit: () => {},
    status: false,
    ...extra,
  });
  ctl.ws = {
    readyState: 1,
    send(payload) {
      frames.push(JSON.parse(payload));
    },
    close() {},
  };
  let seq = 0;
  const send = async (command, args = {}) => {
    seq += 1;
    const id = `cmd-${seq}`;
    await ctl.handleMessage({ type: "command", id, command, args });
    await waitFor(() => frames.some((f) => f.id === id));
    return frames.find((f) => f.id === id);
  };
  const cleanup = () => {
    fs.rmSync(ctlDir, { recursive: true, force: true });
  };
  return { ctl, frames, send, cleanup };
}

/* ---------------- 1. lazySession.ts pure helpers ---------------- */

test("extractLazyCatalog: prefers available (keeping thinkingLevels), merges models without duplicates, ignores invalid items", () => {
  assert.deepEqual(extractLazyCatalog(null), []);
  assert.deepEqual(extractLazyCatalog([]), []);

  const items = extractLazyCatalog({
    available: [
      null,
      "bad",
      { provider: "", id: "missing-provider" },
      { provider: "deepseek", id: "", modelId: "" },
      {
        provider: " deepseek ",
        id: "deepseek-flash",
        modelId: "deepseek-flash",
        name: "DeepSeek V4.1 Flash",
        thinkingLevels: ["off", "low", "low", "", 42, "high", "max"],
      },
      {
        provider: "openai",
        id: "gpt-fallback-id",
        name: "  ",
      },
    ],
    models: [
      {
        provider: "deepseek",
        id: "deepseek-flash",
        name: "Should Not Overwrite Available",
      },
      {
        provider: "anthropic",
        id: "claude-sonnet",
        name: "Claude Sonnet",
      },
    ],
  });

  assert.deepEqual(items, [
    {
      provider: "deepseek",
      modelId: "deepseek-flash",
      name: "DeepSeek V4.1 Flash",
      thinkingLevels: ["off", "low", "high", "max"],
    },
    {
      provider: "openai",
      modelId: "gpt-fallback-id",
      name: "gpt-fallback-id",
    },
    {
      provider: "anthropic",
      modelId: "claude-sonnet",
      name: "Claude Sonnet",
    },
  ]);
});

test("stageLazyModel & stageLazyThinking: resolve name, normalize unsupported thinking, isolate across sessionIds", () => {
  const catalog = [
    {
      provider: "deepseek",
      modelId: "deepseek-v4.1-flash-1017",
      name: "DeepSeek V4.1 Flash 1017",
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "max"],
    },
    {
      provider: "openai",
      modelId: "gpt-no-think",
      name: "No Think Model",
      thinkingLevels: ["off"],
    },
    {
      provider: "anthropic",
      modelId: "claude-capped",
      name: "Capped Model",
      thinkingLevels: ["off", "low", "medium"],
    },
  ];

  // Resolves catalog display name and preserves supported thinkingLevel on same session
  const prevSame = stageLazyThinking(null, "sess-1", "high");
  assert.deepEqual(prevSame, { sessionId: "sess-1", thinkingLevel: "high" });

  const s1 = stageLazyModel(prevSame, "sess-1", "deepseek", "deepseek-v4.1-flash-1017", catalog, "high");
  assert.deepEqual(s1, {
    next: {
      sessionId: "sess-1",
      model: { provider: "deepseek", modelId: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash 1017" },
      thinkingLevel: "high",
    },
    name: "DeepSeek V4.1 Flash 1017",
    nextThinking: "high",
  });

  // Switches to a model supporting only ["off"] -> normalizes current unsupported "high" to "off"
  const s2 = stageLazyModel(s1.next, "sess-1", "openai", "gpt-no-think", catalog, "high");
  assert.deepEqual(s2, {
    next: {
      sessionId: "sess-1",
      model: { provider: "openai", modelId: "gpt-no-think", name: "No Think Model" },
      thinkingLevel: "off",
    },
    name: "No Think Model",
    nextThinking: "off",
  });

  // Switches to a model without "high" -> normalizes current "max" to last supported level ("medium")
  const s3 = stageLazyModel(s1.next, "sess-1", "anthropic", "claude-capped", catalog, "max");
  assert.deepEqual(s3, {
    next: {
      sessionId: "sess-1",
      model: { provider: "anthropic", modelId: "claude-capped", name: "Capped Model" },
      thinkingLevel: "medium",
    },
    name: "Capped Model",
    nextThinking: "medium",
  });

  // Staging thinking on same session preserves model; switching sessionId drops stale model & thinking
  const kept = stageLazyThinking(s1.next, "sess-1", "max");
  assert.deepEqual(kept, {
    sessionId: "sess-1",
    model: { provider: "deepseek", modelId: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash 1017" },
    thinkingLevel: "max",
  });

  const switchedSessionModel = stageLazyModel(kept, "sess-2", "unknown-prov", "unknown-id", catalog, "");
  assert.deepEqual(switchedSessionModel, {
    next: {
      sessionId: "sess-2",
      model: { provider: "unknown-prov", modelId: "unknown-id", name: "unknown-id" },
    },
    name: "unknown-id",
    nextThinking: "",
  });

  const switchedSessionThinking = stageLazyThinking(kept, "sess-2", "low");
  assert.deepEqual(switchedSessionThinking, { sessionId: "sess-2", thinkingLevel: "low" });
});

/* ---------------- 2. deploy/attach.cjs + models.ts end-to-end ---------------- */

test("attach.cjs fallback mode (no pi package / loadPiModelRegistry null or throws): reads models.json + auth.json + settings.json without leaking secrets", async () => {
  const agentDir = makeTmpDir("pi-agent-fb-");
  const secretModelKey = "sk-test-secret-model-key-888";
  const secretAuthKey = "sk-test-secret-auth-key-999";
  const secretHeader = "Bearer test-secret-header-777";
  try {
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          deepseek: {
            baseUrl: "https://39api.cn",
            api: "openai-completions",
            apiKey: secretModelKey,
            headers: { Authorization: secretHeader },
            models: [
              {
                id: "deepseek-v4.1-flash-1017",
                name: "DeepSeek V4.1 Flash 1017",
                reasoning: true,
                input: ["text", "image"],
                thinkingLevelMap: { minimal: {}, low: {}, medium: {}, high: {}, max: {} },
                contextWindow: 1000000,
                maxTokens: 384000,
                headers: { "x-secret": secretHeader },
              },
            ],
          },
          unconfiguredProv: {
            baseUrl: "https://example.invalid",
            api: "openai-completions",
            models: [{ id: "m-unconfigured", name: "Unconfigured Model" }],
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(agentDir, "auth.json"),
      JSON.stringify({
        deepseek: { type: "api_key", key: secretAuthKey },
      }),
    );
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "deepseek",
        defaultModel: "deepseek-v4.1-flash-1017",
      }),
    );

    const { ctl, send, cleanup } = makeController(agentDir);
    try {
      ctl.loadPiModelRegistry = async () => null;

      const modelsRes = await send("get_available_models");
      assert.equal(modelsRes.ok, true);
      const rawModelsStr = JSON.stringify(modelsRes);
      assert.equal(rawModelsStr.includes(secretModelKey), false);
      assert.equal(rawModelsStr.includes(secretAuthKey), false);
      assert.equal(rawModelsStr.includes(secretHeader), false);
      assert.equal(rawModelsStr.includes('"headers"'), false);

      assert.equal(modelsRes.data.models.length, 2);
      assert.equal(modelsRes.data.available.length, 1);
      assert.equal(modelsRes.data.available[0].id, "deepseek-v4.1-flash-1017");
      assert.deepEqual(modelsRes.data.available[0].thinkingLevels, ["off", "minimal", "low", "medium", "high", "max"]);
      assert.deepEqual(modelsRes.data.defaultModel, {
        provider: "deepseek",
        id: "deepseek-v4.1-flash-1017",
        modelId: "deepseek-v4.1-flash-1017",
      });

      // Fallback when loadPiModelRegistry throws
      ctl.loadPiModelRegistry = async () => {
        throw new Error("simulated pi load failure");
      };
      const authRes = await send("get_provider_auth");
      assert.equal(authRes.ok, true);
      const rawAuthStr = JSON.stringify(authRes);
      assert.equal(rawAuthStr.includes(secretModelKey), false);
      assert.equal(rawAuthStr.includes(secretAuthKey), false);
      assert.equal(rawAuthStr.includes(secretHeader), false);

      const ds = authRes.data.providers.find((p) => p.id === "deepseek");
      const unconf = authRes.data.providers.find((p) => p.id === "unconfiguredProv");
      assert.equal(ds.configured, true);
      assert.equal(unconf.configured, false);
    } finally {
      cleanup();
    }
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("attach.cjs ModelRegistry mode -> models.ts: surfaces built-in + custom models, merges provider auth, strips secrets", async () => {
  const agentDir = makeTmpDir("pi-agent-reg-");
  const secretAuthKey = "sk-registry-secret-key-123";
  const secretHeader = "Bearer registry-secret-header-456";
  try {
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          deepseek: {
            baseUrl: "https://39api.cn",
            api: "openai-completions",
            headers: { Authorization: secretHeader },
            models: [
              {
                id: "deepseek-v4.1-flash-1017",
                name: "DeepSeek V4.1 Flash 1017",
                reasoning: true,
                thinkingLevelMap: { minimal: {}, low: {}, medium: {}, high: {}, max: {} },
              },
            ],
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(agentDir, "auth.json"),
      JSON.stringify({
        deepseek: { type: "api_key", key: secretAuthKey },
      }),
    );
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "deepseek",
        defaultModel: "deepseek-v4.1-flash-1017",
      }),
    );

    const builtInFlash = {
      id: "deepseek-flash",
      name: "DeepSeek V4.1 Flash",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      provider: "deepseek",
      reasoning: true,
      thinkingLevelMap: { minimal: {}, low: {}, medium: {}, high: {}, max: {} },
      input: ["text", "image"],
      contextWindow: 1000000,
      maxTokens: 384000,
      type: "chat",
    };
    const builtInPro = {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      provider: "deepseek",
      reasoning: true,
      thinkingLevelMap: { minimal: {}, low: {}, medium: {}, high: {}, max: {} },
      input: ["text"],
      contextWindow: 1000000,
      maxTokens: 384000,
      type: "chat",
    };
    const customModel = {
      id: "deepseek-v4.1-flash-1017",
      name: "DeepSeek V4.1 Flash 1017",
      api: "openai-completions",
      baseUrl: "https://39api.cn",
      provider: "deepseek",
      reasoning: true,
      thinkingLevelMap: { minimal: {}, low: {}, medium: {}, high: {}, max: {} },
      input: ["text", "image"],
      contextWindow: 1000000,
      maxTokens: 384000,
      headers: { Authorization: secretHeader },
      apiKey: secretAuthKey,
    };
    const unconfiguredOpenAI = {
      id: "gpt-4o",
      name: "GPT-4o",
      api: "openai-responses",
      baseUrl: "https://api.openai.com",
      provider: "openai",
      reasoning: false,
      input: ["text", "image"],
    };

    const { ctl, send, cleanup } = makeController(agentDir);
    try {
      ctl.loadPiModelRegistry = async () => ({
        runtime: {
          isUsingSubscription: (id) => id === "openai",
        },
        registry: {
          getAll: () => [builtInFlash, builtInPro, customModel, unconfiguredOpenAI],
          getAvailable: () => [builtInFlash, builtInPro, customModel],
          getRegisteredProviderIds: () => ["deepseek"],
          getProviderDisplayName: (id) => (id === "deepseek" ? "DeepSeek" : id === "openai" ? "OpenAI" : id),
          getProviderAuthStatus: (id) =>
            id === "deepseek" ? { configured: true, source: "stored", rawSecret: secretAuthKey } : { configured: false, source: null },
          isUsingOAuth: () => false,
        },
      });

      const modelsRes = await send("get_available_models");
      assert.equal(modelsRes.ok, true);
      const rawModelsStr = JSON.stringify(modelsRes);
      assert.equal(rawModelsStr.includes(secretAuthKey), false);
      assert.equal(rawModelsStr.includes(secretHeader), false);
      assert.equal(rawModelsStr.includes('"headers"'), false);
      assert.equal(rawModelsStr.includes('"apiKey"'), false);

      assert.deepEqual(
        modelsRes.data.available.map((m) => `${m.provider}/${m.id}`),
        [
          "deepseek/deepseek-flash",
          "deepseek/deepseek-v4-pro",
          "deepseek/deepseek-v4.1-flash-1017",
        ],
      );
      assert.equal(modelDefaultOf(modelsRes.data)?.modelId, "deepseek-v4.1-flash-1017");
      assert.equal(modelDefaultOf(modelsRes.data)?.name, "DeepSeek V4.1 Flash 1017");

      // Feed get_available_models directly into UI parser (models.ts)
      const rows = modelRowsOf(modelsRes.data, { model: "" });
      const entries = modelMenuEntriesOf(rows);
      const selectable = entries.filter((e) => !e.representative.unconfigured);
      assert.equal(entries.length, 4);
      assert.equal(selectable.length, 3);
      assert.deepEqual(
        selectable.map((e) => e.representative.name),
        ["DeepSeek V4.1 Flash", "DeepSeek V4 Pro", "DeepSeek V4.1 Flash 1017"],
      );
      assert.equal(
        modelThinkingOptionsOf(selectable[2].representative.thinkingLevels).some((o) => o.value === "high"),
        true,
      );

      // Verify lazy catalog extraction consumes attach output accurately
      const catalog = extractLazyCatalog(modelsRes.data);
      assert.equal(catalog.length, 4);
      assert.deepEqual(
        stageLazyModel(null, "lazy-1", "deepseek", "deepseek-flash", catalog, "high").name,
        "DeepSeek V4.1 Flash",
      );

      // Verify get_provider_auth merges registry + models.json without leaking secret fields
      const authRes = await send("get_provider_auth");
      assert.equal(authRes.ok, true);
      const rawAuthStr = JSON.stringify(authRes);
      assert.equal(rawAuthStr.includes(secretAuthKey), false);
      assert.equal(rawAuthStr.includes(secretHeader), false);
      assert.equal(rawAuthStr.includes("rawSecret"), false);

      const ds = authRes.data.providers.find((p) => p.id === "deepseek");
      const oai = authRes.data.providers.find((p) => p.id === "openai");
      assert.equal(ds.displayName, "DeepSeek");
      assert.equal(ds.models, 3);
      assert.equal(ds.configured, true);
      assert.equal(ds.authSource, "stored");
      assert.equal(oai.displayName, "OpenAI");
      assert.equal(oai.models, 1);
      assert.equal(oai.configured, false);
      assert.equal(oai.subscription, true);
    } finally {
      cleanup();
    }
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

/* ---------------- 3. Source contracts for cShared.ts & useRelay.ts ---------------- */

test("cShared.ts: useModelData queries runDeviceCommand for unloaded/lazy sessions, derives fallback thinking levels, keeps useDeviceDefaultModelName read-only", () => {
  const src = fs.readFileSync(path.resolve("ui/src/pi/containers/cShared.ts"), "utf8");
  assert.match(src, /function sessionDeviceIdOf\(/);
  assert.match(src, /if \(relay\.lazySession && relay\.lazySession\.id === relay\.roomId && relay\.lazySession\.deviceId\)/);

  const modelDataSection = src.slice(src.indexOf("export function useModelData"), src.indexOf("export function useDeviceDefaultModelName"));
  assert.match(modelDataSection, /mode = roomReady \? "room" : deviceOnline \? "device" : "off"/);
  assert.match(modelDataSection, /cur\.runDeviceCommand\(targetDevice, command, args\)/);
  assert.match(modelDataSection, /open && mode !== "off" \? "get_available_models" : null/);
  assert.match(modelDataSection, /modelThinkingOptionsOf\(currentRow\?\.thinkingLevels\)/);
  assert.match(modelDataSection, /open && !isStatic && mode === "off"/);
  assert.match(modelDataSection, /listPhase = "error"/);

  const defaultSection = src.slice(src.indexOf("export function useDeviceDefaultModelName"), src.indexOf("export function useDeviceDefaultModelName") + 1500);
  assert.equal(defaultSection.includes("set_model"), false);
  assert.equal(defaultSection.includes("set_thinking_level"), false);
});

test("useRelay.ts: supports model/thinking queries & staging on lazySession and flushes staged choices on first send", () => {
  const src = fs.readFileSync(path.resolve("ui/src/relay/useRelay.ts"), "utf8");
  assert.match(src, /lazyPendingModelRef/);
  assert.match(src, /lazyCatalogRef/);

  const devCmdPos = src.indexOf("const runDeviceCommand = useCallback");
  const runCmdPos = src.indexOf("const runCommand = useCallback");
  assert.ok(devCmdPos > 0 && runCmdPos > devCmdPos, "runDeviceCommand must be declared before runCommand");

  const runCmdSection = src.slice(runCmdPos, runCmdPos + 3500);
  assert.match(runCmdSection, /command === "get_available_models"/);
  assert.match(runCmdSection, /command === "get_available_thinking_levels"/);
  assert.match(runCmdSection, /command === "set_model"/);
  assert.match(runCmdSection, /command === "set_thinking_level"/);
  assert.match(runCmdSection, /runDeviceCommand\(lazy\.deviceId, "get_available_models", args\)/);
  assert.match(runCmdSection, /stageLazyModel\(lazyPendingModelRef\.current, lazy\.id/);
  assert.match(runCmdSection, /stageLazyThinking\(lazyPendingModelRef\.current, lazy\.id, level\)/);
  assert.match(runCmdSection, /throw new RelayError\("not_loaded"/);

  const flushSection = src.slice(src.indexOf("const flushLazySend = useCallback"), src.indexOf("const flushLazySend = useCallback") + 2800);
  assert.match(flushSection, /pendingModel\?\.model/);
  assert.match(flushSection, /commandSendRef\.current\("set_model"/);
  assert.match(flushSection, /pendingModel\?\.thinkingLevel/);
  assert.match(flushSection, /commandSendRef\.current\("set_thinking_level"/);

  const subIdx = src.indexOf('if (type === "subscribed")');
  const getStateIdx = src.indexOf('commandSendRef.current("get_state")', subIdx);
  assert.ok(subIdx > 0 && getStateIdx > subIdx);
  const subBlock = src.slice(subIdx, getStateIdx);
  assert.match(subBlock, /onlineRef\.current\s*=\s*!!msg\.online/);
});

test("attach.cjs upsert_provider_model preserves omitted baseUrl/input, clears only explicit empty string; ConfigModals supports baseUrl & input", async () => {
  const agentDir = makeTmpDir("pi-upsert-model-");
  try {
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          deepseek: {
            models: [
              {
                id: "deepseek-v4.1-flash-1017",
                name: "DeepSeek V4.1 Flash 1017",
                baseUrl: "https://39api.cn",
                reasoning: true,
                input: ["text", "image"],
              },
            ],
          },
        },
      }),
    );
    const { send, cleanup } = makeController(agentDir);
    try {
      const keepRes = await send("upsert_provider_model", {
        provider: "deepseek",
        originalId: "deepseek-v4.1-flash-1017",
        model: { id: "deepseek-v4.1-flash-1017", reasoning: false },
      });
      assert.equal(keepRes.ok, true);
      let saved = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).providers.deepseek.models[0];
      assert.equal(saved.baseUrl, "https://39api.cn");
      assert.deepEqual(saved.input, ["text", "image"]);

      const clearRes = await send("upsert_provider_model", {
        provider: "deepseek",
        originalId: "deepseek-v4.1-flash-1017",
        model: { id: "deepseek-v4.1-flash-1017", baseUrl: "", input: ["text"] },
      });
      assert.equal(clearRes.ok, true);
      saved = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).providers.deepseek.models[0];
      assert.equal("baseUrl" in saved, false);
      assert.deepEqual(saved.input, ["text"]);
    } finally {
      cleanup();
    }
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }

  const modalsSrc = fs.readFileSync(path.resolve("ui/src/pi/settings/ConfigModals.tsx"), "utf8");
  assert.match(modalsSrc, /baseUrl\?: string \| null/);
  assert.match(modalsSrc, /input\?: string\[\]/);
  assert.match(modalsSrc, /接口地址 Base URL（可选覆盖）/);
  assert.match(modalsSrc, /支持图片输入（Vision）/);
});
