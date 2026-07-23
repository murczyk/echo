import type { CallsignInfo } from '../../../../Bindings';
import type { CallsignNetworkHint } from '../../../../Bindings';

export function toTooltipText(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

export function formatLegacyCallsignTooltipLine(
  callsignInfo: Pick<CallsignInfo, 'position' | 'unit1' | 'unit2'>,
): string {
  return `🐷 ${toTooltipText(callsignInfo.position)} ${toTooltipText(callsignInfo.unit1)} ${toTooltipText(callsignInfo.unit2)}`;
}

export function formatNetworkCallsignTooltipLine(
  hint: Pick<CallsignNetworkHint, 'position' | 'formation'>,
): string {
  return `🐷 ${[hint.position, hint.formation].map(toTooltipText).filter(Boolean).join(' ')}`;
}
