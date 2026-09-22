import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(extensionRoot, "animations.js"), "utf8");

function classList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name)
  };
}

function instantAnimation() {
  return { finished: Promise.resolve(), cancel() {} };
}

const documentElement = { classList: classList(), animate: instantAnimation };
const sandbox = {
  console,
  document: { documentElement },
  matchMedia: () => ({ matches: false }),
  window: { setTimeout, clearTimeout },
  setTimeout,
  clearTimeout
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

const motion = sandbox.SaySlateAnimations;
assert.ok(motion, "Animation controller was not exposed.");

const panel = { hidden: true, dataset: {}, animate: instantAnimation };
await motion.showPanel(panel);
assert.equal(panel.hidden, false, "Panel did not open.");
await motion.hidePanel(panel);
assert.equal(panel.hidden, true, "Panel did not hide after its exit animation.");

const toast = { classList: classList(), animate: instantAnimation };
motion.showToast(toast, 1);
assert.equal(toast.classList.contains("visible"), true, "Toast did not enter.");
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(toast.classList.contains("visible"), false, "Toast did not leave.");

let themeApplied = false;
await motion.transitionTheme(() => { themeApplied = true; });
assert.equal(themeApplied, true, "Theme transition did not apply the requested theme.");

let reducedAnimationCalls = 0;
const reducedAnimation = () => {
  reducedAnimationCalls += 1;
  return instantAnimation();
};
const reducedSandbox = {
  console,
  document: { documentElement: { classList: classList(), animate: reducedAnimation } },
  matchMedia: () => ({ matches: true }),
  window: { setTimeout, clearTimeout },
  setTimeout,
  clearTimeout
};
vm.createContext(reducedSandbox);
vm.runInContext(source, reducedSandbox);
const reducedPanel = { hidden: true, dataset: {}, animate: reducedAnimation };
await reducedSandbox.SaySlateAnimations.showPanel(reducedPanel);
await reducedSandbox.SaySlateAnimations.hidePanel(reducedPanel);
const reducedToast = { classList: classList(), animate: reducedAnimation };
reducedSandbox.SaySlateAnimations.showToast(reducedToast, 1);
await new Promise((resolve) => setTimeout(resolve, 10));
await reducedSandbox.SaySlateAnimations.transitionTheme(() => {});
assert.ok(reducedAnimationCalls >= 5, "Reduced-motion mode suppressed all requested transition feedback.");

console.log("Panel, toast, and theme animation lifecycles verified.");
