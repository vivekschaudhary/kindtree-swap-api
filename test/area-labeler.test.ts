import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logging/logger.js";
import { createAreaLabeler, createGoogleAreaLabeler, gridAreaLabel, pickLabel } from "../src/adapters/area-labeler.js";

const logger = createLogger("silent");

const okBody = {
  status: "OK",
  results: [
    {
      address_components: [
        { long_name: "Mission District", types: ["neighborhood", "political"] },
        { long_name: "San Francisco", types: ["locality", "political"] },
        { long_name: "California", types: ["administrative_area_level_1", "political"] },
      ],
    },
  ],
};

const fakeFetch = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;

describe("pickLabel", () => {
  it("joins neighbourhood and city", () => {
    expect(pickLabel(okBody)).toBe("Mission District, San Francisco");
  });

  it("uses the city alone when there is no neighbourhood", () => {
    const body = { status: "OK", results: [{ address_components: [{ long_name: "Oakland", types: ["locality"] }] }] };
    expect(pickLabel(body)).toBe("Oakland");
  });

  it("returns null for zero results", () => {
    expect(pickLabel({ status: "ZERO_RESULTS", results: [] })).toBeNull();
  });
});

describe("Google area labeler", () => {
  it("sends the rounded point and returns the derived label", async () => {
    let requested = "";
    const labeler = createGoogleAreaLabeler({
      apiKey: "test-key",
      logger,
      fetchImpl: (async (url: URL) => {
        requested = String(url);
        return new Response(JSON.stringify(okBody), { status: 200 });
      }) as typeof fetch,
    });
    expect(await labeler.label(37.775, -122.419)).toBe("Mission District, San Francisco");
    expect(requested).toContain("latlng=37.775%2C-122.419");
    expect(requested).toContain("key=test-key");
  });

  it("falls back to the grid label on an HTTP error", async () => {
    const labeler = createGoogleAreaLabeler({ apiKey: "k", logger, fetchImpl: fakeFetch({}, 500) });
    expect(await labeler.label(37.77, -122.41)).toBe(gridAreaLabel(37.77, -122.41));
  });

  it("falls back to the grid label when the network fails", async () => {
    const labeler = createGoogleAreaLabeler({
      apiKey: "k",
      logger,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    expect(await labeler.label(37.77, -122.41)).toBe(gridAreaLabel(37.77, -122.41));
  });

  it("falls back to the grid label on zero results", async () => {
    const labeler = createGoogleAreaLabeler({ apiKey: "k", logger, fetchImpl: fakeFetch({ status: "ZERO_RESULTS", results: [] }) });
    expect(await labeler.label(0.1, 0.1)).toBe(gridAreaLabel(0.1, 0.1));
  });
});

describe("area labeler selection", () => {
  it("uses the grid labeler when no Google key is configured", async () => {
    const labeler = createAreaLabeler({ logger });
    expect(await labeler.label(37.77, -122.41)).toBe("Region 37.5N 122.5W");
  });
});
