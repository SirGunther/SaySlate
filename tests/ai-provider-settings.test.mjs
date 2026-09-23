import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(extensionRoot, "aiProviderSettings.js"), "utf8");

// A shared in-memory chrome.storage.local fake so multiple "module loads" (fresh vm
// contexts, matching a real page reload) observe the same persisted records - this is
// the realistic storage fake EV-031's harness pattern calls for.
function createStorage(initial = {}) {
  const backing = { ...initial };
  const setCalls = [];
  const api = {
    local: {
      get(key, callback) {
        callback({ [key]: backing[key] });
      },
      set(entries, callback) {
        setCalls.push(JSON.parse(JSON.stringify(entries)));
        Object.assign(backing, JSON.parse(JSON.stringify(entries)));
        callback();
      }
    }
  };
  return { backing, setCalls, chrome: { storage: api, runtime: {} } };
}

function createModule(chrome) {
  const context = { chrome, crypto: { randomUUID } };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.SaySlateAIProviderSettings;
}

// ---- Scenario 1: independent multi-profile persistence across switching and reload ----

{
  const storage = createStorage();
  const moduleA = createModule(storage.chrome);
  await moduleA.load();

  const geminiProfile = await moduleA.upsertProfile({
    name: "Personal Gemini",
    providerKind: "gemini",
    endpoint: "",
    modelId: "gemini-3.1-flash-lite",
    credential: "test-key-gemini",
    credentialAction: "replace"
  });
  const openAiProfile = await moduleA.upsertProfile({
    name: "Work OpenAI",
    providerKind: "openai",
    endpoint: "https://api.openai.com/v1",
    modelId: "gpt-test",
    credential: "test-key-openai",
    credentialAction: "replace"
  });

  await moduleA.activateProfile(geminiProfile.id);
  await moduleA.activateProfile(openAiProfile.id);
  await moduleA.activateProfile(geminiProfile.id);

  const snapshotBefore = JSON.parse(JSON.stringify(storage.backing["sayslate-ai-provider-profiles"]));
  const openAiBefore = snapshotBefore.profiles.find((profile) => profile.id === openAiProfile.id);
  assert.deepEqual(openAiBefore, {
    id: openAiProfile.id,
    name: "Work OpenAI",
    providerKind: "openai",
    endpoint: "https://api.openai.com/v1",
    modelId: "gpt-test",
    credential: "test-key-openai"
  });

  // Replacing the Gemini profile's credential must not touch the OpenAI profile.
  await moduleA.upsertProfile({
    id: geminiProfile.id,
    credential: "test-key-gemini-rotated",
    credentialAction: "replace"
  });

  const openAiAfterReplace = storage.backing["sayslate-ai-provider-profiles"].profiles.find(
    (profile) => profile.id === openAiProfile.id
  );
  assert.deepEqual(openAiAfterReplace, openAiBefore, "replacing one profile's credential mutated another profile");

  // Clearing the OpenAI credential must not touch the Gemini profile's endpoint/model/key.
  await moduleA.clearCredential(openAiProfile.id);
  const geminiAfterClear = storage.backing["sayslate-ai-provider-profiles"].profiles.find(
    (profile) => profile.id === geminiProfile.id
  );
  assert.equal(geminiAfterClear.credential, "test-key-gemini-rotated");
  assert.equal(geminiAfterClear.modelId, "gemini-3.1-flash-lite");

  const clearedOpenAi = storage.backing["sayslate-ai-provider-profiles"].profiles.find(
    (profile) => profile.id === openAiProfile.id
  );
  assert.equal(clearedOpenAi.credential, "", "Clear Credential did not blank the credential");
  assert.equal(clearedOpenAi.endpoint, "https://api.openai.com/v1", "Clear Credential disturbed the endpoint");

  // Reloading the module from storage (a fresh vm context, like a fresh page load) must
  // restore every profile and the active-profile ID.
  const moduleB = createModule(storage.chrome);
  const reloaded = await moduleB.load();
  assert.equal(reloaded.profiles.length, 2);
  assert.equal(reloaded.activeProfileId, geminiProfile.id);
  const reloadedGemini = reloaded.profiles.find((profile) => profile.id === geminiProfile.id);
  const reloadedOpenAi = reloaded.profiles.find((profile) => profile.id === openAiProfile.id);
  assert.equal(reloadedGemini.credential, "test-key-gemini-rotated");
  assert.equal(reloadedOpenAi.credential, "");
  assert.equal(reloadedOpenAi.endpoint, "https://api.openai.com/v1");

  // Deleting the active profile must leave no active profile, and must not touch the
  // untouched profile's fields.
  await moduleB.deleteProfile(geminiProfile.id);
  const afterDelete = storage.backing["sayslate-ai-provider-profiles"];
  assert.equal(afterDelete.activeProfileId, null);
  assert.equal(afterDelete.profiles.length, 1);
  assert.equal(afterDelete.profiles[0].id, openAiProfile.id);
  assert.equal(afterDelete.profiles[0].endpoint, "https://api.openai.com/v1");

  console.log("Independent multi-profile persistence, switching, and reload verified.");
}

// ---- Scenario 2: retain-credential-action leaves an unrelated field edit untouched ----

