// dsh-desktop — in-process web profile boot.
// A faithful port of the CLI's runProfile (apps/cli/src/profile-boot.ts in the
// deepseek-harness repository; shipped as @deepseek-ai/dsh/lib/profile-boot-*.js),
// built ONLY from published package APIs, so the desktop shell composes the exact
// same tree that `dsh --profile web` boots: same bundles, same patch layers
// (profile + home), same --patch overlays, same shipped agent-preset root, same
// telemetry switch, same user patch-layer watching.
//
// Electron-free on purpose: this module also runs under plain Node 22+ for the
// smoke test (scripts/smoke.mjs). The Electron shell (main.ts) only consumes
// BootResult.

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PROFILE_PATCH_FILENAME,
  boot,
  composeEntries,
  healProfilesModuleFallback,
  installFailLoud,
  loadLayeredEnv,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  watchUserPatches,
} from "@deepseek-ai/dsh-app-boot";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { DSH_LAUNCH_ENVIRONMENT_KEY } from "@deepseek-ai/dsh-launch-environment";

const require = createRequire(import.meta.url);
const NAME = "dsh";
const PROFILE_ROOT_FILENAME = "cordis.yml";
const TELEMETRY_ROW_ID = "session-telemetry-otel";

/** Absolute path of the dsh CLI package.json — the SAME installation anchor the CLI boots from,
 *  so healProfilesModuleFallback materializes the same flat module fallback closure. */
const INSTALL_ANCHOR = require.resolve("@deepseek-ai/dsh/package.json");
/** Shipped agent-preset root beside the dsh package's own config (an assembly fact the CLI patches in). */
const SHIPPED_PRESET_ROOT = join(dirname(INSTALL_ANCHOR), "config/agent-presets");

/** The empty root entry list every profile tree patches over (byte-identical to the CLI's). */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;

export interface BootOptions {
  /** Profile name to boot. Default "web". */
  profile?: string;
  /** Arguments handed to the booted tree — the web app's own flag family (--host/--port/--trusted-host). */
  args?: string[];
  /** Extra --patch overlay files, in application order. */
  patchFiles?: string[];
  /** DSH_HOME override, materialized on process.env before anything resolves it. */
  home?: string;
  /** Working directory before boot (the tree's process.cwd(); default: caller's cwd). */
  cwd?: string;
  /** Sink for tree stderr (fail-loud diagnostics, loader warnings). Default process.stderr. */
  stderr?: (line: string) => void;
  /** Installed-host base directory URL for bare package names (the app's own
   *  node_modules). When set, host-side bare imports resolve from the host
   *  instead of the profile dir, and the junction heal degrades to best-effort —
   *  the upstream "closed packaged runtime" pattern. Default: undefined (CLI parity). */
  bareModuleBaseUrl?: string;
  /** Exit request handed to the tree (cmdline help/errors, fail-loud). Default process.exit. */
  exit?: (code: number) => void;
  /** Skip the user patch layers (profile + home) — recovery "safe mode" for broken plugins. */
  safe?: boolean;
}

export interface BootResult {
  /** The settled root context; the whole tree lives until dispose(). */
  ctx: any;
  /** The webserver's bound port (OS-assigned when args include --port 0). */
  port: number;
  /** Canonical local URL the renderer loads. */
  url: string;
  /** Whole-tree teardown, resolving at quiescence. */
  dispose: () => Promise<void>;
}

/** Home-level user patch layer ($DSH_HOME/cordis.patch.yml), resolved per call. */
function homePatchPath(): string {
  return join(resolveDshHome(), PROFILE_PATCH_FILENAME);
}

/** Telemetry opt-out switch: ANY non-empty value disables (mirror of the CLI's resolveTelemetryPatch). */
function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean) {
  if ((disabledEnv ?? "") === "" || !hasRow) return undefined;
  return { id: TELEMETRY_ROW_ID, disabled: true };
}

/** Load a resolved profile and (re)write the empty root config, mirroring prepareProfile. */
function prepareProfile(name: string, healBestEffort: boolean, stderr: (line: string) => void, safe: boolean): { profile: any; healFailed: boolean } {
  let healFailed = false;
  try {
    healProfilesModuleFallback(INSTALL_ANCHOR);
  } catch (error) {
    if (!healBestEffort) throw error;
    // Junction heal failed (restricted environment / antivirus): the tree can
    // still resolve in-box packages through bareModuleBaseUrl; out-of-tree
    // profile packages resolve from the profile's own node_modules. Non-fatal.
    healFailed = true;
    stderr(`dsh-desktop: warning: module-fallback junction heal failed (${error instanceof Error ? error.message : String(error)}); in-box packages resolve through the installed-host base instead\n`);
  }
  // userLayer:false skips $DSH_HOME/profiles/<name>/cordis.patch.yml — the safe-mode switch.
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, { userLayer: !safe });
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG);
  return { profile, healFailed };
}

/** The full patch stack of one composed profile, in application order. */
function allPatches(composed: any): any[] {
  return [
    ...composed.bundlePatches,
    ...composed.profile.patches,
    ...composed.homePatches,
    ...composed.overlays,
  ];
}

