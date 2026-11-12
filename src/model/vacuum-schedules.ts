/**
 * The schedules a robot vacuum holds — `TimerResponse` on DP 164, decoded.
 *
 * The DP number comes from a `get_product_data_point` dump; the product catalogue names the DP, and the
 * vendor's `timing.proto` carries the message.
 *
 * The shape is deeper than anything else on this line — a repeated `TimerInfo`, each with four nested
 * containers and a `oneof` for what the timer actually does — which is why it decodes here rather than
 * as one more field reader inside `vacuum-clean`. It reads a payload and answers a list; it never asks
 * the device for one, and it holds no DP number of its own.
 *
 * **`TimerInfo.Addition` is deliberately not decoded.** It carries the account ids of whoever created
 * and last edited each timer — the kind of value this SDK does not surface without a reason.
 *
 * @module model/vacuum-schedules
 */
import type { RawDpCodec, RawDpField } from "../core/contracts.js";
import { WEEKDAYS, type Weekday } from "./weekdays.js";
import { each, flag, int, sub, text } from "./proto-read.js";

/** What a timer runs when it fires, as the vendor's `Action` oneof names it. */
export const VACUUM_SCHEDULE_ACTIONS = ["autoClean", "roomsClean", "cruise", "sceneClean"] as const;
export type VacuumScheduleAction = (typeof VACUUM_SCHEDULE_ACTIONS)[number];

/** One schedule the robot holds. */
export interface VacuumSchedule {
  /** The device's own id for this timer — what a future edit or delete would name it by. */
  readonly id: number;
  /** Whether the timer is switched on. A valid timer that is off stays stored and does not fire. */
  readonly enabled: boolean;
  /**
   * Whether the device still considers the timer usable. A timer pointing at a deleted scene or a map
   * that no longer exists is reported `valid: false` rather than removed, so the app can show why.
   */
  readonly valid: boolean;
  /** `true` for a weekly timer, `false` for one that fires once. */
  readonly repeats: boolean;
  /** Hour of the day it fires, 0–23, in the user's own timezone — see {@link utcOffsetSeconds}. */
  readonly hour: number;
  /** Minute of the hour it fires, 0–59. */
  readonly minute: number;
  /**
   * The days a repeating timer fires on. Empty for a one-shot timer, and empty for a repeating one
   * whose `week_bits` is zero — which the device treats as a timer that never fires.
   */
  readonly weekdays: readonly Weekday[];
  /**
   * The offset from UTC the timer's clock was set against, in seconds east.
   *
   * Carried per timer rather than per device: the robot stores whatever the phone that created the
   * schedule told it, so an absolute instant follows from this offset and not from any local zone.
   */
  readonly utcOffsetSeconds: number;
  /** Whether the phone that created the timer said its region observes daylight saving. */
  readonly daylightSaving: boolean;
  /** What the timer runs. */
  readonly action: VacuumScheduleAction;
  /** The map the run targets, for a rooms-clean or a cruise. */
  readonly mapId?: number;
  /** The rooms a rooms-clean visits, in the order the timer lists them. */
  readonly roomIds?: readonly number[];
  /** The scene a scene-clean runs. */
  readonly sceneId?: number;
  /** The scene's name as the device last saw it — kept so a deleted scene can still be named. */
  readonly sceneName?: string;
}

/** Field numbers inside `TimerResponse` (DP 164). */
const RESPONSE_FIELD = { METHOD: 1, SEQ: 2, RESULT: 3, TIMERS: 4 } as const;

/** Field numbers inside `TimerInfo`. */
const TIMER_FIELD = { ID: 1, STATUS: 2, DESC: 3, ADDITION: 4, ACTION: 5 } as const;

/** `TimerInfo.Id`, `TimerInfo.Status`, `TimerInfo.Desc` and the two containers below `Desc`. */
const ID_FIELD = { VALUE: 1 } as const;
const STATUS_FIELD = { VALID: 1, OPENED: 2 } as const;
const DESC_FIELD = { TRIGGER: 1, TIMING: 2, CYCLE: 3 } as const;
const TIMING_FIELD = { USER_TZ: 1, SUMMER: 2, HOURS: 3, MINUTES: 4 } as const;
const CYCLE_FIELD = { WEEK_BITS: 1 } as const;

/**
 * `TimerInfo.Action`, whose `Param` oneof is what says which kind of run the timer starts.
 *
 * The oneof branch is read in preference to `Action.type` beside it, and the two agree by
 * construction. `type` is an enum whose first member is `SCHEDULE_AUTO_CLEAN = 0`, so proto3 omits it
 * on the commonest timer there is — reading it alone would answer "auto clean" for every schedule,
 * including the ones that are not.
 */
const ACTION_FIELD = { TYPE: 1, AUTO_CLEAN: 3, ROOMS_CLEAN: 4, CRUISE: 5, SCENE_CLEAN: 6 } as const;

/**
 * `ScheduleRoomsClean`, which carries its rooms in one of two places.
 *
 * `General` is the X9-era layout and `Custom` the one X10-class hardware uses; the vendor kept both and
 * numbers the room list differently in each (6 there, 3 here). Both are read, `Custom` first, because a
 * device sends whichever its generation uses and neither is a fallback for the other.
 */
const ROOMS_CLEAN_FIELD = { GENERAL: 2, CUSTOM: 3 } as const;
const ROOMS_GENERAL_FIELD = { MAP_ID: 1, ROOMS: 6 } as const;
const ROOMS_CUSTOM_FIELD = { MAP_ID: 1, ROOMS: 3 } as const;
const ROOM_FIELD = { ID: 1 } as const;
const CRUISE_FIELD = { MAP_ID: 1 } as const;
const SCENE_FIELD = { SCENE_ID: 1, SCENE_NAME: 2 } as const;

