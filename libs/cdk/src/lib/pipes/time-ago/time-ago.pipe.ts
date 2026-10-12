import { Pipe, PipeTransform } from '@angular/core';

const MS_IN_MINUTE = 60_000;
const MINUTES_IN_HOUR = 60;
const MINUTES_IN_DAY = 1_440;

const shortDateFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

const longDateFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function localFields(date: Date) {
  return [
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  ];
}

function isBefore(left: number[], right: number[]) {
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) {
      return left[i] < right[i];
    }
  }

  return false;
}

// Full calendar years between two dates in local time.
function fullYearsBetween(earlier: Date, later: Date) {
  const years = later.getFullYear() - earlier.getFullYear();
  const notFull = isBefore(
    localFields(later).slice(1),
    localFields(earlier).slice(1),
  );

  return notFull ? years - 1 : years;
}

// Full calendar days from `date` to `base` in local time (DST aware).
function fullDaysBetween(date: Date, base: Date) {
  const calendarDays = Math.abs(
    Math.round(
      (Date.UTC(base.getFullYear(), base.getMonth(), base.getDate()) -
        Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) /
        (MINUTES_IN_DAY * MS_IN_MINUTE),
    ),
  );
  const isPast = isBefore(localFields(date), localFields(base));
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + (isPast ? calendarDays : -calendarDays));
  const overshoots = isPast
    ? isBefore(localFields(base), localFields(shifted))
    : isBefore(localFields(shifted), localFields(base));

  return overshoots ? calendarDays - 1 : calendarDays;
}

function pluralize(count: number, unit: string) {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

// Largest unit up to days, rounded; days use the wall-clock difference.
function formatDistance(earlier: Date, later: Date) {
  const minutes = (later.getTime() - earlier.getTime()) / MS_IN_MINUTE;

  if (minutes < MINUTES_IN_HOUR) {
    return pluralize(Math.round(minutes), 'minute');
  }

  if (minutes < MINUTES_IN_DAY) {
    return pluralize(Math.round(minutes / MINUTES_IN_HOUR), 'hour');
  }

  const dstNormalizedMinutes =
    minutes - later.getTimezoneOffset() + earlier.getTimezoneOffset();

  return pluralize(Math.round(dstNormalizedMinutes / MINUTES_IN_DAY), 'day');
}

@Pipe({ name: 'timeAgo', standalone: true })
export class TimeAgoPipe implements PipeTransform {
  transform(date: number) {
    const createdAt = new Date(date);
    const now = new Date();
    const [earlier, later] =
      createdAt.getTime() <= now.getTime()
        ? [createdAt, now]
        : [now, createdAt];

    if (fullYearsBetween(earlier, later) >= 1) {
      return longDateFormat.format(createdAt);
    }

    if (fullDaysBetween(createdAt, now) > 6) {
      return shortDateFormat.format(createdAt);
    }

    if (Math.trunc((later.getTime() - earlier.getTime()) / 1000) <= 60) {
      return 'Now';
    }

    return `${formatDistance(earlier, later)} ago`;
  }
}
