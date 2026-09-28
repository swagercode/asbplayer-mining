import { useCallback, useEffect, useRef, useState } from 'react';
import { initialGlobalState } from '@project/common/global-state';
import type { OnlineSubtitleSourceConfig } from '@project/common/global-state';
import { ExtensionGlobalStateProvider } from '@/services/extension-global-state-provider';

const provider = new ExtensionGlobalStateProvider();

// Shared by the options page and toolbar popup. Keep each keystroke out of React's
// state updater so StrictMode cannot repeat storage writes.
export const useOnlineSubtitleSourceConfig = () => {
    const [config, setConfig] = useState(initialGlobalState.onlineSubtitleSourceConfig);
    const configRef = useRef(config);

    useEffect(() => {
        let active = true;
        const update = (value: OnlineSubtitleSourceConfig) => {
            if (active) {
                configRef.current = value;
                setConfig(value);
            }
        };
        const listener = (changes: Record<string, Browser.storage.StorageChange>, area: string) => {
            if (area === 'local' && changes.onlineSubtitleSourceConfig?.newValue) {
                update(changes.onlineSubtitleSourceConfig.newValue as OnlineSubtitleSourceConfig);
            }
        };
        browser.storage.onChanged.addListener(listener);
        void provider.get(['onlineSubtitleSourceConfig']).then((state) => update(state.onlineSubtitleSourceConfig));
        return () => {
            active = false;
            browser.storage.onChanged.removeListener(listener);
        };
    }, []);

    const onConfigChanged = useCallback((partial: Partial<OnlineSubtitleSourceConfig>) => {
        const next = { ...configRef.current, ...partial };
        configRef.current = next;
        setConfig(next);
        void provider.set({ onlineSubtitleSourceConfig: next });
    }, []);

    return { onlineSubtitleSourceConfig: config, onOnlineSourceConfigChanged: onConfigChanged };
};
