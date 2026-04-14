import type { CallsignInfo } from '../../../../Bindings';

export function toTooltipText(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

export function formatLegacyCallsignTooltipLine(callsignInfo: Pick<CallsignInfo, 'position' | 'unit1' | 'unit2'>): string {
  return `🐷 ${toTooltipText(callsignInfo.position)} ${toTooltipText(callsignInfo.unit1)} ${toTooltipText(callsignInfo.unit2)}`;
}
