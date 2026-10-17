// Calendar days where the reader is. A report over time counts by the reader's days, not by UTC's: a result
// recorded at six in the evening in Los Angeles belongs to that day there, though it is the next day in UTC.

/** One day: its date where the reader is (`2027-01-15`) and the instants it starts and ends at, in milliseconds. */
export type LocalDay = { day: string; from: number; to: number };

/**
 * True when the platform knows the time zone by this name (an IANA name such as `Europe/Berlin`, or `UTC`). An offset
 * such as `+05:37` is not a name: the reports count in quarters of an hour, and every named zone's midnight is a whole
 * quarter of an hour in UTC, which an offset's need not be.
 */
export function isZone(zone: string): boolean {
	if (!/^[A-Za-z]/.test(zone)) return false;
	try {
		new Intl.DateTimeFormat("en", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

const formats = new Map<string, Intl.DateTimeFormat>();
function format(zone: string): Intl.DateTimeFormat {
	let found = formats.get(zone);
	if (!found) {
		found = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
		});
		formats.set(zone, found);
	}
	return found;
}

/** The wall clock in the zone at an instant, written as if it were UTC. */
function wall(ms: number, zone: string): number {
	const parts: Record<string, number> = {};
	for (const part of format(zone).formatToParts(ms)) if (part.type !== "literal") parts[part.type] = Number(part.value);
	const { year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0 } = parts;
	return Date.UTC(year, month - 1, day, hour, minute, second);
}

/** The first instant of a date where the zone is (the date given as its midnight in UTC). */
function midnight(date: number, zone: string): number {
	// The offset at a guess may differ from the one at the answer when the clocks change that day, so each guess is
	// taken from the one before. Where the clocks skip midnight (Santiago goes from 00:00 to 01:00), the second guess
	// is an hour early, in the day before: the day starts at the earliest guess whose clock reads that date.
	const first = date - (wall(date, zone) - date);
	const second = date - (wall(first, zone) - first);
	const onDate = [first, second].filter((at) => wall(at, zone) >= date && wall(at, zone) < date + 86_400_000);
	return Math.min(...(onDate.length > 0 ? onDate : [second]));
}

const isoDate = (date: number): string => new Date(date).toISOString().slice(0, 10);

/** The last `count` days in the zone, oldest first, the last of them the one `now` is in. */
export function localDays(now: number, count: number, zone: string): LocalDay[] {
	const clock = wall(now, zone);
	const today = Date.UTC(new Date(clock).getUTCFullYear(), new Date(clock).getUTCMonth(), new Date(clock).getUTCDate());
	const days: LocalDay[] = [];
	for (let back = count - 1; back >= 0; back--) {
		const date = today - back * 86_400_000;
		days.push({ day: isoDate(date), from: midnight(date, zone), to: midnight(date + 86_400_000, zone) });
	}
	return days;
}
