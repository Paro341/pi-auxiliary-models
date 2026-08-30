/**
 * /aux 命令的纯函数解析与展示（阶段 3，v8 §8）。
 * 全部为纯函数，便于单元测试；不接触文件系统与网络。
 */

export const SUBCOMMANDS = ["status", "vision", "extract", "allow", "disallow", "policy"];

/** IMAGE_OUT_OF_ROOT 的完整错误文本（v8 §10）：列出 cwd + allowedRoots，给出 /aux allow 下一步。 */
export function formatImageOutOfRoot(allowedRoots, cwd) {
	const dirs = [cwd, ...(allowedRoots ?? [])];
	return `图片不在允许的目录内。当前允许的目录：${dirs.join("，") || "（无）"}。可用 /aux allow <目录> 添加。`;
}

const ROLES = ["vision", "extract"];

/**
 * 切分 provider/id：第一个斜杠之前是 provider，其余全部是 id（含斜杠与冒号）。
 * 不得按最后一个斜杠切分；不得把冒号当 thinking 级别后缀。
 * 返回 { provider, id } 或 null（不含斜杠）。
 */
export function splitProviderId(modelRef) {
	if (typeof modelRef !== "string" || modelRef.length === 0) return null;
	const slash = modelRef.indexOf("/");
	if (slash <= 0 || slash === modelRef.length - 1) return null;
	return { provider: modelRef.slice(0, slash), id: modelRef.slice(slash + 1) };
}

/**
 * 解析 /aux 参数 → 命令意图。
 * 返回 { ok: true, kind, ... } 或 { ok: false, error }。
 * 空参数 → wizard（TUI 交互界面；非 TUI 由调用方降级为诊断）。
 */
export function parseAuxArgs(args) {
	const trimmed = (args ?? "").trim().replace(/\s+/g, " ").trim();
	if (!trimmed) return { ok: true, kind: "wizard" };

	const tokens = trimmed.split(" ");
	const [first] = tokens;

	if (first === "status") {
		if (tokens.length > 1) return { ok: false, error: "/aux status 不接受额外参数" };
		return { ok: true, kind: "status" };
	}

	if (first === "allow" || first === "disallow") {
		if (tokens.length === 1) {
			if (first === "allow") return { ok: true, kind: "allow-list" };
			return { ok: false, error: "/aux disallow 需要一个目录参数" };
		}
		if (tokens.length > 2) return { ok: false, error: `${first} 只接受一个目录参数` };
		return { ok: true, kind: first === "allow" ? "allow-add" : "allow-remove", directory: tokens[1] };
	}

	if (first === "vision" || first === "extract") {
		if (tokens.length !== 2) {
			return { ok: false, error: `/aux ${first} 需要一个模型（<provider>/<id>）或 default` };
		}
		const role = first;
		const target = tokens[1];
		if (target === "default") {
			return { ok: true, kind: "role-default", role };
		}
		const modelRef = splitProviderId(target);
		if (!modelRef) {
			return { ok: false, error: `模型参数必须是 provider/id（含斜杠），收到 "${target}"` };
		}
		return { ok: true, kind: "role-set", role, provider: modelRef.provider, id: modelRef.id };
	}

	if (first === "policy") {
		// v9：/aux policy roots|unrestricted
		if (tokens.length !== 2 || (tokens[1] !== "roots" && tokens[1] !== "unrestricted")) {
			return { ok: false, error: `/aux policy 需要一个取值：roots（限目录）或 unrestricted（不限目录）` };
		}
		return { ok: true, kind: "policy-set", policy: tokens[1] };
	}

	return { ok: false, error: `未知子命令 "${first}"；可用：status、vision、extract、allow、disallow、policy` };
}

/**
 * 构建状态条文本与 /aux 诊断文本（v8 §8）。
 * 标记：! 错误、× 关闭、* 作用域外或断言能力。
 */
export function buildStatusText({ config, visionRoute, extractRoute, scopedIds, mode = "widget" }) {
	const mark = (roleName, route) => {
		if (!route?.ok) {
			if (route?.code === "ROLE_DISABLED" || !config.enabled || !config.roles[roleName]?.enabled) return "× 已关闭";
			return "! 错误";
		}
		const name = `${route.model.provider}/${route.model.id}`;
		const star = scopedIds?.has(name) ? "" : " *";
		const assert = route.assertedImageCapability ? " (断言)" : "";
		if (route.reason === "vision-fallback") return `回退 ${name}${star}${assert}`;
		if (route.reason === "pinned") return `固定 ${name}${star}${assert}`;
		return `主模型 ${name}${star}`;
	};
	// v9：pathPolicy 可见标记（无边界可以，但不能是悄悄的）
	const policyMark = config.roles.vision.pathPolicy === "unrestricted" ? " · 目录限制:关" : "";
	if (mode === "widget") {
		// footer 扩展状态行：紧凑，主模型不重复（footer 右侧已显示），各角色 | 分隔
		const roleLine = (role, route) => {
			const label = role === "vision" ? "看图" : "压长文";
			if (route?.ok && route.reason === "default-main") return `${label}: 跟随主模型`;
			return `${label}: ${mark(role, route)}`;
		};
		return [roleLine("vision", visionRoute) + policyMark, roleLine("extract", extractRoute)];
	}
	// 诊断模式：主模型首行 + 各角色逐行（保留原始长名）+ pathPolicy 行
	const mainSourceDiag = [visionRoute, extractRoute].find((r) => r?.ok && r.reason === "default-main");
	const mainNameDiag = mainSourceDiag ? `${mainSourceDiag.model.provider}/${mainSourceDiag.model.id}` : undefined;
	const diagLines = [];
	if (mainNameDiag) diagLines.push(`主模型 ${mainNameDiag}`);
	diagLines.push(`看图 vision:    ${mark("vision", visionRoute)}`);
	diagLines.push(`压长文 extract: ${mark("extract", extractRoute)}`);
	diagLines.push(`目录限制 pathPolicy: ${config.roles.vision.pathPolicy === "unrestricted" ? "关闭 (unrestricted)" : "启用 (roots)"}`);
	return diagLines;
}
export function buildModelCandidates({
	role, models, scopedModelIds, assert = false,
}) {
	const scoped = scopedModelIds instanceof Set ? scopedModelIds : new Set(scopedModelIds ?? []);
	return (models ?? [])
		.map((model) => {
			const name = `${model.provider}/${model.id}`;
			const hasImage = Array.isArray(model.input) && model.input.includes("image");
			const visionOk = role === "vision" ? hasImage || assert : true;
			if (!visionOk) return null;
			const outOfScope = !scoped.has(name);
			return {
				value: name,
				label: `${name}${outOfScope ? " *" : ""}`,
				description: hasImage ? "支持图片" : "仅文本",
				selectable: true, // 未鉴权由调用方在 UI 层禁用
				outOfScope,
				textOnly: !hasImage,
			};
		})
		.filter((entry) => entry !== null);
}