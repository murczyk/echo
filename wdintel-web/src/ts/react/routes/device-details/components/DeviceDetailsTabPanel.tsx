import { Box, Paper, Tab, Tabs } from '@mui/material';

import { DeviceFileContentPane } from '../../device-files';
import { DeviceFileJournal } from '../../device-files/components/DeviceFileJournal';
import type { DeviceAnalyticsTagFilter } from '../../device-files/types';
import type { DeviceAnalyticsTagsState } from '../../device-files/use-device-analytics-tags';
import type { DeviceFileJournalState } from '../../device-files/use-device-file-journal';
import { DeviceAnalyticsPanel } from './DeviceAnalyticsPanel';

export type DeviceDetailsTab = 'analytical' | 'files' | 'journal';

export function DeviceDetailsTabPanel({
  activeTab,
  journal,
  deviceId,
  isAdmin,
  tagsState,
  tagFilter,
  onTagFilterChange,
  onTabChange,
}: {
  activeTab: DeviceDetailsTab;
  journal: DeviceFileJournalState;
  deviceId: string;
  isAdmin: boolean;
  tagsState: DeviceAnalyticsTagsState;
  tagFilter: DeviceAnalyticsTagFilter;
  onTagFilterChange: (filter: DeviceAnalyticsTagFilter) => void;
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
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
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
          <Tab
            id="device-details-journal-tab"
            aria-controls="device-details-journal-panel"
            value="journal"
            label="Журнал"
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
          >
            <DeviceAnalyticsPanel
              deviceId={deviceId}
              enabled
              isAdmin={isAdmin}
              tagsState={tagsState}
              tagFilter={tagFilter}
              onTagFilterChange={onTagFilterChange}
            />
          </Box>
        ) : null}
        {activeTab === 'files' ? (
          <Box
            id="device-details-files-panel"
            role="tabpanel"
            aria-labelledby="device-details-files-tab"
            sx={{ height: '100%', minHeight: 0, minWidth: 0 }}
          >
            <DeviceFileContentPane />
          </Box>
        ) : null}
        {activeTab === 'journal' ? (
          <Box
            id="device-details-journal-panel"
            role="tabpanel"
            aria-labelledby="device-details-journal-tab"
            sx={{ height: '100%', minHeight: 0, minWidth: 0 }}
          >
            <DeviceFileJournal
              journal={journal}
              tagsState={tagsState}
              tagFilter={tagFilter}
              onTagFilterChange={onTagFilterChange}
            />
          </Box>
        ) : null}
      </Box>
    </Paper>
  );
}
