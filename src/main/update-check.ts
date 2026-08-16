// dsh-desktop — DSH core update check (Electron-free).
// Reads the installed @deepseek-ai/dsh version (the SAME install anchor boot.ts
// resolves) and the latest published version from the public npm registry. Also
// reads the deepseek-harness master branch's apps/cli version for display only
// (it can lag npm). This module imports no Electron API so it runs under plain
// Node 22+ and can be smoke-tested directly.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const DSH_PKG = "@deepseek-ai/dsh";
const REGISTRY = "https://registry.npmjs.org";
const MASTER_PKG_URL =
  "https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/apps/cli/package.json";
const FETCH_TIMEOUT_MS = 15_000;

export interface UpdateInfo {
  installed: string;
  latest: string;
  /** deepseek-harness master branch apps/cli version; display-only, may lag npm. */
  master: string | null;
  updatable: boolean;
  error: string | null;
}

/** Installed version of the dsh CLI package (the boot install anchor). */
export function installedDshVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve(`${DSH_PKG}/package.json`);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** Latest published version of the dsh package, straight from the registry dist-tags. */
export async function fetchLatestVersion(): Promise<string> {
  const url = `${REGISTRY}/-/package/${encodeURIComponent(DSH_PKG)}/dist-tags`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json", "user-agent": "dsh-desktop" },
  });
  if (!res.ok) throw new Error(`npm registry HTTP ${res.status}`);
  const data = (await res.json()) as { latest?: unknown };
  if (typeof data.latest !== "string" || data.latest.length === 0) {
    throw new Error("registry has no latest dist-tag");
  }
  return data.latest;
}

/** deepseek-harness master branch apps/cli version (display only). */
export async function fetchMasterBranchVersion(): Promise<string | null> {
  try {
    const res = await fetch(MASTER_PKG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const text = await res.text();
    const m = /"version"\s*:\s*"([^"]+)"/.exec(text);
    return m === null ? null : m[1];
  } catch {
    return null;
  }
}

/** Minimal semver compare: -1 / 0 / 1. Handles X.Y.Z and -rc.N / -beta.N prereleases. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1; // release > prerelease
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    const xNum = x !== "" && !Number.isNaN(nx);
    const yNum = y !== "" && !Number.isNaN(ny);
    if (xNum && yNum) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (xNum) {
      return -1; // numeric identifiers rank below alphanumeric
    } else if (yNum) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function parseVersion(version: string): { core: [number, number, number]; pre: string[] } {
  const clean = version.trim();
  const [corePart, ...rest] = clean.split("-");
  const nums = corePart.split(".").map((n) => {
    const v = parseInt(n, 10);
    return Number.isNaN(v) ? 0 : v;
  });
  while (nums.length < 3) nums.push(0);
  const pre = rest.length > 0 ? rest.join("-").split(".") : [];
  return { core: [nums[0], nums[1], nums[2]], pre };
}

/** Check installed vs latest. Never throws; failures land in .error. */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const installed = installedDshVersion();
  let latest = installed;
  let error: string | null = null;
  try {
    latest = await fetchLatestVersion();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const master = await fetchMasterBranchVersion();
  const updatable = error === null && installed !== "unknown" && compareVersions(installed, latest) < 0;
  return { installed, latest, master, updatable, error };
}
