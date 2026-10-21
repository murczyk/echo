import type { ComponentProps } from 'react';

import type { InboxMessagesReq, SignalGroupEntry } from '../../../../../Bindings';
import type { GroupIdentity } from './GroupIdentity';
import type { GroupNavigationItem, GroupScope } from './group-navigation.types';

export function groupFilterScope(selectedKeys: readonly string[]): GroupScope {
  const keys = [...new Set(selectedKeys)];
  return keys.length === 1 ? { kind: 'group', masterKey: keys[0]! } : { kind: 'all' };
}

export function buildGroupFilterItems(
  keys: readonly string[],
  groupInfos: Record<string, SignalGroupEntry>,
  excludeDutyHidden = false,
): GroupNavigationItem[] {
  const groups = [...new Set(keys)].flatMap<GroupNavigationItem>((masterKey) => {
    const info = groupInfos[masterKey];
    if (excludeDutyHidden && (!info || info.ignoreOperativny)) return [];
    return [
      {
        kind: 'group',
        masterKey,
        name: info?.name ?? masterKey,
        colorKey: info?.colorKey ?? 'blue_grey',
      },
    ];
  });
  return [
    {
      kind: 'all',
      masterKey: null,
      name: 'Всі групи',
    },
    ...groups,
  ];
}

export function groupFilterIdentity(
  selectedKeys: readonly string[],
  groupInfos: Record<string, SignalGroupEntry>,
): ComponentProps<typeof GroupIdentity>['group'] {
  const keys = [...new Set(selectedKeys)];
  const firstKey = keys[0];
  if (!firstKey) return { kind: 'all', name: 'Всі групи' };
  const firstGroup = groupInfos[firstKey];
  return {
    kind: keys.length === 1 ? 'group' : 'all',
    name: (firstGroup?.name ?? firstKey) + (keys.length > 1 ? ` + ${keys.length - 1} ін.` : ''),
    colorKey: firstGroup?.colorKey,
  };
}

export function applyGroupScopeToInboxRequest(
  request: InboxMessagesReq,
  scope: GroupScope,
): InboxMessagesReq {
  if (scope.kind === 'all') return request;
  return {
    ...request,
    selectedGroups: [scope.masterKey],
    deniedGroups: null,
  };
}
