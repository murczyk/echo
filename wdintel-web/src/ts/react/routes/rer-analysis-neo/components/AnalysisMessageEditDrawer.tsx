import { Box, Button, Drawer, Stack, TextField, Typography } from '@mui/material';
import React from 'react';

import type { InboxMessage } from '../../../../../Bindings';

type Props = {
  message: { id: number; message: InboxMessage } | null;
  open: boolean;
  saveInFlight: boolean;
  onClose: () => void;
  onSave: () => void;
  onUpdateField: <K extends keyof InboxMessage>(field: K, value: InboxMessage[K]) => void;
};

function nullableString(value: string | null | undefined): string {
  return value ?? '';
}

export function AnalysisMessageEditDrawer({ message, open, saveInFlight, onClose, onSave, onUpdateField }: Props) {
  return (
    <Drawer anchor="right" open={open} onClose={onClose}>
      <Box sx={{ width: { xs: '100vw', sm: 420 }, display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
          <Typography variant="h6">Редагування додаткових полів</Typography>
        </Box>
        <Stack spacing={2} sx={{ p: 2, flex: 1, overflow: 'auto' }}>
          <TextField
            label="Дата"
            value={nullableString(message?.message.date)}
            placeholder="YYYY-MM-DD"
            onChange={(event) => onUpdateField('date', event.target.value || null)}
          />
          <TextField
            label="Час"
            value={nullableString(message?.message.time)}
            placeholder="HH:MM"
            onChange={(event) => onUpdateField('time', event.target.value || null)}
          />
          <TextField
            label="Частота"
            value={nullableString(message?.message.freq)}
            onChange={(event) => onUpdateField('freq', event.target.value || null)}
          />
          <TextField
            label="Координати"
            value={nullableString(message?.message.coords)}
            onChange={(event) => onUpdateField('coords', event.target.value || null)}
          />
          <TextField
            label="Пост"
            value={nullableString(message?.message.post)}
            onChange={(event) => onUpdateField('post', event.target.value || null)}
          />
          <TextField
            label="Підрозділ"
            value={nullableString(message?.message.unit)}
            onChange={(event) => onUpdateField('unit', event.target.value || null)}
          />
          <TextField
            label="Локація"
            value={nullableString(message?.message.location)}
            onChange={(event) => onUpdateField('location', event.target.value || null)}
          />
        </Stack>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ p: 2, borderTop: '1px solid', borderColor: 'divider' }}>
          <Button onClick={onClose}>Скасувати</Button>
          <Button variant="contained" onClick={onSave} disabled={saveInFlight || message == null}>
            {saveInFlight ? 'Зберігаємо...' : 'Зберегти'}
          </Button>
        </Stack>
      </Box>
    </Drawer>
  );
}
