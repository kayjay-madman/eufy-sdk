import { isClassicWifiLock, isFamiLockS3, isSmartLockC30, isSmartLockC33, isVideoSmartLock } from "../device-family.js";
import { asBool } from "../../core/util.js";
import { posixWallClockToEpoch, type WallClockTime } from "../../core/posix-tz.js";
import { WEEKDAYS, type Weekday } from "../weekdays.js";
import { LockPushEvent } from "../push-events.js";
import { describeDevice } from "./access.js";
import { method, propertiesOf, provided, type MemberDeps, type Members, type Surface } from "./members.js";
import type { AvailabilityContext, CapabilityModule, CommandContext, InboundSignal } from "./types.js";
import type {
  Command,
  CommandSink,
  AutoLockSnapshot,
  DeviceUserDirectory,
  Ff09SettingsReader,
  MediaProvider,
} from "../../core/contracts.js";

/**
 * Setting-id selectors for the compact `ff09-setting-toggle` write — this capability's OWN wire
 * vocabulary, named not inlined per the capability wire-id convention, so `setRainMode`
 * below references `LOCK_SETTING_ID.RAIN_MODE` and this module's own spec can import it too, instead
 * of a bare `7` at either call site.
 *
 * Unlike a normal capability id (owned by exactly one layer, crossing into `transport/` only as an
 * opaque number), this value is a GENUINE duplicate of `transport/ff09.ts`'s `FF09_SETTING_ID.RAIN_MODE`
 * — the capability↔transport decorrelation rule (`model/` never imports `transport/`) leaves no way to
 * share one source of truth across the boundary, and no test can cross-check them without violating
 * that same rule (`guard:decorrelation` forbids any `transport/` import under `src/model`, including
 * tests). If a future capture revises this id, BOTH copies must be updated by hand.
 */
export const LOCK_SETTING_ID = {
  /** One-touch lock toggle. Structurally confirmed via the app's own JS (2026-07-18) — see the module doc. */
  ONE_TOUCH_LOCK: 1,
  /** Scramble-passcode toggle. Structurally confirmed via the app's own JS (2026-07-18) — see the module doc. */
  SCRAMBLE_PASSCODE: 3,
  /** Wifi-status toggle. Structurally confirmed via the app's own JS (2026-07-18) — see the module doc. */
  WIFI_STATUS: 5,
  /** Event-log-enable toggle. Structurally confirmed via the app's own JS (2026-07-18) — see the module doc. */
  ENABLE_LOG: 6,
  /** Rain Mode toggle on the T8531 video lock. Verified live 2026-07-18. */
  RAIN_MODE: 7,
  /** Privacy-mode toggle. Structurally confirmed via the app's own JS (2026-07-18) — see the module doc. */
  PRIVACY_MODE: 9,
  /** One-touch rear-lock toggle. Structurally confirmed via the app's own JS (2026-07-18) — see the module doc. */
  ONE_TOUCH_REAR_LOCK: 11,
} as const;

/**
 * Bound lock controls — the object returned by `dev.lock()`.
 *
 * Everything is DERIVED from `LOCK_MEMBERS`. `lock`/`unlock` drive every lock-family actuator over the
 * wire its family takes: the shared `ff09` frame on the T8531 video smart lock and the T85D0 garage door,
 * the T8530 video lock's own `set-payload`, and the keyed-payload envelope on the classic Wi-Fi lock (the
 * `T8520`-range unit that never negotiates a session key). The setting toggles ride `ff09` only. This
 * module emits ONE transport-neutral intent per wire (identity fields only, no wire bytes, no cipher, no
 * routing key) and names no transport: the command sink routes P2P vs MQTT by the device's topology, and
 * the chosen transport's command router builds the frame + envelope and re-resolves its own routing tail.
 * Which pipe it is does not reach `dev.lock()` — its surface is identical either way, the same way
 * P2P-vs-cloud is hidden for live media.
 *
 * Classic Wi-Fi lock: `lock()` and `unlock()` are both confirmed on hardware — the bolt moved each way, the
 * device answered result code 0, and the cloud status followed. That device answers every command, so on it
 * the two reject on a refusal or an unanswered command as well as on missing identity.
 *
 * FamiLock S3: `lock()` and `unlock()` are both confirmed on hardware with the `ff09` frame — the lock
 * answered status 0 to each and reported itself unlocked, then locked.
 */
export type LockActions = Surface<typeof LOCK_MEMBERS>;

/** Native video-lock command vocabulary verified on T8530 attached to HomeBase 3. */
const VIDEO_LOCK_CMD = { ACTUATE: 1961, STATUS: 1955, NOTIFY: 1351 } as const;

/**
 * The actuation intent, or a refusal naming what is missing. Identity is a genuine precondition — the
 * frame carries the member fields — and a generated "not a valid value" message would misreport it.
 */
function actuate(engage: boolean, ctx: CommandContext, sink: CommandSink): Promise<void> {
  if (!ctx.adminUserId || !ctx.shortUserId || (isVideoSmartLock(ctx) && !ctx.accountName)) {
    return Promise.reject(
      new Error(
        `lock: missing member identity (admin_user_id/short_user_id, and user name on video locks) [${describeDevice(ctx)}]`,
      ),
    );
  }
  if (isVideoSmartLock(ctx)) {
    return sink.dispatch({
      kind: "set-payload",
      cmd: VIDEO_LOCK_CMD.ACTUATE,
      channel: ctx.channel,
      mValue3: 0,
      payload: {
        shortUserId: ctx.shortUserId,
        slOperation: engage ? 1 : 0,
        userId: ctx.adminUserId,
        userName: ctx.accountName,
      },
    });
  }
  return sink.dispatch({
    kind: isClassicWifiLock(ctx) ? "keyed-payload-actuate" : "ff09-actuate",
    engage,
    adminUserId: ctx.adminUserId,
    username: ctx.accountName ?? "",
    shortUserId: ctx.shortUserId,
    deviceSn: ctx.serial ?? "",
  });
}

