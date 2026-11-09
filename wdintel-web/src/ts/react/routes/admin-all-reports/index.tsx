import { Box, Stack } from '@mui/material';
import { useEffect } from 'react';

import { FULL_HEIGHT_LOADING_ROW_COUNT } from '../../components/mui-customized/table/custom-styles';
import { PageHeader } from '../../components/PageHeader';
import { listAllReportHistory } from '../../services/api/report-history';
import { navigateWithinSpa } from '../../utils/browser';
import { ReportHistoryTableSection } from '../settings-neo/SettingsMyReportsSection';

export function AdminAllReportsPage() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('tab') === 'rer-report') {
      params.delete('tab');
      const search = params.toString();
      navigateWithinSpa(`/admin/system-settings-neo${search ? `?${search}` : ''}#reports`);
    }
  }, []);

  return (
    <Stack spacing={1.5} sx={{ height: '100%', minHeight: 0, p: 2 }}>
      <PageHeader title="Всі звіти" />
      <Box sx={{ flex: 1, minHeight: 0 }}>
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
      </Box>
    </Stack>
  );
}
