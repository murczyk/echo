import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Checkbox,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { PowerChip } from '../../../components/PowerChip';
import type { AnalysisPageActions, AnalysisPageState } from '../types';
import { uppercaseStrings } from '../../../utils/misc';
import { AnalysisFilterField } from './AnalysisFilterField';
import { AnalysisSavedFiltersCard } from './AnalysisSavedFiltersCard';
import type { AnalysisFilterSectionId } from '../types';
import { normalizeFilterLabel, sortFilterOptionsByLabel } from '../use-analysis-data.shared';

type Props = Pick<
  AnalysisPageState,
  | 'isDirty'
  | 'counts'
  | 'canResetFilters'
  | 'includeOnlyNewFreqs'
  | 'loadedSavedFilter'
  | 'options'
  | 'filtersLoading'
  | 'aorEntries'
  | 'groupInfos'
  | 'networkDisplayMap'
  | 'networks'
  | 'queryState'
  | 'saveInFlight'
  | 'savedFilterName'
  | 'savedFilters'
  | 'tagsMap'
> &
  Pick<
    AnalysisPageActions,
    | 'applySavedFilter'
    | 'deleteLoadedSavedFilter'
    | 'renameExistingSavedFilter'
    | 'resetFilters'
    | 'saveAsNew'
    | 'setIncludeOnlyNewFreqs'
    | 'setSavedFilterName'
    | 'updateExisting'
    | 'updateQueryState'
    | 'loadFilterSection'
  >;

type FilterSectionId =
  | 'important'
  | 'tags'
  | 'networks'
  | 'aors'
  | 'groups'
  | 'senders'
  | 'freqs'
  | 'callsigns'
  | 'units'
  | 'locations'
  | 'posts'
  | 'metadata';

const defaultExpandedSections: Record<FilterSectionId, boolean> = {
  important: true,
  tags: false,
  networks: false,
  aors: false,
  groups: false,
  senders: false,
  freqs: false,
  callsigns: false,
  units: false,
  locations: false,
  posts: false,
  metadata: false,
};

const compactCheckboxLabelSx = {
  m: 0,
  minHeight: 32,
  alignItems: 'center',
  '& .MuiFormControlLabel-label': {
    lineHeight: 1.3,
  },
};

type FilterSectionProps = {
  sectionId?: FilterSectionId;
  title: string;
  countLabel?: string | null;
  expanded: boolean;
  onToggle: () => void;
  onLoad?: () => void;
  children: ReactNode;
};

type UnitsExactMatchMode = 'default' | 'exact' | 'non-exact';

function unitsExactMatchModeFromState(value: boolean | null): UnitsExactMatchMode {
  if (value === true) return 'exact';
  if (value === false) return 'non-exact';
  return 'default';
}

function unitsExactMatchStateFromMode(value: UnitsExactMatchMode): boolean | null {
  if (value === 'exact') return true;
  if (value === 'non-exact') return false;
  return null;
}

function getInitialExpandedSections(): Record<FilterSectionId, boolean> {
  return defaultExpandedSections;
}

function sectionCountLabel(selectedCount: number, overallCount: number | null | undefined): string | null {
  if (overallCount == null) {
    return selectedCount > 0 ? String(selectedCount) : null;
  }
  return selectedCount > 0 ? `${selectedCount} з ${overallCount}` : String(overallCount);
}

function FilterSection({ sectionId, title, countLabel, expanded, onToggle, onLoad, children }: FilterSectionProps) {
  return (
    <Accordion
      data-section-id={sectionId ?? title}
      expanded={expanded}
      onChange={(_event, nextExpanded) => {
        onToggle();
        if (nextExpanded) {
          onLoad?.();
        }
      }}
      disableGutters
      elevation={0}
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: (theme) => `${theme.shape.borderRadius}px`,
        overflow: 'hidden',
        backgroundColor: 'background.paper',
        '&:before': {
          display: 'none',
        },
        '& + &': {
          mt: 1,
        },
      }}
    >
      <AccordionSummary
        expandIcon={<ExpandMoreIcon />}
        sx={{
          minHeight: 46,
          px: 1.5,
          py: 0.25,
          '& .MuiAccordionSummary-content': {
            my: 0.75,
          },
          '&.Mui-expanded': {
            minHeight: 46,
          },
          '&.Mui-expanded .MuiAccordionSummary-content': {
            my: 0.75,
          },
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, width: '100%', minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, minWidth: 0 }} noWrap>
            {title}
          </Typography>
          {countLabel ? (
            <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.secondary', flexShrink: 0 }}>
              {countLabel}
            </Typography>
          ) : null}
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 1.5, pb: 1.25, pt: 0 }}>
        <Stack spacing={1}>{children}</Stack>
      </AccordionDetails>
    </Accordion>
  );
}

