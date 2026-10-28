import type { UnitResponse } from '../../../services/api/direct-submit';
import type { DeepPartial } from 'react-hook-form';
import { normalizeMessageUnitName } from './message-unit-name';

export const MESSAGE_UNIT_SELECTION_ERROR = 'Підрозділ не обрано';

export type MessageUnitSelection = {
  name: string;
  id?: number;
  create?: boolean;
  inherited?: boolean;
};
export type MessageNetworkUnitSelection = {
  networkId: number;
  unitIds: number[];
  units: UnitResponse[];
};
type SelectedMessageUnit =
  { name: string; id: number; create?: false } | { name: string; id?: undefined; create: true };

export function compatibleMessageUnitSelection(
  name: string | undefined,
  selection: Partial<MessageUnitSelection> | undefined,
): SelectedMessageUnit | undefined {
  if (!name?.trim() || !selection) return undefined;
  if (
    !selection.name ||
    normalizeMessageUnitName(name) !== normalizeMessageUnitName(selection.name)
  )
    return undefined;
  if (selection.create === true) {
    return selection.id == null ? { name: selection.name, create: true } : undefined;
  }
  return selection.id != null && Number.isInteger(selection.id) && selection.id > 0
    ? { id: selection.id, name: selection.name }
    : undefined;
}

export function isMessageUnitSelectionValid(
  name: string | undefined,
  selection: Partial<MessageUnitSelection> | undefined,
  networkSelection?: DeepPartial<MessageNetworkUnitSelection>,
): boolean {
  if (networkSelection) {
    const units = (networkSelection.unitIds ?? []).map((id) =>
      (networkSelection.units ?? []).find(
        (unit) => id != null && unit?.id === id && unit?.name?.trim(),
      ),
    );
    return (
      units.length > 0 &&
      units.every((unit) => unit != null) &&
      normalizeMessageUnitName(name ?? '') ===
        normalizeMessageUnitName(units.map((unit) => unit?.name).join(', '))
    );
  }
  return (
    !name?.trim() ||
    (selection?.inherited === true &&
      selection.id == null &&
      selection.create !== true &&
      name === selection.name) ||
    compatibleMessageUnitSelection(name, selection) != null
  );
}
