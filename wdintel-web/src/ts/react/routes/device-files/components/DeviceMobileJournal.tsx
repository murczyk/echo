import type { DeviceFileJournalEntry } from '../../../../../Bindings';
import { DeviceAnalyticsTagBadges } from './DeviceAnalyticsTagBadges';
import { DeviceFileContentMarker } from './DeviceFileContentMarker';

export function DeviceMobileJournal({
  entries,
  formatSynchronizedAt,
}: {
  entries: DeviceFileJournalEntry[];
  formatSynchronizedAt: (value: string) => string;
}) {
  return (
    <ul
      aria-label="Журнал синхронізації файлів"
      className="m-0 list-none divide-y divide-echo-border p-0"
    >
      {entries.map((entry) => (
        <li
          key={entry.fileId}
          className="flex min-w-0 flex-col gap-echo-sm p-echo-lg [overflow-wrap:anywhere]"
        >
          <strong>{entry.name}</strong>
          <span className="text-[length:var(--echo-typography-font-size-xs)] text-echo-text/70">
            {entry.absolutePath}
          </span>
          <DeviceAnalyticsTagBadges tags={entry.tags} />
          <span className="flex items-center gap-echo-sm text-[length:var(--echo-typography-font-size-xs)]">
            <DeviceFileContentMarker hasContent={entry.hasContent} />
            {entry.hasContent ? 'Контент доступний' : 'Контент відсутній'}
          </span>
          <span className="text-[length:var(--echo-typography-font-size-xs)] text-echo-text/70">
            Синхронізовано: {formatSynchronizedAt(entry.synchronizedAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}
