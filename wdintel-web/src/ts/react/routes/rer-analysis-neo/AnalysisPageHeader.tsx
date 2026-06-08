import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import { Button, Stack } from '@mui/material';

import { PageHeader } from '../../components/PageHeader';
import { SidePanelToggleButton } from '../../components/SidePanelToggleButton';
import { AnalysisHeaderControls } from './components/AnalysisHeaderControls';
import type { AnalysisPageViewModel } from './types';

type Props = {
  page: AnalysisPageViewModel;
  isMobileLayout: boolean;
  leftPanelVisible: boolean;
  rightPanelVisible: boolean;
};

export function AnalysisPageHeader({ page, isMobileLayout, leftPanelVisible, rightPanelVisible }: Props) {
  return (
    <PageHeader
      title="Аналіз"
      middle={<AnalysisHeaderControls queryState={page.queryState} updateQueryState={page.updateQueryState} />}
      titleLeadingActions={!isMobileLayout ? (
        <SidePanelToggleButton
          side="left"
          active={leftPanelVisible}
          label={leftPanelVisible ? 'Згорнути ліву панель' : 'Розгорнути ліву панель'}
          onClick={() => page.toggleLeftPanel()}
        />
      ) : null}
      titleLeadingGap={!isMobileLayout ? 2 : 1}
      titleActions={
        <Button
          variant="contained"
          color="primary"
          size="small"
          onClick={page.openReport}
          title="Відкрити конструктор звітів"
          startIcon={<DescriptionOutlinedIcon sx={{ fontSize: 18 }} />}
          sx={{ height: 36, px: 1.25, display: { xs: 'inline-flex', md: 'none' }, whiteSpace: 'nowrap' }}
        >
          Конструктор
        </Button>
      }
      middleGap={4}
      actions={
        <Stack direction="row" spacing={2} alignItems="center">
          <Button
            variant="contained"
            color="primary"
            onClick={page.openReport}
            title="Відкрити конструктор звітів"
            sx={{ height: 40, px: 2, display: { xs: 'none', md: 'inline-flex' } }}
          >
            Конструктор звітів
          </Button>
          {!isMobileLayout ? (
            <SidePanelToggleButton
              side="right"
              active={rightPanelVisible}
              label={rightPanelVisible ? 'Згорнути праву панель' : 'Розгорнути праву панель'}
              onClick={() => page.toggleRightPanel()}
            />
          ) : null}
        </Stack>
      }
    />
  );
}
