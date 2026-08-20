import { useCallback } from 'react';
import { copyTextToClipboard } from '../../../copy-to-clipboard';
import { useOptionalPowerSnackbar } from '../../components/PowerSnackbar';

type UseDutyBulkCopyParams<T> = {
  entityLabel: string;
  serialize: (selected: readonly T[]) => string;
};

export function useDutyBulkCopy<T>({
  entityLabel,
  serialize,
}: UseDutyBulkCopyParams<T>): (selected: readonly T[]) => Promise<void> {
  const { notify } = useOptionalPowerSnackbar();

  return useCallback(
    async (selected: readonly T[]) => {
      try {
        await copyTextToClipboard(serialize(selected));
        notify({
          message: `Скопійовано значень: ${selected.length}.`,
          severity: 'success',
        });
      } catch {
        notify({
          message: `Не вдалося скопіювати ${entityLabel}.`,
          severity: 'error',
        });
      }
    },
    [entityLabel, notify, serialize],
  );
}
