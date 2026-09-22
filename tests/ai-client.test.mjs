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
