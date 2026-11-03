import { CircularProgress } from '@mui/material';
import { useEffect, useRef, useState } from 'react';

import { redirectToLogin } from '../../../auth-redirect';
import { ConfirmDangerDialog } from '../../../components/ConfirmDangerDialog';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { isAbortError, isUnauthorizedError } from '../../../services/api/client';
import { rebuildDeviceStats } from '../../../services/api/devices';
import { toDeviceFileLoadError } from '../../device-files/helpers';
import { useDeviceFileErrorNotification } from '../../device-files/use-device-file-error-notification';
import { formatDeviceBytes, formatDeviceCount } from '../device-activity';
import { useDeviceMobileLayout } from '../use-device-mobile-layout';

export function DeviceStatsRebuildAction({
  deviceId,
  disabled,
  onRebuilt,
}: {
  deviceId: string;
  disabled: boolean;
  onRebuilt?: () => void;
}) {
  const mobile = useDeviceMobileLayout();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useDeviceFileErrorNotification(error);
  useEffect(() => () => abortRef.current?.abort(), []);

  const rebuild = async () => {
    if (disabled || rebuilding) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRebuilding(true);
    setError(null);
    setMessage(null);
    try {
      const rsp = await rebuildDeviceStats({ deviceId }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setMessage(
        `Статистику перераховано: ${formatDeviceCount(BigInt(rsp.contentCount))} завантажень, ` +
          `${formatDeviceBytes(BigInt(rsp.contentBytes))}; ` +
          `${formatDeviceCount(BigInt(rsp.fileCount))} файлів, ` +
          `${formatDeviceCount(BigInt(rsp.directoryCount))} тек.`,
      );
      onRebuilt?.();
    } catch (rebuildError) {
      if (controller.signal.aborted || isAbortError(rebuildError)) return;
      if (isUnauthorizedError(rebuildError)) {
        redirectToLogin();
        return;
      }
      const message = toDeviceFileLoadError(
        rebuildError,
        'Не вдалося перерахувати статистику',
      ).message;
      setError(message);
      setMessage(message);
    } finally {
      if (!controller.signal.aborted) {
        setRebuilding(false);
        setConfirmOpen(false);
      }
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  return (
    <section
      aria-label="Статистика пристрою"
      className="flex flex-col items-start gap-echo-sm border-t border-echo-border pt-echo-lg"
    >
      <PowerButton
        className={mobile ? '!min-h-echo-control-lg' : undefined}
        size="small"
        variant="outlined"
        style={{ whiteSpace: 'normal' }}
        disabled={disabled || rebuilding}
        startIcon={rebuilding ? <CircularProgress size={14} color="inherit" /> : undefined}
        onClick={() => setConfirmOpen(true)}
      >
        {rebuilding ? 'Перерахунок…' : 'Перерахувати статистику пристрою'}
      </PowerButton>
      {message !== null ? (
        <PowerAlert severity={error === null ? 'success' : 'error'} autoHideDuration={null}>
          {message}
        </PowerAlert>
      ) : null}
      <ConfirmDangerDialog
        open={confirmOpen}
        title="Перерахувати статистику пристрою?"
        description="Статистику завантажень буде обнулено й перераховано з усіх файлів пристрою. Поки перерахунок триває, показники будуть неповними. Нові завантаження не блокуються."
        confirmLabel="Перерахувати"
        submitting={rebuilding}
        disabled={disabled}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void rebuild()}
      />
    </section>
  );
}
