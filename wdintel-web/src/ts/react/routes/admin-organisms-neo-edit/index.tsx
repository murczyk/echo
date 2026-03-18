import {
  Alert,
  Autocomplete,
  Box,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import React from 'react';

import { AreaOfResponsibility, CreateOrganismReq, Organism, OrganismGroup, SignalGroupFull, UpdateOrganismReq } from '../../../../Bindings';
import { FormPageHeader } from '../../components/FormPageHeader';
import { FormPageLayout } from '../../components/FormPageLayout';
import { PageErrorState } from '../../components/PageErrorState';
import { PageLoadingState } from '../../components/PageLoadingState';
import { SectionEmptyState } from '../../components/SectionEmptyState';
import { SectionErrorState } from '../../components/SectionErrorState';
import { Button } from '../../components/mui-customized/button';
import { listAors } from '../../services/api/aor';
import {
  addGroupToOrganism,
  checkOrganismGoiConnection,
  computeAvailableGroups,
  computeAvailableGroupsForNew,
  createOrganism,
  getOrganismGoiSettings,
  GOI_INTEGRATION_TYPE_FULL,
  GOI_INTEGRATION_TYPE_SIMPLE,
  type GoiIntegrationType,
  listOrganismGroups,
  listOrganisms,
  listSignalGroups,
  removeGroupFromOrganism,
  setupOrganismGoiWorker,
  type UpdateOrganismGoiSettingsReq,
  updateOrganismGoiSettings,
  updateOrganism,
} from '../../services/api/organisms';
import { navigateWithinSpa } from '../../utils/browser';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';
type StatusMessage = { kind: 'error' | 'success'; message: string } | null;

type OrganismFormState = {
  name: string;
  parentId: number | null;
  roles: string[];
  aorIds: number[];
  enabled: boolean;
  limitGroups: boolean;
  groupIds: string[];
  goiIntegrationType: GoiIntegrationType;
  goiSshHost: string;
  goiSshUser: string;
  goiSshPort: number;
  goiPath: string;
  goiApiHost: string;
  goiApiPort: number;
  goiApiLogin: string;
  goiApiPassword: string;
};

const GOI_SSH_PORT_DEFAULT = 22;
const GOI_API_PORT_DEFAULT = 8088;
const GOI_PATH_DEFAULT = '/etc/goi/data/palettes';

const ROLE_OPTIONS = ['Admin', 'Rer', 'Bpla', 'Full', 'Basic', 'UnitsEditor', 'CallsignsEditor'];

const emptyFormState: OrganismFormState = {
  name: '',
  parentId: null,
  roles: [],
  aorIds: [],
  enabled: true,
  limitGroups: false,
  groupIds: [],
  goiIntegrationType: GOI_INTEGRATION_TYPE_FULL,
  goiSshHost: '',
  goiSshUser: '',
  goiSshPort: GOI_SSH_PORT_DEFAULT,
  goiPath: GOI_PATH_DEFAULT,
  goiApiHost: '',
  goiApiPort: GOI_API_PORT_DEFAULT,
  goiApiLogin: '',
  goiApiPassword: '',
};

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

function formatGroupLabel(group: SignalGroupFull | undefined, fallbackKey: string): string {
  if (!group) return fallbackKey;
  if (group.name && group.name.trim()) return group.name;
  return `Без назви (id=${group.masterKey.slice(0, 6)}...)`;
}

function formatAorLabel(aor: AreaOfResponsibility | undefined, fallbackId: number): string {
  if (!aor) return String(fallbackId);
  return aor.name || String(fallbackId);
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function asNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isFinite(item));
  }
  return [];
}

function getOrganismGroupKeys(organismId: number, organismGroups: OrganismGroup[]): string[] {
  return organismGroups.filter((item) => item.organismId === organismId).map((item) => item.masterKey);
}

function buildAvailableGroups(parentId: number | null, allGroups: SignalGroupFull[], organismGroups: OrganismGroup[]) {
  if (!parentId) return allGroups;
  const parentGroupKeys = organismGroups
    .filter((item) => item.organismId === parentId)
    .map((item) => item.masterKey);
  if (parentGroupKeys.length === 0) return allGroups;
  const parentGroupSet = new Set(parentGroupKeys);
  return allGroups.filter((group) => parentGroupSet.has(group.masterKey));
}