/** The compact single-setting write (`ff09-setting-toggle`), or a refusal naming the missing identity. */
function settingToggle(settingId: number, name: string, enabled: boolean, ctx: CommandContext, sink: CommandSink) {
  if (!ctx.adminUserId) {
    return Promise.reject(new Error(`lock.${name}: missing member identity (admin_user_id) [${describeDevice(ctx)}]`));
  }
  return sink.dispatch({
    kind: "ff09-setting-toggle",
    adminUserId: ctx.adminUserId,
    deviceSn: ctx.serial ?? "",
    settingId,
    value: enabled,
  });
}

/**
 * Whether the device is reachable over P2P — the topology fact that decides which lock settings exist.
 * The compact toggles are only known on the P2P video lock; the MQTT garage door does not expose them in
 * the app, so offering them there would guess a frame shape that likely does not exist.
 */
const overP2p = (ctx: AvailabilityContext): boolean => ctx.hasP2p === true && !isVideoSmartLock(ctx);

/** Native actuation is verified only on the HomeBase 3 route; other lock families retain their controls. */
function actuationAvailable(ctx: CommandContext): boolean {
  return !isVideoSmartLock(ctx) || ctx.stationSerial?.startsWith("T8030") === true;
}

/** Live status read; unknown states remain unknown and device refusals reject. */
async function refreshStatus(
  query: NonNullable<MediaProvider["p2pQuery"]>,
  timezone: string,
): Promise<boolean | undefined> {
  const payload = await query(VIDEO_LOCK_CMD.STATUS, {
    payload: { timezone },
  });
  if (payload.code !== 0) throw new Error(`lock.refreshStatus: device result ${String(payload.code)}`);
  return nativeState(payload.slState);
}

/** Only the two observed settled states carry a boolean. */
function nativeState(raw: unknown): boolean | undefined {
  if (raw === "3") return false;
  if (raw === "4") return true;
  return undefined;
}

/** Successful video-lock status reports, attributed by the resolved device type. */
function nativeReport(signal: InboundSignal): Record<string, unknown> | undefined {
  if (
    signal.source !== "p2p-frame" ||
    !isVideoSmartLock(signal) ||
    signal.commandId !== VIDEO_LOCK_CMD.NOTIFY ||
    signal.json?.cmd !== VIDEO_LOCK_CMD.STATUS
  )
    return undefined;
  const report = signal.json.payload as Record<string, unknown> | undefined;
  return report?.code === 0 ? report : undefined;
}

/**
 * The keypad-user wire on the Smart Lock C33, C30 and FamiLock S3, as the vendor app drives it: the `ff09`
 * opcodes that add a code, change it and delete a user, and the envelope `apiCommand` the app sends every
 * command to these locks under.
 */
const PASSCODE_WIRE = { ADD: 0x24, CHANGE: 0x26, DELETE_USER: 0x2d, API_COMMAND: 6012 } as const;

/** The most bytes one field of an `ff09` frame carries: a field's length is a single byte. */
const MAX_FIELD_BYTES = 0xff;

/** The models whose keypad users are added and deleted here: Smart Lock C33, C30 and FamiLock S3. */
const keepsKeypadUsers = (ctx: CommandContext): boolean =>
  isSmartLockC33(ctx) || isSmartLockC30(ctx) || isFamiLockS3(ctx);

/**
 * When a keypad code admits its holder, on the lock's own clock; a code added without one is permanent.
 * Each kind is one of the app's choices for a new user:
 *
 * - `timeSpan` — Schedule → Time Span: one continuous window from `starts` to `ends`, wall times on the
 *   lock's clock to the minute.
 * - `repeated` — Schedule → Repeated Entry: every listed weekday, all day, from the day `starts` through
 *   the day `ends`.
 * - `oneTime` — OneTime: the code admits once.
 */
export type PasscodeValidity =
  | { kind: "timeSpan"; starts: WallClockTime; ends: WallClockTime }
  | {
      kind: "repeated";
      starts: Pick<WallClockTime, "year" | "month" | "day">;
      ends: Pick<WallClockTime, "year" | "month" | "day">;
      days: readonly Weekday[];
    }
  | { kind: "oneTime" };

/** A code's window as the add-passcode frame spells it (`A4`…`A9`, `AA`, `AD`). */
interface PasscodeWindow {
  /** `A4`: `4` for a keypad user, `5` for a OneTime one. */
  userType: number;
  /** `A5`: the first day, as {@link frameDate}; `00000000` for none. */
  startDate: Buffer;
  /** `A6`: the last day, as {@link frameDate}; `ffffffff` for none. */
  endDate: Buffer;
  /** `A7`: the weekdays, a mask in {@link WEEKDAYS} order, its top bit set on all but a permanent code. */
  week: number;
  /** `A8`: the time of day the code opens, `[hour, minute]`. */
  startTime: Buffer;
  /** `A9`: the time of day the code closes, `[hour, minute]`; `ffff` for the end of the day. */
  endTime: Buffer;
  /** `AA`: `1` for a code that admits once, `0` otherwise. */
  singleUse: number;
  /** `AD`: `0` for a permanent or OneTime code, `1` for a Repeated Entry, `2` for a Time Span. */
  validity: number;
}

