import { Box, Button, CircularProgress, Drawer, Stack, Typography } from '@mui/material';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import type { EncryptionKeyData, EncryptionRec } from '../../../../../Bindings';
import { createKey, listKeys } from '../../../services/api/networks';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';
import { PowerAlert } from '../../../components/PowerAlert';
import {
  formatErrorMessage,
  getFrequencyFormatError,
  parseNetworkDetailsDateInput,
  type NetworkFreqCreateWizardForm,
} from '../use-rer-network-details-neo-page.shared';
import { NetworkFreqFormFields } from './NetworkFreqFormFields';
import { NetworkFreqKeysSection } from './NetworkFreqKeysSection';
import { NetworkFreqNewKeyDialog } from './NetworkFreqNewKeyDialog';
import { validateNetworkFreqNewKey } from '../network-freq-new-key';

type Props = {
  open: boolean;
  form: NetworkFreqCreateWizardForm;
  saving: boolean;
  error: string | null;
  networkId: number | null;
  canManageKeys: boolean;
  encryptions: EncryptionRec[];
  onClose: () => void;
  onChange: (next: NetworkFreqCreateWizardForm) => void;
  onSave: () => void;
  disableRestoreFocus?: boolean;
};

type NewKeyForm = {
  key: string;
  description: string;
  encryptionId: number | null;
};

function formatKeyLabel(key: EncryptionKeyData): string {
  const parts = [key.description?.trim(), key.key?.trim()].filter((value) => value && value !== '');
  if (parts.length === 0) {
    return `#${key.id ?? '—'}`;
  }

  return parts.join(' • ');
}

function buildSelectedKeys(keys: EncryptionKeyData[], selectedIds: number[]): EncryptionKeyData[] {
  const keysById = new Map(keys.map((key) => [key.id, key]));
  return selectedIds
    .map((keyId) => keysById.get(keyId))
    .filter((key): key is EncryptionKeyData => Boolean(key));
}

