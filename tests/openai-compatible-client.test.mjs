import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(extensionRoot, "openAICompatibleClient.js"), "utf8");

function createClient(fetchImplementation) {
  const context = {
    AbortController,
    URL,
    TextDecoder,
    fetch: fetchImplementation,
    window: { setTimeout, clearTimeout }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.SaySlateOpenAICompatibleClient;
}

const SCHEMA = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
const ENDPOINT = "https://api.openai.com/v1";

// SAYREASON-01A: a fake SSE `response.body` shaped like LM Studio's (EV-028) - a
// ReadableStream-like object whose reader yields one UTF-8 chunk per `data:` line, each
// separated by chunk-emission timing so streamed timeout/restart behavior is exercised
// the same way the real `fetch` body would deliver it. `signal` (the same AbortSignal the
// adapter aborts on timeout) lets a delayed or hung chunk reject with AbortError, exactly
// as a real in-flight stream read would.
function sseBody(lines, { signal, chunkDelayMs = 0 } = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  // Resolves after `ms`, or rejects with AbortError if `signal` fires first. With no `ms`
  // (the "no more chunks" case below) it never resolves on its own - only an abort settles
  // it, exactly like a stalled LM Studio stream that never sends another byte.
  function waitOrAbort(ms) {
    return new Promise((resolve, reject) => {
      const timer = typeof ms === "number" ? setTimeout(resolve, ms) : null;
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            if (timer) clearTimeout(timer);
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      }
    });
  }
  return {
    getReader() {
      return {
        async read() {
          if (index >= lines.length) {
            // SAYREASON-01A "Stall" scenario: no more chunks and no [DONE] - hang until
            // the caller's abort timer fires, exactly like a stalled LM Studio stream.
            await waitOrAbort();
            return { done: true, value: undefined };
          }
          await waitOrAbort(chunkDelayMs);
          const value = encoder.encode(lines[index]);
          index += 1;
          return { done: false, value };
        }
      };
    }
  };
}

function sseResponse(lines, { signal, chunkDelayMs = 0 } = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: sseBody(lines, { signal, chunkDelayMs })
  };
}

function dataLine(payload) {
  return `data: ${JSON.stringify(payload)}\n`;
}

// ---- Scenario 1: exact URL, headers (conditional Bearer), and json_schema strict body ----

{
  let request;
  const client = createClient(async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: JSON.stringify({ text: "Processed result." }) } }] };
      }
    };
  });

  const result = await client.generate({
    endpoint: ENDPOINT,
    credential: "test-key-openai",
    modelId: "test-model",
    systemPrompt: "",
    userPrompt: "perform this pass",
    schema: SCHEMA
  });

  assert.equal(result, "Processed result.");
  assert.equal(request.url, `${ENDPOINT}/chat/completions`);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer test-key-openai");
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "test-model");
  assert.deepEqual(body.messages, [{ role: "user", content: "perform this pass" }]);
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema, SCHEMA);
  assert.ok(body.temperature === undefined, "no sampling parameters must be sent");
  assert.ok(body.top_p === undefined, "no sampling parameters must be sent");
  assert.ok(body.max_tokens === undefined, "no token-limit parameters must be sent");
  assert.ok(!result.includes("test-key-openai"), "the result must never contain the credential");

  console.log("OpenAI-compatible exact URL/headers/schema-body request verified.");
}

// ---- Scenario 2: a non-empty systemPrompt is included; blank credential omits Bearer ----

{
  let request;
  const client = createClient(async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, async json() { return { choices: [{ message: { content: JSON.stringify({ text: "ok" }) } }] }; } };
  });

  await client.generate({
    endpoint: "https://lmstudio.example-tailnet.ts.net/v1",
    credential: "",
    modelId: "local-model",
    systemPrompt: "Follow the house style.",
    userPrompt: "perform this pass",
    schema: SCHEMA
  });

  assert.ok(!("Authorization" in request.options.headers), "a blank credential (LM Studio) must omit Authorization");
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.messages[0], { role: "system", content: "Follow the house style." });

  console.log("OpenAI-compatible blank-credential/system-prompt inclusion verified.");
}

// ---- Scenario 3: malformed (non-JSON) response body ----

