import { Box, Paper, Tab, Tabs } from '@mui/material';

import type { ComponentProps } from 'react';
import type {
  EncryptionRec,
  Network,
  NetworkDescrType,
  NetworkFreqCallsignsPeriod,
  NetworkGroupActivityPeriod,
  NetworkFreqsRes,
  NetworkPoint,
} from '../../../../../Bindings';
import type { NetworkDetailsTab } from '../use-rer-network-details-neo-page.shared';
import { NetworkDetailsCallsignsPanel } from './NetworkCallsignsTables';
import { NetworkDetailsActivityPanel } from './NetworkDetailsActivityPanel';
import { NetworkDetailsDescriptionsPanel } from './NetworkDetailsDescriptionsPanel';
import { NetworkDetailsFrequenciesPanel } from './NetworkDetailsFrequenciesPanel';
import { NetworkDetailsPelengationPanel } from './NetworkDetailsPelengationPanel';
import { NetworkCallsignRelationsPanel } from './NetworkCallsignRelationsPanel';

type CallsignPanelProps = ComponentProps<typeof NetworkDetailsCallsignsPanel>;

type Props = {
  network: Network | null;
  loading: boolean;
  confirmationDescriptions: Network['descriptions'];
  signDescriptions: Network['descriptions'];
  canManageDescriptions: boolean;
  canManageFrequencies: boolean;
  canViewActivityTab: boolean;
  canViewRelationsTab: boolean;
  activeNetworkDetailsTab: NetworkDetailsTab;
  expandedDescriptionIds: number[];
  onSetActiveNetworkDetailsTab: (tab: NetworkDetailsTab) => void;
  onToggleExpanded: (descriptionId: number) => void;
  onEdit: (description: Network['descriptions'][number]) => void;
  onDelete: (description: Network['descriptions'][number]) => void;
  onCreate: (descrType: NetworkDescrType) => void;
  freqs: NetworkFreqsRes[];
  freqsLoaded: boolean;
  freqsLoading: boolean;
  freqsError: string | null;
  freqCallsignsById: Map<number, string[]>;
  freqCallsignsStatus: 'idle' | 'loading' | 'success' | 'error';
  freqCallsignsPeriod: NetworkFreqCallsignsPeriod;
  onFreqCallsignsPeriodChange: (period: NetworkFreqCallsignsPeriod) => void;
  networkActivity: Record<string, Record<string, number>>;
  networkActivityPeriod: NetworkGroupActivityPeriod;
  networkActivityLoaded: boolean;
  networkActivityLoading: boolean;
  networkActivityError: string | null;
  relations: ComponentProps<typeof NetworkCallsignRelationsPanel>['relations'];
  relationsLoaded: boolean;
  relationsLoading: boolean;
  relationsError: string | null;
  relationsSearch: string;
  relationsEnabledFreqs: string[];
  relationsMinIntensity: number;
  relationsShowLabels: boolean;
  relationsSelectedNodeId: string | null;
  relationsSelectedEdgeId: string | null;
  relationsSince: string;
  relationsTill: string;
  pelengSince: string;
  pelengTill: string;
  pelengSearch: string;
  pelengEnabledFreqs: string[];
  pelengShowLabels: boolean;
  pelengSatelliteEnabled: boolean;
  pelengHeatmapEnabled: boolean;
  onReloadRelations: () => void;
  onRelationsSearchChange: (value: string) => void;
  onRelationsEnabledFreqsChange: (freqs: string[]) => void;
  onRelationsMinIntensityChange: (value: number) => void;
  onRelationsShowLabelsChange: (value: boolean) => void;
  onRelationsSelectNodeId: (nodeId: string | null) => void;
  onRelationsSelectEdgeId: (edgeId: string | null) => void;
  onRelationsSinceChange: (value: string) => void;
  onRelationsTillChange: (value: string) => void;
  onPelengSinceChange: (value: string) => void;
  onPelengTillChange: (value: string) => void;
  onPelengSearchChange: (value: string) => void;
  onPelengEnabledFreqsChange: (freqs: string[]) => void;
  onPelengShowLabelsChange: (value: boolean) => void;
  onPelengSatelliteEnabledChange: (value: boolean) => void;
  onPelengHeatmapEnabledChange: (value: boolean) => void;
  pelengPoints: NetworkPoint[];
  pelengPointsLoaded: boolean;
  pelengPointsLoading: boolean;
  pelengPointsError: string | null;
  onReloadNetworkActivity: () => void;
  onNetworkActivityPeriodChange: (period: NetworkGroupActivityPeriod) => void;
  onReloadPelengPoints: () => void;
  encryptions: EncryptionRec[];
  expandedFrequencyGroupIds: string[];
  toggleFrequencyGroupExpanded: (groupId: string) => void;
  onOpenFreqCreateWizard: () => void;
  onOpenFreqEditDrawer: (freq: NetworkFreqsRes) => void;
  onOpenDeleteFreqDialog: (freq: NetworkFreqsRes) => void;
  onOpenFreqRowActions: (anchorEl: HTMLElement, freqId: number) => void;
  onCloseFreqRowActions: () => void;
  freqRowActionMenuAnchorEl: HTMLElement | null;
  freqRowActionTargetId: number | null;
  onReloadFrequencies: () => void;
  callsignPanelProps: CallsignPanelProps;
};