{
  const storage = createStorage();
  const module1 = createModule(storage.chrome);
  await module1.load();
  const profile = await module1.upsertProfile({
    name: "Custom",
    providerKind: "custom",
    endpoint: "https://tailnet.example/v1",
    modelId: "model-a",
    credential: "test-key-custom",
    credentialAction: "replace"
  });

  await module1.upsertProfile({
    id: profile.id,
    endpoint: "https://tailnet.example/v2",
    credentialAction: "retain"
  });

  const stored = storage.backing["sayslate-ai-provider-profiles"].profiles[0];
  assert.equal(stored.credential, "test-key-custom", "retain must not blank a saved credential on a blank edit");
  assert.equal(stored.endpoint, "https://tailnet.example/v2");

  console.log("Retain credential action verified.");
}

// ---- Scenario 3: malformed/unsupported stored version fails without overwriting storage ----

{
  const malformedRecord = { version: 2, activeProfileId: null, profiles: [] };
  const storage = createStorage({ "sayslate-ai-provider-profiles": malformedRecord });
  const module1 = createModule(storage.chrome);

  await assert.rejects(module1.load());
  assert.deepEqual(
    storage.backing["sayslate-ai-provider-profiles"],
    malformedRecord,
    "a malformed stored version must not be overwritten"
  );
  assert.equal(storage.setCalls.length, 0, "load() must not call chrome.storage.local.set on a malformed record");

  console.log("Malformed stored version rejection verified.");
}

// ---- Scenario 4: legacy Gemini migration, idempotency, and LD-030 move semantics ----

{
  const legacyConfig = {
    apiKey: "test-key-legacy-gemini",
    model: "gemini-3.1-flash-lite",
    firstPassPrompt: "Correct grammar only.",
    secondPassPrompt: "Improve clarity.",
    secondPassEnabled: true,
    promptSchemaVersion: 3
  };
  const storage = createStorage({ "sayslate-grammar-config": legacyConfig });
  const module1 = createModule(storage.chrome);
  await module1.load();

  const firstMigration = await module1.migrateLegacyConfig();
  assert.ok(firstMigration, "migration should create a profile the first time");
  assert.equal(firstMigration.providerKind, "gemini");
  assert.equal(firstMigration.modelId, "gemini-3.1-flash-lite");
  assert.equal(firstMigration.credential, "test-key-legacy-gemini");

  const stateAfterFirst = storage.backing["sayslate-ai-provider-profiles"];
  assert.equal(stateAfterFirst.profiles.length, 1);

  const legacyAfterFirst = storage.backing["sayslate-grammar-config"];
  assert.equal(legacyAfterFirst.apiKey, undefined, "migration must move, not copy, the legacy key");
  assert.equal(legacyAfterFirst.model, undefined, "migration must move, not copy, the legacy model");
  assert.equal(legacyAfterFirst.firstPassPrompt, "Correct grammar only.", "prompts must survive migration unchanged");
  assert.equal(legacyAfterFirst.secondPassPrompt, "Improve clarity.", "prompts must survive migration unchanged");
  assert.equal(legacyAfterFirst.secondPassEnabled, true);

  // Running migration again against the now-stripped legacy record must not recreate a profile.
  const secondMigration = await module1.migrateLegacyConfig();
  assert.equal(secondMigration, null, "migration must be a no-op once the legacy key/model are gone");
  assert.equal(storage.backing["sayslate-ai-provider-profiles"].profiles.length, 1);

  // LD-030: deleting the migrated profile, then migrating again, must not recreate it -
  // the legacy record already lost its key/model in the same write as the original migration.
  await module1.deleteProfile(firstMigration.id);
  assert.equal(storage.backing["sayslate-ai-provider-profiles"].profiles.length, 0);
  const migrationAfterDelete = await module1.migrateLegacyConfig();
  assert.equal(migrationAfterDelete, null, "a deleted migrated profile must never be recreated");
  assert.equal(storage.backing["sayslate-ai-provider-profiles"].profiles.length, 0);

  console.log("Legacy Gemini migration, idempotency, and post-delete non-recreation verified.");
}

// ---- Scenario 5: clearing the migrated profile's credential, then migrating again, recreates nothing ----

{
  const legacyConfig = {
    apiKey: "test-key-legacy-gemini-2",
    model: "gemini-3.1-flash-lite",
    firstPassPrompt: "Correct grammar only.",
    secondPassPrompt: "Improve clarity.",
    secondPassEnabled: true,
    promptSchemaVersion: 3
  };
  const storage = createStorage({ "sayslate-grammar-config": legacyConfig });
  const module1 = createModule(storage.chrome);
  await module1.load();

  const migrated = await module1.migrateLegacyConfig();
  await module1.clearCredential(migrated.id);

  const clearedProfile = storage.backing["sayslate-ai-provider-profiles"].profiles.find(
    (profile) => profile.id === migrated.id
  );
  assert.equal(clearedProfile.credential, "");

  const migrationAfterClear = await module1.migrateLegacyConfig();
  assert.equal(migrationAfterClear, null, "clearing the migrated profile's credential must not resurrect a legacy copy");
  assert.equal(storage.backing["sayslate-ai-provider-profiles"].profiles.length, 1);
  assert.equal(storage.backing["sayslate-grammar-config"].apiKey, undefined);

  console.log("Post-clear-credential migration non-recreation verified.");
}

console.log("AI provider profile storage and migration boundary verified.");
