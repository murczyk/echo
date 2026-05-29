import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import SummarizeOutlinedIcon from '@mui/icons-material/SummarizeOutlined';
import MoreVertOutlinedIcon from '@mui/icons-material/MoreVertOutlined';
import {
  Box,
  Button,
  IconButton,
  Menu,
  MenuItem,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useState } from 'react';

import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { PageErrorState } from '../../components/PageErrorState';
import { PageHeader } from '../../components/PageHeader';
import { PowerAlert } from '../../components/PowerAlert';
import { navigateWithinSpa } from '../../utils/browser';
import { NetworkFreqCreateWizard } from './components/NetworkFreqCreateWizard';
import { NetworkFreqEditDrawer } from './components/NetworkFreqEditDrawer';
import { NetworkFreqTechDataDrawer } from './components/NetworkFreqTechDataDrawer';
import { NetworkDescriptionDrawer } from './components/NetworkDescriptionDrawer';
import { NetworkCallsignDrawer } from './components/NetworkCallsignDrawer';
import { NetworkEtalonkaReportDialog } from './components/NetworkEtalonkaReportDialog';
import { NetworkDetailsTabPanel } from './components/NetworkDetailsTabPanel';
import { NetworkDetailsLeftPanel } from './components/NetworkDetailsLeftPanel';
import { NetworkEditDrawer } from './components/NetworkEditDrawer';
import { useRerNetworkDetailsNeoPage } from './use-rer-network-details-neo-page';
import {
  formatClassicNetworkHeaderName,
} from './use-rer-network-details-neo-page.shared';
import {
  parseDateInputExclusiveEndInTimeZone,
  parseDateInputInTimeZone,
} from '../../utils/misc';

type Props = {
  networkId: number;
};

