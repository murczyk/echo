import AddIcon from '@mui/icons-material/Add';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RemoveIcon from '@mui/icons-material/Remove';
import {
  Box,
  Button,
  ButtonBase,
  Chip,
  Collapse,
  IconButton,
  Paper,
  Skeleton,
  Stack,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type {
  AnalysisCallsignFrequencyMatch,
  AnalysisCallsignFrequencyMatchesRsp,
  AnalysisStatsReq,
} from '../../../../../Bindings';
import { CompactText, CompactTitle } from '../../../components/CompactTypography';
import { SearchableMultiOptionAutocomplete } from '../../../components/SearchableMultiOptionAutocomplete';
import {
  normalizeCallsignFilterValues,
  normalizeCallsignLookupValue,
} from '../../../utils/callsign-normalization';
import { useCallsignPage } from '../use-callsign-page';
import type { AnalysisFilterOption } from '../types';

const DEFAULT_MIN_MATCHES = 2;
const MIN_MATCHES = 1;
const MAX_MATCHES = 99;

function callsignQuantity(value: number) {
  const lastTwoDigits = value % 100;
  const lastDigit = value % 10;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) return 'позивних';
  if (lastDigit === 1) return 'позивний';
  if (lastDigit >= 2 && lastDigit <= 4) return 'позивні';
  return 'позивних';
}

type CallsignOption = {
  id: number;
  label: string;
  value: string;
  values: string[];
};

