import BarChartOutlinedIcon from '@mui/icons-material/BarChartOutlined';
import GraphicEqOutlinedIcon from '@mui/icons-material/GraphicEqOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import PeopleOutlineOutlinedIcon from '@mui/icons-material/PeopleOutlineOutlined';
import PersonAddOutlinedIcon from '@mui/icons-material/PersonAddOutlined';
import { Box, Tab, Tabs } from '@mui/material';
import { useMemo } from 'react';

import type { AnalysisPageActions, AnalysisPageState } from '../types';
import { sortAndTakeTopAnalysisCountItems } from '../count-items';
import { getAnalysisSidebarTabs } from '../types';
import { AnalysisCallsignGraphPane } from './AnalysisCallsignGraphPane';
import { AnalysisCallsignsPane } from './AnalysisCallsignsPane';
import { AnalysisFrequenciesPane } from './AnalysisFrequenciesPane';
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
import { normalizeCallsignLookupValue } from '../../../utils/callsign-normalization';
import { buildAnalysisReq } from '../helpers';

type Props = Pick<
  AnalysisPageState,
  | 'callsignGraph'
  | 'callsignGraphLoading'
  | 'callsignGraphLoadError'
  | 'correlatedFreqs'
  | 'correlatedFreqsLoaded'
  | 'correlatedFreqsLoading'
  | 'groupsActivity'
  | 'groupsActivityLoadedFreq'
  | 'groupsActivityLoadedPeriod'
  | 'groupsActivityPeriod'
  | 'groupsActivityLoading'
  | 'isFilterSectionLoading'
  | 'mapAttrs'
  | 'analysisMapInSidebar'
  | 'newCallsigns'
  | 'newCallsignsLoading'
  | 'options'
  | 'rightSidebarLoading'
  | 'rightSidebarOutdated'
  | 'queryState'
  | 'rightSidebarTab'
  | 'rightPanelOpen'
  | 'topFreqs'
  | 'topLocations'
  | 'topUnits'
