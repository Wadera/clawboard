export const EUROPEAN_DATE_LOCALE = 'en-GB';

export function formatDateTime(value: string | number | Date, fallback = ''): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString(EUROPEAN_DATE_LOCALE, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: undefined,
    hour12: false,
  });
}

export function formatDateTimeLong(value: string | number | Date, fallback = ''): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString(EUROPEAN_DATE_LOCALE, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
