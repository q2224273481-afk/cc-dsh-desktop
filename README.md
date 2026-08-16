# dsh-desktop

DSH 桌面壳（Phase 1）：Electron 窗口 + **进程内** boot 的 `dsh web` profile。

薄壳原则：不重写任何 UI、不 fork 前端、不替代任何插件机制。桌面壳做的事只有两件——

1. 在 Electron main 进程里用 `@deepseek-ai/dsh-app-boot` 的公开 API boot 出与
   `dsh --profile web` **完全相同**的 Cordis 树（镜像 CLI 的 `runProfile`：同一
   bundle 层、同一 patch 层、同一 `--patch` overlay、同一 agent-preset 根、同一
   telemetry 开关、同一 patch 热更新）；
2. 让一个 sandbox 渲染进程加载原装 `@deepseek-ai/dsh-web-frontend` dist，指向
   `http://127.0.0.1:<随机端口>`。

因此网页端全部功能与全部拓展能力（`dsh plugin add`、patch 层、agent presets、
client-plugin HMR、原生目录选择器自动判定）原样保留——它们都属于 DSH 本体，壳
一行都没碰。

## 架构

```
Electron main（Node 22，进程内）
 ├─ Cordis host 树 = web profile（dsh-base + dsh-web-app + $DSH_HOME 两层 patch + --patch）
 │    ├─ host-webserver @ 127.0.0.1:<OS 随机端口>
 │    │     ├─ /api            ← fetch/WebSocket（网关）
 │    │     └─ /plugins/*/client.js ← 客户端插件包
 │    ├─ client-modules → 注入 window.__DSH_BOOT__
 │    └─ storage/session/llm/tools/sandbox/agent-presets/…（与 CLI 完全一致）
 └─ BrowserWindow（sandbox 渲染进程，原装 dist，无 nodeIntegration；
        preload 只暴露 dshDesktop 桥：标题栏颜色回传 + frameless 标记）
       └─ 客户端 Cordis 树 ← 与浏览器版同一份代码
       └─ dsh-desktop-polish 客户端插件：精修主题 token + 自绘标题栏
```

## 快速开始

前置：Node ≥ 22、npm。（打包时需要 VS Build Tools，见下文。）

```powershell
npm install
npm run make-icon          # 生成 assets/icon.png（托盘/打包图标）
npm run smoke              # 纯 Node 冒烟：boot 整树 → 验证 HTTP 面 → dispose
npm start                  # 桌面窗口（开发模式）
```

Electron 冒烟（验证进程内树在 Electron ABI 下完整启动）：

```powershell
npm run smoke:electron
```

> 注意：若已经执行过 `npm run rebuild:pty`（node-pty 重建为 Electron ABI），
> 纯 Node 冒烟会因 ABI 不匹配失败；用 `npm rebuild node-pty` 可切回 Node ABI。
> 两者是互斥的单份 node_modules 状态，开发时按需切换。

## 壳自身参数

| 参数 | 说明 |
|---|---|
| `--smoke` | boot + HTTP 校验 + 输出 JSON + 退出（0 通过 / 3 失败） |
| `--backend child` | 用系统 Node 以子进程方式跑 dsh CLI（回退模式） |
| `--home <dir>` | DSH_HOME 覆盖 |
| `--user-data <dir>` | Electron userData 覆盖（日志在其下 logs/） |
| `--cwd <dir>` | 树的启动目录（默认用户主目录） |
| `--port <n>` | 固定端口（默认 0 = 系统随机分配） |
| `--no-tray` | 关闭托盘 |
| `--quit-on-close` | 关窗即退出（默认关窗隐藏到托盘） |

## 进程内 boot 的关键决策

- **安装锚点 = `@deepseek-ai/dsh` 包**：与 CLI 完全一致，`healProfilesModuleFallback`
  重建的扁平模块 fallback（`$DSH_HOME/profiles/node_modules`）逐包相同，新增插件的
  peer 依赖解析路径不变。
- **`--port 0`**：随机端口，从根上消灭 3080 冲突；`web-runtime` 把实际端口写进
  `DSH_WEB_URL` 与 URL 行。
- **失败诊断**：`installFailLoud` 的 stderr/exit 接壳的日志文件与退出路径；
  GUI 启动失败弹错误框并指向日志文件（`<userData>/logs/desktop-YYYYMMDD.log`）。
- **优雅退出**：`before-quit` → 树 dispose（5 秒兜底）→ `app.exit`，镜像 CLI 的
  bounded shutdown。

## 原生模块与 ABI

| 模块 | 使用方 | Electron 兼容性 |
|---|---|---|
| `node-addon-require-builtin` | cordis-plugin-loader | ✅ N-API（免重建） |
| `koffi` | sandbox ACL / fs / 目录选择器 | ✅ N-API |
| `sharp` | attachment 缩略图 | ✅ N-API（0.33+） |
| `node-pty` | dsh-subprocess-local | ✅ N-API（1.1.0 起基于 node-addon-api，免重建） |