> &
  Pick<
    AnalysisPageActions,
    | 'findCallsignFrequencyMatches'
    | 'loadCallsignGraph'
    | 'loadCorrelatedFreqs'
    | 'loadGroupsActivity'
    | 'loadMessagesForMap'
    | 'loadSettlementMessagesForMap'
    | 'setRightSidebarTab'
    | 'refreshMapDateRange'
    | 'setShowSettlements'
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
  callsignGraphLoadError,
  correlatedFreqs,
  correlatedFreqsLoaded,
  correlatedFreqsLoading,
  groupsActivity,
  groupsActivityLoadedFreq,
  groupsActivityLoadedPeriod,
  groupsActivityPeriod,
  groupsActivityLoading,
  isFilterSectionLoading,
  mapAttrs,
  analysisMapInSidebar,
  findCallsignFrequencyMatches,
  loadCallsignGraph,
  loadCorrelatedFreqs,
  loadGroupsActivity,
  loadMessagesForMap,
  loadSettlementMessagesForMap,
  newCallsigns,
  newCallsignsLoading,
  options,
  rightSidebarLoading,
  rightSidebarOutdated,
  queryState,
  rightPanelOpen,
  rightSidebarTab,
  setRightSidebarTab,
  topFreqs,
  topLocations,
  topUnits,
  refreshMapDateRange,
  setShowSettlements,
  toggleUnitFromMap,
  toggleRightPanel,
  updateQueryState,
  isCompactLayout = false,
  showNarrowCloseButton = true,
}: Props) {
  const isSidebarVisible = rightPanelOpen;
  const sidebarTabs = getAnalysisSidebarTabs(
    analysisMapInSidebar,
    queryState.radioFeaturesAllowed !== false,
  );
  const sidebarTab = analysisMapInSidebar || rightSidebarTab !== 'map' ? rightSidebarTab : 'stats';
  const selectedFreq = queryState.freqsSelected[0] ?? null;
  const callsignAnalysisReq = useMemo(
    () =>
      buildAnalysisReq(
        queryState,
        (options.freqs ?? []).map((option) => option.value),
      ),
    [options.freqs, queryState],
  );
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
  const clearUnit = () => {
    updateQueryState({ unitsExactMatchOnly: null, unitsSelected: [] });
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
  const clearFreq = () => {
    updateQueryState({ freqsSelected: [] });
  };
  const selectGroup = (groupKey: string) => {
    updateQueryState({
      groupsSelected: toggleExclusiveAnalysisSelection(queryState.groupsSelected, groupKey),
    });
  };
  const addGroup = (groupKey: string) => {
    updateQueryState({
      groupsSelected: addAnalysisSelection(queryState.groupsSelected, groupKey),
    });
  };
  const clearGroup = () => {
    updateQueryState({ groupsSelected: [] });
  };
  const selectCallsign = (callsigns: string[] | string) => {
    const values = (Array.isArray(callsigns) ? callsigns : [callsigns])
      .map(normalizeCallsignLookupValue)
      .filter((value) => value !== '');
    if (values.length === 0) return;
    updateQueryState({
      callsignsSelected: values.every((value) => queryState.callsignsSelected.includes(value))
        ? []
        : values,
    });
  };
  const addCallsign = (callsigns: string[] | string) => {
    updateQueryState({
      callsignsSelected: (Array.isArray(callsigns) ? callsigns : [callsigns]).reduce(
        (selected, callsign) =>
          addAnalysisSelection(selected, normalizeCallsignLookupValue(callsign)),
        queryState.callsignsSelected,
      ),
    });
  };
  const removeCallsign = (callsigns: string[]) => {
    const removed = new Set(callsigns.map(normalizeCallsignLookupValue));
    updateQueryState({
      callsignsSelected: queryState.callsignsSelected.filter(
        (callsign) => !removed.has(normalizeCallsignLookupValue(callsign)),
      ),
    });
  };
  const clearCallsign = () => {
    updateQueryState({ callsignsSelected: [] });
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
  const topGroups = useMemo(
    () =>
      sortAndTakeTopAnalysisCountItems(
        options.groups.map((group) => ({
          key: group.label,
          value: group.value,
          count: group.count,
        })),
      ),
    [options.groups],
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
  const clearNetwork = () => {
    updateQueryState({ networksSelected: [] });
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
  const clearLocation = () => {
    updateQueryState({ locationsSelected: [] });
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
            if (tab === 'graph') {
              return (
                <Tab
                  key={tab}
                  value={tab}
                  icon={<HubOutlinedIcon />}
                  iconPosition="start"
                  label="Граф"
                />
              );
            }
            if (tab === 'frequencies') {
              return (
                <Tab
                  key={tab}
                  value={tab}
                  icon={<GraphicEqOutlinedIcon />}
                  iconPosition="start"
                  label="Частоти"
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
              onLoadSettlementMessages={loadSettlementMessagesForMap}
              onUnitClick={toggleUnitFromMap}
              onShowSettlementsChange={setShowSettlements}
            />
          </Box>
        ) : null}
        {sidebarTab === 'stats' ? (
          <>
            <Box>
              <AnalysisStatsPane
                groupsLoading={isFilterSectionLoading?.('groups') ?? false}
                onClearFreq={clearFreq}
                onClearGroup={clearGroup}
                onClearLocation={clearLocation}
                onClearNetwork={clearNetwork}
                onClearUnit={clearUnit}
                onAddFreq={addFreq}
                onAddGroup={addGroup}
                onAddLocation={addLocation}
                onAddNetwork={addNetwork}
                onAddUnit={addUnit}
                onToggleFreq={selectFreq}
                onToggleGroup={selectGroup}
                onToggleLocation={selectLocation}
                onToggleNetwork={selectNetwork}
                onToggleUnit={selectUnit}
                selectedFreqs={queryState.freqsSelected}
                selectedGroups={queryState.groupsSelected}
                selectedLocations={queryState.locationsSelected}
                selectedNetworks={queryState.networksSelected}
                selectedUnits={queryState.unitsSelected}
                rightSidebarLoading={rightSidebarLoading}
                rightSidebarOutdated={rightSidebarOutdated}
                topFreqs={topFreqs}
                topGroups={topGroups}
                topLocations={topLocations}
                topNetworks={topNetworks}
                topUnits={topUnits}
              />
            </Box>
          </>
        ) : null}
        {sidebarTab === 'frequencies' ? (
          <AnalysisFrequenciesPane
            correlatedFreqs={correlatedFreqs}
            correlatedFreqsLoaded={correlatedFreqsLoaded}
            correlatedFreqsLoading={correlatedFreqsLoading}
            groupsActivity={groupsActivity}
            groupsActivityLoadedFreq={groupsActivityLoadedFreq}
            groupsActivityLoadedPeriod={groupsActivityLoadedPeriod}
            groupsActivityLoading={groupsActivityLoading}
            groupsActivityPeriod={groupsActivityPeriod}
            onClearFreq={clearFreq}
            onLoadCorrelatedFreqs={loadCorrelatedFreqs}
            onLoadGroupsActivity={loadGroupsActivity}
            onAddFreq={addFreq}
            onToggleFreq={selectFreq}
            selectedFreq={selectedFreq}
            selectedFreqs={queryState.freqsSelected}
            topFreqs={topFreqs}
          />
        ) : null}
        {sidebarTab === 'callsigns' ? (
          <AnalysisCallsignsPane
            analysisReq={callsignAnalysisReq}
            onClearCallsign={clearCallsign}
            onAddCallsign={addCallsign}
            onAddFreq={addFreq}
            onRemoveCallsign={removeCallsign}
            selectedCallsigns={queryState.callsignsSelected}
            selectedFreqs={queryState.freqsSelected}
            onSearchFrequencyMatches={findCallsignFrequencyMatches}
            onToggleCallsign={selectCallsign}
            onToggleFreq={selectFreq}
          />
        ) : null}
        {sidebarTab === 'graph' ? (
          <AnalysisCallsignGraphPane
            callsignGraph={callsignGraph}
            callsignGraphLoading={callsignGraphLoading}
            callsignGraphLoadError={callsignGraphLoadError}
            onLoadCallsignGraph={loadCallsignGraph}
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
