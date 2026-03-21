import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import SaveOutlinedIcon from '@mui/icons-material/SaveOutlined';
import {
  Button,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import React from 'react';

import type { CallsignInfoRes, Network, SummaryTableFreqRow, Unit } from '../../../../../Bindings';
import { PowerChip } from '../../../components/PowerChip';
import { formatCallsignHintTooltip, getCallsignHintResult } from '../callsign-hints';

type Props = {
  callsignInfoMap: Record<string, CallsignInfoRes>;
  networkDisplayMap: Record<number, string>;
  networks: Network[];
  onDownloadGeojson: () => void;
  onDownloadKmz: () => void;
  onDownloadXlsx: () => void;
  onRenameUnit: (freq: string, unit: string, unitNew: string) => Promise<void>;
  onSelectFreq: (freq: string) => void;
  onShowFreqOnMap: (freq: string) => void;
  rows: SummaryTableFreqRow[];
  unitsMap: Record<number, Unit>;
};

function freqNetworks(freq: string, networks: Network[]): Network[] {
  return networks.filter((network) => network.freqs.some((item) => item.freq === freq));
}

export function AnalysisSummaryTableCard({
  callsignInfoMap,
  networkDisplayMap,
  networks,
  onDownloadGeojson,
  onDownloadKmz,
  onDownloadXlsx,
  onRenameUnit,
  onSelectFreq,
  onShowFreqOnMap,
  rows,
  unitsMap,
}: Props) {
  const headingId = React.useId().replace(/:/g, '-');
  const [editingKey, setEditingKey] = React.useState<string | null>(null);
  const [editingValue, setEditingValue] = React.useState('');
  const [savingKey, setSavingKey] = React.useState<string | null>(null);

  const startEdit = React.useCallback((freq: string, unit: string) => {
    setEditingKey(`${freq}::${unit}`);
    setEditingValue(unit);
  }, []);

  const stopEdit = React.useCallback(() => {
    setEditingKey(null);
    setEditingValue('');
  }, []);

  const saveEdit = React.useCallback(
    async (freq: string, unit: string) => {
      const nextValue = editingValue.trim();
      if (!nextValue || nextValue === unit) {
        stopEdit();
        return;
      }
      const key = `${freq}::${unit}`;
      setSavingKey(key);
      try {
        await onRenameUnit(freq, unit, nextValue);
        stopEdit();
      } finally {
        setSavingKey(null);
      }
    },
    [editingValue, onRenameUnit, stopEdit],
  );

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1.5} sx={{ mb: 1.5 }}>
        <Typography id={headingId} variant="subtitle2" component="h2">
          Зведена таблиця
        </Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap">
          <Button size="small" startIcon={<DownloadOutlinedIcon />} onClick={onDownloadXlsx}>
            XLSX
          </Button>
          <Button size="small" startIcon={<DownloadOutlinedIcon />} onClick={onDownloadKmz}>
            KMZ
          </Button>
          <Button size="small" startIcon={<DownloadOutlinedIcon />} onClick={onDownloadGeojson}>
            GeoJSON
          </Button>
        </Stack>
      </Stack>
      <TableContainer sx={{ maxHeight: 420 }}>
        <Table size="small" stickyHeader aria-label="Зведена таблиця аналізу">
          <TableHead>
            <TableRow>
              <TableCell>Частота</TableCell>
              <TableCell align="right">К-сть</TableCell>
              <TableCell>Координати</TableCell>
              <TableCell>Позивні</TableCell>
              <TableCell>Підрозділи</TableCell>
              <TableCell>Локації</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6}>Немає даних</TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const linkedNetworks = freqNetworks(row.freq, networks);
                const sortedCallsigns = row.callsigns
                  .map((callsign, index) => ({
                    callsign,
                    index,
                    hint: getCallsignHintResult({
                      hintContext: 'frequency',
                      freq: row.freq,
                      networks,
                      unitsMap,
                      callsignInfoMap,
                      callsign,
                    }),
                  }))
                  .sort((left, right) => {
                    const leftPriority = left.hint.prioritizedCallsigns.length > 0 ? 0 : 1;
                    const rightPriority = right.hint.prioritizedCallsigns.length > 0 ? 0 : 1;
                    return leftPriority - rightPriority || left.index - right.index;
                  });

                return (
                  <TableRow key={row.freq} hover sx={{ verticalAlign: 'top' }}>
                    <TableCell sx={{ minWidth: 180 }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {row.freq}
                      </Typography>
                      <Stack direction="row" spacing={0.5} sx={{ mt: 0.75 }}>
                        <Button size="small" startIcon={<FilterAltOutlinedIcon />} onClick={() => onSelectFreq(row.freq)}>
                          У фільтр
                        </Button>
                        <Button size="small" startIcon={<MapOutlinedIcon />} onClick={() => onShowFreqOnMap(row.freq)}>
                          На мапі
                        </Button>
                      </Stack>
                    </TableCell>
                    <TableCell align="right">{row.count}</TableCell>
                    <TableCell sx={{ minWidth: 180 }}>
                      <Stack spacing={0.5}>
                        {row.localityCoords.length === 0 ? (
                          <Typography variant="body2" color="text.secondary">
                            —
                          </Typography>
                        ) : (
                          row.localityCoords.map((item, index) => (
                            <Typography key={`${row.freq}-locality-${index}-${item.locality}`} variant="body2">
                              {item.locality.split(',')[0]}
                            </Typography>
                          ))
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell sx={{ minWidth: 220 }}>
                      <Stack direction="row" gap={0.5} flexWrap="wrap">
                        {sortedCallsigns.length === 0
                          ? '—'
                          : sortedCallsigns.map(({ callsign, hint }) => {
                              const tooltip = formatCallsignHintTooltip(hint);
                              const chip = (
                                <PowerChip
                                  label={
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                      {tooltip && hint.iconClass ? <i className={`bi ${hint.iconClass}`} /> : null}
                                      <span>{callsign.toUpperCase()}</span>
                                    </span>
                                  }
                                  size="small"
                                  color={tooltip ? 'primary' : 'default'}
                                  selected={Boolean(tooltip)}
                                />
                              );
                              return tooltip ? (
                                <Tooltip key={`${row.freq}-${callsign}`} title={tooltip} placement="top">
                                  <span>{chip}</span>
                                </Tooltip>
                              ) : (
                                <React.Fragment key={`${row.freq}-${callsign}`}>{chip}</React.Fragment>
                              );
                            })}
                      </Stack>
                    </TableCell>
                    <TableCell sx={{ minWidth: 320 }}>
                      <Stack spacing={0.5}>
                        {linkedNetworks.map((network) => (
                          <Typography key={`${row.freq}-network-${network.id}`} variant="body2">
                            {networkDisplayMap[network.id] ?? `р/м ${network.name}`}
                          </Typography>
                        ))}
                        {row.units.map((unit) => {
                          const editKey = `${row.freq}::${unit}`;
                          const isEditing = editingKey === editKey;
                          const isSaving = savingKey === editKey;
                          return (
                            <Stack key={`${row.freq}-unit-${unit}`} direction="row" spacing={1} alignItems="center">
                              {isEditing ? (
                                <>
                                  <TextField
                                    size="small"
                                    fullWidth
                                    aria-label={`Нова назва підрозділу для частоти ${row.freq}`}
                                    value={editingValue}
                                    onChange={(event) => setEditingValue(event.target.value)}
                                  />
                                  <IconButton
                                    size="small"
                                    aria-label={`Зберегти нову назву підрозділу ${unit} для частоти ${row.freq}`}
                                    onClick={() => void saveEdit(row.freq, unit)}
                                    disabled={isSaving}
                                  >
                                    <SaveOutlinedIcon fontSize="small" />
                                  </IconButton>
                                  <Button size="small" onClick={stopEdit} disabled={isSaving}>
                                    Скасувати
                                  </Button>
                                </>
                              ) : (
                                <>
                                  <Typography variant="body2">{unit}</Typography>
                                  <IconButton size="small" aria-label={`Редагувати назву підрозділу ${unit} для частоти ${row.freq}`} onClick={() => startEdit(row.freq, unit)}>
                                    <EditOutlinedIcon fontSize="small" />
                                  </IconButton>
                                </>
                              )}
                            </Stack>
                          );
                        })}
                        {linkedNetworks.length === 0 && row.units.length === 0 ? (
                          <Typography variant="body2" color="text.secondary">
                            —
                          </Typography>
                        ) : null}
                      </Stack>
                    </TableCell>
                    <TableCell sx={{ minWidth: 180 }}>
                      <Stack spacing={0.5}>
                        {row.locations.length === 0 ? (
                          <Typography variant="body2" color="text.secondary">
                            —
                          </Typography>
                        ) : (
                          row.locations.map((location, index) => (
                            <Typography key={`${row.freq}-location-${index}-${location}`} variant="body2">
                              {location}
                            </Typography>
                          ))
                        )}
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}
