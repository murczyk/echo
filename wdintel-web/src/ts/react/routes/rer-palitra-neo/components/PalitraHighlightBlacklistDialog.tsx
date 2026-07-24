import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  Stack,
  TextField,
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
      <DialogTitle>Чорний список підсвічування</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="subtitle1">{palitra?.name ?? ''}</Typography>
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
                    >
                      <Checkbox checked={entry !== null} tabIndex={-1} disableRipple />
                      <Box sx={{ flex: 1 }}>
                        <Typography>{point.label}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {entry ? 'Прибрати з чорного списку' : 'Додати до чорного списку'}
                        </Typography>
                      </Box>
                      {pending ? <CircularProgress size={18} /> : null}
                    </ListItemButton>
                  );
                })}
              </List>
              {missingEntries.length > 0 ? (
                <Stack spacing={0.75}>
                  <Typography variant="subtitle2">Не знайдено серед поточних точок</Typography>
                  {missingEntries.map((entry) => (
                    <ListItemButton
                      key={entry.id}
                      onClick={() => onToggle(entry.label, entry)}
                      disabled={mutationBlocked || pendingEntryIds.has(entry.id)}
                      aria-label={`${entry.label}: Прибрати з чорного списку`}
                      sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}
                    >
                      <Box sx={{ flex: 1 }}>
                        <Typography>{entry.label}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          Прибрати з чорного списку
                        </Typography>
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
