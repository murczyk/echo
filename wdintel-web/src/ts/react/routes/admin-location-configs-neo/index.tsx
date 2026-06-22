import { Card, CardContent, Checkbox, FormControl, ListItemText, MenuItem, Select, SelectChangeEvent, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { useEffect, useState } from 'react';

import { PageLoadingState } from '../../components/PageLoadingState';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { ELLIPSIS } from '../../utils/misc';
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

function formatConfigName(config: string): string {
  return config.split('/').pop() || config;
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
  const [loadStatus, setLoadStatus] = useState<LoadingStatus>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [availableConfigs, setAvailableConfigs] = useState<string[]>([]);
  const [rows, setRows] = useState<RowState[]>([]);

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

  useEffect(() => {
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
    <Card variant="outlined">
      <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
        <div className="flex w-full min-w-0 flex-col gap-6">
          <Typography component="h2" variant="h6" sx={{ m: 0, fontWeight: 600 }}>
            Файли населених пунктів для AOR
          </Typography>

          <Typography color="text.secondary">
            Оберіть один або кілька регіональних JSON-файлів, у яких ECHO шукатиме населені пункти для кожної смуги відповідальності. Порожній вибір використовує набір сервера за замовчуванням.
          </Typography>

          {loadStatus === 'loading' ? (
            <PageLoadingState />
          ) : null}

          {loadStatus === 'error' ? (
            <PowerAlert severity="error">{loadError || 'Помилка завантаження'}</PowerAlert>
          ) : null}

          {loadStatus === 'success' && availableConfigs.length === 0 ? (
            <PowerAlert severity="warning">У каталозі settlements_json немає доступних регіональних файлів.</PowerAlert>
          ) : null}

          {loadStatus === 'success' && availableConfigs.length > 0 ? (
            <Table
              size="small"
              sx={{
                width: '100%',
                tableLayout: 'fixed',
              }}
            >
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: '20%' }}>AOR (смуга відповідальності)</TableCell>
                  <TableCell sx={{ width: '70%' }}>Файли settlements.json</TableCell>
                  <TableCell sx={{ width: '10%' }}>Дія</TableCell>
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
                      <TableCell sx={{ width: '10%' }}>{row.aorName}</TableCell>
                      <TableCell>
                        <FormControl size="small" fullWidth>
                          <Select
                            multiple
                            displayEmpty
                            value={row.editedConfigs}
                            onChange={(event) => onSelectChange(row.aorId, event)}
                            renderValue={(selected) =>
                              selected.length > 0
                                ? selected.map(formatConfigName).join(', ')
                                : 'Набір сервера за замовчуванням'
                            }
                            sx={{
                              '& .MuiSelect-select': {
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              },
                            }}
                          >
                            {availableConfigs.map((config) => (
                              <MenuItem value={config} key={config}>
                                <Checkbox checked={row.editedConfigs.includes(config)} />
                                <ListItemText primary={formatConfigName(config)} />
                              </MenuItem>
                            ))}
                          </Select>
                        </FormControl>
                      </TableCell>
                      <TableCell sx={{ width: '10%' }}>
                        <div className="flex items-center gap-2">
                          <PowerButton
                            variant="contained"
                            disabled={!isChanged || row.isSaving}
                            onClick={() => onSave(row)}
                          >
                            {row.isSaving ? `Збереження${ELLIPSIS}` : 'Зберегти'}
                          </PowerButton>
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
      </CardContent>
    </Card>
  );
}
