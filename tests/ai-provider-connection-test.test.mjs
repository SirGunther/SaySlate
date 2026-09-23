import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registrySource = fs.readFileSync(path.join(extensionRoot, "aiProviderRegistry.js"), "utf8");
const permissionsSource = fs.readFileSync(path.join(extensionRoot, "aiProviderPermissions.js"), "utf8");
const connectionTestSource = fs.readFileSync(path.join(extensionRoot, "aiProviderConnectionTest.js"), "utf8");

// Values returned from inside the vm context carry that sandbox's own Object prototype,
// which fails node:assert/strict's prototype-sensitive deepEqual against a plain literal
// from this module's realm (see tests/ai-provider-permissions.test.mjs). A JSON round-trip
// normalizes to plain data before comparison; every field on this module's result is
// JSON-safe (strings, booleans, null).
const plain = (value) => JSON.parse(JSON.stringify(value));

// A realistic MV3 chrome.permissions fake (same shape as
// tests/ai-provider-permissions.test.mjs): contains/request are callback-style, and every
// call is recorded so a scenario can assert whether chrome.permissions.request was ever
// invoked (LD-034/LD-037: connection testing must never request a permission itself).
function createPermissionsFake({ granted = [] } = {}) {
  const grantedOrigins = new Set(granted);
  const containsCalls = [];
  const requestCalls = [];
  const permissions = {
    contains(descriptor, callback) {
      containsCalls.push(descriptor.origins);
      callback(descriptor.origins.every((origin) => grantedOrigins.has(origin)));
    },
    request(descriptor, callback) {
      requestCalls.push(descriptor.origins);
      callback(false);
    }
  };
  return { chrome: { permissions, runtime: {} }, containsCalls, requestCalls };
}

