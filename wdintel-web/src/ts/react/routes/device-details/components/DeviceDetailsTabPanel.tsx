import { Box, Paper, Tab, Tabs } from '@mui/material';

import { DeviceFilesPanel } from '../../device-files';
import type { DeviceFilesState } from '../../device-files/use-device-files';

export type DeviceDetailsTab = 'analytical' | 'files';

export function DeviceDetailsTabPanel({
  activeTab,
  files,
  canSyncFiles,
  onTabChange,
}: {
  activeTab: DeviceDetailsTab;
  files: DeviceFilesState;
  canSyncFiles: boolean;
  onTabChange: (tab: DeviceDetailsTab) => void;
}) {
  return (
    <Paper
      variant="outlined"
      data-testid="device-details-tab-panel"
      sx={{
        minHeight: 0,
        height: '100%',
        minWidth: 0,
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <Box sx={{ px: 2, pt: 0.5, borderBottom: 1, borderColor: 'divider' }}>
        <Tabs
          value={activeTab}
          onChange={(_, nextTab: DeviceDetailsTab) => onTabChange(nextTab)}
          aria-label="Розділи пристрою"
          sx={{ minHeight: 42, '& .MuiTabs-indicator': { height: 2 } }}
        >
          <Tab
            id="device-details-analytical-tab"
            aria-controls="device-details-analytical-panel"
            value="analytical"
            label="Аналітичні відомості"
          />
          <Tab
            id="device-details-files-tab"
            aria-controls="device-details-files-panel"
            value="files"
            label="Файли"
          />
        </Tabs>
      </Box>

      <Box sx={{ minHeight: 0, flex: 1, overflow: 'hidden' }}>
        {activeTab === 'analytical' ? (
          <Box
            id="device-details-analytical-panel"
            role="tabpanel"
            aria-labelledby="device-details-analytical-tab"
            sx={{ height: '100%', minHeight: 0 }}
          />
        ) : (
          <Box
            id="device-details-files-panel"
            role="tabpanel"
            aria-labelledby="device-details-files-tab"
            sx={{ height: '100%', minHeight: 0, minWidth: 0 }}
          >
            <DeviceFilesPanel files={files} canSync={canSyncFiles} />
          </Box>
        )}
      </Box>
    </Paper>
  );
}
