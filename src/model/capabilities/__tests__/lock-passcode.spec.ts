import { describe, it, expect, vi } from "vitest";
import type { LockActions, PasscodeValidity } from "../lock.js";
import type { Weekday } from "../../weekdays.js";
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

/** The Smart Lock C30, which the app sends the same add-passcode frame over the same wire. */
const c30: CommandContext = { ...c33, deviceType: 202, model: "T85D0", serial: "T85D0K0000000000" };

/** The FamiLock S3: a camera-codec device with a P2P endpoint, taking the same frame over MQTT. */
const s3: CommandContext = {
  ...c33,
  codec: "camera",
  deviceType: 203,
  model: "T85V0",
  serial: "T85V0K0000000000",
  hasP2p: true,
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
    deleteUser: vi.fn(async () => {
      calls.push("deleteUser");
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

describe("lock.addPasscode — Smart Lock C33, C30 and FamiLock S3", () => {
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
    expect(users.deleteUser).not.toHaveBeenCalled();
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

  it("records an S3 code in the S3's cloud form: the frame's dates and times as hex, week FF", async () => {
    const permanent = fakes();
    await lockOf(s3, permanent).addPasscode!("Guest", "66554433");
    const frame = vi.mocked(permanent.ff09Settings.exchange!).mock.calls[0]![2].map((f) => f.toString("hex"));
    expect(frame.slice(2, 7)).toEqual(["00000000", "ffffffff", "7f", "0000", "ffff"]);
    expect(permanent.users.savePassword).toHaveBeenCalledWith("0007", {
      passwordId: "0007",
      passwordType: 1,
      schedule: JSON.stringify({
        startDay: "00000000",
        endDay: "FFFFFFFF",
        week: "FF",
        startTime: "0000",
        endTime: "FFFF",
      }),
    });

    const span = fakes();
    await lockOf(s3, span).addPasscode!("Guest", "11223344", {
      kind: "timeSpan",
      starts: { year: 2026, month: 11, day: 10, hour: 10, minute: 0 },
      ends: { year: 2026, month: 12, day: 10, hour: 9, minute: 0 },
    });
    const spanFrame = vi.mocked(span.ff09Settings.exchange!).mock.calls[0]![2].map((f) => f.toString("hex"));
    expect(spanFrame.slice(2, 7)).toEqual(["ea070b0a", "ea070c0a", "ff", "0a00", "0900"]);
    expect(vi.mocked(span.users.savePassword).mock.calls[0]![1].schedule).toBe(
      JSON.stringify({ startDay: "EA070B0A", endDay: "EA070C0A", week: "FF", startTime: "0A00", endTime: "0900" }),
    );
  });

  it("sends a Repeated Entry as the app does: its days, the weekday mask with the top bit, all day", async () => {
    const { users, ff09Settings } = fakes();

    await lockOf(c33, { users, ff09Settings }).addPasscode!("Guest", "13243546", {
      kind: "repeated",
      starts: { year: 2026, month: 11, day: 11 },
      ends: { year: 2026, month: 12, day: 31 },
      days: ["monday", "wednesday", "friday"],
    });

    const fields = vi.mocked(ff09Settings.exchange!).mock.calls[0]![2].map((f) => f.toString("hex"));
    expect([fields[1], ...fields.slice(2, 8), fields[10]]).toEqual([
      "04",
      "ea070b0b",
      "ea070c1f",
      "aa",
      "0000",
      "ffff",
      "00",
      "01",
    ]);
    expect(users.savePassword).toHaveBeenCalledWith("0007", {
      passwordId: "0007",
      passwordType: 1,
      schedule: JSON.stringify({
        startDate: 1794373200,
        endDate: 1798779599,
        timePeriodNum: 1,
        timePeriods: [{ periodic: 170, startTime: "0:0", endTime: "-1:-1" }],
      }),
    });
  });

  it("sends a OneTime code as the app does: user type 5, every weekday with the top bit, single use", async () => {
    const { users, ff09Settings } = fakes();

    await lockOf(c33, { users, ff09Settings }).addPasscode!("Guest", "24354657", { kind: "oneTime" });

    const fields = vi.mocked(ff09Settings.exchange!).mock.calls[0]![2].map((f) => f.toString("hex"));
    expect([fields[1], ...fields.slice(2, 8), fields[10]]).toEqual([
      "05",
      "00000000",
      "ffffffff",
      "ff",
      "0000",
      "ffff",
      "01",
      "00",
    ]);
    expect(vi.mocked(users.savePassword).mock.calls[0]![1].schedule).toBe(
      JSON.stringify({
        startDate: 0,
        endDate: -1,
        timePeriodNum: 1,
        timePeriods: [{ periodic: 127, startTime: "0:0", endTime: "-1:-1" }],
      }),
    );
  });

  it("sends an S3 Repeated Entry and records its weekday byte in the S3's cloud form", async () => {
    const { users, ff09Settings } = fakes();

    await lockOf(s3, { users, ff09Settings }).addPasscode!("Guest", "35465768", {
      kind: "repeated",
      starts: { year: 2026, month: 11, day: 12 },
      ends: { year: 2027, month: 1, day: 15 },
      days: ["tuesday", "thursday", "saturday"],
    });

    const fields = vi.mocked(ff09Settings.exchange!).mock.calls[0]![2].map((f) => f.toString("hex"));
    expect([...fields.slice(2, 8), fields[10]]).toEqual(["ea070b0c", "eb07010f", "d4", "0000", "ffff", "00", "01"]);
    expect(vi.mocked(users.savePassword).mock.calls[0]![1].schedule).toBe(
      JSON.stringify({ startDay: "EA070B0C", endDay: "EB07010F", week: "D4", startTime: "0000", endTime: "FFFF" }),
    );
  });

  it("starts an S3 OneTime code on the lock's own day, as the app does", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T03:30:00Z"));
    try {
      const { users, ff09Settings } = fakes();

      await lockOf(s3, { users, ff09Settings }).addPasscode!("Guest", "46576879", { kind: "oneTime" });

      const fields = vi.mocked(ff09Settings.exchange!).mock.calls[0]![2].map((f) => f.toString("hex"));
      expect([fields[1], ...fields.slice(2, 8), fields[10]]).toEqual([
        "05",
        "ea070b0a",
        "ffffffff",
        "ff",
        "0000",
        "ffff",
        "01",
        "00",
      ]);
      expect(vi.mocked(users.savePassword).mock.calls[0]![1].schedule).toBe(
        JSON.stringify({ startDay: "EA070B0A", endDay: "FFFFFFFF", week: "FF", startTime: "0000", endTime: "FFFF" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds an S3 time span without the lock's clock zone, which its cloud record does not use", async () => {
    const { users, ff09Settings } = fakes();
    const at = (day: number, hour: number) => ({ year: 2026, month: 11, day, hour, minute: 0 });

    await lockOf({ ...s3, timezone: undefined }, { users, ff09Settings }).addPasscode!("Guest", "1234", {
      kind: "timeSpan",
      starts: at(10, 10),
      ends: at(11, 9),
    });

    expect(vi.mocked(users.savePassword).mock.calls[0]![1].schedule).toBe(
      JSON.stringify({ startDay: "EA070B0A", endDay: "EA070B0B", week: "FF", startTime: "0A00", endTime: "0900" }),
    );
  });

  it("dates an S3 OneTime code by the lock's day through the hour its clock repeats at midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-05T03:30:00Z"));
    try {
      const { users, ff09Settings } = fakes();
      const chile = { ...s3, timezone: "<-04>4<-03>,M9.1.6/24,M4.1.6/24" };

      await lockOf(chile, { users, ff09Settings }).addPasscode!("Guest", "1234", { kind: "oneTime" });

      expect(vi.mocked(ff09Settings.exchange!).mock.calls[0]![2][2]!.toString("hex")).toBe("ea070404");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a Repeated Entry it cannot spell before touching the cloud", async () => {
    const day = (d: number, month = 2) => ({ year: 2026, month, day: d });
    const refusals: Array<[Extract<PasscodeValidity, { kind: "repeated" }>, RegExp]> = [
      [{ kind: "repeated", starts: day(30), ends: day(5, 3), days: ["monday"] }, /not a real day/],
      [{ kind: "repeated", starts: day(12), ends: day(10), days: ["monday"] }, /must not end before it starts/],
      [{ kind: "repeated", starts: day(10), ends: day(12), days: [] }, /at least one weekday/],
      [{ kind: "repeated", starts: day(10), ends: day(12), days: ["mon" as Weekday] }, /"mon" is not a weekday/],
    ];
    for (const [validity, reason] of refusals) {
      const { users, ff09Settings } = fakes();
      await expect(lockOf(c33, { users, ff09Settings }).addPasscode!("Guest", "1234", validity)).rejects.toThrow(
        reason,
      );
      expect(users.addUser).not.toHaveBeenCalled();
    }
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

  it("is present on the C33, C30 and S3, absent off them, and without either provider or the exchange", () => {
    const { users, ff09Settings } = fakes();
    const { exchange: _dropped, ...noExchange } = ff09Settings;

    expect("addPasscode" in lockOf(c33, { users, ff09Settings })).toBe(true);
    expect("addPasscode" in lockOf(c30, { users, ff09Settings })).toBe(true);
    expect("addPasscode" in lockOf(s3, { users, ff09Settings })).toBe(true);
    expect("addPasscode" in lockOf(videoLock, { users, ff09Settings })).toBe(false);
    expect("addPasscode" in lockOf(c33, { ff09Settings })).toBe(false);
    expect("addPasscode" in lockOf(c33, { users })).toBe(false);
    expect("addPasscode" in lockOf(c33, { users, ff09Settings: noExchange })).toBe(false);
  });
});

describe("lock.changePasscode", () => {
  it("sends the lock the user's id and the new code, and touches no cloud record", async () => {
    const { users, ff09Settings, calls } = fakes(reply(0));

    await lockOf(c33, { users, ff09Settings }).changePasscode!("0007", "24681357");

    expect(calls).toEqual(["exchange"]);
    const [code, apiCommand, fields] = vi.mocked(ff09Settings.exchange!).mock.calls[0]!;
    expect([code, apiCommand]).toEqual([0x26, 6012]);
    expect(fields.map((f) => f.toString("hex"))).toEqual(["0007", Buffer.from("24681357", "ascii").toString("hex")]);
  });

  it("rejects with the lock's status on a refusal", async () => {
    const { users, ff09Settings } = fakes(reply(1));

    await expect(lockOf(c33, { users, ff09Settings }).changePasscode!("0007", "24681357")).rejects.toThrow(
      /device result 1/,
    );
  });

  it("refuses a malformed short id or passcode, and the account's own user, before touching the lock", async () => {
    const { users, ff09Settings } = fakes(reply(0));
    const lock = lockOf(c33, { users, ff09Settings });

    await expect(lock.changePasscode!("7", "1234")).rejects.toThrow(/4 hex digits/);
    await expect(lock.changePasscode!("0000", "1234")).rejects.toThrow(/account's own user/);
    await expect(lock.changePasscode!("0007", "12a4")).rejects.toThrow(/digits only/);
    await expect(lock.changePasscode!("0007", "1".repeat(256))).rejects.toThrow(/at most 255 bytes/);
    expect(ff09Settings.exchange).not.toHaveBeenCalled();
  });

  it("is present where addPasscode is, and absent off those models", () => {
    const { users, ff09Settings } = fakes();

    for (const ctx of [c33, c30, s3]) {
      expect("changePasscode" in lockOf(ctx, { users, ff09Settings })).toBe(true);
    }
    expect("changePasscode" in lockOf(videoLock, { users, ff09Settings })).toBe(false);
    expect("changePasscode" in lockOf(c33, { ff09Settings })).toBe(false);
  });
});

describe("lock.deleteUser", () => {
  it("tells the lock to delete the user under its short id, then removes the cloud user", async () => {
    const { users, ff09Settings, calls } = fakes(reply(0));

    await lockOf(c33, { users, ff09Settings }).deleteUser!("0007");

    expect(calls).toEqual(["exchange", "deleteUser"]);
    const [code, apiCommand, fields] = vi.mocked(ff09Settings.exchange!).mock.calls[0]!;
    expect([code, apiCommand]).toEqual([0x2d, 6012]);
    expect(fields.map((f) => f.toString("hex"))).toEqual(["0007"]);
    expect(users.deleteUser).toHaveBeenCalledWith("0007");
  });

  it("rejects with the lock's status on a refusal, leaving the cloud user", async () => {
    const { users, ff09Settings } = fakes(reply(1));

    await expect(lockOf(c33, { users, ff09Settings }).deleteUser!("0007")).rejects.toThrow(/device result 1/);
    expect(users.deleteUser).not.toHaveBeenCalled();
  });

  it("refuses a malformed short id and the account's own before touching the lock", async () => {
    const { users, ff09Settings } = fakes(reply(0));
    const lock = lockOf(c33, { users, ff09Settings });

    await expect(lock.deleteUser!("7")).rejects.toThrow(/4 hex digits/);
    await expect(lock.deleteUser!("0000")).rejects.toThrow(/account's own user/);
    expect(ff09Settings.exchange).not.toHaveBeenCalled();
  });

  it("is present where addPasscode is, and absent off those models", () => {
    const { users, ff09Settings } = fakes();

    for (const ctx of [c33, c30, s3]) expect("deleteUser" in lockOf(ctx, { users, ff09Settings })).toBe(true);
    expect("deleteUser" in lockOf(videoLock, { users, ff09Settings })).toBe(false);
    expect("deleteUser" in lockOf(c33, { ff09Settings })).toBe(false);
  });
});

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
declare const lk: LockActions;
const _optional: Exact<undefined extends typeof lk.addPasscode ? true : false, true> = true;
const _signature: Exact<
  NonNullable<typeof lk.addPasscode>,
  (name: string, passcode: string, validity?: PasscodeValidity) => Promise<{ shortUserId: string; passwordId: string }>
> = true;
const _changeSignature: Exact<
  NonNullable<typeof lk.changePasscode>,
  (shortUserId: string, passcode: string) => Promise<void>
> = true;
const _deleteSignature: Exact<NonNullable<typeof lk.deleteUser>, (shortUserId: string) => Promise<void>> = true;
export const _surfaceAssertions = [_optional, _signature, _changeSignature, _deleteSignature];
