import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Drawer,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { memo, useEffect, useMemo, useState } from 'react';

import type { EncryptionKeyData, ModulationRec, NetworkFreqsRes } from '../../../../../Bindings';
import { createKey, listKeys } from '../../../services/api/networks';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';
import { PowerAlert } from '../../../components/PowerAlert';
import { formatErrorMessage, type NetworkFreqTechDataForm } from '../use-rer-network-details-neo-page.shared';
import { NetworkFreqKeysSection } from './NetworkFreqKeysSection';
import { NetworkFreqSectionCard } from './NetworkFreqSectionCard';
import { NetworkFreqSummaryHeader } from './NetworkFreqSummaryHeader';

type Props = {
  open: boolean;
  networkId: number | null;
  freq: NetworkFreqsRes | null;
  form: NetworkFreqTechDataForm | null;
  saving: boolean;
  error: string | null;
  canManageKeys: boolean;
  modulations: ModulationRec[];
  onClose: () => void;
  onChange: (next: NetworkFreqTechDataForm | null) => void;
  onSave: () => void;
  onReloadFrequencies: () => void;
};

type NewKeyForm = {
  key: string;
  description: string;
  modulationId: number | null;
};

type TechForm = {
  rx: string;
  tx: string;
  cc: string;
  slot: string;
  groupId: string;
  channel: string;
  encryptionType: 'none' | 'ARC40' | 'AES256' | 'VEDA';
};

const DISABLED_TECH_HELPER = 'Поки що не підтримується';

const DEFAULT_TECH_FORM: TechForm = {
  rx: '',
  tx: '',
  cc: '',
  slot: '',
  groupId: '',
  channel: '',
  encryptionType: 'none',
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
  return selectedIds.map((keyId) => keysById.get(keyId)).filter((key): key is EncryptionKeyData => Boolean(key));
}

function NetworkFreqTechDataDrawerComponent({
  open,
  networkId,
  freq,
  form,
  saving,
  error,
  canManageKeys,
  modulations,
  onClose,
  onChange,
  onSave,
  onReloadFrequencies,
}: Props) {
  const titleId = 'network-freq-tech-drawer-title';
  const formBlocked = saving;
  const [keys, setKeys] = useState<EncryptionKeyData[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [newKeyOpen, setNewKeyOpen] = useState(false);
  const [newKeySaving, setNewKeySaving] = useState(false);
  const [newKeyForm, setNewKeyForm] = useState<NewKeyForm>({
    key: '',
    description: '',
    modulationId: null,
  });
  const [techForm, setTechForm] = useState<TechForm>(DEFAULT_TECH_FORM);

  const modulationItems = useMemo(
    () =>
      modulations.map((modulation) => (
        <MenuItem key={modulation.id} value={String(modulation.id)}>
          {modulation.name}
        </MenuItem>
      )),
    [modulations],
  );

  const selectedKeys = useMemo(() => (form ? buildSelectedKeys(keys, form.encryptionKeyIds) : []), [form, keys]);

  useEffect(() => {
    if (!open) return;
    setTechForm(DEFAULT_TECH_FORM);
  }, [open]);

  useEffect(() => {
    if (!open || !networkId || !canManageKeys) return;

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
    if (!form) return;
    onChange({ ...form, encryptionKeyIds: next.flatMap((key) => (key.id === null ? [] : [key.id])) });
  };

  const handleCreateKey = async () => {
    if (!form || !networkId || newKeySaving) return;

    setNewKeySaving(true);
    try {
      const createdKey = await createKey({
        sigintNetworkId: networkId,
        sigintNetworkFreqIds: [form.networkFreqId],
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
      onReloadFrequencies();
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
      onClose={saving ? undefined : onClose}
      ModalProps={{
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
          Редагувати тех. дані
        </Typography>
      </Box>

      <NetworkFreqSummaryHeader freq={freq} />

      <Box sx={{ p: 2.5, flex: 1, overflowY: 'auto' }}>
        <Stack spacing={2.5}>
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}

          {form ? (
            <NetworkFreqSectionCard title="DMR" muted hint={DISABLED_TECH_HELPER}>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
                <TextField
                  label="Rx"
                  value={techForm.rx}
                  onChange={(event) => setTechForm((current) => ({ ...current, rx: event.target.value }))}
                  disabled
                  fullWidth
                />
                <TextField
                  label="Tx"
                  value={techForm.tx}
                  onChange={(event) => setTechForm((current) => ({ ...current, tx: event.target.value }))}
                  disabled
                  fullWidth
                />
              </Box>

              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' }, gap: 2 }}>
                <TextField
                  label="CC"
                  value={techForm.cc}
                  onChange={(event) => setTechForm((current) => ({ ...current, cc: event.target.value }))}
                  disabled
                  fullWidth
                />
                <TextField
                  label="Slot"
                  value={techForm.slot}
                  onChange={(event) => setTechForm((current) => ({ ...current, slot: event.target.value }))}
                  disabled
                  fullWidth
                />
                <TextField
                  label="Group ID"
                  value={techForm.groupId}
                  onChange={(event) => setTechForm((current) => ({ ...current, groupId: event.target.value }))}
                  disabled
                  fullWidth
                />
              </Box>

              <TextField
                label="Channel"
                value={techForm.channel}
                onChange={(event) => setTechForm((current) => ({ ...current, channel: event.target.value }))}
                disabled
                fullWidth
              />
            </NetworkFreqSectionCard>
          ) : null}

          {form ? (
            <>
              <FormControl fullWidth disabled={formBlocked}>
                <InputLabel id="network-freq-tech-encryption-type-label" shrink>
                  Тип шифрування
                </InputLabel>
                <Select
                  labelId="network-freq-tech-encryption-type-label"
                  label="Тип шифрування"
                  value={techForm.encryptionType}
                  onChange={(event) =>
                    setTechForm((current) => ({ ...current, encryptionType: String(event.target.value) as TechForm['encryptionType'] }))
                  }
                >
                  <MenuItem value="none">Без шифрування</MenuItem>
                  <MenuItem value="ARC40">ARC40</MenuItem>
                  <MenuItem value="AES256">AES256</MenuItem>
                  <MenuItem value="VEDA">VEDA</MenuItem>
                </Select>
              </FormControl>

              <NetworkFreqKeysSection
                canManageKeys={canManageKeys}
                saving={formBlocked}
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
        <Button onClick={onSave} variant="contained" disabled={saving || !form}>
          {saving ? <CircularProgress size={16} color="inherit" /> : 'Зберегти'}
        </Button>
      </Box>

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
    </Drawer>
  );
}

export const NetworkFreqTechDataDrawer = memo(NetworkFreqTechDataDrawerComponent);
