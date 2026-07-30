import BarChartOutlinedIcon from '@mui/icons-material/BarChartOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import PeopleOutlineOutlinedIcon from '@mui/icons-material/PeopleOutlineOutlined';
import PersonAddOutlinedIcon from '@mui/icons-material/PersonAddOutlined';
import { Box, Tab, Tabs } from '@mui/material';
import { useMemo } from 'react';

import type { AnalysisPageActions, AnalysisPageState } from '../types';
import { sortAndTakeTopAnalysisCountItems } from '../count-items';
import { getAnalysisSidebarTabs } from '../types';
import { AnalysisCallsignsPane } from './AnalysisCallsignsPane';
import { AnalysisMapPane } from './AnalysisMapPane';
import { AnalysisStatsPane } from './AnalysisStatsPane';
import { AnalysisNewCallsignsCard } from './AnalysisNewCallsignsCard';
import { AnalysisRightPanelToggle } from './AnalysisRightPanelToggle';
import {
  addUnitSelection,
  normalizeUnknownUnitFilterValue,
  normalizeUnknownUnitSelections,
  toggleExclusiveUnitSelection,
} from '../../shared/analysis-unit-filter';
import {
  addAnalysisSelection,
  toggleExclusiveAnalysisSelection,
} from '../../shared/analysis-filter-selection';
import { analysisCompactTabsSx } from '../analysis-tab-styles';

type Props = Pick<
  AnalysisPageState,
  | 'callsignGraph'
  | 'callsignGraphLoading'
  | 'callsignGraphLoadVersion'
  | 'callsignGraphLoadError'
  | 'callsignGraphNolimit'
  | 'correlatedFreqs'
  | 'correlatedFreqsLoading'
  | 'groupsActivity'
  | 'groupsActivityLoadedFreq'
  | 'groupsActivityLoadedPeriod'
  | 'groupsActivityPeriod'
  | 'groupsActivityLoading'
  | 'mapAttrs'
  | 'analysisMapInSidebar'
  | 'newCallsigns'
  | 'newCallsignsLoading'
  | 'options'
  | 'rightSidebarLoading'
  | 'queryState'
  | 'rightSidebarTab'
  | 'rightPanelOpen'
  | 'topCallsigns'
  | 'topFreqs'
  | 'topLocations'
  | 'topUnits'
> &
  Pick<
    AnalysisPageActions,
    | 'loadCallsignGraph'
    | 'loadCorrelatedFreqs'
    | 'loadGroupsActivity'
    | 'loadMessagesForMap'
    | 'selectOnlyFreq'
    | 'setRightSidebarTab'
    | 'refreshMapDateRange'
    | 'toggleCallsignGraphNolimit'
    | 'toggleUnitFromMap'
    | 'toggleRightPanel'
    | 'updateQueryState'
  > & { isCompactLayout?: boolean; showNarrowCloseButton?: boolean };

export const analysisSidebarRootSx = {
  minHeight: 0,
  height: '100%',
  overflow: 'hidden',
} as const;

export const analysisSidebarContentSx = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
} as const;