{
  const client = createClient(async () => ({
    ok: true,
    status: 200,
    async json() {
      throw new Error("Unexpected token");
    }
  }));

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "test-key-openai", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA }),
    (error) => error.code === "malformed_response"
  );

  console.log("OpenAI-compatible malformed-JSON-body rejection verified.");
}

// ---- Scenario 4: schema mismatch (valid JSON, wrong shape) ----

{
  const client = createClient(async () => ({
    ok: true,
    status: 200,
    async json() { return { choices: [{ message: { content: JSON.stringify({ wrongKey: "value" }) } }] }; }
  }));

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "test-key-openai", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA }),
    (error) => error.code === "malformed_response"
  );

  console.log("OpenAI-compatible schema-mismatch rejection verified.");
}

// ---- Scenario 5: a model refusal maps to provider_error ----

{
  const client = createClient(async () => ({
    ok: true,
    status: 200,
    async json() { return { choices: [{ message: { refusal: "I can't help with that.", content: null } }] }; }
  }));

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "test-key-openai", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA }),
    (error) => error.code === "provider_error" && !error.message.includes("I can't help with that.")
  );

  console.log("OpenAI-compatible refusal mapping verified.");
}

// ---- Scenario 6: authentication failure ----

{
  const client = createClient(async () => ({
    ok: false,
    status: 401,
    async json() { return { error: { message: "invalid_api_key" } }; }
  }));

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "test-key-openai", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA }),
    (error) => error.code === "authentication_failed" && !error.message.includes("test-key-openai")
  );

  console.log("OpenAI-compatible authentication-failure mapping verified.");
}

// ---- Scenario 7: a generic provider error (500) ----

{
  const client = createClient(async () => ({ ok: false, status: 500, async json() { return { error: { message: "internal" } }; } }));

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "test-key-openai", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA }),
    (error) => error.code === "provider_error"
  );

  console.log("OpenAI-compatible generic provider-error mapping verified.");
}

// ---- Scenario 8 (LD-031): HTTP 400 on the schema request retries once without schema,
// dropping response_format entirely, and accepts a trimmed non-empty text reply. ----

{
  let callCount = 0;
  let retryBody;
  const client = createClient(async (url, options) => {
    callCount += 1;
    if (callCount === 1) return { ok: false, status: 400, async json() { return { error: { message: "schema unsupported" } }; } };
    retryBody = JSON.parse(options.body);
    return { ok: true, status: 200, async json() { return { choices: [{ message: { content: "  Plain retried text.  " } }] }; } };
  });

  const result = await client.generate({ endpoint: ENDPOINT, credential: "test-key-openai", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA });

  assert.equal(callCount, 2);
  assert.equal(result, "Plain retried text.");
  assert.ok(retryBody.response_format === undefined, "the retry must drop response_format entirely");

  console.log("OpenAI-compatible LD-031 schema-free retry verified.");
}

// ---- Scenario 9 (LD-031): an empty retry reply is malformed_response, final outcome ----

{
  let callCount = 0;
  const client = createClient(async () => {
    callCount += 1;
    if (callCount === 1) return { ok: false, status: 422, async json() { return {}; } };
    return { ok: true, status: 200, async json() { return { choices: [{ message: { content: "   " } }] }; } };
  });

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "test-key-openai", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA }),
    (error) => error.code === "malformed_response"
  );
  assert.equal(callCount, 2, "the empty retry must not be retried again");

  console.log("OpenAI-compatible empty LD-031 retry rejection verified.");
}

// ---- Scenario 10: abort/timeout ----

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
    client.generate({ endpoint: ENDPOINT, credential: "test-key-openai", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA, timeoutMs: 5 }),
    (error) => error.code === "request_timeout"
  );

  console.log("OpenAI-compatible abort/timeout mapping verified.");
}

// ---- Scenario 11: a network-level fetch failure ----

{
  const client = createClient(async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  });

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "test-key-openai", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA }),
    (error) => error.code === "network_error"
  );

  console.log("OpenAI-compatible network-error mapping verified.");
}

console.log("OpenAI-compatible client contract boundary verified.");

// ---- LD-041: reasoning_effort is sent only when asked, and only on the structured request;
// a schema rejection's plain retry omits it, as it omits response_format. ----