/**
 * A permanent code's window: no start or end date (`00000000` / `ffffffff`), every weekday (`7f`), from
 * `00:00` with no end time (`ffff`), validity `0`.
 */
const PERMANENT_WINDOW: PasscodeWindow = {
  userType: 4,
  startDate: Buffer.from([0, 0, 0, 0]),
  endDate: Buffer.from([0xff, 0xff, 0xff, 0xff]),
  week: 0x7f,
  startTime: Buffer.from([0, 0]),
  endTime: Buffer.from([0xff, 0xff]),
  singleUse: 0,
  validity: 0,
};

/**
 * A OneTime code's window, as the app sends it: user type `5`, the permanent code's dates and times,
 * every weekday with the top bit set (`ff`), the single-use field `1`, validity `0`.
 */
const ONE_TIME_WINDOW: PasscodeWindow = { ...PERMANENT_WINDOW, userType: 5, week: 0xff, singleUse: 1 };

/** Whether `t` names a real calendar day the frame can carry (a `u16` year from 2000). */
function isRealDay(t: Pick<WallClockTime, "year" | "month" | "day">): boolean {
  const d = new Date(Date.UTC(t.year, t.month - 1, t.day));
  return (
    [t.year, t.month, t.day].every(Number.isInteger) &&
    t.year >= 2000 &&
    t.year <= 0xffff &&
    d.getUTCFullYear() === t.year &&
    d.getUTCMonth() === t.month - 1 &&
    d.getUTCDate() === t.day
  );
}

/** A day as the frame spells it: `u16 LE year ‖ month ‖ day`. */
const frameDate = (t: Pick<WallClockTime, "year" | "month" | "day">) =>
  Buffer.from([t.year & 0xff, t.year >> 8, t.month, t.day]);

/**
 * A Time Span's window, as the app sends it: each date as {@link frameDate}, each time as
 * `[hour, minute]`, every weekday (`ff`), validity `2`. Throws on a time that is not a whole minute of a
 * real date, and on an end not after its start.
 */
function timeSpanWindow(span: Extract<PasscodeValidity, { kind: "timeSpan" }>): PasscodeWindow {
  const { starts, ends } = span;
  for (const t of [starts, ends]) {
    if (
      !isRealDay(t) ||
      !Number.isInteger(t.hour) ||
      !Number.isInteger(t.minute) ||
      t.hour < 0 ||
      t.hour > 23 ||
      t.minute < 0 ||
      t.minute > 59 ||
      (t.second ?? 0) !== 0
    ) {
      throw new Error(`lock.addPasscode: ${JSON.stringify(t)} is not a whole minute of a real date`);
    }
  }
  const wall = (t: WallClockTime) => Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute);
  if (wall(ends) <= wall(starts)) throw new Error("lock.addPasscode: a time span must end after it starts");
  return {
    ...PERMANENT_WINDOW,
    startDate: frameDate(starts),
    endDate: frameDate(ends),
    week: 0xff,
    startTime: Buffer.from([starts.hour, starts.minute]),
    endTime: Buffer.from([ends.hour, ends.minute]),
    validity: 2,
  };
}

/**
 * A Repeated Entry's window, as the app sends it: each date as {@link frameDate}, the weekdays as a mask
 * in {@link WEEKDAYS} order with the top bit set (Monday, Wednesday and Friday are `aa`), all day
 * (`0000` to `ffff`), validity `1`. Throws on a day that is not real, on an end before its start, and on
 * no weekday or one not in {@link WEEKDAYS}.
 */
function repeatedWindow(span: Extract<PasscodeValidity, { kind: "repeated" }>): PasscodeWindow {
  const { starts, ends, days } = span;
  for (const t of [starts, ends]) {
    if (!isRealDay(t)) throw new Error(`lock.addPasscode: ${JSON.stringify(t)} is not a real day`);
  }
  const day = (t: Pick<WallClockTime, "year" | "month" | "day">) => Date.UTC(t.year, t.month - 1, t.day);
  if (day(ends) < day(starts)) throw new Error("lock.addPasscode: repeated entry must not end before it starts");
  if (days.length === 0) throw new Error("lock.addPasscode: repeated entry needs at least one weekday");
  const unknown = days.find((d) => !WEEKDAYS.includes(d));
  if (unknown !== undefined) throw new Error(`lock.addPasscode: ${JSON.stringify(unknown)} is not a weekday`);
  return {
    ...PERMANENT_WINDOW,
    startDate: frameDate(starts),
    endDate: frameDate(ends),
    week: days.reduce((mask, d) => mask | (1 << WEEKDAYS.indexOf(d)), 0x80),
    validity: 1,
  };
}

/** The instant `time` names on the lock's clock `tz`. Throws on a zone this cannot evaluate. */
function onLockClock(tz: string | undefined, time: WallClockTime): number {
  const at = posixWallClockToEpoch(tz ?? "", time);
  if (at === undefined) {
    throw new Error(`lock.addPasscode: the lock's clock zone ${JSON.stringify(tz)} is not one the SDK can read`);
  }
  return at;
}

/**
 * The calendar day it is now on the lock's clock `tz`: the day whose midnight on that clock is the latest
 * one not after the present instant. Throws on a zone this cannot evaluate.
 */
