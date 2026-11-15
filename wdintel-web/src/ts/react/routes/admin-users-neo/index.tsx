import { useEffect, useMemo, useState } from 'react';

import { AreaOfResponsibility, Login, Organism } from '../../../../Bindings';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { TableContentState } from '../../components/TableContentState';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { listAors } from '../../services/api/aor';
import { listLogins } from '../../services/api/logins';
import { listOrganisms } from '../../services/api/organisms';
import { listSigintZones } from '../../services/api/zones';

import { AddUserDialog } from './AddUserDialog';
import { buildAorColumnLookup } from './aor-column';
import { EditUserDialog } from './EditUserDialog';
import { debugLog, formatErrorMessage } from './user-display';
import {
  DEFAULT_COLUMN_ORDER,
  DEFAULT_COLUMNS_VISIBILITY,
  LoadingStatus,
  UserLookups,
  ZoneEntry,
} from './user-types';
import { UsersTable } from './UsersTable';
export function AdminUsersNeoPageBody() {
  const [logins, setLogins] = useState<Login[]>([]);
  const [status, setStatus] = useState<LoadingStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingLogin, setEditingLogin] = useState<Login | null>(null);
  const [zones, setZones] = useState<ZoneEntry[]>([]);
  const [organisms, setOrganisms] = useState<Organism[]>([]);
  const [zonesStatus, setZonesStatus] = useState<LoadingStatus>('idle');
  const [zonesError, setZonesError] = useState<string | null>(null);
  const [organismsStatus, setOrganismsStatus] = useState<LoadingStatus>('idle');
  const [organismsError, setOrganismsError] = useState<string | null>(null);
  const [aors, setAors] = useState<AreaOfResponsibility[]>([]);
  const [aorsStatus, setAorsStatus] = useState<LoadingStatus>('idle');
  const [aorsError, setAorsError] = useState<string | null>(null);

  async function loadLogins() {
    debugLog('loadLogins:start');
    setStatus('loading');
    setError(null);
    try {
      const rsp = await listLogins({ sortBy: 'LoginCreatedAtDesc', filterByRoles: null });
      debugLog('loadLogins:success', { count: rsp.users?.length ?? 0 });
      setLogins(rsp.users ?? []);
      setStatus('success');
    } catch (err) {
      debugLog('loadLogins:error', err);
      setStatus('error');
      setError(formatErrorMessage(err));
    }
  }

  async function loadZones() {
    debugLog('loadZones:start');
    setZonesStatus('loading');
    setZonesError(null);
    try {
      const zoneList = await listSigintZones();
      debugLog('loadZones:success', { count: zoneList.length, sample: zoneList.slice(0, 3) });
      setZones(zoneList);
      setZonesStatus('success');
    } catch (err) {
      debugLog('loadZones:error', err);
      setZonesStatus('error');
      setZonesError(formatErrorMessage(err));
    }
  }

  async function loadOrganisms() {
    debugLog('loadOrganisms:start');
    setOrganismsStatus('loading');
    setOrganismsError(null);
    try {
      const organismList = await listOrganisms({ sortBy: null });
      debugLog('loadOrganisms:success', {
        count: organismList.length,
        sample: organismList.slice(0, 3),
      });
      setOrganisms(organismList);
      setOrganismsStatus('success');
    } catch (err) {
      debugLog('loadOrganisms:error', err);
      setOrganismsStatus('error');
      setOrganismsError(formatErrorMessage(err));
    }
  }

  async function loadAors() {
    setAorsStatus('loading');
    setAorsError(null);
    try {
      setAors(await listAors({ sortBy: null }));
      setAorsStatus('success');
    } catch (err) {
      setAorsStatus('error');
      setAorsError(formatErrorMessage(err));
    }
  }

  useEffect(() => {
    loadLogins();
    void loadZones();
    void loadOrganisms();
    void loadAors();
  }, []);

  const aorLookup = useMemo(
    () => buildAorColumnLookup(organisms, aors, aorsStatus === 'success' || aorsStatus === 'error'),
    [organisms, aors, aorsStatus],
  );

  const lookups: UserLookups = {
    zones,
    zonesStatus,
    zonesError,
    organisms,
    organismsStatus,
    organismsError,
  };

  const renderTable = () => {
    return (
      <TableContentState
        status={status}
        errorMessage={error || 'Помилка завантаження'}
        loadingContent={
          <div className="flex w-full min-w-0 flex-1 min-h-0">
            <UsersTable
              data={logins}
              loading
              aorLookup={aorLookup}
              onEdit={(login) => setEditingLogin(login)}
              onUserUpdated={(login) =>
                setLogins((prev) => prev.map((item) => (item.id === login.id ? login : item)))
              }
            />
          </div>
        }
      >
        <div className="flex w-full min-w-0 flex-1 min-h-0">
          <UsersTable
            data={logins}
            loading={false}
            aorLookup={aorLookup}
            onEdit={(login) => setEditingLogin(login)}
            onUserUpdated={(login) =>
              setLogins((prev) => prev.map((item) => (item.id === login.id ? login : item)))
            }
          />
        </div>
      </TableContentState>
    );
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-echo-lg overflow-hidden">
      <div className="shrink-0">
        <TablePageToolbar
          title="Користувачі"
          withGlobalTextFilter
          hideGlobalTextFilter={status !== 'success'}
          internalActionsDisabled={status !== 'success'}
          actions={
            <div className="flex gap-3">
              <PowerButton variant="contained" onClick={() => setCreateOpen(true)}>
                Додати користувача
              </PowerButton>
            </div>
          }
        />
      </div>

      {organismsError ? (
        <div className="shrink-0">
          <PowerAlert severity="error">{`Не вдалося завантажити організми: ${organismsError}`}</PowerAlert>
        </div>
      ) : null}
      {aorsError ? (
        <div className="shrink-0">
          <PowerAlert severity="error">{`Не вдалося завантажити смуги: ${aorsError}`}</PowerAlert>
        </div>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1">{renderTable()}</div>

      <AddUserDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onUserCreated={(login) => setLogins((prev) => [login, ...prev])}
        lookups={lookups}
      />
      <EditUserDialog
        open={Boolean(editingLogin)}
        login={editingLogin}
        onClose={() => setEditingLogin(null)}
        onUserUpdated={(login) =>
          setLogins((prev) => prev.map((item) => (item.id === login.id ? login : item)))
        }
        lookups={lookups}
        disableRestoreFocus
      />
    </div>
  );
}

export function AllUsersTab() {
  return (
    <TableStateProvider
      tableId="admin-users-neo"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <AdminUsersNeoPageBody />
    </TableStateProvider>
  );
}

export function AdminUsersNeoPage() {
  return <AllUsersTab />;
}

export { AddUserDialog } from './AddUserDialog';
export { EditUserDialog } from './EditUserDialog';
