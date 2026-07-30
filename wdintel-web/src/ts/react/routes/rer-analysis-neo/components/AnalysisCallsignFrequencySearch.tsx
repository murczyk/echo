import AddIcon from '@mui/icons-material/Add';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RemoveIcon from '@mui/icons-material/Remove';
import {
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  Collapse,
  IconButton,
  Paper,
  Stack,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useId, useMemo, useRef, useState } from 'react';

import type {
  AnalysisCallsignFrequencyMatch,
  AnalysisCallsignFrequencyMatchesRsp,
} from '../../../../../Bindings';
import { CompactText, CompactTitle } from '../../../components/CompactTypography';
import { SearchableMultiOptionAutocomplete } from '../../../components/SearchableMultiOptionAutocomplete';
import type { AnalysisFilterOption } from '../types';

const DEFAULT_MIN_MATCHES = 2;
const MIN_MATCHES = 1;
const MAX_MATCHES = 99;

type CallsignOption = {
  id: number;
  label: string;
  value: string;
};

type Props = {
  callsignOptions: AnalysisFilterOption[];
  onAddFreq: (freq: string) => void;
  onSearch: (
    callsigns: string[],
    minMatches: number,
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
  callsignOptions,
  onAddFreq,
  onSearch,
  onToggleFreq,
  selectedFreqs,
}: Props) {
  const headingId = useId().replace(/:/g, '-');
  const [collapsed, setCollapsed] = useState(false);
  const [selectedCallsigns, setSelectedCallsigns] = useState<string[]>([]);
  const [minMatches, setMinMatches] = useState(DEFAULT_MIN_MATCHES);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<AnalysisCallsignFrequencyMatch[] | null>(null);
  const requestIdRef = useRef(0);
  const options = useMemo<CallsignOption[]>(() => {
    const uniqueOptions = new Map<string, string>();
    for (const option of callsignOptions) {
      const value = option.value.trim();
      if (value.length > 0 && !uniqueOptions.has(value)) {
        uniqueOptions.set(value, option.label.trim() || value);
      }
    }
    for (const callsign of selectedCallsigns) {
      if (!uniqueOptions.has(callsign)) uniqueOptions.set(callsign, callsign);
    }
    return Array.from(uniqueOptions, ([value, label], id) => ({ id, label, value }));
  }, [callsignOptions, selectedCallsigns]);
  const selectedIds = selectedCallsigns
    .map((callsign) => options.find((option) => option.value === callsign)?.id)
    .filter((id): id is number => id !== undefined);
  const canSearch = selectedCallsigns.length >= minMatches;

  const search = async () => {
    if (!canSearch || loading) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setResults(null);
    setLoading(true);
    const response = await onSearch(selectedCallsigns, minMatches);
    if (requestId !== requestIdRef.current) return;
    if (response) setResults(response.frequencies);
    setLoading(false);
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
            onValueIdsChange={(valueIds) => {
              setSelectedCallsigns(
                valueIds
                  .map((id) => options.find((option) => option.id === id)?.value)
                  .filter((value): value is string => value !== undefined),
              );
              setResults(null);
            }}
          />
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
                  setResults(null);
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
                  setResults(null);
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
            startIcon={loading ? <CircularProgress color="inherit" size={16} /> : undefined}
          >
            Знайти
          </Button>
          {!canSearch && selectedCallsigns.length > 0 ? (
            <CompactText color="text.secondary">
              {`Оберіть щонайменше ${minMatches} позивні.`}
            </CompactText>
          ) : null}
          {results ? (
            results.length > 0 ? (
              <Stack spacing={1}>
                {results.map((frequency) => (
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
