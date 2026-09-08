import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import {
  Button,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Skeleton,
  Stack,
  Switch,
  Tooltip,
} from '@mui/material';
import { useRef, useState } from 'react';

import { PageHeader } from '../../components/PageHeader';
import { SidePanelToggleButton } from '../../components/SidePanelToggleButton';
import { AnalysisHeaderControls } from './components/AnalysisHeaderControls';
import { AnalysisPaginationControl } from './components/AnalysisPaginationControl';
import { ANALYSIS_MESSAGES_PAGE_SIZE } from './helpers';
import type { AnalysisCenterTab, AnalysisPageViewModel } from './types';

type Props = {
  page: AnalysisPageViewModel;
  centerTab: AnalysisCenterTab;
  isCompactLayout?: boolean;
  isNarrowLayout: boolean;
  leftPanelVisible: boolean;
  rightPanelVisible: boolean;
  onOpenReport?: (focusTarget: HTMLElement) => void;
};

type SettingsMenuProps = {
  page: AnalysisPageViewModel;
  loading: boolean;
  onOpenReport?: (focusTarget: HTMLElement) => void;
};

function AnalysisSettingsMenu({ page, loading, onOpenReport }: SettingsMenuProps) {
  const [anchorElement, setAnchorElement] = useState<HTMLElement | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuOpen = Boolean(anchorElement);
  const closeMenu = () => setAnchorElement(null);
  const openReport = (focusTarget: HTMLElement | null) => {
    if (onOpenReport && focusTarget) {
      onOpenReport(focusTarget);
    } else {
      page.openReport();
    }
  };

  return (
    <>
      <Tooltip title="Налаштування аналізу" arrow>
        <IconButton
          ref={settingsButtonRef}
          aria-label="Налаштування аналізу"
          aria-controls={menuOpen ? 'compact-analysis-settings-menu' : undefined}
          aria-haspopup="menu"
          aria-expanded={menuOpen ? 'true' : undefined}
          onClick={(event) => {
            settingsButtonRef.current = event.currentTarget;
            setAnchorElement(event.currentTarget);
          }}
          sx={{
            width: 40,
            height: 40,
            borderRadius: 1,
            border: '1px solid',
            borderColor: 'divider',
          }}
        >
          <SettingsOutlinedIcon sx={{ fontSize: 20 }} />
        </IconButton>
      </Tooltip>
      <Menu
        id="compact-analysis-settings-menu"
        anchorEl={anchorElement}
        open={menuOpen}
        onClose={closeMenu}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ list: { 'aria-label': 'Налаштування аналізу' } }}
      >
        <MenuItem
          role="menuitemcheckbox"
          aria-checked={page.newestFirst}
          onClick={() => page.setNewestFirst(!page.newestFirst)}
        >
          <ListItemIcon>
            <Switch
              size="small"
              checked={page.newestFirst}
              tabIndex={-1}
              disableRipple
              inputProps={{ 'aria-hidden': true }}
              sx={{ ml: -0.75 }}
            />
          </ListItemIcon>
          <ListItemText>Спочатку нові</ListItemText>
        </MenuItem>
        <MenuItem
          disabled={loading}
          onClick={() => {
            closeMenu();
            page.reload({ preserveMessagePage: true });
          }}
        >
          <ListItemIcon>
            {loading ? (
              <Skeleton variant="circular" width={20} height={20} />
            ) : (
              <RefreshOutlinedIcon fontSize="small" />
            )}
          </ListItemIcon>
          <ListItemText>Оновити</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            closeMenu();
            if (onOpenReport) {
              window.requestAnimationFrame(() => openReport(settingsButtonRef.current));
            } else {
              page.openReport();
            }
          }}
        >
          <ListItemIcon>
            <DescriptionOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Звіти</ListItemText>
        </MenuItem>
      </Menu>
    </>
  );
}

