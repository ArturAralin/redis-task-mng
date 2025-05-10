export const FAIL_COLOR = 'rgb(217, 53, 38)';
export const IN_PROGRESS_COLOR = 'rgb(60, 113, 247)';
export const NEW_COLOR = 'rgb(82, 95, 122)';
export const COMPLETE_COLOR = 'rgb(0, 137, 90)';

export const TIMEZONES = Array.from({ length: 25 }, (_, i) => ({
  name: `UTC${i - 12 >= 0 ? '+' : '-'}${Math.abs(i - 12)
    .toString()
    .padStart(2, '0')}:00`,
  offset: (i - 12) * 60,
})).sort((a, b) => a.offset - b.offset);

export const OFFSET_TO_TZ_NAME = new Map(
  TIMEZONES.map((tz) => [tz.offset, tz.name]),
);
