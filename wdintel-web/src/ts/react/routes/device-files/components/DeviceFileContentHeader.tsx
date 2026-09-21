import DownloadIcon from '@mui/icons-material/Download';
import { Typography } from '@mui/material';
import { useState } from 'react';

import type { DeviceFileTreeEntry } from '../../../../../Bindings';
import { PowerButton } from '../../../components/PowerButton';
import { usePowerSnackbar } from '../../../components/PowerSnackbar';
import { getDeviceFileContent } from '../../../services/api/devices';
import { downloadBlob } from '../../../utils/download-blob';
import { toDeviceFileLoadError } from '../helpers';

function DownloadButton({ href, fileName }: { href: string | null; fileName: string }) {
  const { notify } = usePowerSnackbar();
  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    if (href === null) return;
    setDownloading(true);
    try {
      const blob = await getDeviceFileContent(href);
      downloadBlob(blob, fileName);
    } catch (error) {
      notify({
        severity: 'error',
        message: toDeviceFileLoadError(error, 'Помилка скачування файлу').message,
      });
    } finally {
      setDownloading(false);
    }
  };
  return (
    <PowerButton
      size="small"
      variant="contained"
      disableElevation
      sx={{ textTransform: 'none' }}
      className="h-echo-control-sm shrink-0"
      startIcon={<DownloadIcon fontSize="small" />}
      onClick={() => void download()}
      disabled={href === null || downloading}
      aria-busy={downloading}
    >
      Скачати файл
    </PowerButton>
  );
}

export function DeviceFileContentHeader({
  file,
  href,
  sessionScoped = false,
}: {
  file: DeviceFileTreeEntry;
  href: string | null;
  sessionScoped?: boolean;
}) {
  const path = file.absolutePath ?? (file.pathComponents.join(' / ') || file.name);
  return (
    <header className="flex min-h-echo-control-lg shrink-0 flex-wrap items-center gap-echo-md border-b border-echo-divider-subtle px-echo-lg py-echo-sm echo-sm:h-echo-control-lg echo-sm:flex-nowrap">
      <Typography
        component="h2"
        variant="body2"
        id="device-file-content-title"
        title={path}
        tabIndex={0}
        className="m-0 min-w-0 flex-1 basis-full overflow-x-auto whitespace-nowrap font-normal! text-echo-text echo-sm:basis-auto"
      >
        {path}
      </Typography>
      {file.revision != null ? (
        <span className="inline-flex shrink-0 items-center gap-echo-xs whitespace-nowrap rounded-echo-sm bg-echo-success/20 px-echo-sm py-echo-xs text-echo-xs text-[color:color-mix(in_srgb,var(--echo-color-success)_60%,var(--echo-color-text))]">
          <span aria-hidden="true" className="size-echo-xs rounded-full bg-current" />
          Ревізія {file.revision} · {sessionScoped ? 'Із вибраної сесії' : 'Поточна'}
        </span>
      ) : null}
      <DownloadButton href={href} fileName={file.name} />
    </header>
  );
}
