import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import { Box, Button, Tooltip } from '@mui/material';
import type { MouseEvent } from 'react';

import type { MessageCardDocument } from './document-preview.types';
import { deriveDocumentDownloadName, deriveDocumentFileName } from './message-card-document-utils';
import { blurActiveElement } from '../../../utils/focus';
import { MessageMediaThumbnailDownloadLink } from './MessageCardMedia';

export function MessageMediaDocumentLink({
  document,
  index,
  selected = false,
  onPreview,
  isDownloadStarting,
  onDownloadStart,
}: {
  document: MessageCardDocument;
  index: number;
  selected?: boolean;
  onPreview?: () => void;
  isDownloadStarting: (downloadKey: string) => boolean;
  onDownloadStart: (downloadKey: string) => boolean;
}) {
  const displayName = deriveDocumentFileName(document, index);
  const downloadName = deriveDocumentDownloadName(document, index);
  const canPreview = document.kind !== 'unsupported' && onPreview != null;
  const downloadKey = `media:${String(document.id ?? '')}`;
  const handlePreviewClick = (_event: MouseEvent<HTMLButtonElement>) => {
    blurActiveElement();
    onPreview?.();
  };

  return (
    <span
      className="relative inline-flex max-w-full min-w-0 items-center self-start"
      data-message-card-attachment-tile="true"
    >
      <Tooltip title={displayName} enterDelay={400}>
        <Button
          size="small"
          variant="outlined"
          onClick={canPreview ? handlePreviewClick : undefined}
          disabled={!canPreview}
          type="button"
          aria-current={selected ? 'true' : undefined}
          data-summary-selected={selected ? 'true' : undefined}
          sx={{
            minWidth: 0,
            maxWidth: '100%',
            minHeight: 32,
            py: 0.25,
            pl: 0.75,
            pr: 4,
            fontSize: 11,
            lineHeight: 1.25,
            textTransform: 'none',
            fontWeight: 500,
            color: 'text.primary',
            borderColor: selected ? 'primary.light' : 'divider',
            backgroundColor: selected ? 'action.selected' : 'transparent',
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
      <MessageMediaThumbnailDownloadLink
        href={document.href}
        displayName={displayName}
        downloadName={downloadName}
        downloadKey={downloadKey}
        isDownloadStarting={isDownloadStarting}
        onDownloadStart={onDownloadStart}
      />
    </span>
  );
}
