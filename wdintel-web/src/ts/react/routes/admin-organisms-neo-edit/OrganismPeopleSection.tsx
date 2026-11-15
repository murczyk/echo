import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import type {
  Login,
  Organism,
  OrganismUserLabel,
  OrganismUserLabelsRsp,
} from '../../../../Bindings';
import { buildDefaultColumnOrder } from '../../components/mui-customized/table/get-default-table-options';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import { PageLoadingState } from '../../components/PageLoadingState';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { listLogins } from '../../services/api/logins';
import {
  assignOrganismUserLabel,
  deleteOrganismUserLabel,
  listOrganismUserLabels,
  setOrganismMessageStatsExclusion,
  upsertOrganismUserLabel,
} from '../../services/api/organism-user-labels';
import { listOrganisms } from '../../services/api/organisms';
import { listSigintZones } from '../../services/api/zones';
import { useOrganismManagement } from '../admin-organisms-neo/management-context';
import { AddUserDialog } from '../admin-users-neo/AddUserDialog';
import { EditUserDialog } from '../admin-users-neo/EditUserDialog';
import { UserManagementScope } from '../admin-users-neo/user-management-scope';
import type { UserLookups } from '../admin-users-neo/user-types';
import { DEFAULT_COLUMNS_VISIBILITY } from '../admin-users-neo/user-types';
import { OrganismUsersList } from './OrganismUsersList';

type SectionData = { users: Login[]; labels: OrganismUserLabelsRsp; organism: Organism };
type Run = (operation: () => Promise<unknown>) => Promise<void>;

