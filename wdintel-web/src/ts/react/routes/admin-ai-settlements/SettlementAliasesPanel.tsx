import AddIcon from '@mui/icons-material/Add';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';

import type { SettlementAliasItem } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { deleteSettlementAlias, listSettlementAliases } from '../../services/api/ai-settlements';
import { SettlementAliasDialog } from './SettlementAliasDialog';
import { SettlementAliasesTable } from './SettlementAliasesTable';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SettlementAliasesPanel() {
  const [aliases, setAliases] = useState<SettlementAliasItem[]>([]);
  const [nextId, setNextId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ alias: SettlementAliasItem | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SettlementAliasItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    void load(null);
  }, []);

  async function load(afterId: string | null) {
    setLoading(true);
    setError(null);
    try {
      const page = await listSettlementAliases(afterId);
      setAliases((current) => {
        const items = new Map((afterId ? current : []).map((alias) => [alias.id, alias]));
        for (const alias of page.items) items.set(alias.id, alias);
        return Array.from(items.values());
      });
      setNextId(page.nextId);
    } catch (loadError) {
      const message = `Помилка завантаження синонімів: ${errorMessage(loadError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setLoading(false);
    }
  }

  function saved(alias: SettlementAliasItem) {
    setAliases((current) => [alias, ...current.filter((item) => item.id !== alias.id)]);
    setEditor(null);
    notify({ severity: 'success', message: 'Синонім збережено.' });
  }

  async function remove() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await deleteSettlementAlias(deleteTarget.id);
      setAliases((current) => current.filter((alias) => alias.id !== deleteTarget.id));
      setDeleteTarget(null);
      notify({ severity: 'success', message: 'Синонім видалено.' });
    } catch (deleteError) {
      notify({
        severity: 'error',
        message: `Помилка видалення синоніма: ${errorMessage(deleteError)}`,
      });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <Typography component="h2" variant="h6">
          Словник синонімів
        </Typography>
        <PowerButton
          variant="contained"
          startIcon={<AddIcon />}
          disabled={loading}
          onClick={() => setEditor({ alias: null })}
        >
          Add New
        </PowerButton>
      </div>
      {error ? (
        <PowerAlert severity="error">
          {error}
          <PowerButton disabled={loading} onClick={() => void load(nextId)}>
            Повторити
          </PowerButton>
        </PowerAlert>
      ) : null}
      <SettlementAliasesTable
        aliases={aliases}
        loading={loading}
        onEdit={(alias) => setEditor({ alias })}
        onDelete={setDeleteTarget}
      />
      {nextId ? (
        <PowerButton variant="outlined" disabled={loading} onClick={() => void load(nextId)}>
          Завантажити ще
        </PowerButton>
      ) : null}
      {editor ? (
        <SettlementAliasDialog
          alias={editor.alias}
          onClose={() => setEditor(null)}
          onSaved={saved}
        />
      ) : null}
      <Dialog open={deleteTarget !== null} onClose={() => !deleting && setDeleteTarget(null)}>
        <DialogTitle>Видалити синонім?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {deleteTarget?.text} — {deleteTarget?.settlement.name}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <PowerButton disabled={deleting} onClick={() => setDeleteTarget(null)}>
            Скасувати
          </PowerButton>
          <PowerButton
            variant="contained"
            color="error"
            disabled={deleting}
            onClick={() => void remove()}
          >
            Видалити
          </PowerButton>
        </DialogActions>
      </Dialog>
    </div>
  );
}
