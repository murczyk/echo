import DataObjectIcon from '@mui/icons-material/DataObject';
import { Box, IconButton, Popover, Stack, Tooltip, Typography } from '@mui/material';
import { useId, useState } from 'react';
import type { MouseEvent } from 'react';

import type { InboxMessage } from '../../../../../Bindings';
import { buildDmrMetadataRows } from './message-card-metadata';
import { isPresent } from '../../../utils/misc';

const MESSAGE_CARD_ACTION_COLOR = 'var(--color-action)';

export function MessageCardDmrMetadataPopover({ msg }: { msg: InboxMessage }) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const popoverId = useId().replace(/:/g, '-');
  const rows = buildDmrMetadataRows(msg);
  const open = isPresent(anchorEl);

  if (rows.length === 0) {
    return null;
  }

  function openPopover(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setAnchorEl(event.currentTarget);
  }

  function closePopover() {
    setAnchorEl(null);
  }

  return (
    <>
      <Tooltip title="DMR метадані">
        <IconButton
          aria-label="DMR метадані"
          aria-controls={open ? popoverId : undefined}
          aria-haspopup="dialog"
          aria-expanded={open ? 'true' : undefined}
          onClick={openPopover}
          size="medium"
          sx={{
            width: 30,
            minWidth: 30,
            height: 30,
            color: MESSAGE_CARD_ACTION_COLOR,
            '&:hover': {
              backgroundColor: 'action.hover',
            },
          }}
        >
          <DataObjectIcon fontSize="inherit" />
        </IconButton>
      </Tooltip>
      <Popover
        id={popoverId}
        open={open}
        anchorEl={anchorEl}
        onClose={closePopover}
        disableAutoFocus
        disableEnforceFocus
        disableRestoreFocus
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: {
            sx: {
              width: 320,
              maxWidth: 'calc(100vw - 24px)',
              p: 1.25,
              mt: 1,
            },
          },
        }}
      >
        <Stack spacing={1}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            DMR метадані
          </Typography>
          <Stack spacing={0.75}>
            {rows.map((row) => (
              <Box
                key={`${row.label}:${row.value}`}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: '72px minmax(0, 1fr)',
                  columnGap: 1,
                  alignItems: 'start',
                  minWidth: 0,
                }}
              >
                <Typography variant="caption" color="text.secondary">
                  {row.label}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{
                    minWidth: 0,
                    fontWeight: 600,
                    overflowWrap: 'anywhere',
                    wordBreak: 'break-word',
                    whiteSpace: 'normal',
                  }}
                >
                  {row.value}
                </Typography>
              </Box>
            ))}
          </Stack>
        </Stack>
      </Popover>
    </>
  );
}
