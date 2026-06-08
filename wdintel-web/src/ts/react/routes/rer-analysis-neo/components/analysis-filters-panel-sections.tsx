import { Box, Checkbox, FormControl, FormControlLabel, InputLabel, MenuItem, Select, Stack, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import type { MouseEvent } from 'react';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';

import type { AnalysisFilterSectionId } from '../types';
import { NO_DATA_LABEL } from '../../../utils/misc';
import { AnalysisFilterField } from './AnalysisFilterField';
import type { AnalysisFiltersPanelDerivedData } from './analysis-filters-panel-derived';
import {
  compactCheckboxLabelSx,
  FilterSection,
  type AnalysisFiltersPanelPage,
  type FilterSectionId,
  sectionCountLabel,
} from './analysis-filters-panel-shared';

type Props = Pick<AnalysisFiltersPanelPage, 'counts' | 'includeOnlyNewFreqs' | 'options' | 'queryState' | 'setIncludeOnlyNewFreqs' | 'updateQueryState'> & {
  derived: AnalysisFiltersPanelDerivedData;
  expandedSections: Record<FilterSectionId, boolean>;
  filtersLoading: boolean;
  unitsExactMatchOnlyDefault: boolean | null;
  toggleSection: (section: FilterSectionId) => void;
  isSectionLoading: (section: FilterSectionId) => boolean;
  loadFilterSectionWithSpinner: (section: AnalysisFilterSectionId) => Promise<void>;
};

type MetadataFilterMode = 'all' | 'with' | 'without';

function metadataFilterModeFromState(queryState: AnalysisFiltersPanelPage['queryState']): MetadataFilterMode {
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
  counts,
  derived,
  expandedSections,
  includeOnlyNewFreqs,
  filtersLoading,
  isSectionLoading,
  loadFilterSectionWithSpinner,
  options,
  queryState,
  unitsExactMatchOnlyDefault,
  setIncludeOnlyNewFreqs,
  toggleSection,
  updateQueryState,
}: Props) {
  const showInitialLoadingIndicators = filtersLoading;
  const loadingCountLabel = NO_DATA_LABEL;

  const loadSection = (section: AnalysisFilterSectionId) => () => {
    void loadFilterSectionWithSpinner(section);
  };

  const handleMetadataFilterModeChange = (_event: MouseEvent<HTMLElement>, nextMode: MetadataFilterMode | null) => {
    const mode = nextMode ?? 'all';
    updateQueryState({
      onlyWithMetadata: mode === 'with',
      withoutMetadata: mode === 'without',
    });
  };

  const unitsExactMatchLabel =
    queryState.unitsSelected.length > 0
      ? counts?.unitsExactMatchesCount != null
        ? `Точний збіг за еталонкою: ${counts.unitsExactMatchesCount}`
        : 'Точний збіг за еталонкою'
      : null;
  const effectiveUnitsExactMatchOnly = queryState.unitsExactMatchOnly ?? unitsExactMatchOnlyDefault ?? false;

  const metadataFilterMode = metadataFilterModeFromState(queryState);
  return (
    <>
      <FilterSection
        title="Смуги"
        countLabel={isSectionLoading('aors') || showInitialLoadingIndicators ? loadingCountLabel : sectionCountLabel(derived.aorsSelectedCount, counts?.aorsCount ?? options.aors.length)}
        expanded={expandedSections.aors}
        onToggle={() => toggleSection('aors')}
        onLoad={loadSection('aors')}
      >
        <AnalysisFilterField
          label="Смуги"
          options={derived.aorOptions}
          loading={isSectionLoading('aors')}
          value={queryState.aorsSelected}
          onChange={(aorsSelected) => updateQueryState({ aorsSelected })}
        />
      </FilterSection>
      <FilterSection
        title="Частоти"
        countLabel={isSectionLoading('freqs') || showInitialLoadingIndicators ? loadingCountLabel : sectionCountLabel(derived.freqsSelectedCount, counts?.freqsCount ?? options.freqs.length)}
        expanded={expandedSections.freqs}
        onToggle={() => toggleSection('freqs')}
      >
        <Stack spacing={1.25}>
          <AnalysisFilterField
            label="Частоти"
            options={options.freqs}
            disabled={includeOnlyNewFreqs}
            loading={isSectionLoading('freqs')}
            value={queryState.freqsSelected}
            onChange={(freqsSelected) => updateQueryState({ freqsSelected })}
          />
          <FormControl size="small" disabled={includeOnlyNewFreqs}>
            <InputLabel id="analysis-adjacent-range-label">Включати частоти в діапазоні</InputLabel>
            <Select
              labelId="analysis-adjacent-range-label"
              label="Включати частоти в діапазоні"
              value={String(queryState.adjacentFreqsRange)}
              onChange={(event) => updateQueryState({ adjacentFreqsRange: Number(event.target.value) })}
            >
              {[0, 0.0005, 0.002, 0.005].map((value) => (
                <MenuItem key={value} value={String(value)}>
                  {value === 0 ? '0 кГц' : `${value * 1000} кГц`}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControlLabel
            control={<Checkbox checked={includeOnlyNewFreqs} onChange={(_event, value) => setIncludeOnlyNewFreqs(value)} />}
            label="Тільки нові частоти"
            sx={compactCheckboxLabelSx}
          />
        </Stack>
      </FilterSection>
      <FilterSection
        title="Позивні"
        countLabel={isSectionLoading('callsigns') || showInitialLoadingIndicators ? loadingCountLabel : sectionCountLabel(derived.callsignsSelectedCount, counts?.callsignsCount ?? options.callsigns.length)}
        expanded={expandedSections.callsigns}
        onToggle={() => toggleSection('callsigns')}
        onLoad={loadSection('callsigns')}
      >
        <AnalysisFilterField
          label="Позивні"
          options={derived.callsignsOptions}
          loading={isSectionLoading('callsigns')}
          value={queryState.callsignsSelected}
          onChange={(callsignsSelected) => updateQueryState({ callsignsSelected })}
        />
      </FilterSection>
      <FilterSection
        title="Мережі"
        countLabel={isSectionLoading('networks') || showInitialLoadingIndicators ? loadingCountLabel : sectionCountLabel(derived.networksSelectedCount, counts?.networksCount ?? options.networks.length)}
        expanded={expandedSections.networks}
        onToggle={() => toggleSection('networks')}
        onLoad={loadSection('networks')}
      >
        <AnalysisFilterField
          label="Мережі"
          options={derived.networkOptions}
          disabled={queryState.withoutNetwork}
          loading={isSectionLoading('networks')}
          value={queryState.networksSelected}
          onChange={(networksSelected) => updateQueryState({ networksSelected })}
        />
        <Stack spacing={0.5}>
          <FormControlLabel
            control={<Checkbox checked={queryState.withoutNetwork} onChange={(_event, value) => updateQueryState({ withoutNetwork: value })} />}
            label="Тільки без мережі"
            sx={compactCheckboxLabelSx}
          />
        </Stack>
      </FilterSection>
      <FilterSection
        title="Підрозділи"
        countLabel={isSectionLoading('units') || showInitialLoadingIndicators ? loadingCountLabel : sectionCountLabel(derived.unitsSelectedCount, counts?.unitsCount ?? options.units.length)}
        expanded={expandedSections.units}
        onToggle={() => toggleSection('units')}
        onLoad={loadSection('units')}
      >
        <Stack spacing={1.25}>
          <AnalysisFilterField
            label="Підрозділи"
            options={derived.unitsOptions}
            loading={isSectionLoading('units')}
            value={queryState.unitsSelected}
            normalizeUnknownAliases
            onChange={(unitsSelected) => updateQueryState({ unitsSelected })}
          />
          {queryState.unitsSelected.length > 0 ? (
            <FormControlLabel
              control={<Checkbox checked={effectiveUnitsExactMatchOnly} onChange={(_event, value) => updateQueryState({ unitsExactMatchOnly: value })} />}
              label={unitsExactMatchLabel}
              sx={compactCheckboxLabelSx}
            />
          ) : null}
        </Stack>
      </FilterSection>
      <FilterSection
        title="Групи"
        countLabel={isSectionLoading('groups') || showInitialLoadingIndicators ? loadingCountLabel : sectionCountLabel(derived.groupsSelectedCount, counts?.groupsCount ?? options.groups.length)}
        expanded={expandedSections.groups}
        onToggle={() => toggleSection('groups')}
        onLoad={loadSection('groups')}
      >
        <AnalysisFilterField
          label="Групи"
          options={derived.groupOptions}
          loading={isSectionLoading('groups')}
          value={queryState.groupsSelected}
          onChange={(groupsSelected) => updateQueryState({ groupsSelected })}
        />
      </FilterSection>
      <FilterSection
        title="Відправники"
        countLabel={isSectionLoading('senders') || showInitialLoadingIndicators ? loadingCountLabel : sectionCountLabel(derived.sendersSelectedCount, counts?.sendersCount ?? options.senders.length)}
        expanded={expandedSections.senders}
        onToggle={() => toggleSection('senders')}
        onLoad={loadSection('senders')}
      >
        <AnalysisFilterField
          label="Відправники"
          options={options.senders}
          loading={isSectionLoading('senders')}
          value={queryState.sendersSelected}
          onChange={(sendersSelected) => updateQueryState({ sendersSelected })}
        />
      </FilterSection>
      <FilterSection
        title="Пости"
        countLabel={isSectionLoading('posts') || showInitialLoadingIndicators ? loadingCountLabel : sectionCountLabel(derived.postsSelectedCount, counts?.postsCount ?? options.posts.length)}
        expanded={expandedSections.posts}
        onToggle={() => toggleSection('posts')}
        onLoad={loadSection('posts')}
      >
        <Stack spacing={1.25}>
          <AnalysisFilterField
            label="Пости"
            options={derived.postsOptions}
            loading={isSectionLoading('posts')}
            value={queryState.postsSelected}
            onChange={(postsSelected) => updateQueryState({ postsSelected })}
          />
        </Stack>
      </FilterSection>
      <FilterSection
        title="Локації"
        countLabel={isSectionLoading('locations') || showInitialLoadingIndicators ? loadingCountLabel : sectionCountLabel(derived.locationsSelectedCount, counts?.locationsCount ?? options.locations.length)}
        expanded={expandedSections.locations}
        onToggle={() => toggleSection('locations')}
        onLoad={loadSection('locations')}
      >
        <Stack spacing={0.5}>
          <AnalysisFilterField
            label="Локації"
            options={derived.locationsOptions}
            loading={isSectionLoading('locations')}
            value={queryState.locationsSelected}
            onChange={(locationsSelected) => updateQueryState({ locationsSelected })}
          />
          <FormControlLabel
            control={<Checkbox checked={queryState.includePelengLocations} onChange={(_event, value) => updateQueryState({ includePelengLocations: value })} />}
            label="Включати пеленг-локації"
            sx={compactCheckboxLabelSx}
          />
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
            control={<Checkbox checked={queryState.orWithExtendedForm} onChange={(_event, value) => updateQueryState({ orWithExtendedForm: value })} />}
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
            control={<Checkbox checked={queryState.orBookmarked} onChange={(_event, value) => updateQueryState({ orBookmarked: value })} />}
            label="Збережені"
            sx={compactCheckboxLabelSx}
          />
          <FormControlLabel
            control={<Checkbox checked={queryState.orImportant} onChange={(_event, value) => updateQueryState({ orImportant: value })} />}
            label="Важливі"
            sx={compactCheckboxLabelSx}
          />
        </Box>
      </FilterSection>
      <FilterSection
        title="Теги"
        countLabel={isSectionLoading('tags') || showInitialLoadingIndicators ? loadingCountLabel : sectionCountLabel(derived.tagsSelectedCount, counts?.tagsCount ?? options.tags.length)}
        expanded={expandedSections.tags}
        onToggle={() => toggleSection('tags')}
        onLoad={loadSection('tags')}
      >
        <Stack spacing={1.25}>
          <AnalysisFilterField
            label="Теги"
            options={derived.tagOptions}
            loading={isSectionLoading('tags')}
            value={queryState.tags.map((tagId) => String(tagId))}
            onChange={(next) => updateQueryState({ tags: next.map((item) => Number(item)).filter((tagId) => Number.isFinite(tagId)) })}
          />
          <Stack spacing={0.5}>
            <FormControlLabel
              control={<Checkbox checked={queryState.filterTagsOption === 'AllTags'} onChange={(_event, value) => updateQueryState({ filterTagsOption: value ? 'AllTags' : 'OneOfTags' })} />}
              label={
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
                  <Box component="span">Співпадіння з усіма вибраними вище</Box>
                  <Tooltip title="Якщо ввімкнено, запис має збігатися з усіма вибраними вище тегами." placement="top">
                    <Box component="span" sx={{ display: 'inline-flex', color: 'text.secondary', lineHeight: 0, cursor: 'default' }} aria-label="Підказка">
                      <InfoOutlinedIcon sx={{ fontSize: 16 }} />
                    </Box>
                  </Tooltip>
                </Box>
              }
              sx={compactCheckboxLabelSx}
            />
            <FormControlLabel
              control={<Checkbox checked={queryState.withoutModelTags} onChange={(_event, value) => updateQueryState({ withoutModelTags: value })} />}
              label="Без відміток роботами"
              sx={compactCheckboxLabelSx}
            />
            <FormControlLabel
              control={<Checkbox checked={queryState.reportTagsOnlyThisUnit} onChange={(_event, value) => updateQueryState({ reportTagsOnlyThisUnit: value })} />}
              label="Лише теги мого підрозділу"
              sx={compactCheckboxLabelSx}
            />
          </Stack>
        </Stack>
      </FilterSection>
      <FilterSection
        title="Метадані"
        countLabel={isSectionLoading('metadata') ? loadingCountLabel : sectionCountLabel(derived.metadataSelectedCount, null)}
        expanded={expandedSections.metadata}
        onToggle={() => toggleSection('metadata')}
        onLoad={loadSection('metadata')}
      >
        <Stack spacing={1.25}>
          <AnalysisFilterField
            label="Метадані CC"
            options={derived.metadataCcsOptions}
            disabled={queryState.withoutMetadata}
            loading={isSectionLoading('metadata')}
            value={queryState.metadataCc}
            onChange={(metadataCc) => updateQueryState({ metadataCc })}
          />
          <AnalysisFilterField
            label="Метадані відправника"
            options={derived.metadataSendersOptions}
            disabled={queryState.withoutMetadata}
            loading={isSectionLoading('metadata')}
            value={queryState.metadataSender}
            onChange={(metadataSender) => updateQueryState({ metadataSender })}
          />
          <AnalysisFilterField
            label="Метадані отримувача"
            options={derived.metadataReceiversOptions}
            disabled={queryState.withoutMetadata}
            loading={isSectionLoading('metadata')}
            value={queryState.metadataReceiver}
            onChange={(metadataReceiver) => updateQueryState({ metadataReceiver })}
          />
          <AnalysisFilterField
            label="Хеш метаданих"
            options={derived.metadataHashesOptions}
            disabled={queryState.withoutMetadata}
            loading={isSectionLoading('metadata')}
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
    </>
  );
}
