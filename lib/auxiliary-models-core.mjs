import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONFIG_FILENAME = "auxiliary-models.json";

/**
 * 解析配置文件的读写路径（用户目录优先，包目录兕底）。
 * - 若显式指定 PI_CODING_AGENT_DIR 环境变量，则用它（显式用户意图优先）。
 * - 否则优先用户配置目录 `~/.pi/agent/`（与 Pi 生态 getAgentDir() 语义一致，升级/重建包不丢配置）。
 * - 仅在用户目录不存在该配置时，回落包目录（新装场景：包内自带空白配置）。
 * 读写始终用同一路径（runner 的 load/save 都指向它），保证读后改写一致。
 */
export function resolveConfigPath(packageDir, agentDirOverride) {
	if (agentDirOverride) return join(agentDirOverride, CONFIG_FILENAME);
	const userConfig = join(homedir(), ".pi", "agent", CONFIG_FILENAME);
	if (existsSync(userConfig)) return userConfig;
	return join(packageDir, CONFIG_FILENAME);
}

export const ERROR_CODES = Object.freeze({
	ROLE_DISABLED: "ROLE_DISABLED",
	PINNED_MODEL_UNAVAILABLE: "PINNED_MODEL_UNAVAILABLE",
	PINNED_MODEL_NOT_VISION: "PINNED_MODEL_NOT_VISION",
	NO_VISION_FALLBACK: "NO_VISION_FALLBACK",
	MAIN_MODEL_UNAVAILABLE: "MAIN_MODEL_UNAVAILABLE",
	BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
	INPUT_TOO_LARGE: "INPUT_TOO_LARGE",
	IMAGE_TOO_LARGE: "IMAGE_TOO_LARGE",
	IMAGE_NOT_FOUND: "IMAGE_NOT_FOUND",
	IMAGE_OUT_OF_ROOT: "IMAGE_OUT_OF_ROOT",
	IMAGE_UNSUPPORTED_TYPE: "IMAGE_UNSUPPORTED_TYPE",
	TIMEOUT: "TIMEOUT",
	ABORTED: "ABORTED",
	UPSTREAM_ERROR: "UPSTREAM_ERROR",
	CONFIG_INVALID: "CONFIG_INVALID",
});

const ERROR_MESSAGES = Object.freeze({
	[ERROR_CODES.ROLE_DISABLED]: "这个辅助角色（或总开关）已关闭。",
	[ERROR_CODES.PINNED_MODEL_UNAVAILABLE]: "固定模型找不到，或尚未配置鉴权。",
	[ERROR_CODES.PINNED_MODEL_NOT_VISION]: "固定的视觉模型未声明图片输入能力。",
	[ERROR_CODES.NO_VISION_FALLBACK]: "主模型不支持图片，且没有可用的视觉回退模型；请使用 /aux 配置。",
	[ERROR_CODES.MAIN_MODEL_UNAVAILABLE]: "当前主模型不可用，或尚未配置鉴权。",
	[ERROR_CODES.BUDGET_EXCEEDED]: "本轮辅助模型调用次数已达到上限。",
	[ERROR_CODES.INPUT_TOO_LARGE]: "输入文本超过辅助模型允许的长度。",
	[ERROR_CODES.IMAGE_TOO_LARGE]: "图片缩放后仍超过允许大小。",
	[ERROR_CODES.IMAGE_NOT_FOUND]: "图片路径找不到，或读取失败。",
	[ERROR_CODES.IMAGE_OUT_OF_ROOT]: "图片不在允许的目录内。",
	[ERROR_CODES.IMAGE_UNSUPPORTED_TYPE]: "文件不是受支持的图片格式。",
	[ERROR_CODES.TIMEOUT]: "辅助模型调用或排队等待超时。",
	[ERROR_CODES.ABORTED]: "辅助模型调用已取消。",
	[ERROR_CODES.UPSTREAM_ERROR]: "辅助模型提供商返回了错误。",
	[ERROR_CODES.CONFIG_INVALID]: "辅助模型配置无效，已保留上一份有效配置。",
});

export const DEFAULT_CONFIG = deepFreeze({
	version: 1,
	enabled: true,
	ui: { widget: true, listAllModels: false },
	defaults: {
		timeoutMs: 60_000,
		maxOutputTokens: 2_048,
		maxInputChars: 50_000,
		maxCallsPerTurn: 2,
	},
	roles: {
		vision: {
			enabled: true,
			mode: "default",
			model: null,
			assertImageCapable: false,
			fallbacks: [],
			maxImageBytes: 8 * 1024 * 1024,
			pathPolicy: "unrestricted", // v9：本机默认 "unrestricted"（与主模型全盘访问对齐，见 §6）；"roots" 需显式配置或用户切回
			allowedRoots: [],
		},
		extract: { enabled: true, mode: "default", model: null },
	},
});