// Every scenario loads the real registry, the real permissions module, and the real
// connection-test module together in one vm context (EV-031), with an injected fetch fake
// recording every request so tests can assert method/URL/headers/body shape directly.
function createModule({ granted = ["https://api.example.com/*", "https://generativelanguage.googleapis.com/*", "https://api.anthropic.com/*", "https://api.openai.com/*", "https://lmstudio.example-tailnet.ts.net/*"], fetchImplementation } = {}) {
  const requests = [];
  const recordingFetch = async (url, options) => {
    requests.push({ url, options: options || {} });
    return fetchImplementation(url, options || {});
  };

  const { chrome, requestCalls } = createPermissionsFake({ granted });
  const context = {
    chrome,
    URL,
    AbortController,
    fetch: recordingFetch,
    window: { setTimeout, clearTimeout }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(registrySource, context);
  vm.runInContext(permissionsSource, context);
  vm.runInContext(connectionTestSource, context);
  return { module: context.SaySlateAIProviderConnectionTest, requests, requestCalls };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

const GEMINI_PROFILE = {
  providerKind: "gemini",
  endpoint: "https://generativelanguage.googleapis.com/v1beta",
  modelId: "gemini-2.5-flash",
  credential: "test-key-gemini"
};
const OPENAI_PROFILE = {
  providerKind: "openai",
  endpoint: "https://api.openai.com/v1",
  modelId: "gpt-test-model",
  credential: "test-key-openai"
};
const ANTHROPIC_PROFILE = {
  providerKind: "anthropic",
  endpoint: "https://api.anthropic.com/v1",
  modelId: "claude-test-model",
  credential: "test-key-anthropic"
};
const CUSTOM_PROFILE = {
  providerKind: "custom",
  endpoint: "https://lmstudio.example-tailnet.ts.net/v1",
  modelId: "local-model",
  credential: ""
};

// ---- Scenario 1: missing endpoint - invalid_configuration, no fetch at all ----

{
  const { module, requests } = createModule({ fetchImplementation: async () => { throw new Error("must not fetch"); } });
  const result = await module.test({ profile: { ...GEMINI_PROFILE, endpoint: "" } });
  assert.deepEqual(plain(result), { ok: false, code: "invalid_configuration", message: result.message, modelId: "gemini-2.5-flash" });
  assert.equal(requests.length, 0, "a missing endpoint must fail before any network access");
  console.log("Missing-endpoint pre-network invalid_configuration verified.");
}

// ---- Scenario 2: missing model ID - invalid_configuration, no fetch ----

{
  const { module, requests } = createModule({ fetchImplementation: async () => { throw new Error("must not fetch"); } });
  const result = await module.test({ profile: { ...GEMINI_PROFILE, modelId: "" } });
  assert.equal(result.code, "invalid_configuration");
  assert.equal(result.modelId, null);
  assert.equal(requests.length, 0, "a missing model ID must fail before any network access");
  console.log("Missing-model-ID pre-network invalid_configuration verified.");
}

// ---- Scenario 3: missing credential (gemini/openai/anthropic) - invalid_configuration ----

{
  for (const profile of [GEMINI_PROFILE, OPENAI_PROFILE, ANTHROPIC_PROFILE]) {
    const { module, requests } = createModule({ fetchImplementation: async () => { throw new Error("must not fetch"); } });
    const result = await module.test({ profile: { ...profile, credential: "" } });
    assert.equal(result.code, "invalid_configuration", `${profile.providerKind} requires a credential`);
    assert.equal(requests.length, 0, "a missing required credential must fail before any network access");
  }
  console.log("Missing-credential pre-network invalid_configuration verified for gemini/openai/anthropic.");
}

// ---- Scenario 4: custom provider with no credential proceeds to discovery (EV-014) ----

{
  const { module, requests } = createModule({
    fetchImplementation: async () => jsonResponse(200, { object: "list", data: [{ id: "local-model", object: "model" }] })
  });
  const result = await module.test({ profile: CUSTOM_PROFILE });
  assert.deepEqual(plain(result), { ok: true, code: "available", message: result.message, modelId: "local-model" });
  assert.equal(requests.length, 1);
  assert.ok(!("Authorization" in requests[0].options.headers), "a blank credential must omit Authorization entirely");
  console.log("Custom-provider credential-optional discovery verified.");
}

// ---- Scenario 5: permission denied - permission_denied, hasForEndpoint only, never requests ----

{
  const { module, requests, requestCalls } = createModule({
    granted: [],
    fetchImplementation: async () => { throw new Error("must not fetch"); }
  });
  const result = await module.test({ profile: GEMINI_PROFILE });
  assert.equal(result.code, "permission_denied");
  assert.equal(requests.length, 0, "a missing host permission must fail before any network access");
  assert.equal(requestCalls.length, 0, "connection testing must never call chrome.permissions.request itself");
  console.log("Permission-denied pre-network failure verified; no permission was requested.");
}

// ---- Scenario 6: Gemini available - GET /models/<id>?key=<credential>, name matches ----

{
  const { module, requests } = createModule({
    fetchImplementation: async () => jsonResponse(200, { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash" })
  });
  const result = await module.test({ profile: GEMINI_PROFILE });
  assert.deepEqual(plain(result), { ok: true, code: "available", message: result.message, modelId: "gemini-2.5-flash" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, "GET");
  assert.ok(!requests[0].options.body, "a discovery request must never carry a body");
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, "/v1beta/models/gemini-2.5-flash");
  assert.equal(url.searchParams.get("key"), "test-key-gemini");
  console.log("Gemini available-model discovery verified.");
}

// ---- Scenario 7: Gemini 404 - model_unavailable ----

{
  const { module } = createModule({
    fetchImplementation: async () => jsonResponse(404, { error: { code: 404, status: "NOT_FOUND", message: "Model not found." } })
  });
  const result = await module.test({ profile: GEMINI_PROFILE });
  assert.equal(result.code, "model_unavailable");
  console.log("Gemini 404 model_unavailable mapping verified.");
}

// ---- Scenario 8: Gemini bad key (EV-034 exact envelope) - authentication_failed, not a retry ----

{
  let callCount = 0;
  const { module } = createModule({
    fetchImplementation: async () => {
      callCount += 1;
      return jsonResponse(400, {
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message: 'Invalid API key.',
          details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }]
        }
      });
    }
  });
  const result = await module.test({ profile: GEMINI_PROFILE });
  assert.equal(result.code, "authentication_failed");
  assert.equal(callCount, 1, "an invalid-key 400 must not be retried");
  assert.ok(!result.message.includes("test-key-gemini"), "the result must never contain the credential");
  console.log("Gemini EV-034 invalid-key envelope mapping verified.");
}

// ---- Scenario 9: OpenAI-compatible available - GET /models, Bearer auth, exact ID match ----

{
  const { module, requests } = createModule({
    fetchImplementation: async () =>
      jsonResponse(200, { object: "list", data: [{ id: "other-model", object: "model" }, { id: "gpt-test-model", object: "model" }] })
  });
  const result = await module.test({ profile: OPENAI_PROFILE });
  assert.deepEqual(plain(result), { ok: true, code: "available", message: result.message, modelId: "gpt-test-model" });
  assert.equal(requests[0].url, "https://api.openai.com/v1/models");
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-key-openai");
  console.log("OpenAI-compatible available-model discovery verified.");
}

// ---- Scenario 10: OpenAI-compatible reachable but selected model absent - model_unavailable ----

{
  const { module } = createModule({
    fetchImplementation: async () => jsonResponse(200, { object: "list", data: [{ id: "some-other-model", object: "model" }] })
  });
  const result = await module.test({ profile: OPENAI_PROFILE });
  assert.equal(result.code, "model_unavailable");
  console.log("OpenAI-compatible reachable-but-absent-model mapping verified.");
}

// ---- Scenario 11: OpenAI-compatible 401/403 - authentication_failed ----

{
  for (const status of [401, 403]) {
    const { module } = createModule({ fetchImplementation: async () => jsonResponse(status, { error: { message: "unauthorized" } }) });
    const result = await module.test({ profile: OPENAI_PROFILE });
    assert.equal(result.code, "authentication_failed", `status ${status}`);
  }
  console.log("OpenAI-compatible 401/403 authentication_failed mapping verified.");
}

// ---- Scenario 12: Anthropic single page, exact ID present - available, headers/URL exact ----

{
  const { module, requests } = createModule({
    fetchImplementation: async () =>
      jsonResponse(200, {
        data: [{ id: "claude-test-model", type: "model", display_name: "Claude Test Model" }],
        has_more: false,
        first_id: "claude-test-model",
        last_id: "claude-test-model"
      })
  });
  const result = await module.test({ profile: ANTHROPIC_PROFILE });
  assert.deepEqual(plain(result), { ok: true, code: "available", message: result.message, modelId: "claude-test-model" });
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, "/v1/models");
  assert.equal(url.searchParams.get("limit"), "1000");
  assert.equal(url.searchParams.has("after_id"), false);
  assert.equal(requests[0].options.headers["x-api-key"], "test-key-anthropic");
  assert.ok(!("Authorization" in requests[0].options.headers), "Anthropic must authenticate with x-api-key, not Bearer");
  assert.equal(requests[0].options.headers["anthropic-version"], "2023-06-01");
  assert.equal(requests[0].options.headers["anthropic-dangerous-direct-browser-access"], "true");
  console.log("Anthropic single-page available-model discovery verified.");
}

