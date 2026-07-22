import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import { Badge, Box, Button, Divider, Paper, Stack, Typography } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';

import { PowerChip } from '../../../components/PowerChip';
import { AnalysisSavedFiltersCard } from './AnalysisSavedFiltersCard';
import { buildAnalysisFiltersPanelDerivedData } from './analysis-filters-panel-derived';
import { AnalysisFiltersPanelSections } from './analysis-filters-panel-sections';
import {
  getInitialExpandedSections,
  type AnalysisFiltersPanelProps,
  type FilterSectionId,
} from './analysis-filters-panel-shared';

export function AnalysisFiltersPanel({ page, isCompactLayout = false }: AnalysisFiltersPanelProps) {
  const {
    isDirty,
    counts,
    canResetFilters,
    aorEntries,
    countsLoading,
    filtersLoading,
    isFilterSectionEmptyLoading,
    isFilterSectionLoading,
    isFilterSectionStale,
    groupInfos,
    includeOnlyNewFreqs,
    loadedSavedFilter,
    messagesOverallCount,
    messagesTotalCount,
    messagesTotalLoading,
    options,
    queryState,
    unitsExactMatchOnlyDefault,
    saveInFlight,
    savedFilterName,
    savedFilters,
    tagsMap,
    tagsOrder,
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
  } = page;
  const [expandedSections, setExpandedSections] = useState(() => getInitialExpandedSections());
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const derived = useMemo(
    () =>
      buildAnalysisFiltersPanelDerivedData({
        aorEntries,
        counts,
        groupInfos,
        options,
        queryState,
        tagsMap,
        tagsOrder,
      }),
    [aorEntries, counts, groupInfos, options, queryState, tagsMap, tagsOrder],
  );

  const toggleSection = (section: FilterSectionId) => {
    setExpandedSections((current) => ({ ...current, [section]: !current[section] }));
  };

  useEffect(() => {
    setMobileExpanded(!isCompactLayout);
  }, [isCompactLayout]);

  const showCompactToggle = isCompactLayout;
  const showFilterContent = !showCompactToggle || mobileExpanded;

  return (
    <Paper
      variant="outlined"
      sx={{
        px: { xs: 1, lg: 1.5 },
        pb: { xs: 0, lg: 1.5 },
        pt: 0,
        overflow: { xs: 'visible', lg: 'auto' },
        minHeight: 0,
        height: { xs: 'auto', lg: '100%' },
        display: 'flex',
        flexDirection: 'column',
        border: 'none',
        borderRadius: 0,
        boxShadow: 'none',
        backgroundColor: 'transparent',
      }}
    >
      <Stack spacing={1.5} sx={{ minHeight: 0, flex: { lg: 1 } }}>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          justifyContent="space-between"
          sx={{ pt: 0, pb: 0.5, minWidth: 0 }}
        >
          {showCompactToggle ? (
            <Button
              size="small"
              onClick={() => {
                setMobileExpanded((current) => !current);
              }}
              aria-expanded={showFilterContent}
              aria-label={showFilterContent ? 'Згорнути фільтри' : 'Розгорнути фільтри'}
              startIcon={
                <Badge color="error" variant="dot" invisible={!canResetFilters}>
                  <FilterAltIcon sx={{ fontSize: 18 }} />
                </Badge>
              }
              endIcon={
                showFilterContent ? (
                  <ExpandLessIcon fontSize="small" />
                ) : (
                  <ExpandMoreIcon fontSize="small" />
                )
              }
              sx={{
                flexShrink: 1,
                minWidth: 0,
                justifyContent: 'flex-start',
                whiteSpace: 'nowrap',
                textTransform: 'none',
              }}
            >
              Фільтри
            </Button>
          ) : (
            <Typography variant="subtitle1" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
              Фільтри
            </Typography>
          )}
          <Typography
            variant="body2"
            role="status"
            aria-live="polite"
            sx={{ fontWeight: 600, whiteSpace: 'nowrap', px: 0.5 }}
          >
            {!messagesTotalLoading && messagesTotalCount !== null && messagesOverallCount !== null
              ? `${messagesTotalCount} з ${messagesOverallCount}`
              : '— з —'}
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

        {showFilterContent ? (
          showCompactToggle ? (
            <Box
              sx={{
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                overflowY: 'visible',
                overflowX: 'hidden',
                overscrollBehavior: 'contain',
                WebkitOverflowScrolling: 'touch',
                pr: 0.25,
                pb: 0.5,
              }}
            >
              <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                <AnalysisFiltersPanelSections
                  counts={counts}
                  countsLoading={countsLoading}
                  derived={derived}
                  expandedSections={expandedSections}
                  includeOnlyNewFreqs={includeOnlyNewFreqs}
                  filtersLoading={filtersLoading}
                  isFilterSectionEmptyLoading={isFilterSectionEmptyLoading}
                  isFilterSectionLoading={isFilterSectionLoading}
                  isFilterSectionStale={isFilterSectionStale}
                  loadFilterSection={loadFilterSection}
                  options={options}
                  queryState={queryState}
                  unitsExactMatchOnlyDefault={unitsExactMatchOnlyDefault}
                  setIncludeOnlyNewFreqs={setIncludeOnlyNewFreqs}
                  toggleSection={toggleSection}
                  updateQueryState={updateQueryState}
                />
              </Box>

              <Divider sx={{ my: 1, flexShrink: 0 }} />

              <Box sx={{ display: 'flex', flexDirection: 'column', flexShrink: 0, pb: 1.5 }}>
                {loadedSavedFilter ? (
                  <Stack
                    direction="row"
                    spacing={0.75}
                    alignItems="center"
                    sx={{ alignSelf: 'flex-start', mb: 1 }}
                  >
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      Обраний фільтр:
                    </Typography>
                    <PowerChip
                      label={loadedSavedFilter.name}
                      selected
                      color="default"
                      title={`Збережений фільтр: ${loadedSavedFilter.name}`}
                    />
                  </Stack>
                ) : null}
                <AnalysisSavedFiltersCard
                  canSaveAsNew={canResetFilters}
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
              </Box>
            </Box>
          ) : (
            <>
              <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                <AnalysisFiltersPanelSections
                  counts={counts}
                  countsLoading={countsLoading}
                  derived={derived}
                  expandedSections={expandedSections}
                  includeOnlyNewFreqs={includeOnlyNewFreqs}
                  filtersLoading={filtersLoading}
                  isFilterSectionEmptyLoading={isFilterSectionEmptyLoading}
                  isFilterSectionLoading={isFilterSectionLoading}
                  isFilterSectionStale={isFilterSectionStale}
                  loadFilterSection={loadFilterSection}
                  options={options}
                  queryState={queryState}
                  unitsExactMatchOnlyDefault={unitsExactMatchOnlyDefault}
                  setIncludeOnlyNewFreqs={setIncludeOnlyNewFreqs}
                  toggleSection={toggleSection}
                  updateQueryState={updateQueryState}
                />
              </Box>

              <Divider sx={{ my: 1.25 }} />

              <Box sx={{ pb: 1.5 }}>
                {loadedSavedFilter ? (
                  <Stack
                    direction="row"
                    spacing={0.75}
                    alignItems="center"
                    sx={{ alignSelf: 'flex-start', mb: 1 }}
                  >
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      Обраний фільтр:
                    </Typography>
                    <PowerChip
                      label={loadedSavedFilter.name}
                      selected
                      color="default"
                      title={`Збережений фільтр: ${loadedSavedFilter.name}`}
                    />
                  </Stack>
                ) : null}
                <AnalysisSavedFiltersCard
                  canSaveAsNew={canResetFilters}
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
              </Box>
            </>
          )
        ) : null}
      </Stack>
    </Paper>
  );
}
