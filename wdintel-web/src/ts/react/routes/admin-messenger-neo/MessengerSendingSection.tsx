import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Autocomplete,
  FormControlLabel,
  IconButton,
  Switch,
  TablePagination,
  TextField,
  Tooltip,
} from '@mui/material';
import { useEffect, useState } from 'react';
import type {
  EchoAccountF1,
  MessengerAlertHistoryEntry,
  MessengerAlertHistoryRsp,
  MessengerAlertSettings,
} from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { PowerSnackbarProvider, usePowerSnackbar } from '../../components/PowerSnackbar';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import {
  type AppMrtColumnDef,
  mrtCustomCell,
  mrtTextCell,
} from '../../components/mui-customized/table/get-default-table-options';
import {
  getMessengerAlertSettings,
  listMessengerAlertHistory,
  saveMessengerAlertSettings,
} from '../../services/api/messenger-alerts';
import { listAccounts } from '../../services/api/messenger';
import { SettingsNeoTable } from '../settings-neo/SettingsNeoTable';
import { transformAccounts } from './transform-accounts';

const PAGE_SIZE = 20;
const STATUS_LABELS: Record<string, string> = {
  queued: 'У черзі',
  sending: 'Відправляється',
  sent: 'Надіслано',
  failed: 'Помилка',
  skipped: 'Пропущено',
};
const COLUMN_ORDER = [
  'createdAt',
  'recipientLogin',
  'recipientProfileId',
  'messageUrl',
  'status',
  'senderName',
  'sentAt',
  'error',
];
const COLUMN_VISIBILITY = Object.fromEntries(COLUMN_ORDER.map((id) => [id, true]));
const COLUMNS: AppMrtColumnDef<MessengerAlertHistoryEntry>[] = [
  {
    accessorKey: 'createdAt',
    header: 'Створено',
    meta: { overflowMode: 'text' },
    Cell: mrtTextCell<MessengerAlertHistoryEntry>({
      displayValue: ({ row }) => new Date(row.original.createdAt).toLocaleString('uk-UA'),
    }),
  },
  { accessorKey: 'recipientLogin', header: 'Одержувач' },
  { accessorKey: 'recipientProfileId', header: 'Профіль в месенджері' },
  {
    accessorKey: 'messageUrl',
    header: 'Повідомлення',
    meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
    Cell: mrtCustomCell<MessengerAlertHistoryEntry>(({ row }) => (
      <a href={row.original.messageUrl} target="_blank" rel="noreferrer">
        Відкрити повідомлення
      </a>
    )),
  },
  {
    accessorKey: 'status',
    header: 'Статус',
    meta: { overflowMode: 'text' },
    Cell: mrtTextCell<MessengerAlertHistoryEntry>({
      displayValue: ({ row }) => STATUS_LABELS[row.original.status] ?? row.original.status,
    }),
  },
  { accessorKey: 'senderName', header: 'Відправник' },
  {
    accessorKey: 'sentAt',
    header: 'Надіслано',
    meta: { overflowMode: 'text' },
    Cell: mrtTextCell<MessengerAlertHistoryEntry>({
      displayValue: ({ row }) =>
        row.original.sentAt ? new Date(row.original.sentAt).toLocaleString('uk-UA') : '—',
    }),
  },
  { accessorKey: 'error', header: 'Помилка' },
];

function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'Невідома помилка';
}

function DeliveryHistory() {
  const { notify } = usePowerSnackbar();
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [page, setPage] = useState(0);
  const [history, setHistory] = useState<MessengerAlertHistoryRsp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const cursor = cursors[page];

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setHistory(null);
    void listMessengerAlertHistory({ beforeId: cursor }, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) setHistory(response);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = `Помилка завантаження історії: ${errorText(error)}`;
        setError(message);
        notify({ severity: 'error', message });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [cursor, revision, notify]);

  const entries = history?.entries ?? [];
  function refresh() {
    setPage(0);
    setCursors([null]);
    setRevision((current) => current + 1);
  }

  return (
    <div className="flex flex-col gap-echo-md">
      <div className="flex items-center justify-between gap-echo-md">
        <h2 className="m-0 text-echo-lg font-bold">Історія відправки</h2>
        <PowerButton startIcon={<RefreshIcon />} onClick={refresh} disabled={loading}>
          Оновити
        </PowerButton>
      </div>
      {error ? (
        <PowerAlert severity="error" autoHideDuration={null}>
          {error}
        </PowerAlert>
      ) : null}
      <TableStateProvider
        tableId="messenger-alert-history"
        defaultColumnOrder={COLUMN_ORDER}
        defaultColumnVisibility={COLUMN_VISIBILITY}
        defaultEnableColumnOrdering={false}
      >
        <SettingsNeoTable
          columns={COLUMNS.map((column) => ({
            ...column,
            enableSorting: false,
            enableColumnFilter: false,
          }))}
          data={entries}
          loading={loading}
          showToolbarInternalActions
          enableTopToolbar
          toolbarFiltersHidden
          renderBottomToolbar={() => (
            <TablePagination
              component="div"
              count={!history || history.nextBeforeId ? -1 : page * PAGE_SIZE + entries.length}
              page={page}
              rowsPerPage={PAGE_SIZE}
              rowsPerPageOptions={[PAGE_SIZE]}
              labelDisplayedRows={() =>
                entries.length
                  ? `${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + entries.length}`
                  : '0'
              }
              getItemAriaLabel={(type) =>
                type === 'previous' ? 'Попередня сторінка' : 'Наступна сторінка'
              }
              backIconButtonProps={{ disabled: loading || page === 0 }}
              nextIconButtonProps={{ disabled: loading || !history?.nextBeforeId }}
              onPageChange={(_, nextPage) => {
                if (loading) return;
                if (nextPage > page) {
                  if (!history?.nextBeforeId) return;
                  setCursors((current) => [...current.slice(0, page + 1), history.nextBeforeId]);
                }
                setPage(nextPage);
              }}
            />
          )}
        />
      </TableStateProvider>
    </div>
  );
}

