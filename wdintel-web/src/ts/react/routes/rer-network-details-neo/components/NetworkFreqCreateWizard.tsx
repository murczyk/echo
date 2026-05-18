import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { SelectChangeEvent } from '@mui/material/Select';
import { memo, useEffect, useMemo, useState } from 'react';

import type { EncryptionKeyData, ModulationRec } from '../../../../../Bindings';
import { createKey, listKeys } from '../../../services/api/networks';
import { PowerAlert } from '../../../components/PowerAlert';
import {
  formatErrorMessage,
  getFrequencyFormatError,
  NETWORK_ENCRYPTION_TYPE_OPTIONS,
  displayNetworkSignalType,
  isModulationCompatibleWithSignalType,
  signalTypeFromKind,
  signalTypeFromModulationName,
  type NetworkFreqCreateWizardForm,
} from '../use-rer-network-details-neo-page.shared';
import { NetworkFreqDatePickerField } from './NetworkFreqDatePickerField';
import { NetworkFreqActivityControl } from './NetworkFreqActivityControl';
import { NetworkFreqKeysSection } from './NetworkFreqKeysSection';
import { NetworkFreqSectionCard } from './NetworkFreqSectionCard';
import { NEO_SELECT_MENU_PROPS } from './dropdownProps';

type Props = {
  open: boolean;
  step: 1 | 2;
  form: NetworkFreqCreateWizardForm;
  saving: boolean;
  error: string | null;
  networkId: number | null;
  canManageKeys: boolean;
  modulations: ModulationRec[];
  onClose: () => void;
  onChange: (next: NetworkFreqCreateWizardForm) => void;
  onStepChange: (step: 1 | 2) => void;
  onSave: () => void;
};

type NewKeyForm = {
  key: string;
  description: string;
  modulationId: number | null;
};

const DISABLED_TECH_HELPER = 'Поки що не підтримується';

function formatKeyLabel(key: EncryptionKeyData): string {
  const parts = [key.description?.trim(), key.key?.trim()].filter((value) => value && value !== '');
  if (parts.length === 0) {
    return `#${key.id ?? '—'}`;
  }

  return parts.join(' • ');
}

function buildSelectedKeys(keys: EncryptionKeyData[], selectedIds: number[]): EncryptionKeyData[] {
  const keysById = new Map(keys.map((key) => [key.id, key]));
  return selectedIds.map((keyId) => keysById.get(keyId)).filter((key): key is EncryptionKeyData => Boolean(key));
}

