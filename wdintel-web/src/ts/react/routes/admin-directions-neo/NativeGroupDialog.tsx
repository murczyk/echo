import { GroupMessageRequirements } from '../shared/group-navigation/GroupMessageRequirements';
import {
  Autocomplete,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Switch,
  TextField,
} from '@mui/material';
import { useEffect, useState } from 'react';

import type {
  AreaOfResponsibility,
  Login,
  NativeGroupDetail,
  NativeGroupSettings,
  Organism,
  SigintZone,
} from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import {
  createNativeGroup,
  getNativeGroup,
  updateNativeGroup,
} from '../../services/api/native-groups';
import { fetchCurrentUser } from '../../services/api/user';
import { GroupColorPicker } from '../shared/group-navigation';

type ReferenceData = {
  logins: Login[];
  organisms: Organism[];
  aors: AreaOfResponsibility[];
  zones: [number, SigintZone][];
  supportNonRerInterceptions: boolean;
};

type Props = ReferenceData & {
  masterKey: string | null;
  requestId: string;
  onClose: () => void;
  onSaved: (group: NativeGroupDetail) => void;
};

function defaultSettings(creatorId: string): NativeGroupSettings {
  return {
    name: '',
    colorKey: 'blue_grey',
    shortNote: null,
    longNote: null,
    isSecret: true,
    userLogins: [creatorId],
    organismIds: [],
    adminLogins: [creatorId],
    areaOfResponsibilityIds: [],
    zoneIds: [],
    interseptionKind: 'rer',
    disableNetworkAssignment: false,
    isAviationGroup: false,
    aiTranscriptAnalysisEnabled: false,
    isSigintUnitMandatory: false,
    isDeviceMandatory: false,
  };
}

type SelectionOption<T extends string | number> = { id: T; label: string };

function GroupSelection<T extends string | number>({
  label,
  options,
  selectedIds,
  onChange,
  disabled,
}: {
  label: string;
  options: SelectionOption<T>[];
  selectedIds: T[];
  onChange: (ids: T[]) => void;
  disabled: boolean;
}) {
  const value = selectedIds.map(
    (id) => options.find((option) => option.id === id) ?? { id, label: String(id) },
  );
  return (
    <Autocomplete
      multiple
      disabled={disabled}
      options={options}
      value={value}
      getOptionLabel={(option) => option.label}
      isOptionEqualToValue={(option, selected) => option.id === selected.id}
      onChange={(_, selected) => onChange(selected.map(({ id }) => id))}
      renderInput={(params) => <TextField {...params} label={label} />}
    />
  );
}