export function AnalysisFiltersPanel({
  isDirty,
  counts,
  canResetFilters,
  aorEntries,
  filtersLoading,
  groupInfos,
  includeOnlyNewFreqs,
  loadedSavedFilter,
  options,
  queryState,
  saveInFlight,
  savedFilterName,
  savedFilters,
  tagsMap,
  applySavedFilter,
  deleteLoadedSavedFilter,
  renameExistingSavedFilter,
  resetFilters,
  saveAsNew,
  setIncludeOnlyNewFreqs,
  setSavedFilterName,
  loadFilterSection,
  updateExisting,
  updateQueryState,
}: Props) {
  const [expandedSections, setExpandedSections] = useState(() => getInitialExpandedSections());
  const [loadingSections, setLoadingSections] = useState<Partial<Record<FilterSectionId, boolean>>>({});
  const prevFiltersLoadingRef = useRef(filtersLoading);

  const toggleSection = (section: FilterSectionId) => {
    setExpandedSections((current) => ({ ...current, [section]: !current[section] }));
  };

  const loadFilterSectionWithSpinner = useCallback(
    async (section: AnalysisFilterSectionId) => {
      setLoadingSections((current) => ({ ...current, [section]: true }));
      try {
        await loadFilterSection(section);
      } finally {
        setLoadingSections((current) => ({ ...current, [section]: false }));
      }
    },
    [loadFilterSection],
  );

  useEffect(() => {
    const wasLoading = prevFiltersLoadingRef.current;
    prevFiltersLoadingRef.current = filtersLoading;
    if (!wasLoading || filtersLoading) return;

    const maybeReload = (section: AnalysisFilterSectionId, expanded: boolean, optionCount: number) => {
      if (expanded && optionCount === 0) {
        void loadFilterSectionWithSpinner(section);
      }
    };

    maybeReload('tags', expandedSections.tags, options.tags.length);
    maybeReload('networks', expandedSections.networks, options.networks.length);
    maybeReload('aors', expandedSections.aors, options.aors.length);
    maybeReload('groups', expandedSections.groups, options.groups.length);
    maybeReload('senders', expandedSections.senders, options.senders.length);
    maybeReload('callsigns', expandedSections.callsigns, options.callsigns.length);
    maybeReload('units', expandedSections.units, options.units.length);
    maybeReload('locations', expandedSections.locations, options.locations.length);
    maybeReload('posts', expandedSections.posts, options.posts.length);
    maybeReload('metadata', expandedSections.metadata, options.metadataCcs.length + options.metadataSenders.length + options.metadataReceivers.length + options.metadataHashes.length);
  }, [
    expandedSections.aors,
    expandedSections.callsigns,
    expandedSections.groups,
    expandedSections.locations,
    expandedSections.metadata,
    expandedSections.networks,
    expandedSections.posts,
    expandedSections.senders,
    expandedSections.tags,
    expandedSections.units,
    filtersLoading,
    loadFilterSection,
    options.aors.length,
    options.callsigns.length,
    options.groups.length,
    options.locations.length,
    options.metadataCcs.length,
    options.metadataHashes.length,
    options.metadataReceivers.length,
    options.metadataSenders.length,
    options.networks.length,
    options.posts.length,
    options.senders.length,
    options.tags.length,
    options.units.length,
    loadFilterSectionWithSpinner,
  ]);

  const isSectionLoading = (section: FilterSectionId): boolean => filtersLoading || loadingSections[section] === true;

  const groupOptions = sortFilterOptionsByLabel(
    options.groups.map((option) => ({
      ...option,
      label: normalizeFilterLabel(groupInfos[option.value]?.name ?? option.label ?? option.value),
    })),
  );
  const callsignValues = Array.from(new Set([...options.callsigns.map((option) => option.value), ...queryState.callsignsSelected]));
  const callsignLabels = uppercaseStrings(callsignValues);
  const callsignsOptions = callsignValues.reduce<Array<{ value: string; label: string; count: number; values: string[] }>>((acc, callsign, index) => {
    const label = callsignLabels[index] ?? callsign;
    const existingOption = acc.find((option) => option.label === label);
    if (existingOption != null) {
      existingOption.values.push(callsign);
      existingOption.count += options.callsigns.find((option) => option.value === callsign)?.count ?? 0;
      return acc;
    }
    acc.push({ value: label, label, count: options.callsigns.find((option) => option.value === callsign)?.count ?? 0, values: [callsign] });
    return acc;
  }, []);
  const aorNamesById = Object.fromEntries(aorEntries.map((aor) => [String(aor.id), aor.name]));
  const aorOptions = sortFilterOptionsByLabel(
    options.aors.map((option) => ({
      ...option,
      label: normalizeFilterLabel(aorNamesById[option.value] ?? option.label ?? option.value),
    })),
    ['Вся смуга'],
  );
  const networkOptions = sortFilterOptionsByLabel(
    options.networks.map((option) => ({
      ...option,
      label: normalizeFilterLabel(option.label ?? option.value),
    })),
  );
  const tagOptions = sortFilterOptionsByLabel(
    options.tags.map((option) => ({
      ...option,
      label: normalizeFilterLabel(tagsMap[Number(option.value)]?.label ?? option.label ?? option.value),
    })),
  );
  const metadataCcsOptions = sortFilterOptionsByLabel(
    options.metadataCcs.map((option) => ({
      ...option,
      label: normalizeFilterLabel(option.label ?? option.value),
    })),
  );
  const metadataSendersOptions = sortFilterOptionsByLabel(
    options.metadataSenders.map((option) => ({
      ...option,
      label: normalizeFilterLabel(option.label ?? option.value),
    })),
  );
  const metadataReceiversOptions = sortFilterOptionsByLabel(
    options.metadataReceivers.map((option) => ({
      ...option,
      label: normalizeFilterLabel(option.label ?? option.value),
    })),
  );
  const metadataHashesOptions = sortFilterOptionsByLabel(
    options.metadataHashes.map((option) => ({
      ...option,
      label: normalizeFilterLabel(option.label ?? option.value),
    })),
  );
  const locationsOptions = sortFilterOptionsByLabel(
    options.locations.map((option) => ({
      ...option,
      label: normalizeFilterLabel(option.label ?? option.value),
    })),
    ['<Не вказано>'],
  );
  const postsOptions = sortFilterOptionsByLabel(
    options.posts.map((option) => ({
      ...option,
      label: normalizeFilterLabel(option.label ?? option.value),
    })),
  );
  const unitsOptions = sortFilterOptionsByLabel(
    options.units.map((option) => ({
      ...option,
      label: normalizeFilterLabel(option.label ?? option.value),
    })),
  );
  const importantSelectedCount =
    Number(queryState.orWithExtendedForm) +
    Number(queryState.orBookmarked) +
    Number(queryState.orImportant) +
    Number(queryState.orWithCoords) +
    Number(queryState.orWithoutCoords) +
    Number(queryState.withoutModelTags) +
    Number(queryState.reportTagsOnlyThisUnit);
  const tagsSelectedCount =
    queryState.tags.length +
    Number(queryState.orWithExtendedForm) +
    Number(queryState.orBookmarked) +
    Number(queryState.orImportant) +
    Number(queryState.orWithCoords) +
    Number(queryState.orWithoutCoords) +
    Number(queryState.withoutModelTags) +
    Number(queryState.reportTagsOnlyThisUnit);
  const aorsSelectedCount = queryState.aorsSelected.length;
  const groupsSelectedCount = queryState.groupsSelected.length;
  const sendersSelectedCount = queryState.sendersSelected.length;
  const freqsSelectedCount = queryState.freqsSelected.length;
  const callsignsSelectedCount = queryState.callsignsSelected.length;
  const unitsSelectedCount = queryState.unitsSelected.length;
  const locationsSelectedCount = queryState.locationsSelected.length;
  const postsSelectedCount = queryState.postsSelected.length;
  const networksSelectedCount = queryState.networksSelected.length;
  const metadataSelectedCount =
    queryState.metadataCc.length + queryState.metadataSender.length + queryState.metadataReceiver.length + queryState.metadataHash.length;
  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.5,
        overflow: 'auto',
        minHeight: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        border: 'none',
        borderRadius: 0,
        boxShadow: 'none',
        backgroundColor: 'transparent',
      }}
    >
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={2} alignItems="center" justifyContent="space-between" sx={{ pt: 0.5, pb: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
            Фільтри
          </Typography>
          <Button
            size="small"
            onClick={resetFilters}
            disabled={!canResetFilters}
            sx={{ flexShrink: 0 }}
          >
            Скинути
          </Button>
        </Stack>
        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
          {loadedSavedFilter ? (
            <PowerChip
              label={loadedSavedFilter.name}
              onDelete={() => applySavedFilter(null)}
              selected
              color="default"
              sx={{ alignSelf: 'flex-start', mb: 1 }}
              title={`Збережений фільтр: ${loadedSavedFilter.name}`}
            />
          ) : null}
          <FilterSection
            sectionId="important"
            title="Важливе"
            countLabel={sectionCountLabel(importantSelectedCount, null)}
            expanded={expandedSections.important}
            onToggle={() => toggleSection('important')}
          >
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                columnGap: 1,
                rowGap: 0.25,
                alignItems: 'start',
              }}
            >
              <FormControlLabel
                control={<Checkbox checked={queryState.orWithExtendedForm} onChange={(_e, value) => updateQueryState({ orWithExtendedForm: value })} />}
                label="З нотаткою"
                sx={compactCheckboxLabelSx}
              />
              <FormControlLabel
                control={<Checkbox checked={queryState.orBookmarked} onChange={(_e, value) => updateQueryState({ orBookmarked: value })} />}
                label="Збережені"
                sx={compactCheckboxLabelSx}
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={queryState.orWithCoords}
                    onChange={(_e, value) => updateQueryState({ orWithCoords: value, orWithoutCoords: value ? false : queryState.orWithoutCoords })}
                  />
                }
                label="З пеленгом"
                sx={compactCheckboxLabelSx}
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={queryState.orWithoutCoords}
                    onChange={(_e, value) => updateQueryState({ orWithoutCoords: value, orWithCoords: value ? false : queryState.orWithCoords })}
                  />
                }
                label="Без пеленга"
                sx={compactCheckboxLabelSx}
              />
              <FormControlLabel
                control={<Checkbox checked={queryState.orImportant} onChange={(_e, value) => updateQueryState({ orImportant: value })} />}
                label="Важливі"
                sx={{
                  ...compactCheckboxLabelSx,
                  gridColumn: '1 / -1',
                  justifySelf: 'start',
                }}
              />
            </Box>
          </FilterSection>

          <FilterSection
            title="Відправники"
            countLabel={sectionCountLabel(sendersSelectedCount, counts?.sendersCount ?? options.senders.length)}
            expanded={expandedSections.senders}
            onToggle={() => toggleSection('senders')}
            onLoad={() => void loadFilterSectionWithSpinner('senders')}
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
            title="Групи"
            countLabel={sectionCountLabel(groupsSelectedCount, counts?.groupsCount ?? options.groups.length)}
            expanded={expandedSections.groups}
            onToggle={() => toggleSection('groups')}
            onLoad={() => void loadFilterSectionWithSpinner('groups')}
          >
            <AnalysisFilterField
              label="Групи"
              options={groupOptions}
              loading={isSectionLoading('groups')}
              value={queryState.groupsSelected}
              onChange={(groupsSelected) => updateQueryState({ groupsSelected })}
            />
          </FilterSection>

          <FilterSection
            title="Локації"
            countLabel={sectionCountLabel(locationsSelectedCount, counts?.locationsCount ?? options.locations.length)}
            expanded={expandedSections.locations}
            onToggle={() => toggleSection('locations')}
            onLoad={() => void loadFilterSectionWithSpinner('locations')}
          >
            <Stack spacing={0.5}>
              <AnalysisFilterField
                label="Локації"
                options={locationsOptions}
                loading={isSectionLoading('locations')}
                value={queryState.locationsSelected}
                onChange={(locationsSelected) => updateQueryState({ locationsSelected })}
              />
              <FormControlLabel
                control={<Checkbox checked={queryState.includePelengLocations} onChange={(_e, value) => updateQueryState({ includePelengLocations: value })} />}
                label="Включати пеленг-локації"
                sx={compactCheckboxLabelSx}
              />
            </Stack>
          </FilterSection>

          <FilterSection
            title="Мережі"
            countLabel={sectionCountLabel(networksSelectedCount, counts?.networksCount ?? options.networks.length)}
            expanded={expandedSections.networks}
            onToggle={() => toggleSection('networks')}
            onLoad={() => void loadFilterSectionWithSpinner('networks')}
          >
            <AnalysisFilterField
              label="Мережі"
              options={networkOptions}
              disabled={queryState.withoutNetwork}
              loading={isSectionLoading('networks')}
              value={queryState.networksSelected}
              onChange={(networksSelected) => updateQueryState({ networksSelected })}
            />
            <Stack spacing={0.5}>
              <FormControlLabel
                control={<Checkbox checked={queryState.withoutNetwork} onChange={(_e, value) => updateQueryState({ withoutNetwork: value })} />}
                label="Тільки без мережі"
                sx={compactCheckboxLabelSx}
              />
            </Stack>
          </FilterSection>

          <FilterSection
            title="Метадані"
            countLabel={sectionCountLabel(metadataSelectedCount, null)}
            expanded={expandedSections.metadata}
            onToggle={() => toggleSection('metadata')}
            onLoad={() => void loadFilterSectionWithSpinner('metadata')}
          >
            <Stack spacing={1.25}>
              <AnalysisFilterField
                label="Метадані CC"
                options={metadataCcsOptions}
                disabled={queryState.withoutMetadata}
                loading={isSectionLoading('metadata')}
                value={queryState.metadataCc}
                onChange={(metadataCc) => updateQueryState({ metadataCc })}
              />
              <AnalysisFilterField
                label="Метадані відправника"
                options={metadataSendersOptions}
                disabled={queryState.withoutMetadata}
                loading={isSectionLoading('metadata')}
                value={queryState.metadataSender}
                onChange={(metadataSender) => updateQueryState({ metadataSender })}
              />
              <AnalysisFilterField
                label="Метадані отримувача"
                options={metadataReceiversOptions}
                disabled={queryState.withoutMetadata}
                loading={isSectionLoading('metadata')}
                value={queryState.metadataReceiver}
                onChange={(metadataReceiver) => updateQueryState({ metadataReceiver })}
              />
              <AnalysisFilterField
                label="Хеш метаданих"
                options={metadataHashesOptions}
                disabled={queryState.withoutMetadata}
                loading={isSectionLoading('metadata')}
                value={queryState.metadataHash}
                onChange={(metadataHash) => updateQueryState({ metadataHash })}
              />
            </Stack>
            <Stack spacing={0.5}>
              <FormControlLabel
                control={<Checkbox checked={queryState.onlyWithMetadata} disabled={queryState.withoutMetadata} onChange={(_e, value) => updateQueryState({ onlyWithMetadata: value })} />}
                label="Тільки з метаданими"
                sx={compactCheckboxLabelSx}
              />
              <FormControlLabel
                control={<Checkbox checked={queryState.withoutMetadata} disabled={queryState.onlyWithMetadata} onChange={(_e, value) => updateQueryState({ withoutMetadata: value })} />}
                label="Тільки без метаданих"
                sx={compactCheckboxLabelSx}
              />
            </Stack>
          </FilterSection>

          <FilterSection
            title="Підрозділи"
            countLabel={sectionCountLabel(unitsSelectedCount, counts?.unitsCount ?? options.units.length)}
            expanded={expandedSections.units}
            onToggle={() => toggleSection('units')}
            onLoad={() => void loadFilterSectionWithSpinner('units')}
          >
            <Stack spacing={1.25}>
              <AnalysisFilterField
                label="Підрозділи"
                options={unitsOptions}
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
                  onChange={(event) =>
                    updateQueryState({
                      unitsExactMatchOnly: unitsExactMatchStateFromMode(event.target.value as UnitsExactMatchMode),
                    })
                  }
                >
                  <MenuItem value="default">За замовчуванням</MenuItem>
                  <MenuItem value="exact">Точний збіг</MenuItem>
                  <MenuItem value="non-exact">Неточний збіг</MenuItem>
                </Select>
              </FormControl>
            </Stack>
          </FilterSection>

          <FilterSection
            title="Позивні"
            countLabel={sectionCountLabel(callsignsSelectedCount, counts?.callsignsCount ?? options.callsigns.length)}
            expanded={expandedSections.callsigns}
            onToggle={() => toggleSection('callsigns')}
            onLoad={() => void loadFilterSectionWithSpinner('callsigns')}
          >
            <AnalysisFilterField
              label="Позивні"
              options={callsignsOptions}
              loading={isSectionLoading('callsigns')}
              value={queryState.callsignsSelected}
              onChange={(callsignsSelected) => updateQueryState({ callsignsSelected })}
            />
          </FilterSection>

          <FilterSection
            title="Пости"
            countLabel={sectionCountLabel(postsSelectedCount, counts?.postsCount ?? options.posts.length)}
            expanded={expandedSections.posts}
            onToggle={() => toggleSection('posts')}
            onLoad={() => void loadFilterSectionWithSpinner('posts')}
          >
            <Stack spacing={1.25}>
              <AnalysisFilterField
                label="Пости"
                options={postsOptions}
                loading={isSectionLoading('posts')}
                value={queryState.postsSelected}
                onChange={(postsSelected) => updateQueryState({ postsSelected })}
              />
            </Stack>
          </FilterSection>

          <FilterSection
            title="Смуги"
            countLabel={sectionCountLabel(aorsSelectedCount, counts?.aorsCount ?? options.aors.length)}
            expanded={expandedSections.aors}
            onToggle={() => toggleSection('aors')}
            onLoad={() => void loadFilterSectionWithSpinner('aors')}
          >
            <AnalysisFilterField
              label="Смуги"
              options={aorOptions}
              loading={isSectionLoading('aors')}
              value={queryState.aorsSelected}
              onChange={(aorsSelected) => updateQueryState({ aorsSelected })}
            />
          </FilterSection>

          <FilterSection
            title="Теги"
            countLabel={sectionCountLabel(tagsSelectedCount, counts?.tagsCount ?? options.tags.length)}
            expanded={expandedSections.tags}
            onToggle={() => toggleSection('tags')}
            onLoad={() => void loadFilterSectionWithSpinner('tags')}
          >
            <Stack spacing={1.25}>
              <AnalysisFilterField
                label="Теги"
                options={tagOptions}
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
                  control={<Checkbox checked={queryState.withoutModelTags} onChange={(_e, value) => updateQueryState({ withoutModelTags: value })} />}
                  label="Без відміток роботами"
                  sx={compactCheckboxLabelSx}
                />
                <FormControlLabel
                  control={<Checkbox checked={queryState.reportTagsOnlyThisUnit} onChange={(_e, value) => updateQueryState({ reportTagsOnlyThisUnit: value })} />}
                  label="Лише теги мого підрозділу"
                  sx={compactCheckboxLabelSx}
                />
              </Stack>
            </Stack>
          </FilterSection>

          <FilterSection
            title="Частоти"
            countLabel={sectionCountLabel(freqsSelectedCount, counts?.freqsCount ?? options.freqs.length)}
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
                control={<Checkbox checked={includeOnlyNewFreqs} onChange={(_e, value) => setIncludeOnlyNewFreqs(value)} />}
                label="Тільки нові частоти"
                sx={compactCheckboxLabelSx}
              />
            </Stack>
          </FilterSection>
        </Box>
        <Divider />
        <AnalysisSavedFiltersCard
          isDirty={isDirty}
          loadedSavedFilter={loadedSavedFilter}
          saveInFlight={saveInFlight}
          savedFilterName={savedFilterName}
          savedFilters={savedFilters}
          onApplySavedFilter={applySavedFilter}
          onDeleteLoadedSavedFilter={deleteLoadedSavedFilter}
          onRenameExisting={renameExistingSavedFilter}
          onSaveAsNew={saveAsNew}
          onSavedFilterNameChange={setSavedFilterName}
          onUpdateExisting={updateExisting}
        />
      </Stack>
    </Paper>
  );
}
