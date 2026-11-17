import { useEffect, useRef, useState } from 'react';
import type { UiExtensionElement, UiExtensionSnapshot } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { Icon, isKnownIcon } from './Icons';
import { HoverTooltip } from './HoverTooltip';

/**
 * Fills the top-bar extension slot with declarative buttons from
 * ~/.pi/desktop-ui/extensions.json. Like every renderer surface, the bridge
 * comes from the chat store. Actions execute where they belong: 'prompt' goes
 * through the store's send pipeline (slash commands, busy queuing) and
 * 'command' through the workspace terminal on the renderer side, 'url'/'script'
 * reach the main process via invokeUiExtension. No element can ship code —
 * icons come from the built-in set and unknown names fall back to a default glyph.
 */
export function TopBarExtensions() {
	const { t } = useT();
	const bridge = useChatStore((state) => state.bridge);
	const send = useChatStore((state) => state.send);
	const sessionId = useChatStore((state) => state.sessionId);
	const [snapshot, setSnapshot] = useState<UiExtensionSnapshot | null>(null);
	const [failedId, setFailedId] = useState<string | null>(null);
	const failureTimer = useRef<number | null>(null);

	useEffect(() => {
		// Older bridge mocks in fixtures lack the feature; an empty slot stays invisible.
		if (!bridge?.getUiExtensions || !bridge.onUiExtensionsChanged) {
			setSnapshot(null);
			return;
		}
		let mounted = true;
		void bridge.getUiExtensions().then((loaded) => {
			if (mounted) setSnapshot(loaded);
		}).catch(() => { /* Slot stays empty; the error is visible in the main-process log. */ });
		const unsubscribe = bridge.onUiExtensionsChanged((snapshot) => setSnapshot(snapshot));
		return () => {
			mounted = false;
			unsubscribe();
		};
	}, [bridge]);

	const elements = (snapshot?.elements ?? []).filter((element) => element.slot === 'top-bar');
	if (!bridge || !elements.length) return null;

	const markFailed = (elementId: string) => {
		setFailedId(elementId);
		if (failureTimer.current) clearTimeout(failureTimer.current);
		failureTimer.current = window.setTimeout(() => setFailedId(null), 4000);
	};

	const invoke = (element: UiExtensionElement) => {
		void (async () => {
			try {
				if (element.action.type === 'prompt') {
					// The send pipeline handles preparation, slash commands and busy queuing;
					// a failed send throws and lands in the failure state below.
					await send(element.action.value);
				} else if (element.action.type === 'command') {
					await bridge.startWorkspaceCommand(element.action.value);
				} else {
					await bridge.invokeUiExtension({ elementId: element.id });
				}
			} catch (error) {
				console.error(`[ui-extensions] ${element.id} failed:`, error);
				markFailed(element.id);
			}
		})();
	};

	return <>{elements.map((element) => {
		const needsSession = element.action.type === 'prompt' || element.action.type === 'command';
		const disabled = needsSession && !sessionId;
		const failed = failedId === element.id;
		return (
			<HoverTooltip key={element.id} title={disabled ? t('uiext.needSession') : element.label}>
				<button type="button" className={`pd-topbar-ext-button${failed ? ' is-failed' : ''}`} aria-label={element.label} disabled={disabled} onClick={() => invoke(element)}>
					<Icon name={failed ? 'alert' : isKnownIcon(element.icon) ? element.icon : 'spark'} width="16" height="16" />
				</button>
			</HoverTooltip>
		);
	})}</>;
}
