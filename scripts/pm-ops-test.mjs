// patch-ops unit test (plain Node, no Electron).
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disablePlugin, enablePlugin, extractFailedPlugin, listPlugins, patchPaths } from "../dist/main/patch-ops.js";

const home = mkdtempSync(join(tmpdir(), "pm-ops-"));
const { profile, home: homePatch } = patchPaths(home);
mkdirSync(join(home, "profiles", "web"), { recursive: true });

const ORIGINAL = [
  "# Your patch layer for this dsh profile, applied after every bundle layer:",
  "- insert:",
  "    # Desktop polish theme layer: alias-token overrides + font/CSS refinement.",
  "    - id: dsh-desktop-polish",
  "      name: dsh-desktop-polish",
  "",
].join("\n");
writeFileSync(profile, ORIGINAL);

function assert(cond, label) {
  if (!cond) throw new Error("ASSERT FAIL: " + label);
  console.log("ok - " + label);
}

// 1. list
let snap = listPlugins(home);
assert(snap.plugins.length === 1 && snap.plugins[0].id === "dsh-desktop-polish" && snap.plugins[0].inserted && !snap.plugins[0].disabled, "list sees inserted polish plugin");

// 2. disable (append, comment-preserving, idempotent)
disablePlugin(profile, "dsh-desktop-polish");
const afterDisableText = readFileSync(profile, "utf8");
assert(afterDisableText.includes("dsh-desktop-polish") && afterDisableText.includes("disabled: true"), "disable row appended");
assert(afterDisableText.includes("Desktop polish theme layer"), "original comment preserved");
const flowCount = afterDisableText.split("disabled: true").length - 1;
disablePlugin(profile, "dsh-desktop-polish");
assert(readFileSync(profile, "utf8").split("disabled: true").length - 1 === flowCount, "disable is idempotent");
snap = listPlugins(home);
assert(snap.plugins[0].disabled === true, "effective disabled after disable");

// 3. enable (removes appended row + its comment only)
enablePlugin(profile, "dsh-desktop-polish");
const afterEnableText = readFileSync(profile, "utf8");
assert(!afterEnableText.includes("disabled: true"), "disable row removed");
assert(afterEnableText.includes("Desktop polish theme layer"), "comments intact after enable");
snap = listPlugins(home);
assert(snap.plugins[0].disabled === false, "effective enabled after enable");

// 4. disable on a missing patch file creates a minimal valid file
disablePlugin(homePatch, "some-plugin");
assert(existsSync(homePatch) && readFileSync(homePatch, "utf8").includes("disabled: true"), "missing file created with disable row");
enablePlugin(homePatch, "some-plugin");
assert(!readFileSync(homePatch, "utf8").includes("disabled: true"), "enable cleans the created file");

// 5. failed-plugin extraction
const fakeError =
  "dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry definitely-broken-plugin (definitely-broken-missing-package): Cannot find package";
const extracted = extractFailedPlugin(fakeError);
assert(extracted && extracted.id === "definitely-broken-plugin" && extracted.name === "definitely-broken-missing-package", "failed plugin extracted from boot error");
assert(extractFailedPlugin("nothing here") === null, "no false positive");

rmSync(home, { recursive: true, force: true });
console.log("PM-OPS-TEST OK");
