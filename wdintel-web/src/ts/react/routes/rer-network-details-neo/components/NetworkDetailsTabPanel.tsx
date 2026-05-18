import { Box, Paper, Tab, Tabs } from '@mui/material';

import type { ComponentProps } from 'react';
import type { ModulationRec, Network, NetworkDescrType, NetworkFreqsRes, NetworkPoint } from '../../../../../Bindings';
import type { NetworkDetailsTab } from '../use-rer-network-details-neo-page.shared';
import { NetworkDetailsCallsignsPanel } from './NetworkCallsignsTables';
import { NetworkDetailsActivityPanel } from './NetworkDetailsActivityPanel';
import { NetworkDetailsDescriptionsPanel } from './NetworkDetailsDescriptionsPanel';
import { NetworkDetailsFrequenciesPanel } from './NetworkDetailsFrequenciesPanel';
import { NetworkDetailsPelengationPanel } from './NetworkDetailsPelengationPanel';

type CallsignPanelProps = ComponentProps<typeof NetworkDetailsCallsignsPanel>;

type Props = {
  network: Network | null;
  loading: boolean;
  confirmationDescriptions: Network['descriptions'];
  signDescriptions: Network['descriptions'];
  canManageDescriptions: boolean;
  canManageFrequencies: boolean;
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
  networkActivity: Record<string, Record<string, number>>;
  networkActivityLoaded: boolean;
  networkActivityLoading: boolean;
  networkActivityError: string | null;
  pelengPoints: NetworkPoint[];
  pelengPointsLoaded: boolean;
  pelengPointsLoading: boolean;
  pelengPointsError: string | null;
  onReloadNetworkActivity: () => void;
  onReloadPelengPoints: () => void;
  modulations: ModulationRec[];
  expandedFrequencyGroupIds: string[];
  toggleFrequencyGroupExpanded: (groupId: string) => void;
  onOpenFreqCreateWizard: () => void;
  onOpenFreqEditDrawer: (freq: NetworkFreqsRes) => void;
  onOpenFreqTechDrawer: (freq: NetworkFreqsRes) => void;
  onOpenDeleteFreqDialog: (freq: NetworkFreqsRes) => void;
  onToggleFreqCommandControl: (freq: NetworkFreqsRes) => void;
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
  networkActivity,
  networkActivityLoaded,
  networkActivityLoading,
  networkActivityError,
  pelengPoints,
  pelengPointsLoaded,
  pelengPointsLoading,
  pelengPointsError,
  onReloadNetworkActivity,
  onReloadPelengPoints,
  modulations,
  expandedFrequencyGroupIds,
  toggleFrequencyGroupExpanded,
  onOpenFreqCreateWizard,
  onOpenFreqEditDrawer,
  onOpenFreqTechDrawer,
  onOpenDeleteFreqDialog,
  onToggleFreqCommandControl,
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
          <Tab value="activity" label="Активність" />
          <Tab value="pelengation" label="Пеленгація" />
        </Tabs>
      </Box>

      <Box sx={{ minHeight: 0, flex: 1, overflow: 'hidden' }}>
        {activeNetworkDetailsTab === 'frequencies' ? (
          <Box sx={{ px: 2, pt: 2, pb: 3, minHeight: 0, minWidth: 0, flex: 1, display: 'flex', height: '100%' }}>
            <NetworkDetailsFrequenciesPanel
              network={network}
              loading={loading}
              freqs={freqs}
              freqsLoaded={freqsLoaded}
              freqsLoading={freqsLoading}
              freqsError={freqsError}
              modulations={modulations}
              expandedFrequencyGroupIds={expandedFrequencyGroupIds}
              onToggleFrequencyGroupExpanded={toggleFrequencyGroupExpanded}
              onOpenFreqCreateWizard={onOpenFreqCreateWizard}
              onOpenFreqEditDrawer={onOpenFreqEditDrawer}
              onOpenFreqTechDrawer={onOpenFreqTechDrawer}
              onOpenDeleteFreqDialog={onOpenDeleteFreqDialog}
              onToggleCommandControl={onToggleFreqCommandControl}
              onOpenFreqRowActions={onOpenFreqRowActions}
              onCloseFreqRowActions={onCloseFreqRowActions}
              freqRowActionMenuAnchorEl={freqRowActionMenuAnchorEl}
              freqRowActionTargetId={freqRowActionTargetId}
              canManage={canManageFrequencies}
              onReloadFrequencies={onReloadFrequencies}
            />
          </Box>
        ) : activeNetworkDetailsTab === 'callsigns' ? (
          <Box sx={{ px: 2, pt: 2, pb: 3, minHeight: 0, minWidth: 0, flex: 1, display: 'flex', height: '100%', flexDirection: 'column' }}>
            <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
              <NetworkDetailsCallsignsPanel {...callsignPanelProps} />
            </Box>
          </Box>
        ) : activeNetworkDetailsTab === 'activity' ? (
          <Box sx={{ px: 2, pt: 2, pb: 3, minHeight: 0, minWidth: 0, flex: 1, display: 'flex', height: '100%', flexDirection: 'column' }}>
            <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
              <NetworkDetailsActivityPanel
                networkActivity={networkActivity}
                networkActivityLoaded={networkActivityLoaded}
                networkActivityLoading={networkActivityLoading}
                networkActivityError={networkActivityError}
                onReloadNetworkActivity={onReloadNetworkActivity}
              />
            </Box>
          </Box>
        ) : activeNetworkDetailsTab === 'pelengation' ? (
          <Box sx={{ px: 2, pt: 2, pb: 3, minHeight: 0, minWidth: 0, flex: 1, display: 'flex', height: '100%', flexDirection: 'column' }}>
            <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
              <NetworkDetailsPelengationPanel
                pelengPoints={pelengPoints}
                pelengPointsLoaded={pelengPointsLoaded}
                pelengPointsLoading={pelengPointsLoading}
                pelengPointsError={pelengPointsError}
                onReloadPelengPoints={onReloadPelengPoints}
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
