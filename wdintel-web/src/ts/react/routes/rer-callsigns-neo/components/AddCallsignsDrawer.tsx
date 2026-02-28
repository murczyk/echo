import React from 'react';
import AddIcon from '@mui/icons-material/Add';
import ClearAllIcon from '@mui/icons-material/ClearAll';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Divider,
  Drawer,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';

import type { Source, Unit } from '../../../../../Bindings';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';
import { CallsignFormFields } from './CallsignFormFields';
import type { CallsignDraftRow } from '../types';

type Props = {
  open: boolean;
  onClose: () => void;
  units: Unit[];
  sources: Source[];
  addUnitId: number | null;
  addSourceId: number | null;
  rows: CallsignDraftRow[];
  submitting: boolean;
  disabled: boolean;
  validationError: string | null;
  duplicateHints: Array<{
    id: number;
    callsign: string;
    position: string;
    comment: string;
    unitName: string;
  }>;
  onAddUnitIdChange: (unitId: number | null) => void;
  onAddSourceIdChange: (sourceId: number | null) => void;
  onRowChange: (index: number, row: CallsignDraftRow) => void;
  onAppendRow: () => void;
  onRemoveRow: (index: number) => void;
  onClearRows: () => void;
  onApplyPastedRows: (value: string) => void;
  onSubmit: () => void;
};

