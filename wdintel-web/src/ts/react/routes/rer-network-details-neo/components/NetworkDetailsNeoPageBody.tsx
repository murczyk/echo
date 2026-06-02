import { Box } from '@mui/material';
import { combineDateTimeInputToMs, parseDateInputExclusiveEndInTimeZone, parseDateInputInTimeZone } from '../../../utils/misc';
import { NetworkDetailsLeftPanel } from './NetworkDetailsLeftPanel';
import { NetworkDetailsTabPanel } from './NetworkDetailsTabPanel';
import { useRerNetworkDetailsNeoPage } from '../use-rer-network-details-neo-page';

type Page = ReturnType<typeof useRerNetworkDetailsNeoPage>;
type PanelPlacement = 'left' | 'top';

type Props = {
  page: Page;
  networkId: number;
  leftPanelVisible: boolean;
  panelPlacement: PanelPlacement;
  topPanelCollapsed: boolean;
  showAllAors: boolean;
  onToggleShowAllAors: () => void;
  onSetPanelPlacement: (placement: PanelPlacement) => void;
  onSetTopPanelCollapsed: (collapsed: boolean) => void;
  onToggleTopPanelCollapsed: () => void;
};

function buildRelationsReloadHandler(page: Page) {
  return () => {
    if (page.network) {
      const since = parseDateInputInTimeZone(page.relationsSince);
      const till = parseDateInputExclusiveEndInTimeZone(page.relationsTill);
      if (since === null || till === null) return;
      void page.loadRelations(page.network.id, since, till);
    }
  };
}

function buildPelengReloadHandler(page: Page, networkId: number) {
  return () => {
    const since = combineDateTimeInputToMs(page.pelengSince);
    const till = combineDateTimeInputToMs(page.pelengTill);
    if (since === null || till === null) return;
    void page.loadPelengPoints(networkId, since, till);
  };
}

function buildCallsignPanelProps(page: Page) {
  return {
    sources: page.sources,
    networkCallsigns: page.networkCallsigns,
    catalogCallsignGroups: page.catalogCallsignGroups,
    unknownInterceptedCallsigns: page.unknownInterceptedCallsigns,
    loading: page.callsignsLoading,
    loadingError: page.callsignsError,
    canManage: page.canManageCallsignActions,
    sectionMode: page.callsignSectionMode,
    onSectionModeChange: page.setCallsignSectionMode,
    statusFilter: page.callsignStatusFilter,
    onStatusFilterChange: page.setCallsignStatusFilter,
    interceptedExpanded: page.callsignInterceptedExpanded,
    onToggleInterceptedExpanded: page.toggleCallsignInterceptedExpanded,
    onOpenCreateDrawer: page.openCallsignDrawerForCreate,
    onOpenEditDrawer: page.openCallsignDrawerForEdit,
    onOpenDeleteDialog: page.openCallsignDeleteDialog,
    onSetMarkerMode: page.setNetworkCallsignMarkerMode,
    onAddKnownCallsign: page.addKnownCallsignsToNetwork,
    onAddInterceptedToDeveloping: (callsign: string) => page.openCallsignDrawerForCreate({ callsign, developing: true, status: 'developing' }),
    onAddInterceptedToNetwork: (callsign: string) => page.openCallsignDrawerForCreate({ callsign, developing: false, status: 'verified' }),
    onReload: page.loadCallsigns,
    inFlightCreateCallsigns: page.callsignCreateInFlightCallsigns,
    inFlightAddIds: page.callsignCatalogAddInFlightIds,
    inFlightUpdateIds: page.callsignUpdateInFlightIds,
    inFlightDeleteIds: page.callsignDeleteInFlightIds,
  };
}

function buildSharedLeftPanelProps(
  page: Page,
  showAllAors: boolean,
  onToggleShowAllAors: () => void,
  onSetPanelPlacement: (placement: PanelPlacement) => void,
  onSetTopPanelCollapsed: (collapsed: boolean) => void,
  onToggleTopPanelCollapsed: () => void,
) {
  const aorVisible = showAllAors ? page.aorItems : page.aorItems.slice(0, 5);
  const aorCollapsedCount = Math.max(page.aorItems.length - aorVisible.length, 0);

  return {
    isLoading: page.loading && !page.network,
    unitNames: page.unitNames,
    network: page.network,
    aorVisible,
    aorCollapsedCount,
    showAllAors,
    onToggleShowAllAors,
    callsignCount: page.callsignCount,
    statusTone: page.status.tone,
    statusLabel: page.status.label,
    rangeLabel: page.rangeLabel,
    transferTypeLabel: page.transferTypeLabel,
    postItems: page.postItems,
    onPlacementChange: onSetPanelPlacement,
    onCollapsedChange: onSetTopPanelCollapsed,
    onToggleCollapsed: onToggleTopPanelCollapsed,
    onCopyMainInfo: page.handleCopyMainInfo,
  } as const;
}

