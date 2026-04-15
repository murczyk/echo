import { useCallback, useEffect, useRef } from 'react';
import { Alert, Box, Button, Drawer, Stack, Typography } from '@mui/material';

import type { Source, Unit } from '../../../../../Bindings';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';
import { CALLSIGN_FORM_HINT, RO_SOURCE_RADIO_FREQ_REQUIRED_ERROR } from '../helpers';
import { CallsignFormFields } from './CallsignFormFields';
import type { CallsignEditForm } from '../types';
import { PowerAlert } from '../../../components/PowerAlert';

type Props = {
  open: boolean;
  form: CallsignEditForm | null;
  units: Unit[];
  sources: Source[];
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onChange: (next: CallsignEditForm) => void;
  onSave: () => void;
};

export function EditCallsignDrawer({ open, form, units, sources, submitting, error, onClose, onChange, onSave }: Props) {
  const titleId = 'callsigns-edit-drawer-title';
  const latestFormRef = useRef<CallsignEditForm | null>(form);

  useEffect(() => {
    latestFormRef.current = form;
  }, [form]);

  const handleFormChange = useCallback(
    (next: CallsignEditForm) => {
      latestFormRef.current = next;
      onChange(next);
    },
    [onChange],
  );

  const handleCallsignAdditionalSourceIdsChange = useCallback(
    (callsignAdditionalSourceIds: number[]) => {
      const current = latestFormRef.current;
      if (!current) return;
      const next = { ...current, callsignAdditionalSourceIds };
      latestFormRef.current = next;
      onChange(next);
    },
    [onChange],
  );

  return (
    <Drawer
      anchor='right'
      open={open}
      onClose={submitting ? undefined : onClose}
      ModalProps={{
        BackdropProps: {
          sx: (theme) => pageDrawerBackdropSx(theme),
        },
      }}
      slotProps={{
        paper: {
          'aria-labelledby': titleId,
          sx: {
            width: { xs: '100vw', sm: 640 },
            maxWidth: '100vw',
            display: 'flex',
            backgroundColor: 'background.default',
            backgroundImage: 'none',
          },
        },
      }}
    >
      <Box sx={{ p: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant='h6' id={titleId}>
          Редагувати позивний
        </Typography>
      </Box>
      <Box sx={{ p: 2.5, flex: 1, overflowY: 'auto' }}>
        <Stack spacing={2.5}>
          {error ? <PowerAlert severity='error'>{error}</PowerAlert> : null}
          {form ? (
            <CallsignFormFields
              value={form}
              onChange={handleFormChange}
              units={units}
              sources={sources}
              includeUnitSelect
              includeSourceSelect
              includeConfirmationSources
              compact
              controlsFirst
              hintContent={
                <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
                  <Typography variant='caption' color='text.secondary' sx={{ textAlign: 'left' }}>
                    {CALLSIGN_FORM_HINT}
                    {form.sourceId === 2 ? ` ${RO_SOURCE_RADIO_FREQ_REQUIRED_ERROR}` : ''}
                  </Typography>
                </Box>
              }
              callsignAdditionalSourceIds={form.callsignAdditionalSourceIds}
              onCallsignAdditionalSourceIdsChange={handleCallsignAdditionalSourceIdsChange}
              disabled={submitting}
            />
          ) : null}
        </Stack>
      </Box>
      <Box sx={{ p: 2.5, borderTop: '1px solid', borderColor: 'divider', display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
        <Button onClick={onClose} disabled={submitting}>
          Скасувати
        </Button>
        <Button onClick={onSave} variant='contained' disabled={submitting || !form}>
          {submitting ? 'Збереження…' : 'Зберегти'}
        </Button>
      </Box>
    </Drawer>
  );
}
