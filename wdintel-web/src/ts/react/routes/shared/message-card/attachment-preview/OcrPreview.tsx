import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { Box, Button, IconButton, Stack, Tooltip, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useEffect, useState, type ReactNode } from 'react';

import type { OcrMediaSummary } from '../../../../../../Bindings';
import { MessageCardDisabledControlCursorWrapper } from '../MessageCardDisabledControlCursorWrapper';

export function OcrPreviewAction({
  ocr,
  active,
  onClick,
}: {
  ocr?: OcrMediaSummary | null;
  active: boolean;
  onClick: () => void;
}) {
  if (ocr == null) return null;
  const ready = ocr.state === 'completed' && ocr.qualityStatus !== 'failed';
  const progress = ocr.totalPages > 0 ? ` (${ocr.processedPages}/${ocr.totalPages} стор.)` : '';
  const title = ready
    ? active
      ? 'Закрити OCR'
      : ocr.qualityStatus === 'degraded'
        ? 'Переглянути OCR (якість знижена)'
        : 'Переглянути OCR'
    : ocr.state === 'failed'
      ? `OCR завершився з помилкою${ocr.lastError ? `: ${ocr.lastError}` : ''}`
      : `OCR обробляється${progress}`;

  const button = (
    <IconButton
      aria-label={title}
      aria-pressed={ready ? active : undefined}
      disabled={!ready}
      color={active ? 'primary' : 'default'}
      size="small"
      onClick={onClick}
      sx={{
        color: active ? 'primary.main' : 'text.secondary',
        '&:hover': { color: active ? 'primary.dark' : 'text.primary' },
      }}
    >
      <VisibilityIcon fontSize="small" />
    </IconButton>
  );

  return (
    <Tooltip title={title} enterDelay={300}>
      <MessageCardDisabledControlCursorWrapper disabled={!ready}>
        {button}
      </MessageCardDisabledControlCursorWrapper>
    </Tooltip>
  );
}

export function OcrSplitPreview({
  source,
  mediaId,
  visible,
  fullPane,
  onFullPaneChange,
}: {
  source: ReactNode;
  mediaId?: string | null;
  visible: boolean;
  fullPane: boolean;
  onFullPaneChange: (value: boolean) => void;
}) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('sm'));
  const [mobilePane, setMobilePane] = useState<'source' | 'ocr'>('ocr');

  useEffect(() => {
    if (visible) setMobilePane('ocr');
    if (!visible) onFullPaneChange(false);
  }, [onFullPaneChange, visible]);

  if (!visible || mediaId == null) return source;
  const showSource = mobile ? mobilePane === 'source' : !fullPane;
  const showOcr = mobile ? mobilePane === 'ocr' : true;

  return (
    <Box sx={{ flex: '1 1 auto', minHeight: 0, display: 'flex', position: 'relative' }}>
      <Box
        sx={{
          display: showSource ? 'flex' : 'none',
          flex: mobile ? '1 1 100%' : '1 1 50%',
          minWidth: 0,
          minHeight: 0,
          borderRight: mobile ? 0 : 1,
          borderColor: 'divider',
        }}
      >
        {source}
      </Box>
      <Box
        sx={{
          display: showOcr ? 'flex' : 'none',
          flex: fullPane || mobile ? '1 1 100%' : '1 1 50%',
          minWidth: 0,
          minHeight: 0,
          position: 'relative',
          bgcolor: 'background.paper',
        }}
      >
        <Box
          component="iframe"
          title="OCR"
          src={`/api/messenger/media/${encodeURIComponent(mediaId)}/ocr`}
          sandbox=""
          referrerPolicy="no-referrer"
          sx={{ flex: 1, minWidth: 0, border: 0, bgcolor: 'background.paper' }}
        />
      </Box>
      <Stack
        direction="row"
        spacing={0.5}
        sx={{ position: 'absolute', top: 8, right: 8, zIndex: 2 }}
      >
        {mobile ? (
          <>
            <Button
              size="small"
              variant={mobilePane === 'source' ? 'contained' : 'outlined'}
              onClick={() => setMobilePane('source')}
            >
              Оригінал
            </Button>
            <Button
              size="small"
              variant={mobilePane === 'ocr' ? 'contained' : 'outlined'}
              onClick={() => setMobilePane('ocr')}
            >
              OCR
            </Button>
          </>
        ) : (
          <Tooltip title={fullPane ? 'Повернути розділений перегляд' : 'Розгорнути OCR'}>
            <IconButton
              size="small"
              aria-label={fullPane ? 'Повернути розділений перегляд' : 'Розгорнути OCR'}
              onClick={() => onFullPaneChange(!fullPane)}
              sx={{ bgcolor: 'background.paper', boxShadow: 1 }}
            >
              {fullPane ? (
                <FullscreenExitIcon fontSize="small" />
              ) : (
                <FullscreenIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
        )}
      </Stack>
    </Box>
  );
}
