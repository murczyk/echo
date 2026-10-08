import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CloseIcon from '@mui/icons-material/Close';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import LinkIcon from '@mui/icons-material/Link';
import {
  Button,
  Box,
  Checkbox,
  CircularProgress,
  Drawer,
  FormControlLabel,
  Link,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';

import type {
  CreateUnitReq,
  OrbitUnitDetails,
  Unit,
  UnitCombatType,
} from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { PowerIconButton } from '../../../components/PowerIconButton';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';
import { getCreateUnitDuplicateCandidates, getUnitCombatTypes } from '../../../services/api/units';
import {
  defaultUnitMasks,
  EMPTY_UNIT_FORM,
  formatUnitError,
  isUnitFormValid,
  trimUnitForm,
  unitName,
  unitToForm,
  uniqueTrimmed,
} from '../helpers';
import type { UnitForm } from '../helpers';
import { AutoNetworkFields } from './AutoNetworkFields';

export type UnitFormSubmit = {
  unit: CreateUnitReq;
  autoNetwork:
    | {
        skipNetworkCreation: boolean;
        locations: string[];
        unitMask: string[];
      }
    | undefined;
};

type Props = {
  open: boolean;
  suspended?: boolean;
  unit: Unit | null;
  devicesSectionEnabled: boolean;
  submitting: boolean;
  error: string | null;
  orbitUnits: OrbitUnitDetails[];
  orbitLinksLoading: boolean;
  orbitLinksError: string | null;
  canLinkOrbitUnit: boolean;
  unlinkingOrbitUnitId: string | null;
  onClose: () => void;
  onSubmit: (value: UnitFormSubmit) => void;
  onLinkOrbitUnit: () => void;
  onUnlinkOrbitUnit: (orbitUnit: OrbitUnitDetails) => void;
  editSection?: 'all' | 'unit' | 'orbit';
};

const HIERARCHY_FIELDS: Array<{
  key: keyof Pick<
    UnitForm,
    | 'other'
    | 'teamOrCrew'
    | 'section'
    | 'squad'
    | 'platoon'
    | 'company'
    | 'battalion'
    | 'regiment'
    | 'brigade'
    | 'division'
    | 'corps'
    | 'army'
    | 'militaryDistrict'
    | 'armyRegion'
  >;
  label: string;
  placeholder: string;
}> = [
  { key: 'other', label: 'Інше', placeholder: 'Інший рівень підпорядкування' },
  { key: 'teamOrCrew', label: 'Команда/Екіпаж', placeholder: 'Назва команди або екіпажу' },
  { key: 'section', label: 'Секція', placeholder: 'Назва секції' },
  { key: 'squad', label: 'Відділення', placeholder: 'Назва відділення' },
  { key: 'platoon', label: 'Взвод', placeholder: 'Наприклад, 1 взвод' },
  { key: 'company', label: 'Рота', placeholder: 'Наприклад, 1 рота' },
  { key: 'battalion', label: 'Батальйон', placeholder: 'Наприклад, 2 батальйон' },
  { key: 'regiment', label: 'Полк', placeholder: 'Наприклад, 123 полк' },
  { key: 'brigade', label: 'Бригада', placeholder: 'Наприклад, 123 бригада' },
  { key: 'division', label: 'Дивізія', placeholder: 'Назва дивізії' },
  { key: 'corps', label: 'Корпус', placeholder: 'Назва корпусу' },
  { key: 'army', label: 'Армія', placeholder: 'Назва армії' },
  {
    key: 'militaryDistrict',
    label: 'Група армій/Фронт',
    placeholder: 'Назва групи армій або фронту',
  },
  {
    key: 'armyRegion',
    label: 'Регіон/ТВД/Збройні Сили',
    placeholder: 'Назва регіону, ТВД або збройних сил',
  },
];

function UnitDetailsFields({
  form,
  editing,
  disabled,
  editSection,
  combatTypes,
  combatTypesLoading,
  combatTypeName,
  onChange,
}: {
  form: UnitForm;
  editing: boolean;
  disabled: boolean;
  editSection: 'all' | 'unit' | 'orbit';
  combatTypes: UnitCombatType[];
  combatTypesLoading: boolean;
  combatTypeName: string | null;
  onChange: (value: UnitForm) => void;
}) {
  if (editSection === 'orbit') {
    return (
      <Stack spacing={2}>
        <PresentInOrbitField form={form} disabled={disabled} onChange={onChange} />
        <TextField
          label="Примітка Orbit"
          placeholder="Причина відсутності прив’язки до Orbit"
          value={form.orbitNote ?? ''}
          onChange={(event) => onChange({ ...form, orbitNote: event.target.value || null })}
          disabled={disabled}
          multiline
          minRows={3}
          fullWidth
        />
      </Stack>
    );
  }

  return (
    <>
      <Typography color="text.secondary">Заповніть відомі рівні підпорядкування.</Typography>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {editing ? (
          <TextField
            label="Назва"
            placeholder="Назва підрозділу"
            value={form.name ?? ''}
            onChange={(event) => onChange({ ...form, name: event.target.value })}
            disabled={disabled}
            fullWidth
            sx={{ gridColumn: { md: '1 / -1' } }}
          />
        ) : null}
        {HIERARCHY_FIELDS.map(({ key, label, placeholder }) => (
          <TextField
            key={key}
            label={label}
            placeholder={placeholder}
            value={form[key]}
            onChange={(event) => onChange({ ...form, [key]: event.target.value })}
            disabled={disabled}
            fullWidth
          />
        ))}
        <TextField
          select
          label="Види та роди ЗС"
          value={form.combatTypeId ?? ''}
          onChange={(event) => onChange({ ...form, combatTypeId: event.target.value || null })}
          disabled={disabled || combatTypesLoading}
          helperText={combatTypesLoading ? 'Завантаження видів та родів ЗС…' : undefined}
          fullWidth
        >
          <MenuItem value="">Не визначено</MenuItem>
          {form.combatTypeId && !combatTypes.some((type) => type.id === form.combatTypeId) ? (
            <MenuItem value={form.combatTypeId}>{combatTypeName ?? 'Поточне значення'}</MenuItem>
          ) : null}
          {combatTypes.map((combatType) => (
            <MenuItem key={combatType.id} value={combatType.id}>
              {combatType.name}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          label="Коментар"
          placeholder="Додаткова інформація про підрозділ"
          value={form.comment}
          onChange={(event) => onChange({ ...form, comment: event.target.value })}
          disabled={disabled}
          multiline
          minRows={3}
          fullWidth
          sx={{ gridColumn: { md: '1 / -1' } }}
        />
        {editSection === 'all' ? (
          <>
            <TextField
              label="Примітка Orbit"
              placeholder="Причина відсутності прив’язки до Orbit"
              value={form.orbitNote ?? ''}
              onChange={(event) => onChange({ ...form, orbitNote: event.target.value || null })}
              disabled={disabled}
              multiline
              minRows={3}
              fullWidth
              sx={{ gridColumn: { md: '1 / -1' } }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={form.active}
                  onChange={(event) => onChange({ ...form, active: event.target.checked })}
                  disabled={disabled}
                />
              }
              label="Активний підрозділ"
            />
          </>
        ) : null}
        {editing && (editSection === 'all' || editSection === 'unit') ? (
          <>
            <PresentInOrbitField form={form} disabled={disabled} onChange={onChange} />
            <TextField
              select
              label="Можливо дублікат"
              value={
                form.isDeduplicateCandidate === null ? 'unset' : String(form.isDeduplicateCandidate)
              }
              onChange={(event) =>
                onChange({
                  ...form,
                  isDeduplicateCandidate:
                    event.target.value === 'unset' ? null : event.target.value === 'true',
                })
              }
              disabled={disabled}
              fullWidth
            >
              <MenuItem value="unset">Не визначено</MenuItem>
              <MenuItem value="true">Так</MenuItem>
              <MenuItem value="false">Ні</MenuItem>
            </TextField>
          </>
        ) : null}
      </div>
    </>
  );
}

function PresentInOrbitField({
  form,
  disabled,
  onChange,
}: {
  form: UnitForm;
  disabled: boolean;
  onChange: (value: UnitForm) => void;
}) {
  return (
    <TextField
      select
      label="Присутній в Orbit"
      value={form.presentInOrbit === null ? 'unset' : String(form.presentInOrbit)}
      onChange={(event) =>
        onChange({
          ...form,
          presentInOrbit: event.target.value === 'unset' ? null : event.target.value === 'true',
        })
      }
      disabled={disabled}
      fullWidth
    >
      <MenuItem value="unset">Немає інформації</MenuItem>
      <MenuItem value="true">Так</MenuItem>
      <MenuItem value="false">Ні</MenuItem>
    </TextField>
  );
}

function orbitUnitTitle(orbitUnit: OrbitUnitDetails): string {
  return (
    orbitUnit.unitName?.trim() ||
    orbitUnit.unitNameShort?.trim() ||
    orbitUnit.generativeUnitNameFull?.trim() ||
    orbitUnit.unitId
  );
}

function OrbitUnitLinks({
  orbitUnits,
  loading,
  error,
  canLinkOrbitUnit,
  unlinkingOrbitUnitId,
  onLink,
  onUnlink,
}: {
  orbitUnits: OrbitUnitDetails[];
  loading: boolean;
  error: string | null;
  canLinkOrbitUnit: boolean;
  unlinkingOrbitUnitId: string | null;
  onLink: () => void;
  onUnlink: (orbitUnit: OrbitUnitDetails) => void;
}) {
  if (!loading && error === null && orbitUnits.length === 0 && !canLinkOrbitUnit) return null;

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={2} alignItems="center" justifyContent="space-between">
        <Typography variant="h6">Прив’язані Orbit підрозділи</Typography>
        {canLinkOrbitUnit ? (
          <Button
            variant="outlined"
            startIcon={<LinkIcon />}
            disabled={loading || unlinkingOrbitUnitId !== null}
            onClick={onLink}
          >
            Прив’язати
          </Button>
        ) : null}
      </Stack>
      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
      {loading ? <CircularProgress size={24} /> : null}
      {orbitUnits.map((orbitUnit) => (
        <Stack
          key={orbitUnit.unitId}
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          alignItems={{ xs: 'stretch', sm: 'center' }}
          justifyContent="space-between"
          sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2 }}
        >
          <Stack spacing={0.5} sx={{ minWidth: 0 }}>
            <Link
              href={`https://delta.mil.gov.ua/orbit/units/${orbitUnit.unitId}/organizational-structure`}
              target="_blank"
              rel="noopener noreferrer"
              fontWeight={600}
              sx={{ overflowWrap: 'anywhere' }}
            >
              {orbitUnitTitle(orbitUnit)}
            </Link>
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              ID: {orbitUnit.unitId}
            </Typography>
          </Stack>
          <Button
            color="error"
            variant="outlined"
            startIcon={
              unlinkingOrbitUnitId === orbitUnit.unitId ? (
                <CircularProgress size={16} color="inherit" />
              ) : (
                <DeleteOutlineIcon />
              )
            }
            disabled={unlinkingOrbitUnitId !== null}
            onClick={() => onUnlink(orbitUnit)}
            sx={{ whiteSpace: 'nowrap' }}
          >
            Видалити
          </Button>
        </Stack>
      ))}
    </Stack>
  );
}

function DuplicateMergeSelection({
  units,
  selectedUnitIds,
  disabled,
  onToggle,
}: {
  units: Unit[];
  selectedUnitIds: Set<number>;
  disabled: boolean;
  onToggle: (unitId: number) => void;
}) {
  return (
    <Stack spacing={2}>
      <PowerAlert severity="warning" autoHideDuration={null}>
        Схоже що даний підрозділ вже прив'язаний до Orbit, будь-ласка оберіть які дублікати бажаєте
        виправити.
      </PowerAlert>
      <Stack spacing={1}>
        {units.map((unit) => (
          <FormControlLabel
            key={unit.id}
            control={
              <Checkbox
                checked={selectedUnitIds.has(unit.id)}
                onChange={() => onToggle(unit.id)}
                disabled={disabled}
              />
            }
            label={
              <Stack>
                <Typography fontWeight={600}>{unit.name}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {unit.active ? 'Активний підрозділ' : 'Неактивний підрозділ'}
                </Typography>
              </Stack>
            }
            sx={{ m: 0, border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}
          />
        ))}
      </Stack>
    </Stack>
  );
}

export function UnitFormDrawer({
  open,
  suspended = false,
  unit,
  devicesSectionEnabled,
  submitting,
  error,
  orbitUnits,
  orbitLinksLoading,
  orbitLinksError,
  canLinkOrbitUnit,
  unlinkingOrbitUnitId,
  onClose,
  onSubmit,
  onLinkOrbitUnit,
  onUnlinkOrbitUnit,
  editSection = 'all',
}: Props) {
  const [form, setForm] = useState<UnitForm>(EMPTY_UNIT_FORM);
  const [combatTypes, setCombatTypes] = useState<UnitCombatType[]>([]);
  const [combatTypesLoading, setCombatTypesLoading] = useState(false);
  const [combatTypesError, setCombatTypesError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || editSection === 'orbit') return;
    const controller = new AbortController();
    setCombatTypesLoading(true);
    setCombatTypesError(null);
    void getUnitCombatTypes({ signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) setCombatTypes(response.combatTypes);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setCombatTypesError(formatUnitError(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setCombatTypesLoading(false);
      });
    return () => controller.abort();
  }, [open, editSection]);

  const [networkStep, setNetworkStep] = useState(false);
  const [skipNetworkCreation, setSkipNetworkCreation] = useState(false);
  const [locations, setLocations] = useState<string[]>([]);
  const [unitMask, setUnitMask] = useState<string[]>([]);
  const [pendingSubmission, setPendingSubmission] = useState<UnitFormSubmit | null>(null);
  const [duplicateCandidates, setDuplicateCandidates] = useState<Unit[]>([]);
  const [selectedDuplicateUnitIds, setSelectedDuplicateUnitIds] = useState<Set<number>>(new Set());
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  const [duplicateCheckError, setDuplicateCheckError] = useState<string | null>(null);
  const initialFormRef = useRef<UnitForm>(EMPTY_UNIT_FORM);
  const sessionRef = useRef<{
    open: boolean;
    unitId: number | null;
    editSection: Props['editSection'];
  } | null>(null);
  const editing = unit !== null;
  const duplicateStep = pendingSubmission !== null;

  useEffect(() => {
    const previousSession = sessionRef.current;
    const unitId = unit?.id ?? null;
    const isNewSession =
      open &&
      (previousSession === null ||
        !previousSession.open ||
        previousSession.unitId !== unitId ||
        previousSession.editSection !== editSection);
    sessionRef.current = { open, unitId, editSection };
    if (!isNewSession) return;
    const initialForm = unit === null ? EMPTY_UNIT_FORM : unitToForm(unit);
    initialFormRef.current = initialForm;
    setForm(initialForm);
    setNetworkStep(false);
    setSkipNetworkCreation(false);
    setLocations([]);
    setUnitMask([]);
    setPendingSubmission(null);
    setDuplicateCandidates([]);
    setSelectedDuplicateUnitIds(new Set());
    setCheckingDuplicates(false);
    setDuplicateCheckError(null);
  }, [editSection, open, unit]);

  function continueFromDetails() {
    if (editing) {
      onSubmit({ unit: trimUnitForm(form), autoNetwork: undefined });
      return;
    }
    if (!devicesSectionEnabled) {
      void checkDuplicates({ unit: trimUnitForm(form), autoNetwork: undefined });
      return;
    }
    setUnitMask(defaultUnitMasks(form));
    setNetworkStep(true);
  }

  function submitNetworkStep() {
    void checkDuplicates({
      unit: trimUnitForm(form),
      autoNetwork: {
        skipNetworkCreation,
        locations: uniqueTrimmed(locations),
        unitMask: uniqueTrimmed(unitMask),
      },
    });
  }

  async function checkDuplicates(value: UnitFormSubmit) {
    setCheckingDuplicates(true);
    setDuplicateCheckError(null);
    try {
      const units = await getCreateUnitDuplicateCandidates(value.unit);
      if (units.length === 0) {
        onSubmit(value);
        return;
      }
      setDuplicateCandidates(units);
      setSelectedDuplicateUnitIds(new Set());
      setPendingSubmission(value);
    } catch (requestError) {
      setDuplicateCheckError(formatUnitError(requestError));
    } finally {
      setCheckingDuplicates(false);
    }
  }

  function submitDuplicateStep() {
    if (pendingSubmission === null) return;
    onSubmit({
      ...pendingSubmission,
      unit: {
        ...pendingSubmission.unit,
        duplicateUnitIds: Array.from(selectedDuplicateUnitIds),
      },
    });
  }

  function toggleDuplicate(unitId: number) {
    setSelectedDuplicateUnitIds((current) => {
      const next = new Set(current);
      if (next.has(unitId)) next.delete(unitId);
      else next.add(unitId);
      return next;
    });
  }

  function goBack() {
    if (duplicateStep) {
      setPendingSubmission(null);
      setDuplicateCandidates([]);
      setSelectedDuplicateUnitIds(new Set());
      return;
    }
    setNetworkStep(false);
  }

  const busy = submitting || checkingDuplicates || unlinkingOrbitUnitId !== null;
  const hasUnsavedChanges =
    JSON.stringify(form) !== JSON.stringify(initialFormRef.current) ||
    networkStep ||
    pendingSubmission !== null ||
    locations.length > 0 ||
    unitMask.length > 0 ||
    skipNetworkCreation;
  const requestClose = () => {
    if (busy) return;
    if (hasUnsavedChanges && !window.confirm('Є незбережені зміни. Закрити форму?')) return;
    onClose();
  };

  const confirmDisabled =
    submitting ||
    checkingDuplicates ||
    !isUnitFormValid(form) ||
    (networkStep && !skipNetworkCreation && locations.length === 0);

  return (
    <Drawer
      anchor="right"
      open={open && !suspended}
      onClose={busy ? undefined : requestClose}
      ModalProps={{ BackdropProps: { sx: (theme) => pageDrawerBackdropSx(theme) } }}
      slotProps={{
        paper: {
          'aria-labelledby': 'unit-form-drawer-title',
          sx: {
            width: { xs: '100vw', sm: 760 },
            maxWidth: '100vw',
            display: 'flex',
            backgroundColor: 'background.default',
            backgroundImage: 'none',
          },
        },
      }}
    >
      <Box sx={{ p: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
          <Typography variant="h6" id="unit-form-drawer-title">
            {duplicateStep
              ? 'Об’єднати дублікати'
              : editing && editSection === 'unit'
                ? 'Редагувати дані підрозділу'
                : editing && editSection === 'orbit'
                  ? 'Редагувати примітку Orbit'
                  : editing
                    ? 'Редагувати підрозділ'
                    : networkStep
                      ? 'Налаштування радіомережі'
                      : 'Новий підрозділ'}
          </Typography>
          <PowerIconButton
            aria-label="Закрити форму"
            size="small"
            disabled={busy}
            onClick={requestClose}
          >
            <CloseIcon fontSize="small" />
          </PowerIconButton>
        </Stack>
      </Box>
      <Box sx={{ p: 2.5, flex: 1, overflowY: 'auto' }}>
        <Stack spacing={3} sx={{ pt: 1 }}>
          {duplicateStep ? (
            <DuplicateMergeSelection
              units={duplicateCandidates}
              selectedUnitIds={selectedDuplicateUnitIds}
              disabled={submitting}
              onToggle={toggleDuplicate}
            />
          ) : networkStep ? (
            <AutoNetworkFields
              unitName={unitName(form)}
              skipNetworkCreation={skipNetworkCreation}
              allowSkip
              locations={locations}
              unitMask={unitMask}
              disabled={submitting || checkingDuplicates}
              onSkipNetworkCreationChange={setSkipNetworkCreation}
              onLocationsChange={setLocations}
              onUnitMaskChange={setUnitMask}
            />
          ) : (
            <>
              <UnitDetailsFields
                form={form}
                editing={editing}
                disabled={submitting || checkingDuplicates}
                editSection={editSection}
                combatTypes={combatTypes}
                combatTypesLoading={combatTypesLoading}
                combatTypeName={unit?.combatTypeName ?? null}
                onChange={setForm}
              />
              {editing && editSection === 'all' ? (
                <OrbitUnitLinks
                  orbitUnits={orbitUnits}
                  loading={orbitLinksLoading}
                  error={orbitLinksError}
                  canLinkOrbitUnit={canLinkOrbitUnit}
                  unlinkingOrbitUnitId={unlinkingOrbitUnitId}
                  onLink={onLinkOrbitUnit}
                  onUnlink={onUnlinkOrbitUnit}
                />
              ) : null}
            </>
          )}
          {combatTypesError ? (
            <PowerAlert severity="error">
              Не вдалося завантажити види та роди ЗС: {combatTypesError}
            </PowerAlert>
          ) : null}
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
          {duplicateCheckError ? (
            <PowerAlert severity="error">
              Не вдалося перевірити прив’язані дублікати: {duplicateCheckError}
            </PowerAlert>
          ) : null}
        </Stack>
      </Box>
      <Box sx={{ p: 2.5, borderTop: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" spacing={1} justifyContent="flex-end">
          {networkStep || duplicateStep ? (
            <PowerButton
              onClick={goBack}
              disabled={busy}
              startIcon={<ArrowBackIcon />}
              sx={{ mr: 'auto' }}
            >
              Назад
            </PowerButton>
          ) : null}
          <PowerButton onClick={requestClose} disabled={busy}>
            Скасувати
          </PowerButton>
          <PowerButton
            key={
              duplicateStep
                ? 'create-from-duplicates'
                : networkStep
                  ? 'network-next'
                  : 'unit-submit'
            }
            onClick={
              duplicateStep
                ? submitDuplicateStep
                : networkStep
                  ? submitNetworkStep
                  : continueFromDetails
            }
            variant="contained"
            disabled={confirmDisabled || busy}
            startIcon={
              submitting || checkingDuplicates ? (
                <CircularProgress size={16} color="inherit" />
              ) : null
            }
          >
            {duplicateStep
              ? 'Створити'
              : !editing && devicesSectionEnabled && !networkStep
                ? 'Далі'
                : editing
                  ? 'Зберегти'
                  : 'Створити'}
          </PowerButton>
        </Stack>
      </Box>
    </Drawer>
  );
}
