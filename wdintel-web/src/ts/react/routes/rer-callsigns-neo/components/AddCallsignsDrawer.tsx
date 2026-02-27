import AddIcon from '@mui/icons-material/Add';
import ClearAllIcon from '@mui/icons-material/ClearAll';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import {
  Alert,
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
  const hasRowWithEmptyCallsign = rows.some((row) => row.callsign.trim() === '');
  const drawerTitleId = 'callsigns-add-drawer-title';
  const addUnitSelectLabelId = 'callsigns-add-unit-label';
  const addSourceSelectLabelId = 'callsigns-add-source-label';

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={submitting ? undefined : onClose}
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
          <Typography variant="body2" color="text.secondary">
            Підтримується вставка табличних даних (TSV: позивний, посада, коментар)
          </Typography>

          {validationError ? <Alert severity="error">{validationError}</Alert> : null}

          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            <FormControl sx={{ flex: 1 }} size="small" disabled={formDisabled}>
              <InputLabel id={addUnitSelectLabelId} shrink>
                Підрозділ
              </InputLabel>
              <Select
                labelId={addUnitSelectLabelId}
                label="Підрозділ"
                fullWidth
                displayEmpty
                value={addUnitId ?? ''}
                onChange={(event) => {
                  const raw = event.target.value;
                  onAddUnitIdChange(raw === '' ? null : Number(raw));
                }}
              >
                <MenuItem value="">
                  <em>Оберіть підрозділ</em>
                </MenuItem>
                {units.map((unit) => (
                  <MenuItem key={unit.id} value={unit.id}>
                    {unit.name.trim() || `#${unit.id}`}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

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
        <Button onClick={onClose} disabled={submitting}>
          Скасувати
        </Button>
        <Button
          variant="contained"
          onClick={onSubmit}
          disabled={formDisabled || addUnitId == null || !hasAtLeastOneCallsign || hasRowWithEmptyCallsign}
        >
          {submitting ? 'Збереження…' : 'Додати'}
        </Button>
      </Box>
    </Drawer>
  );
}