function stableScopeValue(value: unknown): string {
  if (value == null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableScopeValue).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableScopeValue(entryValue)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

type Props = {
  analysisReq?: AnalysisStatsReq | null;
  callsignOptions?: AnalysisFilterOption[];
  onAddFreq: (freq: string) => void;
  onSearch: (
    callsigns: string[],
    minMatches: number,
    signal?: AbortSignal,
  ) => Promise<AnalysisCallsignFrequencyMatchesRsp | null>;
  onToggleFreq: (freq: string) => void;
  selectedFreqs: readonly string[];
};

function FrequencyMatchCard({
  frequency,
  onAddFreq,
  onToggleFreq,
  selectedFreqs,
}: {
  frequency: AnalysisCallsignFrequencyMatch;
  onAddFreq: (freq: string) => void;
  onToggleFreq: (freq: string) => void;
  selectedFreqs: readonly string[];
}) {
  const selected = selectedFreqs.includes(frequency.freq);
  const canAdd = selectedFreqs.length > 0 && !selected;

  return (
    <Box
      component="article"
      sx={{
        display: 'flex',
        minWidth: 0,
        overflow: 'hidden',
        border: '1px solid',
        borderRadius: 1,
        backgroundColor: (theme) =>
          selected
            ? alpha(theme.palette.primary.main, theme.palette.mode === 'light' ? 0.12 : 0.24)
            : 'background.paper',
        borderColor: selected ? 'primary.main' : 'divider',
      }}
    >
      <ButtonBase
        aria-label={
          selected ? `Прибрати ${frequency.freq} з фільтра` : `Вибрати лише ${frequency.freq}`
        }
        aria-pressed={selected}
        onClick={() => onToggleFreq(frequency.freq)}
        sx={{
          minWidth: 0,
          flex: 1,
          display: 'block',
          px: 1.5,
          py: 1.25,
          color: 'inherit',
          textAlign: 'left',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <CompactTitle
            component="div"
            sx={{ mb: 0.75, textDecoration: 'underline', textUnderlineOffset: '2px' }}
          >
            {frequency.freq}
          </CompactTitle>
          {selected ? (
            <Box component="span" aria-hidden sx={{ ml: 1, fontSize: 22, lineHeight: 1 }}>
              ×
            </Box>
          ) : null}
        </Box>
        <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ mb: 0.75 }}>
          {frequency.callsigns.map((callsign) => (
            <Chip key={callsign} label={callsign} size="small" />
          ))}
        </Stack>
        <CompactText color={selected ? 'inherit' : 'text.secondary'}>
          {`Повідомлень: ${frequency.messageCount}`}
        </CompactText>
      </ButtonBase>
      {canAdd ? (
        <IconButton
          aria-label={`Додати ${frequency.freq} до поточного фільтра`}
          size="small"
          onClick={() => onAddFreq(frequency.freq)}
          sx={{ alignSelf: 'flex-start', mt: 0.75, mr: 0.75 }}
        >
          <AddIcon fontSize="small" />
        </IconButton>
      ) : null}
    </Box>
  );
}

export function AnalysisCallsignFrequencySearch({
  analysisReq = null,
  callsignOptions = [],
  onAddFreq,
  onSearch,
  onToggleFreq,
  selectedFreqs,
}: Props) {
  const headingId = useId().replace(/:/g, '-');
  const [collapsed, setCollapsed] = useState(true);
  const [selectedCallsigns, setSelectedCallsigns] = useState<string[]>([]);
  const selectedValuesRef = useRef<Record<string, string[]>>({});
  const [minMatches, setMinMatches] = useState(DEFAULT_MIN_MATCHES);
  const [loadingScope, setLoadingScope] = useState<string | null>(null);
  const [results, setResults] = useState<AnalysisCallsignFrequencyMatch[] | null>(null);
  const [resultsScope, setResultsScope] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const suggestions = useCallsignPage({
    active: !collapsed,
    analysisReq,
    onError: () => undefined,
  });
  const suggestionError =
    suggestions.error instanceof Error
      ? suggestions.error.message
      : suggestions.error
        ? 'Не вдалося завантажити позивні.'
        : null;
  const options = useMemo<CallsignOption[]>(() => {
    const uniqueOptions = new Map<string, string>();
    const optionValues = new Map<string, string[]>();
    for (const entry of [
      ...callsignOptions,
      ...suggestions.entries.map((item) => ({
        value: item.value,
        label: item.label,
        values: item.values,
      })),
    ]) {
      const value = normalizeCallsignLookupValue(entry.value);
      if (value.length > 0 && !uniqueOptions.has(value)) {
        uniqueOptions.set(value, entry.label.trim() || value);
        optionValues.set(value, normalizeCallsignFilterValues(entry.values ?? [entry.value]));
      }
    }
    for (const callsign of selectedCallsigns) {
      const value = normalizeCallsignLookupValue(callsign);
      if (!uniqueOptions.has(value)) {
        uniqueOptions.set(value, callsign);
        optionValues.set(value, selectedValuesRef.current[value] ?? [value]);
      }
    }
    return Array.from(uniqueOptions, ([value, label], id) => ({
      id,
      label,
      value,
      values: optionValues.get(value) ?? [value],
    }));
  }, [callsignOptions, selectedCallsigns, suggestions.entries]);
  const selectedIds = selectedCallsigns
    .map((callsign) => options.find((option) => option.value === callsign)?.id)
    .filter((id): id is number => id !== undefined);
  const canSearch = selectedCallsigns.length >= minMatches;
  const callsignsStillRequired = Math.max(minMatches - selectedCallsigns.length, 0);
  const suggestionNoOptionsText = suggestionError
    ? 'Не вдалося завантажити позивні.'
    : suggestions.query.trim() === ''
      ? 'Введіть позивний для пошуку.'
      : 'За вашим запитом позивних не знайдено.';
  const selectedCallsignValues = normalizeCallsignFilterValues(
    selectedCallsigns.flatMap(
      (callsign) =>
        options.find((option) => option.value === callsign)?.values ??
        selectedValuesRef.current[callsign] ?? [callsign],
    ),
  );
  const matchingScope = useMemo(
    () =>
      stableScopeValue({
        analysisReq,
        callsigns: selectedCallsignValues,
        minMatches,
      }),
    [analysisReq, minMatches, selectedCallsignValues],
  );
  const matchingScopeRef = useRef(matchingScope);
  matchingScopeRef.current = matchingScope;
  const loading = loadingScope === matchingScope;
  const visibleResults = resultsScope === matchingScope ? results : null;

  useLayoutEffect(() => {
    requestIdRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    setLoadingScope(null);
    setResults(null);
    setResultsScope(null);
    return () => {
      requestIdRef.current += 1;
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
    };
  }, [matchingScope]);

  const search = async () => {
    if (!canSearch || loading) return;
    const requestId = requestIdRef.current + 1;
    const abortController = new AbortController();
    requestIdRef.current = requestId;
    requestAbortRef.current?.abort();
    requestAbortRef.current = abortController;
    setResults(null);
    setResultsScope(null);
    setLoadingScope(matchingScope);
    const response = await onSearch(selectedCallsignValues, minMatches, abortController.signal);
    if (requestId !== requestIdRef.current || matchingScopeRef.current !== matchingScope) return;
    requestAbortRef.current = null;
    if (response) {
      setResults(response.frequencies);
      setResultsScope(matchingScope);
    }
    setLoadingScope(null);
  };

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          mb: collapsed ? 0 : 1.5,
        }}
      >
        <CompactTitle id={headingId} component="h2">
          Пошук частот
        </CompactTitle>
        <IconButton
          size="small"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Розгорнути Пошук частот' : 'Згорнути Пошук частот'}
          onClick={() => setCollapsed((current) => !current)}
        >
          {collapsed ? <ExpandMoreIcon fontSize="small" /> : <ExpandLessIcon fontSize="small" />}
        </IconButton>
      </Box>
      <Collapse in={!collapsed} unmountOnExit>
        <Stack spacing={1.5}>
          <SearchableMultiOptionAutocomplete
            label="Позивні"
            options={options}
            valueIds={selectedIds}
            getOptionLabel={(option) => option.label}
            loading={suggestions.pending}
            loadingText="Завантаження позивних…"
            noOptionsText={suggestionNoOptionsText}
            onInputChange={suggestions.setQuery}
            serverSearch
            onValueIdsChange={(valueIds) => {
              const selected = valueIds
                .map((id) => options.find((option) => option.id === id))
                .filter((option): option is CallsignOption => option !== undefined);
              selectedValuesRef.current = Object.fromEntries(
                selected.map((option) => [option.value, option.values]),
              );
              setSelectedCallsigns(selected.map((option) => option.value));
            }}
          />
          {callsignsStillRequired > 0 ? (
            <CompactText color="text.secondary">
              {`Оберіть ще ${callsignsStillRequired} ${callsignQuantity(callsignsStillRequired)}.`}
            </CompactText>
          ) : null}
          {suggestionError ? (
            <Stack direction="row" spacing={0.5} alignItems="center">
              <CompactText color="error">{suggestionError}</CompactText>
              <Button
                size="small"
                disabled={!suggestions.canRetry || suggestions.pending}
                onClick={() => void suggestions.retry()}
              >
                Повторити
              </Button>
            </Stack>
          ) : null}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto',
              alignItems: 'center',
              gap: 1,
            }}
          >
            <CompactText component="label">Мінімум збігів</CompactText>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: '32px minmax(32px, auto) 32px',
                alignItems: 'center',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 1,
              }}
            >
              <IconButton
                size="small"
                aria-label="Зменшити мінімум збігів"
                disabled={minMatches <= MIN_MATCHES}
                onClick={() => {
                  setMinMatches((current) => Math.max(MIN_MATCHES, current - 1));
                }}
              >
                <RemoveIcon fontSize="small" />
              </IconButton>
              <CompactTitle component="output" sx={{ px: 0.5, textAlign: 'center' }}>
                {minMatches}
              </CompactTitle>
              <IconButton
                size="small"
                aria-label="Збільшити мінімум збігів"
                disabled={minMatches >= MAX_MATCHES}
                onClick={() => {
                  setMinMatches((current) => Math.min(MAX_MATCHES, current + 1));
                }}
              >
                <AddIcon fontSize="small" />
              </IconButton>
            </Box>
          </Box>
          <Button
            variant="contained"
            disabled={!canSearch || loading}
            onClick={() => void search()}
            startIcon={loading ? <Skeleton variant="circular" width={16} height={16} /> : undefined}
          >
            Знайти
          </Button>
          {visibleResults ? (
            visibleResults.length > 0 ? (
              <Stack spacing={1}>
                {visibleResults.map((frequency) => (
                  <FrequencyMatchCard
                    key={frequency.freq}
                    frequency={frequency}
                    onAddFreq={onAddFreq}
                    onToggleFreq={onToggleFreq}
                    selectedFreqs={selectedFreqs}
                  />
                ))}
              </Stack>
            ) : (
              <CompactText color="text.secondary">
                Частот із заданою кількістю збігів не знайдено.
              </CompactText>
            )
          ) : null}
        </Stack>
      </Collapse>
    </Paper>
  );
}
