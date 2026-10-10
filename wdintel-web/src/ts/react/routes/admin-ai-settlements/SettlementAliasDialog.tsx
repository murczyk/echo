import {
  Autocomplete,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
} from '@mui/material';
import { useEffect, useState } from 'react';

import type { SettlementAliasItem, SettlementAliasSettlement } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { saveSettlementAlias, searchAliasSettlements } from '../../services/api/ai-settlements';

function settlementLabel(settlement: SettlementAliasSettlement): string {
  return [settlement.name, settlement.district, settlement.region, `#${settlement.id}`]
    .filter(Boolean)
    .join(', ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SettlementAliasDialog({
  alias,
  onClose,
  onSaved,
}: {
  alias: SettlementAliasItem | null;
  onClose: () => void;
  onSaved: (alias: SettlementAliasItem) => void;
}) {
  const [settlement, setSettlement] = useState<SettlementAliasSettlement | null>(
    alias?.settlement ?? null,
  );
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<SettlementAliasSettlement[]>([]);
  const [text, setText] = useState(alias?.text ?? '');
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    setOptions([]);
    if (query.trim().length < 3) {
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const found = await searchAliasSettlements(query.trim(), { signal: controller.signal });
        if (!controller.signal.aborted) setOptions(found);
      } catch (searchError) {
        if (!controller.signal.aborted) {
          const message = `Помилка пошуку населених пунктів: ${errorMessage(searchError)}`;
          setError(message);
          notify({ severity: 'error', message });
        }
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, notify]);

  async function save() {
    if (!settlement || !text.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveSettlementAlias({
        id: alias?.id ?? null,
        settlementId: settlement.id,
        text: text.trim(),
      });
      onSaved(saved);
    } catch (saveError) {
      const message = `Помилка збереження синоніма: ${errorMessage(saveError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open fullWidth maxWidth="sm" onClose={() => !saving && onClose()}>
      <DialogTitle>{alias ? 'Редагувати синонім' : 'Новий синонім'}</DialogTitle>
      <DialogContent>
        <div className="flex flex-col gap-4 pt-2">
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
          <Autocomplete
            options={options}
            value={settlement}
            disabled={saving}
            loading={searching}
            filterOptions={(items) => items}
            getOptionLabel={settlementLabel}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            renderOption={(props, option) => (
              <li {...props} key={option.id}>
                {settlementLabel(option)}
              </li>
            )}
            onChange={(_, value) => setSettlement(value)}
            onInputChange={(_, value, reason) => {
              if (reason === 'input' || reason === 'clear') {
                setQuery(value);
                setError(null);
                setSettlement(null);
              }
            }}
            noOptionsText={
              query.trim().length < 3
                ? 'Введіть щонайменше 3 символи'
                : 'Населених пунктів не знайдено'
            }
            loadingText="Пошук…"
            renderInput={(params) => (
              <TextField
                {...params}
                autoFocus
                required
                label="Населений пункт"
                helperText="Введіть щонайменше 3 символи назви та виберіть населений пункт."
              />
            )}
          />
          <TextField
            required
            fullWidth
            label="Синонім"
            value={text}
            disabled={saving}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
      </DialogContent>
      <DialogActions>
        <PowerButton variant="outlined" disabled={saving} onClick={onClose}>
          Скасувати
        </PowerButton>
        <PowerButton
          variant="contained"
          disabled={saving || !settlement || !text.trim()}
          onClick={() => void save()}
          startIcon={saving ? <CircularProgress size={18} /> : undefined}
        >
          Зберегти
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}