function MessengerSendingForm() {
  const { notify } = usePowerSnackbar();
  const [settings, setSettings] = useState<MessengerAlertSettings | null>(null);
  const [savedSettings, setSavedSettings] = useState<MessengerAlertSettings | null>(null);
  const [accounts, setAccounts] = useState<EchoAccountF1[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    void Promise.all([getMessengerAlertSettings(controller.signal), listAccounts()])
      .then(([response, accounts]) => {
        if (controller.signal.aborted) return;
        setSettings(response);
        setSavedSettings(response);
        setAccounts(transformAccounts(accounts.accounts));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = `Помилка завантаження відправки: ${errorText(error)}`;
        setError(message);
        notify({ severity: 'error', message });
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [notify, revision]);

  const senders = accounts.filter(
    (account) =>
      account.canSendMessages === true &&
      !account.isImported &&
      ['signal', 'whatsapp'].includes(account.messenger),
  );
  const selected = settings?.senderDatasourceIds ?? [];
  const missingSender = !savedSettings?.senderDatasourceIds.some((id) =>
    senders.some((account) => account.id === id),
  );
  const senderLabel = (id: number) => {
    const account = accounts.find((account) => account.id === id);
    return account
      ? `${account.displayName} · ${account.messenger} · ${account.phoneNumber}`
      : `Недоступний акаунт #${id}`;
  };

  async function save() {
    if (!settings || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await saveMessengerAlertSettings(settings);
      setSettings(response);
      setSavedSettings(response);
      notify({ severity: 'success', message: 'Налаштування відправки збережено' });
    } catch (error) {
      const message = `Помилка збереження відправки: ${errorText(error)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setBusy(false);
    }
  }

  function moveSender(index: number, direction: number) {
    if (!settings) return;
    const ids = [...selected];
    [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
    setSettings({ ...settings, senderDatasourceIds: ids });
  }

  return (
    <div className="flex flex-col gap-echo-lg p-echo-lg">
      <h2 className="m-0 text-echo-lg font-bold">Відправка сповіщень</h2>
      {error ? (
        <PowerAlert severity="error" autoHideDuration={null}>
          {error}
        </PowerAlert>
      ) : null}
      {savedSettings && missingSender ? (
        <PowerAlert severity="warning" autoHideDuration={null}>
          Відправка вимкнена: не вибрано месенджер для відправки.
        </PowerAlert>
      ) : null}
      {settings ? (
        <>
          <FormControlLabel
            label="Надсилати згадки у важливих повідомленнях"
            control={
              <Switch
                checked={settings.enabled}
                disabled={busy}
                onChange={(_, enabled) => setSettings({ ...settings, enabled })}
              />
            }
          />
          <Autocomplete
            multiple
            options={senders.map((account) => account.id)}
            value={selected}
            getOptionLabel={senderLabel}
            disabled={busy}
            onChange={(_, senderDatasourceIds) => setSettings({ ...settings, senderDatasourceIds })}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Месенджери для відправки"
                helperText="У вкладці «Акаунти» увімкніть «Надсилати повідомлення». Доставка використовує перший доступний акаунт відповідного месенджера."
              />
            )}
          />
          <ol className="m-0 flex list-none flex-col gap-echo-sm p-0">
            {selected.map((id, index) => (
              <li key={id} className="flex items-center gap-echo-sm">
                <span>
                  {index + 1}. {senderLabel(id)}
                </span>
                <Tooltip title="Підняти">
                  <span>
                    <IconButton
                      aria-label={`Підняти ${senderLabel(id)}`}
                      size="small"
                      disabled={busy || index === 0}
                      onClick={() => moveSender(index, -1)}
                    >
                      <ArrowUpwardIcon />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title="Опустити">
                  <span>
                    <IconButton
                      aria-label={`Опустити ${senderLabel(id)}`}
                      size="small"
                      disabled={busy || index === selected.length - 1}
                      onClick={() => moveSender(index, 1)}
                    >
                      <ArrowDownwardIcon />
                    </IconButton>
                  </span>
                </Tooltip>
              </li>
            ))}
          </ol>
          <div>
            <PowerButton variant="contained" onClick={() => void save()} disabled={busy}>
              Зберегти
            </PowerButton>
          </div>
        </>
      ) : !busy ? (
        <div>
          <PowerButton onClick={() => setRevision((value) => value + 1)}>
            Повторити завантаження
          </PowerButton>
        </div>
      ) : null}
      <DeliveryHistory />
    </div>
  );
}

export function MessengerSendingSection() {
  return (
    <PowerSnackbarProvider>
      <MessengerSendingForm />
    </PowerSnackbarProvider>
  );
}
