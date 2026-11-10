import type { DeviceFilesState } from '../../device-files/use-device-files';
import { SidePanelToggleButton } from '../../../components/SidePanelToggleButton';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { Typography } from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import HistoryIcon from '@mui/icons-material/History';
import InfoIcon from '@mui/icons-material/Info';

import type { DeviceDetails, SyncSummary } from '../../../../../Bindings';
import { PowerButton } from '../../../components/PowerButton';
import { PowerIconButton } from '../../../components/PowerIconButton';
import { navigateWithinSpa } from '../../../utils/browser';
import { formatDeviceLifecycleLabel } from '../helpers';
import { DeviceSyncSessionFilter } from './DeviceSyncSessionFilter';
import { selectDeviceSyncSession } from '../url-state';
import { DeviceAudioForwardingWarning } from './DeviceAudioForwardingWarning';
import { DeviceDetailsSection } from '../page-route';
import { DeviceBreadcrumbs } from './DeviceBreadcrumbs';

export function DeviceMobileHeader({
  device,
  files,
  onToggleFiles,
  filesOpen,
  deviceId,
  section,
  backHref,
  backLabel,
  canEdit,
  editSubmitting,
  onEdit,
  onInfo,
  onSessions,
  syncId,
  session,
}: {
  device: DeviceDetails | null;
  files?: DeviceFilesState;
  onToggleFiles?: () => void;
  filesOpen?: boolean;
  deviceId: string;
  section: DeviceDetailsSection;
  backHref: string;
  backLabel: string;
  canEdit: boolean;
  editSubmitting: boolean;
  onEdit: () => void;
  onInfo: () => void;
  onSessions?: () => void;
  syncId: string | null;
  session: SyncSummary | null;
}) {
  return (
    <header className="device-page-header flex shrink-0 flex-col gap-echo-sm">
      <div className="flex min-w-0 items-center gap-echo-sm">
        {files && onToggleFiles ? (
          <SidePanelToggleButton
            side="left"
            active={filesOpen ?? false}
            label={filesOpen ? 'Згорнути ліву панель' : 'Розгорнути ліву панель'}
            onClick={onToggleFiles}
          />
        ) : null}
        <PowerIconButton
          className="!size-echo-control-lg shrink-0"
          aria-label={backLabel}
          onClick={() => navigateWithinSpa(backHref)}
        >
          <ArrowBackIcon />
        </PowerIconButton>
        <div className="min-w-0 flex-1">
          <Typography component="div" variant="h5" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
            <DeviceBreadcrumbs
              deviceId={deviceId}
              deviceName={device ? (device.name ?? 'Без назви') : null}
              section={section}
              files={files}
            />
          </Typography>
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
        {section !== DeviceDetailsSection.Files ? (
          <DeviceAudioForwardingWarning configured={device?.audioForwardingConfigured} />
        ) : null}
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
      <div className={onSessions ? 'grid grid-cols-2 gap-echo-sm' : 'grid gap-echo-sm'}>
        <PowerButton
          className="!min-h-echo-control-lg"
          variant="outlined"
          startIcon={<InfoIcon />}
          onClick={onInfo}
        >
          Про пристрій
        </PowerButton>
        {onSessions ? (
          <PowerButton
            className="!min-h-echo-control-lg"
            variant="outlined"
            startIcon={<HistoryIcon />}
            onClick={onSessions}
          >
            Сесії
          </PowerButton>
        ) : null}
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
