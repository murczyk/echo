import { isUnitParentValue } from '../../shared/unit-children-filter';
import { useRadioFeatures } from '../../shared/RadioFeatures';
import {
  Box,
  Button,
  Checkbox,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import type { MouseEvent } from 'react';
import { useCallback, useMemo } from 'react';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';

import type { AnalysisFilterSectionId } from '../types';
import {
  normalizeCallsignFilterValues,
  normalizeCallsignLookupValue,
} from '../../../utils/callsign-normalization';
import { NO_DATA_LABEL } from '../../../utils/misc';
import { isCanonicalUnitIdValue } from '../../../utils/unit-search';
import { AnalysisFilterField } from './AnalysisFilterField';
import { buildAnalysisReq } from '../helpers';
import { useCallsignPage } from '../use-callsign-page';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';
import type { AnalysisFiltersPanelDerivedData } from './analysis-filters-panel-derived';
import {
  compactCheckboxLabelSx,
  FilterSection,
  type AnalysisFiltersPanelPage,
  type FilterSectionId,
  sectionCountLabel,
} from './analysis-filters-panel-shared';

type Props = Pick<
  AnalysisFiltersPanelPage,
  | 'counts'
  | 'cyberEchoEnabled'
  | 'includeOnlyNewFreqs'
  | 'options'
  | 'queryState'
  | 'setIncludeOnlyNewFreqs'
  | 'updateQueryState'
> & {
  threadOnly?: boolean;
  derived: AnalysisFiltersPanelDerivedData;
  expandedSections: Record<FilterSectionId, boolean>;
  filtersLoading: boolean;
  isFilterSectionLoading: (section: AnalysisFilterSectionId) => boolean;
  isFilterSectionEmptyLoading: (section: AnalysisFilterSectionId, optionCount: number) => boolean;
  isFilterSectionStale: (section: AnalysisFilterSectionId) => boolean;
  loadFilterSection: (section: AnalysisFilterSectionId) => Promise<void>;
  unitsExactMatchOnlyDefault: boolean | null;
  analysisAorFilterEnabled: boolean;
  hideNetworks: boolean;
  hideGroupSelection: boolean;
  rerReportFilterEnabled: boolean;
  toggleSection: (section: FilterSectionId) => void;
};

type FilterSectionLoadTarget = AnalysisFilterSectionId | 'freqs';

// The tags filter has two mutually exclusive modes on a single axis, so they live in
// one ToggleButtonGroup instead of mixing a synthetic list option with a separate toggle:
//   include  → keep only messages carrying a selected tag  (tagsExcludeMode = false)
//   exclude  → drop messages carrying a selected tag       (tagsExcludeMode = true)
type TagFilterMode = 'include' | 'exclude';

function tagFilterModeFromState(queryState: AnalysisFiltersPanelPage['queryState']): TagFilterMode {
  return queryState.tagsExcludeMode ? 'exclude' : 'include';
}

function tagFilterModeHint(mode: TagFilterMode): string {
  switch (mode) {
    case 'exclude':
      return 'Показувати записи без вибраних тегів';
    case 'include':
    default:
      return 'Показувати лише записи з вибраними тегами';
  }
}

type MetadataFilterMode = 'all' | 'with' | 'without';

function CallsignFilterField({
  active,
  fallbackOptions,
  options,
  queryState,
  value,
  onChange,
}: {
  active: boolean;
  fallbackOptions: AnalysisFiltersPanelDerivedData['callsignsOptions'];
  options: AnalysisFiltersPanelPage['options'];
  queryState: AnalysisFiltersPanelPage['queryState'];
  value: string[];
  onChange: (callsigns: string[]) => void;
}) {
  const { notify } = useOptionalPowerSnackbar();
  const analysisReq = useMemo(
    () =>
      buildAnalysisReq(
        queryState,
        options.freqs.map((option) => option.value),
      ),
    [options.freqs, queryState],
  );
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
    active,
    analysisReq,
    onError: notifyCallsignLoadError,
  });
  const error =
    page.error instanceof Error
      ? page.error.message
      : page.error
        ? 'Не вдалося завантажити позивні.'
        : null;
  const callsignOptions = active
    ? page.entries.map((entry) => {
        const values = normalizeCallsignFilterValues(entry.values);
        const value = normalizeCallsignLookupValue(entry.value);
        return {
          value: values.includes(value) ? value : (values[0] ?? value),
          label: entry.label,
          count: entry.count,
          values,
        };
      })
    : fallbackOptions;

  return (
    <Stack spacing={0.5}>
      <AnalysisFilterField
        label="Позивні"
        options={callsignOptions}
        loading={page.pending}
        emptyLoading={active && page.pending && page.entries.length === 0}
        value={value}
        deferredCommit
        preserveInputOnSelect
        preserveInputOnBlur
        onInputChange={page.setQuery}
        onChange={(callsignsSelected) => onChange(normalizeCallsignFilterValues(callsignsSelected))}
      />
      <Stack direction="row" spacing={0.5}>
        <Button
          size="small"
          disabled={page.pending || page.stale || page.pageIndex === 0}
          onClick={() => void page.loadFirstPage()}
        >
          Перша
        </Button>
        <Button
          size="small"
          disabled={page.pending || page.stale || !page.hasPrevious}
          onClick={() => void page.loadPreviousPage()}
        >
          Попередні
        </Button>
        <Button
          size="small"
          disabled={page.pending || page.stale || !page.hasMore}
          onClick={() => void page.loadNextPage()}
        >
          Наступні
        </Button>
      </Stack>
      {error ? (
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Typography color="error" variant="caption">
            {error}
          </Typography>
          <Button
            size="small"
            disabled={!page.canRetry || page.loading}
            onClick={() => void page.retry()}
          >
            Повторити
          </Button>
        </Stack>
      ) : null}
    </Stack>
  );
}

