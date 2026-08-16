// dsh-desktop — DSH core update UI + confirm-then-update action.
// A small frameless window (same look as the plugin manager) shows the installed
// vs latest version. It never updates automatically: the update runs only after
// the user clicks "更新". In-place npm update makes sense in dev/source mode;
// the packaged app's node_modules is read-only, so the button is withheld there.

import { app, BrowserWindow, ipcMain, shell } from "electron";
import type { WebContents } from "electron";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkForUpdate } from "./update-check.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DSH_PKG = "@deepseek-ai/dsh";
const DSH_APP_BOOT_PKG = "@deepseek-ai/dsh-app-boot";
const REPO_URL = "https://github.com/deepseek-ai/deepseek-harness";

let updateWindow: BrowserWindow | undefined;
let updateServer: http.Server | undefined;

export interface UpdaterDeps {
  relaunch: (args: string[]) => void;
}

let updaterDeps: UpdaterDeps | undefined;

/** Register the upd:* IPC surface once. */
export function installUpdaterIpc(deps: UpdaterDeps): void {
  updaterDeps = deps;
  ipcMain.handle("upd:check", async () => {
    const info = await checkForUpdate();
    return { ...info, packaged: app.isPackaged };
  });
  ipcMain.handle("upd:update", async (_event, payload: unknown) => {
    const version =
      typeof payload === "object" && payload !== null ? (payload as { version?: unknown }).version : undefined;
    if (typeof version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(version)) {
      throw new Error("bad version");
    }
    if (app.isPackaged) throw new Error("打包版不支持就地 npm 更新，请重新安装最新安装包");
    return runNpmUpdate(version);
  });
  ipcMain.handle("upd:restart", () => {
    updaterDeps?.relaunch([]);
    setTimeout(() => app.exit(0), 300);
    return { ok: true };
  });
  ipcMain.handle("upd:open-repo", () => {
    void shell.openExternal(REPO_URL);
    return { ok: true };
  });
}

/** Run npm install for the two core packages in the app root (dev/source mode). */
function runNpmUpdate(version: string): Promise<{ ok: boolean; exitCode: number | null; error: string | null }> {
  return new Promise((resolveIt) => {
    const appRoot = join(__dirname, "..", "..");
    const args = ["install", `${DSH_PKG}@${version}`, `${DSH_APP_BOOT_PKG}@${version}`, "--no-audit", "--no-fund"];
    console.log("[updater] npm", args.join(" "));
    // stdio:"inherit" keeps npm output on the app's stdout (and, unlike piped
    // stdio, also works inside confined sandboxes); the exit code is what matters.
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? "npm.cmd" : "npm", args, { cwd: appRoot, stdio: "inherit", shell: isWin });
    child.once("error", (error) => {
      console.log("[updater] spawn error:", error.message);
      resolveIt({ ok: false, exitCode: null, error: error.message });
    });
    child.once("close", (code) => {
      console.log("[updater] npm exit code:", code);
      resolveIt({ ok: code === 0, exitCode: code, error: code === 0 ? null : `npm install 退出码 ${code}` });
    });
  });
}

