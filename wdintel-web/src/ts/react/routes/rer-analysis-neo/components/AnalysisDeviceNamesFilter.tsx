import { useEffect, useState } from 'react';

import { usePowerSnackbar } from '../../../components/PowerSnackbar';
import { searchDeviceNames } from '../../../services/api/direct-submit';
import { toErrorMessage } from '../use-analysis-data.shared';
import { AnalysisFilterField } from './AnalysisFilterField';

type Props = {
  value: string[];
  onChange: (deviceNamesSelected: string[]) => void;
};

export function AnalysisDeviceNamesFilter({ value, onChange }: Props) {
  const { notify } = usePowerSnackbar();
  const [deviceNameInput, setDeviceNameInput] = useState('');
  const [deviceNames, setDeviceNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const abortController = new AbortController();
    const timeoutId = window.setTimeout(() => {
      setLoading(true);
      void searchDeviceNames(deviceNameInput, { signal: abortController.signal })
        .then((devices) => {
          if (!abortController.signal.aborted) {
            setDeviceNames(devices.map((device) => device.name));
          }
        })
        .catch((error) => {
          if (!abortController.signal.aborted) {
            notify({
              severity: 'error',
              message: `Не вдалося завантажити назви пристроїв: ${toErrorMessage(error)}`,
            });
          }
        })
        .finally(() => {
          if (!abortController.signal.aborted) setLoading(false);
        });
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
      abortController.abort();
    };
  }, [deviceNameInput, notify]);

  return (
    <AnalysisFilterField
      label="Назва пристрою"
      options={deviceNames}
      value={value}
      loading={loading}
      deferredCommit
      onInputChange={setDeviceNameInput}
      onChange={onChange}
    />
  );
}
