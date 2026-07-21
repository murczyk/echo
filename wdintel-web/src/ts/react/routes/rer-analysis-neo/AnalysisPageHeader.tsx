import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import { Button, Stack, Tooltip, IconButton, CircularProgress } from '@mui/material';

import { PageHeader } from '../../components/PageHeader';
import { SidePanelToggleButton } from '../../components/SidePanelToggleButton';
import { AnalysisHeaderControls } from './components/AnalysisHeaderControls';
import { AnalysisPaginationControl } from './components/AnalysisPaginationControl';
import { ANALYSIS_MESSAGES_PAGE_SIZE } from './helpers';
import type { AnalysisCenterTab, AnalysisPageViewModel } from './types';

type Props = {
  page: AnalysisPageViewModel;
  centerTab: AnalysisCenterTab;
  isMobileLayout: boolean;
  leftPanelVisible: boolean;
  rightPanelVisible: boolean;
};

export function AnalysisPageHeader({
  page,
  centerTab,
  isMobileLayout,
  leftPanelVisible,
  rightPanelVisible,
}: Props) {
  const loading = page.countsLoading || page.messagesLoading || page.summaryLoading;
  return (
    <PageHeader
      title="Аналіз"
      middle={
        <AnalysisHeaderControls
          queryState={page.queryState}
          updateQueryState={page.updateQueryState}
        />
      }
      titleLeadingActions={
        !isMobileLayout ? (
          <SidePanelToggleButton
            side="left"
            active={leftPanelVisible}
            label={leftPanelVisible ? 'Згорнути ліву панель' : 'Розгорнути ліву панель'}
            onClick={() => page.toggleLeftPanel()}
          />
        ) : null
      }
      titleLeadingGap={!isMobileLayout ? 2 : 1}
      titleActions={
        <Button
          variant="contained"
          color="primary"
          size="small"
          onClick={page.openReport}
          title="Відкрити конструктор звітів"
          startIcon={<DescriptionOutlinedIcon sx={{ fontSize: 18 }} />}
          sx={{
            height: 36,
            px: 1.25,
            display: { xs: 'inline-flex', md: 'none' },
            whiteSpace: 'nowrap',
          }}
        >
          Конструктор
        </Button>
      }
      middleGap={4}
      actions={
        <Stack direction="row" spacing={1} alignItems="center">
          <AnalysisPaginationControl
            centerTab={centerTab}
            pageIndex={page.pageIndex}
            pageSize={ANALYSIS_MESSAGES_PAGE_SIZE}
            messagesCount={page.messages.length}
            totalCount={page.messagesTotalCount}
            totalLoading={page.messagesTotalLoading}
            loading={page.messagesLoading}
            noMoreToLoad={page.noMoreToLoad}
            busy={page.messagesPaging || page.messagesLoading}
            onFirstPage={page.loadFirstPage}
            onLastPage={page.loadLastPage}
            onPrevPage={page.loadPrevPage}
            onNextPage={page.loadNextPage}
          />
          <Tooltip title="Оновити" arrow>
            <span>
              <IconButton
                onClick={() => page.reload()}
                disabled={loading}
                aria-label="Оновити"
                sx={{
                  width: 40,
                  height: 40,
                  borderRadius: 1,
                  border: '1px solid',
                  borderColor: 'divider',
                }}
              >
                {loading ? (
                  <CircularProgress size={20} color="inherit" />
                ) : (
                  <RefreshOutlinedIcon sx={{ fontSize: 20 }} />
                )}
              </IconButton>
            </span>
          </Tooltip>
          <Button
            variant="contained"
            color="primary"
            onClick={page.openReport}
            title="Відкрити конструктор звітів"
            sx={{ height: 40, px: 2, display: { xs: 'none', md: 'inline-flex' }, ml: 1 }}
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
