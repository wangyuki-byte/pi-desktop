import { spawn } from 'node:child_process';
import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseUiExtensionConfig, type UiExtensionElement, type UiExtensionSnapshot } from '@pidesktop/shared';
import { getAppLocale } from './appLocale';
import { openExternalHttpUrl } from './externalLinks';

export interface UiExtensionsServiceOptions {
	/** Injected for tests; defaults to the real user home directory. */
	homeDir?: string;
	/** Pushes a fresh snapshot to every renderer; wired to broadcastToRenderers in ipc.ts. */
	broadcast: (snapshot: UiExtensionSnapshot) => void;
}

const REFRESH_DEBOUNCE_MS = 300;
const SNAPSHOT_CHANGE_DEBOUNCE_MS = 400;

export interface UiExtensionsService {
	start(): void;
	stop(): void;
	getSnapshot(): UiExtensionSnapshot;
	/** Executes the main-process half of an element action ('url' | 'script'); 'prompt' and 'command' are renderer-side. */
	invoke(elementId: string): Promise<void>;
}

/**
 * Loads `~/.pi/desktop-ui/extensions.json`, watches it for edits and executes
 * whitelisted actions. Elements are pure data (see packages/shared/uiExtensions);
 * this service never evaluates third-party code beyond launching the user's own
 * script files, which must live inside ~/.pi/desktop-ui/scripts/.
 */
export function createUiExtensionsService(options: UiExtensionsServiceOptions): UiExtensionsService {
	const home = options.homeDir ?? homedir();
	const root = join(home, '.pi', 'desktop-ui');
	const configFile = join(root, 'extensions.json');
	const scriptsDir = join(root, 'scripts');
	let watcher: FSWatcher | null = null;
	let refreshTimer: NodeJS.Timeout | null = null;
	let broadcastTimer: NodeJS.Timeout | null = null;
	let lastSnapshot: UiExtensionSnapshot = { version: 1, elements: [], error: null };
	let lastBroadcastJson = '';

	function readSnapshot(): UiExtensionSnapshot {
		let raw: string;
		try {
			raw = readFileSync(configFile, 'utf8');
		} catch (error) {
			// An absent config is a healthy empty state; only existing-but-unreadable files surface diagnostics.
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, elements: [], error: null };
			return { version: 1, elements: [], error: `无法读取 UI 扩展配置：${(error as Error).message}` };
		}
		try {
			const parsed = parseUiExtensionConfig(JSON.parse(raw));
			return { version: 1, elements: parsed.elements, error: parsed.error };
		} catch (error) {
			return { version: 1, elements: [], error: `UI 扩展配置不是合法 JSON：${(error as Error).message}` };
		}
	}

	function scheduleRefresh(): void {
		refreshTimer ??= setTimeout(() => {
			refreshTimer = null;
			refresh();
		}, REFRESH_DEBOUNCE_MS);
	}

	function refresh(): void {
		const snapshot = readSnapshot();
		if (snapshot.error) console.warn('[ui-extensions]', snapshot.error);
		// lastSnapshot updates synchronously: invoke() and getSnapshot() must see the current file
		// even when a renderer fires between the watcher debounce and the broadcast debounce.
		lastSnapshot = snapshot;
		// fs.watch fires in bursts; collapse them so renderers only see settled snapshots.
		if (JSON.stringify(snapshot) === lastBroadcastJson) return;
		broadcastTimer ??= setTimeout(() => {
			broadcastTimer = null;
			options.broadcast(lastSnapshot);
			lastBroadcastJson = JSON.stringify(lastSnapshot);
		}, SNAPSHOT_CHANGE_DEBOUNCE_MS);
	}

	function startWatching(): void {
		const piDir = join(home, '.pi');
		try {
			watcher = watch(piDir, { recursive: true, persistent: false }, (_event, filename) => {
				if (filename && !String(filename).includes('desktop-ui')) return;
				scheduleRefresh();
			});
		} catch {
			// recursive is unsupported on Linux; fall back to a flat watch that still
			// notices the desktop-ui directory itself being created or renamed.
			try {
				watcher = watch(piDir, { persistent: false }, (_event, filename) => {
					if (filename && !String(filename).includes('desktop-ui')) return;
					scheduleRefresh();
				});
			} catch {
				// Watching is best-effort; the startup read still applies.
			}
		}
	}

	async function notifyScriptFailure(element: UiExtensionElement, detail: string): Promise<void> {
		const message = detail.slice(0, 300);
		// Loaded on demand: the static import chain must stay free of electron so
		// fixture tests that mock a minimal electron module keep loading ipc.ts.
		try {
			const { Notification } = await import('electron');
			if (!Notification.isSupported?.()) {
				console.error(`[ui-extensions] script failed: ${element.id}: ${message}`);
				return;
			}
			const english = getAppLocale() === 'en-US';
			new Notification({
				title: english ? `Script failed: ${element.label}` : `脚本执行失败：${element.label}`,
				body: message,
				silent: false,
			}).show();
		} catch {
			// Headless/test environments without a usable electron fall back to the log.
			console.error(`[ui-extensions] script failed: ${element.id}: ${message}`);
		}
	}

	function runScript(element: UiExtensionElement): void {
		// parseUiExtensionConfig guarantees a relative path without '..' or drive letters,
		// so resolving inside scriptsDir can never escape it — no second check needed here.
		const resolved = resolve(scriptsDir, element.action.value);
		// cmd /s /c handles quoted paths and .cmd/.bat without Node's shell quoting rules;
		// other platforms exec the file directly (shebang or exec bit is the user's business).
		const child = process.platform === 'win32'
			? spawn('cmd.exe', ['/d', '/s', '/c', resolved], { cwd: scriptsDir, windowsHide: true, stdio: 'ignore' })
			: spawn(resolved, [], { cwd: scriptsDir, stdio: 'ignore' });
		child.on('error', (error) => notifyScriptFailure(element, error.message));
		child.on('exit', (code) => {
			if (code !== 0) notifyScriptFailure(element, `退出码 ${code}`);
		});
	}

	return {
		start() {
			refresh();
			startWatching();
		},
		stop() {
			if (refreshTimer) clearTimeout(refreshTimer);
			if (broadcastTimer) clearTimeout(broadcastTimer);
			if (watcher) watcher.close();
			refreshTimer = null;
			broadcastTimer = null;
			watcher = null;
		},
		getSnapshot() {
			return lastSnapshot;
		},
		async invoke(elementId) {
			// Re-read on invoke: a renderer may fire shortly after a config edit, before the watcher debounce lands, so lastSnapshot alone would wrongly reject.
			const element = readSnapshot().elements.find((candidate) => candidate.id === elementId);
			if (!element) throw new Error('UI 元素不存在或刚被移除，请检查 ~/.pi/desktop-ui/extensions.json');
			if (element.action.type === 'url') openExternalHttpUrl(element.action.value);
			else if (element.action.type === 'script') runScript(element);
			else throw new Error('该动作类型由会话侧执行，不应到达主进程');
		},
	};
}
