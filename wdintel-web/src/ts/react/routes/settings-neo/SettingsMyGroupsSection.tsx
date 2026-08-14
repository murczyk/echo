import EditIcon from '@mui/icons-material/Edit';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import {
  Autocomplete,
  Box,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useId, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';

import type {
  AreaOfResponsibility,
  MyAdminSignalGroup,
  MyOrganism,
  SignalGroupLogin,
} from '../../../../Bindings';
import { ELLIPSIS } from '../../utils/misc';
import { PowerButton } from '../../components/PowerButton';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerIconButton } from '../../components/PowerIconButton';
import { PowerMenu } from '../../components/PowerMenu';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import { fetchMyAdminGroupEditReference, updateMyAdminGroup } from '../../services/api/zones';
import { SettingsNeoTable } from './SettingsNeoTable';
import type { AppMrtColumnDef } from '../../components/mui-customized/table/get-default-table-options';

const DEFAULT_MY_GROUPS_COLUMNS_VISIBILITY = {
  name: true,
  aors: true,
  admins: true,
  privacy: true,
  allowedUsers: true,
};

const DEFAULT_MY_GROUPS_EDIT_COLUMNS_VISIBILITY = {
  actions: true,
  ...DEFAULT_MY_GROUPS_COLUMNS_VISIBILITY,
};

const DEFAULT_MY_GROUPS_COLUMN_ORDER = [
  'mrt-row-numbers',
  'name',
  'aors',
  'admins',
  'privacy',
  'allowedUsers',
];

const DEFAULT_MY_GROUPS_EDIT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'actions',
  'name',
  'aors',
  'admins',
  'privacy',
  'allowedUsers',
];

const MY_GROUPS_SETUP_FLOW_IMAGE_ALT =
  'Схема додавання групи: 1. Додайте номер бота до групи Signal або WhatsApp. 2. Напишіть в підтримку "Додано групу ...". 3. Вкажіть тип групи: приватна група — користувачі Delta1, Delta2; смугова група — смуга АК33, АК34.';

const DISABLE_NETWORK_ASSIGNMENT_TOOLTIP =
  'Корисно для глобальних груп що діють на дуже широкій смузі';

type ReferenceDataStatus = 'idle' | 'loading' | 'success' | 'error';

type MyGroupEditState = {
  group: MyAdminSignalGroup;
  isSecret: boolean;
  disableNetworkAssignment: boolean;
  selectedUsers: SignalGroupLogin[];
  selectedOrganismIds: number[];
  selectedAdmins: SignalGroupLogin[];
  selectedAorIds: number[];
  isSaving: boolean;
  error: string | null;
};

function formatAors(group: MyAdminSignalGroup): string {
  const aors = group.areasOfResponsibility ?? [];
  if (aors.length === 0) return '—';
  return aors.map((aor) => aor.name).join(', ');
}

function formatGroupLogin(login: SignalGroupLogin): string {
  if (
    !login.deltaLogin ||
    login.login.toLocaleLowerCase() === login.deltaLogin.toLocaleLowerCase()
  ) {
    return login.login;
  }
  return `${login.login} (${login.deltaLogin})`;
}

function formatGroupLogins(logins: SignalGroupLogin[]): string {
  if (logins.length === 0) return '—';
  return logins.map(formatGroupLogin).join(', ');
}

function formatOrganismIds(organismIds: number[]): string {
  if (organismIds.length === 0) return '—';
  return organismIds.map((id) => `#${id}`).join(', ');
}

function formatAllowedUsers(group: MyAdminSignalGroup): string {
  if (!group.isGroupSecret) return 'без обмежень';
  const parts: string[] = [];
  if (group.allowedUsers.length > 0) parts.push(formatGroupLogins(group.allowedUsers));
  if (group.allowedOrganismIds.length > 0) {
    parts.push(`Організми: ${formatOrganismIds(group.allowedOrganismIds)}`);
  }
  return parts.length > 0 ? parts.join('; ') : '—';
}

function selectedOrganisms(selectedIds: number[], options: MyOrganism[]) {
  return selectedIds
    .map((id) => options.find((organism) => organism.id === id))
    .filter(Boolean) as MyOrganism[];
}