function NativeGroupFields({
  settings,
  onChange,
  logins,
  organisms,
  aors,
  zones,
  supportNonRerInterceptions,
  disabled,
}: ReferenceData & {
  settings: NativeGroupSettings;
  onChange: (settings: NativeGroupSettings) => void;
  disabled: boolean;
}) {
  const loginOptions = logins
    .filter((login) => !login.deleted)
    .map(({ id, login }) => ({ id, label: login }));
  return (
    <div className="flex flex-col gap-echo-lg">
      <TextField
        label="Назва групи"
        required
        autoFocus
        disabled={disabled}
        value={settings.name}
        onChange={(event) => onChange({ ...settings, name: event.target.value })}
      />
      <GroupColorPicker
        value={settings.colorKey ?? 'blue_grey'}
        disabled={disabled}
        onChange={(colorKey) => onChange({ ...settings, colorKey })}
      />
      <GroupSelection
        label="Адміністратори"
        disabled={disabled}
        options={loginOptions}
        selectedIds={settings.adminLogins}
        onChange={(adminLogins) => onChange({ ...settings, adminLogins })}
      />
      <FormControlLabel
        label="Приватна група"
        control={
          <Switch
            disabled={disabled}
            checked={settings.isSecret}
            onChange={(_, isSecret) => onChange({ ...settings, isSecret })}
          />
        }
      />
      {settings.isSecret ? (
        <>
          <GroupSelection
            label="Дозволені користувачі"
            disabled={disabled}
            options={loginOptions}
            selectedIds={settings.userLogins}
            onChange={(userLogins) => onChange({ ...settings, userLogins })}
          />
          <GroupSelection
            label="Дозволені організми"
            disabled={disabled}
            options={organisms
              .filter((organism) => organism.enabled)
              .map(({ id, name }) => ({ id, label: name }))}
            selectedIds={settings.organismIds}
            onChange={(organismIds) => onChange({ ...settings, organismIds })}
          />
        </>
      ) : null}
      <GroupMessageRequirements
        isSigintUnitMandatory={settings.isSigintUnitMandatory ?? false}
        isDeviceMandatory={settings.isDeviceMandatory ?? false}
        disabled={disabled}
        onChange={(requirements) => onChange({ ...settings, ...requirements })}
      />
      <GroupSelection
        label="Напрямки"
        disabled={disabled}
        options={zones.map(([id, zone]) => ({ id, label: zone.name }))}
        selectedIds={settings.zoneIds}
        onChange={(zoneIds) => onChange({ ...settings, zoneIds })}
      />
      <GroupSelection
        label="Смуги відповідальності"
        disabled={disabled}
        options={aors.map(({ id, name }) => ({ id, label: name }))}
        selectedIds={settings.areaOfResponsibilityIds}
        onChange={(areaOfResponsibilityIds) => onChange({ ...settings, areaOfResponsibilityIds })}
      />
      {supportNonRerInterceptions || settings.interseptionKind === 'other' ? (
        <TextField
          select
          label="Категорія групи"
          value={settings.interseptionKind}
          disabled={disabled || !supportNonRerInterceptions}
          onChange={(event) =>
            onChange({
              ...settings,
              interseptionKind: event.target.value as NativeGroupSettings['interseptionKind'],
            })
          }
        >
          <MenuItem value="rer">РЕР</MenuItem>
          <MenuItem value="other">Інше</MenuItem>
        </TextField>
      ) : null}
      <FormControlLabel
        label="Вимкнути привʼязку мереж"
        control={
          <Switch
            checked={settings.disableNetworkAssignment}
            disabled={disabled}
            onChange={(_, disableNetworkAssignment) =>
              onChange({ ...settings, disableNetworkAssignment })
            }
          />
        }
      />
      <FormControlLabel
        label="Автоматично аналізувати транскрипції аудіо"
        control={
          <Switch
            checked={settings.aiTranscriptAnalysisEnabled ?? false}
            disabled={disabled}
            onChange={(_, aiTranscriptAnalysisEnabled) =>
              onChange({ ...settings, aiTranscriptAnalysisEnabled })
            }
          />
        }
      />
      <FormControlLabel
        label="Авіаційна група"
        control={
          <Switch
            checked={settings.isAviationGroup}
            disabled={disabled}
            onChange={(_, isAviationGroup) => onChange({ ...settings, isAviationGroup })}
          />
        }
      />
      <TextField
        label="Коротка нотатка"
        disabled={disabled}
        value={settings.shortNote ?? ''}
        onChange={(event) => onChange({ ...settings, shortNote: event.target.value })}
      />
      <TextField
        label="Розширена нотатка"
        disabled={disabled}
        multiline
        minRows={3}
        value={settings.longNote ?? ''}
        onChange={(event) => onChange({ ...settings, longNote: event.target.value })}
      />
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Невідома помилка';
}

export function NativeGroupDialog(props: Props) {
  const { notify } = usePowerSnackbar();
  const [settings, setSettings] = useState<NativeGroupSettings | null>(null);
  const [isArchived, setIsArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        if (props.masterKey) {
          const group = await getNativeGroup(props.masterKey, { signal: controller.signal });
          setSettings(group.settings);
          setIsArchived(group.isArchived);
        } else {
          const user = await fetchCurrentUser(controller.signal);
          setSettings(defaultSettings(user.id));
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = `Не вдалося завантажити групу: ${errorMessage(error)}`;
          setError(message);
          notify({ severity: 'error', message });
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [props.masterKey, notify]);

  async function save() {
    if (!settings || saving || isArchived) return;
    if (
      !settings.name.trim() ||
      settings.adminLogins.length === 0 ||
      (settings.zoneIds.length > 0 && settings.areaOfResponsibilityIds.length === 0)
    ) {
      setError('Вкажіть назву, щонайменше одного адміністратора та смугу для вибраних напрямків.');
      return;
    }
    setSaving(true);
    setError(null);
    const nextSettings = {
      ...settings,
      name: settings.name.trim(),
      shortNote: settings.shortNote?.trim() || null,
      longNote: settings.longNote?.trim() || null,
      userLogins: settings.isSecret ? settings.userLogins : [],
      organismIds: settings.isSecret ? settings.organismIds : [],
    };
    let group: NativeGroupDetail;
    try {
      group = props.masterKey
        ? await updateNativeGroup({ masterKey: props.masterKey, settings: nextSettings })
        : await createNativeGroup({ requestId: props.requestId, settings: nextSettings });
    } catch (error) {
      const message = `Не вдалося зберегти групу: ${errorMessage(error)}`;
      setError(message);
      notify({ severity: 'error', message });
      setSaving(false);
      return;
    }
    notify({
      severity: 'success',
      message: props.masterKey ? 'Групу збережено.' : 'Групу створено.',
    });
    props.onSaved(group);
  }

  return (
    <Dialog open fullWidth maxWidth="md" onClose={saving ? undefined : props.onClose}>
      <DialogTitle>{props.masterKey ? 'Налаштування групи' : 'Створити групу'}</DialogTitle>
      <DialogContent>
        <form
          id="native-group-form"
          className="flex flex-col gap-echo-lg py-echo-sm"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
          {loading ? <CircularProgress aria-label="Завантаження групи" /> : null}
          {isArchived ? (
            <PowerAlert severity="info">Для редагування розархівуйте групу.</PowerAlert>
          ) : null}
          {settings ? (
            <fieldset disabled={saving || isArchived} className="m-0 min-w-0 border-0 p-0">
              <NativeGroupFields
                {...props}
                settings={settings}
                onChange={setSettings}
                disabled={saving || isArchived}
              />
            </fieldset>
          ) : null}
        </form>
      </DialogContent>
      <DialogActions>
        <PowerButton variant="outlined" onClick={props.onClose} disabled={saving}>
          {isArchived ? 'Закрити' : 'Скасувати'}
        </PowerButton>
        {!isArchived ? (
          <PowerButton
            variant="contained"
            type="submit"
            form="native-group-form"
            disabled={loading || saving || !settings}
          >
            {props.masterKey ? 'Зберегти' : 'Створити групу'}
          </PowerButton>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}