function validateGroupsForParent(
  organismGroups: OrganismGroup[],
  allGroups: SignalGroupFull[],
  selectedGroups: string[],
  parentId: number | null,
): string[] {
  if (!parentId) return [];
  const parentGroupKeys = organismGroups
    .filter((item) => item.organismId === parentId)
    .map((item) => item.masterKey);
  if (parentGroupKeys.length === 0) return [];
  const parentGroupSet = new Set(parentGroupKeys);
  return selectedGroups
    .filter((groupId) => !parentGroupSet.has(groupId))
    .map((groupId) => {
      const group = allGroups.find((item) => item.masterKey === groupId);
      return formatGroupLabel(group, groupId);
    });
}

function getBackToPath(): string {
  const params = new URLSearchParams(window.location.search);
  const backTo = params.get('backTo');
  if (!backTo) return '/admin/organisms-neo';

  try {
    return decodeURIComponent(backTo);
  } catch (_) {
    return '/admin/organisms-neo';
  }
}

function hasAnyGoiApiSettings(form: OrganismFormState): boolean {
  if (form.goiIntegrationType !== GOI_INTEGRATION_TYPE_FULL) return false;
  const sshHost = form.goiSshHost.trim();
  const apiHost = form.goiApiHost.trim();
  if (form.goiApiLogin.trim() || form.goiApiPassword.trim()) return true;
  return apiHost.length > 0 && apiHost !== sshHost;
}

function isFullGoiIntegration(form: OrganismFormState): boolean {
  return form.goiIntegrationType === GOI_INTEGRATION_TYPE_FULL;
}

type AdminOrganismsNeoEditPageProps = {
  organismId: string | null;
};

type OrganismFormFieldsProps = {
  form: OrganismFormState;
  formErrors: Record<string, string>;
  isSubmitting: boolean;
  isCheckingGoiConnection: boolean;
  isSettingUpGoiWorker: boolean;
  isNew: boolean;
  organisms: Organism[];
  groups: SignalGroupFull[];
  availableGroups: SignalGroupFull[];
  aors: AreaOfResponsibility[];
  computedGroups: SignalGroupFull[] | null;
  computeError: string | null;
  goiConnectionStatus: StatusMessage;
  isComputing: boolean;
  groupsValidation: string[];
  onCheckGoiConnection: () => void;
  onSetupGoiWorker: () => void;
  onChange: (patch: Partial<OrganismFormState>) => void;
};

