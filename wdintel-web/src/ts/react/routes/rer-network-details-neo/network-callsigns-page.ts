import type { RerNetworkDetailsNeoPage } from './use-rer-network-details-neo-page';

type Page = RerNetworkDetailsNeoPage;

export function buildCallsignPanelProps(page: Page) {
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
    onAddInterceptedToDeveloping: (callsign: string) => page.openCallsignDrawerForCreate({ callsign, developing: true }),
    onAddInterceptedToNetwork: (callsign: string) => page.openCallsignDrawerForCreate({ callsign, developing: false }),
    onReload: page.loadCallsigns,
    inFlightCreateCallsigns: page.callsignCreateInFlightCallsigns,
    inFlightAddIds: page.callsignCatalogAddInFlightIds,
    inFlightUpdateIds: page.callsignUpdateInFlightIds,
    inFlightDeleteIds: page.callsignDeleteInFlightIds,
  };
}
