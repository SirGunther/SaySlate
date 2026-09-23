import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(extensionRoot, "aiProviderRegistry.js"), "utf8");

function createRegistry() {
  const context = { URL };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.SaySlateAIProviderRegistry;
}

const registry = createRegistry();

// ---- Scenario 1: every provider kind resolves to one explicit preset/transport contract ----

{
  const gemini = registry.presetFor(registry.PROVIDER_KINDS.GEMINI);
  assert.equal(gemini.transportKind, registry.TRANSPORT_KINDS.GEMINI_NATIVE);
  assert.equal(gemini.defaultEndpoint, "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(gemini.discoveryStrategy, registry.DISCOVERY_STRATEGIES.GEMINI_EXACT_MODEL_RETRIEVAL);

  const openai = registry.presetFor(registry.PROVIDER_KINDS.OPENAI);
  assert.equal(openai.transportKind, registry.TRANSPORT_KINDS.OPENAI_CHAT_COMPLETIONS);
  assert.equal(openai.defaultEndpoint, "https://api.openai.com/v1");
  assert.equal(openai.discoveryStrategy, registry.DISCOVERY_STRATEGIES.EXACT_ID_MODEL_LIST_MATCH);

  const anthropic = registry.presetFor(registry.PROVIDER_KINDS.ANTHROPIC);
  assert.equal(anthropic.transportKind, registry.TRANSPORT_KINDS.ANTHROPIC_MESSAGES);
  assert.equal(anthropic.defaultEndpoint, "https://api.anthropic.com/v1");
  assert.equal(anthropic.discoveryStrategy, registry.DISCOVERY_STRATEGIES.EXACT_ID_MODEL_LIST_MATCH);

  // LD-024: custom/LM Studio maps to the OpenAI-compatible transport, blank editable endpoint.
  const custom = registry.presetFor(registry.PROVIDER_KINDS.CUSTOM);
  assert.equal(custom.transportKind, registry.TRANSPORT_KINDS.OPENAI_CHAT_COMPLETIONS);
  assert.equal(custom.defaultEndpoint, "");
  assert.equal(custom.discoveryStrategy, registry.DISCOVERY_STRATEGIES.EXACT_ID_MODEL_LIST_MATCH);

  assert.equal(registry.presetFor("unknown-kind"), null, "an unrecognized provider kind must not resolve a preset");

  console.log("Every provider kind resolves to one explicit preset/transport contract verified.");
}

// ---- Scenario 2: endpoint normalization accepts a valid HTTPS endpoint and strips one trailing slash ----

{
  const trimmed = registry.normalizeEndpoint("https://lmstudio.example-tailnet.ts.net/v1/");
  assert.equal(trimmed.ok, true);
  assert.equal(trimmed.endpoint, "https://lmstudio.example-tailnet.ts.net/v1");

  const rootOnly = registry.normalizeEndpoint("https://lmstudio.example-tailnet.ts.net/");
  assert.equal(rootOnly.ok, true);
  assert.equal(rootOnly.endpoint, "https://lmstudio.example-tailnet.ts.net");

  const withWhitespace = registry.normalizeEndpoint("  https://lmstudio.example-tailnet.ts.net/v1  ");
  assert.equal(withWhitespace.ok, true);
  assert.equal(withWhitespace.endpoint, "https://lmstudio.example-tailnet.ts.net/v1");

  console.log("Endpoint normalization of a valid HTTPS endpoint and trailing-slash stripping verified.");
}

// ---- Scenario 3: every rejection LD-024 lists is actually rejected, none accepted ----

{
  const rejectedInputs = [
    ["blank", ""],
    ["whitespace-only", "   "],
    ["unparsable", "not a url"],
    ["non-https scheme", "http://lmstudio.example-tailnet.ts.net/v1"],
    ["embedded credentials", "https://user:pass@lmstudio.example-tailnet.ts.net/v1"],
    ["query string", "https://lmstudio.example-tailnet.ts.net/v1?key=test-fake-key"],
    ["fragment", "https://lmstudio.example-tailnet.ts.net/v1#section"],
    ["invalid origin (no host)", "https://"]
  ];

  for (const [label, input] of rejectedInputs) {
    const result = registry.normalizeEndpoint(input);
    assert.equal(result.ok, false, `endpoint rejection missing for: ${label}`);
    assert.equal(result.code, "invalid_configuration", `wrong rejection code for: ${label}`);
    assert.equal(result.endpoint, null, `a rejected endpoint must not surface a normalized value for: ${label}`);
  }

  console.log("Every LD-024 endpoint rejection verified.");
}

// ---- Scenario 4: exact origin-pattern derivation never widens beyond the normalized origin ----

{
  const pattern = registry.originPatternForEndpoint("https://lmstudio.example-tailnet.ts.net/v1/");
  assert.equal(pattern, "https://lmstudio.example-tailnet.ts.net/*");

  const portedPattern = registry.originPatternForEndpoint("https://lmstudio.example-tailnet.ts.net:8443/v1");
  assert.equal(portedPattern, "https://lmstudio.example-tailnet.ts.net:8443/*");

  assert.equal(
    registry.originPatternForEndpoint("http://lmstudio.example-tailnet.ts.net/v1"),
    null,
    "an invalid endpoint must not derive any origin pattern"
  );

  console.log("Exact origin-pattern derivation verified.");
}

// ---- Scenario 5 (F1): a normalized custom endpoint persists through the SAYAI-01 profile
// boundary, reloads unchanged, derives the identical exact origin pattern, and an edit to
// it leaves an unrelated (Gemini-preset) profile untouched. This loads the real
// aiProviderRegistry.js and aiProviderSettings.js into one node:vm context together,
// against a shared chrome.storage.local fake (EV-031's harness pattern; the storage fake
// itself follows tests/ai-provider-settings.test.mjs's createStorage). ----

{
  const settingsSource = fs.readFileSync(path.join(extensionRoot, "aiProviderSettings.js"), "utf8");

  function createStorage(initial = {}) {
    const backing = { ...initial };
    const api = {
      local: {
        get(key, callback) {
          callback({ [key]: backing[key] });
        },
        set(entries, callback) {
          Object.assign(backing, JSON.parse(JSON.stringify(entries)));
          callback();
        }
      }
    };
    return { backing, chrome: { storage: api, runtime: {} } };
  }

  // Loads registry + settings together, matching SAYAI-04/SAYAI-05's real consumption:
  // registry normalizes/derives the origin, settings persists the resulting profile.
  function createContext(chrome) {
    const context = { chrome, crypto: { randomUUID }, URL };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context);
    vm.runInContext(settingsSource, context);
    return context;
  }

  const storage = createStorage();
  const contextA = createContext(storage.chrome);
  const registryA = contextA.SaySlateAIProviderRegistry;
  const settingsA = contextA.SaySlateAIProviderSettings;
  await settingsA.load();

  const rawEndpoint = "https://lmstudio.example-tailnet.ts.net/v3/";
  const normalized = registryA.normalizeEndpoint(rawEndpoint);
  assert.equal(normalized.ok, true);

  const geminiPreset = registryA.presetFor(registryA.PROVIDER_KINDS.GEMINI);
  const geminiProfile = await settingsA.upsertProfile({
    name: "Gemini",
    providerKind: registryA.PROVIDER_KINDS.GEMINI,
    endpoint: geminiPreset.defaultEndpoint,
    modelId: "gemini-3.1-flash-lite",
    credential: "test-key-gemini",
    credentialAction: "replace"
  });

  const customProfile = await settingsA.upsertProfile({
    name: "LM Studio",
    providerKind: registryA.PROVIDER_KINDS.CUSTOM,
    endpoint: normalized.endpoint,
    modelId: "local-model",
    credential: "test-key-custom",
    credentialAction: "replace"
  });

  // Reload from a fresh module instance (fresh vm context, matching a fresh page load),
  // reading the same underlying storage - through both public boundaries together.
  const contextB = createContext(storage.chrome);
  const registryB = contextB.SaySlateAIProviderRegistry;
  const settingsB = contextB.SaySlateAIProviderSettings;
  const reloaded = await settingsB.load();

  const reloadedCustom = reloaded.profiles.find((profile) => profile.id === customProfile.id);
  assert.equal(reloadedCustom.endpoint, normalized.endpoint, "the stored endpoint must equal the normalized value");

  assert.equal(
    registryB.originPatternForEndpoint(reloadedCustom.endpoint),
    registryB.originPatternForEndpoint(rawEndpoint),
    "the reloaded stored endpoint must derive the identical exact origin pattern as the original raw (pre-normalization) input"
  );

  // Editing the custom profile's endpoint to a different HTTPS origin must not disturb
  // the unrelated Gemini-preset profile's endpoint or credential.
  const otherEndpoint = "https://other-lmstudio.example-tailnet.ts.net/v1";
  await settingsB.upsertProfile({
    id: customProfile.id,
    endpoint: otherEndpoint,
    credentialAction: "retain"
  });

  const afterEdit = storage.backing["sayslate-ai-provider-profiles"];
  const editedCustom = afterEdit.profiles.find((profile) => profile.id === customProfile.id);
  const untouchedGemini = afterEdit.profiles.find((profile) => profile.id === geminiProfile.id);
  assert.equal(editedCustom.endpoint, otherEndpoint);
  assert.equal(
    untouchedGemini.endpoint,
    geminiPreset.defaultEndpoint,
    "editing the custom profile's endpoint must not disturb the Gemini profile's endpoint"
  );
  assert.equal(untouchedGemini.credential, "test-key-gemini");

  console.log("Custom endpoint normalization persisting through the SAYAI-01 profile boundary (F1) verified.");
}

console.log("AI provider registry contract boundary verified.");
