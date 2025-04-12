import { formatDate } from 'date-fns';

export function prettifyUnixTs(d: number | Date): string {
  const date = formatDate(d, 'dd/MM/yyyy HH:mm:ss');

  return `${date} UTC`;
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
