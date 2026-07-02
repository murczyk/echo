import { Box, Button, CircularProgress, Drawer, Stack, Typography } from '@mui/material';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import type { EncryptionKeyData, EncryptionRec, NetworkFreqsRes } from '../../../../../Bindings';
import { createKey, listKeys } from '../../../services/api/networks';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';
import { PowerAlert } from '../../../components/PowerAlert';
import {
  formatErrorMessage,
  type NetworkFreqEditForm,
  parseNetworkDetailsDateInput,
} from '../use-rer-network-details-neo-page.shared';
import { NetworkFreqFormFields } from './NetworkFreqFormFields';
import { NetworkFreqKeysSection } from './NetworkFreqKeysSection';
import { NetworkFreqNewKeyDialog } from './NetworkFreqNewKeyDialog';
import { validateNetworkFreqNewKey } from '../network-freq-new-key';

type Props = {
  open: boolean;
  form: NetworkFreqEditForm | null;
  saving: boolean;
  error: string | null;
  networkId: number | null;
  encryptions: EncryptionRec[];
  onClose: () => void;
  onChange: (next: NetworkFreqEditForm | null) => void;
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

function NetworkFreqEditDrawerComponent({
  open,
  form,
  saving,
  error,
  networkId,
  encryptions,
  onClose,
  onChange,
  onSave,
  disableRestoreFocus = false,
}: Props) {
  const titleId = 'network-freq-edit-drawer-title';
  const [keys, setKeys] = useState<EncryptionKeyData[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [newKeyOpen, setNewKeyOpen] = useState(false);
  const [newKeySaving, setNewKeySaving] = useState(false);
  const [newKeyTouched, setNewKeyTouched] = useState(false);
  const [activePeriodTouched, setActivePeriodTouched] = useState(false);
  const addNewKeyButtonRef = useRef<HTMLButtonElement | null>(null);
  const [newKeyForm, setNewKeyForm] = useState<NewKeyForm>({
    key: '',
    description: '',
    encryptionId: null,
  });

  const selectedKeys = useMemo(
    () => (form ? buildSelectedKeys(keys, form.encryptionKeyIds) : []),
    [form, keys],
  );
  const newKeyValidationError = validateNetworkFreqNewKey(newKeyForm.key);
  const newKeyError = newKeyTouched ? newKeyValidationError : null;
  const activeFromValidationError =
    form && parseNetworkDetailsDateInput(form.activeFrom) === null
      ? 'Потрібно вказати дату початку'
      : null;
  const activeToValidationError =
    form && form.activeTo.trim() !== '' && parseNetworkDetailsDateInput(form.activeTo) === null
      ? 'Потрібно вказати дату завершення'
      : null;
  const activeFromError = activePeriodTouched ? activeFromValidationError : null;
  const activeToError = activePeriodTouched ? activeToValidationError : null;
  const saveDisabled =
    saving || !form || activeFromValidationError !== null || activeToValidationError !== null;

  useEffect(() => {
    if (!open) return;
    setActivePeriodTouched(false);
  }, [open, form?.networkFreqId]);

  useEffect(() => {
    if (!open || !networkId) return;

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
  }, [networkId, open]);

  const handleSelectedKeysChange = (_event: unknown, next: EncryptionKeyData[]) => {
    if (!form) return;
    onChange({
      ...form,
      encryptionKeyIds: next.flatMap((key) => (key.id === null ? [] : [key.id])),
    });
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

  const handleCreateKey = async () => {
    if (!form || !networkId || newKeySaving || newKeyValidationError !== null) {
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

  const handleSave = () => {
    setActivePeriodTouched(true);
    if (activeFromValidationError !== null || activeToValidationError !== null) {
      return;
    }
    onSave();
  };

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={saving ? undefined : onClose}
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
          Редагувати частоту
        </Typography>
      </Box>

      <Box sx={{ p: 2.5, flex: 1, overflowY: 'auto' }}>
        <Stack spacing={2.5}>
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}

          {form ? (
            <NetworkFreqFormFields
              mode="edit"
              saving={saving}
              modulation={form.modulation}
              encryptionId={form.encryptionId}
              freq={form.freq}
              activeFrom={form.activeFrom}
              activeTo={form.activeTo}
              activeFromError={activeFromError}
              activeToError={activeToError}
              onModulationChange={(nextModulation) =>
                onChange({ ...form, modulation: nextModulation as 'DMR' | 'NFM' | 'AM' | '' })
              }
              onEncryptionChange={(encryptionId) => onChange({ ...form, encryptionId })}
              onActiveFromChange={(nextValue) => onChange({ ...form, activeFrom: nextValue })}
              onActiveToChange={(nextValue) => onChange({ ...form, activeTo: nextValue })}
              onActiveFromBlur={() => setActivePeriodTouched(true)}
              onActiveToBlur={() => setActivePeriodTouched(true)}
              encryptions={encryptions}
              keysSection={
                <NetworkFreqKeysSection
                  canManageKeys={Boolean(networkId)}
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
          ) : null}
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
        <Button onClick={onClose} disabled={saving || newKeySaving}>
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
        createDisabled={newKeyValidationError !== null}
        disableRestoreFocus
      />
    </Drawer>
  );
}

export const NetworkFreqEditDrawer = memo(NetworkFreqEditDrawerComponent);
