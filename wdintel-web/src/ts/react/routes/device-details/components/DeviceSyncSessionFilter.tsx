import { Chip } from '@mui/material';
import type { SyncSummary } from '../../../../../Bindings';
import { formatDeviceDateTime } from '../../devices/helpers';

export function DeviceSyncSessionFilter({
  session,
  onReset,
}: {
  session: SyncSummary | null;
  onReset: () => void;
}) {
  return (
    <Chip
      size="small"
      variant="outlined"
      label={session ? `Сесія: ${formatDeviceDateTime(session.createdAt)}` : 'Вибрана сесія'}
      onDelete={onReset}
    />
  );
}