// ---- Scenario 13: Anthropic multi-page - the model appears only on page 2; after_id
// carries page 1's last_id, proving pagination actually advanced. ----

{
  let callCount = 0;
  const { module, requests } = createModule({
    fetchImplementation: async () => {
      callCount += 1;
      if (callCount === 1) {
        return jsonResponse(200, {
          data: [{ id: "page-one-model", type: "model", display_name: "Page One" }],
          has_more: true,
          first_id: "page-one-model",
          last_id: "page-one-model"
        });
      }
      return jsonResponse(200, {
        data: [{ id: "claude-test-model", type: "model", display_name: "Page Two Match" }],
        has_more: false,
        first_id: "claude-test-model",
        last_id: "claude-test-model"
      });
    }
  });
  const result = await module.test({ profile: ANTHROPIC_PROFILE });
  assert.deepEqual(plain(result), { ok: true, code: "available", message: result.message, modelId: "claude-test-model" });
  assert.equal(callCount, 2, "the model on page 2 requires exactly one follow-up page request");
  assert.equal(requests.length, 2);
  const secondUrl = new URL(requests[1].url);
  assert.equal(secondUrl.searchParams.get("after_id"), "page-one-model", "after_id must carry page 1's last_id");
  console.log("Anthropic multi-page pagination (after_id carries prior last_id) verified.");
}

// ---- Scenario 14: Anthropic exhausts pages without a match - model_unavailable ----

{
  const { module } = createModule({
    fetchImplementation: async () =>
      jsonResponse(200, { data: [{ id: "unrelated-model", type: "model", display_name: "Unrelated" }], has_more: false, first_id: "unrelated-model", last_id: "unrelated-model" })
  });
  const result = await module.test({ profile: ANTHROPIC_PROFILE });
  assert.equal(result.code, "model_unavailable");
  console.log("Anthropic reachable-but-absent-model mapping verified.");
}

// ---- Scenario 15: Anthropic 401 - authentication_failed ----

{
  const { module } = createModule({ fetchImplementation: async () => jsonResponse(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) });
  const result = await module.test({ profile: ANTHROPIC_PROFILE });
  assert.equal(result.code, "authentication_failed");
  console.log("Anthropic 401 authentication_failed mapping verified.");
}

