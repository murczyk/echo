import ClearOutlinedIcon from '@mui/icons-material/ClearOutlined';
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';

import { PowerAlert } from '../../../components/PowerAlert';
import type { Palitra, PalitraHighlightBlacklistEntry } from '../../../../../Bindings';
import { highlightBlacklistLabelKey } from '../../../services/api/palitra';
import { deriveHighlightBlacklistPoints } from './PalitraHighlightBlacklistDialog.helpers';

type Props = {
  palitra: Palitra | null;
  data: Parameters<typeof deriveHighlightBlacklistPoints>[0] | null;
  entries: PalitraHighlightBlacklistEntry[];
  loading: boolean;
  error: string | null;
  mutationError: string | null;
  mutationBlocked: boolean;
  pendingEntryIds: Set<number>;
  pendingLabels: Set<string>;
  onRetry: () => void;
  onToggle: (label: string, entry: PalitraHighlightBlacklistEntry | null) => void;
  onClose: () => void;
};

export function PalitraHighlightBlacklistDialog({
  palitra,
  data,
  entries,
  loading,
  error,
  mutationError,
  mutationBlocked,
  pendingEntryIds,
  pendingLabels,
  onRetry,
  onToggle,
  onClose,
}: Props) {
  const [search, setSearch] = useState('');
  const derived = data ? deriveHighlightBlacklistPoints(data, entries) : null;
  const blacklistedByLabel = new Map(
    entries.map((entry) => [highlightBlacklistLabelKey(entry.label), entry]),
  );
  const normalizedSearch = highlightBlacklistLabelKey(search);
  const points = (derived?.points ?? []).filter((point) =>
    point.normalizedLabel.includes(normalizedSearch),
  );
  const missingEntries = (derived?.missingEntries ?? []).filter((entry) =>
    highlightBlacklistLabelKey(entry.label).includes(normalizedSearch),
  );

  useEffect(() => {
    if (palitra === null) setSearch('');
  }, [palitra]);

  return (
    <Dialog open={palitra !== null} onClose={onClose} disableRestoreFocus fullWidth maxWidth="sm">
      <DialogTitle>Чорний список</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="subtitle1">{palitra?.name ?? ''}</Typography>
          <Typography variant="body2" color="text.secondary">
            Позначені точки не підсвічуються в картках повідомлень. Зніміть позначку, щоб повернути
            підсвітку.
          </Typography>
          {loading ? (
            <Stack direction="row" spacing={1.5} alignItems="center">
              <CircularProgress size={18} />
              <Typography>Завантаження чорного списку та точок...</Typography>
            </Stack>
          ) : error ? (
            <PowerAlert severity="error" action={<Button onClick={onRetry}>Повторити</Button>}>
              Не вдалося завантажити дані: {error}
            </PowerAlert>
          ) : (
            <>
              <TextField
                label="Пошук точки"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                autoFocus
                fullWidth
                size="small"
                slotProps={{
                  input: {
                    endAdornment:
                      search !== '' ? (
                        <InputAdornment position="end">
                          <Tooltip title="Очистити пошук" arrow>
                            <IconButton
                              aria-label="Очистити пошук точок"
                              size="small"
                              onClick={() => setSearch('')}
                              edge="end"
                            >
                              <ClearOutlinedIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </InputAdornment>
                      ) : undefined,
                  },
                }}
              />
              {mutationError ? (
                <PowerAlert severity="error">
                  Не вдалося змінити чорний список: {mutationError}
                </PowerAlert>
              ) : null}
              {mutationBlocked ? (
                <PowerAlert severity="warning">
                  Подальші зміни недоступні для цієї сесії діалогу.
                </PowerAlert>
              ) : null}
              {points.length === 0 && missingEntries.length === 0 ? (
                <Typography color="text.secondary">
                  {derived?.points.length
                    ? 'Збігів не знайдено.'
                    : 'У палітрі немає придатних точок.'}
                </Typography>
              ) : null}
              <List dense disablePadding sx={{ maxHeight: 360, overflowY: 'auto' }}>
                {points.map((point) => {
                  const entry = blacklistedByLabel.get(point.normalizedLabel) ?? null;
                  const pending =
                    (entry !== null && pendingEntryIds.has(entry.id)) ||
                    (entry === null && pendingLabels.has(point.normalizedLabel));
                  return (
                    <ListItemButton
                      key={point.normalizedLabel}
                      onClick={() => onToggle(point.label, entry)}
                      disabled={mutationBlocked || pending}
                      role="checkbox"
                      aria-checked={entry !== null}
                      aria-label={
                        entry
                          ? `${point.label}: Прибрати з чорного списку`
                          : `${point.label}: Додати до чорного списку`
                      }
                      selected={entry !== null}
                      sx={{ alignItems: 'center', gap: 1, px: 1, py: 0.75, borderRadius: 1 }}
                    >
                      <Checkbox
                        checked={entry !== null}
                        tabIndex={-1}
                        disableRipple
                        sx={{ p: 0.5 }}
                      />
                      <Box sx={{ flex: 1 }}>
                        <Typography>{point.label}</Typography>
                      </Box>
                      {pending ? <CircularProgress size={18} /> : null}
                    </ListItemButton>
                  );
                })}
              </List>
              {missingEntries.length > 0 ? (
                <Stack spacing={0.75}>
                  <Typography variant="subtitle2">
                    У чорному списку, але точки вже немає в палітрі
                  </Typography>
                  {missingEntries.map((entry) => (
                    <ListItemButton
                      key={entry.id}
                      onClick={() => onToggle(entry.label, entry)}
                      disabled={mutationBlocked || pendingEntryIds.has(entry.id)}
                      role="checkbox"
                      aria-checked
                      aria-label={`${entry.label}: Прибрати з чорного списку`}
                      selected
                      sx={{
                        alignItems: 'center',
                        gap: 1,
                        border: 1,
                        borderColor: 'divider',
                        px: 1,
                      }}
                    >
                      <Checkbox checked tabIndex={-1} disableRipple sx={{ p: 0.5 }} />
                      <Box sx={{ flex: 1 }}>
                        <Typography>{entry.label}</Typography>
                      </Box>
                      {pendingEntryIds.has(entry.id) ? <CircularProgress size={18} /> : null}
                    </ListItemButton>
                  ))}
                </Stack>
              ) : null}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Закрити</Button>
      </DialogActions>
    </Dialog>
  );
}
