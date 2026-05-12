import { Box, Paper, Tab, Tabs } from '@mui/material';

import type { ModulationRec, Network, NetworkDescrType, NetworkFreqsRes } from '../../../../../Bindings';
import type { NetworkDetailsTab } from '../use-rer-network-details-neo-page.shared';
import { NetworkDetailsFrequenciesPanel } from './NetworkDetailsFrequenciesPanel';
import { NetworkDetailsDescriptionsPanel } from './NetworkDetailsDescriptionsPanel';

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
  modulations: ModulationRec[];
  expandedFrequencyGroupIds: string[];
  toggleFrequencyGroupExpanded: (groupId: string) => void;
  onOpenFreqCreateWizard: () => void;
  onOpenFreqEditDrawer: (freq: NetworkFreqsRes) => void;
  onOpenFreqTechDrawer: (freq: NetworkFreqsRes) => void;
  onOpenDeleteFreqDialog: (freq: NetworkFreqsRes) => void;
  onOpenFreqRowActions: (anchorEl: HTMLElement, freqId: number) => void;
  onCloseFreqRowActions: () => void;
  freqRowActionMenuAnchorEl: HTMLElement | null;
  freqRowActionTargetId: number | null;
  onReloadFrequencies: () => void;
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
  modulations,
  expandedFrequencyGroupIds,
  toggleFrequencyGroupExpanded,
  onOpenFreqCreateWizard,
  onOpenFreqEditDrawer,
  onOpenFreqTechDrawer,
  onOpenDeleteFreqDialog,
  onOpenFreqRowActions,
  onCloseFreqRowActions,
  freqRowActionMenuAnchorEl,
  freqRowActionTargetId,
  onReloadFrequencies,
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
        </Tabs>
      </Box>

      <Box sx={{ position: 'relative', minHeight: 0, flex: 1, overflow: 'hidden' }}>
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            minHeight: 0,
            minWidth: 0,
            display: 'flex',
            visibility: activeNetworkDetailsTab === 'frequencies' ? 'visible' : 'hidden',
            pointerEvents: activeNetworkDetailsTab === 'frequencies' ? 'auto' : 'none',
            zIndex: activeNetworkDetailsTab === 'frequencies' ? 1 : 0,
          }}
        >
          <Box sx={{ px: 2, pt: 2, pb: 3, minHeight: 0, minWidth: 0, flex: 1, display: 'flex' }}>
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
              onOpenFreqRowActions={onOpenFreqRowActions}
              onCloseFreqRowActions={onCloseFreqRowActions}
              freqRowActionMenuAnchorEl={freqRowActionMenuAnchorEl}
              freqRowActionTargetId={freqRowActionTargetId}
              canManage={canManageFrequencies}
              onReloadFrequencies={onReloadFrequencies}
            />
          </Box>
        </Box>
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            minHeight: 0,
            minWidth: 0,
            display: 'flex',
            visibility: activeNetworkDetailsTab === 'frequencies' ? 'hidden' : 'visible',
            pointerEvents: activeNetworkDetailsTab === 'frequencies' ? 'none' : 'auto',
            zIndex: activeNetworkDetailsTab === 'frequencies' ? 0 : 1,
          }}
        >
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
      </Box>
    </Paper>
  );
}
