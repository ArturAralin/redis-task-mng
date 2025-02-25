import { formatDate } from 'date-fns';

export function prettifyUnixTs(d: number | Date): string {
  const date = formatDate(d, 'dd/MM/yyyy HH:mm:ss')


  return `${date} UTC`;
}
