import {
  Autocomplete,
  Box,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';

import {
  AreaOfResponsibility,
  CreateOrganismReq,
  Organism,
  OrganismGroup,
  SignalGroupFull,
  UpdateOrganismReq,
} from '../../../../Bindings';
import { FormPageHeader } from '../../components/FormPageHeader';
import { FormPageLayout } from '../../components/FormPageLayout';
import { PageErrorState } from '../../components/PageErrorState';
import { PageLoadingState } from '../../components/PageLoadingState';
import { SectionEmptyState } from '../../components/SectionEmptyState';
import { SectionErrorState } from '../../components/SectionErrorState';
import { PowerButton } from '../../components/PowerButton';
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
import { PowerAlert } from '../../components/PowerAlert';

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
  goiSimpleUrl: string;
  goiSimpleUrlDirty: boolean;
};

const GOI_SSH_PORT_DEFAULT = 22;
const GOI_API_PORT_DEFAULT = 8088;
const GOI_PATH_DEFAULT = '/etc/goi/data/palettes';

const ROLE_OPTIONS = [
  'Admin',
  'ApiAgent',
  'Rer',
  'Bpla',
  'Full',
  'Basic',
  'UnitsEditor',
  'NetworkEditor',
  'CallsignsEditor',
  'AdvancedReports',
];

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
  goiSimpleUrl: '',
  goiSimpleUrlDirty: false,
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
  if (typeof value === 'string')
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  return [];
}

function asNumberArray(value: unknown): number[] {
  if (Array.isArray(value))
    return value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isFinite(item));
  }
  return [];
}

function getOrganismGroupKeys(organismId: number, organismGroups: OrganismGroup[]): string[] {
  return organismGroups
    .filter((item) => item.organismId === organismId)
    .map((item) => item.masterKey);
}

function buildAvailableGroups(
  parentId: number | null,
  allGroups: SignalGroupFull[],
  organismGroups: OrganismGroup[],
) {
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

function getSimpleGoiUrl(apiHost: string, sshHost: string): string {
  return apiHost.trim() || sshHost.trim();
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

  const parentValue =
    props.organisms.find((organism) => organism.id === props.form.parentId) ?? null;
  const isGoiBusy =
    props.isSubmitting || props.isCheckingGoiConnection || props.isSettingUpGoiWorker;
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
        renderOption={(props, option) => {
          const { key: _unusedKey, ...optionProps } = props;
          return (
            <Box component="li" {...optionProps} key={option.id}>
              {option.name || `ID ${option.id}`}
            </Box>
          );
        }}
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
              .map((id) =>
                formatAorLabel(
                  props.aors.find((aor) => aor.id === id),
                  id,
                ),
              )
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
          За замовчуванням організм має доступ до всіх груп від смуг. Увімкніть для додаткового
          обмеження.
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
        <PowerAlert severity="info">
          Керування інтеграціями ГОІ винесено в окрему адмін-панель. Тут налаштування організму
          більше не містять GOI конфігурацію.
        </PowerAlert>
        <div>
          <PowerButton
            variant="outlined"
            onClick={() => navigateWithinSpa('/admin/goi-integrations-neo')}
            disabled={isGoiBusy}
          >
            Відкрити панель ГОІ
          </PowerButton>
        </div>
      </Box>
    </div>
  );
}

