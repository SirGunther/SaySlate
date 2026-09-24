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
  // LD-041: OpenAI profiles never send reasoning_effort (OpenAI rejects it on non-reasoning models).
  assert.ok(!("reasoning_effort" in JSON.parse(request.options.body)), "OpenAI profiles must not send reasoning_effort");

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
  // LD-041: custom (LM Studio) profiles ask for no reasoning pass on every request.
  assert.equal(JSON.parse(request.options.body).reasoning_effort, "none");

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

// ---- Scenario 7: Custom profile with reasoning: true sends reasoning_effort "medium"
// (LD-003, SAYREASON-01). ----

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

  await client.generate({ profile, userPrompt: "perform this pass", reasoning: true });

  assert.equal(JSON.parse(request.options.body).reasoning_effort, "medium");

  console.log("Dispatcher custom/LM Studio reasoning:true sends reasoning_effort medium verified.");
}

// ---- Scenario 8: Custom profile with reasoning: false sends reasoning_effort "none",
// same as omitting reasoning entirely (LD-003). ----

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

  await client.generate({ profile, userPrompt: "perform this pass", reasoning: false });

  assert.equal(JSON.parse(request.options.body).reasoning_effort, "none");

  console.log("Dispatcher custom/LM Studio reasoning:false sends reasoning_effort none verified.");
}

// ---- Scenario 9: OpenAI profile with reasoning: true still never sends reasoning_effort
// (LD-041: OpenAI rejects it on non-reasoning models; reasoning is Custom-only). ----

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

  await client.generate({ profile, userPrompt: "perform this pass", reasoning: true });

  assert.ok(!("reasoning_effort" in JSON.parse(request.options.body)), "OpenAI profiles must not send reasoning_effort even with reasoning: true");

  console.log("Dispatcher OpenAI reasoning:true still omits reasoning_effort verified.");
}

// ---- Scenario 10: Gemini profile with reasoning: true produces the same request body as
// without reasoning - the dispatcher never adds a reasoning field to adapterArgs (LD-003). ----

{
  let requestWithout;
  let requestWith;

  const clientWithout = createContext(async (url, options) => {
    requestWithout = { url, options };
    return { ok: true, status: 200, async json() { return { candidates: [{ content: { parts: [{ text: JSON.stringify({ text: "Gemini result." }) }] } }] }; } };
  });
  const clientWith = createContext(async (url, options) => {
    requestWith = { url, options };
    return { ok: true, status: 200, async json() { return { candidates: [{ content: { parts: [{ text: JSON.stringify({ text: "Gemini result." }) }] } }] }; } };
  });

  const profile = {
    providerKind: REGISTRY_PRESETS.PROVIDER_KINDS.GEMINI,
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    modelId: "test-model",
    credential: "test-key-gemini"
  };

  await clientWithout.generate({ profile, userPrompt: "perform this pass" });
  await clientWith.generate({ profile, userPrompt: "perform this pass", reasoning: true });

  const bodyWithout = JSON.parse(requestWithout.options.body);
  const bodyWith = JSON.parse(requestWith.options.body);
  const extraKeys = Object.keys(bodyWith).filter((key) => !(key in bodyWithout));
  assert.deepEqual(extraKeys, [], "Gemini request body must gain no field from reasoning: true");

  console.log("Dispatcher Gemini reasoning:true adds no request field verified.");
}

// ---- Scenario 11: Anthropic profile with reasoning: true produces the same request body
// as without reasoning - the dispatcher never adds a reasoning field to adapterArgs (LD-003). ----

{
  let requestWithout;
  let requestWith;

  const clientWithout = createContext(async (url, options) => {
    requestWithout = { url, options };
    return { ok: true, status: 200, async json() { return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ text: "Anthropic result." }) }] }; } };
  });
  const clientWith = createContext(async (url, options) => {
    requestWith = { url, options };
    return { ok: true, status: 200, async json() { return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ text: "Anthropic result." }) }] }; } };
  });

  const profile = {
    providerKind: REGISTRY_PRESETS.PROVIDER_KINDS.ANTHROPIC,
    endpoint: "https://api.anthropic.com/v1",
    modelId: "test-model",
    credential: "test-key-anthropic"
  };

  await clientWithout.generate({ profile, userPrompt: "perform this pass" });
  await clientWith.generate({ profile, userPrompt: "perform this pass", reasoning: true });

  const bodyWithout = JSON.parse(requestWithout.options.body);
  const bodyWith = JSON.parse(requestWith.options.body);
  const extraKeys = Object.keys(bodyWith).filter((key) => !(key in bodyWithout));
  assert.deepEqual(extraKeys, [], "Anthropic request body must gain no field from reasoning: true");

  console.log("Dispatcher Anthropic reasoning:true adds no request field verified.");
}

// ---- Scenario 12: Custom profile, reasoning: true, HTTP 400 on the structured request -
// the schema-free retry body has no reasoning_effort field (EV-002, LD-031). ----

{
  const requests = [];
  let callCount = 0;
  const client = createContext(async (url, options) => {
    callCount += 1;
    requests.push({ url, options });
    if (callCount === 1) {
      return { ok: false, status: 400, async json() { return { error: { message: "schema not supported" } }; } };
    }
    return { ok: true, status: 200, async json() { return { choices: [{ message: { content: "Custom retry result." } }] }; } };
  });

  const profile = {
    providerKind: REGISTRY_PRESETS.PROVIDER_KINDS.CUSTOM,
    endpoint: "https://lmstudio.example-tailnet.ts.net/v1",
    modelId: "local-model",
    credential: ""
  };

  const result = await client.generate({ profile, userPrompt: "perform this pass", reasoning: true });

  assert.equal(result, "Custom retry result.");
  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(requests[0].options.body).reasoning_effort, "medium");
  assert.ok(!("reasoning_effort" in JSON.parse(requests[1].options.body)), "The schema-free retry body must not carry reasoning_effort");

  console.log("Dispatcher custom/LM Studio schema-free retry omits reasoning_effort verified.");
}

console.log("AI provider client dispatcher contract boundary verified.");
