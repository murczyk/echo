export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Невідома помилка';
}

export function formatDateTime(timestamp: number | null): string {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('uk-UA', { dateStyle: 'short', timeStyle: 'medium' }).format(date);
}

export function statusColor(status: string): 'default' | 'success' | 'warning' | 'error' | 'info' {
  if (['running', 'completed', 'safe', 'sent'].includes(status)) return 'success';
  if (['queued', 'pending', 'starting'].includes(status)) return 'info';
  if (['suspicious', 'stopping'].includes(status)) return 'warning';
  if (['failed', 'critical'].includes(status)) return 'error';
  return 'default';
}
