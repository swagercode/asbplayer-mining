export interface LocalizationStrings {
    [key: string]: string | LocalizationStrings;
}

// A cached release translation can predate strings added by a local build.
// Keep its translations while filling missing keys from the bundled resource.
export const mergeLocalizationStrings = (
    bundled: LocalizationStrings,
    cached: LocalizationStrings
): LocalizationStrings => {
    const result = { ...bundled };
    for (const [key, value] of Object.entries(cached)) {
        const fallback = bundled[key];
        result[key] =
            typeof value === 'object' && value !== null && typeof fallback === 'object' && fallback !== null
                ? mergeLocalizationStrings(fallback, value)
                : value;
    }
    return result;
};