/** The `Desc.Trigger` value that means the timer repeats. `SINGLE = 0` is the omitted default. */
const TRIGGER_CYCLE = 1;

/** Expand a `Cycle.week_bits` mask to the days it names, in the vendor's Sunday-first bit order. */
function weekdaysOf(bits: number): readonly Weekday[] {
  return WEEKDAYS.filter((_, i) => (bits & (1 << i)) !== 0);
}

/** Read the room ids out of whichever of `General` / `Custom` the device populated. */
function roomsOf(codec: RawDpCodec, rooms: readonly RawDpField[] | undefined, field: number): number[] {
  return each(codec, rooms, field).map((room) => int(room, ROOM_FIELD.ID));
}

/** What the timer runs, plus whatever target its branch carries. */
function actionOf(
  codec: RawDpCodec,
  timer: readonly RawDpField[] | undefined,
): Pick<VacuumSchedule, "action" | "mapId" | "roomIds" | "sceneId" | "sceneName"> {
  const action = sub(codec, timer, TIMER_FIELD.ACTION);

  const rooms = sub(codec, action, ACTION_FIELD.ROOMS_CLEAN);
  if (rooms) {
    const custom = sub(codec, rooms, ROOMS_CLEAN_FIELD.CUSTOM);
    const general = custom ? undefined : sub(codec, rooms, ROOMS_CLEAN_FIELD.GENERAL);
    const held = custom ?? general;
    return {
      action: "roomsClean",
      mapId: int(held, custom ? ROOMS_CUSTOM_FIELD.MAP_ID : ROOMS_GENERAL_FIELD.MAP_ID),
      roomIds: roomsOf(codec, held, custom ? ROOMS_CUSTOM_FIELD.ROOMS : ROOMS_GENERAL_FIELD.ROOMS),
    };
  }

  const cruise = sub(codec, action, ACTION_FIELD.CRUISE);
  if (cruise) return { action: "cruise", mapId: int(cruise, CRUISE_FIELD.MAP_ID) };

  const scene = sub(codec, action, ACTION_FIELD.SCENE_CLEAN);
  if (scene) {
    return {
      action: "sceneClean",
      sceneId: int(scene, SCENE_FIELD.SCENE_ID),
      sceneName: text(scene, SCENE_FIELD.SCENE_NAME),
    };
  }

  // No branch left to read: an auto-clean timer, whose own branch may be omitted entirely when every
  // field in it is default. `Action.type` is consulted last and only to catch a branch a later firmware
  // adds that this version cannot name — an unknown type is still an auto-clean to the enum's zero.
  return { action: VACUUM_SCHEDULE_ACTIONS[int(action, ACTION_FIELD.TYPE)] ?? "autoClean" };
}

/** Decode one `TimerInfo`. */
function scheduleOf(codec: RawDpCodec, timer: readonly RawDpField[]): VacuumSchedule {
  const status = sub(codec, timer, TIMER_FIELD.STATUS);
  const desc = sub(codec, timer, TIMER_FIELD.DESC);
  const timing = sub(codec, desc, DESC_FIELD.TIMING);
  const repeats = int(desc, DESC_FIELD.TRIGGER) === TRIGGER_CYCLE;

  return {
    id: int(sub(codec, timer, TIMER_FIELD.ID), ID_FIELD.VALUE),
    // An absent `Status` is a timer the device said nothing about, which it only does for one it holds
    // and considers usable — so the zero-omission default reads the right way round here.
    enabled: flag(status, STATUS_FIELD.OPENED),
    valid: flag(status, STATUS_FIELD.VALID),
    repeats,
    hour: int(timing, TIMING_FIELD.HOURS),
    minute: int(timing, TIMING_FIELD.MINUTES),
    weekdays: repeats ? weekdaysOf(int(sub(codec, desc, DESC_FIELD.CYCLE), CYCLE_FIELD.WEEK_BITS)) : [],
    utcOffsetSeconds: int(timing, TIMING_FIELD.USER_TZ),
    daylightSaving: flag(timing, TIMING_FIELD.SUMMER),
    ...actionOf(codec, timer),
  };
}

/**
 * Decode a `TimerResponse` (DP 164) to the schedules it reports, or `undefined`.
 *
 * `undefined` means the payload could not be read at all — no codec, not a Raw-DP value, malformed
 * bytes. An **empty array** is a different and equally real answer: the device reports its timers in
 * full every time, so a report carrying none says this robot has no schedules set.
 *
 * The device sends this unprompted on boot and after any change, and in reply to an `INQUIRY`. Which
 * of those produced a given payload does not change the reading — every report is the complete list —
 * so the request `method` and `seq` beside it are not surfaced.
 */
export function decodeVacuumSchedules(
  raw: unknown,
  codec: RawDpCodec | undefined,
): readonly VacuumSchedule[] | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const report = codec.decode(raw);
  if (!report) return undefined;
  return each(codec, report, RESPONSE_FIELD.TIMERS).map((timer) => scheduleOf(codec, timer));
}

/** How many schedules a `TimerResponse` reports, or `undefined` when the payload could not be read. */
export function decodeVacuumScheduleCount(raw: unknown, codec: RawDpCodec | undefined): number | undefined {
  return decodeVacuumSchedules(raw, codec)?.length;
}

/** How many of the reported schedules are switched on and still usable. */
export function decodeActiveVacuumScheduleCount(raw: unknown, codec: RawDpCodec | undefined): number | undefined {
  return decodeVacuumSchedules(raw, codec)?.filter((s) => s.enabled && s.valid).length;
}
