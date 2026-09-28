// Only cue timing is needed for edition matching; subtitle dialogue is never
// sent to the selector. Accept SRT and ASS without depending on the player UI.
export const subtitleEndSeconds = (text: string): number | undefined => {
    const timestamp = '(\\d{1,3}):([0-5]\\d):([0-5]\\d)[.,](\\d{1,3})';
    const patterns = [
        new RegExp(`^\\s*${timestamp}\\s*-->\\s*${timestamp}`, 'gm'),
        new RegExp(`^Dialogue:\\s*[^,]*,${timestamp},${timestamp},`, 'gmi'),
    ];
    let end: number | undefined;
    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
            const seconds =
                Number(match[5]) * 3600 + Number(match[6]) * 60 + Number(match[7]) + Number(`0.${match[8]}`);
            end = Math.max(end ?? 0, seconds);
        }
    }
    return end;
};

export const fetchSubtitleEndSeconds = async ({ url }: { url: string }): Promise<number | undefined> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
        if (!response.ok) throw new Error(`Subtitle timing request failed: ${response.status}`);
        return subtitleEndSeconds(await response.text());
    } finally {
        clearTimeout(timeout);
    }
};
