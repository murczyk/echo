import {
  CircularProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from '@mui/material';
import { useId } from 'react';

import type { CorrelatedFreq } from '../../../../../Bindings';
import { CompactPowerChip } from '../../../components/CompactPowerChip';
import { CompactText, CompactTitle } from '../../../components/CompactTypography';
import { ELLIPSIS } from '../../../utils/misc';

type Props = {
  correlatedFreqs: CorrelatedFreq[];
  loading: boolean;
  selectedFreq: string | null;
};

export function AnalysisCorrelatedFreqsCard({ correlatedFreqs, loading, selectedFreq }: Props) {
  const headingId = useId().replace(/:/g, '-');

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.5 }}>
        <CompactTitle id={headingId} component="h2">
          Суміжні частоти
        </CompactTitle>
      </Stack>
      {!selectedFreq ? (
        <CompactText color="text.secondary">
          Оберіть частоту вище, щоб завантажити суміжні частоти.
        </CompactText>
      ) : loading ? (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 80 }}>
          <CircularProgress size={18} />
          <CompactText color="text.secondary">
            {`Завантажую суміжні частоти${ELLIPSIS}`}
          </CompactText>
        </Stack>
      ) : correlatedFreqs.length === 0 ? (
        <CompactText color="text.secondary">Немає даних</CompactText>
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
                      : item.commonCallsigns
                          .slice(0, 6)
                          .map((callsign) => (
                            <CompactPowerChip
                              key={`${item.freq}-${callsign}`}
                              label={callsign}
                              size="small"
                              color="default"
                            />
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
