import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import { Badge, Box, Button, CircularProgress, Divider, Paper, Stack, Typography, useMediaQuery } from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '@mui/material/styles';

import { PowerChip } from '../../../components/PowerChip';
import type { AnalysisFilterSectionId } from '../types';
import { AnalysisSavedFiltersCard } from './AnalysisSavedFiltersCard';
import { buildAnalysisFiltersPanelDerivedData } from './analysis-filters-panel-derived';
import { AnalysisFiltersPanelSections } from './analysis-filters-panel-sections';
import { getInitialExpandedSections, type AnalysisFiltersPanelProps, type FilterSectionId } from './analysis-filters-panel-shared';

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
}: AnalysisFiltersPanelProps) {
  const theme = useTheme();
  const isMobileLayout = useMediaQuery(theme.breakpoints.down('sm'));
  const [expandedSections, setExpandedSections] = useState(() => getInitialExpandedSections());
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [loadingSections, setLoadingSections] = useState<Partial<Record<FilterSectionId, boolean>>>({});
  const prevFiltersLoadingRef = useRef(filtersLoading);

  const derived = useMemo(
    () =>
      buildAnalysisFiltersPanelDerivedData({
        aorEntries,
        counts,
        groupInfos,
        options,
        queryState,
        tagsMap,
      }),
    [aorEntries, counts, groupInfos, options, queryState, tagsMap],
  );

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
    maybeReload('metadata', expandedSections.metadata, derived.metadataOptionsCount);
  }, [
    derived.metadataOptionsCount,
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
    loadFilterSectionWithSpinner,
    options.aors.length,
    options.callsigns.length,
    options.groups.length,
    options.locations.length,
    options.networks.length,
    options.posts.length,
    options.senders.length,
    options.tags.length,
    options.units.length,
  ]);

  useEffect(() => {
    setMobileExpanded(!isMobileLayout);
  }, [isMobileLayout]);

  const isSectionLoading = (section: FilterSectionId): boolean => loadingSections[section] === true;
  const showCompactToggle = isMobileLayout;
  const showFilterContent = !showCompactToggle || mobileExpanded;

  return (
    <Paper
      variant="outlined"
      sx={{
        p: { xs: 1, lg: 1.5 },
        overflow: { xs: 'hidden', sm: 'auto' },
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
      <Stack spacing={1.5} sx={{ flex: 1, minHeight: 0 }}>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          justifyContent="space-between"
          sx={{ py: 0.5, minWidth: 0 }}
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
                  <FilterAltOutlinedIcon sx={{ fontSize: 18 }} />
                </Badge>
              }
              endIcon={showFilterContent ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
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
            <Typography
              variant="subtitle1"
              sx={{ fontWeight: 600, lineHeight: 1.2 }}
            >
              Фільтри
            </Typography>
          )}
          <Button size="small" onClick={resetFilters} disabled={!canResetFilters} sx={{ flexShrink: 0 }}>
            Скинути
          </Button>
        </Stack>

        {showFilterContent ? (
          showCompactToggle ? (
            <Box
              sx={{
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                overflowY: 'auto',
                overflowX: 'hidden',
                overscrollBehavior: 'contain',
                WebkitOverflowScrolling: 'touch',
                pr: 0.25,
                pb: 0.5,
              }}
            >
              <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                {loadedSavedFilter ? (
                  <PowerChip
                    label={loadedSavedFilter.name}
                    selected
                    color="default"
                    sx={{ alignSelf: 'flex-start', mb: 1 }}
                    title={`Збережений фільтр: ${loadedSavedFilter.name}`}
                  />
                ) : null}

                <AnalysisFiltersPanelSections
                  counts={counts}
                  derived={derived}
                  expandedSections={expandedSections}
                  includeOnlyNewFreqs={includeOnlyNewFreqs}
                  filtersLoading={filtersLoading}
                  isSectionLoading={isSectionLoading}
                  loadingIndicator={<CircularProgress size={14} thickness={5} />}
                  loadFilterSectionWithSpinner={loadFilterSectionWithSpinner}
                  options={options}
                  queryState={queryState}
                  setIncludeOnlyNewFreqs={setIncludeOnlyNewFreqs}
                  toggleSection={toggleSection}
                  updateQueryState={updateQueryState}
                />
              </Box>

              <Divider sx={{ my: 1, flexShrink: 0 }} />

              <Box sx={{ display: 'flex', flexDirection: 'column', flexShrink: 0, pb: 1.5 }}>
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
              </Box>
            </Box>
          ) : (
            <>
              <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                {loadedSavedFilter ? (
                  <PowerChip
                    label={loadedSavedFilter.name}
                    selected
                    color="default"
                    sx={{ alignSelf: 'flex-start', mb: 1 }}
                    title={`Збережений фільтр: ${loadedSavedFilter.name}`}
                  />
                ) : null}

                <AnalysisFiltersPanelSections
                  counts={counts}
                  derived={derived}
                  expandedSections={expandedSections}
                  includeOnlyNewFreqs={includeOnlyNewFreqs}
                  filtersLoading={filtersLoading}
                  isSectionLoading={isSectionLoading}
                  loadingIndicator={<CircularProgress size={14} thickness={5} />}
                  loadFilterSectionWithSpinner={loadFilterSectionWithSpinner}
                  options={options}
                  queryState={queryState}
                  setIncludeOnlyNewFreqs={setIncludeOnlyNewFreqs}
                  toggleSection={toggleSection}
                  updateQueryState={updateQueryState}
                />
              </Box>

              <Divider sx={{ my: 1.25 }} />

              <Box sx={{ pb: 1.5 }}>
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
              </Box>
            </>
          )
        ) : null}
      </Stack>
    </Paper>
  );
}
