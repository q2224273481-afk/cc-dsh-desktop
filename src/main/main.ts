// dsh-desktop — Electron main process.
//
// Phase 1 shape: boot the dsh web profile IN-PROCESS (boot.ts, the same tree
// `dsh --profile web` boots), then point a sandboxed BrowserWindow at the
// local HTTP URL. The renderer is the stock web frontend over the stock
// HTTP/WebSocket transport, so every web feature and every plugin mechanism
// works unchanged; the only renderer bridge is window.dshDesktop (preload),
// which carries title-bar color sync and the safe-mode flag.
//
// Flags (the shell's own; tree flags are fixed internally):
//   --smoke            boot, verify HTTP + /api surface, print JSON, exit (0 ok / 3 fail)
//   --backend child    run the dsh CLI as a child process instead of in-process
//   --home <dir>       DSH_HOME override
//   --user-data <dir>  Electron userData override (logs live under it)
//   --cwd <dir>        working directory for the booted tree (default: user home)
//   --port <n>         fixed port instead of 0 (OS-assigned)
//   --no-tray          disable the tray icon
//   --quit-on-close    closing the window quits instead of hiding to tray
//   --maximized        open the window maximized
//   --probe            load the UI headless, dump title-bar/WCO geometry as JSON, exit
//   --safe             skip user patch layers (profile + home) — broken-plugin recovery
//   --headless         no recovery dialog: print RECOVERY-JSON and exit 2 instead
//   --plugin-manager   open the plugin rescue manager window instead of booting the tree
//   --pm-probe         headless: try boot, open the manager, dump its state, exit

import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, nativeTheme, shell } from "electron";
import { createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROFILE_PATCH_FILENAME } from "@deepseek-ai/dsh-app-boot";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { bootWebTree, type BootResult } from "./boot.js";
import { runChildFallback } from "./fallback.js";
import { installPmIpc, managerWebContents, openPluginManager } from "./plugin-manager.js";
import { overlayFor, TITLEBAR_DEFAULTS, TITLEBAR_INJECT_SCRIPT } from "./titlebar.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Flags {
  smoke: boolean;
  backend: "inprocess" | "child";
  home?: string;
  userData?: string;
  cwd?: string;
  port?: number;
  noTray: boolean;
  quitOnClose: boolean;
  maximized: boolean;
  probe: boolean;
  tbMode: string;
  safe: boolean;
  headless: boolean;
  pluginManager: boolean;
  pmProbe: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { smoke: false, backend: "inprocess", noTray: false, quitOnClose: false, maximized: false, probe: false, tbMode: "d", safe: false, headless: false, pluginManager: false, pmProbe: false };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--smoke": flags.smoke = true; break;
      case "--backend": flags.backend = argv[++i] === "child" ? "child" : "inprocess"; break;
      case "--home": flags.home = argv[++i]; break;
      case "--user-data": flags.userData = argv[++i]; break;
      case "--cwd": flags.cwd = argv[++i]; break;
      case "--port": { const p = Number(argv[++i]); if (Number.isInteger(p) && p >= 0) flags.port = p; break; }
      case "--no-tray": flags.noTray = true; break;
      case "--quit-on-close": flags.quitOnClose = true; break;
      case "--maximized": flags.maximized = true; break;
      case "--probe": flags.probe = true; break;
      case "--tb-mode": flags.tbMode = argv[++i] ?? "a"; break;
      case "--safe": flags.safe = true; break;
      case "--headless": flags.headless = true; break;
      case "--plugin-manager": flags.pluginManager = true; break;
      case "--pm-probe": flags.pmProbe = true; break;
      default: break;
    }
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(app.isPackaged ? 1 : 2));
if (flags.userData !== undefined) app.setPath("userData", flags.userData);
app.setAppUserModelId("dev.dsh.desktop");

// ── custom title bar (Windows): frameless window + native Window Controls ─────
// Overlay. The themed strip across the top is injected by the shell itself
// (titlebar.ts) at dom-ready — deliberately NOT by a client plugin, so window
// chrome survives broken user plugins (safe mode, failed bundles). The OS
// keeps drawing real caption buttons on top of the strip.
const isWindows = process.platform === "win32";

