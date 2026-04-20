import type { AnalysisStatsSender, InboxMessage, Network, SignalProfileEntry, Unit } from '../../../../Bindings';
import { copyTextToClipboard } from '../../../copy-to-clipboard';
import type { AnalysisFilterOption } from './types';
import { createMasterUnitText } from '../rer-duty-neo/utils';

export function buildSenderLabel(profile: SignalProfileEntry | null | undefined, fallback: string | null): string | null {
  const parts = [profile?.givenName, profile?.familyName].filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  return fallback;
}

function shortUuid(uuid: string): string {
  return uuid.slice(0, 8);
}

function senderDisplayName(profile: SignalProfileEntry | null | undefined, fallback: string): string {
  const label = buildSenderLabel(profile, fallback);
  return label == null || label.trim() === '' ? fallback : label.trim();
}

export function buildNetworkDisplayMap(networks: Network[], unitsMap: Record<number, Unit>): Record<number, string> {
  const next: Record<number, string> = {};
  networks.forEach((network) => {
    next[network.id] = createMasterUnitText(network, unitsMap);
  });
  return next;
}

export function buildSenderFilterOptions(
  senders: AnalysisStatsSender[],
  profiles: Record<string, SignalProfileEntry | null>,
): AnalysisFilterOption[] {
  const nameCounts = senders.reduce<Record<string, number>>((counts, sender) => {
    const name = senderDisplayName(profiles[sender.uuid], sender.uuid);
    counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  }, {});
  const duplicateNames = new Set(Object.entries(nameCounts).filter(([, count]) => count > 1).map(([name]) => name));

  return senders
    .map((sender) => {
      const displayName = senderDisplayName(profiles[sender.uuid], sender.uuid);
      const label = duplicateNames.has(displayName) ? `${displayName} [${shortUuid(sender.uuid)}]` : displayName;
      return {
        value: sender.uuid,
        label,
        count: sender.count,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function getMessageTagEnabled(message: InboxMessage, tagId: number): boolean {
  const inboxTags = message.inboxTags ?? [];
  if (inboxTags.length > 0) {
    return inboxTags.some((tag) => tag.tagId === tagId);
  }
  return (message.tags ?? []).includes(tagId);
}

export async function copyMessageValue(value: string | null | undefined): Promise<void> {
  await copyTextToClipboard(value ?? '');
}
