import FullscreenIcon from '@mui/icons-material/Fullscreen';
import DownloadIcon from '@mui/icons-material/Download';
import { IconButton } from '@mui/material';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FileBreadcrumb } from '../../../../../Bindings';
import type { DeviceFileSelection } from '../device-file-archive';
import { DeviceFileBreadcrumbs } from './DeviceFileBreadcrumbs';
import { PowerIconButton } from '../../../components/PowerIconButton';
import type { useDeviceFilePreview } from '../use-device-file-preview';
import {
  MessageCardAttachmentPreviewHeader,
  attachmentPreviewHeaderIconButtonSx,
} from '../../shared/message-card/attachment-preview/MessageCardAttachmentPreviewHeader';
import { MessageCardAttachmentPreviewInfoPopover } from '../../shared/message-card/attachment-preview/MessageCardAttachmentPreviewInfoPopover';
import { AttachmentPreviewMobileCarouselNav } from '../../shared/message-card/attachment-preview/MessageCardAttachmentPreviewControls';
import type { MessageCardPreviewNavigation } from '../../shared/message-card/attachment-preview/message-card-preview.types';
import { formatSizeBytes } from '../../shared/message-card/message-card-image-utils';
import { formatVideoTime } from '../../shared/message-card/message-card-video-utils';
import { getFilePreviewKind } from '../../shared/message-card/file-preview-kind';
import { formatDeviceDateTime } from '../../devices/helpers';

export function DeviceFileContentHeader({
  file,
  breadcrumbs,
  preview,
  sessionScoped = false,
  revisionPinned = false,
  titleId = 'device-file-content-title',
  navigation,
  additionalActions,
  onClose,
  closeLabel,
  onFullscreen,
}: {
  file: DeviceFileSelection;
  breadcrumbs?: FileBreadcrumb[];
  preview: ReturnType<typeof useDeviceFilePreview>;
  sessionScoped?: boolean;
  revisionPinned?: boolean;
  titleId?: string;
  navigation?: MessageCardPreviewNavigation;
  additionalActions?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  onFullscreen?: () => void;
}) {
  const [infoAnchor, setInfoAnchor] = useState<HTMLButtonElement | null>(null);
  useEffect(() => setInfoAnchor(null), [file.entryId, file.revision]);
  useEffect(() => {
    if (preview.state === 'denied') setInfoAnchor(null);
  }, [preview.state]);
  const sizeBytes = preview.source?.sizeBytes ?? file.sizeBytes;
  const kind = preview.source && getFilePreviewKind(preview.source);
  return (
    <div className="@container/device-preview shrink-0">
      <MessageCardAttachmentPreviewHeader
        embedded
        titleId={titleId}
        fileName={file.name}
        titleContent={
          breadcrumbs ? (
            <DeviceFileBreadcrumbs breadcrumbs={breadcrumbs} fileName={file.name} />
          ) : undefined
        }
        navigation={navigation}
        onInfoClick={
          preview.state !== 'denied' ? (event) => setInfoAnchor(event.currentTarget) : undefined
        }
        onClose={onClose}
        closeLabel={closeLabel}
        additionalActions={
          <>
            {additionalActions}
            <DeviceFileContentActions preview={preview} onFullscreen={onFullscreen} />
          </>
        }
      />
      {navigation && (
        <div className="hidden justify-center bg-[#121212] text-white @max-[640px]/device-preview:flex">
          <AttachmentPreviewMobileCarouselNav navigation={navigation} />
        </div>
      )}
      <MessageCardAttachmentPreviewInfoPopover
        open={infoAnchor != null && preview.state !== 'denied'}
        anchorEl={infoAnchor}
        onClose={() => setInfoAnchor(null)}
        fields={[
          { label: 'URL', value: preview.source?.originalHref || '—' },
          { label: 'Файл', value: file.name },
          { label: 'Тип', value: preview.source?.contentType || file.mimeType || '—' },
          { label: 'Розмір файлу', value: sizeBytes === 0 ? '0 B' : formatSizeBytes(sizeBytes) },
          ...(kind === 'image'
            ? [
                {
                  label: 'Розмір зображення',
                  value: preview.imageSize
                    ? `${preview.imageSize.width} × ${preview.imageSize.height}`
                    : '—',
                },
              ]
            : []),
          ...(kind === 'audio' || kind === 'video'
            ? [
                {
                  label: 'Тривалість',
                  value:
                    preview.durationSeconds == null
                      ? '—'
                      : formatVideoTime(preview.durationSeconds),
                },
              ]
            : []),
          { label: 'ID', value: file.fileId || '—' },
          {
            label: 'Шлях',
            value: file.absolutePath || file.virtualPath || file.pathComponents.join('/'),
          },
          ...(file.revision == null
            ? []
            : [
                {
                  label: 'Ревізія',
                  value: `${file.revision} · ${revisionPinned ? 'За посиланням' : sessionScoped ? 'Із вибраної сесії' : 'Поточна'}`,
                },
              ]),
          { label: 'Дата завантаження', value: formatDeviceDateTime(file.contentUploadedAt) },
          {
            label: 'Дата створення',
            value: formatDeviceDateTime(file.fileMetadataCreatedAt),
          },
          { label: 'Дата зміни', value: formatDeviceDateTime(file.fileMetadataModifiedAt) },
        ]}
      />
    </div>
  );
}

export function DeviceFileContentActions({
  preview,
  onFullscreen,
}: {
  preview: ReturnType<typeof useDeviceFilePreview>;
  onFullscreen?: () => void;
}) {
  const downloadFocus = useRef<{ button: HTMLButtonElement; epoch: number | null } | null>(null);
  useEffect(() => {
    if (preview.downloading) return;
    const target = downloadFocus.current;
    downloadFocus.current = null;
    if (
      target &&
      target.epoch === preview.epoch &&
      target.button.isConnected &&
      !target.button.disabled &&
      document.activeElement === document.body
    ) {
      target.button.focus();
    }
  }, [preview.downloading, preview.epoch]);
  return (
    <>
      {onFullscreen && (
        <IconButton
          size="small"
          sx={attachmentPreviewHeaderIconButtonSx}
          aria-label="На весь екран"
          disabled={preview.state !== 'ready'}
          onClick={onFullscreen}
        >
          <FullscreenIcon />
        </IconButton>
      )}
      <PowerIconButton
        key={preview.epoch}
        size="small"
        sx={attachmentPreviewHeaderIconButtonSx}
        title={preview.downloading ? 'Завантаження…' : 'Скачати файл'}
        onClick={(event) => {
          downloadFocus.current = { button: event.currentTarget, epoch: preview.epoch };
          void preview.download();
        }}
        disabled={!preview.canDownload || preview.downloading}
        aria-busy={preview.downloading}
        aria-label="Скачати файл"
      >
        <DownloadIcon fontSize="small" />
        <span className="sr-only">Скачати файл</span>
      </PowerIconButton>
    </>
  );
}
