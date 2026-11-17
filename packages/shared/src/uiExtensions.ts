/**
 * Desktop UI extension protocol: declarative elements contributed by the
 * user's `~/.pi/desktop-ui/extensions.json` (and later by running pi
 * extensions), rendered into reserved extension slots such as the top bar.
 *
 * Elements are data-only by design: the desktop executes a fixed whitelist of
 * action types and never evaluates third-party UI code, so a config file can
 * add buttons but cannot run arbitrary renderer payloads.
 */

export type UiExtensionSlot = 'top-bar';
export type UiExtensionActionType = 'prompt' | 'command' | 'url' | 'script';

export interface UiExtensionAction {
	type: UiExtensionActionType;
	/** prompt text, terminal command, http(s) URL, or a relative path inside ~/.pi/desktop-ui/scripts/. */
	value: string;
}

export interface UiExtensionElement {
	/** Unique within the snapshot; the renderer sends it back when invoking. */
	id: string;
	slot: UiExtensionSlot;
	/** Icon name from the renderer's built-in set; unknown names fall back to 'spark'. */
	icon: string;
	/** Tooltip and aria-label text provided by the config author. */
	label: string;
	/** Sort key among elements of the same slot; ties break by id. */
	order: number;
	/** 'config' for the user's extensions.json; 'extension:<id>' is reserved for the runtime bridge. */
	source: string;
	action: UiExtensionAction;
}

export interface UiExtensionSnapshot {
	version: 1;
	elements: UiExtensionElement[];
	/** Human-readable diagnostics when the config file exists but is invalid; null when healthy or absent. */
	error: string | null;
}

export interface UiExtensionInvokeRequest {
	elementId: string;
}

const ACTION_TYPES: readonly UiExtensionActionType[] = ['prompt', 'command', 'url', 'script'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_ELEMENTS = 32;
const MAX_LABEL_LENGTH = 64;
const MAX_VALUE_LENGTH = 8000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseElement(raw: unknown, index: number): UiExtensionElement | string {
	if (!isPlainObject(raw)) return `元素 #${index + 1} 必须是对象`;
	const { id, slot, icon, label, order, source, action } = raw;
	if (typeof id !== 'string' || !ID_PATTERN.test(id)) return `元素 #${index + 1} 的 id 必须匹配字母开头的 [A-Za-z0-9._-]，长度 1-64`;
	if (slot !== 'top-bar') return `元素 ${id} 的 slot 暂只支持 "top-bar"`;
	if (typeof icon !== 'string' || !icon || icon.length > 32) return `元素 ${id} 的 icon 必须是 1-32 字符的内置图标名`;
	if (typeof label !== 'string' || !label.trim() || label.length > MAX_LABEL_LENGTH) return `元素 ${id} 的 label 必须是 1-${MAX_LABEL_LENGTH} 字符`;
	if (source !== undefined && source !== 'config') return `元素 ${id} 的 source 只能是 "config"`;
	if (!isPlainObject(action)) return `元素 ${id} 缺少 action 对象`;
	if (typeof action.type !== 'string' || !ACTION_TYPES.includes(action.type as UiExtensionActionType)) {
		return `元素 ${id} 的 action.type 必须是 ${ACTION_TYPES.join(' / ')} 之一`;
	}
	// The includes guard above makes this assertion safe; TS cannot narrow through Array.includes.
	const actionType = action.type as UiExtensionActionType;
	const { value } = action;
	if (typeof value !== 'string' || !value.trim() || value.length > MAX_VALUE_LENGTH) {
		return `元素 ${id} 的 action.value 必须是 1-${MAX_VALUE_LENGTH} 字符`;
	}
	if (actionType === 'url') {
		// Protocol-level check is intentionally shallow (the shared package has no DOM lib for URL);
		// the strict parse happens in the main process via openExternalHttpUrl before anything opens.
		if (!/^https?:\/\/\S+$/i.test(value)) return `元素 ${id} 的 url 必须是 http/https 地址`;
	}
	if (actionType === 'script') {
		// Scripts must live inside ~/.pi/desktop-ui/scripts/; reject absolute paths,
		// drive letters and traversal before the main process resolves anything.
		if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\')) return `元素 ${id} 的 script 必须是 scripts 目录内的相对路径`;
		if (value.split(/[\\/]/).includes('..')) return `元素 ${id} 的 script 路径不允许 ".."`;
	}
	const resolvedOrder = order === undefined ? (index + 1) * 10 : order;
	if (typeof resolvedOrder !== 'number' || !Number.isFinite(resolvedOrder)) return `元素 ${id} 的 order 必须是数字`;
	return {
		id,
		slot,
		icon,
		label,
		order: resolvedOrder,
		source: source ?? 'config',
		action: { type: actionType, value },
	};
}

export interface UiExtensionConfigParseResult {
	elements: UiExtensionElement[];
	error: string | null;
}

/** Parses and validates one extensions.json payload; healthy-but-absent elements arrays are allowed. */
export function parseUiExtensionConfig(value: unknown): UiExtensionConfigParseResult {
	if (!isPlainObject(value)) return { elements: [], error: '配置根节点必须是对象' };
	if (value.elements === undefined) return { elements: [], error: null };
	if (!Array.isArray(value.elements)) return { elements: [], error: 'elements 必须是数组' };
	if (value.elements.length > MAX_ELEMENTS) return { elements: [], error: `最多支持 ${MAX_ELEMENTS} 个 UI 元素` };
	const elements: UiExtensionElement[] = [];
	const seenIds = new Set<string>();
	for (const [index, raw] of value.elements.entries()) {
		const parsed = parseElement(raw, index);
		if (typeof parsed === 'string') return { elements: [], error: parsed };
		if (seenIds.has(parsed.id)) return { elements: [], error: `元素 id 重复：${parsed.id}` };
		seenIds.add(parsed.id);
		elements.push(parsed);
	}
	elements.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
	return { elements, error: null };
}
