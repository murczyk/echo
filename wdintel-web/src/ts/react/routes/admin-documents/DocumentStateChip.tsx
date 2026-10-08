import { Chip } from '@mui/material';

const STATE_LABELS: Record<string, string> = {
  pending: 'У черзі',
  queued: 'У черзі',
  running: 'Обробка',
  processing: 'Обробка',
  done: 'Готово',
  ready: 'Готово',
  complete: 'Готово',
  failed: 'Помилка',
  error: 'Помилка',
  skipped: 'Пропущено',
  disabled: 'Вимкнено',
};

function stateColor(state: string): 'success' | 'error' | 'warning' | 'default' {
  if (['done', 'ready', 'complete'].includes(state)) return 'success';
  if (['failed', 'error'].includes(state)) return 'error';
  if (['pending', 'queued', 'running', 'processing'].includes(state)) return 'warning';
  return 'default';
}

export function DocumentStateChip({ state }: { state: string }) {
  return (
    <Chip
      size="small"
      variant="outlined"
      color={stateColor(state)}
      label={STATE_LABELS[state] ?? state}
    />
  );
}