function OrganismFormFields(props: OrganismFormFieldsProps) {
  const aorOptions = props.aors.map((aor) => (
    <MenuItem key={aor.id} value={aor.id}>
      {aor.name}
    </MenuItem>
  ));
  const groupOptions = props.availableGroups.map((group) => (
    <MenuItem key={group.masterKey} value={group.masterKey}>
      {formatGroupLabel(group, group.masterKey)}
    </MenuItem>
  ));

  const parentValue = props.organisms.find((organism) => organism.id === props.form.parentId) ?? null;
  const isGoiBusy = props.isSubmitting || props.isCheckingGoiConnection || props.isSettingUpGoiWorker;
  const isFullIntegration = isFullGoiIntegration(props.form);

  return (
    <div className="space-y-5">
      <TextField
        label="Назва *"
        value={props.form.name}
        onChange={(event) => props.onChange({ name: event.target.value })}
        error={Boolean(props.formErrors.name)}
        helperText={props.formErrors.name || ' '}
        fullWidth
        disabled={props.isSubmitting}
      />

      <Autocomplete
        options={props.organisms}
        value={parentValue}
        onChange={(_, option) => {
          props.onChange({ parentId: option ? option.id : null });
        }}
        getOptionLabel={(option) => option.name || `ID ${option.id}`}
        isOptionEqualToValue={(option, value) => option.id === value.id}
        clearOnEscape
        disabled={props.isSubmitting}
        renderInput={(params) => (
          <TextField {...params} label="Батьківський організм" placeholder="Без батька" fullWidth />
        )}
      />

      <TextField
        select
        label="Ролі"
        value={props.form.roles}
        onChange={(event) => props.onChange({ roles: asStringArray(event.target.value) })}
        fullWidth
        SelectProps={{
          multiple: true,
          renderValue: (selected) => (selected as string[]).join(', ') || '—',
        }}
        disabled={props.isSubmitting}
        helperText=" "
      >
        {ROLE_OPTIONS.map((role) => (
          <MenuItem key={role} value={role}>
            {role}
          </MenuItem>
        ))}
      </TextField>

      <TextField
        select
        label="Смуги"
        value={props.form.aorIds}
        onChange={(event) => props.onChange({ aorIds: asNumberArray(event.target.value) })}
        fullWidth
        SelectProps={{
          multiple: true,
          renderValue: (selected) => {
            const values = selected as number[];
            if (values.length === 0) return '—';
            return values
              .map((id) => formatAorLabel(props.aors.find((aor) => aor.id === id), id))
              .join(', ');
          },
        }}
        disabled={props.isSubmitting}
        helperText=" "
      >
        {aorOptions}
      </TextField>

      <Box className="space-y-3 pt-2 pb-3">
        <Typography variant="subtitle2" className="text-muted-foreground">
          Доступні групи для організму
        </Typography>
        <Box className="mt-2 p-3 rounded-md bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
          {props.isComputing ? (
            <div className="flex items-center gap-2">
              <CircularProgress size={18} />
              <Typography variant="body2" className="text-muted-foreground italic">
                Завантаження доступних груп...
              </Typography>
            </div>
          ) : props.computeError ? (
            <SectionErrorState message={props.computeError} />
          ) : props.computedGroups ? (
            props.computedGroups.length === 0 ? (
              <SectionEmptyState message="Немає доступних груп" />
            ) : (
              <div className="flex flex-wrap gap-1">
                {props.computedGroups.map((group) => (
                  <span key={group.masterKey} className="badge badge--ochre-light">
                    {formatGroupLabel(group, group.masterKey)}
                  </span>
                ))}
              </div>
            )
          ) : (
            <Typography variant="body2" className="text-muted-foreground italic">
              Оберіть смуги для отримання доступних груп
            </Typography>
          )}
        </Box>
        <Typography variant="caption" className="text-muted-foreground">
          Ці групи будуть доступні організму на основі вибраних смуг та батьківського організму
        </Typography>
      </Box>

      <div className="space-y-1">
        <FormControlLabel
          className="block"
          control={
            <Checkbox
              checked={props.form.limitGroups}
              onChange={() => props.onChange({ limitGroups: !props.form.limitGroups })}
              disabled={props.isSubmitting}
            />
          }
          label="Обмежити перелік груп"
        />
        <Typography component="div" variant="caption" className="text-muted-foreground block">
          За замовчуванням організм має доступ до всіх груп від смуг. Увімкніть для додаткового обмеження.
        </Typography>
      </div>

      {props.form.limitGroups ? (
        <TextField
          select
          label="Обмежити групами"
          value={props.form.groupIds}
          onChange={(event) => props.onChange({ groupIds: asStringArray(event.target.value) })}
          fullWidth
          SelectProps={{
            multiple: true,
            renderValue: (selected) => {
              const values = selected as string[];
              if (values.length === 0) return '—';
              return values
                .map((groupId) => {
                  const group = props.groups.find((item) => item.masterKey === groupId);
                  return formatGroupLabel(group, groupId);
                })
                .join(', ');
            },
          }}
          disabled={props.isSubmitting}
        >
          {groupOptions}
        </TextField>
      ) : null}

      {props.form.limitGroups && props.groupsValidation.length > 0 ? (
        <Box className="p-3 rounded-md bg-yellow-50 border border-yellow-200 dark:bg-yellow-900/20 dark:border-yellow-800">
          <Typography variant="body2" className="text-yellow-800 dark:text-yellow-200">
            ⚠️ Попередження: при виборі цього батьківського організму буде втрачено доступ до груп:{' '}
            <strong>{props.groupsValidation.join(', ')}</strong>
          </Typography>
        </Box>
      ) : null}

      {!props.isNew ? (
        <div className="pt-1">
          <FormControlLabel
            className="block"
            control={
              <Checkbox
                checked={props.form.enabled}
                onChange={() => props.onChange({ enabled: !props.form.enabled })}
                disabled={props.isSubmitting}
              />
            }
            label="Активна"
          />
        </div>
      ) : null}

      <Box className="space-y-4 border-t border-gray-200 dark:border-gray-700 pt-6">
        <Typography variant="h6" className="!font-semibold pb-3">
          ГОІ
        </Typography>
        <TextField
          select
          label="Тип інтеграції"
          value={props.form.goiIntegrationType}
          onChange={(event) =>
            props.onChange({
              goiIntegrationType: event.target.value as GoiIntegrationType,
            })
          }
          fullWidth
          disabled={isGoiBusy}
          helperText=" "
        >
          <MenuItem value={GOI_INTEGRATION_TYPE_SIMPLE}>Проста</MenuItem>
          <MenuItem value={GOI_INTEGRATION_TYPE_FULL}>Повна</MenuItem>
        </TextField>

        {isFullIntegration ? (
          <>
            <Alert severity="info" className="!mb-4">
              Для організму можна запустити контейнер з ПЗ ГОІ, після чого налаштувати їхню інтеграцію. ГОІ має слабкий
              захист та не підтримує повноцінну авторизацію, але має дуже потужну роботу з палітрами. Для налаштування
              необхідно буде вказати SSH-доступ і параметри API worker&apos;а. При завантаженні палітри в організм ЕХО --
              вона з&apos;являтиметься в ГОІ.
            </Alert>

            <TextField
              label="SSH хост"
              value={props.form.goiSshHost}
              onChange={(event) => props.onChange({ goiSshHost: event.target.value })}
              fullWidth
              helperText=" "
              disabled={isGoiBusy}
            />

            <TextField
              label="SSH юзер"
              value={props.form.goiSshUser}
              onChange={(event) => props.onChange({ goiSshUser: event.target.value })}
              fullWidth
              helperText=" "
              disabled={isGoiBusy}
            />

            <TextField
              label="SSH порт"
              type="number"
              value={props.form.goiSshPort}
              onChange={(event) =>
                props.onChange({
                  goiSshPort: Number.isFinite(Number(event.target.value))
                    ? Number(event.target.value)
                    : GOI_SSH_PORT_DEFAULT,
                })
              }
              fullWidth
              inputProps={{ min: 1, max: 65535 }}
              error={Boolean(props.formErrors.goiSshPort)}
              helperText={props.formErrors.goiSshPort || ' '}
              disabled={isGoiBusy}
            />

            <TextField
              label="Шлях"
              value={props.form.goiPath}
              onChange={(event) => props.onChange({ goiPath: event.target.value })}
              fullWidth
              helperText="Шлях до каталогу палітр у контейнері ГОІ"
              disabled={isGoiBusy}
            />

            <Alert severity="info">
              На інстансі ГОІ worker читає логін і пароль з <code>/etc/goi-echo-worker/config.toml</code>. За
              замовчуванням API хост пропонується таким самим, як SSH хост, а порт worker&apos;а має бути <code>8088</code>.
            </Alert>

            <TextField
              label="API хост / домен"
              value={props.form.goiApiHost}
              onChange={(event) => props.onChange({ goiApiHost: event.target.value })}
              fullWidth
              error={Boolean(props.formErrors.goiApiHost)}
              helperText={
                props.formErrors.goiApiHost ||
                'Якщо не змінювати, за замовчуванням використовується те саме значення, що і для SSH хоста'
              }
              disabled={isGoiBusy}
            />

            <TextField
              label="API порт"
              type="number"
              value={props.form.goiApiPort}
              onChange={(event) =>
                props.onChange({
                  goiApiPort: Number.isFinite(Number(event.target.value))
                    ? Number(event.target.value)
                    : GOI_API_PORT_DEFAULT,
                })
              }
              fullWidth
              inputProps={{ min: 1, max: 65535 }}
              error={Boolean(props.formErrors.goiApiPort)}
              helperText={props.formErrors.goiApiPort || ' '}
              disabled={isGoiBusy}
            />

            <TextField
              label="API логін"
              value={props.form.goiApiLogin}
              onChange={(event) => props.onChange({ goiApiLogin: event.target.value })}
              fullWidth
              error={Boolean(props.formErrors.goiApiLogin)}
              helperText={props.formErrors.goiApiLogin || 'Обовʼязковий, якщо налаштована інтеграція ГОІ'}
              disabled={isGoiBusy}
            />

            <TextField
              label="API пароль"
              type="password"
              value={props.form.goiApiPassword}
              onChange={(event) => props.onChange({ goiApiPassword: event.target.value })}
              fullWidth
              error={Boolean(props.formErrors.goiApiPassword)}
              helperText={props.formErrors.goiApiPassword || 'Обовʼязковий, якщо налаштована інтеграція ГОІ'}
              disabled={isGoiBusy}
            />

            <div className="mt-3 flex items-center gap-3">
              <Button variant="outlined" onClick={props.onCheckGoiConnection} disabled={isGoiBusy}>
                {props.isCheckingGoiConnection ? 'Перевірка...' : "Перевірити з'єднання"}
              </Button>
              {!props.isNew ? (
                <Button variant="contained" onClick={props.onSetupGoiWorker} disabled={isGoiBusy}>
                  {props.isSettingUpGoiWorker ? 'Налаштування...' : 'Налаштувати воркер'}
                </Button>
              ) : null}
              {props.isCheckingGoiConnection || props.isSettingUpGoiWorker ? <CircularProgress size={20} /> : null}
            </div>
          </>
        ) : (
          <>
            <Alert severity="info" className="!mb-4">
              Проста інтеграція зберігає лише адресу інстансу ГОІ і показує в меню посилання для відкриття ГОІ без
              налаштування SSH, worker&apos;а чи імпорту даних.
            </Alert>

            <TextField
              label="GOI URL / домен"
              value={props.form.goiSshHost}
              onChange={(event) => props.onChange({ goiSshHost: event.target.value })}
              fullWidth
              helperText="Можна вказати повний URL або домен ГОІ"
              disabled={isGoiBusy}
            />
          </>
        )}

        {props.goiConnectionStatus ? <Alert severity={props.goiConnectionStatus.kind}>{props.goiConnectionStatus.message}</Alert> : null}
      </Box>
    </div>
  );
}

