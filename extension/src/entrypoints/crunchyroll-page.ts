import type { VideoDataSubtitleTrackDef } from '@project/common';

import { inferTracksFromInterceptedMpdViaXMLHTTPRequest } from '@/pages/mpd-util';
import { extractExtension, languageDisplayName, poll } from '@/pages/util';
import type { CrunchyrollEpisodeMetadata } from '@/pages/crunchyroll-util';
import {
    collectCrunchyrollEpisodeMetadata,
    crunchyrollEpisodeIdFromPlaybackUrl,
    crunchyrollEpisodeInfoRequestEvent,
    crunchyrollEpisodeInfoResponseEvent,
    crunchyrollEpisodeMetadataFromJsonLd,
    crunchyrollWatchIdFromPath,
} from '@/pages/crunchyroll-util';

export default defineUnlistedScript(() => {
    const playbackUrlRegex = /\/playback\/v3\/.*\/play(?:\?|$)/i;
    const mpdUrlRegex = /manifest\.mpd(?:\?|$)/i;
    const timedTextLanguagesUrlRegex = /timed_text_languages/i;
    const contentApiUrlRegex = /\/content\/v2\//i;
    const originalJsonParse = JSON.parse; // inferTracks may override JSON.parse
    const languageTitles = new Map<string, string>();
    const episodeMetadataById = new Map<string, CrunchyrollEpisodeMetadata>();
    const maxCachedEpisodeMetadata = 200;
    let lastPlaybackEpisodeId: string | undefined;

    function currentBasename(): string {
        return document.title.replace(/\s*-\s*Watch on Crunchyroll\s*$/i, '').trim();
    }

    function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            return undefined;
        }

        return value as Record<string, unknown>;
    }

    function captureLanguageTitles(value: unknown): void {
        const titles = recordFromUnknown(value);
        if (titles === undefined) return;
        for (const [language, title] of Object.entries(titles)) {
            if (typeof title === 'string') languageTitles.set(language, title);
        }
    }

    function captureLanguageTitlesFromText(text: string): void {
        try {
            captureLanguageTitles(originalJsonParse(text));
        } catch {
            // Ignore non-JSON language-title responses.
        }
    }

    function languageLabel(language: string): string {
        return languageTitles.get(language) ?? languageDisplayName(language);
    }

    /*
     * Episode metadata (series/season/episode) is captured from Crunchyroll's content API
     * responses so that show detection does not depend on the page's DOM.
     */
    function captureEpisodeMetadata(value: unknown): void {
        for (const metadata of collectCrunchyrollEpisodeMetadata(value)) {
            episodeMetadataById.delete(metadata.id);
            episodeMetadataById.set(metadata.id, metadata);
        }

        while (episodeMetadataById.size > maxCachedEpisodeMetadata) {
            const oldestId = episodeMetadataById.keys().next().value;

            if (oldestId === undefined) {
                break;
            }

            episodeMetadataById.delete(oldestId);
        }
    }

    function captureEpisodeMetadataFromText(text: string): void {
        try {
            captureEpisodeMetadata(originalJsonParse(text));
        } catch {
            // Ignore non-JSON content responses.
        }
    }

    function currentEpisodeId(): string | undefined {
        return crunchyrollWatchIdFromPath(window.location.pathname) ?? lastPlaybackEpisodeId;
    }

    function episodeMetadataFromJsonLd(id: string): CrunchyrollEpisodeMetadata | undefined {
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
            try {
                const metadata = crunchyrollEpisodeMetadataFromJsonLd(originalJsonParse(script.textContent ?? ''));

                if (metadata?.id === id) {
                    return metadata;
                }
            } catch {
                // Ignore malformed JSON-LD.
            }
        }

        return undefined;
    }

    function currentEpisodeMetadata(): CrunchyrollEpisodeMetadata | undefined {
        const id = currentEpisodeId();

        if (id === undefined) {
            return undefined;
        }

        return episodeMetadataById.get(id) ?? episodeMetadataFromJsonLd(id);
    }

    function listenForEpisodeInfoRequests(): void {
        document.addEventListener(
            crunchyrollEpisodeInfoRequestEvent,
            () => {
                void (async () => {
                    // Metadata may still be in flight right after a soft navigation
                    if (currentEpisodeMetadata() === undefined) {
                        await poll(() => currentEpisodeMetadata() !== undefined, 3000);
                    }

                    document.dispatchEvent(
                        new CustomEvent(crunchyrollEpisodeInfoResponseEvent, {
                            detail: currentEpisodeMetadata(),
                        })
                    );
                })();
            },
            false
        );
    }

    /*
     * Extracts the regular ASS subtitle tracks from the
     * /playback/v3/.../play response.
     */
    function inspectPlaybackJson(
        value: unknown,
        addTrack: (track: VideoDataSubtitleTrackDef) => void,
        setBasename: (basename: string) => void
    ): void {
        const root = recordFromUnknown(value);

        if (root === undefined) {
            return;
        }

        // Content API responses parsed via JSON.parse also flow through here
        captureEpisodeMetadata(root);

        const data = recordFromUnknown(root.data);
        const subtitles = recordFromUnknown(root.subtitles ?? data?.subtitles);

        if (subtitles === undefined) {
            return;
        }

        let foundTrack = false;

        for (const [key, rawTrack] of Object.entries(subtitles)) {
            if (key.toLowerCase() === 'none') {
                continue;
            }

            const track = recordFromUnknown(rawTrack);

            if (track === undefined) {
                continue;
            }

            const url = typeof track.url === 'string' ? track.url : undefined;
            const language = typeof track.language === 'string' ? track.language : key;
            const extension =
                typeof track.format === 'string' ? track.format.toLowerCase().replace(/^\./, '') : undefined;

            if (url === undefined || extension === undefined || language.toLowerCase() === 'none') {
                continue;
            }

            addTrack({
                label: languageLabel(language),
                language,
                url,
                extension,
            });

            foundTrack = true;
        }

        if (foundTrack) {
            setBasename(currentBasename());
        }
    }

    /*
     * Crunchyroll may parse playback responses through Response.json(),
     * which does not necessarily call the page's JSON.parse implementation.
     * Parse a cloned response so the shared inferTracks onJson hook sees it.
     */
    function interceptResponses(): void {
        const originalFetch = window.fetch;
        const originalXhrOpen = window.XMLHttpRequest.prototype.open;

        window.fetch = function (...args: Parameters<typeof originalFetch>) {
            const [input] = args;

            let requestUrl = '';

            try {
                requestUrl =
                    typeof input === 'string'
                        ? new URL(input, window.location.href).href
                        : input instanceof URL
                          ? input.href
                          : input.url;
            } catch {
                requestUrl = '';
            }

            const responsePromise = originalFetch.call(this, ...args);

            if (timedTextLanguagesUrlRegex.test(requestUrl)) {
                void responsePromise
                    .then((response) => response.clone().json())
                    .then(captureLanguageTitles)
                    .catch(() => {
                        // Subtitle detection must never interfere with playback.
                    });
            }

            if (contentApiUrlRegex.test(requestUrl)) {
                void responsePromise
                    .then((response) => response.clone().text())
                    .then(captureEpisodeMetadataFromText)
                    .catch(() => {
                        // Subtitle detection must never interfere with playback.
                    });
            }

            if (playbackUrlRegex.test(requestUrl)) {
                lastPlaybackEpisodeId = crunchyrollEpisodeIdFromPlaybackUrl(requestUrl) ?? lastPlaybackEpisodeId;
                void responsePromise
                    .then((response) => response.clone().text())
                    .then((text) => {
                        try {
                            JSON.parse(text);
                        } catch {
                            // Ignore non-JSON playback responses.
                        }
                    })
                    .catch(() => {
                        // Subtitle detection must never interfere with playback.
                    });
            }

            return responsePromise;
        };

        window.XMLHttpRequest.prototype.open = function (...args: unknown[]) {
            const url = args[1];

            if (typeof url === 'string' && playbackUrlRegex.test(url)) {
                lastPlaybackEpisodeId = crunchyrollEpisodeIdFromPlaybackUrl(url) ?? lastPlaybackEpisodeId;
            }

            if (typeof url === 'string' && contentApiUrlRegex.test(url)) {
                this.addEventListener(
                    'load',
                    () => {
                        if (this.responseType === 'json') {
                            captureEpisodeMetadata(this.response);
                        } else {
                            try {
                                if (typeof this.responseText === 'string') {
                                    captureEpisodeMetadataFromText(this.responseText);
                                }
                            } catch {
                                // responseText is unavailable for some response types.
                            }
                        }
                    },
                    { once: true }
                );
            }

            if (typeof url === 'string' && timedTextLanguagesUrlRegex.test(url)) {
                this.addEventListener(
                    'load',
                    () => {
                        if (this.responseType === 'json') {
                            captureLanguageTitles(this.response);
                        } else {
                            try {
                                if (typeof this.responseText === 'string') {
                                    captureLanguageTitlesFromText(this.responseText);
                                }
                            } catch {
                                // responseText is unavailable for some response types.
                            }
                        }
                    },
                    { once: true }
                );
            }

            // @ts-expect-error: forwarding original XHR arguments
            originalXhrOpen.apply(this, args);
        };
    }

    inferTracksFromInterceptedMpdViaXMLHTTPRequest(
        mpdUrlRegex,
        (playlist, language) => {
            const segmentUrls = playlist.segments.map((segment) => segment.resolvedUri);
            const url = segmentUrls.length > 0 ? segmentUrls : playlist.resolvedUri;
            const extensionSource = segmentUrls[0] ?? playlist.resolvedUri;
            const baseLabel = languageLabel(language);

            return {
                label: `${baseLabel} [CC]`,
                language,
                url,
                extension: extractExtension(extensionSource, 'vtt'),
            };
        },
        {
            basename: currentBasename,
            onJson: inspectPlaybackJson,
        }
    );

    interceptResponses();
    listenForEpisodeInfoRequests();
});