const SENSITIVE_KEYS = new Set([
	"apikey",
	"api_key",
	"baseurl",
	"base_url",
	"headers",
	"script",
	"command",
	"env",
]);

function deepFreeze(value) {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

function cloneDefaultConfig() {
	return structuredClone(DEFAULT_CONFIG);
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyKeys(value, keys) {
	return Object.keys(value).every((key) => keys.includes(key));
}

function isPositiveInteger(value) {
	return Number.isSafeInteger(value) && value > 0;
}

function hasSensitiveKey(value) {
	if (Array.isArray(value)) return value.some(hasSensitiveKey);
	if (!isPlainObject(value)) return false;
	return Object.entries(value).some(([key, child]) => SENSITIVE_KEYS.has(key.toLowerCase()) || hasSensitiveKey(child));
}

function isModelRef(value) {
	return isPlainObject(value)
		&& hasOnlyKeys(value, ["provider", "id"])
		&& typeof value.provider === "string"
		&& value.provider.trim().length > 0
		&& typeof value.id === "string"
		&& value.id.trim().length > 0;
}

function isRoleBase(value) {
	return isPlainObject(value)
		&& typeof value.enabled === "boolean"
		&& (value.mode === "default" || value.mode === "pinned")
		&& (value.model === null || isModelRef(value.model))
		&& ((value.mode === "default" && value.model === null) || (value.mode === "pinned" && isModelRef(value.model)));
}

/**
 * Validate the on-disk contract before any routing decision or write. Keeping this
 * strict prevents a settings file from becoming an alternate credential/script path.
 */
export function validateConfig(value) {
	if (!isPlainObject(value) || hasSensitiveKey(value)) return { ok: false, code: ERROR_CODES.CONFIG_INVALID };
	if (!hasOnlyKeys(value, ["version", "enabled", "ui", "defaults", "roles"])) return { ok: false, code: ERROR_CODES.CONFIG_INVALID };
	if (value.version !== 1 || typeof value.enabled !== "boolean") return { ok: false, code: ERROR_CODES.CONFIG_INVALID };

	if (!isPlainObject(value.ui) || !hasOnlyKeys(value.ui, ["widget", "listAllModels"])
		|| typeof value.ui.widget !== "boolean" || typeof value.ui.listAllModels !== "boolean") {
		return { ok: false, code: ERROR_CODES.CONFIG_INVALID };
	}

	if (!isPlainObject(value.defaults) || !hasOnlyKeys(value.defaults, ["timeoutMs", "maxOutputTokens", "maxInputChars", "maxCallsPerTurn"])
		|| !Object.values(value.defaults).every(isPositiveInteger)) {
		return { ok: false, code: ERROR_CODES.CONFIG_INVALID };
	}

	if (!isPlainObject(value.roles) || !hasOnlyKeys(value.roles, ["vision", "extract"])) return { ok: false, code: ERROR_CODES.CONFIG_INVALID };
	const { vision, extract } = value.roles;
	if (!isRoleBase(extract) || !hasOnlyKeys(extract, ["enabled", "mode", "model"])) return { ok: false, code: ERROR_CODES.CONFIG_INVALID };
	if (!isRoleBase(vision) || !hasOnlyKeys(vision, ["enabled", "mode", "model", "assertImageCapable", "fallbacks", "maxImageBytes", "pathPolicy", "allowedRoots"])
		|| typeof vision.assertImageCapable !== "boolean"
		|| !Array.isArray(vision.fallbacks) || !vision.fallbacks.every(isModelRef)
		|| !isPositiveInteger(vision.maxImageBytes)
		|| (vision.pathPolicy !== undefined && vision.pathPolicy !== "roots" && vision.pathPolicy !== "unrestricted")
		|| !Array.isArray(vision.allowedRoots) || !vision.allowedRoots.every((root) => typeof root === "string" && root.trim().length > 0)) {
		return { ok: false, code: ERROR_CODES.CONFIG_INVALID };
	}

	const normalized = structuredClone(value);
	// v9：pathPolicy 缺省视为 "unrestricted"（与文档 §6 的"本机默认 unrestricted"一致；旧配置/备份仍可加载，且不会把用户已有行为改严）
	if (normalized.roles.vision.pathPolicy === undefined) normalized.roles.vision.pathPolicy = "unrestricted";
	return { ok: true, config: normalized };
}

/** Load without overwriting malformed input; callers retain their last valid config. */
export async function loadConfig(path, lastValid = cloneDefaultConfig()) {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		const validated = validateConfig(parsed);
		return validated.ok ? validated : { ok: false, code: ERROR_CODES.CONFIG_INVALID, config: structuredClone(lastValid) };
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ENOENT") return { ok: true, config: cloneDefaultConfig() };
		return { ok: false, code: ERROR_CODES.CONFIG_INVALID, config: structuredClone(lastValid) };
	}
}

/**
 * Persist only validated, secret-free settings. Rename is the commit point, so an
 * interrupted write never leaves a half-written configuration at the target path.
 */
export async function saveConfig(path, config) {
	const validated = validateConfig(config);
	if (!validated.ok) throw new Error(ERROR_CODES.CONFIG_INVALID);
	const directory = dirname(path);
	const temporaryPath = join(directory, `.${CONFIG_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
	await mkdir(directory, { recursive: true });
	try {
		await writeFile(temporaryPath, `${JSON.stringify(validated.config, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, path);
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => {});
		throw error;
	}
}

/** Preserve Pi Web Access routing semantics for provider/model ids containing slashes. */
export function findModelWithProviderRouting(registry, provider, id) {
	const available = registry.getAvailable();
	const direct = available.find((candidate) => candidate.provider === provider && candidate.id === id);
	if (direct) return direct;
	const routed = available.find((candidate) => candidate.id === `${provider}/${id}`);
	return routed ?? registry.find(provider, id);
}

function isAuthenticated(registry, model) {
	return Boolean(model) && registry.hasConfiguredAuth(model);
}

function hasImageCapability(model) {
	return Array.isArray(model?.input) && model.input.includes("image");
}

function resolvePinned(role, registry) {
	const selected = findModelWithProviderRouting(registry, role.model.provider, role.model.id);
	if (!selected) return { ok: false, code: ERROR_CODES.PINNED_MODEL_UNAVAILABLE };
	if (!isAuthenticated(registry, selected)) return { ok: false, code: ERROR_CODES.PINNED_MODEL_UNAVAILABLE };
	return { ok: true, model: selected, reason: "pinned" };
}

/**
 * The sole model routing policy for auxiliary roles. It has no network or file
 * effects, which keeps decisions deterministic and independently testable.
 */
export function resolveRole(config, roleName, mainModel, registry) {
	const validated = validateConfig(config);
	if (!validated.ok) return { ok: false, code: ERROR_CODES.CONFIG_INVALID };
	return resolveValidatedRole(validated.config, roleName, mainModel, registry);
}

/** Resolve a configuration previously accepted by validateConfig/loadConfig without cloning it again. */
export function resolveValidatedRole(config, roleName, mainModel, registry) {
	if (roleName !== "vision" && roleName !== "extract") throw new TypeError(`Unknown auxiliary role: ${roleName}`);
	const role = config.roles[roleName];
	if (!config.enabled || !role.enabled) return { ok: false, code: ERROR_CODES.ROLE_DISABLED };

	if (roleName === "extract") {
		if (role.mode === "pinned") return resolvePinned(role, registry);
		if (!isAuthenticated(registry, mainModel)) return { ok: false, code: ERROR_CODES.MAIN_MODEL_UNAVAILABLE };
		return { ok: true, model: mainModel, reason: "default-main" };
	}

	if (role.mode === "pinned") {
		const selected = findModelWithProviderRouting(registry, role.model.provider, role.model.id);
		if (!selected) return { ok: false, code: ERROR_CODES.PINNED_MODEL_UNAVAILABLE };
		if (!hasImageCapability(selected) && !role.assertImageCapable) return { ok: false, code: ERROR_CODES.PINNED_MODEL_NOT_VISION };
		if (!isAuthenticated(registry, selected)) return { ok: false, code: ERROR_CODES.PINNED_MODEL_UNAVAILABLE };
		return { ok: true, model: selected, reason: "pinned", assertedImageCapability: role.assertImageCapable && !hasImageCapability(selected) };
	}

	if (!mainModel || !isAuthenticated(registry, mainModel)) return { ok: false, code: ERROR_CODES.MAIN_MODEL_UNAVAILABLE };
	if (hasImageCapability(mainModel)) {
		return { ok: true, model: mainModel, reason: "default-main" };
	}

	for (const fallback of role.fallbacks) {
		const selected = findModelWithProviderRouting(registry, fallback.provider, fallback.id);
		if (selected && hasImageCapability(selected) && isAuthenticated(registry, selected)) {
			return { ok: true, model: selected, reason: "vision-fallback" };
		}
	}
	return { ok: false, code: ERROR_CODES.NO_VISION_FALLBACK };
}

export function formatError(code) {
	return ERROR_MESSAGES[code] ?? ERROR_MESSAGES[ERROR_CODES.UPSTREAM_ERROR];
}
