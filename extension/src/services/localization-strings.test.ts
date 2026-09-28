import { mergeLocalizationStrings } from '@project/extension/src/services/localization-strings';

it('preserves cached translations while supplying new nested settings from the build', () => {
    const bundled = { settings: { jimaku: 'Jimaku', existing: 'Bundled' }, newSection: { hint: 'New hint' } };
    const cached = { settings: { existing: 'Updated translation' }, remote: 'Remote only' };
    expect(mergeLocalizationStrings(bundled, cached)).toEqual({
        settings: { jimaku: 'Jimaku', existing: 'Updated translation' },
        newSection: { hint: 'New hint' },
        remote: 'Remote only',
    });
    expect(bundled.settings.existing).toBe('Bundled');
});
