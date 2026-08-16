// dsh-desktop — shell-owned title bar (Windows).
//
// The 40px top strip is injected by the SHELL (main process), not by a client
// plugin: window chrome must survive broken user plugins (safe mode, failed
// bundles). The native Window Controls Overlay draws the caption buttons on
// top of the strip; the page reports its computed theme colors through the
// preload bridge so the buttons track the app theme.

/** Title bar height in px — the injected CSS below must match. */
export const TITLEBAR_HEIGHT = 40;

/** Initial overlay colors until the page reports its own (bluish-950/300 dark, bluish-00/700 light). */
export const TITLEBAR_DEFAULTS = {
  dark: { color: "#151517", symbolColor: "#cfd3d6" },
  light: { color: "#ffffff", symbolColor: "#61666b" },
} as const;

export function overlayFor(colors: { color: string; symbolColor: string }): Electron.TitleBarOverlay {
  return { color: colors.color, symbolColor: colors.symbolColor, height: TITLEBAR_HEIGHT };
}

/** Injected into the page at dom-ready (idempotent). Owned by the shell so it
 *  works even when every user client plugin fails to load. */
export const TITLEBAR_INJECT_SCRIPT = `(() => {
  if (document.getElementById("dsh-desktop-titlebar")) return;
  if (!(window.dshDesktop && window.dshDesktop.frameless)) return;
  const H = ${TITLEBAR_HEIGHT};
  const safe = !!(window.dshDesktop && window.dshDesktop.safeMode);
  const css = [
    ":root { --dsh-desktop-titlebar-height: " + H + "px; }",
    "body { padding-top: var(--dsh-desktop-titlebar-height); box-sizing: border-box; }",
    "#dsh-desktop-titlebar {",
    "  position: fixed; top: 0; left: 0; right: 0;",
    "  height: var(--dsh-desktop-titlebar-height);",
    "  z-index: 2147483000;",
    "  display: flex; align-items: center; gap: 8px;",
    "  padding: 0 12px;",
    "  padding-right: calc(100vw - env(titlebar-area-width, calc(100vw - 138px)) + 12px);",
    "  background: var(--dsw-alias-bg-base);",
    "  color: var(--dsw-alias-label-secondary);",
    "  border-bottom: 1px solid var(--dsw-alias-border-l1);",
    "  font-size: 12.5px; font-weight: 500; letter-spacing: 0.02em;",
    "  box-sizing: border-box; user-select: none;",
    "  -webkit-app-region: drag;",
    "}",
    "#dsh-desktop-titlebar .dsh-desktop-dot {",
    "  width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto;",
    "  background: var(--dsw-alias-brand-primary, rgb(65, 118, 230));",
    "}",
    "#dsh-desktop-titlebar .dsh-desktop-title {",
    "  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;",
    "}",
  ].join("\\n");
  const style = document.createElement("style");
  style.id = "dsh-desktop-titlebar-style";
  style.textContent = css;
  document.head.appendChild(style);
  const bar = document.createElement("div");
  bar.id = "dsh-desktop-titlebar";
  const dot = document.createElement("span");
  dot.className = "dsh-desktop-dot";
  const title = document.createElement("span");
  title.className = "dsh-desktop-title";
  const setTitle = () => {
    const base = document.title || "DeepSeek Harness";
    title.textContent = safe ? base + " — Safe Mode" : base;
  };
  setTitle();
  bar.appendChild(dot);
  bar.appendChild(title);
  document.body.appendChild(bar);
  const report = () => {
    const api = window.dshDesktop;
    if (!api || typeof api.setTitleBarColors !== "function") return;
    const cs = getComputedStyle(document.body);
    const bg = cs.getPropertyValue("--dsw-alias-bg-base").trim();
    const fg = cs.getPropertyValue("--dsw-alias-label-secondary").trim();
    if (bg && fg) api.setTitleBarColors(bg, fg);
  };
  report();
  new MutationObserver(report).observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
  const titleNode = document.querySelector("title");
  if (titleNode) new MutationObserver(setTitle).observe(titleNode, { childList: true, characterData: true, subtree: true });
  [200, 800].forEach((ms) => setTimeout(report, ms));
})()`;
