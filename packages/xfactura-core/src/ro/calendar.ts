import { addDays, type LocalDate, type Month } from '../time';

/** Orthodox Easter Sunday (the Julian computus, moved to the Gregorian calendar, 1900–2099). */
export function orthodoxEaster(year: number): LocalDate {
  const d = (19 * (year % 19) + 15) % 30;
  const e = (2 * (year % 4) + 4 * (year % 7) - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  const julian =
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` as LocalDate;
  return addDays(julian, 13);
}

/**
 * The public holidays on which no work is done (Codul muncii art. 139 alin. (1)), Good Friday,
 * Easter and Pentecost by the Orthodox calendar; the holidays of other religious denominations
 * are granted to their members and are not in this list.
 */
export function legalHolidays(year: number): LocalDate[] {
  const easter = orthodoxEaster(year);
  const fixed = [
    '01-01',
    '01-02',
    '01-06',
    '01-07',
    '01-24',
    '05-01',
    '06-01',
    '08-15',
    '11-30',
    '12-01',
    '12-25',
    '12-26',
  ];
  // Whit Monday can fall on 1 June (as in 2026): one day off, listed once.
  return [
    ...new Set([
      ...fixed.map((day) => `${year}-${day}` as LocalDate),
      addDays(easter, -2),
      easter,
      addDays(easter, 1),
      addDays(easter, 49),
      addDays(easter, 50),
    ]),
  ].sort();
}

/** The working days from one day to another, both included: Monday to Friday, less the public
 * holidays that fall on them. */
export function workingDaysBetween(from: LocalDate, to: LocalDate): LocalDate[] {
  const holidays = new Map<number, Set<string>>();
  const days: LocalDate[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const year = Number(day.slice(0, 4));
    if (!holidays.has(year)) holidays.set(year, new Set(legalHolidays(year)));
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !holidays.get(year)!.has(day)) days.push(day);
  }
  return days;
}

/** A month's working days: Monday to Friday, less the public holidays that fall on them. */
export function workingDays(month: Month): number {
  return workingDaysBetween(
    `${month}-01` as LocalDate,
    addDays(`${month}-28` as LocalDate, 3),
  ).filter((day) => day.startsWith(month)).length;
}

/** The `count`-th working day after `from` (a term "în termen de n zile lucrătoare de la" a date:
 * the date itself is not counted). */
export function addWorkingDays(from: LocalDate, count: number): LocalDate {
  let day = from;
  for (let left = count; left > 0;) {
    day = addDays(day, 1);
    if (workingDaysBetween(day, day).length) left -= 1;
  }
  return day;
}
