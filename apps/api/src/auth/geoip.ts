import { open, validate, type CityResponse } from 'maxmind';

/**
 * Where an address roughly is (§20.2: "approximate location"), when the
 * operator gives VDeploy a MaxMind database (GeoLite2 City or Country).
 * Without one there is no location at all, rather than a guess from a
 * service on the internet that would learn every address that signs in.
 */
export type Locate = (ip: string | null | undefined) => string | null;

export const NO_LOCATION: Locate = () => null;

/** "Dhaka, BD" from a city database, "BD" from a country one; null when unknown. */
export function placeOf(found: CityResponse | null | undefined): string | null {
  const country = found?.country?.iso_code;
  if (!country) return null;
  const city = found.city?.names.en;
  return city ? `${city}, ${country}` : country;
}

/** Opens the database once, at start; a path that cannot be read stops the start, in words. */
export async function openGeoIp(path: string | undefined): Promise<Locate> {
  if (!path) return NO_LOCATION;
  let reader;
  try {
    reader = await open<CityResponse>(path);
  } catch (error) {
    throw new Error(
      `GEOIP_DATABASE is set to ${path}, which could not be read as a MaxMind database: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return (ip) => (ip && validate(ip) ? placeOf(reader.get(ip)) : null);
}