// ---- Scenario 16: a generic provider error (500) maps to provider_error ----

{
  const { module } = createModule({ fetchImplementation: async () => jsonResponse(500, { error: "internal" }) });
  const result = await module.test({ profile: OPENAI_PROFILE });
  assert.equal(result.code, "provider_error");
  console.log("Generic provider-error (500) mapping verified.");
}

// ---- Scenario 17: malformed 2xx body (wrong shape) - malformed_response ----

{
  const { module } = createModule({ fetchImplementation: async () => jsonResponse(200, { unexpected: "shape" }) });
  const result = await module.test({ profile: OPENAI_PROFILE });
  assert.equal(result.code, "malformed_response");
  console.log("Wrong-shape 2xx body malformed_response mapping verified.");
}

// ---- Scenario 18: unparseable (non-JSON) 2xx body - malformed_response ----

{
  const { module } = createModule({
    fetchImplementation: async () => ({ ok: true, status: 200, async json() { throw new Error("Unexpected token"); } })
  });
  const result = await module.test({ profile: ANTHROPIC_PROFILE });
  assert.equal(result.code, "malformed_response");
  console.log("Unparseable 2xx body malformed_response mapping verified.");
}

// ---- Scenario 19: fetch rejects - network_error ----

{
  const { module } = createModule({ fetchImplementation: async () => { throw new Error("getaddrinfo ENOTFOUND"); } });
  const result = await module.test({ profile: OPENAI_PROFILE });
  assert.equal(result.code, "network_error");
  console.log("Fetch-rejection network_error mapping verified.");
}

// ---- Scenario 20: the 15-second default timeout aborts cleanly - request_timeout ----

{
  const { module } = createModule({
    fetchImplementation: async (url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })
  });
  const result = await module.test({ profile: OPENAI_PROFILE, timeoutMs: 5 });
  assert.equal(result.code, "request_timeout");
  console.log("Timeout/abort request_timeout mapping verified.");
}

// ---- Scenario 21: no connection-test request is ever a generation request, and no
// request carries a body or any transcript/prompt-shaped field. ----

{
  const seenUrls = [];
  const fetchImplementation = async (url, options) => {
    seenUrls.push(url);
    if (url.includes("generateContent") || url.includes("/chat/completions") || url.includes("/messages")) {
      throw new Error(`must never call a generation endpoint: ${url}`);
    }
    if (options.body) throw new Error("a discovery request must never carry a body");
    if (options.method !== "GET") throw new Error("a discovery request must always be GET");
    if (url.includes("gemini")) return jsonResponse(200, { name: "models/gemini-2.5-flash" });
    if (url.includes("anthropic")) return jsonResponse(200, { data: [{ id: "claude-test-model", type: "model" }], has_more: false, first_id: "x", last_id: "x" });
    return jsonResponse(200, { object: "list", data: [{ id: "gpt-test-model", object: "model" }] });
  };

  for (const profile of [GEMINI_PROFILE, OPENAI_PROFILE, ANTHROPIC_PROFILE]) {
    const { module } = createModule({ fetchImplementation });
    const result = await module.test({ profile });
    assert.equal(result.ok, true);
  }
  assert.ok(seenUrls.length >= 3);
  console.log("No connection-test case calls a generation endpoint, sends a body, or uses a non-GET method.");
}

// ---- Scenario 22: no result across every code contains a credential or raw response body ----

{
  const secretFragment = "test-key-anthropic";
  const cases = [
    { profile: ANTHROPIC_PROFILE, fetchImplementation: async () => jsonResponse(401, { type: "error", error: { message: `bad ${secretFragment}` } }) },
    { profile: ANTHROPIC_PROFILE, fetchImplementation: async () => jsonResponse(500, { error: { message: `server saw ${secretFragment}` } }) },
    { profile: GEMINI_PROFILE, fetchImplementation: async () => jsonResponse(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "bad key test-key-gemini", details: [{ reason: "API_KEY_INVALID" }] } }) }
  ];
  for (const { profile, fetchImplementation } of cases) {
    const { module } = createModule({ fetchImplementation });
    const result = await module.test({ profile });
    assert.ok(!result.message.includes(secretFragment), "result.message must never contain the credential");
    assert.ok(!result.message.includes("test-key-gemini"), "result.message must never contain the credential");
  }
  console.log("No result message leaks a credential across authentication/provider-error outcomes.");
}

console.log("AI provider connection-test contract (pre-network checks, discovery, mapping, secrecy) verified.");
