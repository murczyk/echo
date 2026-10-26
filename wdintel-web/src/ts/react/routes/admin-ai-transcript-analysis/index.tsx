import { useState } from 'react';
import {
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Tab,
  Tabs,
} from '@mui/material';
import type { AiTranscriptTestMessage } from '../../../../Bindings';
import { PageHeader } from '../../components/PageHeader';
import { PageLoadingState } from '../../components/PageLoadingState';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { SidePanelToggleButton } from '../../components/SidePanelToggleButton';
import { MessageEditor } from './MessageEditor';
import { PromptPanel } from './PromptPanel';
import { ResultsTable } from './ResultsTable';
import { QueueTab } from './QueueTab';
import { WorkerSettings } from './WorkerSettings';
import { useTranscriptAnalysis } from './use-transcript-analysis';

enum Panel {
  Prompt = 'prompt',
  Worker = 'worker',
  Queue = 'queue',
}

export function AdminAiTranscriptAnalysisPage() {
  const state = useTranscriptAnalysis();
  const [panel, setPanel] = useState(Panel.Prompt);
  const [promptPanelOpen, setPromptPanelOpen] = useState(true);
  const [editor, setEditor] = useState<{ id: string | null; text: string } | null>(null);
  const [deleting, setDeleting] = useState<AiTranscriptTestMessage | null>(null);
  const { page, disabled } = state;

  if (state.loading) return <PageLoadingState />;
  if (editor) {
    return (
      <MessageEditor
        id={editor.id}
        text={editor.text}
        disabled={disabled}
        error={state.error}
        onChange={(text) => setEditor({ ...editor, text })}
        onBack={() => setEditor(null)}
        onSave={() => void state.saveMessage(editor.id, editor.text, () => setEditor(null))}
      />
    );
  }

  return (
    <section className="flex flex-col gap-echo-lg">
      <PageHeader
        title="Аналіз транскрипцій"
        titleActions={
          <Tabs
            value={panel}
            onChange={(_, value: Panel) => setPanel(value)}
            aria-label="Налаштування аналізу транскрипцій"
          >
            <Tab
              value={Panel.Prompt}
              label="Промпт"
              id="transcript-analysis-tab-prompt"
              aria-controls="transcript-analysis-panel-prompt"
            />
            <Tab
              value={Panel.Worker}
              label="Воркер"
              id="transcript-analysis-tab-worker"
              aria-controls="transcript-analysis-panel-worker"
            />
            <Tab
              value={Panel.Queue}
              label="Черга"
              id="transcript-analysis-tab-queue"
              aria-controls="transcript-analysis-panel-queue"
            />
          </Tabs>
        }
        titleActionsGap={2}
        actions={
          panel === Panel.Prompt ? (
            <SidePanelToggleButton
              side="right"
              active={promptPanelOpen}
              label={promptPanelOpen ? 'Згорнути праву панель' : 'Розгорнути праву панель'}
              onClick={() => setPromptPanelOpen((open) => !open)}
            />
          ) : null
        }
      />
      {state.error && <PowerAlert severity="error">{state.error}</PowerAlert>}
      {page && (
        <div className="flex items-stretch gap-echo-lg">
          <div className="min-w-0 flex-1">
            <div
              id="transcript-analysis-panel-prompt"
              role="tabpanel"
              aria-labelledby="transcript-analysis-tab-prompt"
              hidden={panel !== Panel.Prompt}
            >
              {panel === Panel.Prompt && (
                <ResultsTable
                  page={{
                    ...page,
                    engines: page.engines.filter((engine) => state.selected.includes(engine.id)),
                  }}
                  results={state.results?.results ?? []}
                  disabled={disabled}
                  onCreate={() => setEditor({ id: null, text: '' })}
                  onEdit={(message) => setEditor({ id: message.id, text: message.message })}
                  onDelete={setDeleting}
                />
              )}
            </div>
            <div
              id="transcript-analysis-panel-worker"
              role="tabpanel"
              aria-labelledby="transcript-analysis-tab-worker"
              hidden={panel !== Panel.Worker}
            >
              {panel === Panel.Worker && <WorkerSettings state={state} />}
            </div>
            <div
              id="transcript-analysis-panel-queue"
              role="tabpanel"
              aria-labelledby="transcript-analysis-tab-queue"
              hidden={panel !== Panel.Queue}
            >
              {panel === Panel.Queue && <QueueTab />}
            </div>
          </div>
          {panel === Panel.Prompt && promptPanelOpen && <PromptPanel state={state} />}
        </div>
      )}
      <Dialog open={deleting !== null} onClose={() => !disabled && setDeleting(null)}>
        <DialogTitle>Видалити тестове повідомлення?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Повідомлення і всі збережені результати його аналізу будуть видалені.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <PowerButton variant="outlined" disabled={disabled} onClick={() => setDeleting(null)}>
            Скасувати
          </PowerButton>
          <PowerButton
            variant="contained"
            color="error"
            disabled={disabled}
            startIcon={disabled ? <CircularProgress size={18} /> : undefined}
            onClick={() => {
              if (deleting) void state.deleteMessage(deleting, () => setDeleting(null));
            }}
          >
            Видалити
          </PowerButton>
        </DialogActions>
      </Dialog>
    </section>
  );
}