/** Load the profile and compose its effective patch stack (mirror of the CLI's composeProfile). */
function composeProfile(name: string, patchFiles: string[], healBestEffort: boolean, stderr: (line: string) => void, safe: boolean) {
  const { profile, healFailed } = prepareProfile(name, healBestEffort, stderr, safe);
  const homePatches = safe ? [] : (loadOptionalPatches(NAME, homePatchPath()) ?? []);
  const overlays = patchFiles.flatMap((file) => loadOverlayPatches(NAME, resolve(file)));
  const bundlePatches = profile.layers.flatMap((layer: any) => layer.patches);
  const rows = new Map<string, any>();
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlays])) {
    if (typeof row.id === "string") rows.set(row.id, row);
  }
  const composedOverlays = [...overlays];
  if (healFailed) {
    // Degraded mode (no junction fallback): pin the directory-picker interaction
    // to the native backend. The auto chooser creates its backend entry
    // dynamically, which resolves from the profile dir and needs the junction
    // fallback; a static row imports through the installed-host base instead.
    // (Patch semantics: `name` is a guard, not an override — swap = disable + insert.)
    composedOverlays.push({ id: "directory-picker", disabled: true });
    composedOverlays.push({
      insert: [{ id: "directory-picker-native", name: "@deepseek-ai/dsh-host-directory-picker-native" }],
    });
  }
  if (rows.has("agent-presets")) {
    composedOverlays.push({
      id: "agent-presets",
      config: {
        ...(rows.get("agent-presets")?.config ?? {}),
        roots: [{ path: SHIPPED_PRESET_ROOT, trust: "system" }],
      },
    });
  }
  const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID));
  if (telemetryPatch !== undefined) composedOverlays.push(telemetryPatch);
  return { profile, bundlePatches, homePatches, overlays: composedOverlays, rows, healFailed };
}

/**
 * Boot one web-profile invocation end to end and return the settled tree.
 * Process lifetime belongs to the caller (the Electron app or the smoke script);
 * dispose() tears the whole tree down.
 */
export async function bootWebTree(options: BootOptions = {}): Promise<BootResult> {
  const {
    profile: profileName = "web",
    args = ["--port", "0"],
    patchFiles = [],
    stderr = (line: string) => process.stderr.write(line),
    exit = (code: number) => process.exit(code),
    safe = false,
  } = options;

  if (options.home !== undefined) process.env.DSH_HOME = options.home;
  if (options.cwd !== undefined) process.chdir(options.cwd);

  // Environment snapshot FIRST (reads cwd/home .env and materializes accepted values),
  // exactly as the CLI computes it before booting.
  const environment = loadLayeredEnv(NAME);

  const composed = composeProfile(profileName, patchFiles, options.bareModuleBaseUrl !== undefined, stderr, safe);
  const app: { current?: any } = {};

  // Degraded mode only: when the junction heal failed, the installed host owns
  // bare-name resolution (bareModuleBaseUrl) and the client roster scan rides
  // NODE_PATH. On the normal path (heal succeeded) we stay CLI-identical so
  // out-of-tree profile plugins resolve exactly as the CLI resolves them.
  const effectiveBase = composed.healFailed && options.bareModuleBaseUrl !== undefined
    ? options.bareModuleBaseUrl
    : undefined;
  if (effectiveBase !== undefined) {
    const base = fileURLToPath(effectiveBase.replace(/\/+$/, ""));
    process.env.NODE_PATH = base + (process.env.NODE_PATH ? ";" + process.env.NODE_PATH : "");
    // Recompute the CJS global-module paths: Node caches them on first require,
    // and the packaged runtime has already required modules by the time the
    // desktop shell boots. Without this, NODE_PATH changes are ignored.
    const Module = require("node:module") as { _initPaths?: () => void };
    Module._initPaths?.();
  }

  // Fail-loud guard with the shell's own stderr sink and exit path; release disposes the tree first.
  installFailLoud(
    NAME,
    {
      on: process.on.bind(process),
      off: process.off.bind(process),
      stderr: { write: (line: string) => stderr(line) },
      exit,
    },
    async () => {
      await app.current?.fiber.dispose();
    },
  );

  const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME);
  const composeLive = () => structuredClone([
    ...composed.bundlePatches,
    ...(safe ? [] : (loadOptionalPatches(NAME, composed.profile.patchPath) ?? [])),
    ...(safe ? [] : (loadOptionalPatches(NAME, homePatchPath()) ?? [])),
    ...composed.overlays,
  ]);

  const ctx = await boot(NAME, rootConfig, structuredClone(allPatches(composed)), (hostCtx: any) => {
    app.current = hostCtx;
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
    provideCmdline(hostCtx, { args, exit });
  }, effectiveBase);
  app.current = ctx;

  // User patch-layer hot reload. The web bundle disables the shared hmr row, so —
  // like the CLI — ensure timer+hmr exist, then watch both patch layers.
  if (!safe && ctx.fiber.state === 2 && ctx.get("loader") !== undefined) {
    try {
      if (ctx.get("hmr") === undefined) {
        if (ctx.get("timer") === undefined) await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-timer" });
        await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-hmr", config: { root: [] } });
      }
      await watchUserPatches(ctx, { binName: NAME, filename: composed.profile.patchPath, compose: composeLive });
      await watchUserPatches(ctx, { binName: NAME, filename: homePatchPath(), compose: composeLive });
    } catch (error) {
      // Exiting as asked, or the tree disposed mid-setup: suppress. Otherwise the watch failure is real.
      if (ctx.fiber.state !== 2 || ctx.get("loader") === undefined) { /* shutting down */ }
      else if (effectiveBase !== undefined) {
        // Degraded mode: patch hot-reload is unavailable, but the tree is usable.
        stderr(`dsh-desktop: warning: user patch-layer hot-reload unavailable (${error instanceof Error ? error.message : String(error)})\n`);
      } else throw error;
    }
  }

  const webServer = ctx.get("webServer");
  if (webServer === undefined) {
    throw new Error("dsh-desktop: webServer service missing after boot — the profile did not mount a webserver");
  }
  const port: number = webServer.port;
  const url = `http://127.0.0.1:${String(port)}`;
  return {
    ctx,
    port,
    url,
    dispose: async () => {
      await ctx.fiber.dispose();
    },
  };
}
