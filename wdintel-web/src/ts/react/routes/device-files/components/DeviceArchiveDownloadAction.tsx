import DownloadIcon from '@mui/icons-material/Download';
import { Tooltip } from '@mui/material';

import type { DeviceFileContentRef } from '../../../../../Bindings';
import { PowerIconButton } from '../../../components/PowerIconButton';
import { useDeviceFileDownload } from '../use-device-file-download';

export function DeviceArchiveDownloadAction({
  source,
  name,
}: {
  source: DeviceFileContentRef | null;
  name?: string;
}) {
  const { downloading, download } = useDeviceFileDownload(source);
  if (!source) return null;
  return (
    <Tooltip
      title={
        downloading
          ? 'Завантаження…'
          : name
            ? `Скачати початковий архів «${name}»`
            : 'Скачати початковий архів'
      }
    >
      <span className="inline-flex shrink-0">
        <PowerIconButton
          size="small"
          aria-label="Скачати початковий архів"
          aria-busy={downloading}
          disabled={downloading}
          onClick={() => void download()}
        >
          <DownloadIcon fontSize="small" />
        </PowerIconButton>
      </span>
    </Tooltip>
  );
}
