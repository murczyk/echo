import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import { Box, Button, Tooltip } from '@mui/material';
import { useState } from 'react';

import { kmzAttachmentConversionArchiveUrl } from '../../../services/api/kmz-attachment-conversion';
import {
  mediaDownloadAttr,
  MessageMediaThumbnailDownloadLink,
  type MessageCardDownloadGuardProps,
} from './MessageCardMedia';
import { MessageCardAttachmentPreviewProvider } from './attachment-preview/MessageCardAttachmentPreviewProvider';
import type { KmzAttachmentPreviewSource } from './attachment-preview/message-card-preview.types';

type Props = KmzAttachmentPreviewSource & {
  selected?: boolean;
  onPreview?: () => void;
} & Partial<MessageCardDownloadGuardProps>;

const NO_DOWNLOAD_IN_PROGRESS = () => false;
const ALLOW_DOWNLOAD = () => true;

function archiveDownloadName(fileName: string): string {
  const safeFileName = mediaDownloadAttr(fileName, 'geodata');
  const extensionIndex = safeFileName.lastIndexOf('.');
  const stem = extensionIndex > 0 ? safeFileName.slice(0, extensionIndex) : safeFileName;
  return `${stem || 'geodata'}_files.zip`;
}

export function KmzAttachmentPreviewLink({
  mediaId,
  originalHref,
  fileName,
  initialStatus,
  selected = false,
  onPreview,
  isDownloadStarting,
  onDownloadStart,
}: Props) {
  const [open, setOpen] = useState(false);
  const source = { mediaId, originalHref, fileName, initialStatus };

  return (
    <>
      <Box component="span" className="relative inline-flex max-w-full self-start">
        <Tooltip title={fileName} enterDelay={400}>
          <Button
            size="small"
            variant="outlined"
            onClick={() => {
              if (onPreview) {
                onPreview();
              } else {
                setOpen(true);
              }
            }}
            aria-current={selected ? 'true' : undefined}
            data-summary-selected={selected ? 'true' : undefined}
            sx={{
              mb: 0.5,
              width: 'fit-content',
              minWidth: 0,
              maxWidth: '100%',
              minHeight: 32,
              py: 0.25,
              pl: 0.75,
              pr: initialStatus === 'done' ? 4 : 0.75,
              fontSize: 11,
              lineHeight: 1.25,
              textTransform: 'none',
              fontWeight: 500,
              color: 'text.primary',
              borderColor: selected ? 'primary.main' : 'divider',
              boxShadow: selected ? 1 : undefined,
              backgroundColor: selected ? 'action.selected' : undefined,
              overflow: 'hidden',
              justifyContent: 'flex-start',
              '& .MuiButton-startIcon': { mr: 0.35, ml: -0.25, '& svg': { fontSize: 14 } },
            }}
            startIcon={<MapOutlinedIcon aria-hidden />}
          >
            <Box
              component="span"
              sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {fileName}
            </Box>
          </Button>
        </Tooltip>
        {initialStatus === 'done' ? (
          <MessageMediaThumbnailDownloadLink
            href={kmzAttachmentConversionArchiveUrl(mediaId)}
            displayName={fileName}
            downloadName={archiveDownloadName(fileName)}
            downloadKey={`media-conversion-archive:${mediaId}`}
            downloadLabel={`Завантажити оригінал і конвертований KMZ: ${fileName}`}
            isDownloadStarting={isDownloadStarting ?? NO_DOWNLOAD_IN_PROGRESS}
            onDownloadStart={onDownloadStart ?? ALLOW_DOWNLOAD}
          />
        ) : null}
      </Box>
      {onPreview == null && open ? (
        <MessageCardAttachmentPreviewProvider
          attachments={[{ type: 'kmz', value: source }]}
          initialIndex={0}
          onClose={() => setOpen(false)}
          isDownloadStarting={isDownloadStarting}
          onDownloadStart={onDownloadStart}
        />
      ) : null}
    </>
  );
}
