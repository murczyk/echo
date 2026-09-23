import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import EditIcon from '@mui/icons-material/Edit';
import HistoryIcon from '@mui/icons-material/History';
import InfoIcon from '@mui/icons-material/Info';
import { Skeleton } from '@mui/material';

import type { DeviceDetails, SyncSummary } from '../../../../../Bindings';
import { PowerButton } from '../../../components/PowerButton';
import { PowerIconButton } from '../../../components/PowerIconButton';
import { navigateWithinSpa } from '../../../utils/browser';
import { formatDeviceLifecycleLabel } from '../helpers';
import { DeviceSyncSessionFilter } from './DeviceSyncSessionFilter';
import { selectDeviceSyncSession } from '../url-state';

export function DeviceMobileHeader({
  device,
  canEdit,
  editSubmitting,
  onEdit,
  onInfo,
  onSessions,
  syncId,
  session,
}: {
  device: DeviceDetails | null;
  canEdit: boolean;
  editSubmitting: boolean;
  onEdit: () => void;
  onInfo: () => void;
  onSessions: () => void;
  syncId: string | null;
  session: SyncSummary | null;
}) {
  return (
    <header className="flex shrink-0 flex-col gap-echo-sm">
      <div className="flex min-w-0 items-center gap-echo-sm">
        <PowerIconButton
          className="!size-echo-control-lg shrink-0"
          aria-label="До списку пристроїв"
          onClick={() => navigateWithinSpa('/devices')}
        >
          <ArrowBackIcon />
        </PowerIconButton>
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-[17px]! font-semibold! [overflow-wrap:anywhere]">
            {device ? (device.name ?? 'Без назви') : <Skeleton />}
          </h1>
          {device ? (
            <span
              className={
                device.archived
                  ? 'text-[length:var(--echo-typography-font-size-xs)] text-echo-warning'
                  : 'text-[length:var(--echo-typography-font-size-xs)] text-echo-success'
              }
            >
              {formatDeviceLifecycleLabel(device.archived)}
            </span>
          ) : null}
        </div>
        {canEdit ? (
          <PowerIconButton
            className="!size-echo-control-lg shrink-0"
            aria-label="Редагувати пристрій"
            disabled={editSubmitting}
            onClick={onEdit}
          >
            <EditIcon />
          </PowerIconButton>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-echo-sm">
        <PowerButton
          className="!min-h-echo-control-lg"
          variant="outlined"
          startIcon={<InfoIcon />}
          onClick={onInfo}
        >
          Про пристрій
        </PowerButton>
        <PowerButton
          className="!min-h-echo-control-lg"
          variant="outlined"
          startIcon={<HistoryIcon />}
          onClick={onSessions}
        >
          Сесії
        </PowerButton>
      </div>
      {syncId !== null ? (
        <div className="min-w-0">
          <DeviceSyncSessionFilter
            session={session}
            onReset={() => selectDeviceSyncSession(null)}
          />
        </div>
      ) : null}
    </header>
  );
}
