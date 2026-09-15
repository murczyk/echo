import FolderZipOutlinedIcon from '@mui/icons-material/FolderZipOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import PendingActionsOutlinedIcon from '@mui/icons-material/PendingActionsOutlined';
import { CircularProgress } from '@mui/material';
import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';

import type { DeviceFileTreeEntry } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { PowerSnackbarProvider, usePowerSnackbar } from '../../../components/PowerSnackbar';
import { isAbortError } from '../../../services/api/client';
import { deviceFileContentUrl, getDeviceFileContentSize } from '../../../services/api/devices';
import { toDeviceFileLoadError } from '../helpers';
import { DeviceFileContentHeader } from './DeviceFileContentHeader';

type PreviewFormat = 'txt' | 'pdf' | 'docx';

const TxtDocumentPreview = lazy(() =>
  import('../../shared/message-card/text-document-preview').then((module) => ({
    default: module.TxtDocumentPreview,
  })),
);
const PdfDocumentPreview = lazy(() =>
  import('../../shared/message-card/renderers/PdfDocumentPreview').then((module) => ({
    default: module.PdfDocumentPreview,
  })),
);
const DocxDocumentPreview = lazy(() =>
  import('../../shared/message-card/renderers/DocxDocumentPreview').then((module) => ({
    default: module.DocxDocumentPreview,
  })),
);

function ContentLoading() {
  return (
    <div className="grid h-full place-items-center">
      <CircularProgress aria-label="Завантаження вмісту файлу" />
    </div>
  );
}

function useContentSize(href: string) {
  const { notify } = usePowerSnackbar();
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void getDeviceFileContentSize(href, { signal: controller.signal })
      .then((size) => {
        if (!controller.signal.aborted) setSizeBytes(size);
      })
      .catch((error) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        const message = toDeviceFileLoadError(error, 'Помилка завантаження вмісту файлу').message;
        setError(message);
        notify({ severity: 'error', message });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [href, attempt, notify]);
  return { sizeBytes, loading, error, retry: () => setAttempt((value) => value + 1) };
}

function FilePreview({
  format,
  href,
  sizeBytes,
}: {
  format: PreviewFormat;
  href: string;
  sizeBytes: number | null;
}) {
  const { notify } = usePowerSnackbar();
  const onError = useCallback(
    (error: unknown) => {
      if (isAbortError(error)) return;
      notify({
        severity: 'error',
        message: toDeviceFileLoadError(error, 'Помилка перегляду файлу').message,
      });
    },
    [notify],
  );
  const props = { href, sizeBytes, onError };
  if (format === 'txt') return <TxtDocumentPreview {...props} />;
  if (format === 'pdf') return <PdfDocumentPreview {...props} zoom={100} />;
  return <DocxDocumentPreview {...props} zoom={100} />;
}

function FileContent({ format, href }: { format: PreviewFormat; href: string }) {
  const { sizeBytes, loading, error, retry } = useContentSize(href);
  return (
    <div className="relative h-full min-h-0 min-w-0 overflow-auto">
      {loading ? (
        <ContentLoading />
      ) : error !== null ? (
        <div className="p-echo-md">
          <PowerAlert
            severity="error"
            autoHideDuration={null}
            action={<PowerButton onClick={retry}>Повторити</PowerButton>}
          >
            {error}
          </PowerAlert>
        </div>
      ) : (
        <Suspense fallback={<ContentLoading />}>
          <FilePreview format={format} href={href} sizeBytes={sizeBytes} />
        </Suspense>
      )}
    </div>
  );
}

function FilePreviewState({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-echo-lg p-echo-2xl text-center">
      <div className="flex size-16 shrink-0 items-center justify-center rounded-echo-xl bg-echo-surface text-echo-text/60">
        {icon}
      </div>
      <h3 className="m-0 text-[22px]! font-medium! text-echo-text">{title}</h3>
      <p className="m-0 text-echo-base leading-relaxed text-echo-text/60">{children}</p>
    </div>
  );
}

function SelectedFileContent({ file, href }: { file: DeviceFileTreeEntry; href: string | null }) {
  if (href === null) {
    return (
      <FilePreviewState icon={<PendingActionsOutlinedIcon />} title="Контент файлу відсутній">
        Вміст цього файлу ще не завантажено в Echo.
        <br />
        Перегляд і скачування поки недоступні.
      </FilePreviewState>
    );
  }
  const extension = (
    file.extension?.trim().replace(/^\./, '') ||
    (file.name.includes('.') ? file.name.split('.').pop() : '') ||
    ''
  ).toLowerCase();
  if (extension === 'txt' || extension === 'pdf' || extension === 'docx') {
    return <FileContent format={extension} href={href} />;
  }
  return (
    <FilePreviewState
      icon={extension === 'zip' ? <FolderZipOutlinedIcon /> : <InsertDriveFileOutlinedIcon />}
      title={
        extension
          ? `Перегляд формату ${extension.toUpperCase()} не підтримується`
          : 'Перегляд цього формату не підтримується'
      }
    >
      Ви можете скачати файл і відкрити його
      <br />
      на комп’ютері у відповідній програмі.
    </FilePreviewState>
  );
}

export function DeviceFileContentPane({
  deviceId,
  file,
}: {
  deviceId: string;
  file: DeviceFileTreeEntry | null;
}) {
  const href =
    file?.hasContent && file.fileId != null && file.revision != null
      ? deviceFileContentUrl(deviceId, file.fileId, file.revision)
      : null;
  return (
    <section
      aria-labelledby="device-file-content-title"
      data-testid="device-file-content-pane"
      className="flex h-full min-h-0 min-w-0 flex-col"
    >
      {file !== null ? (
        <PowerSnackbarProvider key={`${deviceId}/${file.entryId}/${file.revision}/${href}`}>
          <DeviceFileContentHeader file={file} href={href} />
          <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-echo-background/50">
            <SelectedFileContent file={file} href={href} />
          </div>
        </PowerSnackbarProvider>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-echo-sm p-echo-xl text-center">
          <h2
            id="device-file-content-title"
            className="m-0 break-all text-echo-lg font-semibold text-echo-text"
          >
            Вміст файлу
          </h2>
          <p className="m-0 text-echo-sm text-echo-text-muted">
            Виберіть файл у дереві або результатах пошуку.
          </p>
        </div>
      )}
    </section>
  );
}
