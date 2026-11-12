/**
 * The days of the week in the vendor's own bit order — Sunday first, at bit 0 of every weekday mask its
 * devices carry.
 *
 * Written out rather than derived from a locale so the mapping is the wire's and not the reader's.
 */
export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
