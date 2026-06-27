import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import { Box, Button, IconButton, Tooltip } from '@mui/material';

import type { MessageCardDocument } from './document-preview.types';
import { deriveDocumentDownloadName, deriveDocumentFileName } from './message-card-document-utils';

export function MessageMediaDocumentLink({
  document,
  index,
  onPreview,
}: {
  document: MessageCardDocument;
  index: number;
  onPreview?: () => void;
}) {
  const displayName = deriveDocumentFileName(document, index);
  const downloadName = deriveDocumentDownloadName(document, index);
  const canPreview = document.kind !== 'unsupported' && onPreview != null;

  return (
    <Box
      sx={{
        mb: 0.5,
        width: '100%',
        maxWidth: 520,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
      }}
    >
      <Tooltip title={displayName} enterDelay={400}>
        <Button
          size="small"
          variant="contained"
          onClick={canPreview ? onPreview : undefined}
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
      <Tooltip title="Завантажити" enterDelay={400}>
        <IconButton
          component="a"
          href={document.href}
          download={downloadName}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Завантажити"
          size="small"
          sx={{ color: 'text.secondary' }}
        >
          <DownloadOutlinedIcon fontSize="inherit" />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
