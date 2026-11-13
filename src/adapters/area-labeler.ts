import type { Logger } from "../logging/logger.js";

/**
 * Turns a rounded point into a coarse, human-readable area name for display (for example
 * "Mission District, San Francisco"). The point itself is never returned to other users (§11).
 *
 * Implementations are swappable behind this interface. The grid labeler needs no vendor and is the
 * default. The Google labeler is used only when GOOGLE_MAPS_API_KEY is set.
 */
export type AreaLabeler = {
  label(lat: number, lng: number): Promise<string>;
};

/** Offline fallback. A 0.5-degree grid cell, roughly 50 km. Reveals no exact point. */
export function gridAreaLabel(lat: number, lng: number): string {
  const cell = (v: number) => Math.floor(v * 2) / 2;
  const ns = cell(lat) >= 0 ? "N" : "S";
  const ew = cell(lng) >= 0 ? "E" : "W";
  return `Region ${Math.abs(cell(lat)).toFixed(1)}${ns} ${Math.abs(cell(lng)).toFixed(1)}${ew}`;
}

export const gridAreaLabeler: AreaLabeler = {
  async label(lat, lng) {
    return gridAreaLabel(lat, lng);
  },
};

type GeocodeResponse = {
  status: string;
  results?: { address_components: { long_name: string; types: string[] }[] }[];
};

/**
 * Google Geocoding API, reverse lookup. Returns a neighbourhood or city name.
 *
 * Privacy: only the rounded point (3 decimal places) is sent. Nothing from the response is stored
 * except the derived label. Google's terms limit caching of lat/lng to 30 days, so raw responses
 * are never kept. Any failure falls back to the grid label, and the log line carries no coordinates.
 */
export function createGoogleAreaLabeler(opts: {
  apiKey: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): AreaLabeler {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 1_500;

  return {
    async label(lat, lng) {
      try {
        const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
        url.searchParams.set("latlng", `${lat},${lng}`);
        url.searchParams.set("result_type", "neighborhood|locality");
        url.searchParams.set("key", opts.apiKey);
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`geocoding http ${res.status}`);
        const body = (await res.json()) as GeocodeResponse;
        const label = pickLabel(body);
        if (label) return label;
        opts.logger.info({ status: body.status }, "geocoding returned no area; using grid label");
      } catch (err) {
        opts.logger.warn({ err: { name: (err as Error).name, message: (err as Error).message } }, "geocoding failed; using grid label");
      }
      return gridAreaLabel(lat, lng);
    },
  };
}

/** "Neighbourhood, City" when both exist, otherwise the most specific name available. */
export function pickLabel(body: GeocodeResponse): string | null {
  if (body.status !== "OK" || !body.results?.length) return null;
  const components = body.results.flatMap((r) => r.address_components);
  const find = (type: string) => components.find((c) => c.types.includes(type))?.long_name;
  const neighbourhood = find("neighborhood") ?? find("sublocality_level_1");
  const city = find("locality") ?? find("administrative_area_level_2");
  if (neighbourhood && city) return `${neighbourhood}, ${city}`;
  return neighbourhood ?? city ?? null;
}

/** Picks the labeler from configuration. */
export function createAreaLabeler(opts: { googleApiKey?: string; logger: Logger }): AreaLabeler {
  return opts.googleApiKey ? createGoogleAreaLabeler({ apiKey: opts.googleApiKey, logger: opts.logger }) : gridAreaLabeler;
}
