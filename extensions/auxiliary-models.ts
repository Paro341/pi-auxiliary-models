import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resizeImage, ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { formatError, resolveValidatedRole, resolveConfigPath } from "../lib/auxiliary-models-core.mjs";
import { prepareImage } from "../lib/auxiliary-models-image.mjs";
import { createAuxiliaryRunner } from "../lib/auxiliary-models-runner.mjs";
import { parseAuxArgs, buildModelCandidates, buildStatusText, formatImageOutOfRoot } from "../lib/auxiliary-models-command.mjs";

/** 阶段 3：/aux 快捷式 + 图片目录策略 + 状态条。路由决策一律走 core 的 resolveValidatedRole（单一事实源）。 */
export default function (pi: ExtensionAPI) {
	const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
	// 配置读写路径：用户目录 ~/.pi/agent 优先（生态一致、升级不丢），包目录兜底（新装）
	const configPath = resolveConfigPath(packageDir, process.env.PI_CODING_AGENT_DIR);
	const runner = createAuxiliaryRunner({ configPath });
	pi.on("turn_start", () => runner.resetTurnBudget());
	pi.on("session_start", async (_event, ctx) => {
		await runner.getConfig();
		lastCtx = ctx as any;
		footerTui = null;
		if ((ctx as any).hasUI && (ctx as any).ui?.setFooter) {
			// 安装自定义 footer：行1 pwd / 行2 stats / 行3 辅助模型 / 行4+ 其他扩展状态
			(ctx as any).ui.setFooter((tui: any, theme: any, footerData: any) => {
				footerTui = tui;
				footerTheme = theme;
				footerDataRef = footerData;
				return auxFooterComponent();
			});
		}
		// 两种情况都刷新辅助状态行缓存（自定义 footer 渲染时已可用）
		refreshWidget(ctx as any);
	});
	// v8 §6 刷新时机：model_select（set/cycle/restore）、配置保存后、辅助调用结束后
	pi.on("model_select", (_event, ctx) => { refreshWidget(ctx as any); });
	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName === "auxiliary_extract" || event.toolName === "auxiliary_vision_describe") refreshWidget(ctx as any);
	});

	const widgetKey = "auxiliary-models";

	/** 模块级：自定义 footer 组件（setFooter 一次创建，render 时读最新 ctx/footerData）。 */
	let customFooter: any = undefined;
	let footerTui: any = undefined;
	let footerTheme: any = undefined;
	let footerDataRef: any = undefined;

	/** ANSI 转义剥离后的可见宽度（东亚字符算 2 列）。 */
	function visibleWidth(text: string): number {
		const stripped = String(text).replace(/\x1b\[[0-9;]*m/g, "");
		let w = 0;
		for (const ch of stripped) {
			const cp = ch.codePointAt(0)!;
			// CJK/全角/EMOJI 等宽字符按 2 列计；其余按 1。
			if (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x1f900 && cp <= 0x1f9ff))) w += 2;
			else w += 1;
		}
		return w;
	}

	/** 按可见宽度截断（保留 ANSI 色彩，追加省略号）。 */
	function truncateToWidth(text: string, maxWidth: number, ellipsis = "…"): string {
		const stripped = String(text).replace(/\x1b\[[0-9;]*m/g, "");
		if (visibleWidth(stripped) <= maxWidth) return String(text);
		const ell = visibleWidth(ellipsis);
		let out = ""; let w = 0;
		for (const ch of stripped) {
			const cw = ch.codePointAt(0)! >= 0x1100 ? 2 : 1; // 简化：仅截断宽字符时用
			if (w + cw + ell > maxWidth) break;
			out += ch; w += cw;
			if (w + ell >= maxWidth) break;
		}
		return out + ellipsis;
	}

	/** 复刻 Pi 内置 footer 的 token 格式化。 */
	function formatTokens(count: number): string {
		if (count < 1000) return count.toString();
		if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
		if (count < 1000000) return `${Math.round(count / 1000)}k`;
		if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
		return `${Math.round(count / 1000000)}M`;
	}

	/** 复刻 Pi 内置 footer 的 cwd 展示（家目录替换为 ~）。 */
	function formatCwdForFooter(cwd: string, home: string | undefined): string {
		if (!home) return cwd;
		const resolvedCwd = resolve(cwd);
		const resolvedHome = resolve(home);
		const relativeToHome = relative(resolvedHome, resolvedCwd);
		const isInsideHome =
			relativeToHome === "" ||
			(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
		if (!isInsideHome) return cwd;
		return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
	}

	/**
	 * 自定义 footer 组件：4+ 行布局。
	 * 行1 pwd / 行2 stats+模型 / 行3 辅助模型状态 / 行4+ 其他扩展状态。
	 */
	function auxFooterComponent() {
		return {
			render(width: number): string[] {
				try {
					const lines: string[] = [];
					const ctx = lastCtx as any;
					if (ctx) {
						// 行1：pwd + branch + session
						const home = process.env.USERPROFILE || process.env.HOME;
						let pwd = formatCwdForFooter(ctx.sessionManager?.getCwd?.() ?? "", home);
						const branch = footerDataRef?.getGitBranch?.();
						if (branch) pwd = `${pwd} (${branch})`;
						const sessionName = ctx.sessionManager?.getSessionName?.();
						if (sessionName) pwd = `${pwd} • ${sessionName}`;
						lines.push(footerTheme?.fg("dim", pwd) ?? pwd);

						// 行2：stats + 右侧模型
						lines.push(buildStatsLine(ctx, width));

						// 行3：辅助模型状态（同步读缓存，避免异步竞态）
						lines.push(lastAuxLine ? truncateToWidth(lastAuxLine, width, footerTheme?.fg("dim", "…") ?? "…") : "");

						// 行4+：其他扩展状态（webui/imessage/未来），按 key 排序每行一个；
						// harness（⚡Optimized，来自 pi-deepseek-optimized 扩展）始终独立成行并排最底部，
						// 不与任何 URL/主状态合并。
						const statuses = footerDataRef?.getExtensionStatuses?.();
						if (statuses) {
							const entries = Array.from(statuses.entries()).filter(([key]) => key !== widgetKey);
							const asLines = entries.map(([key, text]) => ({
								key,
								text: String(text).replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim(),
							}));
							const withText = asLines.filter((l) => l.text);
							// harness 排最后（最底部），其余按 key 字母序
							const harnessLines = withText.filter((l) => l.key === "harness");
							const otherLines = withText.filter((l) => l.key !== "harness").sort((a, b) => a.key.localeCompare(b.key));
							for (const l of [...otherLines, ...harnessLines]) {
								lines.push(truncateToWidth(l.text, width, footerTheme?.fg("dim", "…") ?? "…"));
							}
						}
					}
					return lines;
				} catch { return []; }
			},
		};
	}

	/** 复刻 Pi 内置 footer 的 stats 行（↑↓R W CH $ 上下文% + 右侧模型+thinking 对齐）。 */
	function buildStatsLine(ctx: any, width: number): string {
		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		let latestCacheHitRate: number | undefined;
		for (const entry of entries) {
			if (entry?.type === "message" && entry?.message?.role === "assistant" && entry?.message?.usage) {
				totals.input += entry.message.usage.input ?? 0;
				totals.output += entry.message.usage.output ?? 0;
				totals.cacheRead += entry.message.usage.cacheRead ?? 0;
				totals.cacheWrite += entry.message.usage.cacheWrite ?? 0;
				totals.cost += entry.message.usage.cost?.total ?? 0;
				const promptTokens = (entry.message.usage.input ?? 0) + (entry.message.usage.cacheRead ?? 0) + (entry.message.usage.cacheWrite ?? 0);
				latestCacheHitRate = promptTokens > 0 ? ((entry.message.usage.cacheRead ?? 0) / promptTokens) * 100 : latestCacheHitRate;
			} else if (entry?.type === "message" && entry?.message?.role === "toolResult" && entry?.message?.usage) {
				totals.input += entry.message.usage.input ?? 0; totals.output += entry.message.usage.output ?? 0;
				totals.cacheRead += entry.message.usage.cacheRead ?? 0; totals.cacheWrite += entry.message.usage.cacheWrite ?? 0;
				totals.cost += entry.message.usage.cost?.total ?? 0;
			} else if ((entry?.type === "branch_summary" || entry?.type === "compaction") && entry?.usage) {
				totals.input += entry.usage.input ?? 0; totals.output += entry.usage.output ?? 0;
				totals.cacheRead += entry.usage.cacheRead ?? 0; totals.cacheWrite += entry.usage.cacheWrite ?? 0;
				totals.cost += entry.usage.cost?.total ?? 0;
			}
		}

		const parts: string[] = [];
		if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
		if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
		if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
		if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
		if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);

		const contextUsage = ctx.getContextUsage?.();
		const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const percent = contextUsage?.percent ?? 0;
		const percentStr = contextUsage?.percent !== null && contextUsage?.percent !== undefined
			? `${percent.toFixed(1)}%`
			: "?";
		const autoIndicator = " (auto)";
		parts.push(`${percentStr}/${formatTokens(contextWindow)}${autoIndicator}`);

		let statsLeft = parts.filter(Boolean).join(" ");
		const modelName = ctx.model?.id || "no-model";
		let rightSide = modelName;
		if (ctx.model?.reasoning) {
			const level = (ctx as any).thinkingLevel ?? "off";
			rightSide = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
		}
		const providerCount = footerDataRef?.getAvailableProviderCount?.() ?? 1;
		if (providerCount > 1 && ctx.model) {
			const withProvider = `(${ctx.model.provider}) ${rightSide}`;
			if (visibleWidth(statsLeft) + 2 + visibleWidth(withProvider) <= width) rightSide = withProvider;
		}
		const slw = Math.min(visibleWidth(statsLeft), width);
		const rw = visibleWidth(rightSide);
		const totalNeeded = slw + 2 + rw;
		let statsLine: string;
		if (totalNeeded <= width) {
			statsLine = statsLeft + " ".repeat(width - slw - rw) + rightSide;
		} else {
			const avail = width - slw - 2;
			if (avail > 0) {
				const truncatedRight = truncateToWidth(rightSide, avail, "");
				statsLine = statsLeft + " ".repeat(Math.max(0, width - slw - visibleWidth(truncatedRight))) + truncatedRight;
			} else statsLine = statsLeft;
		}
		const dimStats = footerTheme?.fg ? footerTheme.fg("dim", statsLeft) : statsLeft;
		const remainder = statsLine.slice(statsLeft.length);
		const dimRemainder = footerTheme?.fg ? footerTheme.fg("dim", remainder) : remainder;
		return truncateToWidth(dimStats + dimRemainder, width, footerTheme?.fg?.("dim", "…") ?? "…");
	}


	let lastCtx: ExtensionCommandContext | undefined = undefined;

	/** 防御性读取 pi-web-access 的 summary model 配置（包/路径/形状都可能变，任何异常静默降级）。 */
	function readWebAccessSummaryModel(): string | null {
		const candidates = [
			join(agentDirectory, "web-search.json"),
			join(dirname(agentDirectory), "web-search.json"),
		];
		for (const path of candidates) {
			try {
				if (!existsSync(path)) continue;
				const parsed = JSON.parse(readFileSync(path, "utf8"));
				if (parsed && typeof parsed.summaryModel === "string" && parsed.summaryModel.trim()) {
					return parsed.summaryModel.trim();
				}
			} catch { /* 静默降级 */ }
		}
		return null;
	}

	/** 模块级：辅助状态行文本缓存（refreshWidget 更新，自定义 footer 同步读取）。 */
	let lastAuxLine = "";

	/** 刷新状态条：更新 lastAuxLine 缓存并请求 TUI 重绘。
	 * 尊重 ui.widget 开关（关闭时清空）。自定义 footer 模式下不再调用 setStatus。 */
	function refreshWidget(ctx: { hasUI?: boolean; ui?: any; scopedModels?: any[]; model?: any; modelRegistry?: any; custom?: any }) {
		void runner.getConfig().then((config) => {
			try {
				const widget = config.ui?.widget ?? true;
				if (!widget || !ctx.hasUI) { lastAuxLine = ""; footerTui?.requestRender?.(); return; }
				const scopedIds = new Set((ctx.scopedModels ?? []).map((m: any) => `${m.provider}/${m.id}`));
				const visionRoute = resolveValidatedRole(config, "vision", ctx.model, ctx.modelRegistry);
				const extractRoute = resolveValidatedRole(config, "extract", ctx.model, ctx.modelRegistry);
				const lines = buildStatusText({ config, visionRoute, extractRoute, scopedIds, mode: "widget" });
				lastAuxLine = lines.join(" | ");
				footerTui?.requestRender?.();
			} catch { /* 状态条失败不致命 */ }
		});
	}

	function output(ctx: ExtensionCommandContext, text: string, type: "info" | "error" = "info") {
		if (ctx.hasUI) ctx.ui.notify(text, type);
		else console.log(text);
	}

	/** 模型完整 id（含路由 id）。 */
	function modelFullId(m: any): string {
		return `${m.provider}/${m.id}`;
	}

	/**
	 * 模型选择器：复用 Pi 内置 ModelSelectorComponent（/model 同款），
	 * 支持关键字搜索（顶部 `> 关键词` 输入框）与 Tab 切换 all/scoped。
	 * 共享完整模型库（all scope 默认，含所有 provider 的模型）。
	 * 返回选中模型的 provider/id，或 undefined（取消）。
	 */
	async function openModelPicker(ctx: ExtensionCommandContext, title: string, initialSearch = ""): Promise<{ provider: string; id: string } | undefined> {
		if (!ctx.hasUI || !ctx.ui.custom) return undefined;
		const registry = ctx.modelRegistry as any;
		// 鸭子类型：ModelSelectorComponent 需要 ModelRuntime 接口，而扩展 ctx 只有 ModelRegistry
		const runtimeish = {
			getAvailableSnapshot: () => registry.getAvailable?.() ?? [],
			getModel: (p: string, i: string) => registry.find?.(p, i),
			getError: () => registry.getError?.(),
			refresh: (opts: any) => registry.refresh?.(opts),
		};
		return ctx.ui.custom<{ provider: string; id: string } | undefined>((tui, theme, _kb, done) => {
			const selector = new ModelSelectorComponent(
				tui as any,
				ctx.model as any,
				runtimeish as any,
				[], // 空 scoped → 默认 all scope（共享完整模型库）；用户可 Tab 切 scoped（无条目时忽略）
				(model: any) => done({ provider: model.provider, id: model.id }),
				() => done(undefined),
				initialSearch,
			);
			return selector as any;
		});
	}

	/**
	 * /aux 交互向导（TUI，v8 §8 界面顺序）：
	 * 总开关 → 状态条 → 角色 → 模式 → 模型 → 视觉目录 → 保存。
	 * 模型选择用 ctx.ui.custom + ModelSelectorComponent（带搜索，/model 同款）；视觉只列支持图片或断言项，作用域外标 *。
	 * 列表默认共享完整模型库（all scope），Tab 可切 scoped。
	 */
	async function openAuxWizard(ctx: ExtensionCommandContext, config: any) {
		const pending = structuredClone(config);
		for (;;) {
			const roleLines = {
				vision: `看图 vision    ${pending.roles.vision.mode === "pinned" ? `固定 ${modelFullId(pending.roles.vision.model)}` : "跟随主模型"}`,
				extract: `压长文 extract ${pending.roles.extract.mode === "pinned" ? `固定 ${modelFullId(pending.roles.extract.model)}` : "跟随主模型"}`,
			};
			const action = await ctx.ui.select(
				`辅助模型 /aux | 状态条: ${pending.ui.widget ? "显示" : "隐藏"} | 列表范围: ${pending.ui.listAllModels ? "完整目录" : "仅会话可用"}`,
				[roleLines.vision, roleLines.extract, "状态条开关", "模型列表范围", "图片目录", "保存并退出", "放弃更改", "有效路由说明"],
			);
			if (action === "放弃更改" || action === undefined || action === null) return;
			if (action === "保存并退出") {
				const probe = resolveValidatedRole(pending, "vision", ctx.model, ctx.modelRegistry);
				const probeExtract = resolveValidatedRole(pending, "extract", ctx.model, ctx.modelRegistry);
				if (!probe.ok) { output(ctx, `vision 校验失败：${formatError(probe.code)}`, "error"); return; }
				if (!probeExtract.ok) { output(ctx, `extract 校验失败：${formatError(probeExtract.code)}`, "error"); return; }
				await runner.saveAndReload(pending);
				refreshWidget(ctx);
				output(ctx, "辅助模型配置已保存。");
				return;
			}
			if (action === "状态条开关") { pending.ui.widget = !pending.ui.widget; continue; }
			if (action === "模型列表范围") { pending.ui.listAllModels = !pending.ui.listAllModels; continue; }
			if (action === "图片目录") {
				const dirs = pending.roles.vision.allowedRoots ?? [];
				const choice = await ctx.ui.select(
					`图片目录（当前 ${dirs.length} 个）：${dirs.map((d: string) => `  ${d}`).join("\n") || "  (仅当前目录)"}`,
					[...dirs.map((d: string) => `移除 ${d}`), "添加目录", "返回"],
				);
				if (choice === "添加目录") {
					const dir = await ctx.ui.input("输入要允许的目录路径（如 D:/lynni/Pictures）：");
					if (dir && dir.trim()) {
						try { await stat(dir.trim()); } catch { output(ctx, `目录 ${dir.trim()} 不存在或不可访问。`, "error"); continue; }
						if (!pending.roles.vision.allowedRoots.includes(dir.trim())) pending.roles.vision.allowedRoots.push(dir.trim());
					}
				} else if (choice && choice.startsWith("移除 ")) {
					const target = choice.slice(3);
					pending.roles.vision.allowedRoots = pending.roles.vision.allowedRoots.filter((d: string) => d !== target);
				}
				continue;
			}
			if (action === "有效路由说明") {
				const scopedIds = new Set((ctx.scopedModels ?? []).map((m: any) => `${m.provider}/${m.id}`));
				const vr = resolveValidatedRole(pending, "vision", ctx.model, ctx.modelRegistry);
				const er = resolveValidatedRole(pending, "extract", ctx.model, ctx.modelRegistry);
				output(ctx, ["有效路由：", ...buildStatusText({ config: pending, visionRoute: vr, extractRoute: er, scopedIds, mode: "diag" })].join("\n"));
				continue;
			}
			const roleName = action.startsWith("看图") ? "vision" : action.startsWith("压长文") ? "extract" : undefined;
			if (!roleName) continue;
			const role = pending.roles[roleName];
			const modeChoice = await ctx.ui.select(
				`${roleName === "vision" ? "看图" : "压长文"} 角色：当前 ${role.mode === "pinned" ? `固定 ${modelFullId(role.model)}` : "跟随主模型"}`,
				["跟随主模型 (default)", "固定模型 (pinned)", "返回"],
			);
			if (modeChoice === "返回" || modeChoice === undefined || modeChoice === null) continue;
			if (modeChoice === "跟随主模型 (default)") { role.mode = "default"; role.model = null; continue; }
			// 用 Pi 内置模型选择器（带搜索、完整模型库）；选择后由后续校验拦截不支持图片的模型
			const picked = await openModelPicker(ctx, `选择 ${roleName} 固定模型（输入关键字过滤；Enter 选择；Tab 切换作用域）`, modelFullId(role.model ?? {}));
			if (picked && picked.provider && picked.id) {
				role.mode = "pinned"; role.model = { provider: picked.provider, id: picked.id };
			}
		}
	}

	async function handleAux(args: string, ctx: ExtensionCommandContext) {
		lastCtx = ctx;
		const config = await runner.getConfig();
		const parsed = parseAuxArgs(args);
		if (!parsed.ok) { output(ctx, parsed.error, "error"); return; }

		if (parsed.kind === "wizard") {
			// TUI：交互向导；非 TUI：直接输出诊断（v8 §8）
			if (ctx.hasUI && typeof ctx.ui.select === "function") {
				await openAuxWizard(ctx, config);
			} else {
				const scopedIds = new Set((ctx.scopedModels ?? []).map((m: any) => `${m.provider}/${m.id}`));
				const visionRoute = resolveValidatedRole(config, "vision", ctx.model, ctx.modelRegistry);
				const extractRoute = resolveValidatedRole(config, "extract", ctx.model, ctx.modelRegistry);
				const summary = readWebAccessSummaryModel();
				const lines = [...buildStatusText({ config, visionRoute, extractRoute, scopedIds, mode: "diag" }), `pi-web-access summaryModel: ${summary ?? "(未设置)"}`, `允许目录: ${[...(config.roles.vision.allowedRoots ?? [])].join("，") || "(仅当前目录)"}`];
				output(ctx, lines.join("\n"));
			}
			return;
		}

		if (parsed.kind === "status") {
			const scopedIds = new Set((ctx.scopedModels ?? []).map((m: any) => `${m.provider}/${m.id}`));
			const visionRoute = resolveValidatedRole(config, "vision", ctx.model, ctx.modelRegistry);
			const extractRoute = resolveValidatedRole(config, "extract", ctx.model, ctx.modelRegistry);
			const summary = readWebAccessSummaryModel();
			const lines = [...buildStatusText({ config, visionRoute, extractRoute, scopedIds, mode: "diag" }), `pi-web-access summaryModel: ${summary ?? "(未设置)"}`];
			output(ctx, lines.join("\n"));
			return;
		}

		if (parsed.kind === "allow-list") {
			const dirs = [ctx.cwd, ...(config.roles.vision.allowedRoots ?? [])];
			output(ctx, `当前允许的图片目录：\n${dirs.map((d) => `  ${d}`).join("\n") || "  (无)"}`);
			return;
		}

		if (parsed.kind === "role-default" || parsed.kind === "role-set"
			|| parsed.kind === "allow-add" || parsed.kind === "allow-remove") {
			// 非 TUI 模式任何情况下不写文件（v8 §4）
			if (!ctx.hasUI) { output(ctx, "非 TUI 模式不写配置；仅输出诊断。如需修改配置，请在 TUI 中使用 /aux。", "error"); return; }
		}

		if (parsed.kind === "role-default" || parsed.kind === "role-set") {
			const pending = structuredClone(config);
			if (parsed.kind === "role-default") {
				pending.roles[parsed.role].mode = "default";
				pending.roles[parsed.role].model = null;
			} else {
				const modelRef = { provider: parsed.provider, id: parsed.id };
				pending.roles[parsed.role].mode = "pinned";
				pending.roles[parsed.role].model = modelRef;
				// 完整校验（存在性、鉴权、能力）——失败则保持原配置，不写文件
				const probe = structuredClone(pending);
				const route = resolveValidatedRole(probe, parsed.role, ctx.model, ctx.modelRegistry);
				if (!route.ok) {
					if (route.code === "PINNED_MODEL_NOT_VISION") {
						output(ctx, `模型 ${parsed.provider}/${parsed.id} 未声明图片能力；如需固定它，请用 /aux vision ${parsed.provider}/${parsed.id} 并先开启 assertImageCapable（见文档），或改用支持图片的模型。`, "error");
					} else {
						output(ctx, `校验失败：${formatError(route.code)}`, "error");
					}
					return;
				}
			}
			await runner.saveAndReload(pending); // 原子保存 + 刷新内存缓存
			refreshWidget(ctx);
			output(ctx, parsed.kind === "role-default"
				? `已将 ${parsed.role} 恢复为跟随主模型。`
				: `已将 ${parsed.role} 固定为 ${parsed.provider}/${parsed.id}。`);
			return;
		}

		if (parsed.kind === "policy-set") {
			// v9：/aux policy roots|unrestricted，走同样校验与原子保存
			if (!ctx.hasUI) { output(ctx, "非 TUI 模式不写配置；如需修改配置，请在 TUI 中使用 /aux。", "error"); return; }
			const pending = structuredClone(config);
			pending.roles.vision.pathPolicy = parsed.policy;
			await runner.saveAndReload(pending);
			refreshWidget(ctx);
			output(ctx, parsed.policy === "unrestricted"
				? "已切换为不限目录 (unrestricted)：辅助视觉可读取任意路径图片（与主模型对齐）。状态条已显示标记。"
				: "已切换为限目录 (roots)：仅 cwd + allowedRoots，越界需逐次确认。");
			return;
		}

		if (parsed.kind === "allow-add" || parsed.kind === "allow-remove") {
			const pending = structuredClone(config);
			const roots = pending.roles.vision.allowedRoots ?? [];
			const restricted = pending.roles.vision.pathPolicy !== "unrestricted";
			if (parsed.kind === "allow-add") {
				if (roots.includes(parsed.directory)) { output(ctx, `${parsed.directory} 已在允许目录中。`); return; }
				try { await stat(parsed.directory); } catch { output(ctx, `目录 ${parsed.directory} 不存在或不可访问。`, "error"); return; }
				pending.roles.vision.allowedRoots = [...roots, parsed.directory];
				await runner.saveAndReload(pending);
				refreshWidget(ctx);
				output(ctx, `已加入允许目录：${parsed.directory}${restricted ? "" : "。注意：当前目录限制已关闭 (unrestricted)，此设置在切回 /aux policy roots 后才生效。"}`);
			} else {
				if (!roots.includes(parsed.directory)) { output(ctx, `${parsed.directory} 不在允许目录中。`); return; }
				pending.roles.vision.allowedRoots = roots.filter((r: string) => r !== parsed.directory);
				await runner.saveAndReload(pending);
				refreshWidget(ctx);
				output(ctx, `已移除允许目录：${parsed.directory}${restricted ? "" : "。注意：当前目录限制已关闭 (unrestricted)，此设置在切回 /aux policy roots 后才生效。"}`);
			}
			return;
		}
	}

	// ---- 工具 ----
	pi.registerTool({
		name: "auxiliary_extract",
		label: "Auxiliary Extract",
		description: "Use the configured read-only auxiliary model to extract or summarize supplied text.",
		parameters: Type.Object({ text: Type.String({ description: "Text to analyze" }), instruction: Type.String({ description: "Read-only extraction instruction" }) }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return runner.execute({ role: "extract", ctx, input: params.text, instruction: params.instruction, signal });
		},
	});

	pi.registerTool({
		name: "auxiliary_vision_describe",
		label: "Auxiliary Vision Describe",
		description: "Use the configured read-only auxiliary vision model to describe an image inside an allowed directory.",
		parameters: Type.Object({ path: Type.String({ description: "Path to a PNG or JPEG image" }), prompt: Type.Optional(Type.String({ description: "What to inspect in the image" })) }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const config = await runner.getConfig();
			const prepared = await prepareImage({
				imagePath: params.path, cwd: ctx.cwd,
				allowedRoots: config.roles.vision.allowedRoots, maxImageBytes: config.roles.vision.maxImageBytes, resizeImage,
				pathPolicy: config.roles.vision.pathPolicy,
				confirmOutOfRoot: ctx.hasUI && ctx.ui.confirm
					? (path: string) => ctx.ui.confirm(`${path} 不在允许目录内。仅本次把它发给辅助视觉模型？`)
					: undefined,
			});
			if (!prepared.ok) return { content: [{ type: "text" as const, text: prepared.code === "IMAGE_OUT_OF_ROOT" ? formatImageOutOfRoot(config.roles.vision.allowedRoots, ctx.cwd) : formatError(prepared.code) }], isError: true, details: { model: null, reason: null, duration: 0, usage: null, errorCode: prepared.code } };
			// v9：details 记录本次图片是否位于 allowedRoots 之外（只记布尔与最终路径，不记内容）
			const outOfRoot = Boolean(prepared.metadata?.outOfRoot);
			return runner.execute({ role: "vision", ctx, image: prepared.image, instruction: params.prompt ?? "请用简体中文简要描述图片内容，包括可见文字。", signal, imagePath: prepared.metadata?.path, outOfRoot });
		},
	});

	// ---- 命令 ----
	pi.registerCommand("aux", {
		description: "辅助模型配置：status 查看路由；vision/extract <provider>/<id> 固定模型；vision/extract default 恢复跟随；allow/disallow <目录> 管理图片目录",
		handler: handleAux,
		getArgumentCompletions: async (prefix: string) => {
			const raw = prefix ?? "";
			const tokens = raw.trim().split(/\s+/).filter(Boolean);
			// 第一段（子命令/角色名）
			if (tokens.length <= 1 && !raw.endsWith(" ")) {
				return ["status", "vision", "extract", "allow", "disallow", "policy"].map((value) => ({ value, label: value, description: "" }));
			}
			// 第二段：policy 的两个取值
			if (tokens[0] === "policy") {
				return ["roots", "unrestricted"].map((value) => ({ value, label: value, description: value === "roots" ? "限目录（cwd + allowedRoots，越界确认）" : "不限目录（与主模型全盘访问对齐）" }));
			}
			// 第二段：模型或目录补全
			if (tokens[0] === "vision" || tokens[0] === "extract") {
				const config = await runner.getConfig();
				const ctx = lastCtx;
				if (!ctx) return [];
				const scopedIds = new Set((ctx.scopedModels ?? []).map((m: any) => `${m.provider}/${m.id}`));
				// 补全同样尊重 listAllModels：默认会话作用域，开关时完整目录（v8 §8）
				const sourceModels = config.ui.listAllModels
					? (ctx.modelRegistry.getAvailable?.() ?? [])
					: (ctx.scopedModels ?? []).map((sm: any) => sm.model ?? sm);
				const assert = config.roles.vision.assertImageCapable;
				return buildModelCandidates({ role: tokens[0], models: sourceModels, scopedModelIds: scopedIds, assert })
					.map((c) => ({ value: c.value, label: c.label, description: c.description }));
			}
			if (tokens[0] === "allow" || tokens[0] === "disallow") {
				// 目录补全交给 Pi 内置路径补全，这里不返回条目
				return [];
			}
			return [];
		},
	});
}