function lockToday(tz: string | undefined): Pick<WallClockTime, "year" | "month" | "day"> {
  const now = new Date();
  for (const offset of [1, 0, -1]) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
    const day = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    if (onLockClock(tz, { ...day, hour: 0, minute: 0 }) * 1000 <= now.getTime()) return day;
  }
  throw new Error(`lock.addPasscode: no day on the lock's clock ${JSON.stringify(tz)} has begun`);
}

/** The cloud schedule the app records for a code with no dates or times: permanent, and OneTime. */
const UNBOUNDED_SCHEDULE = JSON.stringify({
  startDate: 0,
  endDate: -1,
  timePeriodNum: 1,
  timePeriods: [{ periodic: 127, startTime: "0:0", endTime: "-1:-1" }],
});

/** What a model's cloud schedule is spelled from: a code's frame window, its validity and the lock's clock. */
interface ScheduleSource {
  window: PasscodeWindow;
  validity: PasscodeValidity | undefined;
  /** The lock's clock zone, as its station reports it. */
  tz: string | undefined;
}

/** A time of day as a Time Span's cloud record spells it, `HH:MM`. */
const hhmm = (t: WallClockTime) => `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;

/**
 * A code's schedule as the cloud record of a Smart Lock C33 or C30 stores it, as the app records it. A
 * dated code carries its first day's midnight and its last day's last second as instants on the lock's
 * clock `tz`, and one time period: a Time Span's `periodic` 255 and its two times as `HH:MM`, a Repeated
 * Entry's frame weekday byte and `0:0` to `-1:-1`. A permanent or OneTime code carries
 * {@link UNBOUNDED_SCHEDULE}. Throws on a lock clock `tz` this cannot evaluate.
 */
function smartLockSchedule({ window, validity, tz }: ScheduleSource): string {
  if (validity?.kind !== "timeSpan" && validity?.kind !== "repeated") return UNBOUNDED_SCHEDULE;
  const { starts, ends } = validity;
  return JSON.stringify({
    startDate: onLockClock(tz, { ...starts, hour: 0, minute: 0, second: 0 }),
    endDate: onLockClock(tz, { ...ends, hour: 23, minute: 59, second: 59 }),
    timePeriodNum: 1,
    timePeriods: [
      validity.kind === "timeSpan"
        ? { periodic: 255, startTime: hhmm(validity.starts), endTime: hhmm(validity.ends) }
        : { periodic: window.week, startTime: "0:0", endTime: "-1:-1" },
    ],
  });
}

/**
 * A window as the FamiLock S3's cloud record spells it: the frame's dates, weekday byte and times as
 * upper-case hex, the weekday byte with its top bit set — the app records `FF` for a permanent code,
 * whose frame carries `7f`, and a Repeated Entry's `d4` as `D4`.
 */
function famiLockSchedule({ window }: ScheduleSource): string {
  const hex = (b: Buffer) => b.toString("hex").toUpperCase();
  return JSON.stringify({
    startDay: hex(window.startDate),
    endDay: hex(window.endDate),
    week: hex(Buffer.from([window.week | 0x80])),
    startTime: hex(window.startTime),
    endTime: hex(window.endTime),
  });
}

/** How a model spells a code where the models that take the add-passcode frame differ. */
interface PasscodeDialect {
  /** The schedule the model's cloud record stores for a code, the JSON string verbatim. */
  schedule(code: ScheduleSource): string;
  /** A OneTime code's window on the lock's clock `tz`. */
  oneTime(tz: string | undefined): PasscodeWindow;
}

/** The Smart Lock C33's spelling, which the C30 shares. */
const SMART_LOCK_DIALECT: PasscodeDialect = { schedule: smartLockSchedule, oneTime: () => ONE_TIME_WINDOW };

/**
 * The FamiLock S3's spelling: its cloud record is {@link famiLockSchedule}, and the app starts a OneTime
 * code on the day it is added, on the lock's clock, where the C33 carries no start date.
 */
const FAMILOCK_DIALECT: PasscodeDialect = {
  schedule: famiLockSchedule,
  oneTime: (tz) => ({ ...ONE_TIME_WINDOW, startDate: frameDate(lockToday(tz)) }),
};

/** The window `validity` asks for, in `dialect`; permanent without one. Throws on a kind it does not know. */
function windowOf(
  validity: PasscodeValidity | undefined,
  tz: string | undefined,
  dialect: PasscodeDialect,
): PasscodeWindow {
  switch (validity?.kind) {
    case undefined:
      return PERMANENT_WINDOW;
    case "timeSpan":
      return timeSpanWindow(validity);
    case "repeated":
      return repeatedWindow(validity);
    case "oneTime":
      return dialect.oneTime(tz);
    default:
      throw new Error(`lock.addPasscode: ${JSON.stringify(validity)} is not a validity`);
  }
}

/**
 * The fields of the add-passcode frame after its time and account id (`A3`…`AD`): the code as ASCII
 * digits, the window's user type, dates, weekdays, times and single-use field, the name, the user's short
 * id as two bytes, and the window's validity. Byte-for-byte the frame the app sends to add a code to a
 * C33, a C30 or an S3.
 */
function passcodeFields(passcode: string, name: string, shortUserId: string, window: PasscodeWindow): Buffer[] {
  return [
    Buffer.from(passcode, "ascii"),
    Buffer.from([window.userType]),
    window.startDate,
    window.endDate,
    Buffer.from([window.week]),
    window.startTime,
    window.endTime,
    Buffer.from([window.singleUse]),
    Buffer.from(name, "utf8"),
    Buffer.from(shortUserId, "hex"),
    Buffer.from([window.validity]),
  ];
}

/** A lock's keypad users as bound: their cloud records, the lock's `ff09` exchange, its clock and its model. */
interface KeypadLock {
  users: DeviceUserDirectory;
  exchange: NonNullable<Ff09SettingsReader["exchange"]>;
  /** The lock's clock zone, as its station reports it. */
  tz: string | undefined;
  dialect: PasscodeDialect;
  /** The acting account's own short id, which {@link changePasscode} and {@link deleteUser} refuse. */
  ownShortUserId: string | undefined;
}

/** The keypad binding of a model that keeps keypad users here, once its `ff09` exchange is bound. */
function keypadLockOf(users: DeviceUserDirectory, { ctx, ff09Settings }: MemberDeps): KeypadLock | undefined {
  const exchange = ff09Settings?.exchange?.bind(ff09Settings);
  if (!keepsKeypadUsers(ctx) || !exchange) return undefined;
  return {
    users,
    exchange,
    tz: ctx.timezone,
    dialect: isFamiLockS3(ctx) ? FAMILOCK_DIALECT : SMART_LOCK_DIALECT,
    ownShortUserId: ctx.shortUserId,
  };
}

/** Refuse, naming `method`, a passcode the frame cannot carry: not digits, or longer than a field. */
function checkPasscode(method: string, passcode: string): void {
  if (!/^\d+$/.test(passcode)) throw new Error(`lock.${method}: a passcode is digits only`);
  if (passcode.length > MAX_FIELD_BYTES) {
    throw new Error(`lock.${method}: a passcode is at most ${MAX_FIELD_BYTES} bytes`);
  }
}

/** Refuse, naming `method`, a short id that is not 4 hex digits, and the acting account's own. */
function checkKeypadUser(method: string, lock: KeypadLock, shortUserId: string): void {
  if (!/^[0-9a-fA-F]{4}$/.test(shortUserId)) throw new Error(`lock.${method}: a short id is 4 hex digits`);
  if (shortUserId.toLowerCase() === lock.ownShortUserId?.toLowerCase()) {
    throw new Error(`lock.${method}: refusing the account's own user`);
  }
}

