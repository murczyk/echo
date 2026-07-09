import { Box, Button, Stack, Typography } from '@mui/material';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useState } from 'react';

import type { MessageComment } from '../../../../../Bindings';

const OTHER_COMMENTS_PREVIEW_COUNT = 3;

function commentAuthorLabel(comment: MessageComment): string {
  const sigintPostName = comment.sigintPostName?.trim() ?? '';
  return sigintPostName === '' ? comment.login : sigintPostName;
}

export function MessageCardComments({ messageComments }: { messageComments: MessageComment[] }) {
  const [showOtherCommentsRest, setShowOtherCommentsRest] = useState(false);
  const hasOtherCommentsRest = messageComments.length > OTHER_COMMENTS_PREVIEW_COUNT;
  const visibleOtherComments =
    showOtherCommentsRest || !hasOtherCommentsRest
      ? messageComments
      : messageComments.slice(0, OTHER_COMMENTS_PREVIEW_COUNT);
  const otherCommentsExpandToggleButton = hasOtherCommentsRest ? (
    <Button
      size="small"
      color="inherit"
      variant="text"
      onClick={() => setShowOtherCommentsRest((v) => !v)}
      aria-expanded={showOtherCommentsRest}
      aria-label={
        showOtherCommentsRest ? 'Згорнути додаткові коментарі' : 'Показати додаткові коментарі'
      }
      endIcon={
        showOtherCommentsRest ? (
          <ExpandLessIcon fontSize="inherit" aria-hidden />
        ) : (
          <ExpandMoreIcon fontSize="inherit" aria-hidden />
        )
      }
      sx={{
        flexShrink: 0,
        minHeight: 27,
        py: 0,
        px: 0.5,
        fontSize: '0.875rem',
        fontWeight: 400,
        textTransform: 'none',
        color: 'var(--color-action)',
        '& .MuiButton-endIcon': { ml: 1, mr: 0, '& i': { fontSize: '0.875rem' } },
        alignSelf: 'flex-start',
      }}
    >
      {showOtherCommentsRest ? 'згорнути' : 'розгорнути'}
    </Button>
  ) : null;

  if (messageComments.length === 0) return null;

  return (
    <Stack
      spacing={0.75}
      sx={{
        minWidth: 0,
        mt: 0.25,
        pl: 1,
        py: 0.25,
        borderLeft: '4px solid',
        borderColor: 'divider',
      }}
    >
      {visibleOtherComments.map((comment, index) => (
        <Stack
          key={`${comment.messageId}-${comment.id}-${index}`}
          spacing={0.25}
          sx={{ minWidth: 0 }}
        >
          <Typography
            variant="caption"
            sx={{ fontWeight: 700, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', minWidth: 0 }}
          >
            {commentAuthorLabel(comment)}
          </Typography>
          <Typography
            variant="caption"
            sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', lineHeight: 1.4, minWidth: 0 }}
          >
            {comment.comment}
          </Typography>
        </Stack>
      ))}
      {otherCommentsExpandToggleButton ? (
        <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
          {otherCommentsExpandToggleButton}
        </Box>
      ) : null}
    </Stack>
  );
}
