import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ERROR_CODES } from "./auxiliary-models-core.mjs";

export function sniffImageMime(bytes) {
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	return undefined;
}
function inside(root, candidate) { const value = relative(root, candidate); return value === "" || (!value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && value !== ".." && !isAbsolute(value)); }

/**
 * 读取、嗅探 MIME、先缩放再判上限（v8 §10）。
 * - 范围内读取失败 → IMAGE_NOT_FOUND（附错误类别，不附堆栈）
 * - 文件头不是受支持类型 → IMAGE_UNSUPPORTED_TYPE
 * - 缩放后仍超上限 → IMAGE_TOO_LARGE
 */
async function finishImage(actualPath, resizeImage, maxImageBytes) {
	let bytes;
	try { bytes = await readFile(actualPath); } catch (error) {
		const category = error && typeof error === "object" && typeof error.code === "string" ? error.code : "READ";
		return { ok: false, code: ERROR_CODES.IMAGE_NOT_FOUND, errorKind: category };
	}
	const mimeType = sniffImageMime(bytes);
	if (!mimeType) return { ok: false, code: ERROR_CODES.IMAGE_UNSUPPORTED_TYPE };
	let resized;
	try { resized = await resizeImage(bytes, mimeType, { maxWidth: 2000, maxHeight: 2000, maxBytes: maxImageBytes }); } catch { return { ok: false, code: ERROR_CODES.IMAGE_TOO_LARGE }; }
	if (!resized || Buffer.byteLength(resized.data, "base64") > maxImageBytes) return { ok: false, code: ERROR_CODES.IMAGE_TOO_LARGE };
	return { ok: true, image: { type: "image", mimeType: resized.mimeType, data: resized.data }, metadata: { path: actualPath, width: resized.width, height: resized.height, wasResized: resized.wasResized } };
}

/**
 * 越界图片的一次性放行（v8 §10）：不做自动复制，确认后直接读取。
 * 放行只对本次调用有效，不写配置、不跨调用记忆。
 * v9：pathPolicy = "unrestricted" 时跳过目录判定（不做确认），其余校验链照常。
 */
export async function prepareImage({
	imagePath, cwd, allowedRoots, maxImageBytes, resizeImage,
	pathPolicy = "roots",
	// TUI 模式的确认回调；非 TUI 无 UI 时应传 undefined，越界一律拒绝
	confirmOutOfRoot,
}) {
	let actualPath;
	try {
		actualPath = await realpath(resolve(cwd, imagePath));
	} catch {
		// 路径解析不到（文件不存在 / 无法访问）→ IMAGE_NOT_FOUND
		return { ok: false, code: ERROR_CODES.IMAGE_NOT_FOUND };
	}
	if (pathPolicy === "unrestricted") {
		// v9：不做目录判定；图片内容照常经 finishImage 的完整校验链（MIME/缩放/上限）
		const result = await finishImage(actualPath, resizeImage, maxImageBytes);
		if (result.ok) result.metadata.outOfRoot = true; // 标记本次图片位于 allowedRoots 之外（无边界模式）
		return result;
	}
	let roots;
	try {
		roots = await Promise.all([realpath(cwd), ...allowedRoots.map((root) => realpath(resolve(cwd, root)))]);
	} catch {
		// allowedRoots 里有解析不到的目录：不拒绝整张图，回退到只允许 cwd
		roots = await Promise.all([realpath(cwd)]);
	}
	if (!roots.some((root) => inside(root, actualPath))) {
		// 真越界（含软链接绕路）→ IMAGE_OUT_OF_ROOT；TUI 模式先询问一次性放行
		if (confirmOutOfRoot && (await confirmOutOfRoot(actualPath))) {
			// 用户已确认，本次放行；直接读取，不做物理复制
			const result = await finishImage(actualPath, resizeImage, maxImageBytes);
			if (result.ok) result.metadata.outOfRoot = true;
			return result;
		}
		return { ok: false, code: ERROR_CODES.IMAGE_OUT_OF_ROOT };
	}
	return finishImage(actualPath, resizeImage, maxImageBytes);
}