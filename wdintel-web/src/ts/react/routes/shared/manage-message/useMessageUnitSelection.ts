import { useEffect } from 'react';
import type { DeepPartial, UseFormReturn } from 'react-hook-form';
import type { UnitResponse } from '../../../services/api/direct-submit';
import type { MessageFormData } from './manage-message-drawer.schema';
import { normalizeMessageUnitName } from './message-unit-name';
import { compatibleMessageUnitSelection } from './message-unit-selection';

type Props = {
  active: boolean;
  isEditMode: boolean;
  methods: UseFormReturn<MessageFormData>;
  values: DeepPartial<MessageFormData>;
  results: { search: string; units: UnitResponse[] } | null;
};

export function useMessageUnitSelection({ active, isEditMode, methods, values, results }: Props) {
  const { getValues, register, resetField, trigger, unregister } = methods;
  useEffect(() => {
    if (!active) return;
    const name = getValues('unit') ?? '';
    const selection = getValues('unitSelection');
    const compatibleSelection = compatibleMessageUnitSelection(name, selection);
    if (selection && !compatibleSelection) {
      unregister('unitSelection');
      void trigger('unit');
    }
    if (
      isEditMode ||
      getValues('unitNetworkSelection') ||
      compatibleSelection ||
      !name.trim() ||
      results?.search !== name
    ) {
      return;
    }
    const matches = Array.from(
      new Map(
        results.units
          .filter((unit) => normalizeMessageUnitName(unit.name) === normalizeMessageUnitName(name))
          .map((unit) => [unit.id, unit]),
      ).values(),
    );
    if (matches.length === 1) {
      register('unitSelection');
      resetField('unitSelection', { defaultValue: matches[0], keepTouched: true });
      void trigger('unit');
    }
  }, [
    active,
    getValues,
    isEditMode,
    results,
    register,
    resetField,
    trigger,
    unregister,
    values.unit,
    values.unitSelection,
    values.unitNetworkSelection,
  ]);
}
