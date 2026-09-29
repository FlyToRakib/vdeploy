import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, startTestApp, type TestApp } from '../test-helpers.js';
import { NO_LOCATION, openGeoIp, placeOf } from './geoip.js';

describe('where an address roughly is (§20.2)', () => {
  it('names the city and country a database knows, or the country alone', () => {
    expect(
      placeOf({ country: { iso_code: 'BD' } as never, city: { names: { en: 'Dhaka' } } as never }),
    ).toBe('Dhaka, BD');
    expect(placeOf({ country: { iso_code: 'DE' } as never })).toBe('DE');
    expect(placeOf(null)).toBeNull();
  });

  it('shows nothing without a database, and will not start with one it cannot read', async () => {
    expect(await openGeoIp(undefined)).toBe(NO_LOCATION);
    await expect(openGeoIp('/nowhere/GeoLite2-City.mmdb')).rejects.toThrow(
      /GEOIP_DATABASE is set to \/nowhere\/GeoLite2-City\.mmdb/,
    );
  });
});

describe('sessions, with a GeoIP database', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ locate: (ip) => (ip === '198.51.100.7' ? 'Dhaka, BD' : null) });
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  it('say roughly where each one is', async () => {
    const owner = new Browser(t.app, 'Owner/1.0', '198.51.100.7');
    await owner.request('POST', '/api/v1/setup', {
      name: 'Owner',
      email: 'owner@example.com',
      password: 'correct horse battery 42',
      organization: 'Acme',
    });
    const sessions = (await owner.request('GET', '/api/v1/sessions')).json<
      { location: string | null; current: boolean }[]
    >();
    expect(sessions.find((s) => s.current)?.location).toBe('Dhaka, BD');
  });
});