export function AddCallsignsDrawer({
  open,
  onClose,
  units,
  sources,
  addUnitId,
  addSourceId,
  rows,
  submitting,
  disabled,
  validationError,
  duplicateHints,
  onAddUnitIdChange,
  onAddSourceIdChange,
  onRowChange,
  onAppendRow,
  onRemoveRow,
  onClearRows,
  onApplyPastedRows,
  onSubmit,
}: Props) {
  const formDisabled = disabled || submitting;
  const hasAtLeastOneCallsign = rows.some((row) => row.callsign.trim() !== '');
  const drawerTitleId = 'callsigns-add-drawer-title';
  const addSourceSelectLabelId = 'callsigns-add-source-label';
  const selectedUnit = units.find((unit) => unit.id === addUnitId) ?? null;
  const [unitSearchInput, setUnitSearchInput] = React.useState('');
  const handleCloseDrawer = React.useCallback(() => {
    setUnitSearchInput('');
    onAddUnitIdChange(null);
    onClose();
  }, [onAddUnitIdChange, onClose]);

  const filterUnits = React.useCallback((options: Unit[], inputValue: string) => {
    const normalizedInput = inputValue.toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ').trim();
    if (normalizedInput === '') return options;

    const searchTokens = normalizedInput.split(' ');
    return options.filter((unit) => {
      const unitName = unit.name.toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ').trim();
      const unitId = String(unit.id);
      return searchTokens.every((token) => unitName.includes(token) || unitId.includes(token));
    });
  }, []);

  React.useEffect(() => {
    if (!open) {
      setUnitSearchInput('');
      onAddUnitIdChange(null);
    }
  }, [open, onAddUnitIdChange]);

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={submitting ? undefined : handleCloseDrawer}
      ModalProps={{
        BackdropProps: {
          sx: (theme) => pageDrawerBackdropSx(theme),
        },
      }}
      PaperProps={{
        'aria-labelledby': drawerTitleId,
        sx: {
          width: { xs: '100vw', sm: 640 },
          maxWidth: '100vw',
          display: 'flex',
          backgroundColor: 'background.default',
          backgroundImage: 'none',
        },
      }}
    >
      <Box sx={{ p: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="h6" id={drawerTitleId}>
          Додати позивні
        </Typography>
      </Box>
      <Box sx={{ p: 2.5, flex: 1, overflowY: 'auto' }}>
        <Stack spacing={2.5}>
          {validationError ? <Alert severity="error">{validationError}</Alert> : null}
          {duplicateHints.length > 0 ? (
            <Alert severity="warning">
              <Stack spacing={0.5}>
                <Typography variant="body2" fontWeight={600}>
                  Можливо, такий позивний вже існує:
                </Typography>
                {duplicateHints.map((item) => (
                  <Typography key={item.id} variant="caption" sx={{ display: 'block' }}>
                    {item.callsign} | {item.position || '—'} | {item.unitName} | {item.comment || '—'}
                  </Typography>
                ))}
              </Stack>
            </Alert>
          ) : null}

          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            <Autocomplete
              sx={{ flex: 1 }}
              size="small"
              options={units}
              value={selectedUnit}
              inputValue={unitSearchInput}
              onInputChange={(_, value) => setUnitSearchInput(value)}
              onChange={(_, value) => onAddUnitIdChange(value?.id ?? null)}
              disabled={formDisabled}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              getOptionLabel={(unit) => unit.name.trim() || `#${unit.id}`}
              filterOptions={(options, state) => filterUnits(options, state.inputValue)}
              clearOnBlur={false}
              noOptionsText="Нічого не знайдено"
              renderInput={(params) => (
                <TextField {...params} label="Підрозділ" placeholder="Пошук підрозділу" required />
              )}
            />

            <FormControl sx={{ flex: 1 }} size="small" disabled={formDisabled}>
              <InputLabel id={addSourceSelectLabelId} shrink>
                Джерело
              </InputLabel>
              <Select
                labelId={addSourceSelectLabelId}
                label="Джерело"
                fullWidth
                displayEmpty
                value={addSourceId ?? ''}
                onChange={(event) => {
                  const raw = event.target.value;
                  onAddSourceIdChange(raw === '' ? null : Number(raw));
                }}
              >
                <MenuItem value="">
                  Оберіть джерело
                </MenuItem>
                {sources.map((source) => (
                  <MenuItem key={source.id} value={source.id}>
                    {source.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>

          <Typography variant="body2" color="text.secondary">
            Підтримується вставка табличних даних (TSV: позивний, посада, коментар)
          </Typography>

          <TextField
            label="Швидка вставка TSV"
            placeholder="Пакетно вставте рядки: позивний<TAB>посада<TAB>коментар"
            multiline
            minRows={2}
            onChange={(event) => onApplyPastedRows(event.target.value)}
            disabled={formDisabled}
            InputProps={{
              endAdornment: <UploadFileIcon fontSize="small" color="action" aria-hidden="true" focusable="false" />,
            }}
          />

          <Stack direction="row" spacing={1}>
            <Button size="small" startIcon={<AddIcon />} onClick={onAppendRow} disabled={formDisabled} sx={{ px: '9px' }}>
              Рядок
            </Button>
            <Button size="small" startIcon={<ClearAllIcon />} onClick={onClearRows} disabled={formDisabled} sx={{ px: '9px' }}>
              Очистити
            </Button>
          </Stack>

          <Stack spacing={2} divider={<Divider flexItem />}>
            {rows.map((row, index) => (
              <Stack key={index} spacing={1.5}>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography variant="subtitle2">{`Рядок ${index + 1}`}</Typography>
                  {rows.length > 1 ? (
                    <Tooltip title="Видалити рядок">
                      <span>
                        <IconButton
                          size="small"
                          onClick={() => onRemoveRow(index)}
                          disabled={formDisabled}
                          aria-label={`Видалити рядок ${index + 1}`}
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  ) : null}
                </Stack>
                <CallsignFormFields value={row} onChange={(next) => onRowChange(index, next)} disabled={formDisabled} compact />
              </Stack>
            ))}
          </Stack>
        </Stack>
      </Box>
      <Box sx={{ p: 2.5, borderTop: '1px solid', borderColor: 'divider', display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
        <Button onClick={handleCloseDrawer} disabled={submitting}>
          Скасувати
        </Button>
        <Button
          variant="contained"
          onClick={onSubmit}
          disabled={formDisabled || addUnitId == null || !hasAtLeastOneCallsign}
        >
          {submitting ? 'Збереження…' : 'Додати'}
        </Button>
      </Box>
    </Drawer>
  );
}
