import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(extensionRoot, "aiClient.js"), "utf8");

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
  return context.SaySlateAIClient;
}

let request;
const client = createClient(async (url, options) => {
  request = { url, options };
  return {
    ok: true,
    status: 200,
    async json() {
      return { candidates: [{ content: { parts: [{ text: "Processed result." }] } }] };
    }
  };
});

const result = await client.generate({
  apiKey: "test-key",
  model: "test-model",
  prompt: "perform this pass"
});

assert.equal(result, "Processed result.");
assert.match(request.url, /test-model:generateContent/);
assert.equal(request.options.method, "POST");
assert.equal(JSON.parse(request.options.body).contents[0].parts[0].text, "perform this pass");

const failingClient = createClient(async () => ({
  ok: false,
  status: 403,
  async json() {
    return { error: { message: "Permission denied" } };
  }
}));

await assert.rejects(
  failingClient.generate({ apiKey: "invalid", model: "test-model", prompt: "text" }),
  (error) => error.statusCode === 403 && error.message === "Permission denied"
);

console.log("AI client success and provider-error paths verified.");

// ---- generateStructured (LD-015/LD-022/LD-025/LD-035(4)/LD-031): the gemini-native
// transport SaySlateAIProviderClient dispatches to. `generate` above is untouched. ----

{
  let request;
  const client = createClient(async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      async json() {
        return { candidates: [{ content: { parts: [{ text: JSON.stringify({ text: "Structured result." }) }] } }] };
      }
    };
  });

  const result = await client.generateStructured({
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    credential: "test-key-gemini",
    modelId: "test-model",
    systemPrompt: "",
    userPrompt: "perform this pass",
    schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
  });

  assert.equal(result, "Structured result.");
  assert.equal(
    request.url,
    "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent?key=test-key-gemini"
  );
  const body = JSON.parse(request.options.body);
  assert.equal(body.contents[0].parts[0].text, "perform this pass");
  assert.equal(body.generationConfig.temperature, 0.1);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.ok(body.systemInstruction === undefined, "an empty systemPrompt must omit systemInstruction");
  assert.ok(!result.includes("test-key-gemini"), "the result must never contain the credential");

  console.log("generateStructured native schema request and empty-systemPrompt omission verified.");
}

{
  const client = createClient(async (url, options) => {
    const body = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return { candidates: [{ content: { parts: [{ text: JSON.stringify({ text: `Echo: ${body.systemInstruction.parts[0].text}` }) }] } }] };
      }
    };
  });

  const result = await client.generateStructured({
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    credential: "test-key-gemini",
    modelId: "test-model",
    systemPrompt: "Follow the house style.",
    userPrompt: "perform this pass",
    schema: { type: "object", properties: { text: { type: "string" } } }
  });

  assert.equal(result, "Echo: Follow the house style.");
  console.log("generateStructured non-empty systemPrompt inclusion verified.");
}

{
  // Schema mismatch: valid JSON, but not the canonical { text: string } shape.
  const client = createClient(async () => ({
    ok: true,
    status: 200,
    async json() {
      return { candidates: [{ content: { parts: [{ text: JSON.stringify({ wrongKey: "value" }) }] } }] };
    }
  }));

  await assert.rejects(
    client.generateStructured({
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      credential: "test-key-gemini",
      modelId: "test-model",
      systemPrompt: "",
      userPrompt: "perform this pass",
      schema: { type: "object", properties: { text: { type: "string" } } }
    }),
    (error) => error.code === "malformed_response"
  );

  console.log("generateStructured schema-mismatch rejection verified.");
}

{
  // Authentication failure maps to the bounded authentication_failed code.
  const client = createClient(async () => ({
    ok: false,
    status: 401,
    async json() {
      return { error: { message: "invalid API key" } };
    }
  }));

  await assert.rejects(
    client.generateStructured({
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      credential: "test-key-gemini",
      modelId: "test-model",
      systemPrompt: "",
      userPrompt: "perform this pass",
      schema: { type: "object", properties: { text: { type: "string" } } }
    }),
    (error) => error.code === "authentication_failed" && !error.message.includes("test-key-gemini")
  );

  console.log("generateStructured authentication-failure mapping verified.");
}

{
  // LD-031: HTTP 400 on the schema request triggers exactly one schema-free retry;
  // the retry response carries only free text (no JSON envelope) and must be accepted.
  let callCount = 0;
  let retryBody;
  const client = createClient(async (url, options) => {
    callCount += 1;
    if (callCount === 1) {
      return {
        ok: false,
        status: 400,
        async json() {
          return { error: { message: "schema not supported" } };
        }
      };
    }
    retryBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return { candidates: [{ content: { parts: [{ text: "  Plain retried text.  " }] } }] };
      }
    };
  });

  const result = await client.generateStructured({
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    credential: "test-key-gemini",
    modelId: "test-model",
    systemPrompt: "",
    userPrompt: "perform this pass",
    schema: { type: "object", properties: { text: { type: "string" } } }
  });

  assert.equal(callCount, 2);
  assert.equal(result, "Plain retried text.");
  assert.ok(retryBody.generationConfig.responseSchema === undefined, "the retry must drop the schema");
  assert.ok(retryBody.generationConfig.responseMimeType === undefined, "the retry must drop the response mime type");

  console.log("generateStructured LD-031 schema-free retry verified.");
}

{
  // LD-031: an empty retry reply is malformed_response, not a silent free-form pass.
  let callCount = 0;
  const client = createClient(async () => {
    callCount += 1;
    if (callCount === 1) return { ok: false, status: 422, async json() { return {}; } };
    return { ok: true, status: 200, async json() { return { candidates: [] }; } };
  });

  await assert.rejects(
    client.generateStructured({
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      credential: "test-key-gemini",
      modelId: "test-model",
      systemPrompt: "",
      userPrompt: "perform this pass",
      schema: { type: "object", properties: { text: { type: "string" } } }
    }),
    (error) => error.code === "malformed_response"
  );

  console.log("generateStructured empty LD-031 retry rejection verified.");
}

{
  // Abort/timeout maps to request_timeout.
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
    client.generateStructured({
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      credential: "test-key-gemini",
      modelId: "test-model",
      systemPrompt: "",
      userPrompt: "perform this pass",
      schema: { type: "object", properties: { text: { type: "string" } } },
      timeoutMs: 5
    }),
    (error) => error.code === "request_timeout"
  );

  console.log("generateStructured abort/timeout mapping verified.");
}

{
  // A thrown non-abort fetch failure maps to network_error.
  const client = createClient(async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  });

  await assert.rejects(
    client.generateStructured({
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      credential: "test-key-gemini",
      modelId: "test-model",
      systemPrompt: "",
      userPrompt: "perform this pass",
      schema: { type: "object", properties: { text: { type: "string" } } }
    }),
    (error) => error.code === "network_error"
  );

  console.log("generateStructured network-error mapping verified.");
}