function NetworkFreqCreateWizardComponent({
  open,
  step,
  form,
  saving,
  error,
  networkId,
  canManageKeys,
  modulations,
  onClose,
  onChange,
  onStepChange,
  onSave,
}: Props) {
  const [keys, setKeys] = useState<EncryptionKeyData[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [newKeyOpen, setNewKeyOpen] = useState(false);
  const [newKeySaving, setNewKeySaving] = useState(false);
  const [freqTouched, setFreqTouched] = useState(false);
  const [newKeyForm, setNewKeyForm] = useState<NewKeyForm>({
    key: '',
    description: '',
    modulationId: null,
  });
  const freqValidationError = getFrequencyFormatError(form.freq);

  const modulationItems = useMemo(
    () =>
      modulations
        .filter((modulation) => {
          const modulationSignalType = signalTypeFromModulationName(modulation.name);
          return modulationSignalType === null || modulationSignalType === form.signalType;
        })
        .map((modulation) => (
          <MenuItem key={modulation.id} value={String(modulation.id)}>
            {modulation.name}
          </MenuItem>
        )),
    [form.signalType, modulations],
  );

  const selectedKeys = useMemo(() => (form ? buildSelectedKeys(keys, form.encryptionKeyIds) : []), [form, keys]);
  const freqError = freqTouched ? freqValidationError : null;
  const saveDisabled = saving || form.modulationId === null || freqValidationError !== null;
  const handleClose = () => {
    setFreqTouched(false);
    onClose();
  };
  const handleSave = () => {
    setFreqTouched(false);
    onSave();
  };

  useEffect(() => {
    if (!open) return;
    setFreqTouched(false);
  }, [open]);

  useEffect(() => {
    if (!open || !canManageKeys || networkId === null) return;

    let active = true;
    setKeysLoading(true);
    setKeys([]);
    setKeysError(null);

    void listKeys({ sigintNetworkId: networkId })
      .then((response) => {
        if (!active) return;
        setKeys(response.keys);
      })
      .catch((loadError) => {
        if (!active) return;
        setKeysError(formatErrorMessage(loadError));
      })
      .finally(() => {
        if (!active) return;
        setKeysLoading(false);
      });

    return () => {
      active = false;
    };
  }, [canManageKeys, networkId, open]);

  const handleModulationChange = (event: SelectChangeEvent<string>) => {
    const value = event.target.value.trim();
    const selectedModulation = modulations.find((modulation) => String(modulation.id) === value);
    onChange({
      ...form,
      modulationId: value === '' ? null : Number(value),
      signalType: signalTypeFromModulationName(selectedModulation?.name) ?? form.signalType,
    });
  };

  const handleKindChange = (event: SelectChangeEvent<string>) => {
    const nextKind = String(event.target.value) as NetworkFreqCreateWizardForm['kind'];
    const nextSignalType = signalTypeFromKind(nextKind);
    const nextModulationId =
      form.modulationId === null
        ? null
        : isModulationCompatibleWithSignalType(
            modulations.find((modulation) => modulation.id === form.modulationId)?.name,
            nextSignalType,
          )
          ? form.modulationId
          : null;

    onChange({
      ...form,
      kind: nextKind,
      signalType: nextSignalType,
      modulationId: nextModulationId,
    });
  };

  const handleSelectedKeysChange = (_event: unknown, next: EncryptionKeyData[]) => {
    onChange({ ...form, encryptionKeyIds: next.flatMap((key) => (key.id === null ? [] : [key.id])) });
  };

  const handleCreateKey = async () => {
    if (!networkId || newKeySaving) return;

    setNewKeySaving(true);
    try {
      const createdKey = await createKey({
        sigintNetworkId: networkId,
        sigintNetworkFreqIds: [],
        key: newKeyForm.key.trim() === '' ? null : newKeyForm.key.trim(),
        keyHash: null,
        description: newKeyForm.description.trim() === '' ? null : newKeyForm.description.trim(),
        modulationId: newKeyForm.modulationId,
      });

      setKeys((current) => {
        if (createdKey.id === null) return current;
        if (current.some((key) => key.id === createdKey.id)) return current;
        return [...current, createdKey];
      });

      if (createdKey.id !== null) {
        onChange({
          ...form,
          encryptionKeyIds: [...new Set([...form.encryptionKeyIds, createdKey.id])],
        });
      }

      setNewKeyOpen(false);
      setNewKeyForm({ key: '', description: '', modulationId: null });
    } catch (createError) {
      setKeysError(formatErrorMessage(createError));
    } finally {
      setNewKeySaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : handleClose} fullWidth maxWidth="sm">
      <DialogTitle>{step === 1 ? 'Нова частота — основні параметри' : 'Нова частота — технічні параметри'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}

          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
            <Box sx={{ height: 8, borderRadius: 999, bgcolor: 'action.hover', overflow: 'hidden' }}>
              <Box sx={{ width: '100%', height: '100%', bgcolor: 'warning.main' }} />
            </Box>
            <Box sx={{ height: 8, borderRadius: 999, bgcolor: 'action.hover', overflow: 'hidden' }}>
              <Box sx={{ width: step === 2 ? '100%' : '0%', height: '100%', bgcolor: 'warning.main' }} />
            </Box>
          </Box>

          <Typography variant="body2" color="text.secondary">
            Крок {step} з 2{step === 2 ? ' (не обов’язково)' : ''}
          </Typography>

          {step === 1 ? (
            <>
              <TextField
                label="Частота *"
                placeholder="наприклад, 146.5000"
                value={form.freq}
                onChange={(event) => onChange({ ...form, freq: event.target.value })}
                onBlur={() => setFreqTouched(true)}
                disabled={saving}
                fullWidth
                error={freqError !== null}
                helperText={freqError ?? ' '}
              />

              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
                <FormControl fullWidth disabled={saving}>
                  <InputLabel id="network-freq-create-modulation-label" shrink>
                    Модуляція *
                  </InputLabel>
                  <Select
                    labelId="network-freq-create-modulation-label"
                    label="Модуляція *"
                    displayEmpty
                    value={form.modulationId === null ? '' : String(form.modulationId)}
                    onChange={handleModulationChange}
                    MenuProps={NEO_SELECT_MENU_PROPS}
                    renderValue={(value) => {
                      if (value === '') {
                        return <span style={{ opacity: 0.7 }}>Виберіть модуляцію</span>;
                      }

                      return modulations.find((modulation) => String(modulation.id) === String(value))?.name ?? value;
                    }}
                  >
                    {modulationItems}
                  </Select>
                </FormControl>

              <FormControl fullWidth disabled={saving}>
                <InputLabel id="network-freq-create-kind-label">Сумісний тип *</InputLabel>
                <Select
                  labelId="network-freq-create-kind-label"
                  label="Сумісний тип *"
                  value={form.kind}
                  onChange={handleKindChange}
                  MenuProps={NEO_SELECT_MENU_PROPS}
                >
                  <MenuItem value="DMR">DMR</MenuItem>
                  <MenuItem value="DMRe">DMRe</MenuItem>
                  <MenuItem value="NFM">NFM</MenuItem>
                </Select>
              </FormControl>

              <TextField
                label="Тип сигналу"
                value={displayNetworkSignalType(form.signalType)}
                disabled
                fullWidth
              />
              </Box>

              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <NetworkFreqDatePickerField
                  label="Активна з"
                  value={form.activeFrom}
                  onChange={(nextValue) => onChange({ ...form, activeFrom: nextValue })}
                  disabled={saving}
                />

                <NetworkFreqActivityControl
                  activeTo={form.activeTo}
                  onChange={(nextValue) => onChange({ ...form, activeTo: nextValue })}
                  disabled={saving}
                />
              </Box>

              <TextField
                label="Опис (необов'язково)"
                value={form.description}
                onChange={(event) => onChange({ ...form, description: event.target.value })}
                disabled={saving}
                fullWidth
                multiline
                minRows={2}
              />
            </>
          ) : (
            <>
              <NetworkFreqSectionCard title="DMR" muted hint={DISABLED_TECH_HELPER}>
                <Stack spacing={2.5}>
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                      gap: 2,
                    }}
                  >
                    <TextField
                      label="Rx"
                      value=""
                      disabled
                      fullWidth
                    />
                    <TextField
                      label="Tx"
                      value=""
                      disabled
                      fullWidth
                    />
                  </Box>

                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' },
                      gap: 2,
                    }}
                  >
                    <TextField
                      label="CC"
                      value=""
                      disabled
                      fullWidth
                    />
                    <TextField
                      label="Slot"
                      value=""
                      disabled
                      fullWidth
                    />
                    <TextField
                      label="Group ID"
                      value=""
                      disabled
                      fullWidth
                    />
                  </Box>

                  <TextField
                    label="Channel"
                    value=""
                    disabled
                    fullWidth
                  />
                </Stack>
              </NetworkFreqSectionCard>
              <FormControl fullWidth disabled={saving}>
                <InputLabel id="network-freq-create-encryption-type-label" shrink>
                  Шифрування
                </InputLabel>
                <Select
                  labelId="network-freq-create-encryption-type-label"
                  label="Шифрування"
                  value={form.encryptionType}
                  onChange={(event) => onChange({ ...form, encryptionType: String(event.target.value) as NetworkFreqCreateWizardForm['encryptionType'] })}
                  MenuProps={NEO_SELECT_MENU_PROPS}
                >
                  {NETWORK_ENCRYPTION_TYPE_OPTIONS.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <NetworkFreqKeysSection
                canManageKeys={canManageKeys}
                saving={saving}
                networkId={networkId}
                keysLoading={keysLoading}
                keysError={keysError}
                keys={keys}
                selectedKeys={selectedKeys}
                onSelectedKeysChange={handleSelectedKeysChange}
                onAddNewKey={() => setNewKeyOpen(true)}
                formatKeyLabel={formatKeyLabel}
              />
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 3 }}>
        {step === 2 ? (
          <Button onClick={() => onStepChange(1)} disabled={saving}>
            Назад
          </Button>
        ) : null}
        <Button onClick={handleClose} disabled={saving || newKeySaving}>
          Скасувати
        </Button>
        {step === 1 ? (
          <Button onClick={() => onStepChange(2)} variant="outlined" disabled={saveDisabled}>
            Далі
          </Button>
        ) : null}
        <Button onClick={handleSave} variant="contained" disabled={saveDisabled}>
          {saving ? <CircularProgress size={16} color="inherit" /> : 'Зберегти'}
        </Button>
      </DialogActions>

      <Dialog open={newKeyOpen} onClose={newKeySaving ? undefined : () => setNewKeyOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Новий ключ</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              label="Ключ"
              value={newKeyForm.key}
              onChange={(event) => setNewKeyForm((current) => ({ ...current, key: event.target.value }))}
              disabled={newKeySaving}
              fullWidth
            />
            <TextField
              label="Опис"
              value={newKeyForm.description}
              onChange={(event) => setNewKeyForm((current) => ({ ...current, description: event.target.value }))}
              disabled={newKeySaving}
              fullWidth
            />
            <FormControl fullWidth disabled={newKeySaving}>
              <InputLabel id="network-freq-new-key-modulation-label">Модуляція</InputLabel>
              <Select
                labelId="network-freq-new-key-modulation-label"
                label="Модуляція"
                value={newKeyForm.modulationId === null ? '' : String(newKeyForm.modulationId)}
                onChange={(event) => {
                  const value = event.target.value.trim();
                  setNewKeyForm((current) => ({ ...current, modulationId: value === '' ? null : Number(value) }));
                }}
                MenuProps={NEO_SELECT_MENU_PROPS}
              >
                <MenuItem value="">
                  <em>Не вибрано</em>
                </MenuItem>
                {modulationItems}
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3 }}>
          <Button onClick={() => setNewKeyOpen(false)} disabled={newKeySaving}>
            Скасувати
          </Button>
          <Button onClick={handleCreateKey} variant="contained" disabled={newKeySaving || newKeyForm.key.trim() === ''}>
            {newKeySaving ? <CircularProgress size={16} color="inherit" /> : 'Створити'}
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}

export const NetworkFreqCreateWizard = memo(NetworkFreqCreateWizardComponent);
