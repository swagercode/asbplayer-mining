import { defaultSettings } from '@project/common/settings';
import type { SettingsProvider } from '@project/common/settings';
import type Binding from '@/services/binding';
import type VideoDataSyncController from '@project/extension/src/controllers/video-data-sync-controller';

const mockSelect = jest.fn();
const mockGet = jest.fn();
const mockSet = jest.fn();
const mockDisableNativeSubtitles = jest.fn();
const mockAutoSync = jest.fn();
const mockFrame = { hidden: true, unbind: jest.fn(), clientIfLoaded: undefined };
const mockPage = { config: { key: 'crunchyroll' }, canAutoSync: () => true, isVideoPage: () => true };

jest.mock('@project/extension/src/services/pages', () => ({ currentPageDelegate: async () => mockPage }));
jest.mock('@project/extension/src/services/ui-frame', () => ({ uiFrameForHtml: () => mockFrame }));
jest.mock('@project/extension/src/services/localization-fetcher', () => ({ fetchLocalization: jest.fn() }));
jest.mock('@/services/tutorial', () => ({ isOnTutorialPage: () => false }));
jest.mock('@/services/extension-global-state-provider', () => ({
    ExtensionGlobalStateProvider: class {
        get = mockGet;
        set = mockSet;
    },
}));
jest.mock('@/services/jimaku-auto-select-service', () => ({
    __esModule: true,
    default: class {
        selectForCurrentEpisode = mockSelect;
    },
}));
jest.mock('@/services/crunchyroll-native-subtitles', () => ({
    disableCrunchyrollNativeSubtitles: (...args: unknown[]) => mockDisableNativeSubtitles(...args),
}));
jest.mock('@/services/subtitle-auto-sync', () => ({
    autoSynchronizeSubtitles: (...args: unknown[]) => mockAutoSync(...args),
}));

const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
};

