import { describe, it, expect, vi } from "vitest";
import type { LockActions, PasscodeValidity } from "../lock.js";
import { bind } from "./bind.js";
import type { CommandContext } from "../types.js";
import type { DeviceUserDirectory, Ff09Reply, Ff09SettingsReader } from "../../../core/contracts.js";

/**
 * `lock().addPasscode` against hand-written providers: the cloud's user records and the `ff09` exchange.
 * The frame fields asserted here are the ones the vendor app sends a Smart Lock C33 to add a permanent
 * code, with a synthetic code, name and short id.
 */
const c33: CommandContext = {
  channel: 0,
  codec: "lock",
  timezone: "EST5EDT,M3.2.0,M11.1.0|1.1159",
  deviceType: 201,
  model: "T85L0",
  serial: "T85L0K0000000000",
  paramIds: new Set([6000, 6001]),
  adminUserId: "0".repeat(40),
  shortUserId: "0000",
  hasP2p: false,
};

/** A video smart lock on another wire family; the passcode frame is unconfirmed there. */
const videoLock: CommandContext = { ...c33, deviceType: 189, model: "T8531", serial: "T8531K0000000000" };

function reply(status: number, fields: Array<[number, string]> = []): Ff09Reply {
  return { status, fields: new Map(fields.map(([tag, hex]) => [tag, Buffer.from(hex, "hex")])) };
}

function fakes(answer: Ff09Reply = reply(0, [[0xa1, "0007"]])) {
  const calls: string[] = [];
  const users: DeviceUserDirectory = {
    addUser: vi.fn(async () => {
      calls.push("addUser");
      return { shortUserId: "0007" };
    }),
    savePassword: vi.fn(async () => {
      calls.push("savePassword");
    }),
  };
  const ff09Settings: Ff09SettingsReader = {
    getAutoLockState: vi.fn(),
    exchange: vi.fn(async () => {
      calls.push("exchange");
      return answer;
    }),
  };
  return { users, ff09Settings, calls };
}

const lockOf = (ctx: CommandContext, deps: { users?: DeviceUserDirectory; ff09Settings?: Ff09SettingsReader }) =>
  bind<LockActions>("lock", ctx, { deviceUsers: deps.users, ff09Settings: deps.ff09Settings }).acts;