function LabelEditor({
  label,
  organismId,
  close,
  run,
  busy,
}: {
  label: Partial<OrganismUserLabel>;
  organismId: number;
  close: () => void;
  run: Run;
  busy: boolean;
}) {
  const [name, setName] = useState(label.name ?? '');
  const [color, setColor] = useState(label.color ?? '#87d7f1');
  return (
    <Dialog open onClose={busy ? undefined : close} fullWidth maxWidth="xs">
      <DialogTitle>{label.id ? 'Редагувати лейбл' : 'Створити лейбл'}</DialogTitle>
      <DialogContent>
        <div className="flex flex-col gap-echo-xl pt-echo-sm">
          <TextField
            autoFocus
            label="Назва лейбла"
            value={name}
            onChange={(event) => setName(event.target.value)}
            inputProps={{ maxLength: 80 }}
            disabled={busy}
          />
          <TextField
            label="Колір графіка"
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
            disabled={busy}
          />
        </div>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={busy}>
          Скасувати
        </Button>
        <Button
          disabled={busy || !name.trim()}
          onClick={() =>
            void run(async () => {
              await upsertOrganismUserLabel({
                id: label.id ?? null,
                organismId,
                name: name.trim(),
                color,
              });
              close();
            })
          }
        >
          Зберегти
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function OrganismLabelsList({
  labels,
  busy,
  edit,
  remove,
}: {
  labels: OrganismUserLabelsRsp;
  busy: boolean;
  edit: (label: OrganismUserLabel) => void;
  remove: (label: OrganismUserLabel) => void;
}) {
  return (
    <>
      <Typography color="text.secondary">
        Кожен користувач має один лейбл або залишається без лейбла. Лейбл визначає панель статистики
        для його повідомлень.
      </Typography>
      {!labels.labels.length ? <PowerAlert severity="info">Лейблів ще немає.</PowerAlert> : null}
      {labels.labels.map((label) => (
        <div
          key={label.id}
          className="flex flex-col gap-echo-lg border-b border-echo-border py-echo-sm echo-sm:flex-row echo-sm:items-center"
        >
          <span
            className="size-echo-icon-sm shrink-0 rounded-echo-sm"
            style={{ backgroundColor: label.color }}
            aria-hidden="true"
          />
          <Typography className="flex-1">{label.name}</Typography>
          <Typography color="text.secondary">
            Користувачів: {labels.assignments.filter((entry) => entry.labelId === label.id).length}
          </Typography>
          <Button onClick={() => edit(label)} disabled={busy}>
            Редагувати
          </Button>
          <Button color="error" onClick={() => remove(label)} disabled={busy}>
            Видалити
          </Button>
        </div>
      ))}
    </>
  );
}

function OrganismPeopleSectionBody({
  organismId,
  mode,
}: {
  organismId: number | null;
  mode: 'users' | 'labels';
}) {
  const { globalAdmin } = useOrganismManagement();
  const [zones, setZones] = useState<UserLookups['zones']>([]);
  const [organisms, setOrganisms] = useState<Organism[]>([]);
  const [data, setData] = useState<SectionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [labelEditor, setLabelEditor] = useState<Partial<OrganismUserLabel> | null>(null);
  const [userEditor, setUserEditor] = useState<Login | 'new' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OrganismUserLabel | null>(null);
  const editorTrigger = useRef<HTMLElement | null>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  const { notify } = usePowerSnackbar();
  useEffect(() => {
    if (organismId === null) return;
    let active = true;
    Promise.all([
      listLogins({ sortBy: null, filterByRoles: null }),
      listOrganismUserLabels(organismId),
      listOrganisms({ sortBy: null }),
      globalAdmin ? listSigintZones() : Promise.resolve([]),
    ])
      .then(([users, labels, organisms, zones]) => {
        const organism = organisms.find((item) => item.id === organismId);
        if (!organism) throw new Error('Організм не знайдено.');
        if (active) {
          setZones(zones);
          setOrganisms(organisms);
          setData({
            users: users.users.filter((user) => user.organismId === organismId),
            labels,
            organism,
          });
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (!active) return;
        const message =
          reason instanceof Error
            ? reason.message
            : 'Не вдалося завантажити користувачів та лейбли.';
        setError(message);
        notify({ severity: 'error', message });
      });
    return () => {
      active = false;
    };
  }, [organismId, revision, notify, globalAdmin]);
  const run: Run = async (operation) => {
    setBusy(true);
    try {
      await operation();
      setRevision((value) => value + 1);
      setError(null);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Не вдалося зберегти зміни.';
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setBusy(false);
    }
  };
  if (organismId === null)
    return (
      <PowerAlert severity="info" dismissible={false}>
        Спочатку збережіть організм.
      </PowerAlert>
    );
  if (!data)
    return error ? (
      <PowerAlert severity="error" dismissible={false}>
        {error}
        <Button onClick={() => setRevision((value) => value + 1)}>Повторити</Button>
      </PowerAlert>
    ) : (
      <PageLoadingState />
    );
  const lookups: UserLookups = {
    zones,
    zonesStatus: 'success',
    zonesError: null,
    organisms: globalAdmin ? organisms : [data.organism],
    organismsStatus: 'success',
    organismsError: null,
  };
  return (
    <UserManagementScope.Provider value={globalAdmin ? null : data.organism}>
      <div
        className="flex min-w-0 flex-col gap-echo-lg"
        ref={sectionRef}
        onClickCapture={(event) => {
          if (!userEditor && event.target instanceof Element)
            editorTrigger.current = event.target.closest('button');
        }}
      >
        {error ? (
          <PowerAlert severity="error" dismissible={false}>
            {error}
          </PowerAlert>
        ) : null}
        {mode === 'labels' ? (
          <div>
            <PowerButton variant="contained" disabled={busy} onClick={() => setLabelEditor({})}>
              Створити лейбл
            </PowerButton>
          </div>
        ) : (
          <TablePageToolbar
            title="Користувачі"
            withGlobalTextFilter
            actions={
              <PowerButton variant="contained" disabled={busy} onClick={() => setUserEditor('new')}>
                Додати користувача
              </PowerButton>
            }
          />
        )}
        {mode === 'labels' ? (
          <OrganismLabelsList
            labels={data.labels}
            busy={busy}
            edit={setLabelEditor}
            remove={setDeleteTarget}
          />
        ) : (
          <OrganismUsersList
            users={data.users}
            labels={data.labels}
            busy={busy}
            edit={setUserEditor}
            onUserUpdated={(user) =>
              setData((current) =>
                current
                  ? {
                      ...current,
                      users: current.users
                        .map((item) => (item.id === user.id ? user : item))
                        .filter((item) => item.organismId === organismId),
                    }
                  : current,
              )
            }
            assignLabel={(loginId, labelId) =>
              void run(() => assignOrganismUserLabel({ organismId, loginId, labelId }))
            }
            setExcluded={(loginId, excluded) =>
              void run(async () => {
                await setOrganismMessageStatsExclusion({ organismId, loginId, excluded });
                setData((current) => {
                  if (!current) return current;
                  const ids = current.labels.excludedLoginIds.filter((id) => id !== loginId);
                  return {
                    ...current,
                    labels: {
                      ...current.labels,
                      excludedLoginIds: excluded ? [...ids, loginId] : ids,
                    },
                  };
                });
              })
            }
          />
        )}
        {labelEditor ? (
          <LabelEditor
            label={labelEditor}
            organismId={organismId}
            close={() => setLabelEditor(null)}
            run={run}
            busy={busy}
          />
        ) : null}
        <AddUserDialog
          open={userEditor === 'new'}
          initialOrganismId={organismId}
          onClose={() => setUserEditor(null)}
          lookups={lookups}
          onUserCreated={(user) =>
            setData((current) =>
              current && user.organismId === organismId
                ? { ...current, users: [user, ...current.users] }
                : current,
            )
          }
        />
        <EditUserDialog
          open={Boolean(userEditor && userEditor !== 'new')}
          login={userEditor === 'new' ? null : userEditor}
          disableRestoreFocus
          onExited={() => {
            const trigger = editorTrigger.current;
            if (trigger?.isConnected) trigger.focus();
            else sectionRef.current?.querySelector<HTMLElement>('button')?.focus();
          }}
          onClose={() => setUserEditor(null)}
          lookups={lookups}
          onUserUpdated={(user) =>
            setData((current) =>
              current
                ? {
                    ...current,
                    users: current.users
                      .map((item) => (item.id === user.id ? user : item))
                      .filter((item) => item.organismId === organismId),
                  }
                : current,
            )
          }
        />
        <Dialog open={!!deleteTarget} onClose={busy ? undefined : () => setDeleteTarget(null)}>
          <DialogTitle>Видалити лейбл «{deleteTarget?.name}»?</DialogTitle>
          <DialogContent>Його користувачі перейдуть до панелі «Без лейбла».</DialogContent>
          <DialogActions>
            <Button onClick={() => setDeleteTarget(null)} disabled={busy}>
              Скасувати
            </Button>
            <Button
              color="error"
              disabled={busy}
              onClick={() =>
                deleteTarget &&
                void run(async () => {
                  await deleteOrganismUserLabel({ organismId, labelId: deleteTarget.id });
                  setDeleteTarget(null);
                })
              }
            >
              Видалити
            </Button>
          </DialogActions>
        </Dialog>
      </div>
    </UserManagementScope.Provider>
  );
}

const ORGANISM_USER_COLUMN_ORDER = buildDefaultColumnOrder({
  dataColumnIds: [
    'login',
    'roles',
    'userLabel',
    'messageStatsExcluded',
    'status',
    'createdAt',
    'id',
    'organism',
    'zone',
    'deltaLogin',
    'description',
  ],
  withRowActions: true,
  withRowNumbers: true,
});
export function OrganismPeopleSection(props: {
  organismId: number | null;
  mode: 'users' | 'labels';
}) {
  if (props.mode === 'labels') return <OrganismPeopleSectionBody {...props} />;
  return (
    <TableStateProvider
      key={props.organismId}
      tableId={`organism-users-${props.organismId}`}
      defaultColumnOrder={ORGANISM_USER_COLUMN_ORDER}
      defaultColumnVisibility={{ ...DEFAULT_COLUMNS_VISIBILITY, organism: false, createdAt: false }}
      defaultEnableColumnOrdering={false}
    >
      <OrganismPeopleSectionBody {...props} />
    </TableStateProvider>
  );
}
