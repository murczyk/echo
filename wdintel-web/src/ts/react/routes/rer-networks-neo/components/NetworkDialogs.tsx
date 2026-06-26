import SummarizeOutlinedIcon from '@mui/icons-material/SummarizeOutlined';
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined';
import { MenuItem, Paper, Popper, Stack } from '@mui/material';
import { useEffect } from 'react';

import { ConfirmDangerDialog } from '../../../components/ConfirmDangerDialog';
import { MRT_ROW_ACTION_MODAL_PROPS } from '../../../components/MrtRowActionButton';
import type { useRerNetworksNeoPage } from '../use-rer-networks-neo-page';
import { NetworkEditDrawer } from '../../rer-network-details-neo/components/NetworkEditDrawer';
import { NetworkEtalonkaReportDialog } from '../../rer-network-details-neo/components/NetworkEtalonkaReportDialog';
import type { ListNetworksReq } from '../../../../../Bindings';

function getEtalonkaLaunchWarning(request: ListNetworksReq | null | undefined): string | null {
  if (request === null || request === undefined) return null;

  const isBroadRequest =
    request.ids === null &&
    (request.aorIds === null || request.aorIds.length === 0) &&
    request.filterFreq === null &&
    request.filterUnit === null &&
    request.filterUnitArmy === null &&
    request.filterUnitDivision === null &&
    request.filterUnitRegiment === null &&
    request.filterUnitBattalion === null &&
    request.filterText === null &&
    request.filterName === null &&
    request.filterLocation === null &&
    request.showOnlyFurtherInverstigation === null &&
    request.showInactive === true &&
    request.showOnlyDeleted === false &&
    request.statusFilter === null;

  if (!isBroadRequest) return null;

  return 'Цей звіт охоплює всі мережі. Сигнали й підтвердження збільшують час формування.';
}

type Props = {
  page: ReturnType<typeof useRerNetworksNeoPage>;
};

