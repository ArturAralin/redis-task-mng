import { formatDate, addMinutes } from 'date-fns';
import { TZDate } from '@date-fns/tz';
import { DEFAULT_TIMEZONE } from './constants';

export function unixTzPrettify(
  d: number | Date,
  timezone?: string | null
): string {
  let date: TZDate;
  const tz = timezone || DEFAULT_TIMEZONE;

  if (d instanceof Date) {
    date = TZDate.tz(tz, d);
  } else {
    date = TZDate.tz(tz, d);
  }

  const dateStr = formatDate(date, 'dd/MM/yyyy HH:mm:ss');

  return `${dateStr} ${tz}`;
}

export function durationPretty(durationInMs: number): string {
  const s = Math.floor((durationInMs / 1000) % 60);
  const m = Math.floor((durationInMs / 1000 / 60) % 60);
  const h = Math.floor(durationInMs / 1000 / 60 / 60);
  const ms = durationInMs % 1000;
  const parts = [];

  if (h > 0) {
    parts.push(`${h}h`);
  }

  if (m > 0) {
    parts.push(`${m}m`);
  }

  if (s > 0) {
    parts.push(`${s}s`);
  }

  if (ms > 0) {
    parts.push(`${ms}ms`);
  }

  return parts.join(' ');
}
