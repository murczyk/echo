import { useState } from 'react';
import type { AiAgentFileCitation } from '../../../../Bindings';
import { CircularProgress } from '@mui/material';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { fileCitationHref } from '../../services/api/device-documents';
import { DeviceFileContentPane } from '../device-files/components/DeviceFileContentPane';
import { useLocatedDeviceFile } from '../device-files/use-located-device-file';
import { FilePreviewDialog } from '../shared/message-card/attachment-preview/FilePreviewDialog';

export function FileCitationChip({ source }: { source: AiAgentFileCitation }) {
  const [open, setOpen] = useState(false);
  const { result, error, retry } = useLocatedDeviceFile({
    deviceId: source.deviceId,
    fileId: source.fileId,
    revision: source.revision,
  });
  const href = fileCitationHref(source);
  const name = result?.file.name ?? 'Файл';
  return (
    <>
      <a
        className="echo-chip echo-chip--neutral"
        data-interactive="true"
        href={href}
        onClick={(event) => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          retry();
          setOpen(true);
        }}
      >
        <span className="echo-chip__label">
          {name} · рев. {source.revision}
        </span>
      </a>
      <FilePreviewDialog
        open={open}
        title={name}
        onClose={() => setOpen(false)}
        actions={
          <a href={href} target="_blank" rel="noopener noreferrer">
            Відкрити у дереві файлів
          </a>
        }
      >
        {result ? (
          <DeviceFileContentPane
            deviceId={source.deviceId}
            file={result.file}
            revisionPinned
            citation={source}
          />
        ) : error ? (
          <PowerAlert
            severity="error"
            action={<PowerButton onClick={retry}>Повторити</PowerButton>}
          >
            {error}
          </PowerAlert>
        ) : (
          <CircularProgress aria-label="Завантаження файлу" />
        )}
      </FilePreviewDialog>
    </>
  );
}
