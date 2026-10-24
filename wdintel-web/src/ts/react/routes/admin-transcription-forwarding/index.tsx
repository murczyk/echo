import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Tooltip,
} from '@mui/material';
import { MRT_ROW_ACTION_MODAL_PROPS } from '../../components/MrtRowActionButton';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { PowerIconButton } from '../../components/PowerIconButton';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import { UnitsPaginationControl } from '../rer-units-neo/components/UnitsPaginationControl';
import { AddForwardingDialog } from './AddForwardingDialog';
import {
  DEFAULT_COLUMN_ORDER,
  DEFAULT_COLUMN_VISIBILITY,
  ForwardingTable,
} from './ForwardingTable';
import { useForwardingPage } from './use-forwarding-page';

export function TranscriptionForwardingPage() {
  return (
    <TableStateProvider
      tableId="admin-transcription-forwarding"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMN_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <TranscriptionForwardingPageBody />
    </TableStateProvider>
  );
}

function TranscriptionForwardingPageBody() {
  const {
    page,
    cursors,
    setCursors,
    loading,
    error,
    adding,
    setAdding,
    removing,
    setRemoving,
    busy,
    reload,
    refresh,
    remove,
  } = useForwardingPage();
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col gap-echo-lg overflow-hidden">
      <TablePageToolbar
        title="Пересилання транскрибації"
        titleInfo="Пересилання нових аудіо та їхніх транскрипцій у доступні вам активні групи Echo Native. Зміни не впливають на вже прийняті записи."
        filtersHidden
        internalActionsDisabled={loading || busy || !page}
        leadingInternalActions={
          <nav aria-label="Сторінки пересилань">
            <UnitsPaginationControl
              pageIndex={cursors.length - 1}
              pageSize={page?.pageSize ?? 0}
              totalCount={page?.totalCount ?? 0}
              hasNextPage={Boolean(page?.nextCursor)}
              loading={loading || busy || !page}
              onPrevPage={() => setCursors((values) => values.slice(0, -1))}
              onNextPage={() => {
                if (page?.nextCursor) setCursors((values) => [...values, page.nextCursor]);
              }}
            />
          </nav>
        }
        additionalInternalActions={
          <Tooltip title="Оновити">
            <span>
              <PowerIconButton
                aria-label="Оновити"
                size="small"
                disabled={loading || busy}
                onClick={reload}
              >
                <RefreshIcon fontSize="small" />
              </PowerIconButton>
            </span>
          </Tooltip>
        }
        actions={
          <PowerButton
            variant="contained"
            disabled={busy || loading || Boolean(error)}
            onClick={() => setAdding(true)}
          >
            Додати пересилання
          </PowerButton>
        }
      />
      {loading && <LinearProgress aria-label="Завантаження пересилань" />}
      {error && (
        <PowerAlert
          severity="error"
          action={<PowerButton onClick={refresh}>Повторити</PowerButton>}
        >
          {error}
        </PowerAlert>
      )}
      {page && (
        <div className="flex min-h-0 min-w-0 flex-1">
          <ForwardingTable
            items={page.items}
            rowOffset={(cursors.length - 1) * page.pageSize}
            disabled={busy}
            onRemove={setRemoving}
          />
        </div>
      )}
      {adding && (
        <AddForwardingDialog
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}
      <Dialog
        {...MRT_ROW_ACTION_MODAL_PROPS}
        open={Boolean(removing)}
        onClose={busy ? undefined : () => setRemoving(null)}
        aria-labelledby="remove-forwarding-title"
      >
        <DialogTitle id="remove-forwarding-title">Видалити пересилання?</DialogTitle>
        <DialogContent>
          {removing?.deviceName} → {removing?.groupName}. Нові аудіо більше не надходитимуть у цю
          групу. Інші пересилання залишаться без змін.
        </DialogContent>
        <DialogActions>
          <PowerButton disabled={busy} onClick={() => setRemoving(null)}>
            Скасувати
          </PowerButton>
          <PowerButton
            color="error"
            variant="contained"
            disabled={busy}
            onClick={() => void remove()}
          >
            Видалити
          </PowerButton>
        </DialogActions>
      </Dialog>
    </section>
  );
}
