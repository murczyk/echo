import { Box, Stack, Tab, Tabs } from '@mui/material';
import { useEffect, useState } from 'react';

import { FULL_HEIGHT_LOADING_ROW_COUNT } from '../../components/mui-customized/table/custom-styles';
import { PageHeader } from '../../components/PageHeader';
import { listAllReportHistory } from '../../services/api/report-history';
import { ReportHistoryTableSection } from '../settings-neo/SettingsMyReportsSection';
import { RerReportSettings } from './RerReportSettings';

type AdminAllReportsTab = 'all' | 'rer-report';

const TAB_PATHS: Record<AdminAllReportsTab, string> = {
  all: '/admin/all-reports?tab=all',
  'rer-report': '/admin/all-reports?tab=rer-report',
};

export function readAdminAllReportsTab(search = window.location.search): AdminAllReportsTab {
  return new URLSearchParams(search).get('tab') === 'rer-report' ? 'rer-report' : 'all';
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