/**
 * Add a keypad code the way the vendor app does: create the user's cloud record, which assigns its short
 * id; send the lock the code under that id, which it answers with status `0` and the code's password id
 * in reply field `a1`; then record that password (type `1`, a keypad code, its id in upper-case hex as the
 * app records it) and its schedule under the user in the cloud, which lists the user with no password
 * until it is.
 *
 * A code, name or window that cannot be sent rejects before anything is sent. Any later failure rejects
 * naming the cloud user created for it, and the code's password id once the lock has stored it. A lock
 * refusal leaves that user in the cloud holding no code, as the app leaves it (a lock refuses a passcode
 * it already holds with status `17`).
 */
async function addPasscode(
  lock: KeypadLock,
  name: string,
  passcode: string,
  validity?: PasscodeValidity,
): Promise<{ shortUserId: string; passwordId: string }> {
  checkPasscode("addPasscode", passcode);
  if (Buffer.byteLength(name, "utf8") > MAX_FIELD_BYTES) {
    throw new Error(`lock.addPasscode: a name is at most ${MAX_FIELD_BYTES} bytes`);
  }
  const window = windowOf(validity, lock.tz, lock.dialect);
  const schedule = lock.dialect.schedule({ window, validity, tz: lock.tz });
  const { shortUserId } = await lock.users.addUser(name);
  const reply = await lock
    .exchange(PASSCODE_WIRE.ADD, PASSCODE_WIRE.API_COMMAND, passcodeFields(passcode, name, shortUserId, window))
    .catch((e: Error) => {
      throw new Error(`lock.addPasscode: ${e.message} (cloud user ${shortUserId} remains)`, { cause: e });
    });
  if (reply.status !== 0) {
    throw new Error(`lock.addPasscode: device result ${reply.status} (cloud user ${shortUserId} remains)`);
  }
  const passwordId = reply.fields.get(0xa1);
  if (passwordId?.length !== 2) {
    throw new Error(`lock.addPasscode: the lock's reply carries no password id (cloud user ${shortUserId} remains)`);
  }
  const added = { shortUserId, passwordId: passwordId.toString("hex").toUpperCase() };
  await lock.users
    .savePassword(shortUserId, { passwordId: added.passwordId, passwordType: 1, schedule })
    .catch((e: Error) => {
      throw new Error(
        `lock.addPasscode: the lock stored code ${added.passwordId} under user ${shortUserId}, but the cloud ` +
          `did not record it: ${e.message}`,
        { cause: e },
      );
    });
  return added;
}

/**
 * Change the code of the keypad user `shortUserId` the way the vendor app does: one frame carrying the
 * user's id and the new code, which the lock answers with status `0`. The code keeps its schedule, and
 * the cloud record is left as it is — it holds the code's id and schedule, never the code. A malformed
 * short id or passcode, and the acting account's own user, are refused before anything is sent; a lock
 * refusal rejects with its status.
 */
async function changePasscode(lock: KeypadLock, shortUserId: string, passcode: string): Promise<void> {
  checkKeypadUser("changePasscode", lock, shortUserId);
  checkPasscode("changePasscode", passcode);
  const reply = await lock.exchange(PASSCODE_WIRE.CHANGE, PASSCODE_WIRE.API_COMMAND, [
    Buffer.from(shortUserId, "hex"),
    Buffer.from(passcode, "ascii"),
  ]);
  if (reply.status !== 0) throw new Error(`lock.changePasscode: device result ${reply.status}`);
}

