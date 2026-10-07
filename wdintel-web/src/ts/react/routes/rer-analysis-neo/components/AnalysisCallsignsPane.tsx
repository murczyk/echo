import { useRadioFeatures } from '../../shared/RadioFeatures';
import type {
  AnalysisCallsignFrequencyMatchesRsp,
  AnalysisStatsReq,
} from '../../../../../Bindings';
import { AnalysisCallsignFrequencySearch } from './AnalysisCallsignFrequencySearch';
import AddIcon from '@mui/icons-material/Add';
import ClearIcon from '@mui/icons-material/Clear';
import {
  Box,
  Button,
  CircularProgress,
  InputAdornment,
  Paper,
  Skeleton,
  Stack,
  TablePagination,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCallsignPage } from '../use-callsign-page';
import { PowerIconButton } from '../../../components/PowerIconButton';
import { PowerChip } from '../../../components/PowerChip';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';
import { SectionLoadingOverlay } from '../../../components/SectionLoadingOverlay';
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
    signal?: AbortSignal,
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
  const { notify } = useOptionalPowerSnackbar();
  const notifyCallsignLoadError = useCallback(
    (loadError: unknown) => {
      notify({
        severity: 'error',
        message:
          loadError instanceof Error && loadError.message
            ? loadError.message
            : 'Не вдалося завантажити позивні.',
      });
    },
    [notify],
  );
  const page = useCallsignPage({
    active: true,
    analysisReq,
    onError: notifyCallsignLoadError,
  });
  const error =
    page.error instanceof Error
      ? page.error.message
      : page.error
        ? 'Не вдалося завантажити позивні.'
        : null;
  const failedNavigation =
    page.failedPageIndex == null || page.failedPageIndex === page.pageIndex
      ? null
      : page.failedPageIndex === 0
        ? 'Не вдалося завантажити першу сторінку позивних.'
        : page.failedPageIndex > page.pageIndex
          ? 'Не вдалося завантажити наступну сторінку позивних.'
          : 'Не вдалося завантажити попередню сторінку позивних.';
  const displayedEntries = page.stale ? page.snapshotEntries : page.entries;
  const displayedPageIndex = page.snapshotPageIndex ?? page.pageIndex;
  const displayedRange = `${displayedPageIndex * 50 + 1}–${displayedPageIndex * 50 + displayedEntries.length} позивних`;
  const activeProgress = page.pending;
  const interactionsBlocked = activeProgress || page.stale;
  const showInitialSkeleton = !page.hasLoadedOnce && page.pending;
  const showEmptyState =
    page.hasLoadedOnce &&
    !page.stale &&
    !activeProgress &&
    page.entries.length === 0 &&
    error == null;
  const emptyState =
    page.query.trim() === ''
      ? 'У поточній області аналізу немає позивних.'
      : 'За вашим запитом позивних не знайдено.';
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
    for (const entry of displayedEntries) {
      const key = normalizeCallsignLookupValue(entry.value);
      if (selectedValues.has(key)) {
        next[key] = { label: entry.label, values: entry.values };
      }
    }
    selectedMetadataRef.current = next;
    setSelectedGroups(Object.values(next));
  }, [displayedEntries, selectedCallsigns, selectedValues]);
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
          slotProps={{
            input: {
              endAdornment: page.query ? (
                <InputAdornment position="end">
                  <Tooltip title="Очистити пошук позивного">
                    <PowerIconButton
                      aria-label="Очистити пошук позивного"
                      size="small"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => page.setQuery('')}
                    >
                      <ClearIcon fontSize="small" />
                    </PowerIconButton>
                  </Tooltip>
                </InputAdornment>
              ) : undefined,
            },
          }}
          sx={{ mb: 1 }}
        />
        {selectedGroups.length > 0 ? (
          <Stack spacing={0.5} sx={{ mb: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Вибрані позивні
            </Typography>
            <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">
              {selectedGroups.map((group) => (
                <PowerChip
                  key={normalizeCallsignLookupValue(group.values[0] ?? group.label)}
                  ariaLabel={`Прибрати ${group.label} з фільтра`}
                  label={group.label}
                  title={group.label}
                  onDelete={() => onRemoveCallsign(group.values)}
                  sx={{ maxWidth: '100%', '& .MuiChip-label': { overflowWrap: 'anywhere' } }}
                />
              ))}
            </Stack>
          </Stack>
        ) : null}
        {error ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography color="error">{failedNavigation ?? error}</Typography>
            <Button disabled={!page.canRetry || page.pending} onClick={() => void page.retry()}>
              Повторити
            </Button>
          </Stack>
        ) : null}
        {page.stale && !activeProgress ? (
          <Typography variant="caption" color="text.secondary">
            Показано результати попереднього запиту.
          </Typography>
        ) : null}
        {showInitialSkeleton ? (
          <Stack spacing={0.5} sx={{ py: 1 }} aria-label="Завантаження позивних">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} variant="rounded" height={36} />
            ))}
          </Stack>
        ) : null}
        {showEmptyState ? (
          <Typography color="text.secondary" sx={{ py: 1 }}>
            {emptyState}
          </Typography>
        ) : null}
        <Box
          aria-busy={activeProgress}
          sx={{
            position: 'relative',
            minHeight: activeProgress && displayedEntries.length === 0 ? 72 : 0,
          }}
        >
          <Stack spacing={0.25}>
            {displayedEntries.map((item) => {
              const fullySelected = item.values
                .map(normalizeCallsignLookupValue)
                .every((value) => selectedValues.has(value));
              return (
                <Stack key={item.label} direction="row" spacing={0.5} alignItems="center">
                  <Button
                    color={fullySelected ? 'primary' : 'inherit'}
                    disabled={interactionsBlocked}
                    onClick={() => onToggleCallsign(item.values)}
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      minHeight: 36,
                      justifyContent: 'flex-start',
                      textAlign: 'left',
                    }}
                  >
                    <Typography component="span" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                      {item.label}
                    </Typography>
                    <Typography
                      component="span"
                      variant="caption"
                      color="text.secondary"
                      sx={{ flexShrink: 0, ml: 'auto', pl: 1 }}
                      aria-label={`${item.count} повідомлень`}
                    >
                      {item.count}
                    </Typography>
                  </Button>
                  {!fullySelected ? (
                    <Tooltip title={`Додати ${item.label} до поточного фільтра`}>
                      <span>
                        <PowerIconButton
                          aria-label={`Додати ${item.label} до поточного фільтра`}
                          disabled={interactionsBlocked}
                          onClick={() => onAddCallsign(item.values)}
                        >
                          <AddIcon fontSize="small" />
                        </PowerIconButton>
                      </span>
                    </Tooltip>
                  ) : null}
                </Stack>
              );
            })}
          </Stack>
          <SectionLoadingOverlay
            open={activeProgress && !showInitialSkeleton}
            ariaLabel="Оновлення позивних"
            announce={false}
            showSpinner={displayedEntries.length === 0}
          />
        </Box>
        {displayedEntries.length > 0 ? (
          <Box
            aria-busy={activeProgress}
            sx={{
              position: 'sticky',
              bottom: 0,
              zIndex: 1,
              backgroundColor: 'background.default',
              borderTop: '1px solid',
              borderColor: 'divider',
            }}
          >
            <Stack direction="row" alignItems="center" spacing={0.5}>
              <TablePagination
                component="div"
                count={-1}
                page={page.pageIndex}
                rowsPerPage={50}
                rowsPerPageOptions={[]}
                showFirstButton
                showLastButton={false}
                getItemAriaLabel={(type) =>
                  ({
                    first: 'Перша сторінка позивних',
                    last: 'Остання сторінка позивних',
                    next: 'Наступна сторінка позивних',
                    previous: 'Попередня сторінка позивних',
                  })[type]
                }
                labelDisplayedRows={() => displayedRange}
                labelRowsPerPage=""
                sx={{
                  minHeight: 40,
                  '& .MuiTablePagination-toolbar': {
                    minHeight: 'inherit',
                    px: 0,
                    alignItems: 'center',
                  },
                  '& .MuiTablePagination-displayedRows': { m: 0 },
                }}
                slotProps={{
                  select: { inputProps: { 'aria-label': 'Кількість позивних на сторінці' } },
                  actions: {
                    firstButton: { disabled: interactionsBlocked || page.pageIndex === 0 },
                    previousButton: { disabled: interactionsBlocked || !page.hasPrevious },
                    nextButton: { disabled: interactionsBlocked || !page.hasMore },
                  },
                }}
                onPageChange={(_event, nextPage) => {
                  if (nextPage === 0) void page.loadFirstPage();
                  else if (nextPage < page.pageIndex) void page.loadPreviousPage();
                  else void page.loadNextPage();
                }}
              />
              {activeProgress ? (
                <Box
                  role="status"
                  aria-live="polite"
                  aria-label="Оновлення позивних"
                  sx={{ display: 'flex', alignItems: 'center', pr: 1 }}
                >
                  <CircularProgress size={18} aria-hidden />
                </Box>
              ) : null}
            </Stack>
          </Box>
        ) : null}
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
