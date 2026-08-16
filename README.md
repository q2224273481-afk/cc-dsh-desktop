# dsh-desktop

> **DSH 桌面壳（Phase 1）** — 一个薄壳，把 DeepSeek Harness 的完整 Web 界面与插件生态装进原生桌面窗口。

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Electron 37.2](https://img.shields.io/badge/Electron-37.2-47848F.svg)](https://www.electronjs.org/)
[![Node ≥ 22](https://img.shields.io/badge/Node-%E2%89%A5%2022-339933.svg)](https://nodejs.org/)
[![TypeScript 5.7](https://img.shields.io/badge/TypeScript-5.7-3178C6.svg)](https://www.typescriptlang.org/)
[![Platform](https://img.shields.io/badge/platform-Windows%20first-lightgrey.svg)]()

</div>

## 这是什么

`dsh-desktop` 是一层**薄壳**：不重写任何 UI、不 fork 前端、不替代任何插件机制。它只做两件事——

1. 在 Electron main 进程里，用 `@deepseek-ai/dsh-app-boot` 的公开 API boot 出与
   `dsh --profile web` **完全相同**的 Cordis 树：同一 bundle 层、同一 patch 层、
   同一 `--patch` overlay、同一 agent-preset 根、同一 telemetry 开关、同一 patch 热更新；
2. 让一个 sandbox 渲染进程加载原装 `@deepseek-ai/dsh-web-frontend` dist，指向
   `http://127.0.0.1:<随机端口>`。

因此网页端的**全部功能与全部拓展能力**原样保留——它们都属于 DSH 本体，壳一行都没碰。

## ✨ 特性

| | |
|---|---|
| 🪟 **原生桌面窗口** | Electron 窗口承载 DSH 完整 Web 界面，支持托盘驻留、开机最大化 |
| 🧩 **100% 插件兼容** | `dsh plugin add`、patch 层、agent presets、client-plugin HMR、原生目录选择器全部保留 |
| 🎨 **主题精修** | 走官方 `ThemeRuntime.overrideTokens` 扩展点，深浅色双套 token + Windows 原生字体栈 |
| 🖱️ **自绘标题栏** | frameless + Window Controls Overlay，标题栏颜色跟随明暗主题实时切换 |
| 🛟 **启动自救** | 插件炸了自动进入 GUI 插件管理器：禁用元凶或安全模式启动 |
| 🔄 **核心更新检查** | 启动自动 + 托盘手动检查 DSH 核心（npm 为准），提示后确认才更新 |
| 📦 **一键打包** | `electron-builder --win` 产出 Windows 安装包，原生模块免重建 |

<!-- 在此添加截图：![主界面](docs/screenshot.png) -->

## 目录

- [快速开始](#快速开始)
- [架构](#架构)
- [命令行参数](#命令行参数)
- [插件与扩展](#插件与扩展)
- [主题精修](#主题精修)
- [自绘标题栏](#自绘标题栏)
- [启动自救](#启动自救)
- [打包](#打包)
- [已验证矩阵](#已验证矩阵)
- [已知局限](#已知局限)
- [License](#license)

## 快速开始

前置：**Node ≥ 22**、npm。（打包时需要 VS Build Tools，见[打包](#打包)。）

```powershell
npm install
npm run make-icon          # 生成 assets/icon.png（托盘 / 打包图标）
npm run smoke              # 纯 Node 冒烟：boot 整树 → 校验 HTTP 面 → dispose
npm start                  # 打开桌面窗口（开发模式）
```

Electron 冒烟（验证进程内树在 Electron ABI 下完整启动）：

```powershell
npm run smoke:electron
```

> **注意**：若执行过 `npm run rebuild:pty`（把 node-pty 重建为 Electron ABI），
> 纯 Node 冒烟会因 ABI 不匹配失败；用 `npm rebuild node-pty` 可切回 Node ABI。
> 两者是互斥的单份 `node_modules` 状态，开发时按需切换。

## 架构

```
Electron main（Node 22，进程内）
 ├─ Cordis host 树 = web profile
 │    （dsh-base + dsh-web-app + $DSH_HOME 两层 patch + --patch）
 │    ├─ host-webserver @ 127.0.0.1:<OS 随机端口>
 │    │     ├─ /api                  ← fetch / WebSocket（网关）
 │    │     └─ /plugins/*/client.js  ← 客户端插件包
 │    ├─ client-modules → 注入 window.__DSH_BOOT__
 │    └─ storage / session / llm / tools / sandbox / agent-presets / …
 │        （与 CLI 完全一致）
 └─ BrowserWindow（sandbox 渲染进程，原装 dist，无 nodeIntegration）
       ├─ 客户端 Cordis 树 ← 与浏览器版同一份代码
       ├─ preload 只暴露 dshDesktop 桥（标题栏颜色回传 + frameless 标记）
       └─ dsh-desktop-polish 客户端插件（主题精修，可选）
```

### 进程内 boot 的关键决策

| 决策 | 说明 |
|---|---|
| **安装锚点 = `@deepseek-ai/dsh`** | 与 CLI 完全一致，`healProfilesModuleFallback` 重建的扁平 fallback（`$DSH_HOME/profiles/node_modules`）逐包相同，新增插件的 peer 依赖解析路径不变 |
| **`--port 0`** | 随机端口，从根上消灭 3080 冲突；`web-runtime` 把实际端口写进 `DSH_WEB_URL` 与 URL 行 |
| **失败诊断** | `installFailLoud` 的 stderr/exit 接入壳的日志与退出路径；GUI 启动失败弹窗并指向日志（`<userData>/logs/desktop-YYYYMMDD.log`） |
| **优雅退出** | `before-quit` → 树 dispose（5 秒兜底）→ `app.exit`，镜像 CLI 的 bounded shutdown |

### 原生模块与 ABI

| 模块 | 使用方 | Electron 兼容性 |
|---|---|---|
| `node-addon-require-builtin` | cordis-plugin-loader | ✅ N-API（免重建） |
| `koffi` | sandbox ACL / fs / 目录选择器 | ✅ N-API |
| `sharp` | attachment 缩略图 | ✅ N-API（0.33+） |
| `node-pty` | dsh-subprocess-local | ✅ N-API（1.1.0 起基于 node-addon-api，免重建） |

web 树内的全部原生模块都是 N-API，Node 与 Electron 双兼容，**无需重建**
（`npm run rebuild:pty` 保留为通用工具，仅当某新增插件带非 N-API 原生 addon 时才需要）。
遇到这种插件：对 profile 的 `node_modules` 跑 `electron-rebuild`，或用 `--backend child`
回退到系统 Node（此时原生模块按 Node ABI 正常加载）。

## 命令行参数

| 参数 | 说明 |
|---|---|
| `--smoke` | boot + HTTP 校验 + 输出 JSON + 退出（0 通过 / 3 失败） |
| `--backend child` | 用系统 Node 以子进程方式跑 dsh CLI（回退模式） |
| `--home <dir>` | `DSH_HOME` 覆盖 |
| `--user-data <dir>` | Electron userData 覆盖（日志在其下 `logs/`） |
| `--cwd <dir>` | 树的启动目录（默认用户主目录） |
| `--port <n>` | 固定端口（默认 0 = 系统随机分配） |
| `--no-tray` | 关闭托盘 |
| `--quit-on-close` | 关窗即退出（默认关窗隐藏到托盘） |
| `--safe` | 安全模式启动（跳过全部用户补丁层） |
| `--plugin-manager` | 直接打开插件管理器 |
| `--headless` | 无头启动失败诊断（打印 `RECOVERY-JSON` 后退出） |
| `--no-check-update` | 关闭启动时的 DSH 核心更新自动检查 |
| `--update-probe` | 无头跑一次更新检查并打印 `UPDATE-PROBE-JSON` 后退出 |

## 插件与扩展

安装（`dsh plugin add`）、组合（bundle reconcile）、解析（双锚点 + 扁平 fallback）、
扫描（`dsh.client` 花名册）、服务（`/plugins/<id>/client.js`）五个环节全部复用
DSH 本体，桌面壳只消费 boot 结果。已有插件与新增插件均与浏览器版行为一致；唯一例外
见上文「非 N-API 原生 addon」。

## 主题精修

`plugins/dsh-desktop-polish` 是一个纯 client 插件（node 半边为空 apply），走官方
`ThemeRuntime.overrideTokens` 扩展点覆盖 `--dsw-alias-*` 语义 token（浅色/深色各一套），
并注入一层 CSS（Windows 原生字体栈 `Segoe UI Variable` + 渲染优化）：

- 品牌强调：主按钮纯黑/纯白 → 墨蓝 slate-indigo；
- 表面层次：浅色模式面板/浮层获得轻柔层级；
- 交互悬停：灰黑 → 淡墨蓝。

安装（profile 级，桌面壳与浏览器版同时生效）：

```powershell
dsh plugin --profile web add ./plugins/dsh-desktop-polish
# 然后在 $DSH_HOME/profiles/web/cordis.patch.yml 里加：
# - insert:
#     - id: dsh-desktop-polish
#       name: dsh-desktop-polish
```

**迭代即改即生效**：插件以 pnpm link 方式挂进 profile，直接编辑
`plugins/dsh-desktop-polish/client.js` 保存后，patch 热更新 + client 插件图重载会让
运行中的窗口立即套用新 token——无需重启、无需重新构建前端。

壳层观感（`src/main/main.ts`）：启动底色跟随系统主题防白闪、窗口渐显（约 120ms）、
新图标（墨蓝渐变 + 对话气泡，`npm run make-icon` 重新生成）；Windows/Linux 上移除了
Electron 默认菜单栏（File/Edit/View/…）及其快捷键（Ctrl+R/F12 等），窗口只剩纯 UI，
macOS 保留最小默认菜单。

## 自绘标题栏

窗口为 frameless + `titleBarStyle: "hidden"` + Window Controls Overlay（原生最小化/
最大化/关闭按钮叠加在页面上，保留 Win11 贴靠布局等原生行为）。顶部 40px 标题栏由
**壳**注入（`src/main/titlebar.ts`，dom-ready 时 `executeJavaScript`）：

- 颜色直接取 `--dsw-alias-bg-base` / `--dsw-alias-label-secondary` / `--dsw-alias-border-l1`
  等语义 token，跟随明暗主题自动切换；文字实时跟随 `document.title`；
- `-webkit-app-region: drag`：整条可拖动、双击最大化；
- 壳把计算后的主题色经 `window.dshDesktop.setTitleBarColors(bg, fg)` 回传主进程
  （preload 桥），主进程据此设置原生按钮的 `symbolColor` 与窗口底色，保证按钮与主题同步；
- 主进程 `TITLEBAR_HEIGHT` 与插件 `--dsh-desktop-titlebar-height` 必须一致（现为 40）；
  可用 `--probe` 无头校验几何参数，`--tb-mode` 切换窗口配置变体（当前默认 d）。

> 注意：此 Electron 版本（37.x）中，仅 `frame:false` **不**启用 WCO（报
> “Titlebar overlay is not enabled”），必须同时设置 `titleBarStyle:"hidden"`。

标题栏归壳管、不属于任何客户端插件——即使全部用户插件加载失败，窗口和标题栏依然可用。

## 启动自救

插件故障分两类，各有对策：

1. **客户端插件 bundle 加载失败**：内核本就非致命——页面顶部显示 “Failed to load plugins”
   横幅，App 照常运行（标题栏不受影响，因为它归壳管）。
2. **node 侧插件让整树 boot 失败**（最常见：补丁里插了装不上/写坏的插件）：见下。

### 恢复对话框

启动失败时弹出，四个选择：

| 选项 | 说明 |
|---|---|
| **重试** | 可能只是暂时性问题 |
| **安全模式启动** | `--safe` 重启，跳过全部用户补丁层（profile + home 两层 patch），只加载内置 bundle；标题栏标注 “Safe Mode”，内置功能完整 |
| **打开补丁文件** | 用系统编辑器打开 `$DSH_HOME/profiles/web/cordis.patch.yml`，手动注释掉出错的 insert 行，回来点重试 |
| **退出** | 直接退出 |

- 安全模式实现：`boot.ts` 的 `safe` 选项让 `loadProfile` 以 `userLayer:false` 加载、
  home patch 置空、热重载停用（`composeLive` 同步缩减，保证热更新组合与实际加载一致）。
- boot 另有 **60s 看门狗**：卡死超时同样进入恢复流程。
- 命令行等效：`electron . --safe`；无头自动化用 `--headless`（打印 `RECOVERY-JSON`
  后退出，便于 CI/诊断）。

### 插件管理器（GUI）

**启动失败时管理器直接弹出**（不经过对话框）：自动高亮元凶插件，窗口内提供
「安全模式启动」「应用并重试启动」；关闭窗口后才出现恢复对话框兜底。平时也可从托盘
菜单的**插件管理器…**或 `--plugin-manager` 随时打开：

- 列出两份用户补丁（`profiles/web/cordis.patch.yml` 与 `cordis.patch.yml`）里的全部
  插件：名称、id、来源、insert 行/独立行、启用状态；
- **自动高亮启动失败的元凶**（从 boot 错误里解析 `failed to import loader entry <id> (<name>)`），
  顶部横幅直接提示「禁用它然后重启」；
- 每行一个**禁用/启用**开关：禁用 = 向补丁文件追加一行 `- { id: "...", disabled: true }`
  （幂等、不重写文件、注释原样保留），启用 = 精确删除该行；改动即时生效（运行中的树通过
  补丁热更新感知）；
- **应用并重启**一键重启（恢复场景下自动去掉 `--safe` 重试完整启动）；
- 补丁文件解析失败（手改坏的 YAML）会以红色错误行提示，可一键打开文件修复。

实现：`src/main/patch-ops.ts`（纯文件操作，含 `!!js` 占位 schema，node 单测
`scripts/pm-ops-test.mjs`）+ `src/main/plugin-manager.ts`（窗口 + `pm:*` IPC + 本地
http 页；本环境 `data:`/`file:` 加载被拦截，http 是唯一通道）。无头演练 `--pm-probe`：
破坏补丁 → 管理器识别元凶 → IPC 禁用 → 普通启动成功，全链路自动化验证。

## DSH 核心更新

壳可以检查 DSH 核心（`@deepseek-ai/dsh` 等 npm 包）是否有新版本，**只提示、确认后才更新，绝不强制**：

- **版本源以 npm 为准**：读 `@deepseek-ai/dsh` 在 registry 的 `latest` dist-tag（可安装的权威源）；
  deepseek-harness 仓库 `master` 分支的 `apps/cli` 版本仅作对照展示（可能落后于 npm）。
- **触发**：启动时自动静默检查（有新版本才弹窗）+ 托盘菜单「检查 DSH 核心更新…」手动检查。
- **UI**：一个与插件管理器同款观感的无边框小窗口，显示 当前版本 / 最新版本 / master 分支，
  有「更新」「稍后」按钮。
- **更新动作**：确认后运行 `npm install @deepseek-ai/dsh@<latest> @deepseek-ai/dsh-app-boot@<latest>`
  再提示「重启以生效」。仅 **dev 源码模式**支持就地更新；打包版按钮会提示重新安装安装包
  （完整自动更新属 Phase 2）。
- **关闭自动检查**：`--no-check-update`；无头诊断用 `--update-probe`。

实现：`src/main/update-check.ts`（Electron-free：读已装版本 + 查 registry + 语义版本比较，可
用纯 Node 冒烟）+ `src/main/updater.ts`（窗口 + `upd:*` IPC + npm 更新动作）。

## 打包

```powershell
npm run dist    # electron-builder --win → release/
```

关键配置（`electron-builder.yml`）：

- **`asar: false`** —— `healProfilesModuleFallback` 会把 `$DSH_HOME/profiles/node_modules`
  以 junction 链接到真实依赖目录，而 junction 目标、原生模块与 `worker_threads` 都不能
  存在于 asar 归档内；因此全部以真实文件落盘（`resources/app`）。
- **全部原生模块为 N-API** → `npmRebuild: false`。
- **`electronDist: node_modules/electron/dist`** —— 复用本地已下载的 Electron，避免打包机
  重复下载（离线/受限网络环境适用；正常机器可删掉此行使用默认下载）。

### 封闭打包运行时的模块解析

打包后配置树在用户目录、依赖树在应用目录，两者之间的桥就是 junction 层。壳在 boot 时做了
三层处理：

1. **`bareModuleBaseUrl`**：把应用自身的 `node_modules` 作为裸包名的解析基座传给
   `boot()`（上游 `dsh-app-boot` 为封闭打包运行时预留的接口），host 侧插件导入不依赖 junction；
2. **`NODE_PATH` + `Module._initPaths()`**：client 插件花名册扫描走 `createRequire(profileDir)`
   的 CJS 解析，`NODE_PATH` 指向应用 `node_modules` 让它同样不依赖 junction（`_initPaths`
   是因为打包运行时早已缓存过全局路径）；
3. **junction heal 降级为 best-effort**：正常机器上 heal 照常成功（与 CLI 行为一致，510 个
   junction 覆盖完整依赖闭包）；heal 失败时（受限环境/杀软）自动钉住 directory-picker 原生
   后端、禁用 patch 热更新并打印警告，树仍可用。

## 已验证矩阵

| 验证 | 结果 |
|---|---|
| 纯 Node 冒烟（`npm run smoke`） | ✅ 133 宿主条目 / 38 客户端插件 / 1.6s boot |
| Electron dev 冒烟（`npm run smoke:electron`） | ✅ 同上，Electron 37.2 / Node 22.17 |
| 子进程回退冒烟（`--backend child`） | ✅ 捕获 CLI URL 行，38 插件照常服务 |
| GUI 窗口启动 | ✅ 日志确认 `[boot] web tree settled`，窗口加载 |
| 打包产物冒烟（junction 正常路径） | ✅ 133 / 38 全绿，无警告 |
| 打包产物冒烟（junction 被禁的退化模式） | ✅ 131 / 37 + 2 条降级警告，功能面完整 |

> 注：「退化模式」行是作者测试沙箱（会拦截未知进程创建 junction）的实测结果；普通用户机器
> 无此限制，heal 正常执行，走 133/38 的正常路径。

## 数据与目录

壳的运行数据分三类，落在三处互不重叠的目录：

### 1. DSH_HOME —— 会话 / 设置 / 插件（DSH 本体数据）

默认 `~/.dsh`（Windows：`C:\Users\<你>\.dsh`），可用 `--home <dir>` 覆盖。这是 DSH 本体的数据根，与 CLI **完全共享**：

```
~/.dsh/
├─ settings.yaml              # 全局设置
├─ .credentials.yaml          # 凭据（密钥，勿提交 / 外传）
├─ cordis.patch.yml           # home 级用户补丁（未启用过 home 补丁则不存在）
├─ storages/                  # 会话、存储等 DSH 持久化数据
└─ profiles/
   ├─ node_modules/           # heal 出的扁平模块 fallback（junction，自动重建）
   └─ web/                    # web profile
      ├─ cordis.yml           # profile 根配置（空 entry 列表，勿手改）
      ├─ cordis.patch.yml     # profile 级用户补丁（插件 insert / 禁用行）
      ├─ package.json         # profile 包清单（dsh plugin add 写入）
      ├─ pnpm-lock.yaml / pnpm-workspace.yaml
      └─ node_modules/        # profile 内安装的插件依赖
```

- **插件补丁**：插件管理器（`--plugin-manager`）读写的就是 `profiles/web/cordis.patch.yml`
  与 home 级 `cordis.patch.yml`。
- **换壳不换数据**：会话、设置、凭据都在这里，桌面壳与浏览器版 / CLI 同源。

### 2. Electron userData —— 壳自身日志与缓存

默认 `%APPDATA%\dsh-desktop`（开发模式；打包后为 `%APPDATA%\DSH Desktop`），可用
`--user-data <dir>` 覆盖：

```
<userData>/
├─ logs/desktop-YYYYMMDD.log  # 壳 + 树全部日志（启动失败时看这里）
└─ Cache / Code Cache / Local Storage / …   # Electron 浏览器缓存（可随时清）
```

### 3. 项目目录 —— 源码 / 构建 / 打包产物

```
dsh-desktop/
├─ src/            # 源码（tsc → dist/）
├─ dist/           # 编译产物（npm run build 生成，勿手改）
├─ plugins/        # 自带客户端插件（dsh-desktop-polish）
├─ assets/         # 图标（npm run make-icon 重新生成）
├─ scripts/        # 冒烟 / 单测 / 图标生成脚本
├─ release/        # electron-builder 打包产物（npm run dist 生成）
└─ node_modules/   # 依赖（npm install 安装）
```

> **开发隔离**：本仓库开发时用 `--home .dsh-run-home --user-data .electron-userdata` 把运行数据
> 钉在项目内（均已 .gitignore），避免污染真实 `~/.dsh`；纯 Node 冒烟则用 `.dsh-smoke-home`
> 作为独立 DSH_HOME。

## 已知局限（Phase 1）

- 本地 HTTP 端点仍在（`127.0.0.1` 随机端口），信任面与浏览器版相同；Phase 2 用 `file://` + IPC 桥移除端口。
- 壳自身 UI（窗口/托盘）暂不在插件树内；Phase 3 以 `dsh.desktop` 双面包并入。
- 无自动更新、无签名/公证；`dsh plugin` 依赖 pnpm（与 CLI 相同）。
- 壳与 CLI 共享 `$DSH_HOME`（会话/设置/插件同源，这是设计目标）。

## License

[MIT](LICENSE) © 2026 q2224273481-afk
