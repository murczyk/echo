import { Box, Button } from '@mui/material';

import type { MessageCardBotTagAction } from './message-card.types';

export function MessageCardBotTagPrompt({
  botTagAction,
  onCancelBotTagAction,
  onMarkBotTagWrong,
}: {
  botTagAction: MessageCardBotTagAction;
  onCancelBotTagAction: () => void;
  onMarkBotTagWrong: (messageId: number, tagId: number) => void | Promise<void>;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 1,
        alignItems: 'center',
        px: 1.5,
        py: 1,
        borderRadius: 1,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'var(--color-card)',
      }}
    >
      <Button
        type="button"
        size="small"
        variant="contained"
        onClick={() => void onMarkBotTagWrong(botTagAction.messageId, botTagAction.tagId)}
        sx={{ minHeight: 30, textTransform: 'none' }}
      >
        бот помилився
      </Button>
      <Button type="button" size="small" variant="outlined" onClick={onCancelBotTagAction} sx={{ minHeight: 30, textTransform: 'none' }}>
        закрити
      </Button>
    </Box>
  );
}