// Candidate frameless/title-bar configurations (probe-tested via --tb-mode):
//   a  frame:false + titleBarOverlay object   (WCO disabled: "Titlebar overlay is not enabled")
//   b  titleBarStyle:hidden + overlay object  (WCO ok)
//   c  frame:false + titleBarOverlay: true    (WCO disabled)
//   d  frame:false + titleBarStyle:hidden + overlay object (WCO ok, content flush to edges)
// This Electron requires titleBarStyle:"hidden" for the overlay to exist.
function titleBarWindowOptions(): Partial<Electron.BrowserWindowConstructorOptions> {
  if (!isWindows) return {};
  const overlay = overlayFor(TITLEBAR_DEFAULTS[nativeTheme.shouldUseDarkColors ? "dark" : "light"]);
  switch (flags.tbMode) {
    case "b": return { titleBarStyle: "hidden", titleBarOverlay: overlay };
    case "c": return { frame: false, titleBarOverlay: true };
    case "d": return { frame: false, titleBarStyle: "hidden", titleBarOverlay: overlay };
    default: return { frame: false, titleBarOverlay: overlay };
  }
}

let titleBarColorsReported = false;

function installTitleBarIpc(): void {
  ipcMain.on("dsh-titlebar-colors", (event, payload: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win === null || win !== mainWindow || !isWindows) return;
    if (typeof payload !== "object" || payload === null) return;
    const { bg, fg } = payload as { bg?: unknown; fg?: unknown };
    if (typeof bg !== "string" || typeof fg !== "string") return;
    if (!/^[\w#(),.%\s-]{1,48}$/.test(bg) || !/^[\w#(),.%\s-]{1,48}$/.test(fg)) return;
    try {
      if (!titleBarColorsReported) logLine("[titlebar] page reported colors", { bg, fg });
      win.setTitleBarOverlay(overlayFor({ color: bg, symbolColor: fg }));
      win.setBackgroundColor(bg);
      titleBarColorsReported = true;
    } catch (error) {
      logLine("[titlebar] setTitleBarOverlay failed:", error instanceof Error ? error.message : String(error));
    }
  });
}

// ── logging: everything (shell + tree stdout/stderr) goes to one file ──────────
const originalConsoleLog = console.log;
let logStream: ReturnType<typeof createWriteStream> | undefined;
let logFilePath = "";

function openLogFile(): void {
  const dir = join(app.getPath("userData"), "logs");
  mkdirSync(dir, { recursive: true });
  logFilePath = join(dir, `desktop-${new Date().toISOString().slice(0, 10)}.log`);
  logStream = createWriteStream(logFilePath, { flags: "a" });
}

function logLine(...parts: unknown[]): void {
  const text = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  const stamped = `[${new Date().toISOString()}] ${text}`;
  originalConsoleLog(stamped);
  logStream?.write(stamped + "\n");
}

// Route the shell's own console AND the tree's stdout/stderr into the log file.
console.log = logLine;
console.error = logLine;

// ── backend start (in-process default, child fallback) ─────────────────────────
let booted: BootResult | undefined;
let pendingExitCode = 0;
let lastBootError: string | null = null;

async function startBackend(): Promise<BootResult> {
  // Safe mode always boots in-process: only the in-process path can skip the
  // user patch layers deterministically.
  if (flags.backend === "child" && !flags.safe) {
    const child = await runChildFallback({
      args: ["--port", String(flags.port ?? 0)],
      home: flags.home,
      cwd: flags.cwd ?? homedir(),
      onLine: (line) => logLine("[dsh]", line),
    });
    return {
      ctx: undefined as any,
      port: child.port,
      url: child.url,
      dispose: async () => {
        await child.stop();
      },
    };
  }
  return bootWebTree({
    args: ["--port", String(flags.port ?? 0)],
    home: flags.home,
    cwd: flags.cwd ?? homedir(),
    safe: flags.safe,
    bareModuleBaseUrl: pathToFileURL(join(__dirname, "..", "..", "node_modules")).href + "/",
    stderr: (line) => logLine("[tree]", line),
    exit: (code) => {
      logLine("[tree] exit requested:", code);
      pendingExitCode = code;
      app.quit();
    },
  });
}

// ── window & tray ──────────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;

function trayIconPath(): string {
  return join(__dirname, "..", "..", "assets", "icon.png");
}

function createTray(): void {
  let image: Electron.NativeImage | undefined;
  try {
    image = nativeImage.createFromPath(trayIconPath());
  } catch {
    image = undefined;
  }
  if (image === undefined || image.isEmpty()) {
    logLine("[tray] icon missing at", trayIconPath(), "— tray disabled");
    return;
  }
  tray = new Tray(image);
  const menu = Menu.buildFromTemplate([
    { label: "Show DSH", click: () => showMainWindow() },
    { label: "插件管理器…", click: () => openPluginManager({}) },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setToolTip("DSH Desktop");
  tray.setContextMenu(menu);
  tray.on("click", () => showMainWindow());
}

function showMainWindow(): void {
  if (mainWindow === undefined) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createMainWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    // Match the system theme so the first paint never flashes white.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#14161c" : "#f5f6f7",
    title: "DSH Desktop",
    ...titleBarWindowOptions(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Minimal bridge for desktop-only client plugins (title bar color sync,
      // frameless flag). The renderer itself stays the stock web frontend.
      preload: join(__dirname, "..", "..", "src", "preload", "preload.cjs"),
      additionalArguments: flags.safe ? ["--dsh-safe-mode"] : [],
    },
  });
  win.once("ready-to-show", () => {
    if (flags.probe) return; // headless probe: never show
    // Gentle fade-in instead of a hard pop.
    win.setOpacity(0);
    win.show();
    let step = 0;
    const ramp = setInterval(() => {
      step += 1;
      win.setOpacity(Math.min(1, step * 0.2));
      if (step >= 5) clearInterval(ramp);
    }, 24);
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    }
  });
  win.on("close", (event) => {
    if (!quitting && tray !== undefined && !flags.quitOnClose) {
      event.preventDefault();
      win.hide();
    }
  });
  if (isWindows) {
    // Shell-owned title bar strip: injected here, so it exists even when every
    // user client plugin failed to load.
    win.webContents.on("dom-ready", () => {
      void win.webContents.executeJavaScript(TITLEBAR_INJECT_SCRIPT).catch((error) => {
        logLine("[titlebar] inject failed:", error instanceof Error ? error.message : String(error));
      });
    });
  }
  void win.loadURL(url);
  return win;
}

// ── smoke mode: no window, verify the full HTTP surface, exit ─────────────────
async function runSmoke(): Promise<number> {
  try {
    const startedAt = Date.now();
    const backend = await startBackend();
    const html = await (await fetch(backend.url + "/")).text();
    if (!html.includes("__DSH_BOOT__")) throw new Error("index.html has no __DSH_BOOT__");
    const match = /window\.__DSH_BOOT__\s*=\s*(\{.*?\})\s*<\/script>/s.exec(html);
    if (match === null) throw new Error("cannot extract boot manifest from index.html");
    const graph = JSON.parse(match[1].replaceAll("\\u003c", "<"));
    const rows: any[] = Array.isArray(graph) ? graph : (graph.entries ?? []);
    if (rows.length === 0) throw new Error("boot manifest graph is empty");
    const first = rows[0];
    if (typeof first.url !== "string") throw new Error("boot graph row has no url");
    const bundle = await (await fetch(backend.url + first.url)).text();
    if (bundle.length < 100) throw new Error("client bundle fetch returned too little data");
    const entries = backend.ctx !== undefined ? [...backend.ctx.loader.entries()] : [];
    console.log(JSON.stringify({
      ok: true,
      backend: flags.backend,
      url: backend.url,
      port: backend.port,
      entryCount: entries.length,
      clientPluginCount: rows.length,
      bundleBytes: bundle.length,
      elapsedMs: Date.now() - startedAt,
    }));
    await backend.dispose();
    return 0;
  } catch (error) {
    console.error("SMOKE FAIL:", error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 3;
  }
}

// ── probe mode: headless UI load, dump title-bar/WCO geometry, exit ───────────
const PROBE_SCRIPT = `(() => {
  const bar = document.getElementById("dsh-desktop-titlebar");
  document.documentElement.style.setProperty("--dsh-probe-env-w", "env(titlebar-area-width, 777px)");
  document.documentElement.style.setProperty("--dsh-probe-env-h", "env(titlebar-area-height, 777px)");
  const rootStyle = getComputedStyle(document.documentElement);
  const cs = bar ? getComputedStyle(bar) : null;
  const bodyStyle = getComputedStyle(document.body);
  const root = document.getElementById("root");
  const rootRect = root ? root.getBoundingClientRect() : null;
  const header = document.querySelector(".wSkVaW_header");
  const headerRect = header ? header.getBoundingClientRect() : null;
  const wco = navigator.windowControlsOverlay;
  return {
    inner: { width: window.innerWidth, height: window.innerHeight },
    wco: wco ? { visible: wco.visible, rect: wco.getTitlebarAreaRect() } : null,
    strip: bar && cs ? {
      text: bar.textContent.trim(),
      height: cs.height, top: cs.top, width: cs.width,
      bg: cs.backgroundColor, color: cs.color,
      fontSize: cs.fontSize, fontWeight: cs.fontWeight,
      appRegion: cs.webkitAppRegion,
      borderBottom: cs.borderBottomWidth,
      paddingRight: cs.paddingRight,
    } : null,
    body: {
      paddingTop: bodyStyle.paddingTop,
      bg: bodyStyle.backgroundColor,
      dark: document.body.hasAttribute("data-ds-dark-theme"),
      bgBaseVar: bodyStyle.getPropertyValue("--dsw-alias-bg-base").trim(),
      labelSecondaryVar: bodyStyle.getPropertyValue("--dsw-alias-label-secondary").trim(),
      fontFamily: bodyStyle.fontFamily.slice(0, 90),
    },
    root: rootRect ? { top: rootRect.top, height: rootRect.height } : null,
    sessionHeader: headerRect ? { top: headerRect.top, height: headerRect.height } : null,
    title: document.title,
    bridge: typeof window.dshDesktop === "object" ? Object.keys(window.dshDesktop).sort() : null,
    env: {
      w: rootStyle.getPropertyValue("--dsh-probe-env-w").trim(),
      h: rootStyle.getPropertyValue("--dsh-probe-env-h").trim(),
    },
  };
})()`;

async function runProbe(): Promise<void> {
  try {
    booted = await startBackend();
  } catch (error) {
    console.log(`PROBE-BOOT-ERROR ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}`);
    quitting = true;
    app.exit(2);
    return;
  }
  logLine("[probe] web tree settled at", booted.url);
  mainWindow = createMainWindow(booted.url);
  let done = false;
  const finish = (label: string, data?: unknown): void => {
    if (done) return;
    done = true;
    console.log(`${label} ${JSON.stringify({ tbMode: flags.tbMode, data })}`);
    quitting = true;
    app.exit(0);
  };
  mainWindow.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      mainWindow?.webContents
        .executeJavaScript(PROBE_SCRIPT, true)
        .then((data) => finish("PROBE-JSON", data))
        .catch((error) => finish("PROBE-ERROR", String(error)));
    }, 2500);
  });
  setTimeout(() => finish("PROBE-ERROR", "did-finish-load timeout"), 20000);
}

