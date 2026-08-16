// Pure-Node smoke for the in-process boot path (no Electron needed).
// Boots the exact web tree the desktop shell boots, then verifies the HTTP
// surface: index.html carries the injected __DSH_BOOT__ manifest, and the
// first client plugin bundle is served.
//
//   node scripts/smoke.mjs
//
// DSH_HOME defaults to <project>/.dsh-smoke-home (self-contained, repeatable).

import { bootWebTree } from "../dist/main/boot.js";
import { join } from "node:path";

process.env.DSH_HOME = process.env.DSH_SMOKE_HOME ?? join(process.cwd(), ".dsh-smoke-home");

const startedAt = Date.now();
const booted = await bootWebTree({ args: ["--port", "0"], cwd: process.cwd() });
try {
  const html = await (await fetch(booted.url + "/")).text();
  if (!html.includes("__DSH_BOOT__")) throw new Error("index.html has no __DSH_BOOT__");
  const match = /window\.__DSH_BOOT__\s*=\s*(\{.*?\})\s*<\/script>/s.exec(html);
  if (match === null) throw new Error("cannot extract boot manifest from index.html");
  const graph = JSON.parse(match[1].replaceAll("\\u003c", "<"));
  const rows = Array.isArray(graph) ? graph : (graph.entries ?? []);
  if (rows.length === 0) throw new Error("boot manifest graph is empty");
  const first = rows[0];
  if (typeof first.url !== "string") throw new Error("boot graph row has no url");
  const bundle = await (await fetch(booted.url + first.url)).text();
  if (bundle.length < 100) throw new Error("client bundle fetch returned too little data");
  const entries = [...booted.ctx.loader.entries()];
  console.log(JSON.stringify({
    ok: true,
    url: booted.url,
    port: booted.port,
    entryCount: entries.length,
    clientPluginCount: rows.length,
    bundleBytes: bundle.length,
    elapsedMs: Date.now() - startedAt,
  }));
} catch (error) {
  console.error("SMOKE FAIL:", error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
} finally {
  await booted.dispose();
  // fs watchers may keep the loop alive briefly; the smoke script always exits.
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}
