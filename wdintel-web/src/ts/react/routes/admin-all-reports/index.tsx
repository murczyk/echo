import { Box, FormControlLabel, Stack, Switch, Tab, Tabs } from '@mui/material';
import { useEffect, useState } from 'react';

import { FULL_HEIGHT_LOADING_ROW_COUNT } from '../../components/mui-customized/table/custom-styles';
import { PageHeader } from '../../components/PageHeader';
import { PowerAlert } from '../../components/PowerAlert';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { listAllReportHistory } from '../../services/api/report-history';
import { currentSystemSettings, setRerReportEnabled } from '../../services/api/system-settings';
import { ReportHistoryTableSection } from '../settings-neo/SettingsMyReportsSection';

type AdminAllReportsTab = 'all' | 'rer-report';

const TAB_PATHS: Record<AdminAllReportsTab, string> = {
  all: '/admin/all-reports?tab=all',
  'rer-report': '/admin/all-reports?tab=rer-report',
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function readAdminAllReportsTab(search = window.location.search): AdminAllReportsTab {
  return new URLSearchParams(search).get('tab') === 'rer-report' ? 'rer-report' : 'all';
}

function RerReportSettings() {
  const { notify } = usePowerSnackbar();
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const settings = await currentSystemSettings();
        if (active) setEnabled(settings.rerReportEnabled);
      } catch (nextError) {
        if (active) {
          const message = `Не вдалося завантажити налаштування: ${errorMessage(nextError)}`;
          setError(message);
          notify({ severity: 'error', message });
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  async function updateEnabled(nextEnabled: boolean) {
    const previousEnabled = enabled;
    setEnabled(nextEnabled);
    setSaving(true);
    setError(null);
    try {
      const settings = await setRerReportEnabled(nextEnabled);
      setEnabled(settings.rerReportEnabled);
      notify({ severity: 'success', message: 'Налаштування звіту РЕР збережено.' });
    } catch (nextError) {
      const message = `Не вдалося зберегти налаштування: ${errorMessage(nextError)}`;
      setEnabled(previousEnabled);
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack spacing={1.5} alignItems="flex-start">
      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
      <FormControlLabel
        control={
          <Switch
            checked={enabled}
            disabled={loading || saving}
            onChange={(_, checked) => void updateEnabled(checked)}
          />
        }
        label="Звіт РЕР увімкнено в системі"
      />
    </Stack>
  );
}

export function AdminAllReportsPage() {
  const [tab, setTab] = useState<AdminAllReportsTab>(() => readAdminAllReportsTab());

  useEffect(() => {
    const rawTab = new URLSearchParams(window.location.search).get('tab');
    if (rawTab !== null && rawTab !== 'all' && rawTab !== 'rer-report') {
      window.history.replaceState(null, '', TAB_PATHS.all);
    } else if (rawTab !== null && window.location.search !== `?tab=${rawTab}`) {
      window.history.replaceState(null, '', TAB_PATHS[readAdminAllReportsTab()]);
    }
    const onPopState = () => setTab(readAdminAllReportsTab());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function selectTab(value: AdminAllReportsTab) {
    setTab(value);
    window.history.pushState(null, '', TAB_PATHS[value]);
  }

  return (
    <Stack spacing={1.5} sx={{ height: '100%', minHeight: 0, p: 2 }}>
      <PageHeader
        title="Звіти"
        titleActions={
          <Tabs
            value={tab}
            onChange={(_, value) => selectTab(value as AdminAllReportsTab)}
            aria-label="Розділи адміністрування звітів"
          >
            <Tab value="all" label="Всі звіти" />
            <Tab value="rer-report" label="Звіт РЕР" />
          </Tabs>
        }
        titleActionsGap={2}
      />
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {tab === 'all' ? (
          <ReportHistoryTableSection
            active
            title="Всі звіти"
            showTitle={false}
            tableId="admin-all-reports-v4"
            includeAuthor
            fullHeight
            compactFullHeight
            loadingRowCount={FULL_HEIGHT_LOADING_ROW_COUNT}
            loadReportHistoryBatch={listAllReportHistory}
            allowSuccessfulRerun
          />
        ) : (
          <RerReportSettings />
        )}
      </Box>
    </Stack>
  );
}
