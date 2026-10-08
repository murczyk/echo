import { useEffect, useState, useSyncExternalStore } from 'react';

import type { DebugRecorderSnapshot } from './types';

export type DebugRecorderPanelController = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => DebugRecorderSnapshot;
  finish: () => void;
  download: () => boolean;
};

type DebugRecorderPanelProps = {
  controller: DebugRecorderPanelController;
};

function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.min(60, Math.floor(milliseconds / 1_000)));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function DebugRecorderPanel({ controller }: DebugRecorderPanelProps) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (snapshot.state !== 'recording') return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [snapshot.state, snapshot.startedAt]);

  if (snapshot.state === 'idle') return null;

  const elapsed =
    snapshot.state === 'recording' && snapshot.startedAt !== null && snapshot.deadlineAt !== null
      ? Math.min(snapshot.deadlineAt - snapshot.startedAt, Math.max(0, now - snapshot.startedAt))
      : snapshot.elapsedMs;
  const finishAndDownload = () => {
    controller.finish();
    controller.download();
  };
  const issue = snapshot.downloadError
    ? {
        label: 'Помилка завантаження',
        description: 'Не вдалося завантажити файл. Спробуйте ще раз.',
      }
    : snapshot.persistenceFailed
      ? {
          label: 'Не збережено',
          description: 'Не вдалося зберегти запис у сесії браузера.',
        }
      : null;

  return (
    <section
      className="echo-debug-recorder-panel"
      data-debug-recorder-root=""
      style={{
        position: 'fixed',
        top: '8px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 2500,
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        width: 'max-content',
        maxWidth: 'calc(100vw - 16px)',
        boxSizing: 'border-box',
        padding: '4px',
        paddingInlineStart: '8px',
        borderRadius: 'var(--echo-radius-lg)',
        backgroundColor: 'var(--echo-color-surface-raised)',
        color: 'var(--echo-color-text)',
        boxShadow: 'var(--echo-shadow-md)',
        fontFamily: 'var(--echo-typography-font-family)',
        fontSize: 'var(--echo-typography-font-size-xs)',
        lineHeight: 1,
      }}
    >
      <style>{`
        .echo-debug-recorder-panel button {
          transition: filter 140ms ease-out;
        }
        .echo-debug-recorder-panel button:hover {
          filter: brightness(0.92);
        }
        .echo-debug-recorder-panel button:focus-visible {
          outline: 2px solid var(--echo-color-focus, #2c6c91) !important;
          outline-offset: 2px !important;
        }
        @media (min-width: 1024px) {
          [data-debug-recorder-slot] .echo-debug-recorder-panel {
            position: static !important;
            top: auto !important;
            left: auto !important;
            transform: none !important;
          }
        }
        @media (forced-colors: active) {
          .echo-debug-recorder-panel button:focus-visible {
            outline-color: Highlight !important;
          }
        }
      `}</style>
      <div
        role="status"
        aria-live="polite"
        aria-label={snapshot.state === 'recording' ? 'Запис діагностики' : 'Запис готовий'}
        style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}
      >
        <span
          aria-hidden="true"
          style={{
            width: '8px',
            height: '8px',
            flex: '0 0 auto',
            borderRadius: 'var(--echo-radius-pill)',
            background:
              snapshot.state === 'recording'
                ? 'var(--echo-color-error)'
                : 'var(--echo-color-success)',
          }}
        />
        <strong style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
          {snapshot.state === 'recording' ? 'Запис' : 'Готово'}
        </strong>
        {snapshot.state === 'recording' && (
          <time style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
            {formatTime(elapsed)}
          </time>
        )}
      </div>

      {issue && (
        <span
          role="alert"
          aria-label={issue.description}
          title={issue.description}
          style={{
            maxWidth: '112px',
            overflow: 'hidden',
            color: snapshot.downloadError ? 'var(--echo-color-error)' : 'var(--echo-color-warning)',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {issue.label}
        </span>
      )}

      <button
        type="button"
        onClick={snapshot.state === 'recording' ? finishAndDownload : controller.download}
        style={{
          minHeight: '28px',
          flex: '0 0 auto',
          padding: '4px 10px',
          border: 0,
          borderRadius: 'var(--echo-radius-md)',
          background:
            snapshot.state === 'recording'
              ? 'var(--echo-color-error)'
              : 'var(--echo-color-primary)',
          color:
            snapshot.state === 'recording' ? 'var(--bs-white)' : 'var(--echo-color-on-primary)',
          cursor: 'pointer',
          font: 'inherit',
          fontWeight: 600,
          lineHeight: 1,
          whiteSpace: 'nowrap',
        }}
      >
        {snapshot.state === 'recording'
          ? 'Завершити'
          : snapshot.downloadError
            ? 'Повторити'
            : 'Завантажити'}
      </button>
    </section>
  );
}
