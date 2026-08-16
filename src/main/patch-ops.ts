// dsh-desktop — user patch-file operations for the plugin rescue manager.
// Electron-free on purpose (unit-testable under plain Node).
//
// Writes are comment-preserving: disabling a plugin APPENDS a flow-style row
// (never rewrites the file), and enabling removes exactly that row. The
// original patch content the user wrote stays byte-identical.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as jsyaml from "js-yaml";

const DISABLE_COMMENT = "# disabled via dsh-desktop plugin manager";

// !!js expressions appear in some patch files; the manager never evaluates
// them — they surface as opaque placeholders (only id/name/disabled are read).
const JsExpr = new jsyaml.Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  resolve: () => false,
  construct: (data: string) => ({ $js: data }),
});
const SCHEMA = jsyaml.JSON_SCHEMA.extend(JsExpr);

export interface PatchPlugin {
  id: string;
  name: string | null;
  inserted: boolean;
  disabled: boolean;
  /** First source file that mentions the plugin (the insert row's file wins). */
  file: string;
  kind: "profile" | "home";
}

export interface PatchSource {
  kind: "profile" | "home";
  file: string;
  exists: boolean;
  error: string | null;
}

export function patchPaths(homeDir: string): { profile: string; home: string } {
  return {
    profile: join(homeDir, "profiles", "web", "cordis.patch.yml"),
    home: join(homeDir, "cordis.patch.yml"),
  };
}

interface RawRow {
  id?: unknown;
  name?: unknown;
  disabled?: unknown;
  insert?: unknown;
}

function collectRows(parsed: unknown): { id: string; name: string | null; disabled: boolean; inserted: boolean }[] {
  if (!Array.isArray(parsed)) return [];
  const out: { id: string; name: string | null; disabled: boolean; inserted: boolean }[] = [];
  for (const row of parsed) {
    if (row === null || typeof row !== "object") continue;
    const r = row as RawRow;
    if (typeof r.id === "string") {
      out.push({
        id: r.id,
        name: typeof r.name === "string" ? r.name : null,
        disabled: r.disabled === true,
        inserted: false,
      });
    }
    if (Array.isArray(r.insert)) {
      for (const item of r.insert) {
        if (item === null || typeof item !== "object") continue;
        const it = item as RawRow;
        if (typeof it.id === "string") {
          out.push({
            id: it.id,
            name: typeof it.name === "string" ? it.name : null,
            disabled: it.disabled === true,
            inserted: true,
          });
        }
      }
    }
  }
  return out;
}

export function readPatchSource(file: string, kind: "profile" | "home"): PatchSource & { plugins: PatchPlugin[] } {
  const base: PatchSource = { kind, file, exists: existsSync(file), error: null };
  if (!base.exists) return { ...base, plugins: [] };
  try {
    const parsed = jsyaml.load(readFileSync(file, "utf8"), { schema: SCHEMA });
    const plugins = collectRows(parsed).map((row) => ({ ...row, file, kind }));
    return { ...base, plugins };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error), plugins: [] };
  }
}

/** All plugins across both user patch layers, merged by id (first mention wins for name/file). */
export function listPlugins(homeDir: string): { sources: (PatchSource & { plugins: PatchPlugin[] })[]; plugins: PatchPlugin[] } {
  const paths = patchPaths(homeDir);
  const sources = [
    readPatchSource(paths.profile, "profile"),
    readPatchSource(paths.home, "home"),
  ];
  const merged = new Map<string, PatchPlugin>();
  for (const source of sources) {
    for (const p of source.plugins) {
      const existing = merged.get(p.id);
      if (existing === undefined) {
        merged.set(p.id, { ...p });
      } else {
        existing.inserted = existing.inserted || p.inserted;
        existing.disabled = existing.disabled || p.disabled;
        if (existing.name === null && p.name !== null) existing.name = p.name;
        if (!existing.inserted && p.inserted) {
          existing.file = p.file;
          existing.kind = p.kind;
        }
      }
    }
  }
  return { sources, plugins: [...merged.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

function assertValidId(id: string): void {
  if (!/^[A-Za-z0-9@._\/-]{1,200}$/.test(id)) throw new Error(`invalid plugin id: ${JSON.stringify(id)}`);
}

/** Append a flow-style disable row (idempotent; comments preserved). */
export function disablePlugin(file: string, id: string): void {
  assertValidId(id);
  if (existsSync(file)) {
    const source = readPatchSource(file, "profile");
    if (source.plugins.some((p) => p.id === id && p.disabled)) return; // already disabled
  } else {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  let text = existsSync(file) ? readFileSync(file, "utf8") : "# Your patch layer for this dsh profile.\n";
  if (!/\n$/.test(text)) text += "\n";
  const flow = `- { id: ${JSON.stringify(id)}, disabled: true }`;
  writeFileSync(file, `${text}\n${DISABLE_COMMENT}\n${flow}\n`, "utf8");
}

/** Remove every manager-appended (and any top-level block-style) disable row for id. */
export function enablePlugin(file: string, id: string): void {
  assertValidId(id);
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const drop = new Array<boolean>(lines.length).fill(false);
  const flow = `- { id: ${JSON.stringify(id)}, disabled: true }`;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === flow) {
      drop[i] = true;
      if (i > 0 && lines[i - 1].trim() === DISABLE_COMMENT) drop[i - 1] = true;
    }
  }
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^- id:\s*("([^"]+)"|'([^']+)'|([^\s#]+))/.exec(lines[i]);
    if (m === null) continue;
    const idText = m[2] ?? m[3] ?? m[4];
    if (idText !== id) continue;
    let j = i + 1;
    while (j < lines.length && /^\s+/.test(lines[j])) j += 1;
    const block = lines.slice(i, j).join("\n");
    if (!/disabled:\s*true\s*$/m.test(block)) continue;
    for (let k = i; k < j; k += 1) drop[k] = true;
    let c = i - 1;
    while (c >= 0 && /^\s*#/.test(lines[c])) {
      drop[c] = true;
      c -= 1;
    }
  }
  const kept = lines.filter((_, idx) => !drop[idx]);
  writeFileSync(file, kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n", "utf8");
}

const FAILED_ENTRY_RE = /failed to import loader entry\s+([A-Za-z0-9@._\/-]+)\s*\(([^)]*)\)/;

/** Pull the offending plugin out of a boot-failure message. */
export function extractFailedPlugin(message: string): { id: string; name: string } | null {
  const m = FAILED_ENTRY_RE.exec(message);
  if (m === null) return null;
  return { id: m[1], name: (m[2] ?? "").trim() || m[1] };
}
