import { memo, useCallback, useEffect, useState } from 'react';
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
import { CALLSIGN_FORM_HINT, RO_SOURCE_RADIO_FREQ_REQUIRED_ERROR, hasAnyDraftValue } from '../helpers';
import { CallsignFormFields } from './CallsignFormFields';
import type { CallsignDraftRow } from '../types';

type Props = {
  open: boolean;
  onClose: () => void;
  units: Unit[];
  sources: Source[];
  addUnitId: number | null;
  addSourceId: number | null;
  addCallsignAdditionalSourceIds: number[];
  rows: CallsignDraftRow[];
  submitting: boolean;
  disabled: boolean;
  validationError: string | null;
  duplicateHints: Array<{
    id: number;
    callsign: string;
    position: string;
    fullName: string;
    comment: string;
    unitName: string;
  }>;
  onAddUnitIdChange: (unitId: number | null) => void;
  onAddSourceIdChange: (sourceId: number | null) => void;
  onAddCallsignAdditionalSourceIdsChange: (sourceIds: number[]) => void;
  onRowChange: (index: number, row: CallsignDraftRow) => void;
  onAppendRow: () => void;
  onRemoveRow: (index: number) => void;
  onClearRows: () => void;
  onApplyPastedRows: (value: string) => void;
  onSubmit: () => void;
};

type AddCallsignRowSectionProps = {
  row: CallsignDraftRow;
  index: number;
  rowsLength: number;
  formDisabled: boolean;
  onRowChange: (index: number, row: CallsignDraftRow) => void;
  onRemoveRow: (index: number) => void;
};

const AddCallsignRowSection = memo(function AddCallsignRowSection({
  row,
  index,
  rowsLength,
  formDisabled,
  onRowChange,
  onRemoveRow,
}: AddCallsignRowSectionProps) {
  const handleRowChange = useCallback((next: CallsignDraftRow) => {
    onRowChange(index, next);
  }, [index, onRowChange]);

  const handleRemoveRow = useCallback(() => {
    onRemoveRow(index);
  }, [index, onRemoveRow]);

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="subtitle2">{`Рядок ${index + 1}`}</Typography>
        {rowsLength > 1 ? (
          <Tooltip title="Видалити рядок">
            <span>
              <IconButton
                size="small"
                onClick={handleRemoveRow}
                disabled={formDisabled}
                aria-label={`Видалити рядок ${index + 1}`}
              >
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        ) : null}
      </Stack>
      <CallsignFormFields value={row} onChange={handleRowChange} disabled={formDisabled} compact />
    </Stack>
  );
}, (prev, next) => (
  prev.row === next.row
  && prev.index === next.index
  && prev.rowsLength === next.rowsLength
  && prev.formDisabled === next.formDisabled
));

