import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { Box, Checkbox, FormControl, FormControlLabel, InputLabel, MenuItem, Select, Stack, ToggleButton, ToggleButtonGroup, Tooltip, Typography, type SelectChangeEvent } from '@mui/material';
import type { MouseEvent, ReactNode } from 'react';

import type { AnalysisFilterSectionId } from '../types';
import { AnalysisFilterField } from './AnalysisFilterField';
import type { AnalysisFiltersPanelDerivedData } from './analysis-filters-panel-derived';
import {
  compactCheckboxLabelSx,
  FilterSection,
  type AnalysisFiltersPanelPage,
  type FilterSectionId,
  sectionCountLabel,
  unitsExactMatchModeFromState,
  unitsExactMatchStateFromMode,
  type UnitsExactMatchMode,
} from './analysis-filters-panel-shared';

type Props = Pick<AnalysisFiltersPanelPage, 'counts' | 'includeOnlyNewFreqs' | 'options' | 'queryState' | 'setIncludeOnlyNewFreqs' | 'updateQueryState'> & {
  derived: AnalysisFiltersPanelDerivedData;
  expandedSections: Record<FilterSectionId, boolean>;
  filtersLoading: boolean;
  toggleSection: (section: FilterSectionId) => void;
  isSectionLoading: (section: FilterSectionId) => boolean;
  loadingIndicator: ReactNode;
  loadFilterSectionWithSpinner: (section: AnalysisFilterSectionId) => Promise<void>;
};

type CoordsFilterMode = 'all' | 'with' | 'without';

function coordsFilterModeFromState(queryState: AnalysisFiltersPanelPage['queryState']): CoordsFilterMode {
  if (queryState.orWithCoords && queryState.orWithoutCoords) return 'all';
  if (queryState.orWithCoords) return 'with';
  if (queryState.orWithoutCoords) return 'without';
  return 'all';
}