function AdminOrganismsNeoEditPageBody(props: AdminOrganismsNeoEditPageProps) {
  const isNew = !props.organismId;
  const [loadStatus, setLoadStatus] = useState<LoadingStatus>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [organisms, setOrganisms] = useState<Organism[]>([]);
  const [groups, setGroups] = useState<SignalGroupFull[]>([]);
  const [organismGroups, setOrganismGroups] = useState<OrganismGroup[]>([]);
  const [aors, setAors] = useState<AreaOfResponsibility[]>([]);

  const [form, setForm] = useState<OrganismFormState>(emptyFormState);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [originalGroupKeys, setOriginalGroupKeys] = useState<string[]>([]);
  const [computedGroups, setComputedGroups] = useState<SignalGroupFull[] | null>(null);
  const [computeError, setComputeError] = useState<string | null>(null);
  const [isComputing, setIsComputing] = useState(false);
  const [goiConnectionStatus, setGoiConnectionStatus] = useState<StatusMessage>(null);
  const [isCheckingGoiConnection, setIsCheckingGoiConnection] = useState(false);
  const [isSettingUpGoiWorker, setIsSettingUpGoiWorker] = useState(false);

  const backToPath = useMemo(getBackToPath, []);

  const availableGroups = useMemo(
    () => buildAvailableGroups(form.parentId, groups, organismGroups),
    [form.parentId, groups, organismGroups],
  );

  const groupsValidation = useMemo(
    () => validateGroupsForParent(organismGroups, groups, form.groupIds, form.parentId),
    [organismGroups, groups, form.groupIds, form.parentId],
  );

  useEffect(() => {
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
          goiIntegrationType: emptyFormState.goiIntegrationType,
          goiSshHost: emptyFormState.goiSshHost,
          goiSshUser: emptyFormState.goiSshUser,
          goiSshPort: emptyFormState.goiSshPort,
          goiPath: emptyFormState.goiPath,
          goiApiHost: emptyFormState.goiApiHost,
          goiApiPort: emptyFormState.goiApiPort,
          goiApiLogin: emptyFormState.goiApiLogin,
          goiApiPassword: emptyFormState.goiApiPassword,
          goiSimpleUrl: emptyFormState.goiSimpleUrl,
          goiSimpleUrlDirty: emptyFormState.goiSimpleUrlDirty,
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

  useEffect(() => {
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
      patch.goiApiPassword !== undefined ||
      patch.goiSimpleUrl !== undefined
    ) {
      setGoiConnectionStatus(null);
    }
    setForm((prev) => {
      const next = { ...prev, ...patch };
      if (
        (patch.goiIntegrationType === undefined ||
          patch.goiIntegrationType === GOI_INTEGRATION_TYPE_FULL) &&
        patch.goiSshHost !== undefined &&
        prev.goiApiHost.trim().length === 0 &&
        (patch.goiApiHost === undefined || patch.goiApiHost.trim().length === 0)
      ) {
        next.goiApiHost = patch.goiSshHost;
      }
      if (
        patch.goiIntegrationType === GOI_INTEGRATION_TYPE_SIMPLE &&
        prev.goiIntegrationType !== GOI_INTEGRATION_TYPE_SIMPLE
      ) {
        if (!prev.goiSimpleUrlDirty) {
          next.goiSimpleUrl = getSimpleGoiUrl(
            patch.goiApiHost ?? prev.goiApiHost,
            patch.goiSshHost ?? prev.goiSshHost,
          );
        }
      }
      if (patch.goiSimpleUrl !== undefined) {
        next.goiSimpleUrlDirty = true;
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
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  function buildGoiSettingsReq(
    organismId: number,
    nextForm: OrganismFormState,
  ): UpdateOrganismGoiSettingsReq {
    const hasGoiApiSettings = hasAnyGoiApiSettings(nextForm);
    if (nextForm.goiIntegrationType === GOI_INTEGRATION_TYPE_SIMPLE) {
      const simpleGoiUrl = nextForm.goiSimpleUrl.trim();
      return {
        organismId,
        integrationType: GOI_INTEGRATION_TYPE_SIMPLE,
        sshHost: '',
        sshUser: '',
        sshPort: GOI_SSH_PORT_DEFAULT,
        path: GOI_PATH_DEFAULT,
        apiHost: simpleGoiUrl,
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
      apiHost: hasGoiApiSettings ? nextForm.goiApiHost.trim() || nextForm.goiSshHost.trim() : '',
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
        goiSimpleUrl: getSimpleGoiUrl(settings.apiHost, settings.sshHost),
        goiSimpleUrlDirty: settings.integrationType === GOI_INTEGRATION_TYPE_SIMPLE,
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
      const selectedGroupIds = nextForm.limitGroups ? nextForm.groupIds : [];

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
          await Promise.all(
            toAdd.map((groupId) =>
              addGroupToOrganism({ organismId: parsedId, groupName: groupId }),
            ),
          );
        }
        if (toRemove.length > 0) {
          await Promise.all(
            toRemove.map((groupId) =>
              removeGroupFromOrganism({ organismId: parsedId, groupName: groupId }),
            ),
          );
        }
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
    return (
      <PageErrorState
        message={loadError || 'Помилка завантаження'}
        actionLabel="Назад"
        onAction={navigateBack}
      />
    );
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
          <PowerAlert severity={status.kind} onClose={() => setStatus(null)}>
            {status.message}
          </PowerAlert>
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
          <PowerButton
            variant="outlined"
            onClick={navigateBack}
            disabled={isSubmitting || isCheckingGoiConnection || isSettingUpGoiWorker}
          >
            Скасувати
          </PowerButton>
          <PowerButton
            variant="contained"
            onClick={handleSubmit}
            disabled={isSubmitting || isCheckingGoiConnection || isSettingUpGoiWorker}
          >
            {isNew ? 'Створити' : 'Зберегти'}
          </PowerButton>
        </div>
      </div>
    </FormPageLayout>
  );
}

export function AdminOrganismsNeoEditPage(props: AdminOrganismsNeoEditPageProps) {
  return <AdminOrganismsNeoEditPageBody organismId={props.organismId} />;
}
