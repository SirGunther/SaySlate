import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(extensionRoot, "anthropicClient.js"), "utf8");

function createClient(fetchImplementation) {
  const context = {
    AbortController,
    URL,
    fetch: fetchImplementation,
    window: { setTimeout, clearTimeout }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.SaySlateAnthropicClient;
}

const SCHEMA = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
const ENDPOINT = "https://api.anthropic.com/v1";

// ---- Scenario 1: exact URL, x-api-key/version/browser-access headers, and body shape ----

{
  let request;
  const client = createClient(async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      async json() {
        return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ text: "Processed result." }) }] };
      }
    };
  });

  const result = await client.generate({
    endpoint: ENDPOINT,
    credential: "test-key-anthropic",
    modelId: "test-model",
    systemPrompt: "",
    userPrompt: "perform this pass",
    schema: SCHEMA
  });

  assert.equal(result, "Processed result.");
  assert.equal(request.url, `${ENDPOINT}/messages`);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["x-api-key"], "test-key-anthropic");
  assert.ok(!("Authorization" in request.options.headers), "Anthropic API keys must not use Bearer authentication");
  assert.equal(request.options.headers["anthropic-version"], "2023-06-01");
  assert.equal(request.options.headers["anthropic-dangerous-direct-browser-access"], "true");

  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "test-model");
  assert.equal(body.max_tokens, 16000);
  assert.deepEqual(body.messages, [{ role: "user", content: "perform this pass" }]);
  assert.equal(body.output_config.format.type, "json_schema");
  assert.deepEqual(body.output_config.format.schema, SCHEMA);
  assert.ok(body.system === undefined, "an empty systemPrompt must omit the system field");
  assert.ok(body.temperature === undefined, "sampling parameters return HTTP 400 on current Claude models (EV-033)");
  assert.ok(body.top_p === undefined, "sampling parameters return HTTP 400 on current Claude models (EV-033)");
  assert.ok(body.top_k === undefined, "sampling parameters return HTTP 400 on current Claude models (EV-033)");
  assert.ok(!result.includes("test-key-anthropic"), "the result must never contain the credential");

  console.log("Anthropic exact URL/headers/schema-body request verified.");
}

// ---- Scenario 2: a non-empty systemPrompt is included on the body ----

{
  let request;
  const client = createClient(async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, async json() { return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ text: "ok" }) }] }; } };
  });

  await client.generate({
    endpoint: ENDPOINT,
    credential: "test-key-anthropic",
    modelId: "test-model",
    systemPrompt: "Follow the house style.",
    userPrompt: "perform this pass",
    schema: SCHEMA
  });

  const body = JSON.parse(request.options.body);
  assert.equal(body.system, "Follow the house style.");

  console.log("Anthropic non-empty systemPrompt inclusion verified.");
}

// ---- Scenario 3: malformed (non-JSON) response body ----

{
  const client = createClient(async () => ({ ok: true, status: 200, async json() { throw new Error("Unexpected token"); } }));

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "test-key-anthropic", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA }),
    (error) => error.code === "malformed_response"
  );

  console.log("Anthropic malformed-JSON-body rejection verified.");
}

// ---- Scenario 4: schema mismatch (valid JSON, wrong shape) ----

{
  const client = createClient(async () => ({
    ok: true,
    status: 200,
    async json() { return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ wrongKey: "value" }) }] }; }
  }));

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "test-key-anthropic", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA }),
    (error) => error.code === "malformed_response"
  );

  console.log("Anthropic schema-mismatch rejection verified.");
}

// ---- Scenario 5 (LD-035): stop_reason "refusal" maps to provider_error ----

{
  const client = createClient(async () => ({ ok: true, status: 200, async json() { return { stop_reason: "refusal", content: [] }; } }));

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "test-key-anthropic", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA }),
    (error) => error.code === "provider_error"
  );

  console.log("Anthropic refusal stop_reason mapping verified.");
}

// ---- Scenario 6 (LD-035): stop_reason "max_tokens" maps to malformed_response ----

{
  const client = createClient(async () => ({
    ok: true,
    status: 200,
    async json() { return { stop_reason: "max_tokens", content: [{ type: "text", text: JSON.stringify({ text: "partial" }) }] }; }
  }));

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "test-key-anthropic", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA }),
    (error) => error.code === "malformed_response"
  );

  console.log("Anthropic max_tokens stop_reason mapping verified.");
}

// ---- Scenario 7: authentication failure ----

{
  const client = createClient(async () => ({ ok: false, status: 401, async json() { return { error: { message: "authentication_error" } }; } }));

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "test-key-anthropic", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA }),
    (error) => error.code === "authentication_failed" && !error.message.includes("test-key-anthropic")
  );

  console.log("Anthropic authentication-failure mapping verified.");
}

// ---- Scenario 8: a generic provider error (500) ----

{
  const client = createClient(async () => ({ ok: false, status: 500, async json() { return { error: { message: "internal" } }; } }));

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "test-key-anthropic", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA }),
    (error) => error.code === "provider_error"
  );

  console.log("Anthropic generic provider-error mapping verified.");
}

// ---- Scenario 9 (LD-031): HTTP 400 on the schema request retries once without schema,
// dropping output_config entirely, and accepts a trimmed non-empty text reply. ----

{
  let callCount = 0;
  let retryBody;
  const client = createClient(async (url, options) => {
    callCount += 1;
    if (callCount === 1) return { ok: false, status: 400, async json() { return { error: { message: "schema unsupported" } }; } };
    retryBody = JSON.parse(options.body);
    return { ok: true, status: 200, async json() { return { stop_reason: "end_turn", content: [{ type: "text", text: "  Plain retried text.  " }] }; } };
  });

  const result = await client.generate({ endpoint: ENDPOINT, credential: "test-key-anthropic", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA });

  assert.equal(callCount, 2);
  assert.equal(result, "Plain retried text.");
  assert.ok(retryBody.output_config === undefined, "the retry must drop output_config entirely");
  assert.equal(retryBody.max_tokens, 16000);

  console.log("Anthropic LD-031 schema-free retry verified.");
}

// ---- Scenario 10 (LD-031): an empty retry reply is malformed_response, final outcome ----

{
  let callCount = 0;
  const client = createClient(async () => {
    callCount += 1;
    if (callCount === 1) return { ok: false, status: 422, async json() { return {}; } };
    return { ok: true, status: 200, async json() { return { stop_reason: "end_turn", content: [] }; } };
  });

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "test-key-anthropic", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA }),
    (error) => error.code === "malformed_response"
  );
  assert.equal(callCount, 2, "the empty retry must not be retried again");

  console.log("Anthropic empty LD-031 retry rejection verified.");
}

// ---- Scenario 11: abort/timeout ----

{
  const client = createClient(
    async (url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })
  );

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "test-key-anthropic", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA, timeoutMs: 5 }),
    (error) => error.code === "request_timeout"
  );

  console.log("Anthropic abort/timeout mapping verified.");
}

// ---- Scenario 12: a network-level fetch failure ----

{
  const client = createClient(async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  });

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "test-key-anthropic", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA }),
    (error) => error.code === "network_error"
  );

  console.log("Anthropic network-error mapping verified.");
}

console.log("Anthropic client contract boundary verified.");
