import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registrySource = fs.readFileSync(path.join(extensionRoot, "aiProviderRegistry.js"), "utf8");
const permissionsSource = fs.readFileSync(path.join(extensionRoot, "aiProviderPermissions.js"), "utf8");

const TEST_ENDPOINT = "https://lmstudio.example-tailnet.ts.net/v1";
const TEST_ORIGIN_PATTERN = "https://lmstudio.example-tailnet.ts.net/*";

// Values returned from inside the vm context carry that sandbox's own Object/Array
// prototypes, which fails node:assert/strict's prototype-sensitive deepEqual against a
// plain literal from this module's realm. A JSON round-trip normalizes to plain data
// before comparison; every field here is JSON-safe (strings, booleans, null).
const plain = (value) => JSON.parse(JSON.stringify(value));

// A realistic MV3 chrome.permissions fake: contains/request are callback-style (matching
// the extension's real chrome.permissions surface), request may resolve false (user
// declined) or reject (e.g. not called from a user gesture), and every call is recorded
// so tests can assert exactly which origins were requested, and how many times.
function createPermissionsFake({ granted = [], requestResult = "grant", requestError = null } = {}) {
  const grantedOrigins = new Set(granted);
  const containsCalls = [];
  const requestCalls = [];

  const permissions = {
    contains(descriptor, callback) {
      containsCalls.push(descriptor.origins);
      const isGranted = descriptor.origins.every((origin) => grantedOrigins.has(origin));
      callback(isGranted);
    },
    request(descriptor, callback) {
      requestCalls.push(descriptor.origins);
      if (requestError) {
        chrome.runtime.lastError = { message: requestError };
        callback(undefined);
        chrome.runtime.lastError = undefined;
        return;
      }
      if (requestResult === "grant") {
        for (const origin of descriptor.origins) grantedOrigins.add(origin);
        callback(true);
      } else {
        callback(false);
      }
    }
  };

  const chrome = { permissions, runtime: {} };
  return { chrome, containsCalls, requestCalls };
}

function createModule(chrome) {
  const context = { chrome, URL };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(registrySource, context);
  vm.runInContext(permissionsSource, context);
  return context.SaySlateAIProviderPermissions;
}

// ---- Scenario 1: already granted - ensureForEndpoint never calls request ----

{
  const { chrome, containsCalls, requestCalls } = createPermissionsFake({ granted: [TEST_ORIGIN_PATTERN] });
  const permissionsModule = createModule(chrome);

  const result = await permissionsModule.ensureForEndpoint(TEST_ENDPOINT);

  assert.deepEqual(plain(result), { ok: true, code: "already_granted", originPattern: TEST_ORIGIN_PATTERN });
  assert.equal(containsCalls.length, 1);
  assert.deepEqual(plain(containsCalls[0]), [TEST_ORIGIN_PATTERN]);
  assert.equal(requestCalls.length, 0, "an already-granted origin must never be re-requested");

  console.log("Already-granted ensureForEndpoint verified.");
}

// ---- Scenario 2: not yet granted, user grants - ensureForEndpoint requests the exact origin only ----

{
  const { chrome, requestCalls } = createPermissionsFake({ granted: [], requestResult: "grant" });
  const permissionsModule = createModule(chrome);

  const result = await permissionsModule.ensureForEndpoint(TEST_ENDPOINT);

  assert.deepEqual(plain(result), { ok: true, code: "granted", originPattern: TEST_ORIGIN_PATTERN });
  assert.equal(requestCalls.length, 1);
  assert.deepEqual(plain(requestCalls[0]), [TEST_ORIGIN_PATTERN], "must request only the exact configured origin");

  console.log("User-granted ensureForEndpoint verified.");
}

// ---- Scenario 3: user declines the permission prompt - denied, no broader origin retried ----