export function NetworkDetailsTabPanel({
  network,
  loading,
  confirmationDescriptions,
  signDescriptions,
  canManageDescriptions,
  canManageFrequencies,
  canViewActivityTab,
  canViewRelationsTab,
  activeNetworkDetailsTab,
  expandedDescriptionIds,
  onSetActiveNetworkDetailsTab,
  onToggleExpanded,
  onEdit,
  onDelete,
  onCreate,
  freqs,
  freqsLoaded,
  freqsLoading,
  freqsError,
  freqCallsignsById,
  freqCallsignsStatus,
  freqCallsignsPeriod,
  onFreqCallsignsPeriodChange,
  networkActivity,
  networkActivityPeriod,
  networkActivityLoaded,
  networkActivityLoading,
  networkActivityError,
  relations,
  relationsLoaded,
  relationsLoading,
  relationsError,
  relationsSearch,
  relationsEnabledFreqs,
  relationsMinIntensity,
  relationsShowLabels,
  relationsSelectedNodeId,
  relationsSelectedEdgeId,
  relationsSince,
  relationsTill,
  pelengSince,
  pelengTill,
  pelengSearch,
  pelengEnabledFreqs,
  pelengShowLabels,
  pelengSatelliteEnabled,
  pelengHeatmapEnabled,
  onReloadRelations,
  onRelationsSearchChange,
  onRelationsEnabledFreqsChange,
  onRelationsMinIntensityChange,
  onRelationsShowLabelsChange,
  onRelationsSelectNodeId,
  onRelationsSelectEdgeId,
  onRelationsSinceChange,
  onRelationsTillChange,
  onPelengSinceChange,
  onPelengTillChange,
  onPelengSearchChange,
  onPelengEnabledFreqsChange,
  onPelengShowLabelsChange,
  onPelengSatelliteEnabledChange,
  onPelengHeatmapEnabledChange,
  pelengPoints,
  pelengPointsLoaded,
  pelengPointsLoading,
  pelengPointsError,
  onReloadNetworkActivity,
  onNetworkActivityPeriodChange,
  onReloadPelengPoints,
  encryptions,
  expandedFrequencyGroupIds,
  toggleFrequencyGroupExpanded,
  onOpenFreqCreateWizard,
  onOpenFreqEditDrawer,
  onOpenDeleteFreqDialog,
  onOpenFreqRowActions,
  onCloseFreqRowActions,
  freqRowActionMenuAnchorEl,
  freqRowActionTargetId,
  onReloadFrequencies,
  callsignPanelProps,
}: Props) {
  return (
    <Paper
      variant="outlined"
      sx={{
        minHeight: 0,
        height: '100%',
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          px: 2,
          pt: 0.5,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Tabs
          value={activeNetworkDetailsTab}
          onChange={(_, nextTab: NetworkDetailsTab) => onSetActiveNetworkDetailsTab(nextTab)}
          variant="standard"
          sx={{
            minHeight: 42,
            '& .MuiTabs-indicator': {
              height: 2,
            },
          }}
        >
          <Tab value="descriptions" label="Обґрунтування" />
          <Tab value="signs" label="Розвід. ознаки" />
          <Tab value="frequencies" label="Частоти" />
          <Tab value="callsigns" label="Позивні" />
          {canViewActivityTab ? <Tab value="activity" label="Активність" /> : null}
          <Tab value="direction-finding" label="Пеленгація" />
          {canViewRelationsTab ? <Tab value="relations" label="Граф зв'язків" /> : null}
        </Tabs>
      </Box>

      <Box sx={{ minHeight: 0, flex: 1, overflow: 'hidden' }}>
        {activeNetworkDetailsTab === 'frequencies' ? (
          <Box sx={{ p: 2, minHeight: 0, minWidth: 0, flex: 1, display: 'flex', height: '100%' }}>
            <NetworkDetailsFrequenciesPanel
              network={network}
              loading={loading}
              freqs={freqs}
              freqsLoaded={freqsLoaded}
              freqsLoading={freqsLoading}
              freqsError={freqsError}
              freqCallsignsById={freqCallsignsById}
              freqCallsignsStatus={freqCallsignsStatus}
              freqCallsignsPeriod={freqCallsignsPeriod}
              onFreqCallsignsPeriodChange={onFreqCallsignsPeriodChange}
              encryptions={encryptions}
              expandedFrequencyGroupIds={expandedFrequencyGroupIds}
              onToggleFrequencyGroupExpanded={toggleFrequencyGroupExpanded}
              onOpenFreqCreateWizard={onOpenFreqCreateWizard}
              onOpenFreqEditDrawer={onOpenFreqEditDrawer}
              onOpenDeleteFreqDialog={onOpenDeleteFreqDialog}
              onOpenFreqRowActions={onOpenFreqRowActions}
              onCloseFreqRowActions={onCloseFreqRowActions}
              freqRowActionMenuAnchorEl={freqRowActionMenuAnchorEl}
              freqRowActionTargetId={freqRowActionTargetId}
              canManage={canManageFrequencies}
              onReloadFrequencies={onReloadFrequencies}
            />
          </Box>
        ) : activeNetworkDetailsTab === 'callsigns' ? (
          <Box
            sx={{
              p: 2,
              minHeight: 0,
              minWidth: 0,
              flex: 1,
              display: 'flex',
              height: '100%',
              flexDirection: 'column',
              overflowY: 'auto',
              overflowX: 'hidden',
              boxSizing: 'border-box',
            }}
          >
            <Box
              sx={{
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                width: '100%',
                boxSizing: 'border-box',
              }}
            >
              <NetworkDetailsCallsignsPanel {...callsignPanelProps} />
            </Box>
          </Box>
        ) : activeNetworkDetailsTab === 'relations' && canViewRelationsTab ? (
          <Box
            sx={{
              p: 2,
              minHeight: 0,
              minWidth: 0,
              flex: 1,
              display: 'flex',
              height: '100%',
              flexDirection: 'column',
            }}
          >
            <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
              <NetworkCallsignRelationsPanel
                networkId={network?.id ?? null}
                relations={relations}
                relationsLoaded={relationsLoaded}
                relationsLoading={relationsLoading}
                relationsError={relationsError}
                relationsSearch={relationsSearch}
                relationsEnabledFreqs={relationsEnabledFreqs}
                relationsMinIntensity={relationsMinIntensity}
                relationsShowLabels={relationsShowLabels}
                relationsSelectedNodeId={relationsSelectedNodeId}
                relationsSelectedEdgeId={relationsSelectedEdgeId}
                relationsSince={relationsSince}
                relationsTill={relationsTill}
                onReload={onReloadRelations}
                onSearchChange={onRelationsSearchChange}
                onEnabledFreqsChange={onRelationsEnabledFreqsChange}
                onMinIntensityChange={onRelationsMinIntensityChange}
                onShowLabelsChange={onRelationsShowLabelsChange}
                onSelectNodeId={onRelationsSelectNodeId}
                onSelectEdgeId={onRelationsSelectEdgeId}
                onRelationsSinceChange={onRelationsSinceChange}
                onRelationsTillChange={onRelationsTillChange}
              />
            </Box>
          </Box>
        ) : activeNetworkDetailsTab === 'activity' && canViewActivityTab ? (
          <Box
            sx={{
              p: 2,
              minHeight: 0,
              minWidth: 0,
              flex: 1,
              display: 'flex',
              height: '100%',
              flexDirection: 'column',
            }}
          >
            <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
              <NetworkDetailsActivityPanel
                networkActivity={networkActivity}
                networkActivityPeriod={networkActivityPeriod}
                networkActivityLoaded={networkActivityLoaded}
                networkActivityLoading={networkActivityLoading}
                networkActivityError={networkActivityError}
                onReloadNetworkActivity={onReloadNetworkActivity}
                onNetworkActivityPeriodChange={onNetworkActivityPeriodChange}
              />
            </Box>
          </Box>
        ) : activeNetworkDetailsTab === 'direction-finding' ? (
          <Box
            sx={{
              p: 2,
              minHeight: 0,
              minWidth: 0,
              flex: 1,
              display: 'flex',
              height: '100%',
              flexDirection: 'column',
            }}
          >
            <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
              <NetworkDetailsPelengationPanel
                pelengPoints={pelengPoints}
                pelengPointsLoaded={pelengPointsLoaded}
                pelengPointsLoading={pelengPointsLoading}
                pelengPointsError={pelengPointsError}
                onReloadPelengPoints={onReloadPelengPoints}
                pelengSince={pelengSince}
                pelengTill={pelengTill}
                pelengSearch={pelengSearch}
                pelengEnabledFreqs={pelengEnabledFreqs}
                pelengShowLabels={pelengShowLabels}
                pelengSatelliteEnabled={pelengSatelliteEnabled}
                pelengHeatmapEnabled={pelengHeatmapEnabled}
                onPelengSinceChange={onPelengSinceChange}
                onPelengTillChange={onPelengTillChange}
                onPelengSearchChange={onPelengSearchChange}
                onPelengEnabledFreqsChange={onPelengEnabledFreqsChange}
                onPelengShowLabelsChange={onPelengShowLabelsChange}
                onPelengSatelliteEnabledChange={onPelengSatelliteEnabledChange}
                onPelengHeatmapEnabledChange={onPelengHeatmapEnabledChange}
              />
            </Box>
          </Box>
        ) : (
          <Box sx={{ minHeight: 0, height: '100%', display: 'flex' }}>
            <NetworkDetailsDescriptionsPanel
              network={network}
              loading={loading}
              confirmationDescriptions={confirmationDescriptions}
              signDescriptions={signDescriptions}
              canManageDescriptions={canManageDescriptions}
              expandedDescriptionIds={expandedDescriptionIds}
              onToggleExpanded={onToggleExpanded}
              onEdit={onEdit}
              onDelete={onDelete}
              onCreate={onCreate}
              descrType={activeNetworkDetailsTab === 'signs' ? 'Sign' : 'Confirmation'}
            />
          </Box>
        )}
      </Box>
    </Paper>
  );
}
