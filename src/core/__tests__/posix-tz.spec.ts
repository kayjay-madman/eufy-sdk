import { describe, it, expect } from "vitest";
import { posixWallClockToEpoch, type WallClockTime } from "../posix-tz.js";

/**
 * The POSIX rule evaluator, checked against the platform's own zone database: for each rule and an
 * equivalent IANA zone, every wall time below must name the instant `Intl` says it does — including the
 * days the clocks change, on both hemispheres.
 */
function intlEpoch(zone: string, t: WallClockTime): number {
  const guess = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second ?? 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  let utc = guess;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(utc)).map((x) => [x.type, Number(x.value)]));
    const shown = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
    utc += guess - shown;
  }
  return utc / 1000;
}

const CASES: Array<[string, string]> = [
  ["EST5EDT,M3.2.0,M11.1.0|1.1159", "America/New_York"],
  ["CET-1CEST,M3.5.0,M10.5.0/3", "Europe/Berlin"],
  ["AEST-10AEDT,M10.1.0,M4.1.0/3", "Australia/Sydney"],
  ["IST-5:30", "Asia/Kolkata"],
  ["<+09>-9", "Asia/Tokyo"],
];

const TIMES: WallClockTime[] = [
  { year: 2026, month: 1, day: 15, hour: 12, minute: 0 },
  { year: 2026, month: 3, day: 8, hour: 0, minute: 0 },
  { year: 2026, month: 3, day: 9, hour: 0, minute: 0 },
  { year: 2026, month: 3, day: 29, hour: 12, minute: 0 },
  { year: 2026, month: 4, day: 5, hour: 12, minute: 0 },
  { year: 2026, month: 7, day: 1, hour: 9, minute: 30 },
  { year: 2026, month: 10, day: 4, hour: 12, minute: 0 },
  { year: 2026, month: 10, day: 25, hour: 23, minute: 59, second: 59 },
  { year: 2026, month: 11, day: 1, hour: 0, minute: 0 },
  { year: 2026, month: 11, day: 12, hour: 0, minute: 0 },
  { year: 2026, month: 12, day: 24, hour: 23, minute: 59, second: 59 },
];

describe("posixWallClockToEpoch", () => {
  for (const [rule, zone] of CASES) {
    it(`agrees with ${zone} for ${rule}`, () => {
      for (const t of TIMES) expect(posixWallClockToEpoch(rule, t), JSON.stringify(t)).toBe(intlEpoch(zone, t));
    });
  }

  it("reads a skipped wall time as standard time and a repeated one as daylight time", () => {
    const ny = "EST5EDT,M3.2.0,M11.1.0";
    const at = (month: number, day: number, hour: number) => ({ year: 2026, month, day, hour, minute: 30 });
    expect(posixWallClockToEpoch(ny, at(3, 8, 2))).toBe(Date.UTC(2026, 2, 8, 7, 30) / 1000);
    expect(posixWallClockToEpoch(ny, at(11, 1, 1))).toBe(Date.UTC(2026, 10, 1, 5, 30) / 1000);
  });

  it("answers undefined for a string that is not a rule it evaluates", () => {
    const t = TIMES[0]!;
    expect(posixWallClockToEpoch("", t)).toBeUndefined();
    expect(posixWallClockToEpoch("America/New_York", t)).toBeUndefined();
    expect(posixWallClockToEpoch("EST5EDT,J60,J300", t)).toBeUndefined();
    expect(posixWallClockToEpoch("EST5EDT,M3.2.0", t)).toBeUndefined();
  });
});
