import { useEffect, useMemo, useState } from 'react';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { searchDeviceNames } from '../../services/api/direct-submit';
import { toErrorMessage } from '../rer-analysis-neo/use-analysis-data.shared';
import { FeedFilterSelectionSection } from './FeedFilterSelectionSection';
import {
  useFeedFilterSelectionState,
  type FeedFilterModeTransfer,
} from './useFeedFilterSelectionState';

type Props = {
  selected: string[];
  denied: string[];
  onSelectedChange: (value: string[]) => void;
  onDeniedChange: (value: string[]) => void;
  onModeTransfer: (next: FeedFilterModeTransfer) => void;
};

export function FeedFilterDeviceNamesSection({
  selected,
  denied,
  onSelectedChange,
  onDeniedChange,
  onModeTransfer,
}: Props) {
  const { notify } = usePowerSnackbar();
  const [input, setInput] = useState('');
  const [remoteOptions, setRemoteOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const selection = useFeedFilterSelectionState({
    includeValues: selected,
    excludeValues: denied,
    onIncludeChange: onSelectedChange,
    onExcludeChange: onDeniedChange,
    onModeTransfer,
    toLocalValues: (values) => [...values],
    toParentValues: (values) => [...values],
  });
  const options = useMemo(
    () => [...new Set([...selection.localValue, ...remoteOptions])],
    [remoteOptions, selection.localValue],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      setLoading(true);
      void searchDeviceNames(input, { signal: controller.signal })
        .then((devices) => {
          if (!controller.signal.aborted) setRemoteOptions(devices.map((device) => device.name));
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            notify({
              severity: 'error',
              message: `Не вдалося завантажити назви пристроїв: ${toErrorMessage(error)}`,
            });
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [input, notify]);

  return (
    <FeedFilterSelectionSection
      title="Пристрої"
      mode={selection.mode}
      onModeChange={selection.setMode}
      value={selection.localValue}
      onValueChange={selection.setLocalValue}
      options={options}
      getOptionLabel={(option) => option}
      placeholder={
        selection.localValue.length === 0
          ? selection.mode === 'include'
            ? 'всі'
            : 'жоден'
          : undefined
      }
      loading={loading}
      loadingText="Завантажуємо назви пристроїв…"
      noOptionsText="Назв пристроїв не знайдено"
      onInputChange={setInput}
      keepOpenOnSelect
      bulkPaste
      bulkPasteSeparators={['\n']}
      bulkPasteMenuLabel="Додати кілька пристроїв"
      bulkPasteDialogTitle="Додати кілька пристроїв"
      bulkPasteInputLabel="Пристрої"
      bulkCopy
      bulkCopyMenuLabel="Копіювати обрані пристрої"
    />
  );
}