{
  const { chrome, requestCalls } = createPermissionsFake({ granted: [], requestResult: "decline" });
  const permissionsModule = createModule(chrome);

  const result = await permissionsModule.ensureForEndpoint(TEST_ENDPOINT);

  assert.deepEqual(plain(result), { ok: false, code: "permission_denied", originPattern: TEST_ORIGIN_PATTERN });
  assert.equal(requestCalls.length, 1);
  assert.deepEqual(plain(requestCalls[0]), [TEST_ORIGIN_PATTERN], "a decline must never trigger a broader retry");

  console.log("User-declined ensureForEndpoint verified.");
}

// ---- Scenario 4: chrome.permissions.request rejects (e.g. no user gesture) - denied, never throws ----

{
  const { chrome } = createPermissionsFake({ granted: [], requestError: "This function must be called during a user gesture" });
  const permissionsModule = createModule(chrome);

  const result = await permissionsModule.ensureForEndpoint(TEST_ENDPOINT);

  assert.deepEqual(plain(result), { ok: false, code: "permission_denied", originPattern: TEST_ORIGIN_PATTERN });

  console.log("Rejected chrome.permissions.request call verified as a denial, not a thrown error.");
}

// ---- Scenario 5: invalid endpoint - invalid_configuration, no chrome.permissions call at all ----

{
  const { chrome, containsCalls, requestCalls } = createPermissionsFake();
  const permissionsModule = createModule(chrome);

  const result = await permissionsModule.ensureForEndpoint("http://lmstudio.example-tailnet.ts.net/v1");

  assert.deepEqual(plain(result), { ok: false, code: "invalid_configuration", originPattern: null });
  assert.equal(containsCalls.length, 0, "an invalid endpoint must never reach chrome.permissions.contains");
  assert.equal(requestCalls.length, 0, "an invalid endpoint must never reach chrome.permissions.request");

  console.log("Invalid-endpoint ensureForEndpoint verified.");
}

// ---- Scenario 6: hasForEndpoint never requests - load/display/migration-safe read ----

{
  const notGranted = createPermissionsFake({ granted: [] });
  const notGrantedModule = createModule(notGranted.chrome);
  const notGrantedResult = await notGrantedModule.hasForEndpoint(TEST_ENDPOINT);
  assert.deepEqual(plain(notGrantedResult), { ok: false, code: "permission_denied", originPattern: TEST_ORIGIN_PATTERN });
  assert.equal(notGranted.requestCalls.length, 0, "hasForEndpoint must never call chrome.permissions.request");

  const granted = createPermissionsFake({ granted: [TEST_ORIGIN_PATTERN] });
  const grantedModule = createModule(granted.chrome);
  const grantedResult = await grantedModule.hasForEndpoint(TEST_ENDPOINT);
  assert.deepEqual(plain(grantedResult), { ok: true, code: "already_granted", originPattern: TEST_ORIGIN_PATTERN });
  assert.equal(granted.requestCalls.length, 0, "hasForEndpoint must never call chrome.permissions.request");

  const invalid = createPermissionsFake();
  const invalidModule = createModule(invalid.chrome);
  const invalidResult = await invalidModule.hasForEndpoint("not a url");
  assert.deepEqual(plain(invalidResult), { ok: false, code: "invalid_configuration", originPattern: null });
  assert.equal(invalid.containsCalls.length, 0);
  assert.equal(invalid.requestCalls.length, 0);

  // Simulate repeatedly displaying/loading/switching/migrating a saved profile: calling
  // the read-only check many times in a row must still never prompt the user once.
  for (let i = 0; i < 5; i += 1) {
    await notGrantedModule.hasForEndpoint(TEST_ENDPOINT);
  }
  assert.equal(notGranted.requestCalls.length, 0, "no repeated load/display path may ever request permission");

  console.log("No-request-on-load (hasForEndpoint) verified across granted, denied, and invalid endpoints.");
}

console.log("AI provider permission boundary (grant, denial, already-granted, invalid, no-request-on-load) verified.");
