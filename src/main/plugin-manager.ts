// dsh-desktop — 插件自救管理器：一个 GUI 窗口，列出用户补丁里的插件，
// 一键禁用/启用（写入 patch 文件），并高亮导致启动失败的元凶。
//
// 窗口加载走"主进程本地 http 服务 + 与主窗口完全相同的 webPreferences +
// preload 桥"（本环境中 data:/file: 加载被拦截，http 是已验证的唯一通道）。
// 页面内容 100% 本地静态，preload 桥是页面与主进程的唯一通道。

import { app, BrowserWindow, ipcMain, shell } from "electron";
import type { WebContents } from "electron";
import * as http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  disablePlugin,
  enablePlugin,
  extractFailedPlugin,
  listPlugins,
  patchPaths,
  SHELL_PLUGIN_IDS,
  type PatchPlugin,
} from "./patch-ops.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let managerWindow: BrowserWindow | undefined;
let managerServer: http.Server | undefined;
let managerBootError: string | null = null;
let managerRecovery = false;

export interface PmDeps {
  homeDir: () => string;
  bootError: () => string | null;
  safeMode: () => boolean;
  treeRunning: () => boolean;
  relaunch: (args: string[]) => void;
  openFile: (file: string) => Promise<string>;
}

export interface PmSnapshot {
  homeDir: string;
  safeMode: boolean;
  treeRunning: boolean;
  recovery: boolean;
  failed: { id: string; name: string } | null;
  sources: { kind: "profile" | "home"; file: string; exists: boolean; error: string | null }[];
  plugins: PatchPlugin[];
}

let pmDeps: PmDeps | undefined;

function buildSnapshot(): PmSnapshot {
  const deps = pmDeps as PmDeps;
  const homeDir = deps.homeDir();
  const { sources, plugins } = listPlugins(homeDir);
  const error = deps.bootError();
  return {
    homeDir,
    safeMode: deps.safeMode(),
    treeRunning: deps.treeRunning(),
    recovery: managerRecovery,
    failed: error === null ? null : extractFailedPlugin(error),
    sources: sources.map((s) => ({ kind: s.kind, file: s.file, exists: s.exists, error: s.error })),
    plugins,
  };
}

function allowedPatchFiles(): string[] {
  const deps = pmDeps as PmDeps;
  const paths = patchPaths(deps.homeDir());
  return [paths.profile, paths.home];
}

/** Register the pm:* IPC surface once. All writes are validated against the two user patch files. */
export function installPmIpc(deps: PmDeps): void {
  pmDeps = deps;
  ipcMain.handle("pm:refresh", () => buildSnapshot());
  ipcMain.handle("pm:set", (_event, payload: unknown) => {
    if (typeof payload !== "object" || payload === null) throw new Error("bad payload");
    const { action, id, file } = payload as { action?: unknown; id?: unknown; file?: unknown };
    if (typeof id !== "string" || typeof file !== "string") throw new Error("bad payload");
    if (!allowedPatchFiles().includes(file)) throw new Error("refusing to write outside the user patch files");
    if (SHELL_PLUGIN_IDS.has(id)) throw new Error("壳自带插件不可通过管理器禁用/启用");
    if (action === "disable") disablePlugin(file, id);
    else if (action === "enable") enablePlugin(file, id);
    else throw new Error("unknown action");
    return buildSnapshot();
  });
  ipcMain.handle("pm:restart", (_event, payload: unknown) => {
    const safe = typeof payload === "object" && payload !== null && (payload as { safe?: unknown }).safe === true;
    deps.relaunch(safe ? ["--safe"] : []);
    setTimeout(() => app.exit(0), 300);
    return { ok: true };
  });
  ipcMain.handle("pm:open-file", (_event, file: unknown) => {
    if (typeof file !== "string" || !allowedPatchFiles().includes(file)) throw new Error("bad file");
    return deps.openFile(file);
  });
}

