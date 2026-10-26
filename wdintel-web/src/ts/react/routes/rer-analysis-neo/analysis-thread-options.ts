import type { InboxMessagesRsp, Tag, Unit } from '../../../../Bindings';
import { getUnitIdFilterValue } from '../../utils/unit-search';
import { buildSenderFilterOptions } from './message-utils';
import type { AnalysisFilterOption, AnalysisFilterOptions } from './types';
import { emptyOptions, sortFilterOptionsByLabel } from './use-analysis-data.shared';

export function analysisThreadOptions(
  inbox: InboxMessagesRsp,
  tags: Record<number, Tag>,
  units: Record<number, Unit>,
): AnalysisFilterOptions {
  const counts = new Map<keyof AnalysisFilterOptions, Map<string, AnalysisFilterOption>>();
  const add = (section: keyof AnalysisFilterOptions, value: string | null, label = value) => {
    if (value == null || value === '') return;
    const options = counts.get(section) ?? new Map();
    counts.set(section, options);
    const existing = options.get(value);
    options.set(value, { value, label: label || value, count: (existing?.count ?? 0) + 1 });
  };
  const groups = new Map(inbox.signalGroups.map((group) => [group.masterKey, group]));
  for (const [, message] of inbox.inboxItems) {
    add('freqs', message.freq);
    add('senders', message.sender);
    add('devices', message.deviceName);
    add('locations', message.location);
    add('posts', message.post);
    for (const groupId of new Set(message.groupMasterKeys ?? [message.groupMasterKey])) {
      const group = groupId == null ? null : groups.get(groupId);
      add('groups', groupId, group?.name ?? groupId);
      for (const aor of group?.areasOfResponsibility ?? []) add('aors', String(aor.id), aor.name);
    }
    for (const tagId of new Set([
      ...(message.tags ?? []),
      ...(message.inboxTags ?? []).map((tag) => tag.tagId),
    ]))
      add('tags', String(tagId), tags[tagId]?.label);
    for (const callsign of new Set([
      ...(message.callsigns ?? []),
      ...(message.callsignsAlg2 ?? []),
    ]))
      add('callsigns', callsign);
    for (const networkId of new Set(message.networkIds ?? []))
      add('networks', String(networkId), message.networkName);
    for (const unitId of new Set(message.unitIds ?? []))
      add('units', getUnitIdFilterValue(unitId), units[unitId]?.name);
    if (!message.unitIds?.length) add('units', message.unit);
    for (const metadata of message.metadata ?? []) {
      add('metadataCcs', metadata.colorCode);
      add('metadataSenders', metadata.senderId, metadata.senderName);
      add('metadataReceivers', metadata.callGroupId, metadata.callGroupName);
      add('metadataHashes', metadata.hashId);
    }
  }
  const options = { ...emptyOptions };
  for (const [section, entries] of counts)
    options[section] = sortFilterOptionsByLabel(Array.from(entries.values()));
  options.senders = buildSenderFilterOptions(
    options.senders.map(({ value, count }) => ({ uuid: value, count })),
    inbox.signalProfiles,
  );
  return options;
}