{
  let callCount = 0;
  const bodies = [];
  const client = createClient(async (url, options) => {
    callCount += 1;
    bodies.push(JSON.parse(options.body));
    if (callCount === 1) return { ok: false, status: 400, async json() { return { error: { message: "schema unsupported" } }; } };
    return { ok: true, status: 200, async json() { return { choices: [{ message: { content: "Plain retried text." } }] }; } };
  });

  const result = await client.generate({
    endpoint: "https://lmstudio.example-tailnet.ts.net/v1",
    credential: "",
    modelId: "local-model",
    systemPrompt: "",
    userPrompt: "perform this pass",
    schema: SCHEMA,
    reasoningEffort: "none"
  });

  assert.equal(result, "Plain retried text.");
  assert.equal(bodies[0].reasoning_effort, "none", "the structured request must carry reasoning_effort");
  assert.ok(!("reasoning_effort" in bodies[1]), "the plain retry must omit reasoning_effort");

  console.log("LD-041 reasoning_effort on the structured request only verified.");
}

{
  let body;
  const client = createClient(async (url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, status: 200, async json() { return { choices: [{ message: { content: JSON.stringify({ text: "ok" }) } }] }; } };
  });

  await client.generate({ endpoint: ENDPOINT, credential: "k", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA });

  assert.ok(!("reasoning_effort" in body), "without reasoningEffort the field must be absent");

  console.log("LD-041 reasoning_effort absent by default verified.");
}

// ==== SAYREASON-01A: Custom (LM Studio) streaming - body, timer restart, SSE parsing ====

// ---- Body: stream:true puts stream:true in the structured body; omitted leaves it absent ----

{
  let body;
  const client = createClient(async (url, options) => {
    body = JSON.parse(options.body);
    return sseResponse([dataLine({ choices: [{ delta: { content: JSON.stringify({ text: "ok" }) } }] }), "data: [DONE]\n"]);
  });

  await client.generate({ endpoint: ENDPOINT, credential: "k", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA, stream: true });

  assert.equal(body.stream, true, "stream:true must appear in the structured request body");

  console.log("SAYREASON-01A stream:true present in structured body verified.");
}

{
  let body;
  const client = createClient(async (url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, status: 200, async json() { return { choices: [{ message: { content: JSON.stringify({ text: "ok" }) } }] }; } };
  });

  await client.generate({ endpoint: ENDPOINT, credential: "k", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA });

  assert.ok(!("stream" in body), "stream omitted must leave no stream field");

  console.log("SAYREASON-01A stream field absent by default verified.");
}

// ---- Reasoning then content: reasoning_content chunks are ignored; content is returned ----

{
  const client = createClient(async (url, options) => sseResponse([
    dataLine({ choices: [{ delta: { reasoning_content: "Let me think about this carefully... " } }] }),
    dataLine({ choices: [{ delta: { reasoning_content: "Considering the transcript. " } }] }),
    dataLine({ choices: [{ delta: { content: JSON.stringify({ text: "Reasoned result." }) } }] }),
    "data: [DONE]\n"
  ], { signal: options.signal }));

  const result = await client.generate({ endpoint: ENDPOINT, credential: "k", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA, stream: true });

  assert.equal(result, "Reasoned result.");
  assert.ok(!result.includes("think"), "reasoning_content must never reach the returned text");

  console.log("SAYREASON-01A reasoning_content ignored, content returned verified.");
}

// ---- Slow but steady: chunks every 20ms totalling above 150ms resolve with timeoutMs:50 ----

{
  const chunkText = JSON.stringify({ text: "Slow steady result." });
  const lines = [];
  for (let i = 0; i < chunkText.length; i += 4) {
    lines.push(dataLine({ choices: [{ delta: { content: chunkText.slice(i, i + 4) } }] }));
  }
  lines.push("data: [DONE]\n");
  assert.ok(lines.length >= 8, "the test needs enough chunks for the 20ms gaps to exceed 150ms total");

  const client = createClient(async (url, options) => sseResponse(lines, { signal: options.signal, chunkDelayMs: 20 }));

  const started = Date.now();
  const result = await client.generate({ endpoint: ENDPOINT, credential: "k", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA, stream: true, timeoutMs: 50 });
  const elapsedMs = Date.now() - started;

  assert.equal(result, "Slow steady result.");
  assert.ok(elapsedMs > 150, `expected the steady stream to take over 150ms total, took ${elapsedMs}ms`);

  console.log("SAYREASON-01A slow-but-steady stream resolves past the per-chunk timeout verified.");
}

