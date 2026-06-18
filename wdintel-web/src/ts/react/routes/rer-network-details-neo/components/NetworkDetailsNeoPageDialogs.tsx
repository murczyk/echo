import { Checkbox, FormControlLabel } from '@mui/material';
import { ConfirmDangerDialog } from '../../../components/ConfirmDangerDialog';
import { MRT_ROW_ACTION_MODAL_PROPS } from '../../../components/MrtRowActionButton';
import { PowerAlert } from '../../../components/PowerAlert';
import { NetworkDescriptionDrawer } from './NetworkDescriptionDrawer';
import { NetworkEditDrawer } from './NetworkEditDrawer';
import { NetworkCallsignDrawer } from './NetworkCallsignDrawer';
import { NetworkFreqCreateDrawer } from './NetworkFreqCreateDrawer';
import { NetworkFreqEditDrawer } from './NetworkFreqEditDrawer';
import { NetworkEtalonkaReportDialog } from './NetworkEtalonkaReportDialog';
import { formatClassicNetworkHeaderName } from '../use-rer-network-details-neo-page.shared';
import type { useRerNetworkDetailsNeoPage } from '../use-rer-network-details-neo-page';

type Page = ReturnType<typeof useRerNetworkDetailsNeoPage>;

type Props = {
  page: Page;
};

function buildDeleteDescriptionTitle(descrType: 'Confirmation' | 'Sign'): string {
  return descrType === 'Sign' ? 'Видалити розвідувальні ознаки' : 'Видалити обґрунтування';
}

function buildDeleteDescriptionMessage(
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

export function NetworkDetailsNeoPageDialogs({ page }: Props) {
  const deleteDescriptionTitle = buildDeleteDescriptionTitle(page.deleteDescriptionTarget?.descrType ?? 'Confirmation');
  const deleteDescriptionMessage = buildDeleteDescriptionMessage(page.deleteDescriptionTarget);

  return (
    <>
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
        {page.callsignDeleteTarget
          && page.callsignDeleteTarget.status !== 'developing'
          && page.callsignDeleteTarget.knownCallsignId !== null
          && page.canDeleteCatalogCallsign ? (
          <FormControlLabel
            control={
              <Checkbox
                checked={page.callsignDeleteAlsoFromCatalog}
                onChange={(_, checked) => page.setCallsignDeleteAlsoFromCatalog(checked)}
              />
            }
            label="Видалити також з каталогу"
          />
        ) : null}
        {page.callsignDeleteError ? <PowerAlert severity="error">{page.callsignDeleteError}</PowerAlert> : null}
      </ConfirmDangerDialog>

      <NetworkDescriptionDrawer
        open={page.descriptionDrawerOpen}
        mode={page.descriptionDrawerMode}
        descrType={page.descriptionDrawerDescrType}
        form={page.descriptionDrawerForm}
        saving={page.descriptionDrawerSaving}
        error={page.descriptionDrawerError}
        networkFreqs={page.network?.freqs ?? []}
        onClose={page.closeDescriptionDrawer}
        onChange={page.setDescriptionDrawerForm}
        onSave={page.saveDescription}
      />

      <NetworkEditDrawer
        open={page.editDrawerOpen}
        mode="edit"
        form={page.editForm}
        saving={page.editInProgress}
        error={page.editError}
        referenceLoading={page.referenceLoading}
        aorOptions={page.aorOptions}
        unitOptions={page.unitOptions}
        postOptions={page.postOptions}
        modulationOptions={page.encryptions.map((enc) => ({ id: enc.id, label: enc.name }))}
        onClose={page.closeEditDrawer}
        onChange={page.setEditForm}
        onSave={page.saveNetworkEdit}
        {...MRT_ROW_ACTION_MODAL_PROPS}
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
        {...MRT_ROW_ACTION_MODAL_PROPS}
      />

      <NetworkFreqCreateDrawer
        open={page.freqCreateWizardOpen}
        form={page.freqCreateWizardForm}
        saving={page.freqCreateWizardSaving}
        error={page.freqCreateWizardError}
        networkId={page.network?.id ?? null}
        canManageKeys={page.canEdit}
        encryptions={page.encryptions}
        onClose={page.closeFreqCreateWizard}
        onChange={page.setFreqCreateWizardForm}
        onSave={page.saveFreqCreateWizard}
      />

      <NetworkFreqEditDrawer
        open={page.freqEditDrawerOpen}
        form={page.freqEditDrawerForm}
        saving={page.freqEditDrawerSaving}
        error={page.freqEditDrawerError}
        networkId={page.network?.id ?? null}
        encryptions={page.encryptions}
        onClose={page.closeFreqEditDrawer}
        onChange={page.setFreqEditDrawerForm}
        onSave={page.saveFreqEditDrawer}
        {...MRT_ROW_ACTION_MODAL_PROPS}
      />

      <ConfirmDangerDialog
        open={page.freqDeleteDialogOpen}
        onClose={page.closeDeleteFreqDialog}
        onConfirm={page.deleteFreq}
        title="Підтвердження видалення частоти"
        description={`Видалити частоту «${page.freqDeleteTarget?.freq ?? '—'}»?`}
        submitting={page.freqDeleteSubmitting}
        disabled={!page.canEdit || page.freqDeleteTarget === null}
        {...MRT_ROW_ACTION_MODAL_PROPS}
      >
        {page.freqDeleteError ? <PowerAlert severity="error">{page.freqDeleteError}</PowerAlert> : null}
      </ConfirmDangerDialog>

      <NetworkEtalonkaReportDialog
        report={page.etalonkaReport}
        description="Для поточної радіомережі"
        onClose={page.closeEtalonkaReportDialog}
        onDownload={page.downloadEtalonkaReport}
        onSetProgressExpanded={page.setEtalonkaReportProgressExpanded}
        onTypeChange={page.setEtalonkaReportType}
        onActiveFreqsOnlyChange={page.setEtalonkaReportActiveFreqsOnly}
        onIncludeSigintSignsChange={page.setEtalonkaReportIncludeSigintSigns}
        onIncludeConfirmationChange={page.setEtalonkaReportIncludeConfirmation}
        onIncludeUnitCallsignsChange={page.setEtalonkaReportIncludeUnitCallsigns}
        onIncludePelengsMapChange={page.setEtalonkaReportIncludePelengsMap}
        onFromDateTimeStrChange={page.setEtalonkaReportFromDateTimeStr}
        onToDateTimeStrChange={page.setEtalonkaReportToDateTimeStr}
      />
    </>
  );
}
