// dsh-desktop preload — the only bridge between the stock web app and the
// Electron main process. contextIsolation is on and the renderer is sandboxed,
// so client plugins reach the shell exclusively through window.dshDesktop.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dshDesktop", {
  // "app" for the main window, "manager" for the plugin rescue manager window.
  kind: process.argv.includes("--dsh-manager-window") ? "manager" : "app",
  // True when the shell runs a frameless window whose top strip is drawn by the
  // web app (Windows only for now). Client plugins mount the custom title bar
  // only in this mode.
  frameless: process.platform === "win32",
  // True when the shell booted with --safe (user patch layers skipped).
  safeMode: process.argv.includes("--dsh-safe-mode"),
  // Plugin rescue manager surface (used only by the manager window).
  pm: {
    refresh: () => ipcRenderer.invoke("pm:refresh"),
    set: (payload) => ipcRenderer.invoke("pm:set", payload),
    restart: (payload) => ipcRenderer.invoke("pm:restart", payload || {}),
    openFile: (file) => ipcRenderer.invoke("pm:open-file", file),
  },
  // Report the themed colors computed in the page (from --dsw-alias-* CSS
  // variables) so the native window-controls overlay and the window background
  // follow whatever theme the app is showing.
  setTitleBarColors(bg, fg) {
    if (
      typeof bg === "string" &&
      typeof fg === "string" &&
      bg.length <= 48 &&
      fg.length <= 48
    ) {
      ipcRenderer.send("dsh-titlebar-colors", { bg, fg });
    }
  },
});
