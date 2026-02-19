import {
  Alert,
  CircularProgress,
  FormControl,
  MenuItem,
  Select,
  SelectChangeEvent,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import React from 'react';

import { Button } from '../../components/mui-customized/button';
import { TableTopToolbar } from '../../components/mui-customized/table/components/table-top-toolbar';
import {
  AorLocationConfigItem,
  listAorLocationConfigs,
  saveAorLocationConfig,
} from '../../services/api/location-config';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

type RowState = AorLocationConfigItem & {
  editedConfigs: string[];
  isSaving: boolean;
  saveError: string | null;
};

function areEqualStringArrays(left: string[], right: string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

export function AdminLocationConfigsNeoPage() {
  const [loadStatus, setLoadStatus] = React.useState<LoadingStatus>('idle');
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [availableConfigs, setAvailableConfigs] = React.useState<string[]>([]);
  const [rows, setRows] = React.useState<RowState[]>([]);

  async function load() {
    setLoadStatus('loading');
    setLoadError(null);
    try {
      const data = await listAorLocationConfigs();
      setAvailableConfigs(data.availableConfigs);
      setRows(
        data.items.map((item) => ({
          ...item,
          editedConfigs: item.selectedConfigs || [],
          isSaving: false,
          saveError: null,
        }))
      );
      setLoadStatus('success');
    } catch (error) {
      setLoadStatus('error');
      setLoadError(formatErrorMessage(error));
    }
  }

  React.useEffect(() => {
    load();
  }, []);

  function onSelectChange(aorId: number, event: SelectChangeEvent<string[]>) {
    const value = event.target.value;
    const selected = typeof value === 'string' ? value.split(',') : value;
    setRows((prev) =>
      prev.map((row) =>
        row.aorId === aorId
          ? {
              ...row,
              editedConfigs: selected,
              saveError: null,
            }
          : row
      )
    );
  }

  async function onSave(row: RowState) {
    setRows((prev) =>
      prev.map((entry) =>
        entry.aorId === row.aorId
          ? {
              ...entry,
              isSaving: true,
              saveError: null,
            }
          : entry
      )
    );

    try {
      const saved = await saveAorLocationConfig(row.aorId, row.editedConfigs);
      setRows((prev) =>
        prev.map((entry) =>
          entry.aorId === row.aorId
            ? {
                ...entry,
                selectedConfigs: saved.selectedConfigs,
                editedConfigs: saved.selectedConfigs,
                isSaving: false,
                saveError: null,
              }
            : entry
        )
      );
    } catch (error) {
      const saveError = formatErrorMessage(error);
      setRows((prev) =>
        prev.map((entry) =>
          entry.aorId === row.aorId
            ? {
                ...entry,
                isSaving: false,
                saveError,
              }
            : entry
        )
      );
    }
  }

  return (
    <div className="mt-2 w-full space-y-4">
      <TableTopToolbar
        header={
          <Typography variant="h5" className="!font-semibold">
            Конфігурації локацій по смугах
          </Typography>
        }
        withDatePicker={false}
        withGlobalTextFilter={false}
      />

      {loadStatus === 'loading' ? (
        <div className="flex items-center justify-center py-12">
          <CircularProgress size={28} />
        </div>
      ) : null}

      {loadStatus === 'error' ? (
        <Alert severity="error">{loadError || 'Помилка завантаження'}</Alert>
      ) : null}

      {loadStatus === 'success' ? (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Смуга</TableCell>
              <TableCell>Конфігурація</TableCell>
              <TableCell width={220}>Дія</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => {
              const isChanged = !areEqualStringArrays(
                row.selectedConfigs || [],
                row.editedConfigs || []
              );
              return (
                <TableRow key={row.aorId}>
                  <TableCell>{row.aorName}</TableCell>
                  <TableCell>
                    <FormControl size="small" fullWidth>
                      <Select
                        multiple
                        value={row.editedConfigs}
                        onChange={(event) => onSelectChange(row.aorId, event)}
                        renderValue={(selected) =>
                          selected.length > 0
                            ? selected.join(', ')
                            : 'За замовчуванням (config.toml)'
                        }
                      >
                        {availableConfigs.map((config) => (
                          <MenuItem value={config} key={config}>
                            {config}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="contained"
                        disabled={!isChanged || row.isSaving}
                        onClick={() => onSave(row)}
                      >
                        {row.isSaving ? 'Збереження...' : 'Зберегти'}
                      </Button>
                      {row.saveError ? (
                        <Typography color="error" variant="caption">
                          {row.saveError}
                        </Typography>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : null}
    </div>
  );
}
