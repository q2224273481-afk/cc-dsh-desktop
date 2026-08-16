"use strict";
const { app, BrowserWindow } = require("electron");
const http = require("node:http");
const path = require("node:path");

const HTML = "<!doctype html><html><body><h1>ok</h1></body></html>";
const PRELOAD = path.join(__dirname, "..", "src", "preload", "preload.cjs");

async function tryLoad(label, webPreferences, loadFn) {
  const win = new BrowserWindow({ width: 800, height: 500, show: false, webPreferences });
  const failEvents = [];
  win.webContents.on("did-fail-load", (e, code, desc, url, isMain) => failEvents.push({ code, desc, isMain }));
  let result;
  try {
    result = await Promise.race([
      loadFn(win).then(() => "loaded"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 8s")), 8000)),
    ]);
    let title = null;
    try { title = await win.webContents.executeJavaScript("document.querySelector('h1').textContent"); } catch (e) { title = "exec:" + String(e).slice(0, 60); }
    console.log("LOADTEST " + JSON.stringify({ label, result, title, failEvents }));
  } catch (e) {
    console.log("LOADTEST " + JSON.stringify({ label, result: "rejected", error: String(e).slice(0, 150), failEvents }));
  }
  win.destroy();
}

async function run() {
  app.setPath("userData", path.join(__dirname, "..", ".loadtest-userdata"));
  const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(HTML); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port + "/";
  console.log("LOADTEST-INFO serving " + base);

  const realAppPrefs = { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: PRELOAD };
  await tryLoad("A http + realAppPrefs", realAppPrefs, (w) => w.loadURL(base));
  await tryLoad("B data: + realAppPrefs", realAppPrefs, (w) => w.loadURL("data:text/html," + encodeURIComponent(HTML)));
  await tryLoad("C http + defaultPrefs", {}, (w) => w.loadURL(base));

  console.log("LOADTEST-DONE");
  app.exit(0);
}

app.whenReady().then(run).catch((e) => { console.log("LOADTEST-ERROR " + String(e)); app.exit(1); });
