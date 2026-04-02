import type { InboxMessage, Network, SignalProfileEntry, Unit } from '../../../../Bindings';
import { copyTextToClipboard } from '../../../copy-to-clipboard';
import { createMasterUnitText } from '../rer-duty-neo/utils';

export function buildSenderLabel(profile: SignalProfileEntry | null | undefined, fallback: string | null): string | null {
  const parts = [profile?.givenName, profile?.familyName].filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  return fallback;
}

export function buildNetworkDisplayMap(networks: Network[], unitsMap: Record<number, Unit>): Record<number, string> {
  const next: Record<number, string> = {};
  networks.forEach((network) => {
    next[network.id] = createMasterUnitText(network, unitsMap);
  });
  return next;
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