当前 web 树内的全部原生模块（loader helper、koffi、sharp、node-pty 1.1+）都是
N-API，Node 与 Electron 双兼容，**无需任何重建**（`npm run rebuild:pty` 保留为
通用工具，仅当某个新增插件带非 N-API 原生 addon 时才需要）。若出现这种插件：
装进 profile 目录后是 Node ABI 构建，in-process 模式会 load 失败——对策：
`electron-rebuild` 针对 profile 的 node_modules 重建，或 `--backend child`
回退到系统 Node（此时一切原生模块按 Node ABI 正常加载）。

## 插件与扩展兼容性

安装（`dsh plugin add`）、组合（bundle reconcile）、解析（双锚点 + 扁平 fallback）、
扫描（`dsh.client` 花名册）、服务（`/plugins/<id>/client.js`）五个环节全部复用
DSH 本体，桌面壳只消费 boot 结果。已有插件与新增插件均与浏览器版行为一致；
唯一例外见上节"非 N-API 原生 addon"。

## 打包

```powershell
npm run dist    # electron-builder --win → release/
```

关键配置（electron-builder.yml）：**`asar: false`**——
`healProfilesModuleFallback` 会把 `$DSH_HOME/profiles/node_modules` 以 junction
链接到真实依赖目录，而 junction 目标、原生模块与 worker_threads 都不能存在于
asar 归档内；因此全部以真实文件落盘（`resources/app`），这也是 Electron 官方
文档警告的 asar 不适用场景。全部原生模块为 N-API，`npmRebuild: false`。
`electronDist: node_modules/electron/dist` 复用本地已下载的 Electron，避免
打包机重复下载（离线/受限网络环境适用；正常机器可删掉此行走默认下载）。

## 封闭打包运行时的模块解析（bareModuleBaseUrl / 退化模式）

打包后配置树在用户目录、依赖树在应用目录，两者之间的桥就是 junction 层。
壳在 boot 时做了三层处理：

1. **`bareModuleBaseUrl`**：把应用自身的 `node_modules` 作为裸包名的解析基座
   传给 `boot()`（上游 `dsh-app-boot` 为封闭打包运行时预留的接口），host 侧
   插件导入不依赖 junction。
2. **`NODE_PATH` + `Module._initPaths()`**：client 插件花名册扫描走
   `createRequire(profileDir)` 的 CJS 解析，NODE_PATH 指向应用 node_modules
   让它同样不依赖 junction（`_initPaths` 是因为打包运行时早已缓存过全局路径）。
3. **junction heal 降级为 best-effort**：正常机器上 heal 照常成功（与 CLI 行为
   完全一致，510 个 junction 覆盖完整依赖闭包）；heal 失败时（受限环境/杀软）
   自动钉住 directory-picker 原生后端、禁用 patch 热更新并打印警告，树仍可用。

## 已验证矩阵（本仓库实测）

| 验证 | 结果 |
|---|---|
| 纯 Node 冒烟（`npm run smoke`） | ✅ 133 宿主条目 / 38 客户端插件 / 1.6s boot |
| Electron dev 冒烟（`npm run smoke:electron`） | ✅ 同上，Electron 37.2 / Node 22.17 |
| 子进程回退冒烟（`--backend child`） | ✅ 捕获 CLI URL 行，38 插件照常服务 |
| GUI 窗口启动 | ✅ 日志确认 `[boot] web tree settled`，窗口加载 |
| 打包产物冒烟（junction 正常路径） | ✅ 133 / 38 全绿，无警告 |
| 打包产物冒烟（junction 被禁的退化模式） | ✅ 131 / 37 + 2 条降级警告，功能面完整 |

> 注：本沙箱环境会拒绝「未知二进制」进程树创建 junction（安全监控），打包 exe
> 的 heal 因此走退化路径；用户机器无此监控，heal 正常执行，走 133/38 的正常路径。

## 桌面精修主题（dsh-desktop-polish）

`plugins/dsh-desktop-polish` 是一个纯 client 插件（node 半边为空 apply），走官方
`ThemeRuntime.overrideTokens` 扩展点覆盖 `--dsw-alias-*` 语义 token（浅色/深色各一套）
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
`plugins/dsh-desktop-polish/client.js` 保存后，patch 热更新 + client 插件图重载会
让运行中的窗口立即套用新 token——无需重启、无需重新构建前端。

壳层观感（`src/main/main.ts`）：启动底色跟随系统主题防白闪、窗口渐显（约 120ms）、
新图标（墨蓝渐变 + 对话气泡，`npm run make-icon` 重新生成）；Windows/Linux 上移除了
Electron 默认菜单栏（File/Edit/View/…）及其快捷键（Ctrl+R/F12 等），窗口只剩纯 UI，
macOS 保留最小默认菜单。

## 自绘标题栏（Windows）

窗口为 frameless + `titleBarStyle: "hidden"` + Window Controls Overlay（原生
最小化/最大化/关闭按钮叠加在页面上，保留 Win11 贴靠布局等原生行为）。顶部的 40px
标题栏由 `dsh-desktop-polish` 客户端插件注入：

- 颜色直接取 `--dsw-alias-bg-base` / `--dsw-alias-label-secondary` / `--dsw-alias-border-l1`
  等语义 token，跟随明暗主题自动切换；文字实时跟随 `document.title`；
