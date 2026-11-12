import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command, Ff09SettingsReader } from "../../core/contracts.js";
import type { EufyDevice } from "../../core/types.js";
import type { CommandContext } from "../../model/capabilities/types.js";
import { DeviceType } from "../../model/device-types.js";
import { EufyMega } from "../eufy-mega.js";

const S3 = "T85V0K0000000000";
const VIDEO_LOCK = "T8531K0000000000";
const ADMIN = "0000000000000000000000000000000000000000";
const unlock: Command = {
  kind: "ff09-actuate",
  engage: false,
  adminUserId: ADMIN,
  username: "someone+tag",
  shortUserId: "0000",
  deviceSn: S3,
};

/** A FamiLock S3 and a T8531 video lock, both with a P2P endpoint, and both transports' lock paths spied. */
function fixture() {
  const client = new EufyMega({
    email: "test@example.com",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
  });
  const internals = client as unknown as {
    registry: { devices: EufyDevice[] };
    mqtt: {
      dispatchCommand(sn: string, cmd: Command): Promise<void>;
      getAutoLockState(sn: string, cmd: unknown): Promise<unknown>;
    };
    p2p: {
      dispatchCommand(sn: string, cmd: Command): Promise<void>;
      getAutoLockState(sn: string, cmd: unknown): Promise<unknown>;
    };
    routeCommand(sn: string, cmd: Command): Promise<void>;
    ff09SettingsReaderFor(sn: string, ctx: CommandContext): Ff09SettingsReader | undefined;
  };
  internals.registry.devices = [
    { sn: S3, model: "T85V0", api: "mega", p2pDid: "XXXXXXX-000000-XXXXX", raw: { device_type: DeviceType.LOCK_85V0 } },
    {
      sn: VIDEO_LOCK,
      model: "T8531",
      api: "mega",
      p2pDid: "XXXXXXX-000001-XXXXX",
      raw: { device_type: DeviceType.LOCK_8531 },
    },
  ] as EufyDevice[];
  const spies = {
    mqtt: vi.spyOn(internals.mqtt, "dispatchCommand").mockResolvedValue(),
    p2p: vi.spyOn(internals.p2p, "dispatchCommand").mockResolvedValue(),
    mqttRead: vi.spyOn(internals.mqtt, "getAutoLockState").mockResolvedValue({}),
    p2pRead: vi.spyOn(internals.p2p, "getAutoLockState").mockResolvedValue({}),
  };
  return { internals, ...spies };
}

const ctxOf = (serial: string, deviceType: number): CommandContext => ({
  channel: 0,
  serial,
  deviceType,
  paramIds: new Set(),
  adminUserId: ADMIN,
  hasP2p: true,
});

afterEach(() => vi.restoreAllMocks());

describe("FamiLock S3 ff09 routing", () => {
  it("sends the S3's lock frames over secure MQTT although it has a P2P endpoint", async () => {
    const { internals, mqtt, p2p } = fixture();
    await internals.routeCommand(S3, unlock);
    expect(mqtt).toHaveBeenCalledExactlyOnceWith(S3, unlock);
    expect(p2p).not.toHaveBeenCalled();
    await internals.routeCommand(VIDEO_LOCK, { ...unlock, deviceSn: VIDEO_LOCK });
    expect(p2p).toHaveBeenCalledOnce();
  });

  it("reads the S3's auto-lock settings over secure MQTT too", async () => {
    const { internals, mqttRead, p2pRead } = fixture();
    await internals.ff09SettingsReaderFor(S3, ctxOf(S3, DeviceType.LOCK_85V0))!.getAutoLockState();
    expect(mqttRead).toHaveBeenCalledExactlyOnceWith(S3, { adminUserId: ADMIN, deviceSn: S3 });
    expect(p2pRead).not.toHaveBeenCalled();
    await internals.ff09SettingsReaderFor(VIDEO_LOCK, ctxOf(VIDEO_LOCK, DeviceType.LOCK_8531))!.getAutoLockState();
    expect(p2pRead).toHaveBeenCalledOnce();
  });
});