/**
 * Delete a keypad user the way the vendor app does: tell the lock to drop the user `shortUserId` and
 * every credential stored under it, which it answers with status `0`; then remove the user's cloud
 * record, its passwords with it. A lock refusal rejects with its status before the cloud is touched.
 * Refuses a short id that is not 4 hex digits, and the acting account's own.
 */
async function deleteUser(lock: KeypadLock, shortUserId: string): Promise<void> {
  checkKeypadUser("deleteUser", lock, shortUserId);
  const reply = await lock.exchange(PASSCODE_WIRE.DELETE_USER, PASSCODE_WIRE.API_COMMAND, [
    Buffer.from(shortUserId, "hex"),
  ]);
  if (reply.status !== 0) throw new Error(`lock.deleteUser: device result ${reply.status}`);
  await lock.users.deleteUser(shortUserId);
}

/**
 * Whether the device speaks the `ff09` settings frames at all. The classic Wi-Fi lock actuates over its
 * own keyed envelope and never negotiates the session key those frames ride on, so a settings write
 * aimed at it can only time out — the members are withheld there rather than offered and failing.
 */
const speaksFf09Settings = (ctx: CommandContext): boolean => !isClassicWifiLock(ctx);

/**
 * Whether the `ff09` settings writes are offered. Not on the FamiLock S3: it answers the settings GET and
 * takes lock and unlock, but no settings write has been seen on it.
 */
const offersSettingsWrites = (ctx: CommandContext): boolean => !isFamiLockS3(ctx);

/** Rain Mode's gate: the P2P video lock, and only a device that takes the `ff09` settings frame and its writes. */
const rainModeAvailable = (ctx: CommandContext): boolean =>
  overP2p(ctx) && speaksFf09Settings(ctx) && offersSettingsWrites(ctx);

