import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(extensionRoot, file), "utf8");

const registrySource = read("aiProviderRegistry.js");
const aiClientSource = read("aiClient.js");
const openAISource = read("openAICompatibleClient.js");
const anthropicSource = read("anthropicClient.js");
const dispatcherSource = read("aiProviderClient.js");

// LD-024/LD-025: the dispatcher selects adapters only through the real registry's
// presetFor(...).transportKind, so this test loads the real registry, the real adapter
// scripts, and the real dispatcher into one context - matching how app.html/floating.html
// will load them in HTML-declared producer-before-consumer order (LD-028).
function createContext(fetchImplementation) {
  const context = {
    AbortController,
    URL,
    fetch: fetchImplementation,
    window: { setTimeout, clearTimeout }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(registrySource, context);
  vm.runInContext(aiClientSource, context);
  vm.runInContext(openAISource, context);
  vm.runInContext(anthropicSource, context);
  vm.runInContext(dispatcherSource, context);
  return context.SaySlateAIProviderClient;
}

const REGISTRY_PRESETS = (() => {
  const context = { URL };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(registrySource, context);
  return context.SaySlateAIProviderRegistry;
})();

// ---- Scenario 1: Gemini profile dispatches to the gemini-native transport and returns
// the same plain-string shape existing first/second-pass call sites expect. ----

{
  let request;
  const client = createContext(async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, async json() { return { candidates: [{ content: { parts: [{ text: JSON.stringify({ text: "Gemini result." }) }] } }] }; } };
  });

  const profile = {
    providerKind: REGISTRY_PRESETS.PROVIDER_KINDS.GEMINI,
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    modelId: "test-model",
    credential: "test-key-gemini"
  };

  const result = await client.generate({ profile, userPrompt: "perform this pass" });

  assert.equal(typeof result, "string");
  assert.equal(result, "Gemini result.");
  assert.match(request.url, /generateContent\?key=test-key-gemini/);
  assert.ok(!result.includes("test-key-gemini"));

  console.log("Dispatcher gemini-native routing and plain-string return verified.");
}

// ---- Scenario 2: OpenAI profile dispatches to the openai-chat-completions transport ----

{
  let request;
  const client = createContext(async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, async json() { return { choices: [{ message: { content: JSON.stringify({ text: "OpenAI result." }) } }] }; } };
  });

  const profile = {
    providerKind: REGISTRY_PRESETS.PROVIDER_KINDS.OPENAI,
    endpoint: "https://api.openai.com/v1",
    modelId: "test-model",
    credential: "test-key-openai"
  };

  const result = await client.generate({ profile, userPrompt: "perform this pass" });

  assert.equal(result, "OpenAI result.");
  assert.equal(request.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer test-key-openai");

  console.log("Dispatcher openai-chat-completions routing verified.");
}

// ---- Scenario 3: custom/LM Studio profile also dispatches to openai-chat-completions,
// with no provider-specific branching, and works without a credential (EV-014). ----

{
  let request;
  const client = createContext(async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, async json() { return { choices: [{ message: { content: JSON.stringify({ text: "Custom result." }) } }] }; } };
  });

  const profile = {
    providerKind: REGISTRY_PRESETS.PROVIDER_KINDS.CUSTOM,
    endpoint: "https://lmstudio.example-tailnet.ts.net/v1",
    modelId: "local-model",
    credential: ""
  };

  const result = await client.generate({ profile, userPrompt: "perform this pass" });

  assert.equal(result, "Custom result.");
  assert.ok(!("Authorization" in request.options.headers));

  console.log("Dispatcher custom/LM Studio routing without a credential verified.");
}

// ---- Scenario 4: Anthropic profile dispatches to the anthropic-messages transport ----

{
  let request;
  const client = createContext(async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, async json() { return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ text: "Anthropic result." }) }] }; } };
  });

  const profile = {
    providerKind: REGISTRY_PRESETS.PROVIDER_KINDS.ANTHROPIC,
    endpoint: "https://api.anthropic.com/v1",
    modelId: "test-model",
    credential: "test-key-anthropic"
  };

  const result = await client.generate({ profile, userPrompt: "perform this pass" });

  assert.equal(result, "Anthropic result.");
  assert.equal(request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.options.headers["x-api-key"], "test-key-anthropic");

  console.log("Dispatcher anthropic-messages routing verified.");
}

// ---- Scenario 5: profile/configuration validation before any adapter or network call ----

{
  const client = createContext(async () => {
    throw new Error("fetch must not be called for an invalid profile");
  });

  await assert.rejects(client.generate({ profile: null, userPrompt: "u" }), (error) => error.code === "invalid_configuration");

  await assert.rejects(
    client.generate({ profile: { providerKind: "not-a-real-kind", endpoint: "https://x.example/v1", modelId: "m", credential: "k" }, userPrompt: "u" }),
    (error) => error.code === "invalid_configuration"
  );

  await assert.rejects(
    client.generate({ profile: { providerKind: "gemini", endpoint: "", modelId: "m", credential: "k" }, userPrompt: "u" }),
    (error) => error.code === "invalid_configuration"
  );

  await assert.rejects(
    client.generate({ profile: { providerKind: "gemini", endpoint: "https://generativelanguage.googleapis.com/v1beta", modelId: "", credential: "k" }, userPrompt: "u" }),
    (error) => error.code === "invalid_configuration"
  );

  await assert.rejects(
    client.generate({ profile: { providerKind: "gemini", endpoint: "https://generativelanguage.googleapis.com/v1beta", modelId: "m", credential: "" }, userPrompt: "u" }),
    (error) => error.code === "invalid_configuration",
    "Gemini requires a credential"
  );

  await assert.rejects(
    client.generate({ profile: { providerKind: "anthropic", endpoint: "https://api.anthropic.com/v1", modelId: "m", credential: "" }, userPrompt: "u" }),
    (error) => error.code === "invalid_configuration",
    "Anthropic requires a credential"
  );

  console.log("Dispatcher pre-network profile validation verified.");
}

// ---- Scenario 6: an adapter's bounded error (e.g. authentication_failed) passes through
// the dispatcher unchanged, so callers see the same bounded code the adapter produced. ----

{
  const client = createContext(async () => ({ ok: false, status: 401, async json() { return { error: { message: "invalid_api_key" } }; } }));

  const profile = {
    providerKind: REGISTRY_PRESETS.PROVIDER_KINDS.OPENAI,
    endpoint: "https://api.openai.com/v1",
    modelId: "test-model",
    credential: "test-key-openai"
  };

  await assert.rejects(
    client.generate({ profile, userPrompt: "u" }),
    (error) => error.code === "authentication_failed" && !error.message.includes("test-key-openai")
  );

  console.log("Dispatcher adapter error passthrough verified.");
}

console.log("AI provider client dispatcher contract boundary verified.");
