import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import KeyboardArrowDownOutlinedIcon from '@mui/icons-material/KeyboardArrowDownOutlined';
import KeyboardArrowLeftOutlinedIcon from '@mui/icons-material/KeyboardArrowLeftOutlined';
import KeyboardArrowUpOutlinedIcon from '@mui/icons-material/KeyboardArrowUpOutlined';
import MoreVertOutlinedIcon from '@mui/icons-material/MoreVertOutlined';
import { Box, IconButton, ListItemIcon, MenuItem, Paper, Stack, Tooltip } from '@mui/material';
import { useState } from 'react';

import type { Network } from '../../../../../Bindings';
import { PowerMenu } from '../../../components/PowerMenu';
import {
  buildCollapsedTopSummaryItems,
  buildTopSummarySections,
  formatActivityLabel,
  MainContentSections,
  NetworkDetailsLeftPanelSkeleton,
  TopSummaryRow,
  type MainInfoSnapshot,
  type Placement,
} from './NetworkDetailsLeftPanel.content';

function TopPanelActions({
  placement,
  collapsed,
  onToggleCollapsed,
  onPlacementChange,
  onCollapsedChange,
  mainInfoSnapshot,
  onCopyMainInfo,
}: {
  placement: Placement;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onPlacementChange: (placement: Placement) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  mainInfoSnapshot: MainInfoSnapshot;
  onCopyMainInfo: (snapshot: MainInfoSnapshot) => void;
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [pendingPlacement, setPendingPlacement] = useState<Placement | null>(null);
  const isMenuOpen = anchorEl !== null;
  const collapseLabel = collapsed ? 'Розгорнути панель' : 'Згорнути панель';
  const placementLabel = placement === 'left' ? 'Відображати зверху' : 'Відображати ліворуч';

  const handleMenuClose = () => {
    setAnchorEl(null);
  };

  const handleMenuExited = () => {
    if (pendingPlacement) {
      onPlacementChange(pendingPlacement);
      if (pendingPlacement === 'top') {
        onCollapsedChange(false);
      }
      setPendingPlacement(null);
    }
  };

  return (
    <>
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        sx={{ width: 'fit-content', flexShrink: 0 }}
        data-testid="network-details-panel-actions"
      >
        <Tooltip title="Дії" arrow>
          <span>
            <IconButton
              size="small"
              onClick={(event) => setAnchorEl(event.currentTarget)}
              aria-haspopup="true"
              aria-controls={isMenuOpen ? 'network-details-panel-menu' : undefined}
              aria-label="Дії панелі"
            >
              <MoreVertOutlinedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        {placement === 'top' ? (
          <Tooltip title={collapseLabel} arrow>
            <span>
              <IconButton size="small" onClick={onToggleCollapsed} aria-label={collapseLabel}>
                {collapsed ? (
                  <KeyboardArrowDownOutlinedIcon fontSize="small" />
                ) : (
                  <KeyboardArrowUpOutlinedIcon fontSize="small" />
                )}
              </IconButton>
            </span>
          </Tooltip>
        ) : null}
      </Stack>

      <PowerMenu
        id="network-details-panel-menu"
        anchorEl={anchorEl}
        open={isMenuOpen}
        onClose={handleMenuClose}
        TransitionProps={{ onExited: handleMenuExited }}
        slotProps={{ paper: { sx: { minWidth: 260 } } }}
      >
        <MenuItem
          onClick={() => {
            setPendingPlacement(placement === 'left' ? 'top' : 'left');
            handleMenuClose();
          }}
        >
          <ListItemIcon>
            {placement === 'left' ? (
              <KeyboardArrowUpOutlinedIcon fontSize="small" />
            ) : (
              <KeyboardArrowLeftOutlinedIcon fontSize="small" />
            )}
          </ListItemIcon>
          {placementLabel}
        </MenuItem>
        <MenuItem
          onClick={() => {
            handleMenuClose();
            onCopyMainInfo(mainInfoSnapshot);
          }}
        >
          <ListItemIcon>
            <ContentCopyOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Копіювати основне
        </MenuItem>
      </PowerMenu>
    </>
  );
}

type Props = {
  placement: Placement;
  collapsed: boolean;
  isLoading: boolean;
  unitNames: string[];
  network: Network | null;
  aorVisible: Array<{ id: number; label: string }>;
  aorCollapsedCount: number;
  showAllAors: boolean;
  onToggleShowAllAors: () => void;
  callsignCount: number | null;
  statusTone: 'success' | 'warning';
  statusLabel: string;
  rangeLabel: string;
  transferTypeLabel: string;
  postItems: Array<{ id: number; label: string }>;
  onPlacementChange: (placement: Placement) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  onToggleCollapsed: () => void;
  onCopyMainInfo: (snapshot: MainInfoSnapshot) => void;
};

export function NetworkDetailsLeftPanel({
  placement,
  collapsed,
  isLoading,
  unitNames,
  network,
  aorVisible,
  aorCollapsedCount,
  showAllAors,
  onToggleShowAllAors,
  callsignCount,
  statusTone,
  statusLabel,
  rangeLabel,
  transferTypeLabel,
  postItems,
  onPlacementChange,
  onCollapsedChange,
  onToggleCollapsed,
  onCopyMainInfo,
}: Props) {
  const isTopPlacement = placement === 'top';
  const compact = isTopPlacement;
  const aorLabels = aorVisible.map((item) => item.label);
  const activityLabel = formatActivityLabel(network, statusTone, statusLabel);
  const mainInfoSnapshot: MainInfoSnapshot = {
    unitNames,
    location: network?.location,
    aorLabels,
    aorCollapsedCount,
    callsignCount,
    activityLabel,
  };
  const topSummarySections = buildTopSummarySections({
    snapshot: mainInfoSnapshot,
    network,
    rangeLabel,
    transferTypeLabel,
    postItems,
  });
  const collapsedTopSummaryItems = buildCollapsedTopSummaryItems({
    snapshot: mainInfoSnapshot,
    network,
    statusTone,
  });
  const showCollapsedTopSummary = isTopPlacement && collapsed && !isLoading;

  return (
    <Paper
      variant="outlined"
      sx={{
        height: isTopPlacement ? 'auto' : '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        overflow: isTopPlacement ? 'hidden' : 'auto',
      }}
    >
      <Box
        sx={{
          minHeight: 0,
          p: isTopPlacement ? 1.5 : 2,
          pt: isTopPlacement ? (collapsed ? 1.5 : 2) : 2,
          pr: isTopPlacement ? 1.5 : 4,
          display: 'flex',
          flexDirection: 'column',
          gap: isTopPlacement ? 1.5 : 2.5,
          boxSizing: 'border-box',
          overflow: 'visible',
          position: 'relative',
        }}
      >
        {showCollapsedTopSummary ? (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto',
              alignItems: 'center',
              gap: 1.5,
              minWidth: 0,
            }}
            data-testid="network-details-panel-collapsed-summary"
          >
            <Box sx={{ minWidth: 0 }}>
              <TopSummaryRow items={collapsedTopSummaryItems} />
            </Box>
            <Box data-testid="network-details-panel-actions">
              <TopPanelActions
                placement={placement}
                collapsed={collapsed}
                onToggleCollapsed={onToggleCollapsed}
                onPlacementChange={onPlacementChange}
                onCollapsedChange={onCollapsedChange}
                mainInfoSnapshot={mainInfoSnapshot}
                onCopyMainInfo={onCopyMainInfo}
              />
            </Box>
          </Box>
        ) : (
          <Box
            sx={{ position: 'absolute', top: 12, right: 12, zIndex: 1 }}
            data-testid="network-details-panel-actions"
          >
            <TopPanelActions
              placement={placement}
              collapsed={collapsed}
              onToggleCollapsed={onToggleCollapsed}
              onPlacementChange={onPlacementChange}
              onCollapsedChange={onCollapsedChange}
              mainInfoSnapshot={mainInfoSnapshot}
              onCopyMainInfo={onCopyMainInfo}
            />
          </Box>
        )}

        {isLoading ? (
          <NetworkDetailsLeftPanelSkeleton placement={placement} />
        ) : showCollapsedTopSummary ? null : (
          <MainContentSections
            layout={placement}
            compact={compact}
            unitNames={unitNames}
            network={network}
            aorVisible={aorVisible}
            aorCollapsedCount={aorCollapsedCount}
            showAllAors={showAllAors}
            onToggleShowAllAors={onToggleShowAllAors}
            callsignCount={callsignCount}
            statusTone={statusTone}
            statusLabel={statusLabel}
            rangeLabel={rangeLabel}
            transferTypeLabel={transferTypeLabel}
            postItems={postItems}
          />
        )}
      </Box>
    </Paper>
  );
}