describe('automatic episode subtitle loading', () => {
    const originalFetch = globalThis.fetch;
    let controller: VideoDataSyncController;
    let loadSubtitles: jest.Mock;

    beforeEach(async () => {
        mockSelect.mockReset();
        mockGet.mockReset().mockResolvedValue({
            onlineSubtitleSourceConfig: { jimakuAutoSelect: true, jimakuApiKey: 'test' },
        });
        mockSet.mockReset().mockResolvedValue(undefined);
        mockDisableNativeSubtitles.mockReset().mockResolvedValue(true);
        mockAutoSync.mockReset().mockImplementation(async (files) => ({ files, aligned: false }));
        loadSubtitles = jest.fn().mockResolvedValue(undefined);
        const { default: Controller } = await import('@project/extension/src/controllers/video-data-sync-controller');
        controller = new Controller(
            { video: document.createElement('video'), hasPageScript: true, loadSubtitles } as unknown as Binding,
            {} as SettingsProvider
        );
        controller.updateSettings(defaultSettings);
        globalThis.fetch = jest.fn().mockResolvedValue({
            ok: true,
            arrayBuffer: async () => new Uint8Array([49, 10]).buffer,
        });
    });

    afterEach(() => {
        controller?.unbind();
        globalThis.fetch = originalFetch;
    });

    const emit = (basename: string) =>
        document.dispatchEvent(new CustomEvent('asbplayer-synced-data', { detail: { basename, subtitles: [] } }));
    const selection = (name: string) => ({
        entry: { id: 1, name },
        file: { name: `${name}.srt`, url: `https://jimaku.cc/${name}.srt` },
    });

    it('loads Jimaku subtitles without a picker even when native auto-sync is off', async () => {
        mockSelect.mockResolvedValue(selection('Episode 1'));
        await controller.requestSubtitles({ kind: 'reload', videoChanged: true });
        emit('Episode 1');
        await flush();
        expect(mockSelect).toHaveBeenCalledTimes(1);
        expect(loadSubtitles).toHaveBeenCalledTimes(1);
        expect(loadSubtitles.mock.calls[0][0][0].name).toContain('Episode 1');
        expect(controller.pickerVisible).toBe(false);
        expect(mockDisableNativeSubtitles).toHaveBeenCalledTimes(1);
    });

    it('starts only one selection when track events race while configuration loads', async () => {
        const config = deferred<unknown>();
        mockGet.mockReturnValue(config.promise);
        mockSelect.mockResolvedValue(selection('Episode 1'));
        await controller.requestSubtitles({ kind: 'reload', videoChanged: true });
        emit('Episode 1');
        emit('Episode 1');
        await flush();
        config.resolve({ onlineSubtitleSourceConfig: { jimakuAutoSelect: true } });
        await flush();
        expect(mockSelect).toHaveBeenCalledTimes(1);
        expect(loadSubtitles).toHaveBeenCalledTimes(1);
    });

    it('loads only the aligned Japanese file and requests a reset of the remembered offset', async () => {
        mockSelect.mockResolvedValue(selection('Episode 1'));
        mockAutoSync.mockImplementation(async (files) => ({ files, aligned: true }));
        await controller.requestSubtitles({ kind: 'reload', videoChanged: true });
        emit('Episode 1');
        await flush();
        expect(mockAutoSync).toHaveBeenCalledTimes(1);
        expect(loadSubtitles).toHaveBeenCalledTimes(1);
        expect(loadSubtitles.mock.calls[0][0]).toHaveLength(1);
        expect(loadSubtitles.mock.calls[0][3]).toBe(true);
        expect(mockDisableNativeSubtitles).toHaveBeenCalledTimes(1);
    });

    const releases = (episodeFiltered = true) => ({
        ...selection('Broadcast'),
        episodeFiltered,
        candidates: [selection('Broadcast').file, selection('Streaming').file],
    });

    it('tries an episode-matched release when the selected release fails timing validation', async () => {
        mockSelect.mockResolvedValue(releases());
        mockAutoSync
            .mockImplementationOnce(async (files) => ({ files, aligned: false, rejected: true }))
            .mockImplementationOnce(async (files) => ({ files, aligned: true }));
        await controller.requestSubtitles({ kind: 'reload', videoChanged: true });
        emit('Episode 1');
        await flush();
        expect(mockSelect).toHaveBeenCalledTimes(1);
        expect(mockAutoSync).toHaveBeenCalledTimes(2);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(loadSubtitles).toHaveBeenCalledTimes(1);
        expect(loadSubtitles.mock.calls[0][0]).toHaveLength(1);
        expect(loadSubtitles.mock.calls[0][0][0].name).toContain('Streaming');
        expect(loadSubtitles.mock.calls[0][3]).toBe(true);
        expect(controller.pickerVisible).toBe(false);
    });

    it.each(['unfiltered archive', 'unavailable timing reference'])(
        'avoids unsafe or futile fallback: %s',
        async (reason) => {
            mockSelect.mockResolvedValue(releases(reason !== 'unfiltered archive'));
            mockAutoSync.mockImplementation(async (files) => ({
                files,
                aligned: false,
                rejected: reason === 'unfiltered archive',
            }));
            await controller.requestSubtitles({ kind: 'reload', videoChanged: true });
            emit('Episode 1');
            await flush();
            expect(mockAutoSync).toHaveBeenCalledTimes(1);
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(loadSubtitles.mock.calls[0][0][0].name).toContain('Broadcast');
        }
    );

    it('keeps the selected file when no alternative passes the existing quality check', async () => {
        mockSelect.mockResolvedValue(releases());
        mockAutoSync.mockImplementation(async (files) => ({ files, aligned: false, rejected: true }));
        await controller.requestSubtitles({ kind: 'reload', videoChanged: true });
        emit('Episode 1');
        await flush();
        expect(mockAutoSync).toHaveBeenCalledTimes(2);
        expect(loadSubtitles).toHaveBeenCalledTimes(1);
        expect(loadSubtitles.mock.calls[0][0][0].name).toContain('Broadcast');
        expect(loadSubtitles.mock.calls[0][3]).toBe(false);
    });

    it('does not load an alternative alignment after episode navigation', async () => {
        const alignment = deferred<unknown>();
        mockSelect.mockResolvedValueOnce(releases()).mockResolvedValueOnce(selection('Episode 2'));
        mockAutoSync
            .mockImplementationOnce(async (files) => ({ files, aligned: false, rejected: true }))
            .mockReturnValueOnce(alignment.promise);
        await controller.requestSubtitles({ kind: 'reload', videoChanged: true });
        emit('Episode 1');
        await flush();
        expect(mockAutoSync).toHaveBeenCalledTimes(2);
        await controller.requestSubtitles({ kind: 'reload', videoChanged: true });
        emit('Episode 2');
        await flush();
        alignment.resolve({ files: mockAutoSync.mock.calls[1][0], aligned: true });
        await flush();
        expect(loadSubtitles).toHaveBeenCalledTimes(1);
        expect(loadSubtitles.mock.calls[0][0][0].name).toContain('Episode 2');
    });

    it('discards a late alignment when the episode changes', async () => {
        const alignment = deferred<unknown>();
        mockSelect.mockResolvedValueOnce(selection('Episode 1')).mockResolvedValueOnce(selection('Episode 2'));
        mockAutoSync.mockReturnValueOnce(alignment.promise);
        await controller.requestSubtitles({ kind: 'reload', videoChanged: true });
        emit('Episode 1');
        await flush();
        expect(mockAutoSync).toHaveBeenCalledTimes(1);
        await controller.requestSubtitles({ kind: 'reload', videoChanged: true });
        emit('Episode 2');
        await flush();
        alignment.resolve({ files: mockAutoSync.mock.calls[0][0], aligned: true });
        await flush();
        expect(loadSubtitles).toHaveBeenCalledTimes(1);
        expect(loadSubtitles.mock.calls[0][0][0].name).toContain('Episode 2');
    });

    it('drops the previous episode if navigation happens during its subtitle download', async () => {
        const download = deferred<ArrayBuffer>();
        mockSelect.mockResolvedValueOnce(selection('Episode 1')).mockResolvedValueOnce(selection('Episode 2'));
        (fetch as jest.Mock).mockResolvedValueOnce({ ok: true, arrayBuffer: () => download.promise });
        await controller.requestSubtitles({ kind: 'reload', videoChanged: true });
        emit('Episode 1');
        await flush();
        expect(fetch).toHaveBeenCalledTimes(1);
        await controller.requestSubtitles({ kind: 'reload', videoChanged: true });
        emit('Episode 2');
        await flush();
        download.resolve(new Uint8Array([49]).buffer);
        await flush();
        expect(loadSubtitles).toHaveBeenCalledTimes(1);
        expect(loadSubtitles.mock.calls[0][0][0].name).toContain('Episode 2');
    });

    it('turns off native captions before the model responds and cancels stale player interactions', async () => {
        mockSelect.mockReturnValue(new Promise(() => {}));
        await controller.requestSubtitles({ kind: 'reload', videoChanged: true });
        emit('Episode 1');
        await flush();
        const isFirstEpisodeCurrent = mockDisableNativeSubtitles.mock.calls[0][0];
        expect(isFirstEpisodeCurrent()).toBe(true);
        expect(loadSubtitles).not.toHaveBeenCalled();

        await controller.requestSubtitles({ kind: 'reload', videoChanged: true });
        emit('Episode 2');
        await flush();
        expect(isFirstEpisodeCurrent()).toBe(false);
        const isSecondEpisodeCurrent = mockDisableNativeSubtitles.mock.calls[1][0];
        expect(isSecondEpisodeCurrent()).toBe(true);
        controller.unbind();
        expect(isSecondEpisodeCurrent()).toBe(false);
    });
});
