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

  return (
    <section
      className="echo-debug-recorder-panel"
      data-debug-recorder-root=""
      style={{
        position: 'fixed',
        top: 'calc(var(--app-shell-navbar-height, 58px) + 8px)',
        insetInlineEnd: '8px',
        zIndex: 2500,
        width: '360px',
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: 'calc(100vh - var(--app-shell-navbar-height, 58px) - 24px)',
        overflow: 'auto',
        boxSizing: 'border-box',
        padding: '12px',
        borderRadius: '12px',
        background: '#ffffff',
        color: '#0f172a',
        boxShadow: '0 12px 28px rgba(15, 23, 42, 0.2)',
        fontFamily: 'inherit',
      }}
    >
      <style>{`
        .echo-debug-recorder-panel button {
          transition: background-color 140ms ease-out, box-shadow 140ms ease-out;
        }
        .echo-debug-recorder-panel button:hover {
          filter: brightness(0.92);
        }
        .echo-debug-recorder-panel button:focus-visible {
          outline: 3px solid #60a5fa !important;
          outline-offset: 3px !important;
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
        style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}
      >
        <span
          aria-hidden="true"
          style={{
            width: '10px',
            height: '10px',
            flex: '0 0 auto',
            borderRadius: '999px',
            background: snapshot.state === 'recording' ? '#dc2626' : '#16a34a',
          }}
        />
        <strong>{snapshot.state === 'recording' ? 'Запис діагностики' : 'Запис готовий'}</strong>
        <span style={{ marginInlineStart: 'auto', fontVariantNumeric: 'tabular-nums' }}>
          {formatTime(elapsed)} / 01:00
        </span>
      </div>

      {snapshot.state === 'ready' && (
        <p style={{ margin: '8px 0 0', fontSize: '14px' }}>
          {snapshot.eventCount} подій · {snapshot.anomalyCount} аномалії · {snapshot.droppedEvents}{' '}
          пропущено
        </p>
      )}
      {snapshot.persistenceFailed && (
        <p style={{ margin: '8px 0 0', color: '#b45309', fontSize: '14px' }}>
          Не вдалося зберегти запис у сесії браузера.
        </p>
      )}
      {snapshot.downloadError && (
        <p style={{ margin: '8px 0 0', color: '#b91c1c', fontSize: '14px' }}>
          Не вдалося завантажити файл. Спробуйте ще раз.
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
        <button
          type="button"
          onClick={snapshot.state === 'recording' ? finishAndDownload : controller.download}
          style={{
            minHeight: '36px',
            maxWidth: '100%',
            padding: '7px 12px',
            border: 0,
            borderRadius: '7px',
            outline: '2px solid transparent',
            outlineOffset: '2px',
            background: snapshot.state === 'recording' ? '#b91c1c' : '#1d4ed8',
            color: '#ffffff',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          {snapshot.state === 'recording'
            ? 'Завершити'
            : snapshot.downloadError
              ? 'Повторити завантаження'
              : 'Завантажити'}
        </button>
      </div>
    </section>
  );
}