function NetworkFreqCreateDrawerComponent({
  open,
  form,
  saving,
  error,
  networkId,
  canManageKeys,
  encryptions,
  onClose,
  onChange,
  onSave,
  disableRestoreFocus = false,
}: Props) {
  const titleId = 'network-freq-create-drawer-title';
  const [keys, setKeys] = useState<EncryptionKeyData[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [newKeyOpen, setNewKeyOpen] = useState(false);
  const [newKeySaving, setNewKeySaving] = useState(false);
  const [newKeyTouched, setNewKeyTouched] = useState(false);
  const [freqTouched, setFreqTouched] = useState(false);
  const [activeFromTouched, setActiveFromTouched] = useState(false);
  const [activeToTouched, setActiveToTouched] = useState(false);
  const addNewKeyButtonRef = useRef<HTMLButtonElement | null>(null);
  const [newKeyForm, setNewKeyForm] = useState<NewKeyForm>({
    key: '',
    description: '',
    encryptionId: null,
  });

  const selectedKeys = useMemo(
    () => buildSelectedKeys(keys, form.encryptionKeyIds),
    [form.encryptionKeyIds, keys],
  );
  const freqValidationError = getFrequencyFormatError(form.freq);
  const freqError = freqTouched ? freqValidationError : null;
  const newKeyValidationError = validateNetworkFreqNewKey(newKeyForm.key);
  const newKeyError = newKeyTouched ? newKeyValidationError : null;
  const newKeyCreateDisabled = newKeyValidationError !== null;
  const activeFromValidationError =
    parseNetworkDetailsDateInput(form.activeFrom) === null ? 'Потрібно вказати дату початку' : null;
  const activeToValidationError =
    form.activeTo.trim() !== '' && parseNetworkDetailsDateInput(form.activeTo) === null
      ? 'Потрібно вказати дату завершення'
      : null;
  const activeFromError = activeFromTouched ? activeFromValidationError : null;
  const activeToError = activeToTouched ? activeToValidationError : null;
  const isDmrModulation = form.modulation.toUpperCase().startsWith('DMR');
  const saveDisabled =
    saving ||
    (isDmrModulation && form.encryptionId === null) ||
    freqValidationError !== null ||
    activeFromValidationError !== null ||
    activeToValidationError !== null;

  const handleClose = () => {
    setFreqTouched(false);
    setActiveFromTouched(false);
    setActiveToTouched(false);
    setNewKeyTouched(false);
    onClose();
  };

  const handleSave = () => {
    setFreqTouched(false);
    setActiveFromTouched(false);
    setActiveToTouched(false);
    onSave();
  };

  const restoreAddNewKeyFocus = () => {
    const focusTrigger = () => addNewKeyButtonRef.current?.focus();
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(focusTrigger);
      return;
    }
    window.setTimeout(focusTrigger, 0);
  };

  const openNewKeyDialog = () => {
    addNewKeyButtonRef.current?.blur();
    setNewKeyOpen(true);
  };

  const closeNewKeyDialog = () => {
    (document.activeElement as HTMLElement | null)?.blur();
    setNewKeyOpen(false);
    setNewKeyTouched(false);
    setNewKeyForm({ key: '', description: '', encryptionId: null });
    restoreAddNewKeyFocus();
  };

  useEffect(() => {
    if (!open) return;
    setFreqTouched(false);
    setActiveFromTouched(false);
    setActiveToTouched(false);
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

  const handleSelectedKeysChange = (_event: unknown, next: EncryptionKeyData[]) => {
    onChange({
      ...form,
      encryptionKeyIds: next.flatMap((key) => (key.id === null ? [] : [key.id])),
    });
  };

  const handleCreateKey = async () => {
    if (!networkId || newKeySaving || newKeyValidationError !== null) {
      setNewKeyTouched(true);
      return;
    }

    setNewKeySaving(true);
    try {
      const createdKey = await createKey({
        sigintNetworkId: networkId,
        sigintNetworkFreqIds: [],
        key: newKeyForm.key.trim() === '' ? null : newKeyForm.key.trim(),
        keyHash: null,
        description: newKeyForm.description.trim() === '' ? null : newKeyForm.description.trim(),
        encryptionId: newKeyForm.encryptionId,
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

      closeNewKeyDialog();
      setNewKeyForm({ key: '', description: '', encryptionId: null });
    } catch (createError) {
      setKeysError(formatErrorMessage(createError));
    } finally {
      setNewKeySaving(false);
    }
  };

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={saving ? undefined : handleClose}
      ModalProps={{
        disableRestoreFocus,
        BackdropProps: {
          sx: (theme) => pageDrawerBackdropSx(theme),
        },
      }}
      slotProps={{
        paper: {
          'aria-labelledby': titleId,
          sx: {
            width: { xs: '100vw', sm: 720 },
            maxWidth: '100vw',
            display: 'flex',
            backgroundColor: 'background.default',
            backgroundImage: 'none',
          },
        },
      }}
    >
      <Box sx={{ p: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="h6" id={titleId}>
          Додати частоту
        </Typography>
      </Box>

      <Box sx={{ p: 2.5, flex: 1, overflowY: 'auto' }}>
        <Stack spacing={2.5}>
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}

          <NetworkFreqFormFields
            mode="create"
            saving={saving}
            modulation={form.modulation}
            encryptionId={form.encryptionId}
            activeFrom={form.activeFrom}
            activeTo={form.activeTo}
            freq={form.freq}
            freqError={freqError}
            activeFromError={activeFromError}
            activeToError={activeToError}
            onModulationChange={(modulation) =>
              onChange({ ...form, modulation: modulation as 'DMR' | 'NFM' | 'AM' | '' })
            }
            onEncryptionChange={(encryptionId) => onChange({ ...form, encryptionId })}
            onActiveFromChange={(nextValue) => onChange({ ...form, activeFrom: nextValue })}
            onActiveToChange={(nextValue) => onChange({ ...form, activeTo: nextValue })}
            onActiveFromBlur={() => setActiveFromTouched(true)}
            onActiveToBlur={() => setActiveToTouched(true)}
            onFreqChange={(nextValue) => onChange({ ...form, freq: nextValue })}
            onFreqBlur={() => setFreqTouched(true)}
            encryptions={encryptions}
            keysSection={
              <NetworkFreqKeysSection
                canManageKeys={canManageKeys}
                saving={saving}
                networkId={networkId}
                keysLoading={keysLoading}
                keysError={keysError}
                keys={keys}
                selectedKeys={selectedKeys}
                onSelectedKeysChange={handleSelectedKeysChange}
                onAddNewKey={openNewKeyDialog}
                addNewKeyButtonRef={addNewKeyButtonRef}
                formatKeyLabel={formatKeyLabel}
              />
            }
          />
        </Stack>
      </Box>

      <Box
        sx={{
          p: 2.5,
          borderTop: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 2,
        }}
      >
        <Button onClick={handleClose} disabled={saving || newKeySaving}>
          Скасувати
        </Button>
        <Button onClick={handleSave} variant="contained" disabled={saveDisabled}>
          {saving ? <CircularProgress size={16} color="inherit" /> : 'Зберегти'}
        </Button>
      </Box>

      <NetworkFreqNewKeyDialog
        open={newKeyOpen}
        title="Новий ключ"
        saving={newKeySaving}
        keyValue={newKeyForm.key}
        descriptionValue={newKeyForm.description}
        encryptionId={newKeyForm.encryptionId}
        encryptionOptions={encryptions}
        keyError={newKeyError}
        onClose={() => {
          closeNewKeyDialog();
        }}
        onKeyChange={(nextValue) => {
          setNewKeyForm((current) => ({ ...current, key: nextValue }));
        }}
        onKeyBlur={() => setNewKeyTouched(true)}
        onDescriptionChange={(nextValue) =>
          setNewKeyForm((current) => ({ ...current, description: nextValue }))
        }
        onEncryptionChange={(nextValue) =>
          setNewKeyForm((current) => ({ ...current, encryptionId: nextValue }))
        }
        onCreate={handleCreateKey}
        createDisabled={newKeyCreateDisabled}
        disableRestoreFocus
      />
    </Drawer>
  );
}

export const NetworkFreqCreateDrawer = memo(NetworkFreqCreateDrawerComponent);
