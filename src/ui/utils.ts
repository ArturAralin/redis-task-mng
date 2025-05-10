import { formatDate, addMinutes } from 'date-fns';
import { OFFSET_TO_TZ_NAME, TIMEZONES } from './constants';

export function prettifyUnixTs(tzOffset: number, d: number | Date): string {
  const date = formatDate(addMinutes(d, tzOffset), 'dd/MM/yyyy HH:mm:ss');
  const offsetName = OFFSET_TO_TZ_NAME.get(tzOffset) || 'UTC+00:00';

  return `${date} ${offsetName}`;
}

export function getTimezones(tzOffset: number) {
  return TIMEZONES.map((tz) => ({
    name: tz.name,
    offset: tz.offset,
    current: tz.offset === tzOffset,
  }));
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
