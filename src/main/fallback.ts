// dsh-desktop — child-process fallback backend.
// Runs the dsh CLI (from our own node_modules) under a plain Node on PATH and
// parses the "dsh web: http://..." URL line. Used when the in-process tree
// cannot boot (e.g. a non-N-API native addon installed into the profile that
// was built for the Node ABI, not Electron's).

import { createRequire } from "node:module";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

const require = createRequire(import.meta.url);

export interface ChildFallbackOptions {
  /** web app args (the tree's own flags), e.g. ["--port", "0"]. */
  args?: string[];
  /** DSH_HOME override. */
  home?: string;
  /** working directory for the child. */
  cwd?: string;
  /** Node binary; defaults to DSH_DESKTOP_NODE env, then "node" on PATH. */
  nodeBin?: string;
  /** per-line stdout sink. */
  onLine?: (line: string) => void;
}

export interface ChildFallbackResult {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

/** Resolve the dsh CLI entry shipped inside our own node_modules. */
function dshBinPath(): string {
  return require.resolve("@deepseek-ai/dsh/lib/bin.js");
}

export function runChildFallback(options: ChildFallbackOptions = {}): Promise<ChildFallbackResult> {
  const binPath = dshBinPath();
  const nodeBin = options.nodeBin ?? process.env.DSH_DESKTOP_NODE ?? "node";
  const args = options.args ?? ["--port", "0"];
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(nodeBin, [binPath, "web", ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...(options.home !== undefined ? { DSH_HOME: options.home } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  return new Promise((resolveIt, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const stop = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((done) => child.once("exit", () => done())),
          new Promise<void>((done) => setTimeout(done, 3000)),
        ]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      for (const line of lines.slice(0, -1)) options.onLine?.(line);
      const match = /dsh web: (https?:\/\/[^\s]+)/.exec(stdout);
      if (match !== null && !settled) {
        settled = true;
        const url = match[1];
        resolveIt({ port: Number(new URL(url).port), url, stop });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(new Error(`dsh-desktop: failed to spawn ${nodeBin}: ${error.message}`));
      }
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`dsh-desktop: dsh child exited (code ${String(code)}) before publishing its URL; is Node >= 22 on PATH?`));
      }
    });
  });
}