export function AnalysisFiltersPanelSections({
  counts,
  derived,
  expandedSections,
  includeOnlyNewFreqs,
  filtersLoading,
  isSectionLoading,
  loadingIndicator,
  loadFilterSectionWithSpinner,
  options,
  queryState,
  setIncludeOnlyNewFreqs,
  toggleSection,
  updateQueryState,
}: Props) {
  const showInitialLoadingIndicators = filtersLoading;

  const loadSection = (section: AnalysisFilterSectionId) => () => {
    void loadFilterSectionWithSpinner(section);
  };

  const handleUnitsExactMatchModeChange = (event: SelectChangeEvent) => {
    updateQueryState({
      unitsExactMatchOnly: unitsExactMatchStateFromMode(event.target.value as UnitsExactMatchMode),
    });
  };

  const handleCoordsFilterModeChange = (_event: MouseEvent<HTMLElement>, nextMode: CoordsFilterMode | null) => {
    const mode = nextMode ?? 'all';
    updateQueryState({
      orWithCoords: mode === 'with',
      orWithoutCoords: mode === 'without',
    });
  };

  return (
    <>
      <FilterSection
        title="Смуги"
        countLabel={isSectionLoading('aors') || showInitialLoadingIndicators ? loadingIndicator : sectionCountLabel(derived.aorsSelectedCount, counts?.aorsCount ?? options.aors.length)}
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
        countLabel={isSectionLoading('freqs') || showInitialLoadingIndicators ? loadingIndicator : sectionCountLabel(derived.freqsSelectedCount, counts?.freqsCount ?? options.freqs.length)}
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
        countLabel={isSectionLoading('callsigns') || showInitialLoadingIndicators ? loadingIndicator : sectionCountLabel(derived.callsignsSelectedCount, counts?.callsignsCount ?? options.callsigns.length)}
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
        countLabel={isSectionLoading('networks') || showInitialLoadingIndicators ? loadingIndicator : sectionCountLabel(derived.networksSelectedCount, counts?.networksCount ?? options.networks.length)}
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
        countLabel={isSectionLoading('units') || showInitialLoadingIndicators ? loadingIndicator : sectionCountLabel(derived.unitsSelectedCount, counts?.unitsCount ?? options.units.length)}
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
            onChange={(unitsSelected) => updateQueryState({ unitsSelected })}
          />
          <FormControl fullWidth size="small" sx={{ minWidth: 0 }}>
            <InputLabel id="units-exact-match-mode-label">Збіг за еталонкою</InputLabel>
            <Select
              labelId="units-exact-match-mode-label"
              label="Збіг за еталонкою"
              value={unitsExactMatchModeFromState(queryState.unitsExactMatchOnly)}
              onChange={handleUnitsExactMatchModeChange}
            >
              <MenuItem value="default">За замовчуванням</MenuItem>
              <MenuItem value="exact">Точний збіг</MenuItem>
              <MenuItem value="non-exact">Неточний збіг</MenuItem>
            </Select>
          </FormControl>
        </Stack>
      </FilterSection>
      <FilterSection
        title="Групи"
        countLabel={isSectionLoading('groups') || showInitialLoadingIndicators ? loadingIndicator : sectionCountLabel(derived.groupsSelectedCount, counts?.groupsCount ?? options.groups.length)}
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
        countLabel={isSectionLoading('senders') || showInitialLoadingIndicators ? loadingIndicator : sectionCountLabel(derived.sendersSelectedCount, counts?.sendersCount ?? options.senders.length)}
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
        countLabel={isSectionLoading('posts') || showInitialLoadingIndicators ? loadingIndicator : sectionCountLabel(derived.postsSelectedCount, counts?.postsCount ?? options.posts.length)}
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
        countLabel={isSectionLoading('locations') || showInitialLoadingIndicators ? loadingIndicator : sectionCountLabel(derived.locationsSelectedCount, counts?.locationsCount ?? options.locations.length)}
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
            label={
              <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.375, whiteSpace: 'nowrap' }}>
                З коментарем
                <Tooltip title="Від вас або вашого підрозділу">
                  <InfoOutlinedIcon sx={{ fontSize: 14, color: 'text.secondary', opacity: 0.85 }} />
                </Tooltip>
              </Box>
            }
            sx={{
              ...compactCheckboxLabelSx,
              gridColumn: '1 / -1',
              alignSelf: 'start',
              justifySelf: 'start',
              '& .MuiFormControlLabel-label': {
                lineHeight: 1.3,
                whiteSpace: 'nowrap',
              },
            }}
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
          <Box
            sx={{
              gridColumn: '1 / -1',
              display: 'flex',
              flexDirection: 'column',
              gap: 0.75,
              minWidth: 0,
              mt: 0.5,
            }}
          >
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>
              Режим пеленга
            </Typography>
            <ToggleButtonGroup
              exclusive
              fullWidth
              size="small"
              color="primary"
              value={coordsFilterModeFromState(queryState)}
              onChange={handleCoordsFilterModeChange}
              aria-label="Режим пеленга"
              sx={{
                '& .MuiToggleButton-root': {
                  textTransform: 'none',
                  py: 0.75,
                },
              }}
            >
              <ToggleButton value="all">Усі</ToggleButton>
              <ToggleButton value="with">З пеленгом</ToggleButton>
              <ToggleButton value="without">Без пеленга</ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="caption" sx={{ color: 'text.secondary', lineHeight: 1.35 }}>
              Показувати всі записи або лише ті, де є координати пеленга.
            </Typography>
          </Box>
        </Box>
      </FilterSection>
      <FilterSection
        title="Теги"
        countLabel={isSectionLoading('tags') || showInitialLoadingIndicators ? loadingIndicator : sectionCountLabel(derived.tagsSelectedCount, counts?.tagsCount ?? options.tags.length)}
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
          <FormControl size="small">
            <InputLabel id="analysis-tags-mode-label">Збіг тегів</InputLabel>
            <Select
              labelId="analysis-tags-mode-label"
              label="Збіг тегів"
              value={queryState.filterTagsOption}
              onChange={(event) => updateQueryState({ filterTagsOption: event.target.value as 'OneOfTags' | 'AllTags' })}
            >
              <MenuItem value="OneOfTags">Будь-який з вибраних</MenuItem>
              <MenuItem value="AllTags">Усі вибрані</MenuItem>
            </Select>
          </FormControl>
          <Stack spacing={0.5}>
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
        countLabel={isSectionLoading('metadata') ? loadingIndicator : sectionCountLabel(derived.metadataSelectedCount, null)}
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
        </Stack>
        <Stack spacing={0.5}>
          <FormControlLabel
            control={<Checkbox checked={queryState.onlyWithMetadata} disabled={queryState.withoutMetadata} onChange={(_event, value) => updateQueryState({ onlyWithMetadata: value })} />}
            label="Тільки з метаданими"
            sx={compactCheckboxLabelSx}
          />
          <FormControlLabel
            control={<Checkbox checked={queryState.withoutMetadata} disabled={queryState.onlyWithMetadata} onChange={(_event, value) => updateQueryState({ withoutMetadata: value })} />}
            label="Тільки без метаданих"
            sx={compactCheckboxLabelSx}
          />
        </Stack>
      </FilterSection>
    </>
  );
}
