import { Dialog, DialogContent, DialogTitle, TextField } from '@mui/material';
import type { ReparseStatus } from '../../../../Bindings';
import { PowerButton } from '../../components/PowerButton';
import { useCallsignFeedback } from './useCallsignFeedback';
import {
  cancelCallsignReparse,
  getCallsignReparseFailures,
  retryCallsignReparse,
  startCallsignReparse,
} from '../../services/api/ai-callsigns';

const PAGE_SIZE = 100;
const runLabels: Record<string, string> = {
  enumerating: 'Пошук повідомлень',
  running: 'Обробка',
  completed: 'Завершено',
  failed: 'Завершено з помилками',
  cancelled: 'Скасовано',
};

function RunProgress({ run }: { run: ReparseStatus }) {
  const processed = run.changed + run.unchanged + run.skipped + run.failed;
  const seconds = Math.max(1, ((run.completedAt ?? Date.now()) - run.createdAt) / 1000);
  const rate = processed / seconds;
  const remaining =
    rate > 0 && run.state === 'running' ? Math.ceil((run.total - processed) / rate / 60) : null;
  return (
    <div className="flex flex-col gap-echo-sm">
      <span>
        {run.automatic ? 'Автоматичний' : 'Ручний'} · {runLabels[run.state] ?? run.state}
      </span>
      <span>
        {new Date(run.sinceTs).toLocaleString('uk-UA')} —{' '}
        {new Date(run.untilTs).toLocaleString('uk-UA')}
      </span>
      <span>
        Знайдено: {run.total}; оброблено: {processed}; змінено: {run.changed}; без змін:{' '}
        {run.unchanged}; пропущено: {run.skipped}; помилок: {run.failed}
      </span>
      <span>
        {(rate * 60).toFixed(1)} повідомлень/хв
        {remaining !== null ? `; залишилось приблизно ${remaining} хв` : ''}
      </span>
    </div>
  );
}

type FeedbackState = ReturnType<typeof useCallsignFeedback>;

function ReparseControls({ feedback, enabled }: { feedback: FeedbackState; enabled: boolean }) {
  const { days, setDays, validDays, busy, active, perform } = feedback;
  return (
    <>
      {!enabled && <p role="status">Увімкніть ШІ-воркер, щоб запустити обробку.</p>}
      <div className="flex flex-wrap items-center gap-echo-sm">
        <TextField
          label="Кількість днів"
          value={days}
          type="number"
          onChange={(event) => setDays(event.target.value)}
          error={!validDays}
          inputProps={{ min: 1, step: 1 }}
        />
        <PowerButton
          disabled={!enabled || !validDays || active || busy}
          onClick={() => void perform(() => startCallsignReparse({ days: Number(days) }))}
        >
          Запустити обробку
        </PowerButton>
      </div>
    </>
  );
}

function RunHistory({ feedback, enabled }: { feedback: FeedbackState; enabled: boolean }) {
  const { runs, busy, active, perform, setFailures, fail } = feedback;
  return (
    <>
      {runs.slice(0, 10).map((run) => (
        <article
          key={run.id}
          className="flex flex-col gap-echo-sm rounded-echo-md border border-echo-divider p-echo-md"
        >
          <RunProgress run={run} />
          <div className="flex gap-echo-sm">
            {(run.state === 'running' || run.state === 'enumerating') && (
              <PowerButton
                disabled={busy}
                onClick={() => void perform(() => cancelCallsignReparse({ id: run.id }))}
              >
                Скасувати
              </PowerButton>
            )}
            {(run.state === 'failed' || run.state === 'cancelled') && (
              <PowerButton
                disabled={busy || active || !enabled}
                onClick={() => void perform(() => retryCallsignReparse({ id: run.id }))}
              >
                Повторити незавершене
              </PowerButton>
            )}
            {run.failed > 0 && (
              <PowerButton
                onClick={() =>
                  void getCallsignReparseFailures({ id: run.id }).then(setFailures).catch(fail)
                }
              >
                Показати помилки
              </PowerButton>
            )}
          </div>
        </article>
      ))}
    </>
  );
}

