import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import {
  Autocomplete,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Link,
  MenuItem,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';

import type { CreateUnitReq, OrbitUnitDetails, Unit } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { STANDARD_DIALOG_ACTIONS_SX } from '../../../components/dialogStyles';
import { handleNavigateWithinSpaClick } from '../../../utils/browser';
import {
  defaultUnitMasks,
  EMPTY_UNIT_FORM,
  findPotentialDuplicates,
  isUnitFormValid,
  trimUnitForm,
  unitName,
  unitToForm,
  uniqueTrimmed,
} from '../helpers';
import type { UnitForm } from '../helpers';

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
  unit: Unit | null;
  units: Unit[];
  devicesSectionEnabled: boolean;
  submitting: boolean;
  error: string | null;
  orbitUnits: OrbitUnitDetails[];
  orbitLinksLoading: boolean;
  orbitLinksError: string | null;
  unlinkingOrbitUnitId: string | null;
  onClose: () => void;
  onSubmit: (value: UnitFormSubmit) => void;
  onUnlinkOrbitUnit: (orbitUnit: OrbitUnitDetails) => void;
};

const HIERARCHY_FIELDS: Array<{
  key: keyof Pick<UnitForm, 'company' | 'battalion' | 'regiment' | 'division' | 'army'>;
  label: string;
  placeholder: string;
}> = [
  { key: 'company', label: 'Рота, взвод', placeholder: 'Наприклад, 1 рота' },
  { key: 'battalion', label: 'Батальйон', placeholder: 'Наприклад, 2 батальйон' },
  { key: 'regiment', label: 'Полк/Бригада', placeholder: 'Наприклад, 123 бригада' },
  { key: 'division', label: 'Дивізія', placeholder: 'Назва дивізії' },
  { key: 'army', label: 'Корпус/Армія', placeholder: 'Назва корпусу або армії' },
];

