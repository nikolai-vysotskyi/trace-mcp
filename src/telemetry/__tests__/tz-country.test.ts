import { describe, expect, it } from 'vitest';
import { countryForTimezone } from '../tz-country.js';

describe('countryForTimezone', () => {
  it('maps canonical zones to their ISO country', () => {
    expect(countryForTimezone('Europe/Berlin')).toBe('DE');
    expect(countryForTimezone('America/New_York')).toBe('US');
    expect(countryForTimezone('Asia/Tokyo')).toBe('JP');
  });

  it('returns undefined for aliases and nonsense rather than guessing', () => {
    expect(countryForTimezone('Europe/Kiev')).toBeUndefined(); // alias of Europe/Kyiv
    expect(countryForTimezone('Mars/Olympus_Mons')).toBeUndefined();
    expect(countryForTimezone('')).toBeUndefined();
  });

  it('resolves every zone the runtime knows about, or nothing at all', () => {
    for (const zone of Intl.supportedValuesOf('timeZone')) {
      const cc = countryForTimezone(zone);
      if (cc !== undefined) expect(cc).toMatch(/^[A-Z]{2}$/);
    }
  });
});
