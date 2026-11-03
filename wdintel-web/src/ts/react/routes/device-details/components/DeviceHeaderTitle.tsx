import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { Box, Tooltip } from '@mui/material';

import { PowerIconButton } from '../../../components/PowerIconButton';
import { navigateWithinSpa } from '../../../utils/browser';
import { formatDeviceLifecycleLabel } from '../helpers';
import type { DeviceDetailsSection } from '../page-route';
import { DeviceBreadcrumbs } from './DeviceBreadcrumbs';

export function DeviceHeaderTitle({
  backHref = '/devices',
  backLabel = 'До списку пристроїв',
  deviceId,
  deviceName,
  archived,
  section,
}: {
  backHref?: string;
  backLabel?: string;
  deviceId: string;
  deviceName: string | null;
  archived: boolean;
  section: DeviceDetailsSection;
}) {
  const lifecycleLabel = formatDeviceLifecycleLabel(archived);

  return (
    <div className="flex min-w-0 items-center gap-echo-sm [line-height:inherit]">
      <Tooltip title={backLabel} arrow placement="bottom-start">
        <PowerIconButton
          aria-label={backLabel}
          onClick={() => navigateWithinSpa(backHref)}
          size="small"
          sx={{ flexShrink: 0 }}
        >
          <ArrowBackIcon fontSize="small" />
        </PowerIconButton>
      </Tooltip>
      {deviceName !== null ? (
        <Tooltip title={lifecycleLabel} arrow placement="bottom-start">
          <Box
            component="span"
            aria-label={lifecycleLabel}
            sx={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              bgcolor: archived ? 'warning.main' : 'success.main',
              flexShrink: 0,
              cursor: 'default',
            }}
          />
        </Tooltip>
      ) : null}
      <DeviceBreadcrumbs deviceId={deviceId} deviceName={deviceName} section={section} />
    </div>
  );
}
