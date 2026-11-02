import { useState } from 'react';

import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { restartReportWorker } from '../../services/api/admin';

export function ReportWorkerRestart() {
  const { notify } = usePowerSnackbar();
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);

  async function restart() {
    setRestarting(true);
    try {
      await restartReportWorker();
      setConfirming(false);
      notify({ severity: 'success', message: 'Обробник звітів перезапущено.' });
    } catch (error) {
      notify({
        severity: 'error',
        message: `Не вдалося перезапустити обробник звітів: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setRestarting(false);
    }
  }

  return (
    <div>
      <PowerButton variant="outlined" disabled={restarting} onClick={() => setConfirming(true)}>
        Перезапустити обробник звітів
      </PowerButton>
      <ConfirmDangerDialog
        open={confirming}
        onClose={() => !restarting && setConfirming(false)}
        onConfirm={() => void restart()}
        submitting={restarting}
        title="Перезапустити обробник звітів?"
        description="Поточне формування звітів буде перервано. Після запуску обробника застосовується звичайне відновлення черги."
        confirmLabel="Перезапустити"
      />
    </div>
  );
}
