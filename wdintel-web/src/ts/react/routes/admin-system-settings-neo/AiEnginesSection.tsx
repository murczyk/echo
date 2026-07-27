import {
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
} from '@mui/material';
import { useEffect, useState } from 'react';

import type { AiEngineItem } from '../../../../Bindings';
import { STANDARD_DIALOG_ACTIONS_SX } from '../../components/dialogStyles';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { deleteAiEngine, getAiEngine, listAiEngines } from '../../services/api/ai-engines';
import { AiEngineDetails } from './AiEngineDetails';
import { AiEngineEditor } from './AiEngineEditor';
import { AiEnginesTable } from './AiEnginesTable';
import { readAiEngineUrlScreen, returnToAiEngineList, updateAiEngineUrl } from './url-state';

type AiEngineScreen =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'details'; aiEngine: AiEngineItem }
  | { kind: 'edit'; aiEngine: AiEngineItem };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AiEnginesSection() {
  const [aiEngines, setAiEngines] = useState<AiEngineItem[]>([]);
  const [screen, setScreen] = useState<AiEngineScreen>({ kind: 'list' });
  const [deleteTarget, setDeleteTarget] = useState<AiEngineItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    void loadInitialScreen();

    const syncScreenFromHistory = () => {
      void syncScreenFromUrl();
    };
    window.addEventListener('popstate', syncScreenFromHistory);
    return () => {
      window.removeEventListener('popstate', syncScreenFromHistory);
    };
  }, []);

  async function loadInitialScreen() {
    setLoading(true);
    setError(null);
    try {
      setAiEngines(await listAiEngines());
    } catch (loadError) {
      setError(`Помилка завантаження ШІ движків: ${errorMessage(loadError)}`);
      setLoading(false);
      return;
    }
    await syncScreenFromUrl();
  }

  async function syncScreenFromUrl() {
    setLoading(true);
    setError(null);
    try {
      const requestedScreen = readAiEngineUrlScreen();
      if (requestedScreen.kind === 'list') {
        setScreen({ kind: 'list' });
        return;
      }
      const aiEngine = await getAiEngine(requestedScreen.aiEngineId);
      upsertAiEngine(aiEngine);
      setScreen({ kind: requestedScreen.kind, aiEngine });
    } catch (loadError) {
      setError(`Помилка завантаження ШІ движка: ${errorMessage(loadError)}`);
    } finally {
      setLoading(false);
    }
  }

  function upsertAiEngine(aiEngine: AiEngineItem) {
    setAiEngines((current) => {
      const next = current.some((item) => item.id === aiEngine.id)
        ? current.map((item) => (item.id === aiEngine.id ? aiEngine : item))
        : [...current, aiEngine];
      return next.sort((left, right) => left.name.localeCompare(right.name, 'uk'));
    });
  }

  async function openDetails(aiEngine: AiEngineItem) {
    setLoading(true);
    setError(null);
    try {
      const freshAiEngine = await getAiEngine(aiEngine.id);
      upsertAiEngine(freshAiEngine);
      updateAiEngineUrl(freshAiEngine.id, 'details', 'push');
      setScreen({ kind: 'details', aiEngine: freshAiEngine });
    } catch (loadError) {
      setError(`Помилка завантаження ШІ движка: ${errorMessage(loadError)}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteAiEngine(deleteTarget.id);
      setAiEngines((current) => current.filter((item) => item.id !== deleteTarget.id));
      const deletedCurrentScreen =
        (screen.kind === 'details' || screen.kind === 'edit') &&
        screen.aiEngine.id === deleteTarget.id;
      setScreen({ kind: 'list' });
      setDeleteTarget(null);
      if (deletedCurrentScreen) {
        returnToAiEngineList();
      }
      notify({ severity: 'success', message: 'ШІ движок видалено.' });
    } catch (deleteError) {
      setError(`Помилка видалення ШІ движка: ${errorMessage(deleteError)}`);
    } finally {
      setDeleting(false);
    }
  }

  function handleSaved(aiEngine: AiEngineItem) {
    upsertAiEngine(aiEngine);
    updateAiEngineUrl(aiEngine.id, 'details', screen.kind === 'create' ? 'push' : 'replace');
    setScreen({ kind: 'details', aiEngine });
    notify({ severity: 'success', message: 'ШІ движок збережено.' });
  }

  function openEdit(aiEngine: AiEngineItem, mode: 'push' | 'replace') {
    updateAiEngineUrl(aiEngine.id, 'edit', mode);
    setScreen({ kind: 'edit', aiEngine });
  }

  if (loading && aiEngines.length === 0) {
    return <CircularProgress />;
  }

  return (
    <Stack spacing={2}>
      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}

      {screen.kind === 'list' ? (
        <AiEnginesTable
          aiEngines={aiEngines}
          onCreate={() => setScreen({ kind: 'create' })}
          onView={(aiEngine) => void openDetails(aiEngine)}
          onEdit={(aiEngine) => openEdit(aiEngine, 'push')}
          onDelete={setDeleteTarget}
        />
      ) : null}

      {screen.kind === 'create' ? (
        <AiEngineEditor onBack={() => setScreen({ kind: 'list' })} onSaved={handleSaved} />
      ) : null}

      {screen.kind === 'edit' ? (
        <AiEngineEditor
          aiEngine={screen.aiEngine}
          onBack={returnToAiEngineList}
          onSaved={handleSaved}
        />
      ) : null}

      {screen.kind === 'details' ? (
        <AiEngineDetails
          aiEngine={screen.aiEngine}
          onBack={returnToAiEngineList}
          onEdit={() => openEdit(screen.aiEngine, 'replace')}
          onDelete={() => setDeleteTarget(screen.aiEngine)}
        />
      ) : null}

      <Dialog open={deleteTarget !== null} onClose={() => !deleting && setDeleteTarget(null)}>
        <DialogTitle>Видалити ШІ движок?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Движок «{deleteTarget?.name}» і вся історія його чатів будуть видалені.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
          <PowerButton type="button" variant="outlined" onClick={() => setDeleteTarget(null)}>
            Скасувати
          </PowerButton>
          <PowerButton
            type="button"
            variant="contained"
            color="error"
            disabled={deleting}
            onClick={() => void handleDelete()}
            startIcon={deleting ? <CircularProgress size={18} /> : undefined}
          >
            Видалити
          </PowerButton>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