export function AnalysisSidebar({
  callsignGraph,
  callsignGraphLoading,
  callsignGraphLoadVersion,
  callsignGraphLoadError,
  callsignGraphNolimit,
  correlatedFreqs,
  correlatedFreqsLoading,
  groupsActivity,
  groupsActivityLoadedFreq,
  groupsActivityLoadedPeriod,
  groupsActivityPeriod,
  groupsActivityLoading,
  mapAttrs,
  analysisMapInSidebar,
  loadCallsignGraph,
  loadCorrelatedFreqs,
  loadGroupsActivity,
  loadMessagesForMap,
  newCallsigns,
  newCallsignsLoading,
  options,
  rightSidebarLoading,
  queryState,
  rightPanelOpen,
  rightSidebarTab,
  selectOnlyFreq,
  setRightSidebarTab,
  topCallsigns,
  topFreqs,
  topLocations,
  topUnits,
  refreshMapDateRange,
  toggleCallsignGraphNolimit,
  toggleUnitFromMap,
  toggleRightPanel,
  updateQueryState,
  isCompactLayout = false,
  showNarrowCloseButton = true,
}: Props) {
  const isSidebarVisible = rightPanelOpen;
  const sidebarTabs = getAnalysisSidebarTabs(analysisMapInSidebar);
  const sidebarTab = analysisMapInSidebar || rightSidebarTab !== 'map' ? rightSidebarTab : 'stats';
  const keepMapPaneMounted = analysisMapInSidebar && isSidebarVisible;
  const selectUnit = (unit: string) => {
    const normalizedUnits = normalizeUnknownUnitSelections(queryState.unitsSelected);
    const normalizedUnit = normalizeUnknownUnitFilterValue(unit);
    const wasSelected = normalizedUnits.includes(normalizedUnit);
    const unitsSelected = toggleExclusiveUnitSelection(normalizedUnits, normalizedUnit);
    updateQueryState({
      unitsExactMatchOnly:
        unitsSelected.length === 0 ? null : wasSelected ? queryState.unitsExactMatchOnly : false,
      unitsSelected,
    });
  };
  const addUnit = (unit: string) => {
    updateQueryState({
      unitsExactMatchOnly: false,
      unitsSelected: addUnitSelection(queryState.unitsSelected, unit),
    });
  };
  const selectFreq = (freq: string) => {
    updateQueryState({
      freqsSelected: toggleExclusiveAnalysisSelection(queryState.freqsSelected, freq),
      includeOnlyNewFreqs: false,
    });
  };
  const addFreq = (freq: string) => {
    updateQueryState({
      freqsSelected: addAnalysisSelection(queryState.freqsSelected, freq),
      includeOnlyNewFreqs: false,
    });
  };
  const topNetworks = useMemo(
    () =>
      sortAndTakeTopAnalysisCountItems(
        options.networks.map((network) => ({
          key: network.label,
          value: network.value,
          count: network.count,
        })),
      ),
    [options.networks],
  );
  const selectNetwork = (networkId: string) => {
    updateQueryState({
      networksSelected: toggleExclusiveAnalysisSelection(queryState.networksSelected, networkId),
    });
  };
  const addNetwork = (networkId: string) => {
    updateQueryState({
      networksSelected: addAnalysisSelection(queryState.networksSelected, networkId),
    });
  };
  const selectLocation = (location: string) => {
    updateQueryState({
      locationsSelected: toggleExclusiveAnalysisSelection(queryState.locationsSelected, location),
    });
  };
  const addLocation = (location: string) => {
    updateQueryState({
      locationsSelected: addAnalysisSelection(queryState.locationsSelected, location),
    });
  };

  return (
    <Box
      component="aside"
      aria-label="Аналітична бічна панель"
      sx={{
        ...analysisSidebarRootSx,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box
        data-analysis-sidebar-tabs
        sx={{ pt: 0.5, display: 'flex', alignItems: 'center', flexShrink: 0 }}
      >
        <Tabs
          value={sidebarTab ?? false}
          onChange={(_event, value) => setRightSidebarTab(value as (typeof sidebarTabs)[number])}
          variant="scrollable"
          scrollButtons={isCompactLayout ? false : 'auto'}
          aria-label="Вкладки правої панелі аналізу"
          sx={{
            ...analysisCompactTabsSx,
            flex: 1,
            minWidth: 0,
            px: { xs: 0.5, sm: 1 },
            '& .MuiTabs-flexContainer': {
              gap: 0.5,
              alignItems: 'stretch',
            },
            '& .MuiTabs-scroller': {
              px: 0,
            },
            '& .MuiTab-root': {
              ...analysisCompactTabsSx['& .MuiTab-root'],
              alignItems: 'center',
              justifyContent: 'center',
            },
            '& .MuiTab-iconWrapper': {
              ...analysisCompactTabsSx['& .MuiTab-iconWrapper'],
              alignItems: 'center',
            },
          }}
        >
          {sidebarTabs.map((tab) => {
            if (tab === 'map') {
              return (
                <Tab
                  key={tab}
                  value={tab}
                  icon={<MapOutlinedIcon />}
                  iconPosition="start"
                  label="Мапа"
                />
              );
            }
            if (tab === 'stats') {
              return (
                <Tab
                  key={tab}
                  value={tab}
                  icon={<BarChartOutlinedIcon />}
                  iconPosition="start"
                  label="Зведення"
                />
              );
            }
            if (tab === 'callsigns') {
              return (
                <Tab
                  key={tab}
                  value={tab}
                  icon={<PeopleOutlineOutlinedIcon />}
                  iconPosition="start"
                  label="Позивні"
                />
              );
            }
            return (
              <Tab
                key={tab}
                value={tab}
                icon={<PersonAddOutlinedIcon />}
                iconPosition="start"
                label="Нові"
              />
            );
          })}
        </Tabs>
        {showNarrowCloseButton ? (
          <AnalysisRightPanelToggle
            expanded
            onClick={toggleRightPanel}
            sx={{ display: { xs: 'inline-flex', lg: 'none' }, mr: { xs: 1, lg: 0 } }}
          />
        ) : null}
      </Box>
      <Box
        sx={{
          ...analysisSidebarContentSx,
          '& > *': {
            borderBottom: '1px solid',
            borderColor: 'divider',
          },
          '& > *:last-child': {
            borderBottom: 'none',
          },
          '& .MuiPaper-root': {
            border: 'none',
            borderRadius: 0,
            boxShadow: 'none',
            backgroundColor: 'transparent',
          },
        }}
        data-analysis-sidebar-scroll-body
      >
        {keepMapPaneMounted ? (
          <Box
            sx={{
              height: '100%',
              flex: 1,
              minHeight: 0,
              display: sidebarTab === 'map' ? 'flex' : 'none',
              overflow: 'hidden',
            }}
          >
            <AnalysisMapPane
              mapAttrs={mapAttrs}
              search={queryState.search}
              visible={sidebarTab === 'map'}
              onDateRangeChange={refreshMapDateRange}
              onLoadMessages={loadMessagesForMap}
              onUnitClick={toggleUnitFromMap}
            />
          </Box>
        ) : null}
        {sidebarTab === 'stats' ? (
          <>
            <Box>
              <AnalysisStatsPane
                correlatedFreqs={correlatedFreqs}
                correlatedFreqsLoading={correlatedFreqsLoading}
                groupsActivity={groupsActivity}
                groupsActivityLoadedFreq={groupsActivityLoadedFreq}
                groupsActivityLoadedPeriod={groupsActivityLoadedPeriod}
                groupsActivityPeriod={groupsActivityPeriod}
                groupsActivityLoading={groupsActivityLoading}
                onLoadCorrelatedFreqs={loadCorrelatedFreqs}
                onLoadGroupsActivity={loadGroupsActivity}
                onAddFreq={addFreq}
                onAddLocation={addLocation}
                onSelectFreq={selectOnlyFreq}
                onAddNetwork={addNetwork}
                onAddUnit={addUnit}
                onToggleFreq={selectFreq}
                onToggleLocation={selectLocation}
                onToggleNetwork={selectNetwork}
                onToggleUnit={selectUnit}
                selectedFreq={queryState.freqsSelected[0] ?? null}
                selectedFreqs={queryState.freqsSelected}
                selectedLocations={queryState.locationsSelected}
                selectedNetworks={queryState.networksSelected}
                selectedUnits={queryState.unitsSelected}
                rightSidebarLoading={rightSidebarLoading}
                topFreqs={topFreqs}
                topLocations={topLocations}
                topNetworks={topNetworks}
                topUnits={topUnits}
              />
            </Box>
          </>
        ) : null}
        {sidebarTab === 'callsigns' ? (
          <AnalysisCallsignsPane
            callsignGraph={callsignGraph}
            callsignGraphLoading={callsignGraphLoading}
            callsignGraphLoadVersion={callsignGraphLoadVersion}
            callsignGraphLoadError={callsignGraphLoadError}
            callsignGraphNolimit={callsignGraphNolimit}
            visible={isSidebarVisible}
            onLoadCallsignGraph={loadCallsignGraph}
            onToggleNolimit={toggleCallsignGraphNolimit}
            rightSidebarLoading={rightSidebarLoading}
            topCallsigns={topCallsigns}
          />
        ) : null}
        {sidebarTab === 'newCallsigns' ? (
          <Box>
            <AnalysisNewCallsignsCard loading={newCallsignsLoading} newCallsigns={newCallsigns} />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