export function NetworkDetailsNeoPageBody({
  page,
  networkId,
  leftPanelVisible,
  panelPlacement,
  topPanelCollapsed,
  showAllAors,
  onToggleShowAllAors,
  onSetPanelPlacement,
  onSetTopPanelCollapsed,
  onToggleTopPanelCollapsed,
}: Props) {
  const sharedLeftPanelProps = buildSharedLeftPanelProps(
    page,
    showAllAors,
    onToggleShowAllAors,
    onSetPanelPlacement,
    onSetTopPanelCollapsed,
    onToggleTopPanelCollapsed,
  );
  const relationsReload = buildRelationsReloadHandler(page);
  const pelengReload = buildPelengReloadHandler(page, networkId);
  const callsignPanelProps = buildCallsignPanelProps(page);

  const detailsTabPanel = (
    <NetworkDetailsTabPanel
      network={page.network}
      loading={page.loading}
      confirmationDescriptions={page.confirmationDescriptions}
      signDescriptions={page.signDescriptions}
      canManageDescriptions={page.canManageDescriptionActions}
      canManageFrequencies={page.canEdit}
      canViewActivityTab={page.canViewActivityTab}
      canViewRelationsTab={page.canViewRelationsTab}
      activeNetworkDetailsTab={page.activeNetworkDetailsTab}
      expandedDescriptionIds={page.expandedDescriptionIds}
      onSetActiveNetworkDetailsTab={page.setActiveNetworkDetailsTab}
      onToggleExpanded={page.toggleDescriptionExpanded}
      onEdit={page.openDescriptionDrawerForEdit}
      onDelete={page.openDeleteDescriptionDialog}
      onCreate={page.openDescriptionDrawerForCreate}
      freqs={page.freqs}
      freqsLoaded={page.freqsLoaded}
      freqsLoading={page.freqsLoading}
      freqsError={page.freqsError}
      networkActivity={page.networkActivity}
      networkActivityLoaded={page.networkActivityLoaded}
      networkActivityLoading={page.networkActivityLoading}
      networkActivityError={page.networkActivityError}
      onReloadNetworkActivity={() => page.loadNetworkActivity(networkId)}
      pelengPoints={page.pelengPoints}
      pelengPointsLoaded={page.pelengPointsLoaded}
      pelengPointsLoading={page.pelengPointsLoading}
      pelengPointsError={page.pelengPointsError}
      onReloadPelengPoints={pelengReload}
      modulations={page.modulations}
      expandedFrequencyGroupIds={page.expandedFrequencyGroupIds}
      toggleFrequencyGroupExpanded={page.toggleFrequencyGroupExpanded}
      onOpenFreqCreateWizard={page.openFreqCreateWizard}
      onOpenFreqEditDrawer={page.openFreqEditDrawer}
      onOpenFreqTechDrawer={page.openFreqTechDrawer}
      onOpenDeleteFreqDialog={page.openDeleteFreqDialog}
      onOpenFreqRowActions={page.openFreqRowActions}
      onCloseFreqRowActions={page.closeFreqRowActions}
      freqRowActionMenuAnchorEl={page.freqRowActionMenuAnchorEl}
      freqRowActionTargetId={page.freqRowActionTargetId}
      onReloadFrequencies={page.loadFrequencies}
      callsignPanelProps={callsignPanelProps}
      relations={page.relations}
      relationsLoaded={page.relationsLoaded}
      relationsLoading={page.relationsLoading}
      relationsError={page.relationsError}
      relationsSearch={page.relationsSearch}
      relationsEnabledFreqs={page.relationsEnabledFreqs}
      relationsMinIntensity={page.relationsMinIntensity}
      relationsShowLabels={page.relationsShowLabels}
      relationsSelectedNodeId={page.relationsSelectedNodeId}
      relationsSelectedEdgeId={page.relationsSelectedEdgeId}
      onReloadRelations={relationsReload}
      onRelationsSearchChange={page.setRelationsSearch}
      onRelationsEnabledFreqsChange={page.setRelationsEnabledFreqs}
      onRelationsMinIntensityChange={page.setRelationsMinIntensity}
      onRelationsShowLabelsChange={page.setRelationsShowLabels}
      onRelationsSelectNodeId={page.setRelationsSelectedNodeId}
      onRelationsSelectEdgeId={page.setRelationsSelectedEdgeId}
      relationsSince={page.relationsSince}
      relationsTill={page.relationsTill}
      onRelationsSinceChange={page.setRelationsSince}
      onRelationsTillChange={page.setRelationsTill}
      pelengSince={page.pelengSince}
      pelengTill={page.pelengTill}
      pelengSearch={page.pelengSearch}
      pelengEnabledFreqs={page.pelengEnabledFreqs}
      pelengShowLabels={page.pelengShowLabels}
      onPelengSinceChange={page.setPelengSince}
      onPelengTillChange={page.setPelengTill}
      onPelengSearchChange={page.setPelengSearch}
      onPelengEnabledFreqsChange={page.setPelengEnabledFreqs}
      onPelengShowLabelsChange={page.setPelengShowLabels}
    />
  );

  if (panelPlacement === 'top') {
    return (
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' }}>
        <Box
          sx={{
            minHeight: 0,
            flex: '0 1 auto',
            maxHeight: { xs: '45dvh', md: 'min(50dvh, 560px)' },
            overflowY: 'auto',
            overflowX: 'hidden',
            overscrollBehavior: 'contain',
          }}
        >
          <NetworkDetailsLeftPanel placement="top" collapsed={topPanelCollapsed} {...sharedLeftPanelProps} />
        </Box>
        <Box sx={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>{detailsTabPanel}</Box>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'grid',
        gap: 2,
        gridTemplateColumns: { xs: '1fr', lg: leftPanelVisible ? 'minmax(360px, 420px) minmax(0,1fr)' : 'minmax(0,1fr)' },
        overflow: 'hidden',
      }}
    >
      {leftPanelVisible ? (
        <Box sx={{ minHeight: 0, overflow: 'auto' }}>
          <NetworkDetailsLeftPanel placement="left" collapsed={false} {...sharedLeftPanelProps} />
        </Box>
      ) : null}
      {detailsTabPanel}
    </Box>
  );
}
