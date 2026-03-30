import SearchIcon from '@mui/icons-material/Search';
import {
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
  Switch,
  TextField,
  Typography,
} from '@mui/material';

import type { AnalysisPageActions, AnalysisPageState } from '../types';
import { APP_DATE_INPUT_MIN } from '../../../utils/misc';
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

export function AnalysisFiltersPanel({
  isDirty,
  counts,
  canResetFilters,
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
  const unitsExactMatchHint =
    counts == null
      ? null
      : queryState.unitsExactMatchOnly
        ? `неточних збігів: ${counts.unitsNonExactMatchesCount}`
        : `точних збігів: ${counts.unitsExactMatchesCount}`;

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2,
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
      <Stack spacing={2}>
        <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="space-between">
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            Фільтри
          </Typography>
          <Button
            variant="outlined"
            color="inherit"
            size="small"
            onClick={resetFilters}
            disabled={!canResetFilters}
            sx={{ flexShrink: 0 }}
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
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
        <AnalysisFilterField
          label="Смуги"
          options={options.aors}
          value={queryState.aorsSelected}
          onChange={(aorsSelected) => updateQueryState({ aorsSelected })}
        />
        <AnalysisFilterField
          label="Групи"
          options={options.groups}
          value={queryState.groupsSelected}
          onChange={(groupsSelected) => updateQueryState({ groupsSelected })}
        />
        <AnalysisFilterField
          label="Відправники"
          options={options.senders}
          value={queryState.sendersSelected}
          onChange={(sendersSelected) => updateQueryState({ sendersSelected })}
        />
        <AnalysisFilterField
          label="Частоти"
          options={options.freqs}
          disabled={includeOnlyNewFreqs}
          value={queryState.freqsSelected}
          onChange={(freqsSelected) => updateQueryState({ freqsSelected })}
        />
        <AnalysisFilterField
          label="Позивні"
          options={options.callsigns}
          value={queryState.callsignsSelected}
          onChange={(callsignsSelected) => updateQueryState({ callsignsSelected })}
        />
        <AnalysisFilterField
          label="Підрозділи"
          options={options.units}
          value={queryState.unitsSelected}
          onChange={(unitsSelected) => updateQueryState({ unitsSelected })}
        />
        <AnalysisFilterField
          label="Локації"
          options={options.locations}
          value={queryState.locationsSelected}
          onChange={(locationsSelected) => updateQueryState({ locationsSelected })}
        />
        <AnalysisFilterField
          label="Пости"
          options={options.posts}
          value={queryState.postsSelected}
          onChange={(postsSelected) => updateQueryState({ postsSelected })}
        />
        <AnalysisFilterField
          label="Мережі"
          options={options.networks}
          disabled={queryState.withoutNetwork}
          value={queryState.networksSelected}
          onChange={(networksSelected) => updateQueryState({ networksSelected })}
        />
        <AnalysisFilterField
          label="Теги"
          options={Object.entries(tagsMap).map(([tagId, tag]) => `${tag.label}::${tagId}`)}
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
        <AnalysisFilterField
          label="Метадані CC"
          options={options.metadataCcs}
          disabled={queryState.withoutMetadata}
          value={queryState.metadataCc}
          onChange={(metadataCc) => updateQueryState({ metadataCc })}
        />
        <AnalysisFilterField
          label="Метадані відправника"
          options={options.metadataSenders}
          disabled={queryState.withoutMetadata}
          value={queryState.metadataSender}
          onChange={(metadataSender) => updateQueryState({ metadataSender })}
        />
        <AnalysisFilterField
          label="Метадані отримувача"
          options={options.metadataReceivers}
          disabled={queryState.withoutMetadata}
          value={queryState.metadataReceiver}
          onChange={(metadataReceiver) => updateQueryState({ metadataReceiver })}
        />
        <AnalysisFilterField
          label="Хеш метаданих"
          options={options.metadataHashes}
          disabled={queryState.withoutMetadata}
          value={queryState.metadataHash}
          onChange={(metadataHash) => updateQueryState({ metadataHash })}
        />
        <Stack spacing={1.5}>
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
          <FormControl size="small">
            <InputLabel id="analysis-adjacent-range-label">Суміжні частоти</InputLabel>
            <Select
              labelId="analysis-adjacent-range-label"
              label="Суміжні частоти"
              value={String(queryState.adjacentFreqsRange)}
              onChange={(event) => updateQueryState({ adjacentFreqsRange: Number(event.target.value) })}
            >
              {[0, 0.0005, 0.002, 0.005].map((value) => (
                <MenuItem key={value} value={String(value)}>
                  {value === 0 ? 'Не додавати' : `${value * 1000} кГц`}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControlLabel
            control={<Switch checked={queryState.orWithExtendedForm} onChange={(_e, value) => updateQueryState({ orWithExtendedForm: value })} />}
            label="З нотаткою"
          />
          <FormControlLabel
            control={<Switch checked={queryState.orBookmarked} onChange={(_e, value) => updateQueryState({ orBookmarked: value })} />}
            label="Збережені"
          />
          <FormControlLabel
            control={<Switch checked={queryState.orImportant} onChange={(_e, value) => updateQueryState({ orImportant: value })} />}
            label="Важливі"
          />
          <FormControlLabel
            control={<Switch checked={queryState.orWithCoords} onChange={(_e, value) => updateQueryState({ orWithCoords: value })} />}
            label="З пеленгом"
          />
          <FormControlLabel
            control={<Switch checked={queryState.includePelengLocations} onChange={(_e, value) => updateQueryState({ includePelengLocations: value })} />}
            label="Включати пеленг-локації"
          />
          <FormControlLabel
            control={<Switch checked={queryState.withoutNetwork} onChange={(_e, value) => updateQueryState({ withoutNetwork: value })} />}
            label="Тільки без мережі"
          />
          <FormControlLabel
            control={<Switch checked={queryState.onlyWithMetadata} disabled={queryState.withoutMetadata} onChange={(_e, value) => updateQueryState({ onlyWithMetadata: value })} />}
            label="Тільки з метаданими"
          />
          <FormControlLabel
            control={<Switch checked={queryState.withoutMetadata} disabled={queryState.onlyWithMetadata} onChange={(_e, value) => updateQueryState({ withoutMetadata: value })} />}
            label="Тільки без метаданих"
          />
          <FormControlLabel
            control={<Switch checked={queryState.withoutModelTags} onChange={(_e, value) => updateQueryState({ withoutModelTags: value })} />}
            label="Без відміток роботами"
          />
          <FormControlLabel
            control={<Checkbox checked={queryState.reportTagsOnlyThisUnit} onChange={(_e, value) => updateQueryState({ reportTagsOnlyThisUnit: value })} />}
            label="Лише теги мого підрозділу"
          />
          <FormControlLabel
            control={<Checkbox checked={queryState.unitsExactMatchOnly ?? true} onChange={(_e, value) => updateQueryState({ unitsExactMatchOnly: value })} />}
            label={
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.75, py: 0.25 }}>
                <span>Точний збіг за еталонкою</span>
                {unitsExactMatchHint ? (
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
                      padding: '3px 8px',
                    }}
                  >
                    {unitsExactMatchHint}
                  </span>
                ) : null}
              </Box>
            }
            sx={{
              alignItems: 'flex-start',
              m: 0,
              '& .MuiFormControlLabel-label': {
                paddingTop: '2px',
              },
            }}
          />
          <FormControlLabel
            control={<Checkbox checked={includeOnlyNewFreqs} onChange={(_e, value) => setIncludeOnlyNewFreqs(value)} />}
            label="Тільки нові частоти"
          />
        </Stack>
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
