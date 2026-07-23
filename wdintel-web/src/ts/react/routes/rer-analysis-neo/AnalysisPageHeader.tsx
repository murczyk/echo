import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import {
  Button,
  CircularProgress,
  FormControlLabel,
  IconButton,
  Stack,
  Switch,
  Tooltip,
} from '@mui/material';

import { PageHeader } from '../../components/PageHeader';
import { SidePanelToggleButton } from '../../components/SidePanelToggleButton';
import { AnalysisHeaderControls } from './components/AnalysisHeaderControls';
import { AnalysisPaginationControl } from './components/AnalysisPaginationControl';
import { AnalysisRightPanelToggle } from './components/AnalysisRightPanelToggle';
import { ANALYSIS_MESSAGES_PAGE_SIZE } from './helpers';
import type { AnalysisCenterTab, AnalysisPageViewModel } from './types';

type Props = {
  page: AnalysisPageViewModel;
  centerTab: AnalysisCenterTab;
  isCompactLayout?: boolean;
  isInitialLoading?: boolean;
  isNarrowLayout: boolean;
  leftPanelVisible: boolean;
  rightPanelVisible: boolean;
};

export function AnalysisPageHeader({
  page,
  centerTab,
  isCompactLayout = false,
  isInitialLoading = false,
  isNarrowLayout,
  leftPanelVisible,
  rightPanelVisible,
}: Props) {
  const loading = page.countsLoading || page.messagesLoading || page.summaryLoading;
  const showPagination = !isNarrowLayout || centerTab === 'messages';
  const showCompactRightPanelToggle = isCompactLayout && (!rightPanelVisible || isInitialLoading);
  return (
    <PageHeader
      title="Аналіз"
      middle={
        <AnalysisHeaderControls
          queryState={page.queryState}
          updateQueryState={page.updateQueryState}
          isCompactLayout={isCompactLayout}
        />
      }
      titleLeadingActions={
        !isCompactLayout ? (
          <SidePanelToggleButton
            side="left"
            active={leftPanelVisible}
            label={leftPanelVisible ? 'Згорнути ліву панель' : 'Розгорнути ліву панель'}
            onClick={() => page.toggleLeftPanel()}
          />
        ) : null
      }
      titleLeadingGap={!isCompactLayout ? 2 : 1}
      titleActionsGap={isCompactLayout ? 'auto' : undefined}
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
      compactLayout={isCompactLayout}
      fullWidthActions={isCompactLayout}
      actions={
        <Stack
          direction="row"
          spacing={{ xs: 0, sm: 1 }}
          alignItems="center"
          flexWrap="nowrap"
          justifyContent={isNarrowLayout && centerTab === 'messages' ? 'space-between' : 'flex-end'}
          sx={{ width: '100%', minWidth: 0, flexShrink: 0 }}
          data-analysis-header-actions
        >
          {isNarrowLayout && centerTab === 'messages' ? (
            <Tooltip title="Спочатку нові" arrow>
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={page.newestFirst}
                    onChange={(_event, value) => page.setNewestFirst(value)}
                    inputProps={{ 'aria-label': 'Спочатку нові' }}
                  />
                }
                label="спочатку нові"
                sx={{
                  height: 40,
                  display: 'flex',
                  alignItems: 'center',
                  flexShrink: 0,
                  m: 0,
                  whiteSpace: 'nowrap',
                  '& .MuiFormControlLabel-label': {
                    fontSize: 13,
                    fontWeight: 500,
                    lineHeight: 1.2,
                  },
                }}
              />
            </Tooltip>
          ) : null}
          <Stack
            direction="row"
            spacing={{ xs: 0.5, sm: 1 }}
            alignItems="center"
            flexShrink={0}
            sx={{ minWidth: 0 }}
          >
            {showPagination ? (
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
            ) : null}
            <Tooltip title="Оновити" arrow>
              <span>
                <IconButton
                  onClick={() => page.reload({ preserveMessagePage: true })}
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
            {!isCompactLayout ? (
              <SidePanelToggleButton
                side="right"
                active={rightPanelVisible}
                label={rightPanelVisible ? 'Згорнути праву панель' : 'Розгорнути праву панель'}
                onClick={() => page.toggleRightPanel()}
              />
            ) : null}
            {showCompactRightPanelToggle ? (
              <AnalysisRightPanelToggle
                expanded={rightPanelVisible}
                onClick={() => page.toggleRightPanel()}
              />
            ) : null}
          </Stack>
        </Stack>
      }
    />
  );
}
