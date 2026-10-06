import { useRadioFeatures } from '../../shared/RadioFeatures';
import type {
  AnalysisCallsignFrequencyMatchesRsp,
  AnalysisStatsReq,
} from '../../../../../Bindings';
import { AnalysisCallsignFrequencySearch } from './AnalysisCallsignFrequencySearch';
import { Box, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCallsignPage } from '../use-callsign-page';
import {
  normalizeCallsignFilterValues,
  normalizeCallsignLookupValue,
} from '../../../utils/callsign-normalization';

type Props = {
  analysisReq: AnalysisStatsReq | null;
  onClearCallsign: () => void;
  onAddCallsign: (callsigns: string[]) => void;
  onAddFreq: (freq: string) => void;
  onRemoveCallsign: (callsigns: string[]) => void;
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
  onRemoveCallsign,
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
  const selectedValues = useMemo(
    () => new Set(normalizeCallsignFilterValues(selectedCallsigns)),
    [selectedCallsigns],
  );
  const selectedMetadataRef = useRef<Record<string, { label: string; values: string[] }>>({});
  const [selectedGroups, setSelectedGroups] = useState<Array<{ label: string; values: string[] }>>(
    [],
  );

  useEffect(() => {
    const next: Record<string, { label: string; values: string[] }> = {};
    for (const selected of selectedValues) {
      next[selected] = selectedMetadataRef.current[selected] ?? {
        label: selected,
        values: [selected],
      };
    }
    for (const entry of page.entries) {
      const key = normalizeCallsignLookupValue(entry.value);
      if (selectedValues.has(key)) {
        next[key] = { label: entry.label, values: entry.values };
      }
    }
    selectedMetadataRef.current = next;
    setSelectedGroups(Object.values(next));
  }, [page.entries, selectedCallsigns, selectedValues]);
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
        {selectedGroups.length > 0 ? (
          <Stack spacing={0.5} sx={{ mb: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Вибрані позивні
            </Typography>
            <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">
              {selectedGroups.map((group) => (
                <Button
                  key={normalizeCallsignLookupValue(group.values[0] ?? group.label)}
                  size="small"
                  onClick={() => onRemoveCallsign(group.values)}
                >
                  {group.label} ×
                </Button>
              ))}
            </Stack>
          </Stack>
        ) : null}
        {error ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography color="error">{error}</Typography>
            <Button disabled={!page.canRetry || page.loading} onClick={() => void page.retry()}>
              Повторити
            </Button>
          </Stack>
        ) : null}
        {page.loading && page.entries.length === 0 ? <Typography>Завантаження…</Typography> : null}
        {!page.loading && page.entries.length === 0 && !error ? (
          <Typography color="text.secondary">Нічого не знайдено</Typography>
        ) : null}
        <Stack spacing={0.5}>
          {page.entries.map((item) => {
            const selected = item.values
              .map(normalizeCallsignLookupValue)
              .every((value) => selectedValues.has(value));
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
            disabled={page.loading || page.pageIndex === 0}
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