// ---- Stall: one chunk then no more rejects with request_timeout at timeoutMs:50 ----

{
  const client = createClient(async (url, options) => sseResponse([
    dataLine({ choices: [{ delta: { content: "partial" } }] })
    // no [DONE], no further chunks - the reader hangs until the abort timer fires.
  ], { signal: options.signal }));

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "k", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA, stream: true, timeoutMs: 50 }),
    (error) => error.code === "request_timeout"
  );

  console.log("SAYREASON-01A stalled stream times out verified.");
}

// ---- Error payload mid-stream -> provider_error ----

{
  const client = createClient(async (url, options) => sseResponse([
    dataLine({ error: { message: "server exploded" } }),
    "data: [DONE]\n"
  ], { signal: options.signal }));

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "k", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA, stream: true }),
    (error) => error.code === "provider_error"
  );

  console.log("SAYREASON-01A mid-stream error payload verified.");
}

// ---- Refusal delta -> provider_error ----

{
  const client = createClient(async (url, options) => sseResponse([
    dataLine({ choices: [{ delta: { refusal: "I can't help with that." } }] }),
    "data: [DONE]\n"
  ], { signal: options.signal }));

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "k", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA, stream: true }),
    (error) => error.code === "provider_error" && !error.message.includes("I can't help with that.")
  );

  console.log("SAYREASON-01A refusal delta verified.");
}

// ---- Unparseable data: line -> malformed_response ----

{
  const client = createClient(async (url, options) => sseResponse([
    "data: {not valid json\n",
    "data: [DONE]\n"
  ], { signal: options.signal }));

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "k", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA, stream: true }),
    (error) => error.code === "malformed_response"
  );

  console.log("SAYREASON-01A unparseable data line verified.");
}

// ---- Content that fails the schema -> malformed_response ----

{
  const client = createClient(async (url, options) => sseResponse([
    dataLine({ choices: [{ delta: { content: JSON.stringify({ wrongKey: "value" }) } }] }),
    "data: [DONE]\n"
  ], { signal: options.signal }));

  await assert.rejects(
    client.generate({ endpoint: ENDPOINT, credential: "k", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA, stream: true }),
    (error) => error.code === "malformed_response"
  );

  console.log("SAYREASON-01A schema-mismatch streamed content verified.");
}

// ---- Server ignores stream: stream:true with an application/json response uses the JSON path ----

{
  const client = createClient(async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    async json() { return { choices: [{ message: { content: JSON.stringify({ text: "JSON path result." }) } }] }; }
  }));

  const result = await client.generate({ endpoint: ENDPOINT, credential: "k", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA, stream: true });

  assert.equal(result, "JSON path result.");

  console.log("SAYREASON-01A server-ignores-stream JSON-path fallback verified.");
}

// ---- HTTP 400 with stream:true: the schema-free retry body is exactly { model, messages } ----

{
  let callCount = 0;
  let retryBody;
  const client = createClient(async (url, options) => {
    callCount += 1;
    if (callCount === 1) return { ok: false, status: 400, async json() { return { error: { message: "schema unsupported" } }; } };
    retryBody = JSON.parse(options.body);
    return { ok: true, status: 200, async json() { return { choices: [{ message: { content: "Plain retried text." } }] }; } };
  });

  const result = await client.generate({ endpoint: ENDPOINT, credential: "k", modelId: "m", systemPrompt: "", userPrompt: "u", schema: SCHEMA, stream: true });

  assert.equal(callCount, 2);
  assert.equal(result, "Plain retried text.");
  assert.deepEqual(Object.keys(retryBody).sort(), ["messages", "model"], "the retry body with stream:true must be exactly { model, messages }");
  assert.ok(!("stream" in retryBody), "the schema-free retry must never carry stream");

  console.log("SAYREASON-01A stream:true HTTP 400 schema-free retry body verified.");
}

console.log("SAYREASON-01A streaming scenarios verified.");