export function NetworkDialogs({ page }: Props) {
  useEffect(() => {
    if (page.reportsMenuAnchorEl === null) return;

    const closeReportsMenu = (event: globalThis.MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest('[data-reports-menu="true"]') !== null ||
        target?.closest('[data-reports-menu-button="true"]') !== null
      ) {
        return;
      }

      page.setReportsMenuAnchorEl(null);
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        page.setReportsMenuAnchorEl(null);
      }
    };

    document.addEventListener('click', closeReportsMenu, true);
    window.addEventListener('keydown', closeOnEscape);

    return () => {
      document.removeEventListener('click', closeReportsMenu, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [page.reportsMenuAnchorEl, page.setReportsMenuAnchorEl]);

  return (
    <>
      <Popper
        open={page.reportsMenuAnchorEl !== null}
        anchorEl={page.reportsMenuAnchorEl}
        placement="bottom-end"
        modifiers={[{ name: 'offset', options: { offset: [0, 8] } }]}
        sx={{ zIndex: (theme) => theme.zIndex.modal + 1 }}
      >
        <Paper data-reports-menu="true" sx={{ minWidth: 240, py: 1, boxShadow: 8 }}>
          <Stack spacing={0.5}>
            <MenuItem
              onClick={() => {
                page.setReportsMenuAnchorEl(null);
                page.openTopReportDialog();
              }}
              disabled={page.downloadInFlight !== null || !page.permissions.canExport}
            >
              <Stack direction="row" spacing={1} alignItems="center">
                <SummarizeOutlinedIcon fontSize="small" />
                <span>Еталонний опис</span>
              </Stack>
            </MenuItem>
            <MenuItem
              onClick={() => {
                page.setReportsMenuAnchorEl(null);
                void page.runDownload('goi');
              }}
              disabled={page.downloadInFlight !== null || !page.permissions.canExport}
            >
              <Stack direction="row" spacing={1} alignItems="center">
                <TableChartOutlinedIcon fontSize="small" />
                <span>ГОІ</span>
              </Stack>
            </MenuItem>
          </Stack>
        </Paper>
      </Popper>

      <NetworkEtalonkaReportDialog
        report={page.etalonkaReport}
        description={
          page.reportTargetRequest !== null
            ? 'Для мереж з поточними фільтрами'
            : page.reportTargetNetworkIds !== null && page.reportTargetNetworkIds.length > 1
              ? 'Для вибраних мереж'
              : 'Для поточної радіомережі'
        }
        launchWarningText={getEtalonkaLaunchWarning(page.reportTargetRequest)}
        onClose={page.closeReportDialog}
        onDownload={() => void page.downloadEtalonkaReport()}
        onSetProgressExpanded={(expanded) => page.setEtalonkaReport((current) => ({ ...current, progressExpanded: expanded }))}
        onTypeChange={(reportType) => page.setEtalonkaReport((current) => ({ ...current, reportType }))}
        onActiveFreqsOnlyChange={(activeFreqsOnly) => page.setEtalonkaReport((current) => ({ ...current, activeFreqsOnly }))}
        onIncludeSigintSignsChange={(includeSigintSigns) => page.setEtalonkaReport((current) => ({ ...current, includeSigintSigns }))}
        onIncludeConfirmationChange={(includeConfirmation) => page.setEtalonkaReport((current) => ({ ...current, includeConfirmation }))}
        onIncludeUnitCallsignsChange={(includeUnitCallsigns) => page.setEtalonkaReport((current) => ({ ...current, includeUnitCallsigns }))}
        onIncludePelengsMapChange={(includePelengsMap) => page.setEtalonkaReport((current) => ({ ...current, includePelengsMap }))}
        onFromDateTimeStrChange={(fromDateTimeStr) => page.setEtalonkaReport((current) => ({ ...current, fromDateTimeStr }))}
        onToDateTimeStrChange={(toDateTimeStr) => page.setEtalonkaReport((current) => ({ ...current, toDateTimeStr }))}
        {...MRT_ROW_ACTION_MODAL_PROPS}
      />

      <NetworkEditDrawer
        open={page.createDialog !== null}
        mode="create"
        form={page.createDialog}
        saving={page.createSubmitting}
        error={page.createError}
        referenceLoading={page.loading && page.unitOptions.length === 0 && page.postOptions.length === 0 && page.modulations.length === 0}
        aorOptions={page.aorOptions.map((aor) => ({ id: aor.id, label: aor.name }))}
        unitOptions={page.unitOptions}
        postOptions={page.postOptions}
        modulationOptions={page.modulations.map((modulation) => ({ id: modulation.id, label: modulation.name }))}
        onClose={page.closeCreateDialog}
        onChange={page.setCreateDialog}
        onSave={() => void page.saveNetworkCreate()}
      />

      <NetworkEditDrawer
        open={page.editDialog !== null}
        mode="edit"
        form={page.editDialog}
        saving={page.editSubmitting}
        error={page.editError}
        referenceLoading={page.loading && page.unitOptions.length === 0 && page.postOptions.length === 0 && page.modulations.length === 0}
        aorOptions={page.aorOptions.map((aor) => ({ id: aor.id, label: aor.name }))}
        unitOptions={page.unitOptions}
        postOptions={page.postOptions}
        modulationOptions={page.modulations.map((modulation) => ({ id: modulation.id, label: modulation.name }))}
        onClose={page.closeEditDialog}
        onChange={page.setEditDialog}
        onSave={(form) => void page.saveNetworkEdit(form)}
        {...MRT_ROW_ACTION_MODAL_PROPS}
      />

      <ConfirmDangerDialog
        open={page.deleteDialogNetwork !== null}
        onClose={page.closeDeleteDialog}
        onConfirm={() => void page.confirmDeleteNetwork()}
        title="Видалити мережу"
        description={`Ви дійсно хочете видалити мережу «${page.deleteDialogNetwork?.name ?? ''}»?`}
        submitting={page.deleteSubmitting}
        disabled={page.deleteDialogNetwork === null}
        {...MRT_ROW_ACTION_MODAL_PROPS}
      />
    </>
  );
}
