import { useCallback, useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import type { NetworkSearchResult } from '../../../services/api/direct-submit';
import { getUnitsByIds } from '../../../services/api/units';
import type { MessageFormData } from './manage-message-drawer.schema';

type Props = {
  active: boolean;
  isEditMode: boolean;
  methods: UseFormReturn<MessageFormData>;
  selectedNetwork: NetworkSearchResult | null;
  setSelectedNetwork: (network: NetworkSearchResult | null) => void;
  setUnitLocked: (locked: boolean) => void;
  setNetworkUnitNamesById: Dispatch<SetStateAction<Record<number, string>>>;
  onError: (description: string, error: unknown) => void;
  retryAttempt: number;
};

export function useMessageNetworkUnits({
  active,
  isEditMode,
  methods,
  selectedNetwork,
  setSelectedNetwork,
  setUnitLocked,
  setNetworkUnitNamesById,
  onError,
  retryAttempt,
}: Props) {
  const { getValues, setValue } = methods;
  const selectNetwork = useCallback(
    (network: NetworkSearchResult | null) => {
      const previousAssignment = getValues('unitNetworkSelection');
      const unitIds = Array.from(new Set(network?.unit_ids ?? []));
      setSelectedNetwork(network);
      setUnitLocked(unitIds.length > 0);
      if (!previousAssignment && unitIds.length === 0) return;
      if (previousAssignment || unitIds.length > 0) {
        setValue('unitSelection', undefined);
      }
      setValue(
        'unitNetworkSelection',
        network && unitIds.length > 0 ? { networkId: network.id, unitIds, units: [] } : undefined,
        { shouldValidate: true },
      );
    },
    [getValues, setSelectedNetwork, setUnitLocked, setValue],
  );

  useEffect(() => {
    if (!active || !selectedNetwork?.unit_ids?.length) return;
    const assignment = getValues('unitNetworkSelection');
    if (assignment?.networkId !== selectedNetwork.id) return;
    let current = true;
    const controller = new AbortController();
    const isCurrent = () => {
      const currentAssignment = getValues('unitNetworkSelection');
      return (
        current &&
        currentAssignment?.networkId === selectedNetwork.id &&
        currentAssignment.unitIds.join(',') === assignment.unitIds.join(',')
      );
    };
    setUnitLocked(true);
    getUnitsByIds(assignment.unitIds, { signal: controller.signal })
      .then((units) => {
        if (!isCurrent()) return;
        const assignedUnits = assignment.unitIds.map((id) => units.find((unit) => unit.id === id));
        if (assignedUnits.some((unit) => !unit?.name.trim())) {
          throw new Error('Не вдалося знайти всі підрозділи вибраної мережі.');
        }
        const resolvedUnits = assignedUnits.flatMap((unit) =>
          unit ? [{ id: unit.id, name: unit.name }] : [],
        );
        setNetworkUnitNamesById((currentNames) => ({
          ...currentNames,
          ...Object.fromEntries(resolvedUnits.map((unit) => [unit.id, unit.name])),
        }));
        setValue('unit', resolvedUnits.map((unit) => unit.name).join(', '), {
          shouldValidate: true,
        });
        setValue(
          'unitNetworkSelection',
          { ...assignment, units: resolvedUnits },
          {
            shouldValidate: true,
          },
        );
        if (!isEditMode && resolvedUnits.length === 1) {
          setValue('unitSelection', resolvedUnits[0], { shouldValidate: true });
        }
      })
      .catch((error) => {
        if (!isCurrent()) return;
        setUnitLocked(false);
        onError('Failed to load units for network', error);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [
    active,
    getValues,
    isEditMode,
    onError,
    retryAttempt,
    selectedNetwork,
    setUnitLocked,
    setNetworkUnitNamesById,
    setValue,
  ]);

  return selectNetwork;
}
