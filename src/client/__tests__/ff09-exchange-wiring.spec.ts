import { describe, it, expect, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import type { CommandContext } from "../../model/capabilities/types.js";
import type { DeviceUserDirectory, Ff09SettingsReader } from "../../core/contracts.js";

/**
 * The providers the facade binds a lock with: the `ff09` exchange goes over secure MQTT, also for a lock
 * with a P2P endpoint; the cloud's local-user records go to the device's own serial and its station's.
 * Transports are stubbed; only the facade's wiring runs.
 */
const SN = "T85L0K0000000000";
const ADMIN = "0".repeat(40);

function ctx(hasP2p: boolean): CommandContext {
  return { channel: 0, codec: "lock", serial: SN, paramIds: new Set(), adminUserId: ADMIN, hasP2p };
}

function facade() {
  const eufy = new EufyMega({ email: "t@example.com", password: "x" });
  const internals = eufy as unknown as {
    mqtt: { exchangeFf09: (...a: unknown[]) => Promise<unknown> };
    mega: {
      addDeviceLocalUser: (...a: unknown[]) => Promise<unknown>;
      saveDevicePassword: (...a: unknown[]) => Promise<unknown>;
      deleteDeviceLocalUser: (...a: unknown[]) => Promise<unknown>;
    };
    ff09SettingsReaderFor(sn: string, c: CommandContext): Ff09SettingsReader | undefined;
    deviceUsersFor(sn: string, c: CommandContext): DeviceUserDirectory;
  };
  return { eufy, internals };
}

describe("facade ff09 exchange + device-user wiring", () => {
  it.each([
    ["an MQTT-driven lock", false],
    ["a lock with a P2P endpoint", true],
  ])("sends the exchange over MQTT with the device identity, on %s", async (_name, hasP2p) => {
    const { internals } = facade();
    const exchange = vi.spyOn(internals.mqtt, "exchangeFf09").mockResolvedValue({ status: 0, fields: new Map() });

    const reader = internals.ff09SettingsReaderFor(SN, ctx(hasP2p));
    await reader!.exchange!(0x24, 6012, [Buffer.from([4])]);

    expect(exchange).toHaveBeenCalledWith(SN, {
      adminUserId: ADMIN,
      deviceSn: SN,
      commandCode: 0x24,
      apiCommand: 6012,
      fields: [Buffer.from([4])],
    });
  });

  it("names a covering station's serial, and none for a device that is its own station", async () => {
    const { internals } = facade();
    const add = vi.spyOn(internals.mega, "addDeviceLocalUser").mockResolvedValue({ shortUserId: "0002" });

    await internals.deviceUsersFor(SN, { ...ctx(false), stationSerial: "T8030K0000000000" }).addUser("Guest");

    expect(add).toHaveBeenCalledWith(SN, "T8030K0000000000", "Guest");
  });

  it("creates users, records passwords and removes users under the device's serial and station", async () => {
    const { internals } = facade();
    const add = vi.spyOn(internals.mega, "addDeviceLocalUser").mockResolvedValue({ shortUserId: "0002" });
    const save = vi.spyOn(internals.mega, "saveDevicePassword").mockResolvedValue(undefined);
    const users = internals.deviceUsersFor(SN, ctx(false));

    await expect(users.addUser("Guest")).resolves.toEqual({ shortUserId: "0002" });
    const password = { passwordId: "0002", passwordType: 1, schedule: "{}" };
    await users.savePassword("0002", password);

    const remove = vi.spyOn(internals.mega, "deleteDeviceLocalUser").mockResolvedValue(undefined);
    await users.deleteUser("0002");

    expect(add).toHaveBeenCalledWith(SN, "", "Guest");
    expect(save).toHaveBeenCalledWith(SN, "", "0002", password);
    expect(remove).toHaveBeenCalledWith(SN, "", "0002");
  });
});
