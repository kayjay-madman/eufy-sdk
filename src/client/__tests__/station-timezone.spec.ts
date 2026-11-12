import { afterEach, describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";

/**
 * Which record's `time_zone` a device's command context carries: its parent station's when it has one,
 * its own when it is its own station. Only the registry is seeded; no transport runs.
 */
const LOCK = "T85L0K0000000000";
const VIDEO_LOCK = "T8530P0000000000";
const HUB = "T8030P0000000000";

function harness() {
  const client = new EufyMega({ email: "test@example.com", password: "x", autoRealtime: false });
  const internal = client as any;
  internal.registry.devices = [
    {
      sn: LOCK,
      model: "T85L0",
      stationSn: LOCK,
      category: "eufy_security",
      raw: { device_type: 201, time_zone: "own-zone" },
    },
    {
      sn: VIDEO_LOCK,
      model: "T8530",
      stationSn: HUB,
      category: "eufy_security",
      raw: { device_type: 55, parent_sn: HUB, time_zone: "device-zone" },
    },
    { sn: HUB, model: "T8030", raw: { device_type: 18 } },
  ];
  vi.spyOn(internal.registry, "record").mockImplementation(async (sn: unknown) =>
    sn === LOCK
      ? { deviceType: 201, model: "T85L0", params: {}, paramUpdatedAt: {} }
      : { deviceType: 55, model: "T8530", parentSn: HUB, params: {}, paramUpdatedAt: {} },
  );
  return internal;
}
afterEach(() => vi.restoreAllMocks());

describe("command context timezone", () => {
  it("is a standalone device's own, it being its own station", async () => {
    expect((await harness().commandContext(LOCK)).timezone).toBe("own-zone");
  });

  it("is the parent station's for an attached device, and absent when the parent reports none", async () => {
    expect((await harness().commandContext(VIDEO_LOCK)).timezone).toBeUndefined();
  });
});
