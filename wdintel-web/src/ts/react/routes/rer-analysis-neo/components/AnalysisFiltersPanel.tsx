import SearchIcon from '@mui/icons-material/Search';
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
  InputAdornment,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import type { ReactNode } from 'react';

import type { AnalysisPageActions, AnalysisPageState } from '../types';
import { APP_DATE_INPUT_MIN, uppercaseStrings } from '../../../utils/misc';
import { AnalysisFilterField } from './AnalysisFilterField';
import { AnalysisSavedFiltersCard } from './AnalysisSavedFiltersCard';

type Props = Pick<
  AnalysisPageState,
  | 'isDirty'
  | 'counts'
  | 'canResetFilters'
  | 'includeOnlyNewFreqs'
  | 'loadedSavedFilter'
  | 'options'
  | 'filtersLoading'
  | 'groupInfos'
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
  minHeight: 36,
  alignItems: 'center',
  '& .MuiFormControlLabel-label': {
    lineHeight: 1.3,
  },
};

type FilterSectionProps = {
  title: string;
  expanded: boolean;
  onToggle: () => void;
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

function getInitialExpandedSections(queryState: AnalysisPageState['queryState']): Record<FilterSectionId, boolean> {
  return {
    ...defaultExpandedSections,
    important:
      defaultExpandedSections.important ||
      queryState.orWithExtendedForm ||
      queryState.orBookmarked ||
      queryState.orImportant ||
      queryState.orWithCoords,
    tags:
      queryState.tags.length > 0 ||
      queryState.filterTagsOption !== 'OneOfTags' ||
      queryState.withoutModelTags ||
      queryState.reportTagsOnlyThisUnit,
    networks: queryState.networksSelected.length > 0 || queryState.withoutNetwork,
    aors: queryState.aorsSelected.length > 0,
    groups: queryState.groupsSelected.length > 0,
    senders: queryState.sendersSelected.length > 0,
    freqs:
      queryState.freqsSelected.length > 0 ||
      queryState.adjacentFreqsRange > 0 ||
      queryState.includeOnlyNewFreqs,
    callsigns: queryState.callsignsSelected.length > 0,
    units: queryState.unitsSelected.length > 0 || queryState.unitsExactMatchOnly !== null,
    locations: queryState.locationsSelected.length > 0 || queryState.includePelengLocations === false,
    posts: queryState.postsSelected.length > 0,
    metadata:
      queryState.metadataCc.length > 0 ||
      queryState.metadataSender.length > 0 ||
      queryState.metadataReceiver.length > 0 ||
      queryState.metadataHash.length > 0 ||
      queryState.onlyWithMetadata ||
      queryState.withoutMetadata,
  };
}

function FilterSection({ title, expanded, onToggle, children }: FilterSectionProps) {
  return (
    <Accordion
      expanded={expanded}
      onChange={onToggle}
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
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
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
  updateExisting,
  updateQueryState,
}: Props) {
  const [expandedSections, setExpandedSections] = useState(() => getInitialExpandedSections(queryState));

  const unitsExactMatchHint =
    counts == null
      ? null
      : queryState.unitsExactMatchOnly == null
        ? 'режим: серверний дефолт'
        : queryState.unitsExactMatchOnly
        ? `неточних збігів: ${counts.unitsNonExactMatchesCount}`
        : `точних збігів: ${counts.unitsExactMatchesCount}`;

  const toggleSection = (section: FilterSectionId) => {
    setExpandedSections((current) => ({ ...current, [section]: !current[section] }));
  };

  const callsignValues = Array.from(new Set([...options.callsigns, ...queryState.callsignsSelected]));
  const callsignLabels = uppercaseStrings(callsignValues);
  const callsignsOptions = callsignValues.reduce<Array<{ value: string; label: string; values: string[] }>>((acc, callsign, index) => {
    const label = callsignLabels[index] ?? callsign;
    const existingOption = acc.find((option) => option.label === label);
    if (existingOption != null) {
      existingOption.values.push(callsign);
      return acc;
    }
    acc.push({ value: label, label, values: [callsign] });
    return acc;
  }, []);
  const groupOptions = options.groups
    .map((masterKey) => ({ value: masterKey, label: groupInfos[masterKey]?.name ?? masterKey }))
    .sort((a, b) => a.label.localeCompare(b.label));

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
        <Stack
          direction="row"
          spacing={2}
          alignItems="center"
          justifyContent="space-between"
          sx={{ pt: 0.5, pb: 1 }}
        >
          <Typography variant="subtitle1" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
            Фільтри
          </Typography>
          <Button
            variant="outlined"
            color="inherit"
            size="small"
            onClick={resetFilters}
            disabled={!canResetFilters}
            sx={{ flexShrink: 0, px: 1.75, py: 0.75 }}
          >
            Скинути
          </Button>
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
          <TextField
            label="Дата від"
            type="date"
            size="small"
            InputLabelProps={{ shrink: true }}
            value={queryState.dateFromStr}
            slotProps={{ htmlInput: { min: APP_DATE_INPUT_MIN } }}
            onChange={(event) => updateQueryState({ dateFromStr: event.target.value })}
            sx={{ flex: 1, minWidth: 0 }}
          />
          <TextField
            label="Час від"
            type="time"
            size="small"
            InputLabelProps={{ shrink: true }}
            value={queryState.timeFromStr}
            onChange={(event) => updateQueryState({ timeFromStr: event.target.value })}
            sx={{ flex: 1, minWidth: 0 }}
          />
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
          <TextField
            label="Дата до"
            type="date"
            size="small"
            InputLabelProps={{ shrink: true }}
            value={queryState.dateToStr}
            slotProps={{ htmlInput: { min: APP_DATE_INPUT_MIN } }}
            onChange={(event) => updateQueryState({ dateToStr: event.target.value })}
            sx={{ flex: 1, minWidth: 0 }}
          />
          <TextField
            label="Час до"
            type="time"
            size="small"
            InputLabelProps={{ shrink: true }}
            value={queryState.timeToStr}
            onChange={(event) => updateQueryState({ timeToStr: event.target.value })}
            sx={{ flex: 1, minWidth: 0 }}
          />
        </Stack>
        <TextField
          label="Пошук"
          size="small"
          value={queryState.search}
          onChange={(event) => updateQueryState({ search: event.target.value })}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
        <Box>
          <FilterSection title="Важливе" expanded={expandedSections.important} onToggle={() => toggleSection('important')}>
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
              control={<Checkbox checked={queryState.orImportant} onChange={(_e, value) => updateQueryState({ orImportant: value })} />}
              label="Важливі"
              sx={compactCheckboxLabelSx}
            />
            <FormControlLabel
              control={<Checkbox checked={queryState.orWithCoords} onChange={(_e, value) => updateQueryState({ orWithCoords: value })} />}
              label="З пеленгом"
              sx={compactCheckboxLabelSx}
            />
          </FilterSection>

          <FilterSection title="Теги" expanded={expandedSections.tags} onToggle={() => toggleSection('tags')}>
            <AnalysisFilterField
              label="Теги"
              options={Object.entries(tagsMap).map(([tagId, tag]) => `${tag.label}::${tagId}`)}
              loading={filtersLoading}
              value={queryState.tags.map((tagId) => {
                const tag = tagsMap[tagId];
                return tag ? `${tag.label}::${tagId}` : String(tagId);
              })}
              onChange={(next) =>
                updateQueryState({
                  tags: next.map((item) => Number(item.split('::').at(-1))).filter((tagId) => Number.isFinite(tagId)),
                })
              }
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
          </FilterSection>

          <FilterSection title="Мережі" expanded={expandedSections.networks} onToggle={() => toggleSection('networks')}>
            <AnalysisFilterField
              label="Мережі"
              options={options.networks}
              disabled={queryState.withoutNetwork}
              loading={filtersLoading}
              value={queryState.networksSelected}
              onChange={(networksSelected) => updateQueryState({ networksSelected })}
            />
            <FormControlLabel
              control={<Checkbox checked={queryState.withoutNetwork} onChange={(_e, value) => updateQueryState({ withoutNetwork: value })} />}
              label="Тільки без мережі"
              sx={compactCheckboxLabelSx}
            />
          </FilterSection>

          <FilterSection title="Смуги" expanded={expandedSections.aors} onToggle={() => toggleSection('aors')}>
            <AnalysisFilterField
              label="Смуги"
              options={options.aors}
              loading={filtersLoading}
              value={queryState.aorsSelected}
              onChange={(aorsSelected) => updateQueryState({ aorsSelected })}
            />
          </FilterSection>

          <FilterSection title="Групи" expanded={expandedSections.groups} onToggle={() => toggleSection('groups')}>
            <AnalysisFilterField
              label="Групи"
              options={groupOptions}
              loading={filtersLoading}
              value={queryState.groupsSelected}
              onChange={(groupsSelected) => updateQueryState({ groupsSelected })}
            />
          </FilterSection>

          <FilterSection title="Відправники" expanded={expandedSections.senders} onToggle={() => toggleSection('senders')}>
            <AnalysisFilterField
              label="Відправники"
              options={options.senders}
              loading={filtersLoading}
              value={queryState.sendersSelected}
              onChange={(sendersSelected) => updateQueryState({ sendersSelected })}
            />
          </FilterSection>

          <FilterSection title="Частоти" expanded={expandedSections.freqs} onToggle={() => toggleSection('freqs')}>
            <AnalysisFilterField
              label="Частоти"
              options={options.freqs}
              disabled={includeOnlyNewFreqs}
              loading={filtersLoading}
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
            />
          </FilterSection>

          <FilterSection title="Позивні" expanded={expandedSections.callsigns} onToggle={() => toggleSection('callsigns')}>
            <AnalysisFilterField
              label="Позивні"
              options={callsignsOptions}
              loading={filtersLoading}
              value={queryState.callsignsSelected}
              onChange={(callsignsSelected) => updateQueryState({ callsignsSelected })}
            />
          </FilterSection>

          <FilterSection title="Підрозділи" expanded={expandedSections.units} onToggle={() => toggleSection('units')}>
            <AnalysisFilterField
              label="Підрозділи"
              options={options.units}
              loading={filtersLoading}
              value={queryState.unitsSelected}
              onChange={(unitsSelected) => updateQueryState({ unitsSelected })}
            />
            <Box>
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
                  <MenuItem value="default">Серверний дефолт</MenuItem>
                  <MenuItem value="exact">Точний збіг</MenuItem>
                  <MenuItem value="non-exact">Неточний збіг</MenuItem>
                </Select>
              </FormControl>
              {unitsExactMatchHint ? (
                <Box sx={{ pl: 0.5, pt: 0.5 }}>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      borderRadius: 999,
                      border: '1px solid rgba(245, 158, 11, 0.4)',
                      background: '#fef3c7',
                      color: '#92400e',
                      fontSize: 11,
                      fontWeight: 600,
                      lineHeight: 1,
                      padding: '4px 10px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {unitsExactMatchHint}
                  </span>
                </Box>
              ) : null}
            </Box>
          </FilterSection>

          <FilterSection title="Локації" expanded={expandedSections.locations} onToggle={() => toggleSection('locations')}>
            <AnalysisFilterField
              label="Локації"
              options={options.locations}
              loading={filtersLoading}
              value={queryState.locationsSelected}
              onChange={(locationsSelected) => updateQueryState({ locationsSelected })}
            />
            <FormControlLabel
              control={<Checkbox checked={queryState.includePelengLocations} onChange={(_e, value) => updateQueryState({ includePelengLocations: value })} />}
              label="Включати пеленг-локації"
              sx={compactCheckboxLabelSx}
            />
          </FilterSection>

          <FilterSection title="Пости" expanded={expandedSections.posts} onToggle={() => toggleSection('posts')}>
            <AnalysisFilterField
              label="Пости"
              options={options.posts}
              loading={filtersLoading}
              value={queryState.postsSelected}
              onChange={(postsSelected) => updateQueryState({ postsSelected })}
            />
          </FilterSection>

          <FilterSection title="Метадані" expanded={expandedSections.metadata} onToggle={() => toggleSection('metadata')}>
            <AnalysisFilterField
              label="Метадані CC"
              options={options.metadataCcs}
              disabled={queryState.withoutMetadata}
              loading={filtersLoading}
              value={queryState.metadataCc}
              onChange={(metadataCc) => updateQueryState({ metadataCc })}
            />
            <AnalysisFilterField
              label="Метадані відправника"
              options={options.metadataSenders}
              disabled={queryState.withoutMetadata}
              loading={filtersLoading}
              value={queryState.metadataSender}
              onChange={(metadataSender) => updateQueryState({ metadataSender })}
            />
            <AnalysisFilterField
              label="Метадані отримувача"
              options={options.metadataReceivers}
              disabled={queryState.withoutMetadata}
              loading={filtersLoading}
              value={queryState.metadataReceiver}
              onChange={(metadataReceiver) => updateQueryState({ metadataReceiver })}
            />
            <AnalysisFilterField
              label="Хеш метаданих"
              options={options.metadataHashes}
              disabled={queryState.withoutMetadata}
              loading={filtersLoading}
              value={queryState.metadataHash}
              onChange={(metadataHash) => updateQueryState({ metadataHash })}
            />
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