export function AnalysisPageHeader({
  page,
  centerTab,
  isCompactLayout = false,
  isNarrowLayout,
  leftPanelVisible,
  rightPanelVisible,
  onOpenReport,
}: Props) {
  const openReport = (focusTarget: HTMLElement) => {
    if (onOpenReport) {
      onOpenReport(focusTarget);
    } else {
      page.openReport();
    }
  };
  const loading = page.countsLoading || page.messagesLoading || page.summaryLoading;
  const dateRangeLoading = page.mapAttrs?.daterangeLoading === 'true';
  const showPagination = !isNarrowLayout;
  return (
    <PageHeader
      title="Аналіз"
      middle={
        isCompactLayout ? undefined : (
          <AnalysisHeaderControls
            queryState={page.queryState}
            updateQueryState={page.updateQueryState}
          />
        )
      }
      titleLeadingActions={
        <SidePanelToggleButton
          side="left"
          active={leftPanelVisible}
          label={leftPanelVisible ? 'Згорнути ліву панель' : 'Розгорнути ліву панель'}
          onClick={() => page.toggleLeftPanel()}
        />
      }
      titleLeadingGap={isCompactLayout ? 1 : 2}
      titleTrailing={
        isCompactLayout ? (
          <AnalysisHeaderControls
            queryState={page.queryState}
            updateQueryState={page.updateQueryState}
            isCompactLayout
          />
        ) : undefined
      }
      titleActionsGap={isCompactLayout ? 'auto' : isNarrowLayout ? 1 : undefined}
      pinTitleActionsToRight={isNarrowLayout && !isCompactLayout}
      titleActions={
        isNarrowLayout ? (
          <Stack direction="row" spacing={0.5} alignItems="center">
            <AnalysisSettingsMenu page={page} loading={loading} onOpenReport={onOpenReport} />
            <SidePanelToggleButton
              side="right"
              active={rightPanelVisible}
              label={rightPanelVisible ? 'Згорнути праву панель' : 'Розгорнути праву панель'}
              onClick={() => page.toggleRightPanel()}
            />
          </Stack>
        ) : undefined
      }
      middleGap={4}
      compactLayout={isCompactLayout}
      fullWidthActions={isNarrowLayout}
      actions={
        !isNarrowLayout ? (
          <Stack
            direction="row"
            spacing={{ xs: 0, sm: 1 }}
            alignItems="center"
            flexWrap="nowrap"
            justifyContent="flex-end"
            sx={{ width: '100%', minWidth: 0, flexShrink: 0 }}
            data-analysis-header-actions
          >
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
                  rangePageIndex={page.visibleMessagesPageIndex}
                  pageSize={ANALYSIS_MESSAGES_PAGE_SIZE}
                  messagesCount={page.messages.length}
                  totalCount={page.messagesTotalCount}
                  totalLoading={page.messagesTotalLoading}
                  loading={page.messagesLoading}
                  noMoreToLoad={page.noMoreToLoad}
                  busy={page.messagesPaging || page.messagesLoading}
                  jumpDisabled={page.directMessageNavigation != null}
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
                    {loading && !dateRangeLoading ? (
                      <Skeleton variant="circular" width={20} height={20} />
                    ) : (
                      <RefreshOutlinedIcon sx={{ fontSize: 20 }} />
                    )}
                  </IconButton>
                </span>
              </Tooltip>
              <Button
                variant="outlined"
                color="inherit"
                onClick={(event) => openReport(event.currentTarget)}
                title="Відкрити звіти"
                sx={{
                  height: 40,
                  px: 2,
                  display: { xs: 'none', md: 'inline-flex' },
                  ml: 1,
                  borderColor: 'divider',
                  '&:hover': { borderColor: 'text.secondary' },
                }}
              >
                Звіти
              </Button>
              <SidePanelToggleButton
                side="right"
                active={rightPanelVisible}
                label={rightPanelVisible ? 'Згорнути праву панель' : 'Розгорнути праву панель'}
                onClick={() => page.toggleRightPanel()}
              />
            </Stack>
          </Stack>
        ) : undefined
      }
    />
  );
}