// ── boot recovery: retry / safe mode / open patch ──────────────────────────────
const BOOT_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolveIt, reject) => {
    const timer = setTimeout(() => reject(new Error(`dsh-desktop: ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveIt(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function userPatchPath(): string {
  return join(resolveDshHome(), "profiles", "web", PROFILE_PATCH_FILENAME);
}

function relaunchApp(extraArgs: string[]): void {
  const baseArgs = process.argv.slice(app.isPackaged ? 1 : 2);
  const filtered = baseArgs.filter(
    (a) => a !== "--safe" && a !== "--plugin-manager" && a !== "--pm-probe",
  );
  const relaunchArgs = [...extraArgs, ...filtered];
  logLine("[recovery] relaunching with args", relaunchArgs);
  app.relaunch({ args: relaunchArgs });
}

function relaunchWithSafeMode(): void {
  relaunchApp(["--safe"]);
}

async function showRecoveryDialog(firstLine: string): Promise<"retry" | "safe" | "manager" | "patch" | "quit"> {
  const result = await dialog.showMessageBox({
    type: "error",
    title: "DSH Desktop 启动失败",
    message: "插件树启动失败",
    detail: `${firstLine}\n\n可能是某个插件或补丁出了问题。你可以：\n\n• 重试 —— 可能只是暂时性问题\n• 插件管理器 —— 用图形界面禁用出问题的插件\n• 安全模式 —— 跳过全部用户补丁和插件，只加载内置功能\n• 打开补丁文件 —— 手动注释掉出错的插件行，然后回来点重试\n\n日志：${logFilePath}`,
    buttons: ["重试", "插件管理器…", "安全模式启动", "打开补丁文件", "退出"],
    defaultId: 0,
    cancelId: 4,
    noLink: true,
  });
  switch (result.response) {
    case 0: return "retry";
    case 1: return "manager";
    case 2: return "safe";
    case 3: return "patch";
    default: return "quit";
  }
}

/** Open the plugin manager (direct-to-GUI recovery) and resolve when its
 *  window closes — or immediately when it cannot open. A restart/safe-mode
 *  click inside the manager relaunches the process instead of resolving. */
function waitForManagerClose(bootError: string): Promise<void> {
  return new Promise((resolveIt) => {
    openPluginManager({ bootError, recovery: true });
    const wc = managerWebContents();
    if (wc === null) {
      resolveIt();
      return;
    }
    const win = BrowserWindow.fromWebContents(wc);
    if (win === null || win.isDestroyed()) {
      resolveIt();
      return;
    }
    win.once("closed", () => resolveIt());
  });
}

/** Boot with retry + safe-mode recovery. Resolves true when the tree is up. */
async function bootWithRecovery(): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      booted = await withTimeout(startBackend(), BOOT_TIMEOUT_MS, `backend boot timed out after ${BOOT_TIMEOUT_MS / 1000}s`);
      logLine("[boot] web tree settled at", booted.url);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastBootError = message;
      logLine("[boot] FAILED:", error instanceof Error ? (error.stack ?? message) : message);
      if (flags.headless) {
        console.log(`RECOVERY-JSON ${JSON.stringify({ stage: "boot-failed", attempt, safe: flags.safe, message: message.slice(0, 600) })}`);
        quitting = true;
        app.exit(2);
        return false;
      }
      // Direct-to-GUI recovery: the plugin manager pops immediately on every
      // failure. Only after the user closes it does the dialog appear as a
      // fallback (retry / safe mode / manager / patch / quit).
      await waitForManagerClose(message);
      const choice = await showRecoveryDialog(message.split("\n")[0] ?? message);
      if (choice === "retry") continue;
      if (choice === "manager") {
        openPluginManager({ bootError: message, recovery: true });
        continue;
      }
      if (choice === "patch") {
        void shell.openPath(userPatchPath());
        continue;
      }
      if (choice === "safe") {
        relaunchWithSafeMode();
        quitting = true;
        app.exit(0);
        return false;
      }
      quitting = true;
      app.exit(1);
      return false;
    }
  }
}

// ── pm probe: headless plugin-manager drill (boot → dump → optionally disable) ─
async function runPmProbe(): Promise<void> {
  let bootError: string | null = null;
  try {
    booted = await withTimeout(startBackend(), BOOT_TIMEOUT_MS, "pm-probe boot timed out");
  } catch (error) {
    bootError = error instanceof Error ? error.message : String(error);
  }
  lastBootError = bootError;
  openPluginManager({ bootError, recovery: bootError !== null });
  await new Promise((resolveIt) => setTimeout(resolveIt, 3500));
  const wc = managerWebContents();
  if (wc === null) {
    console.log("PM-PROBE-ERROR no manager window");
    quitting = true;
    app.exit(2);
    return;
  }
  const script = [
    "(async () => {",
    "  const s1 = window.__pmState;",
    "  let after = null;",
    "  if (s1 && s1.failed) {",
    "    const target = s1.plugins.find((p) => p.id === s1.failed.id) || { file: s1.sources[0].file, id: s1.failed.id };",
    "    await window.dshDesktop.pm.set({ action: 'disable', id: s1.failed.id, file: target.file });",
    "    const s2 = await window.dshDesktop.pm.refresh();",
    "    after = (s2.plugins.find((p) => p.id === s1.failed.id)) || null;",
    "  }",
    "  return {",
    "    plugins: s1 ? s1.plugins.length : -1,",
    "    pluginIds: s1 ? s1.plugins.map((p) => p.id) : [],",
    "    failed: s1 ? s1.failed : null,",
    "    banner: document.getElementById('banner').hidden ? null : document.getElementById('banner').textContent,",
    "    afterDisable: after,",
    "    title: document.querySelector('#tb').textContent.trim(),",
    "  };",
    "})()",
  ].join("\n");
  try {
    const dump = await wc.executeJavaScript(script, true);
    console.log("PM-PROBE-JSON " + JSON.stringify(dump));
  } catch (error) {
    console.log("PM-PROBE-ERROR " + String(error));
  }
  quitting = true;
  app.exit(0);
}

// ── lifecycle ─────────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());

  app.on("window-all-closed", () => {
    if (tray === undefined || flags.quitOnClose) app.quit();
  });

  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (async () => {
      try {
        // Mirror the CLI's bounded shutdown: 5s grace, then exit anyway.
        await Promise.race([
          (async () => {
            await booted?.dispose();
          })(),
          new Promise((resolveIt) => setTimeout(resolveIt, 5000)),
        ]);
      } catch (error) {
        logLine("[quit] dispose failed:", error);
      }
      app.exit(pendingExitCode);
    })();
  });

  void app.whenReady().then(async () => {
    openLogFile();
    logLine("dsh-desktop", JSON.stringify({ version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, flags }));
    if (flags.smoke) {
      const code = await runSmoke();
      logLine("[smoke] exit", code);
      quitting = true;
      app.exit(code);
      return;
    }
    try {
      // No native menu bar (File/Edit/View/...): the shell is pure UI. macOS
      // keeps a minimal default because its window manager expects one.
      if (process.platform !== "darwin") Menu.setApplicationMenu(null);
      installTitleBarIpc();
      installPmIpc({
        homeDir: () => resolveDshHome(),
        bootError: () => lastBootError,
        safeMode: () => flags.safe,
        treeRunning: () => booted !== undefined && mainWindow !== undefined && !mainWindow.isDestroyed(),
        relaunch: (args) => relaunchApp(args),
        openFile: (file) => shell.openPath(file),
      });
      if (flags.probe) {
        await runProbe();
        return;
      }
      if (flags.pluginManager) {
        openPluginManager({});
        return;
      }
      if (flags.pmProbe) {
        await runPmProbe();
        return;
      }
      // Fallback for the first paint: OS theme flips are applied only until
      // the page reports its own computed colors (the app theme may differ
      // from the OS scheme).
      nativeTheme.on("updated", () => {
        if (!titleBarColorsReported && mainWindow !== undefined && isWindows) {
          mainWindow.setTitleBarOverlay(
            overlayFor(TITLEBAR_DEFAULTS[nativeTheme.shouldUseDarkColors ? "dark" : "light"]),
          );
        }
      });
      const ok = await bootWithRecovery();
      if (!ok || booted === undefined) return;
      mainWindow = createMainWindow(booted.url);
      if (flags.maximized) mainWindow.maximize();
      if (!flags.noTray) createTray();
    } catch (error) {
      // bootWithRecovery handles boot failures; this is for shell-level surprises.
      logLine("[boot] unexpected:", error instanceof Error ? (error.stack ?? error.message) : String(error));
      dialog.showErrorBox(
        "DSH Desktop failed to start",
        `${error instanceof Error ? error.message : String(error)}\n\nDetails: ${logFilePath}`,
      );
      quitting = true;
      app.exit(1);
    }
  });
}