function FeedbackTable({ feedback }: { feedback: FeedbackState }) {
  const {
    search,
    setSearch,
    after,
    setAfter,
    loading,
    rows,
    setSelected,
    setBeforeId,
    setDetails,
  } = feedback;
  return (
    <>
      <TextField
        label="Позивний (початок назви)"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setAfter('');
        }}
      />
      <div className="overflow-x-auto" aria-busy={loading}>
        <table className="w-full text-left">
          <thead>
            <tr>
              <th>Позивний</th>
              <th>Видалень</th>
              <th>Останній відгук</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.callsign}>
                <td>
                  <PowerButton
                    onClick={() => {
                      setSelected(row.callsign);
                      setBeforeId(null);
                      setDetails([]);
                    }}
                  >
                    {row.callsign}
                  </PowerButton>
                </td>
                <td>{row.removalCount}</td>
                <td>{new Date(row.updatedAt).toLocaleString('uk-UA')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && <p>Відгуків немає.</p>}
      </div>
      <div className="flex gap-echo-sm">
        <PowerButton disabled={!after || loading} onClick={() => setAfter('')}>
          На початок
        </PowerButton>
        <PowerButton
          disabled={rows.length < PAGE_SIZE || loading}
          onClick={() => setAfter(rows[rows.length - 1].callsign)}
        >
          Далі
        </PowerButton>
      </div>
    </>
  );
}

function FeedbackDetails({ feedback }: { feedback: FeedbackState }) {
  const { selected, setSelected, details, setBeforeId, openMessage } = feedback;
  return (
    <>
      <Dialog open={selected !== null} onClose={() => setSelected(null)} fullWidth maxWidth="md">
        <DialogTitle>Видалення: {selected}</DialogTitle>
        <DialogContent>
          {details.map((entry) => (
            <article key={entry.id} className="mb-echo-lg">
              <p>
                {entry.actor ?? 'Видалений користувач'} ·{' '}
                {new Date(entry.createdAt).toLocaleString('uk-UA')}
              </p>
              {entry.inboxItemId !== null && (
                <PowerButton onClick={() => void openMessage(entry.inboxItemId!)}>
                  Відкрити повідомлення #{entry.inboxItemId}
                </PowerButton>
              )}
              <pre className="whitespace-pre-wrap break-words">{entry.body}</pre>
            </article>
          ))}
          <PowerButton
            disabled={details.length < PAGE_SIZE}
            onClick={() => setBeforeId(details[details.length - 1].id)}
          >
            Далі
          </PowerButton>
          <PowerButton onClick={() => setSelected(null)}>Закрити</PowerButton>
        </DialogContent>
      </Dialog>
    </>
  );
}

function MessagePreview({ feedback }: { feedback: FeedbackState }) {
  const { currentMessage, setCurrentMessage } = feedback;
  return (
    <>
      <Dialog
        open={currentMessage !== null}
        onClose={() => setCurrentMessage(null)}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>Повідомлення #{currentMessage?.[0]}</DialogTitle>
        <DialogContent>
          <pre className="whitespace-pre-wrap break-words">{currentMessage?.[1].text}</pre>
          <p>Позивні: {currentMessage?.[1].callsigns?.join(', ')}</p>
          <PowerButton onClick={() => setCurrentMessage(null)}>Закрити</PowerButton>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReparseFailures({ feedback }: { feedback: FeedbackState }) {
  const { failures, setFailures } = feedback;
  return (
    <>
      <Dialog open={failures !== null} onClose={() => setFailures(null)} fullWidth maxWidth="md">
        <DialogTitle>Помилки обробки</DialogTitle>
        <DialogContent>
          {failures?.map((failure) => (
            <p key={failure.inboxItemId}>
              #{failure.inboxItemId}: {failure.lastError} (спроб: {failure.attempts})
            </p>
          ))}
          <PowerButton onClick={() => setFailures(null)}>Закрити</PowerButton>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AiCallsignFeedback({ enabled }: { enabled: boolean }) {
  const feedback = useCallsignFeedback();
  return (
    <section className="flex flex-col gap-echo-lg" aria-label="Зворотний зв’язок щодо позивних">
      <p>
        Автоматична обробка нового зворотного зв’язку — щогодини за останні 14 днів. Ручний запуск
        враховує всі позивні зі скаргами. Обробляються також перевірені повідомлення; ручні зміни
        зберігаються.
      </p>
      <ReparseControls feedback={feedback} enabled={enabled} />
      <RunHistory feedback={feedback} enabled={enabled} />
      <FeedbackTable feedback={feedback} />
      <FeedbackDetails feedback={feedback} />
      <MessagePreview feedback={feedback} />
      <ReparseFailures feedback={feedback} />
    </section>
  );
}
