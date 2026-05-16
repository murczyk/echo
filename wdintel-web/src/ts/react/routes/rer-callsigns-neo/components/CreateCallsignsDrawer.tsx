import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import AddIcon from '@mui/icons-material/Add';
import ClearAllIcon from '@mui/icons-material/ClearAll';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { isNullOrUndefined } from '../../../utils/misc';
import {
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
import {
  CALLSIGN_FORM_HINT,
  RO_SOURCE_RADIO_FREQ_REQUIRED_ERROR,
  getUnitSelectionError,
  hasAnyDraftValue,
} from '../helpers';
import { CallsignFormFields } from './CallsignFormFields';
import type { CallsignDraftRow, CallsignDuplicateHintGroup } from '../types';
import { PowerAlert } from '../../../components/PowerAlert';
import { filterUnitsBySearch, findExactUnitSearchMatch, getUnitDisplayLabel } from '../../../utils/unit-search';

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
  duplicateHintGroups: CallsignDuplicateHintGroup[];
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

type CreateCallsignRowSectionProps = {
  row: CallsignDraftRow;
  index: number;
  rowsLength: number;
  formDisabled: boolean;
  duplicateHintGroup: CallsignDuplicateHintGroup | null;
  onRowChange: (index: number, row: CallsignDraftRow) => void;
  onRemoveRow: (index: number) => void;
};

const CreateCallsignRowSection = memo(function CreateCallsignRowSection({
  row,
  index,
  rowsLength,
  formDisabled,
  duplicateHintGroup,
  onRowChange,
  onRemoveRow,
}: CreateCallsignRowSectionProps) {
  const handleRowChange = useCallback((next: CallsignDraftRow) => {
    onRowChange(index, next);
  }, [index, onRowChange]);

  const handleRemoveRow = useCallback(() => {
    onRemoveRow(index);
  }, [index, onRemoveRow]);

  const callsignHintContent = duplicateHintGroup ? (
    <>
      <Typography component="span" variant="caption" color="warning.main" fontWeight={600}>
        {duplicateHintGroup.matches.length === 1
          ? 'Схожий існуючий позивний:'
          : `Схожі існуючі позивні: ${duplicateHintGroup.matches.length}`}
      </Typography>
      <br />
      {duplicateHintGroup.matches.slice(0, 2).map((match, matchIndex) => (
        <span key={match.id}>
          <Typography component="span" variant="caption" color="text.secondary">
            {match.callsign} | {match.unitName}
          </Typography>
          {matchIndex < Math.min(duplicateHintGroup.matches.length, 2) - 1 ? <br /> : null}
        </span>
      ))}
      {duplicateHintGroup.matches.length > 2 ? (
        <>
          <br />
          <Typography component="span" variant="caption" color="text.secondary">
            {`+ ${duplicateHintGroup.matches.length - 2} more`}
          </Typography>
        </>
      ) : null}
    </>
  ) : null;

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
      <CallsignFormFields
        value={row}
        onChange={handleRowChange}
        disabled={formDisabled}
        compact
        callsignHintContent={callsignHintContent}
      />
    </Stack>
  );
}, (prev, next) => (
  prev.row === next.row
  && prev.index === next.index
  && prev.rowsLength === next.rowsLength
  && prev.formDisabled === next.formDisabled
  && prev.duplicateHintGroup === next.duplicateHintGroup
));

type DuplicateHintsSummaryProps = {
  duplicateHintGroups: CallsignDuplicateHintGroup[];
};

const DuplicateHintsSummary = memo(function DuplicateHintsSummary({
  duplicateHintGroups,
}: DuplicateHintsSummaryProps) {
  const totalMatches = duplicateHintGroups.reduce((sum, group) => sum + group.matches.length, 0);
  const previewMatches = duplicateHintGroups
    .flatMap((group) => group.matches.map((match) => ({ rowIndex: group.rowIndex, match })))
    .slice(0, 3);
  const hiddenMatches = totalMatches - previewMatches.length;

  return (
    <Box sx={{ position: 'sticky', top: 0, zIndex: (theme) => theme.zIndex.appBar + 1, bgcolor: 'background.paper', pb: 0.5 }}>
      <PowerAlert
        severity="warning"
        autoHideDuration={null}
        dismissible={false}
        sx={{
          bgcolor: 'background.paper',
          backgroundImage: 'none',
          opacity: 1,
          boxShadow: 1,
        }}
      >
        <Stack spacing={0.5}>
          <Typography variant="body2" fontWeight={600}>
            {`Схожі позивні знайдено: ${totalMatches} у ${duplicateHintGroups.length} рядках`}
          </Typography>
          {previewMatches.map(({ rowIndex, match }) => (
            <Typography key={`${rowIndex}-${match.id}`} variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {`Рядок ${rowIndex + 1}: ${match.callsign} | ${match.unitName}`}
            </Typography>
          ))}
          {hiddenMatches > 0 ? (
            <Typography variant="caption" color="text.secondary">
              {`+ ${hiddenMatches} more`}
            </Typography>
          ) : null}
        </Stack>
      </PowerAlert>
    </Box>
  );
});