function AdminOrganismsNeoEditPageBody(props: AdminOrganismsNeoEditPageProps) {
  const isNew = !props.organismId;
  const [loadStatus, setLoadStatus] = React.useState<LoadingStatus>('idle');
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<StatusMessage>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const [organisms, setOrganisms] = React.useState<Organism[]>([]);
  const [groups, setGroups] = React.useState<SignalGroupFull[]>([]);
  const [organismGroups, setOrganismGroups] = React.useState<OrganismGroup[]>([]);
  const [aors, setAors] = React.useState<AreaOfResponsibility[]>([]);

  const [form, setForm] = React.useState<OrganismFormState>(emptyFormState);
  const [formErrors, setFormErrors] = React.useState<Record<string, string>>({});
  const [originalGroupKeys, setOriginalGroupKeys] = React.useState<string[]>([]);
  const [computedGroups, setComputedGroups] = React.useState<SignalGroupFull[] | null>(null);
  const [computeError, setComputeError] = React.useState<string | null>(null);
  const [isComputing, setIsComputing] = React.useState(false);
  const [goiConnectionStatus, setGoiConnectionStatus] = React.useState<StatusMessage>(null);
  const [isCheckingGoiConnection, setIsCheckingGoiConnection] = React.useState(false);
  const [isSettingUpGoiWorker, setIsSettingUpGoiWorker] = React.useState(false);

  const backToPath = React.useMemo(getBackToPath, []);

  const availableGroups = React.useMemo(
    () => buildAvailableGroups(form.parentId, groups, organismGroups),
    [form.parentId, groups, organismGroups],
  );

  const groupsValidation = React.useMemo(
    () => validateGroupsForParent(organismGroups, groups, form.groupIds, form.parentId),
    [organismGroups, groups, form.groupIds, form.parentId],
  );

  React.useEffect(() => {
    let isCancelled = false;

    async function loadAll() {
      setLoadStatus('loading');
      setLoadError(null);
      try {
        const [organismsData, groupsData, organismGroupsData, aorData] = await Promise.all([
          listOrganisms({ sortBy: null }),
          listSignalGroups(),
          listOrganismGroups(),
          listAors({ sortBy: null }),
        ]);
        if (isCancelled) return;

        setOrganisms(organismsData);
        setGroups(groupsData);
        setOrganismGroups(organismGroupsData);
        setAors(aorData);

        if (isNew) {
          setForm(emptyFormState);
          setOriginalGroupKeys([]);
          setGoiConnectionStatus(null);
          setLoadStatus('success');
          return;
        }

        const parsedId = Number(props.organismId);
        if (!Number.isFinite(parsedId)) {
          setLoadStatus('error');
          setLoadError('Некоректний id');
          return;
        }

        const target = organismsData.find((item) => item.id === parsedId);
        if (!target) {
          setLoadStatus('error');
          setLoadError('Організм не знайдено');
          return;
        }

        const groupKeys = getOrganismGroupKeys(target.id, organismGroupsData);
        const goiSettings = await getOrganismGoiSettings(parsedId);
        if (isCancelled) return;

        setOriginalGroupKeys(groupKeys);
        setForm({
          name: target.name,
          parentId: target.parentId,
          roles: target.roles,
          aorIds: target.aorIds,
          enabled: target.enabled,
          limitGroups: groupKeys.length > 0,
          groupIds: groupKeys,
          goiIntegrationType: goiSettings.integrationType,
          goiSshHost: goiSettings.sshHost,
          goiSshUser: goiSettings.sshUser,
          goiSshPort: goiSettings.sshPort,
          goiPath: goiSettings.path,
          goiApiHost: goiSettings.apiHost,
          goiApiPort: goiSettings.apiPort,
          goiApiLogin: goiSettings.apiLogin,
          goiApiPassword: goiSettings.apiPassword,
        });
        setGoiConnectionStatus(null);
        setLoadStatus('success');
      } catch (error) {
        if (isCancelled) return;
        setLoadStatus('error');
        setLoadError(formatErrorMessage(error));
      }
    }

    loadAll();

    return () => {
      isCancelled = true;
    };
  }, [props.organismId, isNew]);

  React.useEffect(() => {
    if (loadStatus !== 'success') return;
    if (form.aorIds.length === 0) {
      setComputedGroups(null);
      setComputeError(null);
      setIsComputing(false);
      return;
    }

    let isCancelled = false;

    async function loadComputed() {
      setIsComputing(true);
      setComputeError(null);
      try {
        if (isNew) {
          const req: CreateOrganismReq = {
            name: form.name,
            parentId: form.parentId,
            roles: form.roles,
            aorIds: form.aorIds,
          };
          const data = await computeAvailableGroupsForNew(req);
          if (!isCancelled) setComputedGroups(data);
        } else {
          const parsedId = Number(props.organismId);
          if (!Number.isFinite(parsedId)) {
            if (!isCancelled) {
              setComputeError('Некоректний id');
              setComputedGroups(null);
            }
            return;
          }
          const req: UpdateOrganismReq = {
            id: parsedId,
            parentId: form.parentId,
            name: form.name,
            roles: form.roles.length > 0 ? form.roles : null,
            enabled: form.enabled,
            aorIds: form.aorIds,
          };
          const data = await computeAvailableGroups(req);
          if (!isCancelled) setComputedGroups(data);
        }
      } catch (error) {
        if (!isCancelled) {
          setComputedGroups(null);
          setComputeError(formatErrorMessage(error));
        }
      } finally {
        if (!isCancelled) setIsComputing(false);
      }
    }

    loadComputed();

    return () => {
      isCancelled = true;
    };
  }, [form.aorIds, form.parentId, isNew, loadStatus, props.organismId]);

  function handleChange(patch: Partial<OrganismFormState>) {
    if (
      patch.goiSshHost !== undefined ||
      patch.goiIntegrationType !== undefined ||
      patch.goiSshUser !== undefined ||
      patch.goiSshPort !== undefined ||
      patch.goiPath !== undefined ||
      patch.goiApiHost !== undefined ||
      patch.goiApiPort !== undefined ||
      patch.goiApiLogin !== undefined ||
      patch.goiApiPassword !== undefined
    ) {
      setGoiConnectionStatus(null);
    }
    setForm((prev) => {
      const next = { ...prev, ...patch };
      if (
        (patch.goiIntegrationType === undefined || patch.goiIntegrationType === GOI_INTEGRATION_TYPE_FULL) &&
        patch.goiSshHost !== undefined &&
        prev.goiApiHost.trim().length === 0 &&
        (patch.goiApiHost === undefined || patch.goiApiHost.trim().length === 0)
      ) {
        next.goiApiHost = patch.goiSshHost;
      }
      return next;
    });
  }

  function navigateBack() {
    navigateWithinSpa(backToPath);
  }

  function validateForm(): boolean {
    const errors: Record<string, string> = {};
    if (!form.name.trim()) {
      errors.name = 'Заповніть назву';
    }
    if (isFullGoiIntegration(form)) {
      if (!Number.isInteger(form.goiSshPort) || form.goiSshPort < 1 || form.goiSshPort > 65535) {
        errors.goiSshPort = 'Вкажіть коректний SSH порт (1-65535)';
      }
      if (!Number.isInteger(form.goiApiPort) || form.goiApiPort < 1 || form.goiApiPort > 65535) {
        errors.goiApiPort = 'Вкажіть коректний API порт (1-65535)';
      }
      if (hasAnyGoiApiSettings(form)) {
        if (!form.goiApiHost.trim() && !form.goiSshHost.trim()) {
          errors.goiApiHost = 'Вкажіть API хост або SSH хост';
        }
        if (!form.goiApiLogin.trim()) {
          errors.goiApiLogin = 'Вкажіть логін для GOI API worker';
        }
        if (!form.goiApiPassword.trim()) {
          errors.goiApiPassword = 'Вкажіть пароль для GOI API worker';
        }
      }
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  function buildGoiSettingsReq(organismId: number, nextForm: OrganismFormState): UpdateOrganismGoiSettingsReq {
    const hasGoiApiSettings = hasAnyGoiApiSettings(nextForm);
    if (nextForm.goiIntegrationType === GOI_INTEGRATION_TYPE_SIMPLE) {
      return {
        organismId,
        integrationType: GOI_INTEGRATION_TYPE_SIMPLE,
        sshHost: nextForm.goiSshHost.trim(),
        sshUser: '',
        sshPort: GOI_SSH_PORT_DEFAULT,
        path: GOI_PATH_DEFAULT,
        apiHost: '',
        apiPort: GOI_API_PORT_DEFAULT,
        apiLogin: '',
        apiPassword: '',
      };
    }
    return {
      organismId,
      integrationType: GOI_INTEGRATION_TYPE_FULL,
      sshHost: nextForm.goiSshHost.trim(),
      sshUser: nextForm.goiSshUser.trim(),
      sshPort: nextForm.goiSshPort,
      path: nextForm.goiPath.trim() || GOI_PATH_DEFAULT,
      apiHost: hasGoiApiSettings ? (nextForm.goiApiHost.trim() || nextForm.goiSshHost.trim()) : '',
      apiPort: nextForm.goiApiPort,
      apiLogin: hasGoiApiSettings ? nextForm.goiApiLogin.trim() : '',
      apiPassword: hasGoiApiSettings ? nextForm.goiApiPassword.trim() : '',
    };
  }

  async function handleCheckGoiConnection() {
    setIsCheckingGoiConnection(true);
    setGoiConnectionStatus(null);
    try {
      const response = await checkOrganismGoiConnection({
        sshHost: form.goiSshHost.trim(),
        sshUser: form.goiSshUser.trim(),
        sshPort: form.goiSshPort,
        path: form.goiPath.trim() || GOI_PATH_DEFAULT,
      });
      if (!response.ok || response.error) {
        setGoiConnectionStatus({
          kind: 'error',
          message: response.error
            ? `Помилка перевірки з'єднання: ${response.error}`
            : "Помилка перевірки з'єднання: Невідома помилка",
        });
        return;
      }
      const preview = response.listedEntries.slice(0, 5).join(', ');
      setGoiConnectionStatus({
        kind: 'success',
        message: preview
          ? `З'єднання успішне. Файли в каталозі: ${preview}`
          : "З'єднання успішне. Каталог доступний.",
      });
    } catch (error) {
      setGoiConnectionStatus({
        kind: 'error',
        message: `Помилка перевірки з'єднання: ${formatErrorMessage(error)}`,
      });
    } finally {
      setIsCheckingGoiConnection(false);
    }
  }

  async function handleSetupGoiWorker() {
    if (isNew) return;

    const parsedId = Number(props.organismId);
    if (!Number.isFinite(parsedId)) {
      setGoiConnectionStatus({
        kind: 'error',
        message: 'Помилка налаштування воркера: Некоректний id',
      });
      return;
    }

    setIsSettingUpGoiWorker(true);
    setGoiConnectionStatus(null);

    try {
      const settings = await setupOrganismGoiWorker({
        organismId: parsedId,
        sshHost: form.goiSshHost.trim(),
        sshUser: form.goiSshUser.trim(),
        sshPort: form.goiSshPort,
        path: form.goiPath.trim() || GOI_PATH_DEFAULT,
        apiHost: form.goiApiHost.trim() || form.goiSshHost.trim(),
        apiPort: form.goiApiPort,
      });
      setForm((prev) => ({
        ...prev,
        goiIntegrationType: settings.integrationType,
        goiSshHost: settings.sshHost,
        goiSshUser: settings.sshUser,
        goiSshPort: settings.sshPort,
        goiPath: settings.path,
        goiApiHost: settings.apiHost,
        goiApiPort: settings.apiPort,
        goiApiLogin: settings.apiLogin,
        goiApiPassword: settings.apiPassword,
      }));
      setGoiConnectionStatus({
        kind: 'success',
        message:
          "Воркер налаштовано. API логін 'goi' і згенерований пароль записані в /etc/goi-echo-worker/config.toml та підставлені у форму.",
      });
    } catch (error) {
      setGoiConnectionStatus({
        kind: 'error',
        message: `Помилка налаштування воркера: ${formatErrorMessage(error)}`,
      });
    } finally {
      setIsSettingUpGoiWorker(false);
    }
  }

  async function handleSubmit() {
    if (!validateForm()) return;

    setIsSubmitting(true);
    setStatus(null);

    try {
      const trimmedName = form.name.trim();
      const nextForm = { ...form, name: trimmedName };
      const selectedGroupIds = nextForm.limitGroups
        ? nextForm.groupIds
        : [];

      if (isNew) {
        const createReq: CreateOrganismReq = {
          name: nextForm.name,
          parentId: nextForm.parentId,
          roles: nextForm.roles,
          aorIds: nextForm.aorIds.length > 0 ? nextForm.aorIds : null,
        };
        const created = await createOrganism(createReq);

        if (selectedGroupIds.length > 0) {
          await Promise.all(
            selectedGroupIds.map((groupId) =>
              addGroupToOrganism({
                organismId: created.id,
                groupName: groupId,
              }),
            ),
          );
        }

        await updateOrganismGoiSettings(
          buildGoiSettingsReq(created.id, nextForm),
        );
      } else {
        const parsedId = Number(props.organismId);
        if (!Number.isFinite(parsedId)) {
          throw new Error('Некоректний id');
        }

        const updateReq: UpdateOrganismReq = {
          id: parsedId,
          parentId: nextForm.parentId,
          name: nextForm.name,
          roles: nextForm.roles.length > 0 ? nextForm.roles : null,
          enabled: nextForm.enabled,
          aorIds: nextForm.aorIds,
        };
        await updateOrganism(updateReq);

        const selectedGroupSet = new Set(selectedGroupIds);
        const originalGroupSet = new Set(originalGroupKeys);
        const toAdd = selectedGroupIds.filter((key) => !originalGroupSet.has(key));
        const toRemove = originalGroupKeys.filter((key) => !selectedGroupSet.has(key));

        if (toAdd.length > 0) {
          await Promise.all(toAdd.map((groupId) => addGroupToOrganism({ organismId: parsedId, groupName: groupId })));
        }
        if (toRemove.length > 0) {
          await Promise.all(
            toRemove.map((groupId) => removeGroupFromOrganism({ organismId: parsedId, groupName: groupId })),
          );
        }

        await updateOrganismGoiSettings(
          buildGoiSettingsReq(parsedId, nextForm),
        );
      }

      navigateBack();
    } catch (error) {
      setStatus({
        kind: 'error',
        message: isNew
          ? `Помилка створення організму: ${formatErrorMessage(error)}`
          : `Помилка збереження організму: ${formatErrorMessage(error)}`,
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  if (loadStatus === 'loading') {
    return <PageLoadingState />;
  }

  if (loadStatus === 'error') {
    return <PageErrorState message={loadError || 'Помилка завантаження'} actionLabel="Назад" onAction={navigateBack} />;
  }

  return (
    <FormPageLayout>
      <div className="w-full space-y-6">
        <FormPageHeader
          title={isNew ? 'Створити організм' : 'Редагувати організм'}
          subtitle={
            isNew
              ? 'Додайте новий організм'
              : props.organismId
                ? `ID: ${props.organismId}`
                : undefined
          }
          onBack={navigateBack}
        />

        {status ? (
          <Alert severity={status.kind} onClose={() => setStatus(null)}>
            {status.message}
          </Alert>
        ) : null}

        <OrganismFormFields
          form={form}
          formErrors={formErrors}
          isSubmitting={isSubmitting}
          isCheckingGoiConnection={isCheckingGoiConnection}
          isSettingUpGoiWorker={isSettingUpGoiWorker}
          isNew={isNew}
          organisms={organisms}
          groups={groups}
          availableGroups={availableGroups}
          aors={aors}
          computedGroups={computedGroups}
          computeError={computeError}
          goiConnectionStatus={goiConnectionStatus}
          isComputing={isComputing}
          groupsValidation={groupsValidation}
          onCheckGoiConnection={handleCheckGoiConnection}
          onSetupGoiWorker={handleSetupGoiWorker}
          onChange={handleChange}
        />

        <div className="flex justify-end gap-3">
          <Button
            variant="outlined"
            onClick={navigateBack}
            disabled={isSubmitting || isCheckingGoiConnection || isSettingUpGoiWorker}
          >
            Скасувати
          </Button>
          <Button
            variant="contained"
            onClick={handleSubmit}
            disabled={isSubmitting || isCheckingGoiConnection || isSettingUpGoiWorker}
          >
            {isNew ? 'Створити' : 'Зберегти'}
          </Button>
        </div>
      </div>
    </FormPageLayout>
  );
}

export function AdminOrganismsNeoEditPage(props: AdminOrganismsNeoEditPageProps) {
  return <AdminOrganismsNeoEditPageBody organismId={props.organismId} />;
}
