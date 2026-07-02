import dayjs from 'dayjs';

import type { SelectedSidebarUnitFilter } from '../rer-callsigns-neo/types';
import type { ActivityByNetworkId } from './use-rer-networks-neo-page.types';

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function getActivityRequestUpperBoundMs(): number {
  return dayjs().startOf('day').add(1, 'day').valueOf();
}

export function normalizeActivityMap(
  activityByNetworkId: Record<string, Record<string, Record<string, number>>>,
): ActivityByNetworkId {
  const activity = new Map<number, Record<string, Record<string, number>>>();
  for (const [networkId, networkActivity] of Object.entries(activityByNetworkId)) {
    const parsedId = Number(networkId);
    if (!Number.isFinite(parsedId)) continue;
    activity.set(parsedId, networkActivity);
  }
  return activity;
}

export function isSameSidebarUnitFilter(
  left: SelectedSidebarUnitFilter | null,
  right: SelectedSidebarUnitFilter,
): boolean {
  if (left === null || left.kind !== right.kind || left.label !== right.label) {
    return false;
  }

  if (left.kind === 'leaf' && right.kind === 'leaf') {
    return left.unitName === right.unitName;
  }

  if (left.kind === 'group' && right.kind === 'group') {
    return (
      left.hierarchy.army === right.hierarchy.army &&
      left.hierarchy.division === right.hierarchy.division &&
      left.hierarchy.regiment === right.hierarchy.regiment &&
      left.hierarchy.battalion === right.hierarchy.battalion
    );
  }

  return false;
}

export function getNetworkPermissionsFromRoles(rolesList: string[]) {
  const roles = new Set(rolesList);
  return {
    canEdit:
      roles.has('Admin') || (roles.has('UnitsEditor') && (roles.has('Rer') || roles.has('Full'))),
    canExport: roles.has('Admin') || roles.has('Rer') || roles.has('Full'),
    canDelete:
      roles.has('Admin') || (roles.has('UnitsEditor') && (roles.has('Rer') || roles.has('Full'))),
  };
}
