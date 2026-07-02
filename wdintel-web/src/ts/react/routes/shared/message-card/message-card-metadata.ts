import type { InboxMessage, InboxMessageMetadata } from '../../../../../Bindings';

export type DmrMetadataRow = {
  label: string;
  value: string;
};

function normalizeText(value: string | null | undefined): string | null {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

function collectValues(
  metadata: InboxMessageMetadata[],
  selector: (metadata: InboxMessageMetadata) => string | null | undefined,
): string[] {
  const values: string[] = [];
  for (const item of metadata) {
    const value = normalizeText(selector(item));
    if (value == null || values.includes(value)) continue;
    values.push(value);
  }
  return values;
}

function joinParts(parts: string[]): string | null {
  const values = parts
    .map((part) => normalizeText(part))
    .filter((part): part is string => part != null);
  return values.length > 0 ? values.join(' / ') : null;
}

function appendRow(rows: DmrMetadataRow[], label: string, value: string | null): void {
  if (value == null) return;
  rows.push({ label, value });
}

export function buildDmrMetadataRows(msg: InboxMessage): DmrMetadataRow[] {
  const metadata = Array.isArray(msg.metadata) ? msg.metadata : [];
  const rows: DmrMetadataRow[] = [];

  appendRow(rows, 'CC', collectValues(metadata, (item) => item.colorCode).join(', ') || null);

  const senderId = collectValues(metadata, (item) => item.senderId).join(', ');
  const senderName = collectValues(metadata, (item) => item.senderName).join(', ');
  appendRow(rows, 'Відправник', joinParts([senderId, senderName]));

  const callGroupId = collectValues(metadata, (item) => item.callGroupId).join(', ');
  const callGroupName = collectValues(metadata, (item) => item.callGroupName).join(', ');
  appendRow(rows, 'Група', joinParts([callGroupId, callGroupName]));

  appendRow(rows, 'Хеш', collectValues(metadata, (item) => item.hashId).join(', ') || null);

  return rows;
}

export function hasVisibleDmrMetadata(msg: InboxMessage): boolean {
  return buildDmrMetadataRows(msg).length > 0;
}
