import BarChartOutlinedIcon from '@mui/icons-material/BarChartOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import PeopleOutlineOutlinedIcon from '@mui/icons-material/PeopleOutlineOutlined';
import PersonAddOutlinedIcon from '@mui/icons-material/PersonAddOutlined';
import { Box, Tab, Tabs, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';

import type { AnalysisPageActions, AnalysisPageState } from '../types';
import { AnalysisMapPane } from './AnalysisMapPane';
import { AnalysisCallsignGraphCard } from './AnalysisCallsignGraphCard';
import { AnalysisChartsPanel } from './AnalysisChartsPanel';
import { AnalysisCallsignsCloudCard } from './AnalysisCallsignsCloudCard';
import { AnalysisNewCallsignsCard } from './AnalysisNewCallsignsCard';

type Props = Pick<
  AnalysisPageState,
  | 'callsignGraph'
  | 'callsignGraphLoading'
  | 'callsignGraphLoadVersion'
  | 'callsignGraphNolimit'
  | 'correlatedFreqs'
  | 'correlatedFreqsLoading'
  | 'groupsActivity'
  | 'groupsActivityLoadedFreq'
  | 'groupsActivityLoadedPeriod'
  | 'groupsActivityPeriod'
  | 'groupsActivityLoading'
  | 'mapAttrs'
  | 'newCallsigns'
  | 'newCallsignsLoading'
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
  >;

export function AnalysisSidebar({
  callsignGraph,
  callsignGraphLoading,
  callsignGraphLoadVersion,
  callsignGraphNolimit,
  correlatedFreqs,
  correlatedFreqsLoading,
  groupsActivity,
  groupsActivityLoadedFreq,
  groupsActivityLoadedPeriod,
  groupsActivityPeriod,
  groupsActivityLoading,
  mapAttrs,
  loadCallsignGraph,
  loadCorrelatedFreqs,
  loadGroupsActivity,
  loadMessagesForMap,
  newCallsigns,
  newCallsignsLoading,
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
}: Props) {
  const theme = useTheme();
  const isMobileLayout = useMediaQuery(theme.breakpoints.down('sm'));
  const keepMapPaneMounted = rightPanelOpen || isMobileLayout;

  return (
    <Box
      component="aside"
      aria-label="Аналітична бічна панель"
      sx={{ minHeight: 0, height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
    >
      <Box sx={{ pt: 1 }}>
        <Tabs
          value={rightSidebarTab ?? false}
          onChange={(_event, value) => setRightSidebarTab(value as 'map' | 'stats' | 'callsigns' | 'newCallsigns')}
          variant="scrollable"
          scrollButtons={isMobileLayout ? false : 'auto'}
          aria-label="Вкладки правої панелі аналізу"
          sx={{
            minHeight: 0,
            width: '100%',
            px: { xs: 0.5, sm: 1, md: 1.5 },
            '& .MuiTabs-flexContainer': {
              gap: 1,
              alignItems: 'stretch',
            },
            '& .MuiTabs-scroller': {
              px: 0,
            },
            '& .MuiTabs-scrollButtons': {
              width: 32,
              flexShrink: 0,
            },
            '& .MuiTab-root': {
              minHeight: 44,
              px: 1.25,
              py: 0,
              whiteSpace: 'nowrap',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1.1,
            },
            '& .MuiTab-iconWrapper': {
              mr: 1,
              mb: 0,
              alignItems: 'center',
            },
          }}
        >
          <Tab value="map" icon={<MapOutlinedIcon sx={{ fontSize: 20 }} />} iconPosition="start" label="Мапа" />
          <Tab value="stats" icon={<BarChartOutlinedIcon sx={{ fontSize: 20 }} />} iconPosition="start" label="Зведення" />
          <Tab value="callsigns" icon={<PeopleOutlineOutlinedIcon sx={{ fontSize: 20 }} />} iconPosition="start" label="Позивні" />
          <Tab value="newCallsigns" icon={<PersonAddOutlinedIcon sx={{ fontSize: 20 }} />} iconPosition="start" label="Нові" />
        </Tabs>
      </Box>
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
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
      >
        {keepMapPaneMounted ? (
          <Box sx={{ height: '100%', minHeight: 0, display: rightSidebarTab === 'map' ? 'flex' : 'none' }}>
            <AnalysisMapPane
              mapAttrs={mapAttrs}
              search={queryState.search}
              visible={rightSidebarTab === 'map'}
              onDateRangeChange={refreshMapDateRange}
              onExit={() => setRightSidebarTab('stats')}
              onLoadMessages={loadMessagesForMap}
              onUnitClick={toggleUnitFromMap}
            />
          </Box>
        ) : null}
        {rightSidebarTab === 'stats' ? (
          <>
            <Box>
          <AnalysisChartsPanel
            correlatedFreqs={correlatedFreqs}
            correlatedFreqsLoading={correlatedFreqsLoading}
            groupsActivity={groupsActivity}
            groupsActivityLoadedFreq={groupsActivityLoadedFreq}
            groupsActivityLoadedPeriod={groupsActivityLoadedPeriod}
            groupsActivityPeriod={groupsActivityPeriod}
            groupsActivityLoading={groupsActivityLoading}
                onLoadCorrelatedFreqs={loadCorrelatedFreqs}
                onLoadGroupsActivity={loadGroupsActivity}
            onSelectFreq={selectOnlyFreq}
            selectedFreq={queryState.freqsSelected[0] ?? null}
            rightSidebarLoading={rightSidebarLoading}
            topFreqs={topFreqs}
            topLocations={topLocations}
            topUnits={topUnits}
          />
            </Box>
          </>
        ) : null}
        {rightSidebarTab === 'callsigns' ? (
          <Box>
            <AnalysisCallsignsCloudCard items={topCallsigns} loading={rightSidebarLoading} />
            <AnalysisCallsignGraphCard
              graph={callsignGraph}
              loading={callsignGraphLoading}
              loadVersion={callsignGraphLoadVersion}
              nolimit={callsignGraphNolimit}
              visible={rightPanelOpen}
              onLoad={loadCallsignGraph}
              onToggleNolimit={toggleCallsignGraphNolimit}
            />
          </Box>
        ) : null}
        {rightSidebarTab === 'newCallsigns' ? (
          <Box>
            <AnalysisNewCallsignsCard loading={newCallsignsLoading} newCallsigns={newCallsigns} />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
