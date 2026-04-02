import { Button, CircularProgress, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { useId } from 'react';

import type { CorrelatedFreq } from '../../../../../Bindings';
import { PowerChip } from '../../../components/PowerChip';

type Props = {
  correlatedFreqs: CorrelatedFreq[];
  loading: boolean;
  onLoad: () => void;
};

export function AnalysisCorrelatedFreqsCard({ correlatedFreqs, loading, onLoad }: Props) {
  const headingId = useId().replace(/:/g, '-');

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.5 }}>
        <Typography id={headingId} variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
          Суміжні частоти
        </Typography>
        <Button size="small" onClick={onLoad} disabled={loading}>
          {loading ? <CircularProgress size={14} /> : 'Завантажити'}
        </Button>
      </Stack>
      {correlatedFreqs.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Немає даних
        </Typography>
      ) : (
        <Table size="small" aria-label="Таблиця суміжних частот">
          <TableHead>
            <TableRow>
              <TableCell>Частота</TableCell>
              <TableCell>Спільні позивні</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {correlatedFreqs.slice(0, 10).map((item) => (
              <TableRow key={item.freq} hover>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>{item.freq}</TableCell>
                <TableCell>
                  <Stack direction="row" gap={0.5} flexWrap="wrap">
                    {item.commonCallsigns.length === 0
                      ? 'Без позивних'
                      : item.commonCallsigns.slice(0, 6).map((callsign) => (
                          <PowerChip key={`${item.freq}-${callsign}`} label={callsign} size="small" color="default" />
                        ))}
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Paper>
  );
}