/** For --pm-probe: the manager window's webContents, if alive. */
export function managerWebContents(): WebContents | null {
  return managerWindow !== undefined && !managerWindow.isDestroyed() ? managerWindow.webContents : null;
}

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>DSH 插件自救管理器</title>
<style>
  :root {
    --bg: #151517;
    --surface: #232325;
    --border: rgba(255, 255, 255, 0.06);
    --text: #cfd3d6;
    --text-dim: #9ba0a6;
    --accent: #f0f3f9;
    --danger: #f26d6d;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column;
    background: var(--bg); color: var(--text);
    font-family: 'Segoe UI Variable Text', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', system-ui, sans-serif;
    font-size: 13px;
    -webkit-font-smoothing: antialiased;
    user-select: none;
  }
  #tb {
    flex: 0 0 40px; height: 40px;
    display: flex; align-items: center; gap: 8px;
    padding: 0 12px;
    padding-right: calc(100vw - env(titlebar-area-width, calc(100vw - 138px)) + 12px);
    border-bottom: 1px solid var(--border);
    font-size: 12.5px; font-weight: 500; letter-spacing: 0.02em;
    color: var(--text-dim);
    -webkit-app-region: drag;
  }
  #tb .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
  #banner {
    flex: none; margin: 12px 16px 0; padding: 10px 12px;
    border: 1px solid rgba(242, 109, 109, 0.35);
    border-radius: 8px;
    background: rgba(242, 109, 109, 0.12);
    color: #f2b8b8; font-size: 12.5px; line-height: 1.5;
  }
  #wrap { flex: 1; overflow-y: auto; padding: 10px 16px 16px; }
  .empty { color: var(--text-dim); padding: 32px 0; text-align: center; }
  .row {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 12px; margin-top: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .row.off { opacity: 0.75; }
  .row .info { flex: 1; min-width: 0; }
  .row .name { font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .row .sub { color: var(--text-dim); font-size: 11.5px; margin-top: 2px; }
  .row .sub a { color: #9db8e8; text-decoration: none; }
  .row .sub a:hover { text-decoration: underline; }
  .tag { font-size: 10.5px; font-weight: 600; padding: 1px 7px; border-radius: 999px; letter-spacing: 0.02em; }
  .tag.fail { background: rgba(242, 109, 109, 0.18); color: #f2b8b8; border: 1px solid rgba(242, 109, 109, 0.4); }
  .tag.off { background: rgba(255, 255, 255, 0.07); color: var(--text-dim); border: 1px solid var(--border); }
  .tag.shell { background: rgba(157, 184, 232, 0.14); color: #9db8e8; border: 1px solid rgba(157, 184, 232, 0.4); }
  .btn {
    flex: none; padding: 5px 14px;
    border: 1px solid var(--border); border-radius: 6px;
    background: transparent; color: var(--text);
    font: inherit; font-size: 12px; cursor: pointer;
  }
  .btn:hover { background: rgba(255, 255, 255, 0.06); }
  .btn.off:hover { border-color: rgba(242, 109, 109, 0.5); color: #f2b8b8; }
  .btn.on:hover { border-color: rgba(140, 200, 140, 0.5); color: #a8d8a8; }
  .srcerr {
    margin-top: 8px; padding: 10px 12px;
    border: 1px solid rgba(242, 109, 109, 0.35); border-radius: 8px;
    background: rgba(242, 109, 109, 0.1);
    color: #f2b8b8; font-size: 12px; line-height: 1.5;
  }
  .srcerr code { color: var(--text-dim); word-break: break-all; }
  .srcerr a { color: #9db8e8; }
  #foot {
    flex: none; display: flex; gap: 8px; justify-content: flex-end;
    padding: 12px 16px; border-top: 1px solid var(--border);
  }
  #btn-restart {
    padding: 6px 16px; border: none; border-radius: 6px;
    background: var(--accent); color: #17181d;
    font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
  }
  #btn-restart:hover { background: #ffffff; }
</style>
</head>
<body>
<div id="tb"><span class="dot"></span><span>DSH 插件自救管理器</span></div>
<div id="banner" hidden></div>
<div id="wrap"><div id="list"><div class="empty">正在读取补丁…</div></div></div>
<div id="foot">
  <button id="btn-safe" class="btn">安全模式启动</button>
  <button id="btn-restart">应用并重启</button>
  <button id="btn-close" class="btn">关闭</button>
</div>
<script>
(function () {
  "use strict";
  var api = window.dshDesktop;
  function q(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  window.__pmState = null;
  function render(snap) {
    window.__pmState = snap;
    var banner = q("#banner");
    if (snap.failed) {
      banner.hidden = false;
      banner.innerHTML =
        "检测到启动失败插件：<b>" + esc(snap.failed.name) + "</b>（id: " + esc(snap.failed.id) +
        "）—— 在下方禁用它，然后点「应用并重启」。";
    } else {
      banner.hidden = true;
    }
    var list = q("#list");
    list.innerHTML = "";
    if (!snap.plugins.length) {
      list.innerHTML = '<div class="empty">用户补丁中没有找到插件。</div>';
    }
    snap.plugins.forEach(function (p) {
      var row = document.createElement("div");
      row.className = "row" + (p.disabled ? " off" : "");
      var failed = snap.failed && snap.failed.id === p.id;
      var info = document.createElement("div");
      info.className = "info";
      var name = document.createElement("div");
      name.className = "name";
      name.innerHTML =
        (failed ? '<span class="tag fail">启动失败</span> ' : "") +
        (p.disabled ? '<span class="tag off">已禁用</span> ' : "") +
        (p.shellOwned ? '<span class="tag shell">壳自带</span> ' : "") +
        esc(p.name || p.id);
      var sub = document.createElement("div");
      sub.className = "sub";
      sub.innerHTML =
        esc(p.id) + " · " + (p.kind === "home" ? "home 补丁" : "web profile 补丁") +
        (p.inserted ? " · insert 行" : " · 独立行") +
        ' · <a href="#" data-open="' + esc(p.file) + '">打开补丁文件</a>';
      info.appendChild(name);
      info.appendChild(sub);
      row.appendChild(info);
      if (p.shellOwned) {
        var badge = document.createElement("span");
        badge.className = "tag shell";
        badge.textContent = "壳自带 · 不可管理";
        row.appendChild(badge);
      } else {
        var btn = document.createElement("button");
        btn.className = "btn " + (p.disabled ? "on" : "off");
        btn.textContent = p.disabled ? "启用" : "禁用";
        btn.addEventListener("click", function () {
          api.pm.set({ action: p.disabled ? "enable" : "disable", id: p.id, file: p.file })
            .then(render)
            .catch(function (e) { alert("操作失败: " + e); });
        });
        row.appendChild(btn);
      }
      list.appendChild(row);
    });
    snap.sources.forEach(function (s) {
      if (!s.error) return;
      var err = document.createElement("div");
      err.className = "srcerr";
      err.innerHTML =
        "<b>" + (s.kind === "home" ? "home" : "web profile") + " 补丁解析失败</b>：<code>" +
        esc(s.error) + "</code> <a href='#' data-open='" + esc(s.file) + "'>打开文件手动修复</a>";
      list.appendChild(err);
    });
    q("#btn-restart").textContent = snap.recovery ? "应用并重试启动" : "应用并重启";
    q("#btn-safe").hidden = !snap.recovery;
  }
  document.addEventListener("click", function (ev) {
    var t = ev.target;
    var a = t && t.closest ? t.closest("a[data-open]") : null;
    if (!a) return;
    ev.preventDefault();
    api.pm.openFile(a.getAttribute("data-open"));
  });
  q("#btn-restart").addEventListener("click", function () { api.pm.restart({}); });
  q("#btn-safe").addEventListener("click", function () { api.pm.restart({ safe: true }); });
  q("#btn-close").addEventListener("click", function () { window.close(); });
  api.pm.refresh().then(render).catch(function (e) {
    q("#list").innerHTML = '<div class="empty">加载失败: ' + esc(String(e)) + "</div>";
  });
})();
</script>
</body>
</html>`;

/** Open (or focus) the plugin rescue manager window. */
export function openPluginManager(options: { bootError?: string | null; recovery?: boolean } = {}): void {
  managerBootError = options.bootError ?? managerBootError;
  managerRecovery = options.recovery ?? managerRecovery;
  if (managerWindow !== undefined && !managerWindow.isDestroyed()) {
    managerWindow.webContents.reload();
    managerWindow.show();
    managerWindow.focus();
    return;
  }
  managerServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE_HTML);
  });
  managerServer.listen(0, "127.0.0.1", () => {
    const address = managerServer?.address();
    if (address === undefined || address === null || typeof address === "string") return;
    const win = new BrowserWindow({
      width: 860,
      height: 620,
      minWidth: 660,
      minHeight: 440,
      show: false,
      backgroundColor: "#151517",
      title: "DSH 插件自救管理器",
      frame: false,
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#151517", symbolColor: "#cfd3d6", height: 40 },
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: join(__dirname, "..", "..", "src", "preload", "preload.cjs"),
        additionalArguments: ["--dsh-manager-window"],
      },
    });
    managerWindow = win;
    console.log(`[pm] manager window opened (recovery: ${String(managerRecovery)}, bootError: ${managerBootError === null ? "none" : "yes"})`);
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
      managerWindow = undefined;
      managerServer?.close();
      managerServer = undefined;
    });
    void win.loadURL(`http://127.0.0.1:${address.port}/`);
  });
}
