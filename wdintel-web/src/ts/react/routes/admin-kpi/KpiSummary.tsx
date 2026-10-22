import type { ReactNode } from 'react';

import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { formatSnapshotTime } from './helpers';
import type { Snapshot } from './use-kpi-data';

export function MetricCard({
  title,
  value,
  description,
}: {
  title: string;
  value: number;
  description: string;
}) {
  return (
    <section
      aria-label={title}
      className="min-w-0 rounded-echo-lg border border-echo-border bg-echo-surface p-echo-lg"
    >
      <h2 className="m-0 text-echo-base font-semibold">{title}</h2>
      <p className="my-echo-sm text-echo-lg font-bold tabular-nums" aria-label="Кількість">
        {value}
      </p>
      <p className="m-0 text-echo-sm">{description}</p>
    </section>
  );
}

export function SnapshotState<T>({
  snapshot,
  label,
  retry,
}: {
  snapshot: Snapshot<T>;
  label: string;
  retry: () => void;
}) {
  return (
    <div aria-live="polite" className="space-y-echo-sm">
      {snapshot.loading && <p role="status">Завантаження: {label}…</p>}
      {snapshot.error && (
        <PowerAlert severity="error" autoHideDuration={null} dismissible={false}>
          {snapshot.error}
          {snapshot.updatedAt !== null && <span> Показано попередні дані.</span>}
          <PowerButton onClick={retry}>Повторити: {label}</PowerButton>
        </PowerAlert>
      )}
      {snapshot.updatedAt !== null && (
        <p className="m-0 text-echo-sm">Оновлено: {formatSnapshotTime(snapshot.updatedAt)}</p>
      )}
    </div>
  );
}

export function KpiPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      className="min-w-0 space-y-echo-md rounded-echo-lg border border-echo-border bg-echo-surface p-echo-lg"
    >
      <h2 className="m-0 text-echo-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}
