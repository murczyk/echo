import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import { Box, Button, Chip, Drawer, IconButton, Stack, TextField, Typography } from '@mui/material';
import { memo, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { PowerForm } from '../../../components/PowerForm';
import { ELLIPSIS, isNullOrUndefined } from '../../../utils/misc';

import type { InboxMessage } from '../../../../../Bindings';

type Props = {
  message: { id: number; message: InboxMessage } | null;
  open: boolean;
  saveInFlight: boolean;
  onClose: () => void;
  onSave: (message: InboxMessage) => void;
};

function nullableString(value: string | null | undefined): string {
  return value ?? '';
}

function normalizeCallsign(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeLocation(value: string): string {
  return value.trim();
}

function normalizeLocationKey(value: string): string {
  return normalizeLocation(value).toLocaleUpperCase('uk-UA');
}

function splitLocationList(value: string | null | undefined): string[] {
  return String(value ?? '')
    .split(',')
    .map(normalizeLocation)
    .filter((location) => location !== '');
}

function formatLocationList(locations: string[]): string | null {
  const nextLocations = locations.map(normalizeLocation).filter((location) => location !== '');
  return nextLocations.length > 0 ? nextLocations.join(', ') : null;
}

function AnalysisMessageEditDrawerComponent({
  message,
  open,
  saveInFlight,
  onClose,
  onSave,
}: Props) {
  const [callsignDraft, setCallsignDraft] = useState('');
  const [locationDraft, setLocationDraft] = useState('');
  const [draftMessage, setDraftMessage] = useState<InboxMessage | null>(message?.message ?? null);

  useEffect(() => {
    setCallsignDraft('');
    setLocationDraft('');
    setDraftMessage(message?.message ?? null);
  }, [message?.id, message?.message, open]);

  const currentMessage = draftMessage ?? message?.message ?? null;
  const canSave = !saveInFlight && !isNullOrUndefined(currentMessage);

  const updateDraftField = <K extends keyof InboxMessage>(field: K, value: InboxMessage[K]) => {
    setDraftMessage((current) =>
      isNullOrUndefined(current) ? current : { ...current, [field]: value },
    );
  };

  const proposedCallsigns = useMemo(() => {
    if (isNullOrUndefined(currentMessage)) return [];
    const present = new Set(
      (currentMessage.callsigns ?? []).map((item) => normalizeCallsign(item)),
    );
    return (currentMessage.callsignsAlg2 ?? [])
      .map((item) => normalizeCallsign(item))
      .filter((item) => item.length > 0 && item.length <= 12 && !present.has(item))
      .filter((item, index, list) => list.indexOf(item) === index);
  }, [currentMessage]);

  const addCallsign = () => {
    if (isNullOrUndefined(currentMessage)) return;
    const nextCallsign = normalizeCallsign(callsignDraft);
    if (!nextCallsign) return;
    const currentCallsigns = currentMessage.callsigns ?? [];
    const nextValues = currentCallsigns.map((item) => normalizeCallsign(item));
    if (nextValues.includes(nextCallsign)) {
      setCallsignDraft('');
      return;
    }
    updateDraftField('callsigns', [...currentCallsigns, nextCallsign]);
    setCallsignDraft('');
  };

  const removeCallsign = (callsign: string) => {
    if (isNullOrUndefined(currentMessage)) return;
    updateDraftField(
      'callsigns',
      (currentMessage.callsigns ?? []).filter(
        (item) => normalizeCallsign(item) !== normalizeCallsign(callsign),
      ),
    );
  };

  const currentLocations = useMemo(
    () => splitLocationList(currentMessage?.location),
    [currentMessage?.location],
  );

  const addSuggestedCallsign = (callsign: string) => {
    if (isNullOrUndefined(currentMessage)) return;
    const currentCallsigns = currentMessage.callsigns ?? [];
    if (currentCallsigns.some((item) => normalizeCallsign(item) === callsign)) return;
    updateDraftField('callsigns', [...currentCallsigns, callsign]);
  };

  const addLocation = () => {
    if (isNullOrUndefined(currentMessage)) return;
    const nextLocations = splitLocationList(locationDraft);
    if (nextLocations.length === 0) return;
    const existingLocations = new Set(currentLocations.map(normalizeLocationKey));
    const locations = [...currentLocations];
    nextLocations.forEach((location) => {
      const locationKey = normalizeLocationKey(location);
      if (existingLocations.has(locationKey)) return;
      locations.push(location);
      existingLocations.add(locationKey);
    });
    updateDraftField('location', formatLocationList(locations));
    setLocationDraft('');
  };

  const removeLocation = (location: string) => {
    if (isNullOrUndefined(currentMessage)) return;
    const locationKey = normalizeLocationKey(location);
    updateDraftField(
      'location',
      formatLocationList(
        currentLocations.filter((item) => normalizeLocationKey(item) !== locationKey),
      ),
    );
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave || isNullOrUndefined(currentMessage)) return;
    onSave(currentMessage);
  };

  return (
    <Drawer anchor="right" open={open} onClose={onClose} ModalProps={{ disableRestoreFocus: true }}>
      <PowerForm
        canSubmit={canSave}
        onSubmit={handleSubmit}
        sx={{
          width: { xs: '100vw', sm: 420 },
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
        }}
      >
        <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
          <Typography variant="h6">Редагування додаткових полів</Typography>
        </Box>
        <Stack spacing={2} sx={{ p: 2, flex: 1, overflow: 'auto' }}>
          <TextField
            label="Дата"
            value={nullableString(currentMessage?.date)}
            placeholder="YYYY-MM-DD"
            onChange={(event) => updateDraftField('date', event.target.value || null)}
          />
          <TextField
            label="Час"
            value={nullableString(currentMessage?.time)}
            placeholder="HH:MM"
            onChange={(event) => updateDraftField('time', event.target.value || null)}
          />
          <TextField
            label="Частота"
            value={nullableString(currentMessage?.freq)}
            onChange={(event) => updateDraftField('freq', event.target.value || null)}
          />
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField
                fullWidth
                label="Позивний"
                value={callsignDraft}
                placeholder="Додати позивний"
                onChange={(event) => setCallsignDraft(event.target.value.toUpperCase())}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    addCallsign();
                  }
                }}
              />
              <IconButton
                aria-label="Додати позивний"
                onClick={addCallsign}
                disabled={normalizeCallsign(callsignDraft) === ''}
              >
                <AddIcon />
              </IconButton>
            </Stack>

            <Stack direction="row" gap={1} flexWrap="wrap">
              {(currentMessage?.callsigns ?? []).length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  Позивні ще не додані
                </Typography>
              ) : (
                (currentMessage?.callsigns ?? []).map((callsign) => (
                  <Chip
                    key={callsign}
                    label={callsign}
                    onDelete={() => removeCallsign(callsign)}
                    deleteIcon={<CloseIcon />}
                    color="primary"
                    variant="outlined"
                  />
                ))
              )}
            </Stack>

            {proposedCallsigns.length > 0 ? (
              <Stack spacing={0.75}>
                <Typography variant="caption" color="text.secondary">
                  Запропоновані позивні
                </Typography>
                <Stack direction="row" gap={1} flexWrap="wrap">
                  {proposedCallsigns.map((callsign) => (
                    <Chip
                      key={callsign}
                      label={callsign}
                      onClick={() => addSuggestedCallsign(callsign)}
                      variant="filled"
                    />
                  ))}
                </Stack>
              </Stack>
            ) : null}
          </Stack>
          <TextField
            label="Координати"
            value={nullableString(currentMessage?.coords)}
            onChange={(event) => updateDraftField('coords', event.target.value || null)}
          />
          <TextField
            label="Пост"
            value={nullableString(currentMessage?.post)}
            onChange={(event) => updateDraftField('post', event.target.value || null)}
          />
          <TextField
            label="Підрозділ"
            value={nullableString(currentMessage?.unit)}
            onChange={(event) => updateDraftField('unit', event.target.value || null)}
          />
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField
                fullWidth
                label="Локація"
                value={locationDraft}
                placeholder="Додати локацію"
                onChange={(event) => setLocationDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    addLocation();
                  }
                }}
              />
              <IconButton
                aria-label="Додати локацію"
                onClick={addLocation}
                disabled={normalizeLocation(locationDraft) === ''}
              >
                <AddIcon />
              </IconButton>
            </Stack>

            <Stack direction="row" gap={1} flexWrap="wrap">
              {currentLocations.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  Локації ще не додані
                </Typography>
              ) : (
                currentLocations.map((location) => (
                  <Chip
                    key={location}
                    label={location}
                    onDelete={() => removeLocation(location)}
                    deleteIcon={<CloseIcon />}
                    color="primary"
                    variant="outlined"
                  />
                ))
              )}
            </Stack>
          </Stack>
        </Stack>
        <Stack
          direction="row"
          spacing={1}
          justifyContent="flex-end"
          sx={{ p: 2, borderTop: '1px solid', borderColor: 'divider' }}
        >
          <Button type="button" onClick={onClose}>
            Скасувати
          </Button>
          <Button type="submit" variant="contained" disabled={!canSave}>
            {saveInFlight ? `Зберігаємо${ELLIPSIS}` : 'Зберегти'}
          </Button>
        </Stack>
      </PowerForm>
    </Drawer>
  );
}

export const AnalysisMessageEditDrawer = memo(AnalysisMessageEditDrawerComponent);