function DuplicateHint({ units, form }: { units: Unit[]; form: UnitForm }) {
  const duplicates = useMemo(() => findPotentialDuplicates(units, form), [form, units]);
  const visible = duplicates.slice(0, 5);
  if (visible.length === 0) return null;

  return (
    <PowerAlert severity="warning" autoHideDuration={null}>
      <Stack spacing={1.5}>
        <Typography fontWeight={600}>Можливо, такий підрозділ уже існує</Typography>
        <TableContainer sx={{ maxWidth: '100%' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Назва</TableCell>
                <TableCell>Рота/Взвод</TableCell>
                <TableCell>Батальйон</TableCell>
                <TableCell>Полк/Бригада</TableCell>
                <TableCell>Дивізія</TableCell>
                <TableCell>Корпус/Армія</TableCell>
                <TableCell>Статус</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {visible.map((unit) => {
                const href = `/rer-units/${unit.id}`;
                return (
                  <TableRow key={unit.id}>
                    <TableCell>
                      <Link
                        href={href}
                        onClick={(event) => handleNavigateWithinSpaClick(event, href)}
                      >
                        {unit.name}
                      </Link>
                    </TableCell>
                    <TableCell>{unit.company}</TableCell>
                    <TableCell>{unit.battalion}</TableCell>
                    <TableCell>{unit.regiment}</TableCell>
                    <TableCell>{unit.division}</TableCell>
                    <TableCell>{unit.army}</TableCell>
                    <TableCell>{unit.active ? 'Активний' : 'Неактивний'}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
        {duplicates.length > visible.length ? (
          <Typography variant="caption">
            Показано перші {visible.length} з {duplicates.length} збігів. Уточніть поля, щоб звузити
            список.
          </Typography>
        ) : null}
      </Stack>
    </PowerAlert>
  );
}

function UnitDetailsFields({
  form,
  editing,
  disabled,
  onChange,
}: {
  form: UnitForm;
  editing: boolean;
  disabled: boolean;
  onChange: (value: UnitForm) => void;
}) {
  return (
    <>
      <Typography color="text.secondary">
        Заповніть відомі рівні підпорядкування. Під час введення нижче з’являться можливі збіги з
        уже наявними підрозділами.
      </Typography>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
        {editing ? (
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
        ) : null}
      </div>
    </>
  );
}

function NetworkFields({
  form,
  skipNetworkCreation,
  locations,
  unitMask,
  disabled,
  onSkipNetworkCreationChange,
  onLocationsChange,
  onUnitMaskChange,
}: {
  form: UnitForm;
  skipNetworkCreation: boolean;
  locations: string[];
  unitMask: string[];
  disabled: boolean;
  onSkipNetworkCreationChange: (value: boolean) => void;
  onLocationsChange: (value: string[]) => void;
  onUnitMaskChange: (value: string[]) => void;
}) {
  const fieldsDisabled = disabled || skipNetworkCreation;

  return (
    <>
      <TextField label="Підрозділ" value={unitName(form) || 'Без назви'} disabled fullWidth />
      <PowerAlert severity="info" autoHideDuration={null}>
        Разом з підрозділом буде створена SIGINT мережа, яку можна редагувати у База Даних — Мережі.
      </PowerAlert>
      <FormControlLabel
        control={
          <Switch
            checked={skipNetworkCreation}
            onChange={(event) => onSkipNetworkCreationChange(event.target.checked)}
            disabled={disabled}
          />
        }
        label="Пропустити створення мережі"
      />
      <Typography variant="body2" color="text.secondary">
        Без мережі вхідні повідомлення не будуть автоматично зіставлятися з цим підрозділом.
      </Typography>
      <TextField
        label="Назва майбутньої мережі"
        value={`р/м 💻 ${unitName(form) || 'Без назви'}`}
        disabled
        fullWidth
      />
      <Autocomplete
        multiple
        freeSolo
        options={[]}
        value={locations}
        onChange={(_, value) => onLocationsChange(value)}
        disabled={fieldsDisabled}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Локації"
            placeholder="Введіть локацію та натисніть Enter"
            required={!skipNetworkCreation}
          />
        )}
      />
      <Typography variant="body2" color="text.secondary">
        Якщо текст сигналу містить одну з цих назв, повідомлення буде позначено як повідомлення від
        цього підрозділу.
      </Typography>
      <Autocomplete
        multiple
        freeSolo
        options={[]}
        value={unitMask}
        onChange={(_, value) => onUnitMaskChange(value)}
        disabled={fieldsDisabled}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Маски підрозділу"
            placeholder="Введіть маску та натисніть Enter"
          />
        )}
      />
    </>
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
  unlinkingOrbitUnitId,
  onUnlink,
}: {
  orbitUnits: OrbitUnitDetails[];
  loading: boolean;
  error: string | null;
  unlinkingOrbitUnitId: string | null;
  onUnlink: (orbitUnit: OrbitUnitDetails) => void;
}) {
  if (!loading && error === null && orbitUnits.length === 0) return null;

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">Прив’язані Orbit підрозділи</Typography>
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

export function UnitFormDialog({
  open,
  unit,
  units,
  devicesSectionEnabled,
  submitting,
  error,
  orbitUnits,
  orbitLinksLoading,
  orbitLinksError,
  unlinkingOrbitUnitId,
  onClose,
  onSubmit,
  onUnlinkOrbitUnit,
}: Props) {
  const [form, setForm] = useState<UnitForm>(EMPTY_UNIT_FORM);
  const [networkStep, setNetworkStep] = useState(false);
  const [skipNetworkCreation, setSkipNetworkCreation] = useState(false);
  const [locations, setLocations] = useState<string[]>([]);
  const [unitMask, setUnitMask] = useState<string[]>([]);
  const editing = unit !== null;

  useEffect(() => {
    if (!open) return;
    setForm(unit === null ? EMPTY_UNIT_FORM : unitToForm(unit));
    setNetworkStep(false);
    setSkipNetworkCreation(false);
    setLocations([]);
    setUnitMask([]);
  }, [open, unit]);

  function continueFromDetails() {
    if (!devicesSectionEnabled || editing) {
      onSubmit({ unit: trimUnitForm(form), autoNetwork: undefined });
      return;
    }
    setUnitMask(defaultUnitMasks(form));
    setNetworkStep(true);
  }

  function submitNetworkStep() {
    onSubmit({
      unit: trimUnitForm(form),
      autoNetwork: {
        skipNetworkCreation,
        locations: uniqueTrimmed(locations),
        unitMask: uniqueTrimmed(unitMask),
      },
    });
  }

  const confirmDisabled =
    submitting ||
    !isUnitFormValid(form) ||
    (networkStep && !skipNetworkCreation && locations.length === 0);

  return (
    <Dialog
      open={open}
      onClose={submitting || unlinkingOrbitUnitId !== null ? undefined : onClose}
      fullWidth
      maxWidth={networkStep ? 'sm' : 'lg'}
    >
      <DialogTitle>
        {editing
          ? 'Редагувати підрозділ'
          : networkStep
            ? 'Налаштування радіомережі'
            : 'Новий підрозділ'}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={3} sx={{ pt: 1 }}>
          {networkStep ? (
            <NetworkFields
              form={form}
              skipNetworkCreation={skipNetworkCreation}
              locations={locations}
              unitMask={unitMask}
              disabled={submitting}
              onSkipNetworkCreationChange={setSkipNetworkCreation}
              onLocationsChange={setLocations}
              onUnitMaskChange={setUnitMask}
            />
          ) : (
            <>
              <UnitDetailsFields
                form={form}
                editing={editing}
                disabled={submitting}
                onChange={setForm}
              />
              {editing ? (
                <OrbitUnitLinks
                  orbitUnits={orbitUnits}
                  loading={orbitLinksLoading}
                  error={orbitLinksError}
                  unlinkingOrbitUnitId={unlinkingOrbitUnitId}
                  onUnlink={onUnlinkOrbitUnit}
                />
              ) : (
                <DuplicateHint units={units} form={form} />
              )}
            </>
          )}
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
        {networkStep ? (
          <Button
            onClick={() => setNetworkStep(false)}
            disabled={submitting}
            startIcon={<ArrowBackIcon />}
            sx={{ mr: 'auto' }}
          >
            Назад
          </Button>
        ) : null}
        <Button onClick={onClose} disabled={submitting || unlinkingOrbitUnitId !== null}>
          Скасувати
        </Button>
        <Button
          onClick={networkStep ? submitNetworkStep : continueFromDetails}
          variant="contained"
          disabled={confirmDisabled || unlinkingOrbitUnitId !== null}
          startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : null}
        >
          {!editing && devicesSectionEnabled && !networkStep
            ? 'Далі'
            : editing
              ? 'Зберегти'
              : 'Створити'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