/** For diagnostics: the update window's webContents, if alive. */
export function updateWebContents(): WebContents | null {
  return updateWindow !== undefined && !updateWindow.isDestroyed() ? updateWindow.webContents : null;
}

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>DSH 核心更新</title>
<style>
  :root {
    --bg: #151517; --surface: #232325;
    --border: rgba(255, 255, 255, 0.06);
    --text: #cfd3d6; --text-dim: #9ba0a6;
    --accent: #f0f3f9; --good: #a8d8a8; --bad: #f2b8b8;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column;
    background: var(--bg); color: var(--text);
    font-family: 'Segoe UI Variable Text', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', system-ui, sans-serif;
    font-size: 13px; -webkit-font-smoothing: antialiased; user-select: none;
  }
  #tb {
    flex: 0 0 40px; height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 12px;
    padding-right: calc(100vw - env(titlebar-area-width, calc(100vw - 138px)) + 12px);
    border-bottom: 1px solid var(--border);
    font-size: 12.5px; font-weight: 500; letter-spacing: 0.02em; color: var(--text-dim);
    -webkit-app-region: drag;
  }
  #tb .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
  #body { flex: 1; padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 4px 14px; }
  .kv { display: flex; align-items: center; justify-content: space-between; padding: 10px 0;
    border-bottom: 1px solid var(--border); }
  .kv:last-child { border-bottom: none; }
  .kv span { color: var(--text-dim); font-size: 12.5px; }
  .kv b { font-weight: 600; font-family: 'Cascadia Code', Consolas, monospace; font-size: 13px; }
  #status { font-size: 13px; line-height: 1.5; }
  #status.ok { color: var(--good); }
  #status.good { color: var(--good); font-weight: 600; }
  #status.bad { color: var(--bad); }
  #error { font-size: 12px; line-height: 1.5; color: var(--bad);
    background: rgba(242, 109, 109, 0.1); border: 1px solid rgba(242, 109, 109, 0.35);
    border-radius: 8px; padding: 10px 12px; word-break: break-all; }
  #foot { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 16px;
    border-top: 1px solid var(--border); }
  .spacer { flex: 1; }
  .btn { padding: 6px 14px; border: 1px solid var(--border); border-radius: 6px; background: transparent;
    color: var(--text); font: inherit; font-size: 12px; cursor: pointer; }
  .btn:hover { background: rgba(255, 255, 255, 0.06); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .primary { padding: 6px 16px; border: none; border-radius: 6px; background: var(--accent);
    color: #17181d; font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; }
  .primary:hover { background: #ffffff; }
  .primary:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
<div id="tb"><span class="dot"></span><span>DSH 核心更新</span></div>
<div id="body">
  <div class="card">
    <div class="kv"><span>当前版本</span><b id="installed">—</b></div>
    <div class="kv"><span>最新版本</span><b id="latest">—</b></div>
    <div class="kv"><span>master 分支</span><b id="master">—</b></div>
  </div>
  <div id="status">正在检查更新…</div>
  <div id="error" hidden></div>
</div>
<div id="foot">
  <button id="btn-repo" class="btn">仓库主页</button>
  <span class="spacer"></span>
  <button id="btn-later" class="btn" hidden>稍后</button>
  <button id="btn-update" class="primary" hidden>更新</button>
  <button id="btn-restart" class="primary" hidden>重启以生效</button>
  <button id="btn-close" class="btn">关闭</button>
</div>
<script>
(function () {
  "use strict";
  var api = window.dshDesktop;
  function q(s) { return document.querySelector(s); }
  function render(info) {
    q("#installed").textContent = info.installed || "unknown";
    q("#latest").textContent = info.latest || "unknown";
    q("#master").textContent = info.master || "—";
    var status = q("#status"), err = q("#error");
    var btnUpdate = q("#btn-update"), btnLater = q("#btn-later"), btnRestart = q("#btn-restart");
    btnUpdate.hidden = true; btnLater.hidden = true; btnRestart.hidden = true; err.hidden = true;
    btnUpdate.disabled = false;
    if (info.error) {
      status.textContent = "检查失败";
      status.className = "bad";
      err.hidden = false; err.textContent = info.error;
    } else if (info.updatable) {
      status.textContent = "发现新版本 " + info.installed + " → " + info.latest;
      status.className = "good";
      if (info.packaged) {
        status.textContent += "（打包版请重新安装最新安装包）";
      } else {
        btnUpdate.hidden = false; btnLater.hidden = false;
      }
    } else {
      status.textContent = "已是最新版本";
      status.className = "ok";
    }
  }
  function fail(e) {
    q("#status").textContent = "检查失败"; q("#status").className = "bad";
    q("#error").hidden = false; q("#error").textContent = String(e && e.message ? e.message : e);
  }
  api.upd.check().then(render).catch(fail);
  q("#btn-update").addEventListener("click", function () {
    var v = q("#latest").textContent;
    q("#btn-update").disabled = true; q("#btn-later").hidden = true;
    q("#status").textContent = "正在更新到 " + v + " …（可能需要一段时间）";
    q("#status").className = "";
    api.upd.update({ version: v }).then(function (r) {
      if (r && r.ok) {
        q("#status").textContent = "更新完成，重启后生效";
        q("#status").className = "good";
        q("#btn-update").hidden = true;
        q("#btn-restart").hidden = false;
      } else {
        q("#status").textContent = "更新失败";
        q("#status").className = "bad";
        q("#error").hidden = false; q("#error").textContent = (r && r.error) || "未知错误";
        q("#btn-update").disabled = false; q("#btn-update").hidden = false; q("#btn-later").hidden = false;
      }
    }).catch(function (e) {
      q("#status").textContent = "更新失败"; q("#status").className = "bad";
      q("#error").hidden = false; q("#error").textContent = String(e && e.message ? e.message : e);
      q("#btn-update").disabled = false; q("#btn-update").hidden = false; q("#btn-later").hidden = false;
    });
  });
  q("#btn-restart").addEventListener("click", function () { api.upd.restart(); });
  q("#btn-later").addEventListener("click", function () { window.close(); });
  q("#btn-close").addEventListener("click", function () { window.close(); });
  q("#btn-repo").addEventListener("click", function () { api.upd.openRepo(); });
})();
</script>
</body>
</html>`;

/** Open (or focus) the update checker window. */
export function openUpdateWindow(): void {
  if (updateWindow !== undefined && !updateWindow.isDestroyed()) {
    updateWindow.show();
    updateWindow.focus();
    updateWindow.webContents.reload();
    return;
  }
  updateServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE_HTML);
  });
  updateServer.listen(0, "127.0.0.1", () => {
    const address = updateServer?.address();
    if (address === undefined || address === null || typeof address === "string") return;
    const win = new BrowserWindow({
      width: 480,
      height: 360,
      minWidth: 420,
      minHeight: 320,
      show: false,
      backgroundColor: "#151517",
      title: "DSH 核心更新",
      frame: false,
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#151517", symbolColor: "#cfd3d6", height: 40 },
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: join(__dirname, "..", "..", "src", "preload", "preload.cjs"),
        additionalArguments: ["--dsh-updater-window"],
      },
    });
    updateWindow = win;
    console.log("[updater] update window opened");
    win.once("ready-to-show", () => {
      win.setOpacity(0);
      win.show();
      let step = 0;
      const ramp = setInterval(() => {
        step += 1;
        win.setOpacity(Math.min(1, step * 0.2));
        if (step >= 5) clearInterval(ramp);
      }, 24);
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.on("closed", () => {
      updateWindow = undefined;
      updateServer?.close();
      updateServer = undefined;
    });
    void win.loadURL(`http://127.0.0.1:${address.port}/`);
  });
}
