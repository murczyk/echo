import { useRadioFeatures } from '../../shared/RadioFeatures';
import type {
  AnalysisCallsignFrequencyMatchesRsp,
  AnalysisStatsReq,
} from '../../../../../Bindings';
import { AnalysisCallsignFrequencySearch } from './AnalysisCallsignFrequencySearch';
import { Box, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import { useCallsignPage } from '../use-callsign-page';

type Props = {
  analysisReq: AnalysisStatsReq | null;
  onClearCallsign: () => void;
  onAddCallsign: (callsigns: string[]) => void;
  onAddFreq: (freq: string) => void;
  selectedCallsigns: readonly string[];
  selectedFreqs: readonly string[];
  onSearchFrequencyMatches: (
    callsigns: string[],
    minMatches: number,
  ) => Promise<AnalysisCallsignFrequencyMatchesRsp | null>;
  onToggleCallsign: (callsigns: string[]) => void;
  onToggleFreq: (freq: string) => void;
};

export function AnalysisCallsignsPane({
  analysisReq,
  onClearCallsign,
  onAddCallsign,
  onAddFreq,
  selectedCallsigns,
  selectedFreqs,
  onSearchFrequencyMatches,
  onToggleCallsign,
  onToggleFreq,
}: Props) {
  const radioFeaturesAllowed = useRadioFeatures();
  const page = useCallsignPage({
    active: true,
    analysisReq,
    onError: () => undefined,
  });
  const error =
    page.error instanceof Error
      ? page.error.message
      : page.error
        ? 'Не вдалося завантажити позивні.'
        : null;
  return (
    <Stack spacing={0}>
      <Paper component="section" variant="outlined" sx={{ p: 2 }}>
        <Typography component="h2" variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
          Позивні
        </Typography>
        <TextField
          fullWidth
          label="Пошук позивного"
          size="small"
          value={page.query}
          onChange={(event) => page.setQuery(event.target.value)}
          sx={{ mb: 1 }}
        />
        {error ? <Typography color="error">{error}</Typography> : null}
        {page.loading && page.entries.length === 0 ? <Typography>Завантаження…</Typography> : null}
        {!page.loading && page.entries.length === 0 && !error ? (
          <Typography color="text.secondary">Нічого не знайдено</Typography>
        ) : null}
        <Stack spacing={0.5}>
          {page.entries.map((item) => {
            const selected = item.values.every((value) => selectedCallsigns.includes(value));
            return (
              <Stack key={item.label} direction="row" spacing={0.5}>
                <Button
                  color={selected ? 'primary' : 'inherit'}
                  onClick={() => onToggleCallsign(item.values)}
                  sx={{ flex: 1, justifyContent: 'space-between' }}
                >
                  <span>{item.label}</span>
                  <span>{item.count}</span>
                </Button>
                <Button
                  aria-label={`Додати ${item.label}`}
                  onClick={() => onAddCallsign(item.values)}
                >
                  +
                </Button>
              </Stack>
            );
          })}
        </Stack>
        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          <Button
            disabled={page.loading || !page.hasPrevious}
            onClick={() => void page.loadFirstPage()}
          >
            Перша
          </Button>
          <Button
            disabled={page.loading || !page.hasPrevious}
            onClick={() => void page.loadPreviousPage()}
          >
            Попередні 50
          </Button>
          <Button disabled={page.loading || !page.hasMore} onClick={() => void page.loadNextPage()}>
            Наступні 50
          </Button>
        </Stack>
        {selectedCallsigns.length > 0 ? (
          <Button onClick={onClearCallsign} sx={{ mt: 1 }}>
            Очистити вибір
          </Button>
        ) : null}
      </Paper>
      <Box sx={{ borderTop: '1px solid', borderColor: 'divider' }}>
        {radioFeaturesAllowed ? (
          <AnalysisCallsignFrequencySearch
            analysisReq={analysisReq}
            onAddFreq={onAddFreq}
            onSearch={onSearchFrequencyMatches}
            onToggleFreq={onToggleFreq}
            selectedFreqs={selectedFreqs}
          />
        ) : null}
      </Box>
    </Stack>
  );
}
