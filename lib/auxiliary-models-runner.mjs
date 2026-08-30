import { DEFAULT_CONFIG, ERROR_CODES, formatError, loadConfig, resolveValidatedRole, saveConfig } from "./auxiliary-models-core.mjs";

const SYSTEM_PROMPTS = {
	vision: "You are a read-only image-description helper. Describe only the explicitly supplied image and task. You have no tools, cannot read files, and cannot access the network.",
	extract: "You are a read-only text-extraction helper. Analyze only the explicitly supplied text and task. You have no tools, cannot read files, and cannot access the network.",
};

class RoleGate {
	constructor() { this.busy = false; this.waiters = []; }
	acquire(signal) {
		if (!this.busy) { this.busy = true; return Promise.resolve(() => this.release()); }
		return new Promise((resolve, reject) => {
			const waiter = { resolve, reject };
			const abort = () => { const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1); reject(new Error("aborted")); };
			if (signal?.aborted) return abort();
			signal?.addEventListener("abort", abort, { once: true });
			waiter.resolve = () => { signal?.removeEventListener("abort", abort); resolve(() => this.release()); };
			this.waiters.push(waiter);
		});
	}
	release() { const next = this.waiters.shift(); if (next) next.resolve(); else this.busy = false; }
}

function details({ model = null, reason = null, duration, usage = null, errorCode = null, ...extra }) { return { model, reason, duration, usage, errorCode, ...extra }; }
function textFromResponse(response) { return response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"); }
function combinedSignal(signal, timeoutMs) {
	const timeout = new AbortController(); let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; timeout.abort(); }, timeoutMs);
	const signals = [timeout.signal, ...(signal ? [signal] : [])];
	return { signal: AbortSignal.any(signals), didTimeout: () => timedOut, dispose: () => clearTimeout(timer) };
}

/** A tool-facing, read-only helper executor. All model selection remains in auxiliary-models-core. */
export function createAuxiliaryRunner({ config, configPath, now = () => Date.now() } = {}) {
	let cachedConfig = config ?? structuredClone(DEFAULT_CONFIG);
	let loaded = config !== undefined;
	let callsThisTurn = 0;
	const gates = { vision: new RoleGate(), extract: new RoleGate() };

	/** 保存并重载配置：先原子落盘，再更新内存缓存（v8 §4）。仅配置路径构造的 runner 可用。 */
	async function saveAndReload(config) {
		if (configPath === undefined) throw new Error("runner created without configPath cannot persist");
		await saveConfig(configPath, config);
		cachedConfig = structuredClone(config);
	}

	async function ensureConfig() {
		if (loaded) return cachedConfig;
		loaded = true;
		const result = await loadConfig(configPath, cachedConfig);
		cachedConfig = result.config;
		return cachedConfig;
	}
	function error(code, started) {
		const duration = now() - started;
		return { content: [{ type: "text", text: formatError(code) }], isError: true, details: details({ duration, errorCode: code }) };
	}
	return {
		resetTurnBudget() { callsThisTurn = 0; },
		getConfig: ensureConfig,
		getCachedConfig() { return cachedConfig; },
		saveAndReload(config) { return saveAndReload(config); },
		async execute({ role, ctx, input, instruction, image, signal, imagePath, outOfRoot }) {
			const started = now();
			const activeConfig = await ensureConfig();
			const route = resolveValidatedRole(activeConfig, role, ctx.model, ctx.modelRegistry);
			if (!route.ok) return error(route.code, started);
			// 已取消的请求不得消耗预算、进入队列或触发 provider 调用。
			if (signal?.aborted) return error(ERROR_CODES.ABORTED, started);
			if (`${instruction ?? ""}${input ?? ""}`.length > activeConfig.defaults.maxInputChars) return error(ERROR_CODES.INPUT_TOO_LARGE, started);
			if (callsThisTurn >= activeConfig.defaults.maxCallsPerTurn) return error(ERROR_CODES.BUDGET_EXCEEDED, started);
			const deadline = combinedSignal(signal, activeConfig.defaults.timeoutMs);
			if (deadline.signal.aborted) { deadline.dispose(); return error(ERROR_CODES.ABORTED, started); }
			callsThisTurn++;
			let release;
			try {
				release = await gates[role].acquire(deadline.signal);
				const content = image
					? [{ type: "text", text: `Task:\n${instruction}` }, image]
					: [{ type: "text", text: `Task:\n${instruction}\n\nContent:\n${input}` }];
				// Pi 的公共 complete 路径会按 model.input 降级图片；用户显式断言时必须将该能力透传。
				const requestModel = route.assertedImageCapability
					? { ...route.model, input: [...new Set([...route.model.input, "image"])] }
					: route.model;
				const response = await ctx.modelRegistry.complete(requestModel, {
					systemPrompt: SYSTEM_PROMPTS[role],
					messages: [{ role: "user", timestamp: now(), content }],
				}, { signal: deadline.signal, maxTokens: activeConfig.defaults.maxOutputTokens });
				if (deadline.didTimeout()) return error(ERROR_CODES.TIMEOUT, started);
				if (response.stopReason === "aborted") return error(ERROR_CODES.ABORTED, started);
				if (response.stopReason === "error") return error(ERROR_CODES.UPSTREAM_ERROR, started);
				const duration = now() - started;
				const modelName = `${route.model.provider}/${route.model.id}`;
				const extra = imagePath !== undefined ? { imagePath, outOfRoot: Boolean(outOfRoot) } : {};
				return { content: [{ type: "text", text: textFromResponse(response) }], details: details({ model: modelName, reason: route.reason, duration, usage: response.usage, errorCode: null, ...extra }), usage: response.usage };
			} catch {
				return error(deadline.didTimeout() ? ERROR_CODES.TIMEOUT : deadline.signal.aborted ? ERROR_CODES.ABORTED : ERROR_CODES.UPSTREAM_ERROR, started);
			} finally { release?.(); deadline.dispose(); }
		},
	};
}