/**
 * Every `lock` feature, declared once.
 *
 * The six toggles after `setRainMode` share its confirmed frame SHAPE and are grounded in the app's own
 * JS, but none has been captured against a real device — so each is `unverified`: DECLARED, so the
 * capability documents what the lock has, and NOT installed, because a fire-and-forget write that is
 * wrong looks exactly like success. A caller sees them as optional and learns at compile time that they
 * are not settable yet; promoting one is a single edit once a capture lands.
 *
 * They carry no `param`: a setting id is not a param id, nothing reports these back, and declaring one
 * would put a wire number where the schema expects a reported value.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const LOCK_MEMBERS = {
  /**
   * The lock's own state, verified on param 6000: "4" = locked, "3" = unlocked.
   * `writtenElsewhere` points at the `lock`/`unlock` methods — a single `write` cannot express two
   * verbs that carry no value.
   */
  locked: {
    param: 6000,
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    writtenElsewhere: true,
    coerce: (raw) => String(raw).trim() === "4",
    description: "Lock state, true=locked (verified: param 6000, 4=locked, 3=unlocked).",
  },
  /**
   * Cell charge as a percentage, on param 1101 or smart-lock param 6001. Named `battery`
   * within this capability rather than deferring to the `battery` capability: a lock resolves as a lock,
   * so the accessor is `dev.lock().battery`.
   */
  battery: {
    param: 1101,
    readAliases: [{ paramType: 6001 }],
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "verified",
    description: "Lock battery level 0-100 (verified: param 1101, alias 6001).",
  },
  /**
   * Link quality in dBm as the lock measures it, on the shared param 1141. On the `ff09` wire the
   * actuations are fire-and-forget, so a weak link is silent rather than an error.
   */
  rssi: {
    param: 1141,
    type: "number",
    unit: "dBm",
    kind: "dbm",
    provenance: "verified",
    description: "Lock signal strength (verified: param 1141 = RSSI).",
  },

  /**
   * Lock the deadbolt/door. Resolves after sending, without confirming physical state — except on the
   * classic Wi-Fi lock, which answers: there it rejects on a device refusal or no reply as well.
   */
  lock: method(
    ({ ctx, sink }) =>
      (): Promise<void> =>
        actuate(true, ctx, sink),
    "Lock the deadbolt/door.",
    actuationAvailable,
  ),
  /**
   * Unlock the deadbolt/door. Resolves after sending, without confirming physical state — except on the
   * classic Wi-Fi lock, which answers: there it rejects on a device refusal or no reply as well.
   */
  unlock: method(
    ({ ctx, sink }) =>
      (): Promise<void> =>
        actuate(false, ctx, sink),
    "Unlock the deadbolt/door.",
    actuationAvailable,
  ),

  /**
   * Read-modify-write the auto-lock setting: the transport GETs the device's current settings, changes
   * only `enabled` (+ `delaySeconds` if given — otherwise the current delay is preserved), and writes the
   * rest back verbatim. Works on both the T8531 video lock and the T85D0 garage/lock, which share the
   * identical settings frame; confirmed on-device in both directions on both families.
   *
   * **Unlike `lock`/`unlock` this can reject on a device TIMEOUT**, not just missing identity — the GET
   * step is a genuine precondition, so this one is not fire-and-forget.
   */
  setAutoLock: method(
    ({ ctx, sink }) =>
      (enabled: boolean, delaySeconds?: number): Promise<void> => {
        if (!ctx.adminUserId) {
          return Promise.reject(
            new Error(`lock.setAutoLock: missing member identity (admin_user_id) [${describeDevice(ctx)}]`),
          );
        }
        return sink.dispatch({
          kind: "ff09-autolock",
          adminUserId: ctx.adminUserId,
          deviceSn: ctx.serial ?? "",
          enabled,
          delaySeconds,
        });
      },
    "Read-modify-write the auto-lock setting, preserving the fields it does not change.",
    (ctx) => !isVideoSmartLock(ctx) && speaksFf09Settings(ctx) && offersSettingsWrites(ctx),
  ),

  /**
   * Toggle Rain Mode — a pure blind write, unlike `setAutoLock`: the compact frame carries only this one
   * field, so there is no GET pass and it is fire-and-forget. Confirmed on-device end-to-end in both
   * directions, with the app UI reflecting the new state afterward. P2P video lock only.
   */
  setRainMode: method(
    ({ ctx, sink }) =>
      (enabled: boolean): Promise<void> =>
        settingToggle(LOCK_SETTING_ID.RAIN_MODE, "setRainMode", enabled, ctx, sink),
    "Toggle Rain Mode.",
    rainModeAvailable,
  ),

  /**
   * Lock the door by a single touch on the pad, with no code. First of the six compact toggles: all
   * `unverified` (frame shape read out of the app's JS, never captured), so no setter is installed and
   * `setOneTouchLock` lands optional on the surface — a caller learns at compile time. `writeOnly` too:
   * nothing reports the setting back, so there is no getter either.
   */
  oneTouchLock: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    available: overP2p,
    provenance: "apk",
    description: "One-touch locking (setting-id 1). Wire shape confirmed in the app's own JS, NOT captured.",
    write: (v, ctx) => settingToggleCommand(LOCK_SETTING_ID.ONE_TOUCH_LOCK, v, ctx),
  },
  /**
   * Pad anti-shoulder-surfing: the lock asks for extra random digits around the real code so a watcher
   * cannot read it off worn keys. Same `unverified` + `writeOnly` + P2P-only standing as its five
   * siblings — declared so the capability documents the lock, not installed.
   */
  scramblePasscode: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    available: overP2p,
    provenance: "apk",
    description:
      "Scramble the passcode entry pad (setting-id 3). Wire shape confirmed in the app's own JS, NOT captured.",
    write: (v, ctx) => settingToggleCommand(LOCK_SETTING_ID.SCRAMBLE_PASSCODE, v, ctx),
  },
  /**
   * Whether the lock reports its Wi-Fi status — a reporting toggle, not the radio itself, on the app's
   * own naming. Same `unverified` + `writeOnly` + P2P-only standing as its five siblings; treat the
   * meaning as the app's label until a capture pins the behaviour.
   */
  wifiStatus: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    available: overP2p,
    provenance: "apk",
    description: "Wi-Fi status reporting (setting-id 5). Wire shape confirmed in the app's own JS, NOT captured.",
    write: (v, ctx) => settingToggleCommand(LOCK_SETTING_ID.WIFI_STATUS, v, ctx),
  },
  /**
   * Whether the lock records its own event history on-device. Same `unverified` + `writeOnly` +
   * P2P-only standing as its five siblings — the frame shape comes from the app's JS and has never been
   * driven against hardware.
   */
  logEnabled: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    available: overP2p,
    provenance: "apk",
    description: "Event-log recording (setting-id 6). Wire shape confirmed in the app's own JS, NOT captured.",
    write: (v, ctx) => settingToggleCommand(LOCK_SETTING_ID.ENABLE_LOG, v, ctx),
  },
  /**
   * The lock's own privacy mode — unrelated to the camera capability's privacy burst, which is a
   * different device, a different wire and a different meaning. Same `unverified` + `writeOnly` +
   * P2P-only standing as its five siblings.
   */
  privacyMode: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    available: overP2p,
    provenance: "apk",
    description: "Lock privacy mode (setting-id 9). Wire shape confirmed in the app's own JS, NOT captured.",
    write: (v, ctx) => settingToggleCommand(LOCK_SETTING_ID.PRIVACY_MODE, v, ctx),
  },
  /**
   * The rear-deadbolt counterpart to `oneTouchLock`, on a lock that has a second bolt — so a model with
   * one bolt has nothing for it to drive. Last of the six compact toggles and shares their standing
   * exactly: `unverified`, `writeOnly`, P2P-only, no setter installed.
   */
  oneTouchRearLock: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    available: overP2p,
    provenance: "apk",
    description: "One-touch rear locking (setting-id 11). Wire shape confirmed in the app's own JS, NOT captured.",
    write: (v, ctx) => settingToggleCommand(LOCK_SETTING_ID.ONE_TOUCH_REAR_LOCK, v, ctx),
  },

  /**
   * Add a keypad code for a new user named `name` (see {@link addPasscode}): permanent, or as `validity`
   * says — a time span, repeated entry on chosen weekdays, or once. Answers the user's short id and the
   * code's password id, both as the 4-hex-digit strings the cloud's user list carries. Smart Lock C33, C30
   * and FamiLock S3, each kind confirmed on all three.
   */
  addPasscode: provided(
    "deviceUsers",
    (users, deps) => {
      const lock = keypadLockOf(users, deps);
      return lock
        ? (name: string, passcode: string, validity?: PasscodeValidity) => addPasscode(lock, name, passcode, validity)
        : undefined;
    },
    "Add a keypad passcode for a new user: permanent, within a time span, on chosen weekdays, or once.",
  ),

  /**
   * Change the code of the keypad user `shortUserId` (see {@link changePasscode}) to `passcode`, keeping
   * its schedule. Smart Lock C33, C30 and FamiLock S3, confirmed on each.
   */
  changePasscode: provided(
    "deviceUsers",
    (users, deps) => {
      const lock = keypadLockOf(users, deps);
      return lock ? (shortUserId: string, passcode: string) => changePasscode(lock, shortUserId, passcode) : undefined;
    },
    "Change a keypad user's passcode, keeping its schedule.",
  ),

  /**
   * Delete the keypad user `shortUserId` (see {@link deleteUser}) from the lock and the cloud, with every
   * code stored under it. `shortUserId` is the 4-hex-digit id {@link addPasscode} answers and the cloud's
   * user list carries. Smart Lock C33, C30 and FamiLock S3, confirmed on each.
   */
  deleteUser: provided(
    "deviceUsers",
    (users, deps) => {
      const lock = keypadLockOf(users, deps);
      return lock ? (shortUserId: string) => deleteUser(lock, shortUserId) : undefined;
    },
    "Delete a keypad user and every code stored under it.",
  ),

  /**
   * Read the current device-reported state through a HomeBase, with the station's reported timezone;
   * undefined means no settled locked/unlocked state.
   */
  refreshStatus: {
    ...provided(
      "media",
      (media, { ctx }) => {
        const query = media.p2pQuery?.bind(media);
        const timezone = ctx.timezone;
        return isVideoSmartLock(ctx) && ctx.homeBaseAttached && timezone && query
          ? () => refreshStatus(query, timezone)
          : undefined;
      },
      "Read the current lock state from the device.",
    ),
    answers: true,
  },

  /**
   * Read the device's current auto-lock settings via a live `GET_SETTINGS` round-trip — the SAME read
   * `setAutoLock` does internally, exposed standalone with no write attached. Works over BOTH transports.
   * A genuine request/reply query, not a passive property, so it always talks to the device.
   *
   * `answers` for that reason: the returned snapshot IS the point, so it is not a control to offer even
   * though it takes no arguments — offering it as one would run a round-trip and discard the answer.
   */
  getAutoLockState: {
    ...provided(
      "ff09Settings",
      (f, { ctx }) => (isVideoSmartLock(ctx) ? undefined : (): Promise<AutoLockSnapshot> => f.getAutoLockState()),
      "Read the current auto-lock settings via a live round-trip.",
    ),
    answers: true,
  },
} as const satisfies Members;

