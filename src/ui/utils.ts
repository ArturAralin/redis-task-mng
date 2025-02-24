import { formatDate } from 'date-fns';

export function prettifyUnixTs(d: number | Date): string {
  const date = new Date(d);

  return formatDate(date, 'MM/dd/yyyy HH:mm:ss');
}