export function CreateCallsignsDrawer({
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
  duplicateHintGroups,
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
  const drawerTitleId = 'callsigns-create-drawer-title';
  const sourceSelectLabelId = 'callsigns-create-source-label';
  const [unitSearchInput, setUnitSearchInput] = useState('');
  const [pastedInput, setPastedInput] = useState('');
  const selectedUnit = units.find((unit) => unit.id === addUnitId) ?? null;
  const unitSelectionError = getUnitSelectionError(unitSearchInput, selectedUnit);
  const confirmationSources = sources.filter((source) => source.id !== addSourceId);
  const duplicateHintGroupByRowIndex = useMemo(
    () => new Map(duplicateHintGroups.map((group) => [group.rowIndex, group] as const)),
    [duplicateHintGroups],
  );
  const handleClearRows = useCallback(() => {
    setPastedInput('');
    onClearRows();
  }, [onClearRows]);
  const handleCloseDrawer = useCallback(() => {
    setUnitSearchInput('');
    setPastedInput('');
    onClose();
  }, [onClose]);
  const handleUnitInputChange = useCallback((_: unknown, value: string, reason: string) => {
    setUnitSearchInput(value);

    if (reason !== 'input' && reason !== 'clear') return;

    const exactMatch = reason === 'clear' ? null : findExactUnitSearchMatch(units, value);
    onAddUnitIdChange(exactMatch?.id ?? null);
  }, [onAddUnitIdChange, units]);

  const handleUnitBlur = useCallback(() => {
    if (!isNullOrUndefined(addUnitId)) return;

    const exactMatch = findExactUnitSearchMatch(units, unitSearchInput);
    if (!exactMatch) return;

    onAddUnitIdChange(exactMatch.id);
    setUnitSearchInput(getUnitDisplayLabel(exactMatch));
  }, [addUnitId, onAddUnitIdChange, unitSearchInput, units]);

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
      slotProps={{
        paper: {
          'aria-labelledby': drawerTitleId,
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
        <Typography variant="h6" id={drawerTitleId}>
          Додати позивні
        </Typography>
      </Box>
      <Box sx={{ p: 2.5, flex: 1, overflowY: 'auto' }}>
        <Stack spacing={2.5}>
          {validationError ? <PowerAlert severity="error">{validationError}</PowerAlert> : null}
          {duplicateHintGroups.length > 0 ? (
            <DuplicateHintsSummary duplicateHintGroups={duplicateHintGroups} />
          ) : null}

          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            <Autocomplete
              sx={{ flex: 1 }}
              size="small"
              options={units}
              value={selectedUnit}
              inputValue={unitSearchInput}
              onInputChange={handleUnitInputChange}
              onChange={(_, value) => onAddUnitIdChange(value?.id ?? null)}
              disabled={formDisabled}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              getOptionLabel={getUnitDisplayLabel}
              filterOptions={(options, state) => filterUnitsBySearch(options, state.inputValue)}
              renderOption={(props, unit) => {
                const { key: _ignoredKey, ...optionProps } = props;
                return (
                  <li {...optionProps} key={unit.id}>
                    {getUnitDisplayLabel(unit)}
                  </li>
                );
              }}
              clearOnBlur={false}
              noOptionsText="Нічого не знайдено"
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Підрозділ"
                  placeholder="Пошук підрозділу"
                  required
                  error={unitSelectionError !== null}
                  helperText={unitSelectionError ?? 'Почніть вводити назву або оберіть підрозділ зі списку'}
                  onBlur={handleUnitBlur}
                />
              )}
            />

            <FormControl sx={{ flex: 1 }} size="small" disabled={formDisabled}>
              <InputLabel id={sourceSelectLabelId} shrink>
                Основне джерело
              </InputLabel>
              <Select
                labelId={sourceSelectLabelId}
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
            <InputLabel id="callsigns-create-confirmation-sources-label">Підтвердження</InputLabel>
            <Select
              labelId="callsigns-create-confirmation-sources-label"
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
            slotProps={{
              input: {
                endAdornment: <UploadFileIcon fontSize="small" color="action" aria-hidden="true" focusable="false" />,
              },
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
              <CreateCallsignRowSection
                key={index}
                row={row}
                index={index}
                rowsLength={rows.length}
                formDisabled={formDisabled}
                duplicateHintGroup={duplicateHintGroupByRowIndex.get(index) ?? null}
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
          disabled={formDisabled || isNullOrUndefined(addUnitId) || !hasDraftContent}
        >
          {submitting ? 'Збереження…' : 'Додати'}
        </Button>
      </Box>
    </Drawer>
  );
}
