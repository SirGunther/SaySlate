# SaySlate Prompt Recovery - 2026-08-20

This file preserves prompt text recovered from retained SaySlate development records after Edge recreated the extension's local-storage database. It does not contain the Google API key.

## Recovery Status

- Edge's human-readable **PDProjects** profile maps internally to `Profile 1` and the account `PDProjects@planetdepos.com`; this is the profile examined for recovery. The personal `Default` profile was not used for the storage conclusion.
- The current Edge `sayslate-grammar-config` record is present but contains an empty API key, empty first-pass prompt, and empty second-pass prompt.
- The PDProjects profile's OtterCopy storage still contains one 39-character Google API-key candidate, verified only in masked form as `AIza...ACyI`; the secret is not copied into this document.
- The original SaySlate extension ID and path are still identifiable, but the previous non-empty LevelDB record is no longer present.
- Both prompts below were recovered verbatim from Blink's serialized SaySlate form state in the PDProjects Edge session file `Tabs_13431485384996068`, last written August 17, 2026.
- The user explicitly rejected the earlier Codex-derived second-pass candidate as not matching the saved instructions. It has been removed from this recovery record.

## Verified First-Pass Prompt

```text
Your role is to adopt the voice of the user and correct any grammatical errors in their text. It should focus on maintaining the natural tone and style of the user's speech while ensuring proper punctuation, structure, and grammar. Prioritize preserving the user's original message and intent. Remove incoherent and filler such as 'Um'. NEVER use EM Dashes.
```

Provenance: verbatim serialized first prompt from the PDProjects Edge SaySlate tab. It also matches the retained user-provided reference.

## Verified Second-Pass Prompt

```text
Your role is to adopt the voice of the user and make the content more coherent. It should focus on maintaining the natural tone and style of the user's speech while ensuring proper punctuation, structure, and grammar. Prioritize preserving the user's original message and intent.

Improve the paragraph structure for readability. Keep closely related thoughts together.

Do not editorialize the content. Only present the edited version.

NEVER use EM Dashes.
```

Provenance: verbatim serialized second prompt from the PDProjects Edge SaySlate tab. This is not reconstructed from generated output or an assistant recommendation.

## Manual Restoration Checklist

- [ ] Re-enter the Google API key from the separate trusted source or OtterCopy configuration.
- [ ] Restore the verified first-pass prompt.
- [ ] Restore the verified second-pass prompt.
- [ ] Save both prompt fields in SaySlate.
- [ ] Run a short known transcript through both passes and compare the result with prior behavior.
