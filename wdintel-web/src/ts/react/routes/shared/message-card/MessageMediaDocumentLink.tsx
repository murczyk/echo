import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import DownloadIcon from '@mui/icons-material/Download';
import { Box, Button, CircularProgress, IconButton, Tooltip } from '@mui/material';
import type { MouseEvent } from 'react';

import type { MessageCardDocument } from './document-preview.types';
import { deriveDocumentDownloadName, deriveDocumentFileName } from './message-card-document-utils';
import { blurActiveElement } from '../../../utils/focus';
import { MessageCardDisabledControlCursorWrapper } from './MessageCardDisabledControlCursorWrapper';

export function MessageMediaDocumentLink({
  document,
  index,
  onPreview,
  isDownloadStarting,
  onDownloadStart,
}: {
  document: MessageCardDocument;
  index: number;
  onPreview?: () => void;
  isDownloadStarting: (downloadKey: string) => boolean;
  onDownloadStart: (downloadKey: string) => boolean;
}) {
  const displayName = deriveDocumentFileName(document, index);
  const downloadName = deriveDocumentDownloadName(document, index);
  const canPreview = document.kind !== 'unsupported' && onPreview != null;
  const downloadKey = `media:${String(document.id ?? '')}`;
  const downloading = isDownloadStarting(downloadKey);
  const handlePreviewClick = (_event: MouseEvent<HTMLButtonElement>) => {
    blurActiveElement();
    onPreview?.();
  };

  return (
    <Box
      sx={{
        width: 'fit-content',
        maxWidth: '100%',
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
      }}
    >
      <Tooltip title={displayName} enterDelay={400}>
        <Button
          size="small"
          variant="outlined"
          onClick={canPreview ? handlePreviewClick : undefined}
          disabled={!canPreview}
          type="button"
          sx={{
            minWidth: 0,
            maxWidth: '100%',
            minHeight: 26,
            py: 0.25,
            px: 0.75,
            fontSize: 11,
            lineHeight: 1.25,
            textTransform: 'none',
            fontWeight: 500,
            color: 'text.primary',
            borderColor: 'divider',
            '&:hover': {
              backgroundColor: 'action.hover',
              borderColor: 'text.primary',
            },
            alignSelf: 'flex-start',
            overflow: 'hidden',
            justifyContent: 'flex-start',
            '& .MuiButton-startIcon': { mr: 0.35, ml: -0.25, '& svg': { fontSize: 14 } },
          }}
          startIcon={<DescriptionOutlinedIcon aria-hidden />}
        >
          <Box
            component="span"
            sx={{
              display: 'block',
              minWidth: 0,
              width: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              verticalAlign: 'bottom',
            }}
          >
            {displayName}
          </Box>
        </Button>
      </Tooltip>
      <MessageCardDisabledControlCursorWrapper disabled={downloading}>
        <Tooltip title={downloading ? 'Завантаження…' : 'Завантажити'} enterDelay={400}>
          <IconButton
            component="a"
            href={document.href}
            download={downloadName}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={downloading ? 'Завантаження…' : 'Завантажити'}
            aria-busy={downloading}
            disabled={downloading}
            onClick={(event) => {
              if (isDownloadStarting(downloadKey) || !onDownloadStart(downloadKey)) {
                event.preventDefault();
              }
            }}
            size="small"
            sx={{ color: 'text.secondary' }}
          >
            {downloading ? (
              <CircularProgress size={14} aria-label="Завантаження…" />
            ) : (
              <DownloadIcon fontSize="inherit" />
            )}
          </IconButton>
        </Tooltip>
      </MessageCardDisabledControlCursorWrapper>
    </Box>
  );
}
