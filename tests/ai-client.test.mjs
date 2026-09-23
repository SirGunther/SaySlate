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
  // LD-036(1): the canonical schema rides on responseJsonSchema, never responseSchema -
  // Gemini rejects responseSchema outright when it carries additionalProperties (EV-034(a)).
  assert.deepEqual(
    body.generationConfig.responseJsonSchema,
    { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
  );
  assert.ok(body.generationConfig.responseSchema === undefined, "responseSchema must never be sent");
  assert.ok(body.systemInstruction === undefined, "an empty systemPrompt must omit systemInstruction");
  assert.ok(!result.includes("test-key-gemini"), "the result must never contain the credential");

  console.log("generateStructured native schema request (responseJsonSchema) and empty-systemPrompt omission verified.");
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
  // Generic HTTP status mapping (mapStatusToCode's 401/403 branch) - not Gemini's actual
  // bad-key path. Gemini itself never returns 401/403 for an invalid key (EV-034(b));
  // that path is covered separately below via the exact API_KEY_INVALID envelope.
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

  console.log("generateStructured generic 401 status mapping verified (not Gemini's actual bad-key shape).");
}

{
  // LD-036(2)/EV-034(b): Gemini's actual invalid-key response is HTTP 400 INVALID_ARGUMENT
  // with reason API_KEY_INVALID in error.details[] - this must be authentication_failed
  // with exactly one fetch call (no LD-031 retry), and the message must not leak the key
  // or the raw response body.
  let callCount = 0;
  const client = createClient(async () => {
    callCount += 1;
    return {
      ok: false,
      status: 400,
      async json() {
        return {
          error: {
            code: 400,
            message: "API key not valid. Please pass a valid API key.",
            status: "INVALID_ARGUMENT",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "API_KEY_INVALID",
                domain: "googleapis.com",
                metadata: { service: "generativelanguage.googleapis.com" }
              }
            ]
          }
        };
      }
    };
  });

  await assert.rejects(
    client.generateStructured({
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      credential: "test-key-gemini-invalid",
      modelId: "test-model",
      systemPrompt: "",
      userPrompt: "perform this pass",
      schema: { type: "object", properties: { text: { type: "string" } } }
    }),
    (error) =>
      error.code === "authentication_failed" &&
      !error.message.includes("test-key-gemini-invalid") &&
      !error.message.includes("API key not valid")
  );

  assert.equal(callCount, 1, "an invalid-key response must never trigger the LD-031 retry");

  console.log("generateStructured EV-034(b)/LD-036(2) API_KEY_INVALID mapping (no retry) verified.");
}

{
  // LD-031: a genuine schema-rejection HTTP 400 (no API_KEY_INVALID reason) on the
  // schema request triggers exactly one schema-free retry; the retry response carries
  // only free text (no JSON envelope) and must be accepted.
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
  assert.ok(retryBody.generationConfig.responseJsonSchema === undefined, "the retry must drop responseJsonSchema");
  assert.ok(retryBody.generationConfig.responseSchema === undefined, "the retry must never send responseSchema");
  assert.ok(retryBody.generationConfig.responseMimeType === undefined, "the retry must drop the response mime type");

  console.log("generateStructured LD-031 schema-free retry (genuine schema rejection) verified.");
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

{
  // LD-039: the observed failure - HTTP 503 on the schema request - gets one schema-free
  // retry (the original plain request) and the retry's free text is accepted.
  let callCount = 0;
  let retryBody;
  const client = createClient(async (url, options) => {
    callCount += 1;
    if (callCount === 1) {
      return { ok: false, status: 503, async json() { return { error: { message: "The model is overloaded. Please try again later." } }; } };
    }
    retryBody = JSON.parse(options.body);
    return { ok: true, status: 200, async json() { return { candidates: [{ content: { parts: [{ text: " Recovered text. " }] } }] }; } };
  });

  const result = await client.generateStructured({
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    credential: "test-key-gemini",
    modelId: "test-model",
    systemPrompt: "",
    userPrompt: "perform this pass",
    schema: { type: "object", properties: { text: { type: "string" } } },
    retryDelayMs: 0
  });

  assert.equal(callCount, 2, "a 503 must trigger exactly one retry");
  assert.equal(result, "Recovered text.");
  assert.ok(retryBody.generationConfig.responseJsonSchema === undefined, "the 503 retry must drop the schema");
  assert.ok(retryBody.generationConfig.responseMimeType === undefined, "the 503 retry must drop the mime type");

  console.log("generateStructured LD-039 503 schema-free retry verified.");
}

{
  // LD-039: when the retry also fails, the error carries the status and the provider's own
  // reason, with the credential redacted, and no third request is made.
  let callCount = 0;
  const client = createClient(async () => {
    callCount += 1;
    return { ok: false, status: 503, async json() { return { error: { message: "Overloaded for key secret-key-9 right now." } }; } };
  });

  await assert.rejects(
    client.generateStructured({
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      credential: "secret-key-9",
      modelId: "test-model",
      systemPrompt: "",
      userPrompt: "perform this pass",
      schema: { type: "object", properties: { text: { type: "string" } } },
      retryDelayMs: 0
    }),
    (error) =>
      error.code === "provider_error" &&
      error.message.includes("status 503") &&
      error.message.includes("Overloaded") &&
      !error.message.includes("secret-key-9")
  );
  assert.equal(callCount, 2, "a failed retry is final");

  console.log("generateStructured LD-039 failed-retry detail and redaction verified.");
}

{
  // LD-039: a 429 is not retried, but it now explains itself.
  let callCount = 0;
  const client = createClient(async () => {
    callCount += 1;
    return { ok: false, status: 429, async json() { return { error: { message: "Resource has been exhausted (e.g. check quota)." } }; } };
  });

  await assert.rejects(
    client.generateStructured({
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      credential: "test-key-gemini",
      modelId: "test-model",
      systemPrompt: "",
      userPrompt: "perform this pass",
      schema: { type: "object", properties: { text: { type: "string" } } },
      retryDelayMs: 0
    }),
    (error) => error.code === "provider_error" && error.message.includes("status 429") && error.message.includes("quota")
  );
  assert.equal(callCount, 1, "a 429 must not be retried");

  console.log("generateStructured LD-039 429 detail (no retry) verified.");
}
