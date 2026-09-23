import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

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

console.log("AI provider registry contract boundary verified.");
