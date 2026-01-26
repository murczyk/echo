import ArrowBackIcon from '@mui/icons-material/ArrowBack';
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
import { Button } from '../../components/mui-customized/button';
import { listAors } from '../../services/api/aor';
import {
  addGroupToOrganism,
  computeAvailableGroups,
  computeAvailableGroupsForNew,
  createOrganism,
  listOrganismGroups,
  listOrganisms,
  listSignalGroups,
  removeGroupFromOrganism,
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
};

const ROLE_OPTIONS = ['Admin', 'Rer', 'Bpla', 'Full', 'Basic', 'UnitsEditor', 'CallsignsEditor'];

const emptyFormState: OrganismFormState = {
  name: '',
  parentId: null,
  roles: [],
  aorIds: [],
  enabled: true,
  limitGroups: false,
  groupIds: [],
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

type AdminOrganismsNeoEditPageProps = {
  organismId: string | null;
};

type OrganismFormFieldsProps = {
  form: OrganismFormState;
  formErrors: Record<string, string>;
  isSubmitting: boolean;
  isNew: boolean;
  organisms: Organism[];
  groups: SignalGroupFull[];
  availableGroups: SignalGroupFull[];
  aors: AreaOfResponsibility[];
  computedGroups: SignalGroupFull[] | null;
  computeError: string | null;
  isComputing: boolean;
  groupsValidation: string[];
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
      >
        {aorOptions}
      </TextField>

      <Box className="space-y-2">
        <Typography variant="subtitle2" className="text-muted-foreground">
          Доступні групи для організму
        </Typography>
        <Box className="p-3 rounded-md bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
          {props.isComputing ? (
            <div className="flex items-center gap-2">
              <CircularProgress size={18} />
              <Typography variant="body2" className="text-muted-foreground italic">
                Завантаження доступних груп...
              </Typography>
            </div>
          ) : props.computeError ? (
            <Typography variant="body2" className="text-red-600">
              {props.computeError}
            </Typography>
          ) : props.computedGroups ? (
            props.computedGroups.length === 0 ? (
              <Typography variant="body2" className="text-muted-foreground italic">
                Немає доступних груп
              </Typography>
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
        setOriginalGroupKeys(groupKeys);
        setForm({
          name: target.name,
          parentId: target.parentId,
          roles: target.roles,
          aorIds: target.aorIds,
          enabled: target.enabled,
          limitGroups: groupKeys.length > 0,
          groupIds: groupKeys,
        });
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
    setForm((prev) => ({ ...prev, ...patch }));
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
            selectedGroupIds.map((groupId) => addGroupToOrganism({ organismId: created.id, groupName: groupId })),
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
          await Promise.all(toAdd.map((groupId) => addGroupToOrganism({ organismId: parsedId, groupName: groupId })));
        }
        if (toRemove.length > 0) {
          await Promise.all(
            toRemove.map((groupId) => removeGroupFromOrganism({ organismId: parsedId, groupName: groupId })),
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
    return (
      <div className="flex items-center justify-center py-16">
        <CircularProgress size={28} />
      </div>
    );
  }

  if (loadStatus === 'error') {
    return (
      <div className="space-y-4 py-10">
        <Alert severity="error">{loadError || 'Помилка завантаження'}</Alert>
        <Button variant="outlined" onClick={navigateBack}>
          Назад
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center">
      <div className="w-full md:max-w-screen-lg space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Typography variant="h5" className="!font-semibold">
              {isNew ? 'Створити організм' : 'Редагувати організм'}
            </Typography>
            {!isNew && props.organismId ? (
              <Typography variant="body2" className="text-muted-foreground">
                ID: {props.organismId}
              </Typography>
            ) : null}
          </div>
          <Button variant="outlined" startIcon={<ArrowBackIcon />} onClick={navigateBack}>
            Назад
          </Button>
        </div>

        {status ? (
          <Alert severity={status.kind} onClose={() => setStatus(null)}>
            {status.message}
          </Alert>
        ) : null}

        <OrganismFormFields
          form={form}
          formErrors={formErrors}
          isSubmitting={isSubmitting}
          isNew={isNew}
          organisms={organisms}
          groups={groups}
          availableGroups={availableGroups}
          aors={aors}
          computedGroups={computedGroups}
          computeError={computeError}
          isComputing={isComputing}
          groupsValidation={groupsValidation}
          onChange={handleChange}
        />

        <div className="flex justify-end gap-3">
          <Button variant="outlined" onClick={navigateBack} disabled={isSubmitting}>
            Скасувати
          </Button>
          <Button variant="contained" onClick={handleSubmit} disabled={isSubmitting}>
            {isNew ? 'Створити' : 'Зберегти'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function AdminOrganismsNeoEditPage(props: AdminOrganismsNeoEditPageProps) {
  return <AdminOrganismsNeoEditPageBody organismId={props.organismId} />;
}
