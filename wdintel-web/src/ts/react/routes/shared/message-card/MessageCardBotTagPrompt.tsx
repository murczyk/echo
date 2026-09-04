import { Box, Button, Popover } from '@mui/material';

import type { MessageCardBotTagAction } from './message-card.types';

export function MessageCardBotTagPrompt({
  botTagAction,
  anchorEl,
  tagLabel,
  onCancelBotTagAction,
  onMarkBotTagWrong,
}: {
  botTagAction: MessageCardBotTagAction;
  anchorEl: HTMLElement;
  tagLabel: string;
  onCancelBotTagAction: () => void;
  onMarkBotTagWrong: (messageId: number, tagId: number) => void | Promise<void>;
}) {
  return (
    <Popover
      open
      anchorEl={anchorEl}
      onClose={onCancelBotTagAction}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      slotProps={{ paper: { sx: { mt: 0.5, p: 1 } } }}
    >
      <Box role="dialog" aria-label={`Дії для тегу ${tagLabel}`} sx={{ display: 'flex', gap: 1 }}>
        <Button type="button" size="small" variant="outlined" onClick={onCancelBotTagAction}>
          СКАСУВАТИ
        </Button>
        <Button
          type="button"
          size="small"
          variant="contained"
          onClick={() => void onMarkBotTagWrong(botTagAction.messageId, botTagAction.tagId)}
        >
          БОТ ПОМИЛИВСЯ
        </Button>
      </Box>
    </Popover>
  );
}
