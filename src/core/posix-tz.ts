/**
 * POSIX `TZ` rule evaluation — turn a wall-clock time under a rule such as `EST5EDT,M3.2.0,M11.1.0` into
 * the instant it names. Devices report their zone in this form (a station's `time_zone`, sometimes with a
 * vendor suffix after `|`), and an instant is what a cloud record stores for a time the device keeps on
 * its own clock.
 *
 * Covers `std offset [dst [offset] [,start[/time],end[/time]]]` with names alphabetic or `<…>`-quoted,
 * offsets `[+-]hh[:mm[:ss]]` (positive WEST of Greenwich, as POSIX has it), and `Mm.w.d` transition
 * rules, defaulting to `02:00`. A rule in the Julian forms (`Jn`, `n`) is not evaluated.
 *
 * @module core/posix-tz
 */

/** A wall-clock moment: calendar date plus time of day, with no zone attached. */
export interface WallClockTime {
  year: number;
  /** 1–12. */
  month: number;
  /** 1–31. */
  day: number;
  /** 0–23. */
  hour: number;
  /** 0–59. */
  minute: number;
  /** 0–59; 0 when absent. */
  second?: number;
}

interface Transition {
  month: number;
  week: number;
  weekday: number;
  /** Seconds after local midnight. */
  at: number;
}

interface Rule {
  /** Seconds to ADD to local standard time to reach UTC. */
  std: number;
  dst?: { offset: number; start: Transition; end: Transition };
}

const NAME = /^(?:<[^>]+>|[A-Za-z]{3,})/;
const OFFSET = /^[+-]?\d{1,2}(?::\d{1,2}(?::\d{1,2})?)?/;

function seconds(text: string): number {
  const sign = text.startsWith("-") ? -1 : 1;
  const [h = 0, m = 0, s = 0] = text.replace(/^[+-]/, "").split(":").map(Number);
  return sign * (h * 3600 + m * 60 + s);
}

function transition(text: string): Transition | undefined {
  const m = /^M(\d{1,2})\.(\d)\.(\d)(?:\/([+-]?\d{1,3}(?::\d{1,2}(?::\d{1,2})?)?))?$/.exec(text);
  if (!m) return undefined;
  const [month, week, weekday] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || week < 1 || week > 5 || weekday > 6) return undefined;
  return { month, week, weekday, at: m[4] === undefined ? 7200 : seconds(m[4]) };
}

/** Parse a POSIX `TZ` rule, ignoring a vendor suffix after `|`; `undefined` when it is not one. */
function parse(tz: string): Rule | undefined {
  let rest = tz.split("|")[0]!.trim();
  const stdName = NAME.exec(rest)?.[0];
  if (!stdName) return undefined;
  rest = rest.slice(stdName.length);
  const stdOffset = OFFSET.exec(rest)?.[0];
  if (!stdOffset) return undefined;
  rest = rest.slice(stdOffset.length);
  const std = seconds(stdOffset);
  if (!rest) return { std };
  const dstName = NAME.exec(rest)?.[0];
  if (!dstName) return undefined;
  rest = rest.slice(dstName.length);
  const dstOffset = OFFSET.exec(rest)?.[0];
  const offset = dstOffset === undefined ? std - 3600 : seconds(dstOffset);
  rest = rest.slice(dstOffset?.length ?? 0);
  const [, startText, endText, extra] = rest.split(",");
  if (startText === undefined || endText === undefined || extra !== undefined || !rest.startsWith(",")) {
    return undefined;
  }
  const start = transition(startText);
  const end = transition(endText);
  return start && end ? { std, dst: { offset, start, end } } : undefined;
}

/** Seconds since the epoch of a wall-clock time read as if it were UTC. */
function asUtc(t: WallClockTime): number {
  return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second ?? 0) / 1000;
}

/** The wall-clock instant (read as UTC) at which a transition rule fires in `year`. */
function firesAt(rule: Transition, year: number): number {
  const firstWeekday = new Date(Date.UTC(year, rule.month - 1, 1)).getUTCDay();
  let day = 1 + ((rule.weekday - firstWeekday + 7) % 7) + (rule.week - 1) * 7;
  const daysInMonth = new Date(Date.UTC(year, rule.month, 0)).getUTCDate();
  while (day > daysInMonth) day -= 7;
  return Date.UTC(year, rule.month - 1, day) / 1000 + rule.at;
}

/** Whether daylight time is in force at the UTC instant `utc`. */
function inDst(rule: Required<Rule>["dst"], std: number, utc: number): boolean {
  const year = new Date(utc * 1000).getUTCFullYear();
  const start = firesAt(rule.start, year) + std;
  const end = firesAt(rule.end, year) + rule.offset;
  return start < end ? utc >= start && utc < end : utc >= start || utc < end;
}

/**
 * The instant, in seconds since the epoch, that `time` names on a clock following `tz`; `undefined` when
 * `tz` is not a rule this evaluates. A wall time in a spring-forward gap resolves to the standard
 * reading, the later instant; one in a fall-back repeat resolves to the daylight reading, the earlier.
 */
export function posixWallClockToEpoch(tz: string, time: WallClockTime): number | undefined {
  const rule = parse(tz);
  if (!rule) return undefined;
  const wall = asUtc(time);
  if (!rule.dst) return wall + rule.std;
  const asDst = wall + rule.dst.offset;
  return inDst(rule.dst, rule.std, asDst) ? asDst : wall + rule.std;
}