- `-webkit-app-region: drag`：整条可拖动、双击最大化；
- 插件把计算后的主题色经 `window.dshDesktop.setTitleBarColors(bg, fg)` 回传主进程
  （preload 桥），主进程据此设置原生按钮的 `symbolColor` 与窗口底色，保证按钮与主题同步；
- 主进程 `TITLEBAR_HEIGHT` 与插件 `--dsh-desktop-titlebar-height` 必须一致（现为 40）；
  可用 `--probe` 无头校验几何参数，`--tb-mode` 切换窗口配置变体（当前默认 d）。

注意：此 Electron 版本（37.x）中，仅 `frame:false` 不启用 WCO（报
“Titlebar overlay is not enabled”），必须同时设置 `titleBarStyle:"hidden"`。

标题栏由**壳**注入（`src/main/titlebar.ts`，dom-ready 时 executeJavaScript），
不属于任何客户端插件——即使全部用户插件加载失败，窗口和标题栏依然可用。

## 启动自救（插件炸了怎么办）

插件故障分两类，各有对策：

1. **客户端插件 bundle 加载失败**：内核本就非致命——页面顶部显示
   “Failed to load plugins” 横幅，App 照常运行（标题栏也不受影响，因为它归壳管）。
2. **node 侧插件让整树 boot 失败**（最常见：补丁里插了装不上/写坏的插件）：
   - 启动失败时弹出**恢复对话框**，四个选择：
     - **重试** —— 可能只是暂时性问题；
     - **安全模式启动** —— 以 `--safe` 重启，跳过全部用户补丁层
       （profile + home 两层 patch），只加载内置 bundle；标题栏标注
       “Safe Mode”。用户插件都不在，内置功能完整；
     - **打开补丁文件** —— 直接用系统编辑器打开
       `$DSH_HOME/profiles/web/cordis.patch.yml`，手动注释掉出错的
       insert 行，回来点重试；
     - **退出**。
   - 安全模式实现：`boot.ts` 的 `safe` 选项让 `loadProfile` 以
     `userLayer:false` 加载、home patch 置空、热重载停用（`composeLive`
     同步缩减，保证热更新组合与实际加载一致）。
   - boot 另有 **60s 看门狗**：卡死超时同样进入恢复流程。
   - 命令行等效：`electron . --safe`；无头自动化用 `--headless`（打印
     `RECOVERY-JSON` 后退出，便于 CI/诊断）。

已演练验证：向补丁塞入不存在的插件 → 启动失败并精确报出包名 →
`--safe` 正常启动（标题栏/窗口完整，仅主题回退内置）。

### 插件自救管理器（GUI）

**启动失败时管理器直接弹出**（不经过对话框）：自动高亮元凶插件，窗口内
提供「安全模式启动」「应用并重试启动」；关闭窗口后才出现恢复对话框兜底
（重试 / 安全模式 / 重新打开管理器 / 打开补丁 / 退出）。平时也可从托盘
菜单的**插件管理器…**或 `--plugin-manager` 命令行参数随时打开：

- 列出两份用户补丁（`profiles/web/cordis.patch.yml` 与 `cordis.patch.yml`）
  里的全部插件：名称、id、来源、insert 行/独立行、启用状态；
- **自动高亮启动失败的元凶**（从 boot 错误里解析 `failed to import loader
  entry <id> (<name>)`），顶部横幅直接提示"禁用它然后重启"；
- 每行一个**禁用/启用**开关：禁用 = 向补丁文件追加一行
  `- { id: "...", disabled: true }`（幂等、不重写文件、注释原样保留），
  启用 = 精确删除该行；改动即时生效（运行中的树通过补丁热更新感知）；
- **应用并重启**一键重启（恢复场景下自动去掉 `--safe` 重试完整启动）；
- 补丁文件解析失败（手改坏的 YAML）会以红色错误行提示，可一键打开文件修复。

窗口与主窗口同一套观感（无边框 + WCO 原生按钮 + 自绘标题栏）。实现：
`src/main/patch-ops.ts`（纯文件操作，含 `!!js` 占位 schema，node 单测
`scripts/pm-ops-test.mjs`）+ `src/main/plugin-manager.ts`（窗口 + pm:*
IPC + 本地 http 页；本环境 data:/file: 加载被拦截，http 是唯一通道）。
无头演练 `--pm-probe`：破坏补丁 → 管理器识别元凶 → IPC 禁用 →
普通启动成功，全链路自动化验证。

## Phase 1 已知局限

- 本地 HTTP 端点仍在（127.0.0.1 随机端口），信任面与浏览器版相同；Phase 2 用
  `file://` + IPC 桥移除端口。
- 壳自身 UI（窗口/托盘）暂不在插件树内；Phase 3 以 `dsh.desktop` 双面包并入。
- 无自动更新、无签名/公证；`dsh plugin` 依赖 pnpm（与 CLI 相同）。
- 壳与 CLI 共享 `$DSH_HOME`（会话/设置/插件同源，这是设计目标）。