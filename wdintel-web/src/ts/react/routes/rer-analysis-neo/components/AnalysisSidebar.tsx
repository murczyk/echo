import { Box, Stack } from '@mui/material';

import type { AnalysisPageActions, AnalysisPageState } from '../types';
import { AnalysisCallsignsCloudCard } from './AnalysisCallsignsCloudCard';
import { AnalysisCallsignGraphCard } from './AnalysisCallsignGraphCard';
import { AnalysisChartsPanel } from './AnalysisChartsPanel';
import { AnalysisNewCallsignsCard } from './AnalysisNewCallsignsCard';
import { AnalysisOverviewCard } from './AnalysisOverviewCard';
import { AnalysisSummaryTableCard } from './AnalysisSummaryTableCard';

type Props = Pick<
  AnalysisPageState,
  | 'callsignGraph'
  | 'callsignGraphLoading'
  | 'callsignGraphNolimit'
  | 'correlatedFreqs'
  | 'correlatedFreqsLoading'
  | 'counts'
  | 'groupsActivity'
  | 'groupsActivityPeriod'
  | 'groupsActivityLoading'
  | 'networkDisplayMap'
  | 'networks'
  | 'newCallsigns'
  | 'summaryRows'
  | 'summaryCallsignsInfo'
  | 'unitsMap'
  | 'topCallsigns'
  | 'topFreqs'
  | 'topLocations'
  | 'topUnits'
> &
  Pick<
    AnalysisPageActions,
    | 'downloadGeojson'
    | 'downloadKmz'
    | 'downloadSummaryXlsx'
    | 'loadCallsignGraph'
    | 'loadCorrelatedFreqs'
    | 'loadGroupsActivity'
    | 'renameSummaryUnit'
    | 'selectOnlyFreq'
    | 'showFreqOnMap'
    | 'toggleCallsignGraphNolimit'
  >;

export function AnalysisSidebar({
  callsignGraph,
  callsignGraphLoading,
  callsignGraphNolimit,
  correlatedFreqs,
  correlatedFreqsLoading,
  counts,
  downloadGeojson,
  downloadKmz,
  downloadSummaryXlsx,
  groupsActivity,
  groupsActivityPeriod,
  groupsActivityLoading,
  loadCallsignGraph,
  loadCorrelatedFreqs,
  loadGroupsActivity,
  networkDisplayMap,
  networks,
  newCallsigns,
  renameSummaryUnit,
  selectOnlyFreq,
  summaryRows,
  summaryCallsignsInfo,
  unitsMap,
  showFreqOnMap,
  topCallsigns,
  topFreqs,
  topLocations,
  topUnits,
  toggleCallsignGraphNolimit,
}: Props) {
  return (
    <Box component="aside" aria-label="Аналітична бічна панель" sx={{ minHeight: 0, overflow: 'auto' }}>
      <Stack spacing={2}>
        <AnalysisOverviewCard counts={counts} />
        <AnalysisChartsPanel
          correlatedFreqs={correlatedFreqs}
          correlatedFreqsLoading={correlatedFreqsLoading}
          groupsActivity={groupsActivity}
          groupsActivityPeriod={groupsActivityPeriod}
          groupsActivityLoading={groupsActivityLoading}
          onLoadCorrelatedFreqs={loadCorrelatedFreqs}
          onLoadGroupsActivity={loadGroupsActivity}
          topFreqs={topFreqs}
          topLocations={topLocations}
          topUnits={topUnits}
        />
        <AnalysisSummaryTableCard
          callsignInfoMap={summaryCallsignsInfo}
          networkDisplayMap={networkDisplayMap}
          networks={networks}
          onDownloadGeojson={downloadGeojson}
          onDownloadKmz={downloadKmz}
          onDownloadXlsx={downloadSummaryXlsx}
          onRenameUnit={renameSummaryUnit}
          onSelectFreq={selectOnlyFreq}
          onShowFreqOnMap={showFreqOnMap}
          rows={summaryRows}
          unitsMap={unitsMap}
        />
        <AnalysisCallsignsCloudCard items={topCallsigns} />
        <AnalysisCallsignGraphCard
          graph={callsignGraph}
          loading={callsignGraphLoading}
          nolimit={callsignGraphNolimit}
          onLoad={loadCallsignGraph}
          onToggleNolimit={toggleCallsignGraphNolimit}
        />
        <AnalysisNewCallsignsCard newCallsigns={newCallsigns} />
      </Stack>
    </Box>
  );
}