export function AddCallsignsDrawer({
  open,
  onClose,
  units,
  sources,
  addUnitId,
  addSourceId,
  addCallsignAdditionalSourceIds,
  rows,
  submitting,
  disabled,
  validationError,
  duplicateHints,
  onAddUnitIdChange,
  onAddSourceIdChange,
  onAddCallsignAdditionalSourceIdsChange,
  onRowChange,
  onAppendRow,
  onRemoveRow,
  onClearRows,
  onApplyPastedRows,
  onSubmit,
}: Props) {
  const formDisabled = disabled || submitting;
  const hasDraftContent = rows.some((row) => hasAnyDraftValue(row));
  const drawerTitleId = 'callsigns-add-drawer-title';
  const addSourceSelectLabelId = 'callsigns-add-source-label';
  const selectedUnit = units.find((unit) => unit.id === addUnitId) ?? null;
  const confirmationSources = sources.filter((source) => source.id !== addSourceId);
  const [unitSearchInput, setUnitSearchInput] = useState('');
  const [pastedInput, setPastedInput] = useState('');
  const handleClearRows = useCallback(() => {
    setPastedInput('');
    onClearRows();
  }, [onClearRows]);
  const handleCloseDrawer = useCallback(() => {
    setUnitSearchInput('');
    setPastedInput('');
    onClose();
  }, [onClose]);

  const filterUnits = useCallback((options: Unit[], inputValue: string) => {
    const normalizedInput = inputValue.toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ').trim();
    if (normalizedInput === '') return options;

    const searchTokens = normalizedInput.split(' ');
    return options.filter((unit) => {
      const unitName = unit.name.toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ').trim();
      const unitId = String(unit.id);
      return searchTokens.every((token) => unitName.includes(token) || unitId.includes(token));
    });
  }, []);

  useEffect(() => {
    if (!open) {
      setUnitSearchInput('');
      setPastedInput('');
    }
  }, [open]);

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
                    {item.callsign || '—'} | {item.position || '—'} | {item.fullName || '—'} | {item.unitName} | {item.comment || '—'}
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
              renderOption={(props, unit) => {
                const { key: _ignoredKey, ...optionProps } = props;
                return (
                  <li {...optionProps} key={unit.id}>
                    {unit.name.trim() || ("#" + unit.id)}
                  </li>
                );
              }}
              clearOnBlur={false}
              noOptionsText="Нічого не знайдено"
              renderInput={(params) => (
                <TextField {...params} label="Підрозділ" placeholder="Пошук підрозділу" required />
              )}
            />

            <FormControl sx={{ flex: 1 }} size="small" disabled={formDisabled}>
              <InputLabel id={addSourceSelectLabelId} shrink>
                Основне джерело
              </InputLabel>
              <Select
                labelId={addSourceSelectLabelId}
                label="Основне джерело"
                fullWidth
                displayEmpty
                value={addSourceId ?? ''}
                onChange={(event) => {
                  const raw = event.target.value;
                  const nextSourceId = raw === '' ? null : Number(raw);
                  onAddSourceIdChange(nextSourceId);
                  onAddCallsignAdditionalSourceIdsChange(addCallsignAdditionalSourceIds.filter((sourceId) => sourceId !== nextSourceId));
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

          <FormControl fullWidth size="small" disabled={formDisabled}>
            <InputLabel id="callsigns-add-confirmation-sources-label">Підтвердження</InputLabel>
            <Select
              labelId="callsigns-add-confirmation-sources-label"
              label="Підтвердження"
              multiple
              value={addCallsignAdditionalSourceIds}
              onChange={(event) => {
                const value = event.target.value;
                onAddCallsignAdditionalSourceIdsChange(typeof value === 'string' ? value.split(',').map(Number) : value.map(Number));
              }}
              renderValue={(selected) => {
                const names = selected
                  .map((sourceId) => sources.find((source) => source.id === Number(sourceId))?.name ?? `#${sourceId}`);
                return names.length > 0 ? names.join(', ') : 'Оберіть підтвердження';
              }}
            >
              {confirmationSources.map((source) => (
                <MenuItem key={source.id} value={source.id}>
                  {source.name}
                </MenuItem>
              ))}
            </Select>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, ml: 0 }}>
              Додаткові джерела підтвердження для всіх рядків цього набору.
            </Typography>
          </FormControl>
          <TextField
            label="Швидка вставка TSV"
            placeholder={'TSV: "позивний<TAB>посада<TAB>коментар" або "позивний<TAB>посада<TAB>ПІП<TAB>коментар"'}
            value={pastedInput}
            size="small"
            multiline
            minRows={1}
            maxRows={6}
            onChange={(event) => {
              const value = event.target.value;
              setPastedInput(value);
              onApplyPastedRows(value);
            }}
            disabled={formDisabled}
            InputProps={{
              endAdornment: <UploadFileIcon fontSize="small" color="action" aria-hidden="true" focusable="false" />,
            }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ mt: -1, ml: 0 }}>
            Підтримуються лише формати: "позивний&lt;TAB&gt;посада&lt;TAB&gt;коментар" або "позивний&lt;TAB&gt;посада&lt;TAB&gt;ПІП&lt;TAB&gt;коментар".
          </Typography>

          <Stack direction={{ xs: "column", sm: "row-reverse" }} spacing={1.5} justifyContent="space-between" alignItems={{ xs: "flex-start", sm: "center" }}>
            <Stack direction="row" spacing={1}>
              <Button size="small" startIcon={<ClearAllIcon />} onClick={handleClearRows} disabled={formDisabled} sx={{ px: '9px' }}>
                Очистити
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ textAlign: { xs: "left", sm: "left" } }}>
              {CALLSIGN_FORM_HINT}
              {addSourceId === 2 ? ` ${RO_SOURCE_RADIO_FREQ_REQUIRED_ERROR}` : ''}
            </Typography>
          </Stack>

          <Stack spacing={2} divider={<Divider flexItem />}>
            {rows.map((row, index) => (
              <AddCallsignRowSection
                key={index}
                row={row}
                index={index}
                rowsLength={rows.length}
                formDisabled={formDisabled}
                onRowChange={onRowChange}
                onRemoveRow={onRemoveRow}
              />
            ))}
          </Stack>

          <Stack direction="row" justifyContent="flex-start">
            <Button size="small" startIcon={<AddIcon />} onClick={onAppendRow} disabled={formDisabled} sx={{ px: '9px' }}>
              Рядок
            </Button>
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
          disabled={formDisabled || addUnitId == null || !hasDraftContent}
        >
          {submitting ? 'Збереження…' : 'Додати'}
        </Button>
      </Box>
    </Drawer>
  );
}