export function preserveUnknownOrganismIds(
  selectedOrganisms: MyOrganism[],
  previousIds: number[],
  options: MyOrganism[],
) {
  const optionIds = new Set(options.map((organism) => organism.id));
  return [
    ...previousIds.filter((id) => !optionIds.has(id)),
    ...selectedOrganisms.map((organism) => organism.id),
  ];
}

function DisableNetworkAssignmentLabel() {
  return (
    <Box
      component="span"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}
    >
      <Box component="span">Вимкнути привʼязку мереж</Box>
      <Tooltip title={DISABLE_NETWORK_ASSIGNMENT_TOOLTIP} placement="top">
        <Box
          component="span"
          sx={{ display: 'inline-flex', color: 'text.secondary', lineHeight: 0, cursor: 'default' }}
          aria-label="Підказка"
        >
          <InfoOutlinedIcon sx={{ fontSize: 16 }} />
        </Box>
      </Tooltip>
    </Box>
  );
}

function MyGroupActions(props: {
  group: MyAdminSignalGroup;
  onEdit: (group: MyAdminSignalGroup) => void;
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const menuButtonId = useId();
  const menuLabelId = `${menuButtonId}-trigger`;
  const menuOpen = Boolean(anchorEl);

  function handleMenuOpen(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setAnchorEl(event.currentTarget);
  }

  function handleEdit(event: MouseEvent<HTMLLIElement>) {
    event.stopPropagation();
    setAnchorEl(null);
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    window.setTimeout(() => props.onEdit(props.group), 0);
  }

  return (
    <>
      <Tooltip title="Дії">
        <span style={{ display: 'inline-flex' }}>
          <PowerIconButton
            id={menuLabelId}
            size="small"
            aria-label="Дії"
            aria-controls={menuOpen ? menuButtonId : undefined}
            aria-expanded={menuOpen ? 'true' : undefined}
            aria-haspopup="menu"
            onClick={handleMenuOpen}
            sx={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              color: 'text.primary',
            }}
          >
            <MoreVertIcon fontSize="small" />
          </PowerIconButton>
        </span>
      </Tooltip>
      <PowerMenu
        id={menuButtonId}
        anchorEl={anchorEl}
        open={menuOpen}
        onClose={() => setAnchorEl(null)}
        slotProps={{ list: { 'aria-labelledby': menuLabelId } }}
      >
        <MenuItem onClick={handleEdit} sx={{ pl: 0.5 }}>
          <ListItemIcon
            sx={{
              minWidth: 40,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <EditIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Редагувати" />
        </MenuItem>
      </PowerMenu>
    </>
  );
}

function useMyGroupsColumns(
  enableEditActions: boolean,
  onEdit: (group: MyAdminSignalGroup) => void,
) {
  return useMemo<AppMrtColumnDef<MyAdminSignalGroup>[]>(
    () => [
      ...(enableEditActions
        ? [
            {
              header: 'Дії',
              id: 'actions',
              meta: { overflowMode: 'none' },
              Cell: ({ row }) => <MyGroupActions group={row.original} onEdit={onEdit} />,
              enableColumnActions: false,
              enableColumnFilter: false,
              enableSorting: false,
              size: 56,
            } satisfies AppMrtColumnDef<MyAdminSignalGroup>,
          ]
        : []),
      {
        header: 'Група',
        id: 'name',
        accessorFn: (row) => row.name || row.masterKey.slice(-5),
        size: 160,
      },
      {
        header: 'Смуги',
        id: 'aors',
        accessorFn: formatAors,
        enableSorting: false,
        size: 130,
      },
      {
        header: 'Адміни',
        id: 'admins',
        accessorFn: (row) => formatGroupLogins(row.adminLogins),
        enableSorting: false,
        size: 180,
      },
      {
        header: 'Є приватною',
        id: 'privacy',
        accessorFn: (row) => (row.isGroupSecret ? 'так' : 'ні'),
        size: 110,
      },
      {
        header: 'Логіни приватної групи',
        id: 'allowedUsers',
        accessorFn: formatAllowedUsers,
        enableSorting: false,
        size: 250,
      },
    ],
    [enableEditActions, onEdit],
  );
}

function SettingsMyGroupsTable(props: {
  groups: MyAdminSignalGroup[];
  loading: boolean;
  enableEditActions: boolean;
  onEdit: (group: MyAdminSignalGroup) => void;
}) {
  const columns = useMyGroupsColumns(props.enableEditActions, props.onEdit);
  return <SettingsNeoTable columns={columns} data={props.groups} loading={props.loading} />;
}

function MyGroupsSetupFlowImage() {
  return (
    <Box
      component="img"
      src="/img/settings-my-groups-flow.svg"
      alt={MY_GROUPS_SETUP_FLOW_IMAGE_ALT}
      sx={{
        display: 'block',
        width: '100%',
        maxWidth: 920,
        height: 'auto',
        mt: 0.5,
        borderRadius: 1,
      }}
    />
  );
}

export type SettingsMyGroupsSectionProps = {
  status: 'idle' | 'loading' | 'success' | 'error';
  groups: MyAdminSignalGroup[];
  error: string | null;
  enableEditActions: boolean;
  onGroupsChanged: () => Promise<void>;
};

function MyGroupEditDialog(props: {
  editDialog: MyGroupEditState | null;
  setEditDialog: (editDialog: MyGroupEditState | null) => void;
  logins: SignalGroupLogin[];
  organisms: MyOrganism[];
  aorOptions: AreaOfResponsibility[];
  referenceDataStatus: ReferenceDataStatus;
  onSave: () => void;
}) {
  const { editDialog, setEditDialog } = props;

  if (!editDialog) return null;

  return (
    <Dialog open onClose={() => setEditDialog(null)} maxWidth="md" fullWidth disableRestoreFocus>
      <DialogTitle>Редагувати групу</DialogTitle>
      <DialogContent className="space-y-4">
        {editDialog?.error ? <PowerAlert severity="error">{editDialog.error}</PowerAlert> : null}
        {props.referenceDataStatus === 'loading' ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CircularProgress size={18} />
            <Typography variant="body2" color="text.secondary">
              Завантаження даних{ELLIPSIS}
            </Typography>
          </Box>
        ) : null}
        <div className="text-sm text-muted-foreground">Група: {editDialog?.group.name}</div>
        <FormControlLabel
          control={
            <Switch
              checked={editDialog?.isSecret ?? false}
              onChange={(event) =>
                editDialog &&
                setEditDialog({
                  ...editDialog,
                  isSecret: event.target.checked,
                })
              }
            />
          }
          label="Прихована група"
        />
        <FormControlLabel
          control={
            <Switch
              checked={editDialog?.disableNetworkAssignment ?? false}
              onChange={(event) =>
                editDialog &&
                setEditDialog({
                  ...editDialog,
                  disableNetworkAssignment: event.target.checked,
                })
              }
            />
          }
          label={<DisableNetworkAssignmentLabel />}
        />
        {editDialog?.isSecret ? (
          <Autocomplete
            multiple
            options={props.logins}
            value={editDialog?.selectedUsers ?? []}
            onChange={(_, value) =>
              editDialog && setEditDialog({ ...editDialog, selectedUsers: value })
            }
            getOptionLabel={formatGroupLogin}
            isOptionEqualToValue={(option, value) => option.loginId === value.loginId}
            renderInput={(params) => <TextField {...params} label="Користувачі" />}
          />
        ) : null}
        {editDialog?.isSecret ? (
          <Autocomplete
            multiple
            options={props.organisms}
            getOptionLabel={(option) => option.name}
            value={selectedOrganisms(editDialog.selectedOrganismIds, props.organisms)}
            onChange={(_, value) =>
              editDialog &&
              setEditDialog({
                ...editDialog,
                selectedOrganismIds: preserveUnknownOrganismIds(
                  value,
                  editDialog.selectedOrganismIds,
                  props.organisms,
                ),
              })
            }
            renderOption={(optionProps, option) => {
              const { key: _unusedKey, ...restOptionProps } = optionProps;
              return (
                <Box component="li" {...restOptionProps} key={option.id}>
                  {option.name}
                </Box>
              );
            }}
            renderInput={(params) => <TextField {...params} label="Організми" />}
            isOptionEqualToValue={(option, value) => option.id === value.id}
          />
        ) : null}
        <Autocomplete
          multiple
          options={props.logins}
          value={editDialog?.selectedAdmins ?? []}
          onChange={(_, value) =>
            editDialog && setEditDialog({ ...editDialog, selectedAdmins: value })
          }
          getOptionLabel={formatGroupLogin}
          isOptionEqualToValue={(option, value) => option.loginId === value.loginId}
          renderInput={(params) => <TextField {...params} label="Адміністратори групи" />}
        />
        <Autocomplete
          multiple
          options={props.aorOptions}
          getOptionLabel={(option) => option.name}
          value={
            (editDialog?.selectedAorIds ?? [])
              .map((id) => props.aorOptions.find((aor) => aor.id === id))
              .filter(Boolean) as AreaOfResponsibility[]
          }
          onChange={(_, value) =>
            editDialog &&
            setEditDialog({
              ...editDialog,
              selectedAorIds: value.map((aor) => aor.id),
            })
          }
          renderOption={(optionProps, option) => {
            const { key: _unusedKey, ...restOptionProps } = optionProps;
            return (
              <Box component="li" {...restOptionProps} key={option.id}>
                {option.name}
              </Box>
            );
          }}
          renderInput={(params) => <TextField {...params} label="Смуги відповідальності" />}
          isOptionEqualToValue={(option, value) => option.id === value.id}
        />
      </DialogContent>
      <DialogActions>
        <PowerButton
          variant="outlined"
          onClick={() => setEditDialog(null)}
          disabled={editDialog?.isSaving}
        >
          Скасувати
        </PowerButton>
        <PowerButton
          variant="contained"
          onClick={props.onSave}
          disabled={editDialog?.isSaving || props.referenceDataStatus === 'loading'}
        >
          Зберегти
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}

export function SettingsMyGroupsSection({
  status,
  groups,
  error,
  enableEditActions,
  onGroupsChanged,
}: SettingsMyGroupsSectionProps) {
  const hasGroups = groups.length > 0;
  const [editDialog, setEditDialog] = useState<MyGroupEditState | null>(null);
  const [logins, setLogins] = useState<SignalGroupLogin[]>([]);
  const [organisms, setOrganisms] = useState<MyOrganism[]>([]);
  const [aorOptions, setAorOptions] = useState<AreaOfResponsibility[]>([]);
  const [referenceDataStatus, setReferenceDataStatus] = useState<ReferenceDataStatus>('idle');

  async function ensureReferenceDataLoaded(masterKey: string) {
    if (referenceDataStatus === 'loading' || referenceDataStatus === 'success') return;

    setReferenceDataStatus('loading');
    try {
      const reference = await fetchMyAdminGroupEditReference(masterKey);
      setLogins(reference.logins);
      setOrganisms(reference.organisms);
      setAorOptions(reference.areasOfResponsibility);
      setReferenceDataStatus('success');
    } catch {
      setReferenceDataStatus('error');
      setEditDialog((current) =>
        current
          ? {
              ...current,
              error: 'Не вдалося завантажити дані для редагування',
            }
          : current,
      );
    }
  }

  function openEditDialog(group: MyAdminSignalGroup) {
    setEditDialog({
      group,
      isSecret: group.isGroupSecret,
      disableNetworkAssignment: group.disableNetworkAssignment,
      selectedUsers: group.allowedUsers,
      selectedOrganismIds: group.allowedOrganismIds,
      selectedAdmins: group.adminLogins,
      selectedAorIds: (group.areasOfResponsibility ?? []).map((aor) => aor.id),
      isSaving: false,
      error: null,
    });
    void ensureReferenceDataLoaded(group.masterKey);
  }

  async function handleSaveGroupEdit() {
    if (!editDialog) return;
    const selectedAdmins = Array.from(
      new Set(editDialog.selectedAdmins.map((login) => login.loginId).filter(Boolean)),
    );
    if (selectedAdmins.length === 0) {
      setEditDialog({
        ...editDialog,
        error: 'Потрібно залишити щонайменше одного адміністратора групи',
      });
      return;
    }

    setEditDialog({ ...editDialog, isSaving: true, error: null });

    try {
      await updateMyAdminGroup({
        masterKey: editDialog.group.masterKey,
        isSecret: editDialog.isSecret,
        disableNetworkAssignment: editDialog.disableNetworkAssignment,
        userLogins: editDialog.isSecret
          ? editDialog.selectedUsers.map((login) => login.loginId)
          : [],
        organismIds: editDialog.isSecret ? editDialog.selectedOrganismIds : [],
        adminLogins: selectedAdmins,
        areaOfResponsibilityIds:
          editDialog.selectedAorIds.length > 0 ? editDialog.selectedAorIds : null,
      });
      await onGroupsChanged();
      setEditDialog(null);
    } catch {
      setEditDialog({
        ...editDialog,
        isSaving: false,
        error: 'Не вдалося зберегти групу',
      });
    }
  }

  return (
    <Box
      role="tabpanel"
      id="settings-neo-panel-my-groups"
      aria-labelledby="settings-neo-tab-my-groups"
    >
      <Box sx={{ p: 3 }}>
        <Stack spacing={3}>
          <Typography component="h2" variant="h6" sx={{ fontWeight: 700, lineHeight: 1.25 }}>
            Мої групи
          </Typography>

          <PowerAlert severity="info">
            <Stack spacing={1.5}>
              <Box>
                Для того щоби додати вашу приватну групу, додайте в неї телефон бота, написаний в
                описі групи підтримки, і напишіть адміністраторам повідомлення у форматі:
                <br />
                1. Додано групу МОЯ_ГРУПА (WhatsApp), зробіть мене (DeltaUser) адміном та групу
                приватною, видиму користувачам Delta1, Delta2, Delta3
                <br />
                2. Додано групу МОЯ_ГРУПА (Signal), зробіть мене (DeltaUser) адміном та групу
                публічною, на смугу 99АК
              </Box>
              <MyGroupsSetupFlowImage />
            </Stack>
          </PowerAlert>

          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}

          {status === 'loading' ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">
                Завантаження груп{ELLIPSIS}
              </Typography>
            </Box>
          ) : null}

          {status === 'success' && hasGroups ? (
            <TableStateProvider
              tableId={
                enableEditActions ? 'settings-neo-my-groups-v3' : 'settings-neo-my-groups-v2'
              }
              defaultColumnOrder={
                enableEditActions
                  ? DEFAULT_MY_GROUPS_EDIT_COLUMN_ORDER
                  : DEFAULT_MY_GROUPS_COLUMN_ORDER
              }
              defaultColumnVisibility={
                enableEditActions
                  ? DEFAULT_MY_GROUPS_EDIT_COLUMNS_VISIBILITY
                  : DEFAULT_MY_GROUPS_COLUMNS_VISIBILITY
              }
              defaultEnableColumnOrdering={false}
            >
              <Box sx={{ width: '100%', minWidth: 0, overflow: 'hidden' }}>
                <SettingsMyGroupsTable
                  groups={groups}
                  loading={false}
                  enableEditActions={enableEditActions}
                  onEdit={openEditDialog}
                />
              </Box>
            </TableStateProvider>
          ) : null}

          {status === 'success' && !hasGroups ? (
            <Box
              sx={{
                border: 1,
                borderColor: 'divider',
                borderRadius: 2,
                p: { xs: 2, sm: 2.5 },
                bgcolor: 'background.paper',
              }}
            >
              <Stack spacing={1}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  Груп не знайдено
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Тут з&apos;являться групи, коли для вашого облікового запису знайдуться приватні
                  або керовані групи.
                </Typography>
              </Stack>
            </Box>
          ) : null}
        </Stack>
      </Box>
      <MyGroupEditDialog
        editDialog={editDialog}
        setEditDialog={setEditDialog}
        logins={logins}
        organisms={organisms}
        aorOptions={aorOptions}
        referenceDataStatus={referenceDataStatus}
        onSave={handleSaveGroupEdit}
      />
    </Box>
  );
}
