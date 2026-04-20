import AccountCircleOutlinedIcon from '@mui/icons-material/AccountCircleOutlined';
import BarChartOutlinedIcon from '@mui/icons-material/BarChartOutlined';
import PeopleOutlineOutlinedIcon from '@mui/icons-material/PeopleOutlineOutlined';
import { Box, Tab, Tabs } from '@mui/material';

import type { AnalysisPageActions, AnalysisPageState } from '../types';
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
  | 'filtersLoading'
  | 'groupsActivity'
  | 'groupsActivityLoadedFreq'
  | 'groupsActivityLoadedPeriod'
  | 'groupsActivityPeriod'
  | 'groupsActivityLoading'
  | 'newCallsigns'
  | 'newCallsignsLoading'
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
    | 'selectOnlyFreq'
    | 'setRightSidebarTab'
    | 'toggleCallsignGraphNolimit'
  >;

export function AnalysisSidebar({
  callsignGraph,
  callsignGraphLoading,
  callsignGraphLoadVersion,
  callsignGraphNolimit,
  correlatedFreqs,
  correlatedFreqsLoading,
  filtersLoading,
  groupsActivity,
  groupsActivityLoadedFreq,
  groupsActivityLoadedPeriod,
  groupsActivityPeriod,
  groupsActivityLoading,
  loadCallsignGraph,
  loadCorrelatedFreqs,
  loadGroupsActivity,
  newCallsigns,
  newCallsignsLoading,
  queryState,
  rightPanelOpen,
  rightSidebarTab,
  selectOnlyFreq,
  setRightSidebarTab,
  topCallsigns,
  topFreqs,
  topLocations,
  topUnits,
  toggleCallsignGraphNolimit,
}: Props) {
  return (
    <Box
      component="aside"
      aria-label="Аналітична бічна панель"
      sx={{ minHeight: 0, height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
    >
      <Box sx={{ pt: 1 }}>
        <Tabs
          value={rightSidebarTab ?? false}
          onChange={(_event, value) => setRightSidebarTab(value as 'stats' | 'callsigns' | 'newCallsigns')}
          variant="scrollable"
          allowScrollButtonsMobile
          aria-label="Вкладки правої панелі аналізу"
          sx={{
            minHeight: 0,
            width: '100%',
            px: { xs: 0.5, sm: 1, md: 1.5 },
            '& .MuiTabs-flexContainer': { gap: 1 },
            '& .MuiTabs-scroller': {
              px: 0,
            },
            '& .MuiTabs-scrollButtons': {
              width: 32,
              flexShrink: 0,
            },
            '& .MuiTab-root': {
              minHeight: 40,
              px: 1.25,
              py: 0.5,
              whiteSpace: 'nowrap',
            },
            '& .MuiTab-iconWrapper': {
              mr: 1,
              mb: 0,
            },
          }}
        >
          <Tab value="stats" icon={<BarChartOutlinedIcon sx={{ fontSize: 20 }} />} iconPosition="start" label="Зведення" />
          <Tab value="callsigns" icon={<PeopleOutlineOutlinedIcon sx={{ fontSize: 20 }} />} iconPosition="start" label="Позивні" />
          <Tab value="newCallsigns" icon={<AccountCircleOutlinedIcon sx={{ fontSize: 20 }} />} iconPosition="start" label="Нові" />
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
        {rightSidebarTab === 'stats' ? (
          <>
            <Box>
              <AnalysisChartsPanel
                correlatedFreqs={correlatedFreqs}
                correlatedFreqsLoading={correlatedFreqsLoading}
                filtersLoading={filtersLoading}
                groupsActivity={groupsActivity}
                groupsActivityLoadedFreq={groupsActivityLoadedFreq}
                groupsActivityLoadedPeriod={groupsActivityLoadedPeriod}
                groupsActivityPeriod={groupsActivityPeriod}
                groupsActivityLoading={groupsActivityLoading}
                onLoadCorrelatedFreqs={loadCorrelatedFreqs}
                onLoadGroupsActivity={loadGroupsActivity}
                onSelectFreq={selectOnlyFreq}
                selectedFreq={queryState.freqsSelected[0] ?? null}
                topFreqs={topFreqs}
                topLocations={topLocations}
                topUnits={topUnits}
              />
            </Box>
          </>
        ) : null}
        {rightSidebarTab === 'callsigns' ? (
          <Box>
            <AnalysisCallsignsCloudCard items={topCallsigns} />
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
