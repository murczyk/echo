import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Drawer,
  FormControlLabel,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import { AnalyzeKmzResponse, AreaOfResponsibility, MyScope, Organism, User } from '../../../../../Bindings';
import { isAdmin, isFormValid } from '../helpers';
import { KmzColorOption, PalitraFormState } from '../types';
import { AccessEditor } from './AccessEditor';

type Props = {
  open: boolean;
  onClose: () => void;
  createInFlight: boolean;
  kmzAnalyzing: boolean;
  kmzFile: File | null;
  kmzAnalysis: AnalyzeKmzResponse | null;
  kmzColorOptions: KmzColorOption[];
  selectedColorFromKmz: string;
  createForm: PalitraFormState;
  user: User | null;
  myScope: MyScope | null;
  organisms: Organism[];
  aors: AreaOfResponsibility[];
  allLogins: string[];
  availableAccessTypes: ('logins' | 'organisms' | 'aor')[];
  onRequestAnalyzeKmz: () => void;
  onSetKmzColorOptions: (updater: (prev: KmzColorOption[]) => KmzColorOption[]) => void;
  onSetSelectedColorFromKmz: (value: string) => void;
  onSetCreateForm: (updater: (prev: PalitraFormState) => PalitraFormState) => void;
  onCreate: () => void;
};

export function CreatePalitraDrawer({
  open,
  onClose,
  createInFlight,
  kmzAnalyzing,
  kmzFile,
  kmzAnalysis,
  kmzColorOptions,
  selectedColorFromKmz,
  createForm,
  user,
  myScope,
  organisms,
  aors,
  allLogins,
  availableAccessTypes,
  onRequestAnalyzeKmz,
  onSetKmzColorOptions,
  onSetSelectedColorFromKmz,
  onSetCreateForm,
  onCreate,
}: Props) {
  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={createInFlight ? undefined : onClose}
      sx={{
        zIndex: 3500,
        '& .MuiBackdrop-root': { zIndex: 3499 },
        '& .MuiDrawer-paper': { zIndex: 3500 },
      }}
      PaperProps={{ sx: { width: { xs: '100%', sm: 680 }, maxWidth: '100vw', display: 'flex' } }}
    >
      <Box sx={{ p: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="h6">Створити палітру</Typography>
      </Box>
      <Box sx={{ p: 2.5, flex: 1, overflowY: 'auto' }}>
        <Stack spacing={2}>
          <Button
            variant="outlined"
            onClick={onRequestAnalyzeKmz}
            disabled={kmzAnalyzing || createInFlight}
            sx={{ alignSelf: 'flex-start' }}
          >
            {kmzAnalyzing ? 'Аналіз...' : kmzFile ? 'Замінити KMZ файл' : 'Обрати KMZ файл'}
          </Button>

          {kmzFile ? (
            <Typography variant="caption" color="text.secondary">
              Файл: {kmzFile.name}
            </Typography>
          ) : null}

          {kmzAnalysis ? <Alert severity="success">KMZ проаналізовано, кольорів: {kmzAnalysis.topColors.length}</Alert> : null}

          {kmzColorOptions.length > 0 ? (
            <Stack spacing={1}>
              <Typography variant="subtitle2">Кольори з KMZ</Typography>
              <Stack direction="row" spacing={1}>
                <Button size="small" onClick={() => onSetKmzColorOptions((prev) => prev.map((option) => ({ ...option, selected: true })))}>
                  Обрати всі
                </Button>
                <Button size="small" onClick={() => onSetKmzColorOptions((prev) => prev.map((option) => ({ ...option, selected: false })))}>
                  Зняти всі
                </Button>
              </Stack>
              {kmzColorOptions.map((option) => (
                <Paper key={option.colorHex} variant="outlined" sx={{ p: 1.5 }}>
                  <Stack direction="row" spacing={2} alignItems="center">
                    <FormControlLabel
                      control={
                        <Checkbox
                          size="small"
                          checked={option.selected}
                          onChange={() =>
                            onSetKmzColorOptions((prev) =>
                              prev.map((entry) =>
                                entry.colorHex === option.colorHex ? { ...entry, selected: !entry.selected } : entry,
                              ),
                            )
                          }
                        />
                      }
                      label={
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Chip
                            size="small"
                            label={option.colorHex}
                            sx={{ backgroundColor: option.colorHex, color: '#fff', fontFamily: 'monospace' }}
                          />
                          <Typography variant="caption">топ #{option.rank} ({option.count})</Typography>
                        </Stack>
                      }
                    />
                    <TextField
                      size="small"
                      label="Суфікс"
                      value={option.suffix}
                      onChange={(event) =>
                        onSetKmzColorOptions((prev) =>
                          prev.map((entry) =>
                            entry.colorHex === option.colorHex ? { ...entry, suffix: event.target.value } : entry,
                          ),
                        )
                      }
                      sx={{ minWidth: '220px' }}
                    />
                  </Stack>
                </Paper>
              ))}
            </Stack>
          ) : null}

          {kmzColorOptions.length === 0 ? (
            <TextField
              label="Колір"
              type="color"
              size="small"
              value={selectedColorFromKmz}
              onChange={(event) => {
                onSetSelectedColorFromKmz(event.target.value);
                onSetCreateForm((prev) => ({ ...prev, colorHex: event.target.value }));
              }}
              disabled={createInFlight}
              sx={{ width: '140px' }}
            />
          ) : null}

          <TextField
            label="Назва"
            size="small"
            value={createForm.name}
            onChange={(event) => onSetCreateForm((prev) => ({ ...prev, name: event.target.value }))}
            disabled={createInFlight}
            fullWidth
          />

          <AccessEditor
            form={createForm}
            onChange={(next) => onSetCreateForm(() => next)}
            user={user}
            myScope={myScope}
            organisms={organisms}
            aors={aors}
            allLogins={allLogins}
            availableAccessTypes={availableAccessTypes}
          />

          {allLogins.length > 0 && isAdmin(user) ? (
            <Typography variant="caption" color="text.secondary">
              Доступні логіни: {allLogins.join(', ')}
            </Typography>
          ) : null}
        </Stack>
      </Box>
      <Box sx={{ p: 2.5, borderTop: '1px solid', borderColor: 'divider', display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
        <Button onClick={onClose} disabled={createInFlight}>
          Скасувати
        </Button>
        <Button
          onClick={onCreate}
          variant="contained"
          disabled={
            createInFlight ||
            !kmzFile ||
            !isFormValid(createForm) ||
            (kmzColorOptions.length > 0 && !kmzColorOptions.some((option) => option.selected))
          }
        >
          {createInFlight ? <CircularProgress size={16} /> : 'Створити'}
        </Button>
      </Box>
    </Drawer>
  );
}