export function RerNetworkDetailsNeoPage({ networkId }: Props) {
  const page = useRerNetworkDetailsNeoPage(networkId);
  const [showAllAors, setShowAllAors] = useState(false);
  const aorVisible = showAllAors ? page.aorItems : page.aorItems.slice(0, 5);
  const aorCollapsedCount = Math.max(page.aorItems.length - aorVisible.length, 0);
  const statusDotColor = page.status.tone === 'success' ? 'success.main' : 'warning.main';
  const classicHref = `/rer-networks/${networkId}`;
  const title = page.network ? (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
      <Tooltip title={page.status.label} arrow placement="bottom-start">
        <Box
          component="span"
          aria-label={page.status.label}
          sx={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            bgcolor: statusDotColor,
            flexShrink: 0,
            cursor: 'default',
          }}
        />
      </Tooltip>
      <Box component="span" sx={{ minWidth: 0 }}>
        {formatClassicNetworkHeaderName(page.network.name, page.unitNames)}
      </Box>
    </Box>
  ) : (
    <Skeleton width={240} />
  );
  const copyText = page.network ? `${formatClassicNetworkHeaderName(page.network.name, page.unitNames)}, ${page.network.location}` : '';
  const descriptionDrawerNetwork = page.network;
  const isLoading = page.loading && !page.network;
  const deleteDescriptionTitle = getDeleteDescriptionTitle(page.deleteDescriptionTarget?.descrType ?? 'Confirmation');
  const deleteDescriptionMessage = getDeleteDescriptionMessage(page.deleteDescriptionTarget);
  const editFreq = page.freqEditDrawerForm
    ? page.freqs.find((freq) => freq.networkFreqId === page.freqEditDrawerForm?.networkFreqId) ?? null
    : null;
  const techFreq = page.freqTechDrawerForm
    ? page.freqs.find((freq) => freq.networkFreqId === page.freqTechDrawerForm?.networkFreqId) ?? null
    : null;

  const actions = (
    <Stack direction="row" spacing={1} alignItems="center">
      <Button onClick={() => navigateWithinSpa(classicHref)}>
        Повернутись до класичної версії
      </Button>
      <Tooltip title="Скопіювати назву і район">
        <span>
          <IconButton
            onClick={page.handleCopyNetworkInfo}
            disabled={!page.network}
            aria-label="Скопіювати назву і район мережі"
            title={copyText}
          >
            <ContentCopyOutlinedIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Дії">
        <IconButton
          onClick={(event) => page.openMenu(event.currentTarget)}
          aria-haspopup="true"
          aria-controls={page.menuAnchorEl ? 'network-details-actions-menu' : undefined}
          aria-label="Дії з мережею"
        >
          <MoreVertOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu id="network-details-actions-menu" open={page.menuAnchorEl !== null} anchorEl={page.menuAnchorEl} onClose={page.closeMenu}>
        <MenuItem onClick={page.openEditDrawer} disabled={!page.canEdit || !page.network}>
          <Stack direction="row" spacing={1} alignItems="center">
            <EditIcon fontSize="small" />
            <span>Редагувати</span>
          </Stack>
        </MenuItem>
        <MenuItem onClick={page.openEtalonkaReportDialog} disabled={!page.network}>
          <Stack direction="row" spacing={1} alignItems="center">
            <SummarizeOutlinedIcon fontSize="small" />
            <span>Завантажити еталонний опис</span>
          </Stack>
        </MenuItem>
        <MenuItem onClick={page.openDeleteDialog} disabled={!page.canDelete || !page.network} sx={{ color: 'error.main' }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <DeleteIcon fontSize="small" />
            <span>Видалити</span>
          </Stack>
        </MenuItem>
      </Menu>
    </Stack>
  );

  if (page.error && !page.network) {
    return <PageErrorState message={page.error} actionLabel="Спробувати ще раз" onAction={page.reload} />;
  }

  return (
    <Box sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' }}>
      <PageHeader title={title} actions={actions} />

      {page.error ? <PowerAlert severity="error">{page.error}</PowerAlert> : null}
      {page.referenceWarning ? <PowerAlert severity="warning">{page.referenceWarning}</PowerAlert> : null}
      {page.callsignWarning ? <PowerAlert severity="warning">{page.callsignWarning}</PowerAlert> : null}

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', lg: 'minmax(360px, 420px) minmax(0,1fr)' },
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            minHeight: 0,
            overflow: 'auto',
          }}
        >
          <NetworkDetailsLeftPanel
            isLoading={isLoading}
            unitNames={page.unitNames}
            network={page.network}
            aorVisible={aorVisible}
            aorCollapsedCount={aorCollapsedCount}
            showAllAors={showAllAors}
            onToggleShowAllAors={() => setShowAllAors((current) => !current)}
            callsignCount={page.callsignCount}
            statusTone={page.status.tone}
            statusLabel={page.status.label}
            rangeLabel={page.rangeLabel}
            transferTypeLabel={page.transferTypeLabel}
            postItems={page.postItems}
          />
        </Box>

        <NetworkDetailsTabPanel
          network={descriptionDrawerNetwork}
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
          onReloadPelengPoints={() => page.loadPelengPoints(networkId, page.network?.activeFrom ?? null, page.network?.activeTo ?? null)}
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
          callsignPanelProps={{
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
            onAddInterceptedToDeveloping: (callsign) => page.addInterceptedCallsignToNetwork(callsign, true),
            onAddInterceptedToNetwork: (callsign) => page.addInterceptedCallsignToNetwork(callsign, false),
            onReload: page.loadCallsigns,
            inFlightCreateCallsigns: page.callsignCreateInFlightCallsigns,
            inFlightAddIds: page.callsignCatalogAddInFlightIds,
            inFlightUpdateIds: page.callsignUpdateInFlightIds,
            inFlightDeleteIds: page.callsignDeleteInFlightIds,
          }}
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
          onReloadRelations={() => {
            if (page.network) {
              const since = parseDateInputInTimeZone(page.relationsSince);
              const till = parseDateInputExclusiveEndInTimeZone(page.relationsTill);
              if (since === null || till === null) return;
              void page.loadRelations(
                page.network.id,
                since,
                till,
              );
            }
          }}
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
        />
      </Box>

      <ConfirmDangerDialog
        open={page.deleteDialogOpen}
        onClose={page.closeDeleteDialog}
        onConfirm={page.handleDelete}
        title="Підтвердження видалення"
        description={`Видалити мережу «${formatClassicNetworkHeaderName(page.network?.name, page.unitNames)}»?`}
        submitting={page.deleteInProgress}
        disabled={!page.canDelete}
      />

      <ConfirmDangerDialog
        open={page.deleteDescriptionDialogOpen}
        onClose={page.closeDeleteDescriptionDialog}
        onConfirm={page.deleteDescription}
        onExited={page.resetDeleteDescriptionDialog}
        title={deleteDescriptionTitle}
        description={deleteDescriptionMessage}
        submitting={page.deleteDescriptionSubmitting}
        disabled={!page.canManageDescriptionActions || page.deleteDescriptionTarget === null}
      >
        {page.deleteDescriptionError ? <PowerAlert severity="error">{page.deleteDescriptionError}</PowerAlert> : null}
      </ConfirmDangerDialog>

      <ConfirmDangerDialog
        open={page.callsignDeleteDialogOpen}
        onClose={page.closeCallsignDeleteDialog}
        onConfirm={page.deleteCallsign}
        title="Відв'язати позивний"
        description="Ви впевнені, що хочете відв'язати цей позивний від мережі?"
        confirmLabel="Відв'язати"
        submitting={page.callsignDeleteSubmitting}
        disabled={!page.canManageCallsignActions || page.callsignDeleteTarget === null}
      >
        {page.callsignDeleteError ? <PowerAlert severity="error">{page.callsignDeleteError}</PowerAlert> : null}
      </ConfirmDangerDialog>

      <NetworkDescriptionDrawer
        open={page.descriptionDrawerOpen}
        mode={page.descriptionDrawerMode}
        descrType={page.descriptionDrawerDescrType}
        form={page.descriptionDrawerForm}
        saving={page.descriptionDrawerSaving}
        error={page.descriptionDrawerError}
        networkFreqs={descriptionDrawerNetwork?.freqs ?? []}
        onClose={page.closeDescriptionDrawer}
        onChange={page.setDescriptionDrawerForm}
        onSave={page.saveDescription}
      />

      <NetworkEditDrawer
        open={page.editDrawerOpen}
        form={page.editForm}
        saving={page.editInProgress}
        error={page.editError}
        referenceLoading={page.referenceLoading}
        aorOptions={page.aorOptions}
        unitOptions={page.unitOptions}
        postOptions={page.postOptions}
        onClose={page.closeEditDrawer}
        onChange={page.setEditForm}
        onSave={page.saveNetworkEdit}
      />

      <NetworkCallsignDrawer
        open={page.callsignDrawerOpen}
        mode={page.callsignDrawerMode}
        form={page.callsignDrawerForm}
        sources={page.sources}
        units={page.unitOptions}
        saving={page.callsignDrawerSaving}
        error={page.callsignDrawerError}
        onClose={page.closeCallsignDrawer}
        onChange={page.setCallsignDrawerForm}
        onSave={page.saveCallsignDrawer}
      />

      <NetworkFreqCreateWizard
        open={page.freqCreateWizardOpen}
        step={page.freqCreateWizardStep}
        form={page.freqCreateWizardForm}
        saving={page.freqCreateWizardSaving}
        error={page.freqCreateWizardError}
        networkId={page.network?.id ?? null}
        canManageKeys={page.canEdit}
        modulations={page.modulations}
        onClose={page.closeFreqCreateWizard}
        onChange={page.setFreqCreateWizardForm}
        onStepChange={page.setFreqCreateWizardStep}
        onSave={page.saveFreqCreateWizard}
      />

      <NetworkFreqEditDrawer
        open={page.freqEditDrawerOpen}
        form={page.freqEditDrawerForm}
        freq={editFreq}
        saving={page.freqEditDrawerSaving}
        error={page.freqEditDrawerError}
        modulations={page.modulations}
        onClose={page.closeFreqEditDrawer}
        onChange={page.setFreqEditDrawerForm}
        onSave={page.saveFreqEditDrawer}
      />

      <NetworkFreqTechDataDrawer
        open={page.freqTechDrawerOpen}
        networkId={page.network?.id ?? null}
        freq={techFreq}
        form={page.freqTechDrawerForm}
        saving={page.freqTechDrawerSaving}
        error={page.freqTechDrawerError}
        canManageKeys={page.canEdit}
        modulations={page.modulations}
        onClose={page.closeFreqTechDrawer}
        onChange={page.setFreqTechDrawerForm}
        onSave={page.saveFreqTechDrawer}
        onReloadFrequencies={page.loadFrequencies}
      />

      <ConfirmDangerDialog
        open={page.freqDeleteDialogOpen}
        onClose={page.closeDeleteFreqDialog}
        onConfirm={page.deleteFreq}
        title="Підтвердження видалення частоти"
        description={`Видалити частоту «${page.freqDeleteTarget?.freq ?? '—'}»?`}
        submitting={page.freqDeleteSubmitting}
        disabled={!page.canEdit || page.freqDeleteTarget === null}
      >
        {page.freqDeleteError ? <PowerAlert severity="error">{page.freqDeleteError}</PowerAlert> : null}
      </ConfirmDangerDialog>

      <NetworkEtalonkaReportDialog
        report={page.etalonkaReport}
        onClose={page.closeEtalonkaReportDialog}
        onDownload={page.downloadEtalonkaReport}
        onTypeChange={page.setEtalonkaReportType}
        onActiveFreqsOnlyChange={page.setEtalonkaReportActiveFreqsOnly}
        onIncludeSigintSignsChange={page.setEtalonkaReportIncludeSigintSigns}
        onIncludeConfirmationChange={page.setEtalonkaReportIncludeConfirmation}
        onIncludeUnitCallsignsChange={page.setEtalonkaReportIncludeUnitCallsigns}
        onIncludePelengsMapChange={page.setEtalonkaReportIncludePelengsMap}
        onFromDateTimeStrChange={page.setEtalonkaReportFromDateTimeStr}
        onToDateTimeStrChange={page.setEtalonkaReportToDateTimeStr}
      />
    </Box>
  );
}

function getDeleteDescriptionTitle(descrType: 'Confirmation' | 'Sign'): string {
  return descrType === 'Sign' ? 'Видалити розвідувальні ознаки' : 'Видалити обґрунтування';
}

function getDeleteDescriptionMessage(
  description: { descrType: 'Confirmation' | 'Sign'; topic?: string | null } | null,
): string {
  if (!description) {
    return 'Ви впевнені, що хочете видалити цей запис?';
  }

  const topic = description.topic?.trim();
  if (topic) {
    const noun = description.descrType === 'Sign' ? 'розвідувальні ознаки' : 'обґрунтування';
    return `Ви впевнені, що хочете видалити ${noun} «${topic}»?`;
  }

  return description.descrType === 'Sign'
    ? 'Ви впевнені, що хочете видалити ці розвідувальні ознаки?'
    : 'Ви впевнені, що хочете видалити це обґрунтування?';
}