/**
 * The compact toggle as a `Command` for the member `write` path, which supplies no sink. Identity is
 * re-checked by the transport; a member write cannot carry a bespoke refusal, and these are all
 * `unverified` so none is installed today.
 */
function settingToggleCommand(settingId: number, enabled: boolean | number | string, ctx: CommandContext): Command {
  return {
    kind: "ff09-setting-toggle",
    adminUserId: ctx.adminUserId ?? "",
    deviceSn: ctx.serial ?? "",
    settingId,
    value: asBool(enabled),
  };
}
/**
 * The `locked` boolean a `lockState` push carries, derived from which `LockPushEvent` fired: the seven
 * `*_LOCK` actions (262..268) → `true`, the six `*_UNLOCK` actions (257..261 + 269) → `false`. The rest
 * of the 257..771 range — alarms, low-power, offline/online, OTA/status — is not a lock transition and
 * contributes no `locked` field, so a consumer reads state only from an event that actually carries one.
 */
function decodeLockTransition(signal: InboundSignal): Record<string, unknown> {
  if (signal.source !== "push" || signal.eventType === undefined) return {};
  const e = signal.eventType;
  if (e >= LockPushEvent.MANUAL_LOCK && e <= LockPushEvent.TEMPORARY_PW_LOCK) return { locked: true };
  const unlocked =
    (e >= LockPushEvent.MANUAL_UNLOCK && e <= LockPushEvent.APP_UNLOCK) || e === LockPushEvent.TEMPORARY_PW_UNLOCK;
  return unlocked ? { locked: false } : {};
}

/**
 * `lock` — smart lock. `locked` reports lock state via verified param 6000 (4=locked, 3=unlocked);
 * a device that reports no stable state param carries its transitions on the `lockState` event instead,
 * whose payload names the decoded `locked`.
 */
export const LOCK: CapabilityModule = {
  capability: "lock",
  description: "Smart-lock locked/unlocked state and battery.",
  members: LOCK_MEMBERS,
  properties: propertiesOf(LOCK_MEMBERS),
  decodeState(signal) {
    const report = nativeReport(signal);
    if (!report) return null;
    const params: Record<number, string> = {};
    if (nativeState(report.slState) !== undefined) params[6000] = String(report.slState);
    if (report.slBattery !== undefined) params[6001] = String(report.slBattery);
    return { params };
  },
  // Lock state is reported via param 6000 (verified: 4=locked, 3=unlocked); the model name (lock/safe) is a
  // signal, and every lock-codec device has the lock capability as its baseline.
  detection: { evidenceParams: [6000], modelHints: [/lock/i, /safe/i], codecs: ["lock"] },
  // Inbound FCM lock events (LockPushEvent 257..771: (un)lock actions + alarms) → one "lockState", whose
  // payload carries a decoded `locked` boolean for the (un)lock actions (see decodeLockTransition).
  events: [{ source: "push", match: [257, 771], emit: "lockState", derive: decodeLockTransition }],
};