describe("lock.addPasscode — Smart Lock C33", () => {
  it("creates the cloud user, sends the lock the permanent code under its short id, then records the password", async () => {
    const { users, ff09Settings, calls } = fakes();

    const added = await lockOf(c33, { users, ff09Settings }).addPasscode!("Guest", "13572468");

    expect(added).toEqual({ shortUserId: "0007", passwordId: "0007" });
    expect(calls).toEqual(["addUser", "exchange", "savePassword"]);
    expect(users.addUser).toHaveBeenCalledWith("Guest");
    const [code, apiCommand, fields] = vi.mocked(ff09Settings.exchange!).mock.calls[0]!;
    expect(code).toBe(0x24);
    expect(apiCommand).toBe(6012);
    expect(fields.map((f) => f.toString("hex"))).toEqual([
      Buffer.from("13572468", "ascii").toString("hex"),
      "04",
      "00000000",
      "ffffffff",
      "7f",
      "0000",
      "ffff",
      "00",
      Buffer.from("Guest", "utf8").toString("hex"),
      "0007",
      "00",
    ]);
    expect(users.savePassword).toHaveBeenCalledWith("0007", {
      passwordId: "0007",
      passwordType: 1,
      schedule: JSON.stringify({
        startDate: 0,
        endDate: -1,
        timePeriodNum: 1,
        timePeriods: [{ periodic: 127, startTime: "0:0", endTime: "-1:-1" }],
      }),
    });
  });

  it("rejects with the lock's status on a refusal, naming the cloud user it leaves", async () => {
    const { users, ff09Settings } = fakes(reply(17));

    await expect(lockOf(c33, { users, ff09Settings }).addPasscode!("Guest", "13572468")).rejects.toThrow(
      "device result 17 (cloud user 0007 remains)",
    );
    expect(users.savePassword).not.toHaveBeenCalled();
  });

  it("names the cloud user it leaves when the lock does not answer", async () => {
    const { users, ff09Settings } = fakes();
    vi.mocked(ff09Settings.exchange!).mockRejectedValueOnce(new Error("no reply"));

    await expect(lockOf(c33, { users, ff09Settings }).addPasscode!("Guest", "13572468")).rejects.toThrow(
      "no reply (cloud user 0007 remains)",
    );
  });

  it("names the stored code when the cloud does not record it", async () => {
    const { users, ff09Settings } = fakes();
    vi.mocked(users.savePassword).mockRejectedValueOnce(new Error("cloud 500"));

    await expect(lockOf(c33, { users, ff09Settings }).addPasscode!("Guest", "13572468")).rejects.toThrow(
      "the lock stored code 0007 under user 0007, but the cloud did not record it: cloud 500",
    );
  });

  it("records the password id in upper-case hex, as the app does", async () => {
    const { users, ff09Settings } = fakes(reply(0, [[0xa1, "000c"]]));

    const added = await lockOf(c33, { users, ff09Settings }).addPasscode!("Guest", "91021324");

    expect(added.passwordId).toBe("000C");
    expect(vi.mocked(users.savePassword).mock.calls[0]![1].passwordId).toBe("000C");
  });

  it("rejects an accepted reply that carries no password id", async () => {
    const { users, ff09Settings } = fakes(reply(0));

    await expect(lockOf(c33, { users, ff09Settings }).addPasscode!("Guest", "13572468")).rejects.toThrow(
      /no password id/,
    );
    expect(users.savePassword).not.toHaveBeenCalled();
  });

  it("refuses a passcode that is not digits before touching the cloud", async () => {
    const { users, ff09Settings } = fakes();

    await expect(lockOf(c33, { users, ff09Settings }).addPasscode!("Guest", "12a4")).rejects.toThrow(/digits only/);
    expect(users.addUser).not.toHaveBeenCalled();
  });

  it("refuses a name or validity the frame cannot carry before touching the cloud", async () => {
    const refusals: Array<[string, PasscodeValidity | undefined, RegExp]> = [
      ["x".repeat(256), undefined, /at most 255 bytes/],
      ["Guest", { kind: "permanent" } as unknown as PasscodeValidity, /is not a validity/],
    ];
    for (const [name, validity, reason] of refusals) {
      const { users, ff09Settings } = fakes();
      await expect(lockOf(c33, { users, ff09Settings }).addPasscode!(name, "1234", validity)).rejects.toThrow(reason);
      expect(users.addUser).not.toHaveBeenCalled();
    }
  });

  it("sends a time span as the app does, and records its days as instants on the lock's clock", async () => {
    const { users, ff09Settings } = fakes();

    await lockOf(c33, { users, ff09Settings }).addPasscode!("Guest", "22334455", {
      kind: "timeSpan",
      starts: { year: 2026, month: 11, day: 12, hour: 9, minute: 30 },
      ends: { year: 2026, month: 12, day: 24, hour: 17, minute: 45 },
    });

    const fields = vi.mocked(ff09Settings.exchange!).mock.calls[0]![2].map((f) => f.toString("hex"));
    expect(fields.slice(2, 7)).toEqual(["ea070b0c", "ea070c18", "ff", "091e", "112d"]);
    expect(fields[10]).toBe("02");
    expect(users.savePassword).toHaveBeenCalledWith("0007", {
      passwordId: "0007",
      passwordType: 1,
      schedule: JSON.stringify({
        startDate: 1794459600,
        endDate: 1798174799,
        timePeriodNum: 1,
        timePeriods: [{ periodic: 255, startTime: "09:30", endTime: "17:45" }],
      }),
    });
  });

  it("refuses a time span it cannot spell before touching the cloud", async () => {
    const at = (day: number, hour = 9, minute = 0, second?: number) => ({
      year: 2026,
      month: 2,
      day,
      hour,
      minute,
      second,
    });
    const span = (starts: ReturnType<typeof at>, ends: ReturnType<typeof at>) => ({
      kind: "timeSpan" as const,
      starts,
      ends,
    });
    const refusals: Array<[CommandContext, ReturnType<typeof span>, RegExp]> = [
      [c33, span(at(30), at(28)), /not a whole minute of a real date/],
      [c33, span(at(10, 24), at(12)), /not a whole minute of a real date/],
      [c33, span(at(10, 9, 0, 30), at(12)), /not a whole minute of a real date/],
      [c33, span(at(12), at(12)), /end after it starts/],
      [{ ...c33, timezone: undefined }, span(at(10), at(12)), /clock zone/],
      [{ ...c33, timezone: "Mars/Olympus" }, span(at(10), at(12)), /clock zone/],
    ];
    for (const [ctx, validity, reason] of refusals) {
      const { users, ff09Settings } = fakes();
      await expect(lockOf(ctx, { users, ff09Settings }).addPasscode!("Guest", "1234", validity)).rejects.toThrow(
        reason,
      );
      expect(users.addUser).not.toHaveBeenCalled();
    }
  });

  it("is present on the C33, absent off it, and without either provider or the exchange", () => {
    const { users, ff09Settings } = fakes();
    const { exchange: _dropped, ...noExchange } = ff09Settings;

    expect("addPasscode" in lockOf(c33, { users, ff09Settings })).toBe(true);
    expect("addPasscode" in lockOf(videoLock, { users, ff09Settings })).toBe(false);
    expect("addPasscode" in lockOf(c33, { ff09Settings })).toBe(false);
    expect("addPasscode" in lockOf(c33, { users })).toBe(false);
    expect("addPasscode" in lockOf(c33, { users, ff09Settings: noExchange })).toBe(false);
  });
});

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
declare const lk: LockActions;
const _optional: Exact<undefined extends typeof lk.addPasscode ? true : false, true> = true;
const _signature: Exact<
  NonNullable<typeof lk.addPasscode>,
  (name: string, passcode: string, validity?: PasscodeValidity) => Promise<{ shortUserId: string; passwordId: string }>
> = true;
export const _surfaceAssertions = [_optional, _signature];