function metadataFilterModeFromState(
  queryState: AnalysisFiltersPanelPage['queryState'],
): MetadataFilterMode {
  if (queryState.withoutMetadata) return 'without';
  if (queryState.onlyWithMetadata) return 'with';
  return 'all';
}

function metadataFilterModeHint(mode: MetadataFilterMode): string {
  switch (mode) {
    case 'with':
      return 'Показувати лише записи з метаданими';
    case 'without':
      return 'Показувати лише записи без метаданих';
    case 'all':
    default:
      return 'Показувати всі записи';
  }
}

export function AnalysisFiltersPanelSections({
  threadOnly = false,
  counts,
  derived,
  expandedSections,
  cyberEchoEnabled,
  includeOnlyNewFreqs,
  filtersLoading,
  isFilterSectionLoading,
  isFilterSectionEmptyLoading,
  isFilterSectionStale,
  loadFilterSection,
  options,
  queryState,
  unitsExactMatchOnlyDefault,
  analysisAorFilterEnabled,
  hideNetworks,
  hideGroupSelection,
  rerReportFilterEnabled,
  setIncludeOnlyNewFreqs,
  toggleSection,
  updateQueryState,
}: Props) {
  const loadingCountLabel = NO_DATA_LABEL;

  const isSectionLoading = (section: FilterSectionLoadTarget) =>
    section === 'freqs' ? false : isFilterSectionLoading(section);
  const isSectionEmptyLoading = (section: FilterSectionLoadTarget, optionCount: number) =>
    section === 'freqs'
      ? filtersLoading && optionCount === 0
      : isFilterSectionEmptyLoading(section, optionCount);
  const isSectionStale = (section: FilterSectionLoadTarget) =>
    section === 'freqs' ? false : isFilterSectionStale(section);
  const countLabel = (
    section: FilterSectionLoadTarget,
    optionCount: number,
    selectedCount: number,
    overallCount: number | null | undefined,
  ) =>
    overallCount == null ||
    isSectionLoading(section) ||
    isSectionStale(section) ||
    (filtersLoading && optionCount === 0 && selectedCount === 0)
      ? loadingCountLabel
      : sectionCountLabel(selectedCount, overallCount);

  const loadSection = (section: AnalysisFilterSectionId) => () => {
    void loadFilterSection(section);
  };

  const handleMetadataFilterModeChange = (
    _event: MouseEvent<HTMLElement>,
    nextMode: MetadataFilterMode | null,
  ) => {
    const mode = nextMode ?? 'all';
    updateQueryState({
      onlyWithMetadata: mode === 'with',
      withoutMetadata: mode === 'without',
    });
  };

  const handleTagFilterModeChange = (
    _event: MouseEvent<HTMLElement>,
    nextMode: TagFilterMode | null,
  ) => {
    if (nextMode == null) return;
    updateQueryState({ tagsExcludeMode: nextMode === 'exclude' });
  };

  const effectiveUnitsExactMatchOnly =
    queryState.unitsExactMatchOnly ?? unitsExactMatchOnlyDefault ?? false;
  const unitsMatchCount = effectiveUnitsExactMatchOnly
    ? counts?.unitsNonExactMatchesCount
    : counts?.unitsExactMatchesCount;
  const unitsExactMatchLabel =
    queryState.unitsSelected.length > 0
      ? unitsMatchCount != null
        ? effectiveUnitsExactMatchOnly
          ? `неточних збігів: ${unitsMatchCount}`
          : `точних збігів: ${unitsMatchCount}`
        : 'Точний збіг за еталонкою'
      : null;

  const radioFeaturesAllowed = useRadioFeatures();
  const metadataFilterMode = metadataFilterModeFromState(queryState);
  const tagFilterMode = tagFilterModeFromState(queryState);
  return (
    <>
      {analysisAorFilterEnabled ? (
        <FilterSection
          title="Смуги"
          countLabel={countLabel(
            'aors',
            options.aors.length,
            derived.aorsSelectedCount,
            counts?.aorsCount,
          )}
          expanded={expandedSections.aors}
          onToggle={() => toggleSection('aors')}
          onLoad={loadSection('aors')}
        >
          <AnalysisFilterField
            label="Смуги"
            options={derived.aorOptions}
            loading={isFilterSectionLoading('aors') || isFilterSectionStale('aors')}
            emptyLoading={isFilterSectionEmptyLoading('aors', derived.aorOptions.length)}
            value={queryState.aorsSelected}
            deferredCommit
            onChange={(aorsSelected) => updateQueryState({ aorsSelected })}
          />
        </FilterSection>
      ) : null}
      {radioFeaturesAllowed ? (
        <FilterSection
          title="Частоти"
          countLabel={countLabel(
            'freqs',
            options.freqs.length,
            derived.freqsSelectedCount,
            counts?.freqsCount,
          )}
          expanded={expandedSections.freqs}
          onToggle={() => toggleSection('freqs')}
        >
          <Stack spacing={1.25}>
            <AnalysisFilterField
              label="Частоти"
              options={options.freqs}
              disabled={includeOnlyNewFreqs}
              loading={isSectionLoading('freqs') || isSectionStale('freqs')}
              emptyLoading={isSectionEmptyLoading('freqs', options.freqs.length)}
              value={queryState.freqsSelected}
              deferredCommit
              bulkPaste
              bulkPasteSeparators={[',', '\n']}
              bulkPasteInputLabel="Частоти"
              preserveSelectionOrder
              onChange={(freqsSelected) => updateQueryState({ freqsSelected })}
            />
            <FormControl size="small" disabled={includeOnlyNewFreqs}>
              <InputLabel id="analysis-adjacent-range-label">
                Включати частоти в діапазоні
              </InputLabel>
              <Select
                labelId="analysis-adjacent-range-label"
                label="Включати частоти в діапазоні"
                value={String(queryState.adjacentFreqsRange)}
                onChange={(event) =>
                  updateQueryState({ adjacentFreqsRange: Number(event.target.value) })
                }
              >
                {[0, 0.0005, 0.002, 0.005].map((value) => (
                  <MenuItem key={value} value={String(value)}>
                    {value === 0 ? '0 кГц' : `${value * 1000} кГц`}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControlLabel
              control={
                <Checkbox
                  disabled={threadOnly}
                  checked={includeOnlyNewFreqs}
                  onChange={(_event, value) => setIncludeOnlyNewFreqs(value)}
                />
              }
              label="Тільки нові частоти"
              title={threadOnly ? 'Недоступно під час перегляду ланцюжка' : undefined}
              sx={compactCheckboxLabelSx}
            />
          </Stack>
        </FilterSection>
      ) : null}
      <FilterSection
        title="Позивні"
        countLabel={countLabel(
          'callsigns',
          options.callsigns.length,
          derived.callsignsSelectedCount,
          counts?.callsignsCount,
        )}
        expanded={expandedSections.callsigns}
        onToggle={() => toggleSection('callsigns')}
      >
        {threadOnly ? (
          <AnalysisFilterField
            label="Позивні"
            options={derived.callsignsOptions}
            value={queryState.callsignsSelected}
            deferredCommit
            onChange={(callsignsSelected) => updateQueryState({ callsignsSelected })}
          />
        ) : (
          <CallsignFilterField
            active={expandedSections.callsigns}
            fallbackOptions={derived.callsignsOptions}
            options={options}
            queryState={queryState}
            value={queryState.callsignsSelected}
            onChange={(callsignsSelected) => updateQueryState({ callsignsSelected })}
          />
        )}
      </FilterSection>
      {radioFeaturesAllowed && !hideNetworks ? (
        <FilterSection
          title="Мережі"
          countLabel={countLabel(
            'networks',
            options.networks.length,
            derived.networksSelectedCount,
            counts?.networksCount,
          )}
          expanded={expandedSections.networks}
          onToggle={() => toggleSection('networks')}
          onLoad={loadSection('networks')}
        >
          <AnalysisFilterField
            label="Мережі"
            options={derived.networkOptions}
            disabled={queryState.withoutNetwork}
            loading={isFilterSectionLoading('networks') || isFilterSectionStale('networks')}
            emptyLoading={isFilterSectionEmptyLoading('networks', derived.networkOptions.length)}
            value={queryState.networksSelected}
            deferredCommit
            onChange={(networksSelected) => updateQueryState({ networksSelected })}
          />
          <Stack spacing={0.5}>
            <FormControlLabel
              control={
                <Checkbox
                  checked={queryState.withoutNetwork}
                  onChange={(_event, value) => updateQueryState({ withoutNetwork: value })}
                />
              }
              label="Тільки без мережі"
              sx={compactCheckboxLabelSx}
            />
          </Stack>
        </FilterSection>
      ) : null}
      <FilterSection
        title="Підрозділи"
        countLabel={countLabel(
          'units',
          options.units.length,
          derived.unitsSelectedCount,
          counts?.unitsCount,
        )}
        expanded={expandedSections.units}
        onToggle={() => toggleSection('units')}
        onLoad={loadSection('units')}
      >
        <Stack spacing={1.25}>
          <AnalysisFilterField
            label="Підрозділи"
            options={derived.unitsOptions}
            loading={isFilterSectionLoading('units') || isFilterSectionStale('units')}
            emptyLoading={isFilterSectionEmptyLoading('units', derived.unitsOptions.length)}
            value={queryState.unitsSelected}
            normalizeUnknownAliases
            deferredCommit
            preserveInputOnSelect
            preserveSelectedOptionValuesOnChange
            onChange={(unitsSelected) => updateQueryState({ unitsSelected })}
          />
          {queryState.unitsSelected.some(
            (value) => !isCanonicalUnitIdValue(value) && !isUnitParentValue(value),
          ) ? (
            <FormControlLabel
              control={
                <Checkbox
                  checked={effectiveUnitsExactMatchOnly}
                  onChange={(_event, value) => updateQueryState({ unitsExactMatchOnly: value })}
                />
              }
              label={unitsExactMatchLabel}
              sx={compactCheckboxLabelSx}
            />
          ) : null}
        </Stack>
      </FilterSection>
      {!hideGroupSelection ? (
        <FilterSection
          title="Групи"
          countLabel={countLabel(
            'groups',
            options.groups.length,
            derived.groupsSelectedCount,
            counts?.groupsCount,
          )}
          expanded={expandedSections.groups}
          onToggle={() => toggleSection('groups')}
          onLoad={loadSection('groups')}
        >
          <AnalysisFilterField
            label="Групи"
            options={derived.groupOptions}
            loading={isFilterSectionLoading('groups') || isFilterSectionStale('groups')}
            emptyLoading={isFilterSectionEmptyLoading('groups', derived.groupOptions.length)}
            value={queryState.groupsSelected}
            deferredCommit
            preserveSelectedOptionValuesOnChange
            onChange={(groupsSelected) => updateQueryState({ groupsSelected })}
          />
        </FilterSection>
      ) : null}
      <FilterSection
        title="Відправники"
        countLabel={countLabel(
          'senders',
          options.senders.length,
          derived.sendersSelectedCount,
          counts?.sendersCount,
        )}
        expanded={expandedSections.senders}
        onToggle={() => toggleSection('senders')}
        onLoad={loadSection('senders')}
      >
        <AnalysisFilterField
          label="Відправники"
          options={options.senders}
          loading={isFilterSectionLoading('senders') || isFilterSectionStale('senders')}
          emptyLoading={isFilterSectionEmptyLoading('senders', options.senders.length)}
          value={queryState.sendersSelected}
          deferredCommit
          onChange={(sendersSelected) => updateQueryState({ sendersSelected })}
        />
      </FilterSection>
      {cyberEchoEnabled ? (
        <FilterSection
          title="Пристрої"
          countLabel={sectionCountLabel(queryState.deviceNamesSelected.length, undefined)}
          expanded={expandedSections.devices}
          onToggle={() => toggleSection('devices')}
          onLoad={loadSection('devices')}
        >
          {expandedSections.devices ? (
            <AnalysisFilterField
              label="Назва пристрою"
              options={options.devices}
              loading={isFilterSectionLoading('devices') || isFilterSectionStale('devices')}
              emptyLoading={isFilterSectionEmptyLoading('devices', options.devices.length)}
              deferredCommit
              value={queryState.deviceNamesSelected}
              onChange={(deviceNamesSelected) => updateQueryState({ deviceNamesSelected })}
            />
          ) : null}
        </FilterSection>
      ) : null}
      {radioFeaturesAllowed ? (
        <FilterSection
          title="Пости"
          countLabel={countLabel(
            'posts',
            options.posts.length,
            derived.postsSelectedCount,
            counts?.postsCount,
          )}
          expanded={expandedSections.posts}
          onToggle={() => toggleSection('posts')}
          onLoad={loadSection('posts')}
        >
          <Stack spacing={1.25}>
            <AnalysisFilterField
              label="Пости"
              options={derived.postsOptions}
              loading={isFilterSectionLoading('posts') || isFilterSectionStale('posts')}
              emptyLoading={isFilterSectionEmptyLoading('posts', derived.postsOptions.length)}
              value={queryState.postsSelected}
              deferredCommit
              onChange={(postsSelected) => updateQueryState({ postsSelected })}
            />
          </Stack>
        </FilterSection>
      ) : null}
      <FilterSection
        title="Локації"
        countLabel={countLabel(
          'locations',
          options.locations.length,
          derived.locationsSelectedCount,
          counts?.locationsCount,
        )}
        expanded={expandedSections.locations}
        onToggle={() => toggleSection('locations')}
        onLoad={loadSection('locations')}
      >
        <Stack spacing={0.5}>
          <AnalysisFilterField
            label="Локації"
            options={derived.locationsOptions}
            loading={isFilterSectionLoading('locations') || isFilterSectionStale('locations')}
            emptyLoading={isFilterSectionEmptyLoading('locations', derived.locationsOptions.length)}
            value={queryState.locationsSelected}
            deferredCommit
            onChange={(locationsSelected) => updateQueryState({ locationsSelected })}
          />
          {radioFeaturesAllowed ? (
            <FormControlLabel
              control={
                <Checkbox
                  checked={queryState.includePelengLocations}
                  onChange={(_event, value) => updateQueryState({ includePelengLocations: value })}
                />
              }
              label="Включати пеленг-локації"
              sx={compactCheckboxLabelSx}
            />
          ) : null}
        </Stack>
      </FilterSection>
      <FilterSection
        sectionId="important"
        title="Важливе"
        countLabel={sectionCountLabel(derived.importantSelectedCount, null)}
        expanded={expandedSections.important}
        onToggle={() => toggleSection('important')}
      >
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            columnGap: 1,
            rowGap: 0.125,
            alignItems: 'start',
          }}
        >
          <FormControlLabel
            control={
              <Checkbox
                checked={queryState.orWithExtendedForm}
                onChange={(_event, value) => updateQueryState({ orWithExtendedForm: value })}
              />
            }
            label="З коментарем"
            sx={compactCheckboxLabelSx}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={queryState.orWithCoords}
                onChange={(_event, value) =>
                  updateQueryState(
                    value
                      ? { orWithCoords: true, orWithoutCoords: false }
                      : { orWithCoords: false, orWithoutCoords: false },
                  )
                }
              />
            }
            label="З пеленгом"
            sx={compactCheckboxLabelSx}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={queryState.onlyWithMedia}
                onChange={(_event, value) => updateQueryState({ onlyWithMedia: value })}
              />
            }
            label="З медіа"
            sx={compactCheckboxLabelSx}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={queryState.orBookmarked}
                onChange={(_event, value) => updateQueryState({ orBookmarked: value })}
              />
            }
            label="Збережені"
            sx={compactCheckboxLabelSx}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={queryState.orImportant}
                onChange={(_event, value) => updateQueryState({ orImportant: value })}
              />
            }
            label="Важливі"
            sx={compactCheckboxLabelSx}
          />
          {rerReportFilterEnabled ? (
            <FormControlLabel
              control={
                <Checkbox
                  checked={queryState.onlyWithNetwork}
                  onChange={(_event, value) =>
                    updateQueryState({
                      onlyWithNetwork: value,
                      withoutNetwork: value ? false : queryState.withoutNetwork,
                    })
                  }
                />
              }
              label="Для звіту РЕР"
              sx={compactCheckboxLabelSx}
            />
          ) : null}
        </Box>
      </FilterSection>
      <FilterSection
        title="Теги"
        countLabel={countLabel(
          'tags',
          options.tags.length,
          derived.tagsSelectedCount,
          counts?.tagsCount,
        )}
        expanded={expandedSections.tags}
        onToggle={() => toggleSection('tags')}
        onLoad={loadSection('tags')}
      >
        <Stack spacing={1.25}>
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              gap: 0.75,
              minWidth: 0,
            }}
          >
            <ToggleButtonGroup
              exclusive
              fullWidth
              size="small"
              color="primary"
              value={tagFilterMode}
              onChange={handleTagFilterModeChange}
              aria-label="Режим тегів"
              sx={{
                '& .MuiToggleButton-root': {
                  textTransform: 'none',
                  py: 0.75,
                },
              }}
            >
              <ToggleButton value="include">Лише обрані</ToggleButton>
              <ToggleButton value="exclude">Крім обраних</ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="caption" sx={{ color: 'text.secondary', lineHeight: 1.35 }}>
              {tagFilterModeHint(tagFilterMode)}
            </Typography>
          </Box>
          <AnalysisFilterField
            label="Теги"
            options={derived.tagOptions}
            loading={isFilterSectionLoading('tags') || isFilterSectionStale('tags')}
            emptyLoading={isFilterSectionEmptyLoading('tags', derived.tagOptions.length)}
            value={queryState.tags.map((tagId) => String(tagId))}
            onChange={(next) =>
              updateQueryState({
                tags: next.map((item) => Number(item)).filter((tagId) => Number.isFinite(tagId)),
              })
            }
          />
          <Stack spacing={0.5}>
            <FormControlLabel
              control={
                <Checkbox
                  checked={queryState.filterTagsOption === 'AllTags'}
                  disabled={queryState.tagsExcludeMode}
                  onChange={(_event, value) =>
                    updateQueryState({ filterTagsOption: value ? 'AllTags' : 'OneOfTags' })
                  }
                />
              }
              label={
                <Box
                  component="span"
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}
                >
                  <Box component="span">Співпадіння з усіма вибраними вище</Box>
                  <Tooltip
                    title="Якщо ввімкнено, запис має збігатися з усіма вибраними вище тегами."
                    placement="top"
                  >
                    <Box
                      component="span"
                      sx={{
                        display: 'inline-flex',
                        color: 'text.secondary',
                        lineHeight: 0,
                        cursor: 'default',
                      }}
                      aria-label="Підказка"
                    >
                      <InfoOutlinedIcon sx={{ fontSize: 16 }} />
                    </Box>
                  </Tooltip>
                </Box>
              }
              sx={compactCheckboxLabelSx}
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={queryState.withoutModelTags}
                  onChange={(_event, value) => updateQueryState({ withoutModelTags: value })}
                />
              }
              label="Без відміток роботами"
              sx={compactCheckboxLabelSx}
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={queryState.reportTagsOnlyThisUnit}
                  onChange={(_event, value) => updateQueryState({ reportTagsOnlyThisUnit: value })}
                />
              }
              label="Лише теги мого підрозділу"
              sx={compactCheckboxLabelSx}
            />
          </Stack>
        </Stack>
      </FilterSection>
      {radioFeaturesAllowed ? (
        <FilterSection
          title="Метадані"
          countLabel={countLabel(
            'metadata',
            derived.metadataOptionsCount,
            derived.metadataSelectedCount,
            null,
          )}
          expanded={expandedSections.metadata}
          onToggle={() => toggleSection('metadata')}
          onLoad={loadSection('metadata')}
        >
          <Stack spacing={1.25}>
            <AnalysisFilterField
              label="Метадані CC"
              options={derived.metadataCcsOptions}
              disabled={queryState.withoutMetadata}
              loading={isFilterSectionLoading('metadata') || isFilterSectionStale('metadata')}
              emptyLoading={isFilterSectionEmptyLoading(
                'metadata',
                derived.metadataCcsOptions.length,
              )}
              value={queryState.metadataCc}
              onChange={(metadataCc) => updateQueryState({ metadataCc })}
            />
            <AnalysisFilterField
              label="Метадані відправника"
              options={derived.metadataSendersOptions}
              disabled={queryState.withoutMetadata}
              loading={isFilterSectionLoading('metadata') || isFilterSectionStale('metadata')}
              emptyLoading={isFilterSectionEmptyLoading(
                'metadata',
                derived.metadataSendersOptions.length,
              )}
              value={queryState.metadataSender}
              onChange={(metadataSender) => updateQueryState({ metadataSender })}
            />
            <AnalysisFilterField
              label="Метадані отримувача"
              options={derived.metadataReceiversOptions}
              disabled={queryState.withoutMetadata}
              loading={isFilterSectionLoading('metadata') || isFilterSectionStale('metadata')}
              emptyLoading={isFilterSectionEmptyLoading(
                'metadata',
                derived.metadataReceiversOptions.length,
              )}
              value={queryState.metadataReceiver}
              onChange={(metadataReceiver) => updateQueryState({ metadataReceiver })}
            />
            <AnalysisFilterField
              label="Хеш метаданих"
              options={derived.metadataHashesOptions}
              disabled={queryState.withoutMetadata}
              loading={isFilterSectionLoading('metadata') || isFilterSectionStale('metadata')}
              emptyLoading={isFilterSectionEmptyLoading(
                'metadata',
                derived.metadataHashesOptions.length,
              )}
              value={queryState.metadataHash}
              onChange={(metadataHash) => updateQueryState({ metadataHash })}
            />
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: 0.75,
                minWidth: 0,
              }}
            >
              <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>
                Режим метаданих
              </Typography>
              <ToggleButtonGroup
                exclusive
                fullWidth
                size="small"
                color="primary"
                value={metadataFilterMode}
                onChange={handleMetadataFilterModeChange}
                aria-label="Режим метаданих"
                sx={{
                  '& .MuiToggleButton-root': {
                    textTransform: 'none',
                    py: 0.75,
                  },
                }}
              >
                <ToggleButton value="all">Усі</ToggleButton>
                <ToggleButton value="with">З метаданими</ToggleButton>
                <ToggleButton value="without">Без метаданих</ToggleButton>
              </ToggleButtonGroup>
              <Typography variant="caption" sx={{ color: 'text.secondary', lineHeight: 1.35 }}>
                {metadataFilterModeHint(metadataFilterMode)}
              </Typography>
            </Box>
          </Stack>
        </FilterSection>
      ) : null}
    </>
  );
}
