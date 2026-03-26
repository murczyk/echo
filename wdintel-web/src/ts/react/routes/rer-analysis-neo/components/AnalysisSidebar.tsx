import { Box, Stack } from '@mui/material';
import { useEffect, useRef } from 'react';

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
  | 'rightSidebarSections'
  | 'rightPanelOpen'
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
  rightPanelOpen,
  rightSidebarSections,
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
  const statsRef = useRef<HTMLDivElement | null>(null);
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const callsignsRef = useRef<HTMLDivElement | null>(null);
  const newCallsignsRef = useRef<HTMLDivElement | null>(null);
  const prevSectionsRef = useRef(rightSidebarSections);

  useEffect(() => {
    const prevSections = prevSectionsRef.current;
    const activatedSection = (Object.keys(rightSidebarSections) as Array<keyof typeof rightSidebarSections>).find(
      (section) => rightSidebarSections[section] && !prevSections[section],
    );

    prevSectionsRef.current = rightSidebarSections;

    if (!activatedSection) return;

    const sectionRefMap = {
      stats: statsRef,
      summary: summaryRef,
      callsigns: callsignsRef,
      newCallsigns: newCallsignsRef,
    };

    window.requestAnimationFrame(() => {
      sectionRefMap[activatedSection].current?.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
    });
  }, [rightSidebarSections]);

  return (
    <Box component="aside" aria-label="Аналітична бічна панель" sx={{ minHeight: 0, height: '100%', overflow: 'auto' }}>
      <Stack
        spacing={0}
        sx={{
          '& > *': {
            pb: 2,
            mb: 2,
            borderBottom: '1px solid',
            borderColor: 'divider',
          },
          '& > *:last-child': {
            pb: 0,
            mb: 0,
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
        {rightSidebarSections.stats ? <Box ref={statsRef}><AnalysisOverviewCard counts={counts} /></Box> : null}
        {rightSidebarSections.stats ? (
          <Box>
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
          </Box>
        ) : null}
        {rightSidebarSections.summary ? (
          <Box ref={summaryRef}>
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
          </Box>
        ) : null}
        {rightSidebarSections.callsigns ? (
          <Box ref={callsignsRef}>
            <AnalysisCallsignsCloudCard items={topCallsigns} />
            <AnalysisCallsignGraphCard
              graph={callsignGraph}
              loading={callsignGraphLoading}
              nolimit={callsignGraphNolimit}
              visible={rightPanelOpen}
              onLoad={loadCallsignGraph}
              onToggleNolimit={toggleCallsignGraphNolimit}
            />
          </Box>
        ) : null}
        {rightSidebarSections.newCallsigns ? (
          <Box ref={newCallsignsRef}>
            <AnalysisNewCallsignsCard newCallsigns={newCallsigns} />
          </Box>
        ) : null}
      </Stack>
    </Box>
  );
}
