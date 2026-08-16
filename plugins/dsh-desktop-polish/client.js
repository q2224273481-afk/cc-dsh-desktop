// dsh-desktop-polish — 桌面精修主题层（现代圆润、克制）。
// Client bundle protocol: self-register through window.__ModuleLoader__.load
// (the kernel adopts the module table entry; a plain ESM module is not a plugin).
//
// 只做主题：官方扩展点 ThemeRuntime.overrideTokens 覆盖 --dsw-alias-* 语义
// token，另注入一层 CSS 处理字体等非 token 细节。窗口标题栏不属于本插件——
// 它由桌面壳（主进程 titlebar.ts）注入，即使本插件加载失败窗口依然完整可用。

window.__ModuleLoader__.load({
	id: "dsh-desktop-polish",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const name = "dsh-desktop-polish";
		const inject = ["theme"];

		const TOKENS = {
			"--dsw-alias-brand-primary": {
				light: "rgb(45, 58, 97)",
				dark: "rgb(240, 243, 249)"
			},
			"--dsw-alias-button-primary-fill": {
				light: "rgb(45, 58, 97)",
				dark: "rgb(240, 243, 249)"
			},
			"--dsw-alias-button-primary-hover": {
				light: "rgb(63, 79, 125)",
				dark: "rgb(255, 255, 255)"
			},
			"--dsw-alias-button-primary-dimmed": {
				light: "rgb(228, 233, 244)",
				dark: "rgb(53, 62, 80)"
			},
			"--dsw-alias-brand-primary-new-colorprimary-new-color": {
				light: "rgb(65, 118, 230)",
				dark: "rgb(103, 158, 254)"
			},
			"--dsw-alias-bg-layer-2": {
				light: "rgb(249, 250, 251)",
				dark: "rgb(35, 35, 36)"
			},
			"--dsw-alias-bg-layer-3": {
				light: "rgb(241, 243, 245)",
				dark: "rgb(44, 44, 46)"
			},
			"--dsw-alias-bg-overlay": {
				light: "rgb(235, 238, 242)",
				dark: "rgb(53, 54, 56)"
			},
			"--dsw-alias-bg-multi-select": {
				light: "rgb(249, 250, 251)",
				dark: "rgb(35, 35, 36)"
			},
			"--dsw-alias-interactive-bg-hover": {
				light: "rgba(45, 58, 97, 0.05)",
				dark: "rgba(255, 255, 255, 0.05)"
			},
			"--dsw-alias-interactive-bg-hover-accent": {
				light: "rgba(45, 58, 97, 0.1)",
				dark: "rgba(255, 255, 255, 0.1)"
			},
			"--dsw-alias-interactive-bg-active": {
				light: "rgba(45, 58, 97, 0.08)",
				dark: "rgba(255, 255, 255, 0.08)"
			}
		};

		const CSS = [
			"body, body[data-ds-dark-theme] {",
			"  --dsw-font-family: 'Segoe UI Variable Text', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', system-ui, sans-serif;",
			"}",
			"body { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }"
		].join("\n");

		function apply(ctx) {
			const disposeTokens = ctx.theme.overrideTokens("dsh-desktop-polish", TOKENS);
			const style = document.createElement("style");
			style.id = "dsh-desktop-polish-style";
			style.textContent = CSS;
			document.head.append(style);
			return () => {
				style.remove();
				disposeTokens();
			};
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
