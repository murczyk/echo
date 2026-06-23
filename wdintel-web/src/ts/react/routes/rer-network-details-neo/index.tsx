import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import MoreVertOutlinedIcon from '@mui/icons-material/MoreVertOutlined';
import SummarizeOutlinedIcon from '@mui/icons-material/SummarizeOutlined';
import {
  Box,
  Button,
  IconButton,
  Menu,
  MenuItem,
  Skeleton,
  Stack,
  Tooltip,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useEffect, useState } from 'react';

import { PageErrorState } from '../../components/PageErrorState';
import { PageHeader } from '../../components/PageHeader';
import { PowerAlert } from '../../components/PowerAlert';
import { SidePanelToggleButton } from '../../components/SidePanelToggleButton';
import { navigateWithinSpa } from '../../utils/browser';
import { formatClassicNetworkHeaderName } from './use-rer-network-details-neo-page.shared';
import { NetworkDetailsNeoPageBody } from './components/NetworkDetailsNeoPageBody';
import { NetworkDetailsNeoPageDialogs } from './components/NetworkDetailsNeoPageDialogs';
import { useRerNetworkDetailsNeoPage } from './use-rer-network-details-neo-page';
import {
  buildRerNetworkDetailsHref,
  saveRerNetworkDetailsPreferredView,
} from './network-details-preference';

const PANEL_PLACEMENT_STORAGE_KEY = 'rer-network-details-neo.panelPlacement';
const TOP_PANEL_COLLAPSED_STORAGE_KEY = 'rer-network-details-neo.topPanelCollapsed';

type PanelPlacement = 'left' | 'top';

type Props = {
  networkId: number;
};

function readStoredPanelPlacement(): PanelPlacement {
  if (typeof window === 'undefined') {
    return 'left';
  }

  const value = window.localStorage.getItem(PANEL_PLACEMENT_STORAGE_KEY);
  return value === 'top' ? 'top' : 'left';
}

function readStoredTopPanelCollapsed(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.localStorage.getItem(TOP_PANEL_COLLAPSED_STORAGE_KEY) === 'true';
}

function buildPageTitle(
  network: { name?: string | null } | null,
  unitNames: string[],
  status: { label: string; tone: 'success' | 'warning' },
) {
  if (!network) {
    return <Skeleton width={240} />;
  }

  return (
    <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, lineHeight: 'inherit' }}>
      <Tooltip title={status.label} arrow placement="bottom-start">
        <Box
          component="span"
          aria-label={status.label}
          sx={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            bgcolor: status.tone === 'success' ? 'success.main' : 'warning.main',
            flexShrink: 0,
            cursor: 'default',
          }}
        />
      </Tooltip>
      <Box component="span" sx={{ display: 'block', minWidth: 0, lineHeight: 'inherit' }}>
        {formatClassicNetworkHeaderName(network?.name, unitNames)}
      </Box>
    </Box>
  );
}

export function RerNetworkDetailsNeoPage({ networkId }: Props) {
  const page = useRerNetworkDetailsNeoPage(networkId);
  const theme = useTheme();
  const isMobileLayout = useMediaQuery(theme.breakpoints.down('sm'));
  const [showAllAors, setShowAllAors] = useState(false);
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [panelPlacement, setPanelPlacement] = useState<PanelPlacement>(readStoredPanelPlacement);
  const [topPanelCollapsed, setTopPanelCollapsed] = useState(readStoredTopPanelCollapsed);

  useEffect(() => {
    window.localStorage.setItem(PANEL_PLACEMENT_STORAGE_KEY, panelPlacement);
  }, [panelPlacement]);

  useEffect(() => {
    window.localStorage.setItem(TOP_PANEL_COLLAPSED_STORAGE_KEY, String(topPanelCollapsed));
  }, [topPanelCollapsed]);

  useEffect(() => {
    saveRerNetworkDetailsPreferredView('neo');
  }, []);

  const isTopPanel = panelPlacement === 'top';
  const leftPanelVisible = !isTopPanel && (isMobileLayout || leftPanelOpen);
  const classicHref = buildRerNetworkDetailsHref(networkId, 'classic');
  const aorVisible = showAllAors ? page.aorItems : page.aorItems.slice(0, 5);
  const aorCollapsedCount = Math.max(page.aorItems.length - aorVisible.length, 0);
  const editFreq = page.freqEditDrawerForm
    ? page.freqs.find((freq) => freq.networkFreqId === page.freqEditDrawerForm?.networkFreqId) ?? null
    : null;
  const techFreq = page.freqTechDrawerForm
    ? page.freqs.find((freq) => freq.networkFreqId === page.freqTechDrawerForm?.networkFreqId) ?? null
    : null;
  const title = buildPageTitle(page.network, page.unitNames, page.status);
  const toggleSidePanelLabel = isTopPanel
    ? 'Панель відображається зверху'
    : leftPanelVisible
      ? 'Згорнути ліву панель'
      : 'Розгорнути ліву панель';

  if (page.error && !page.network) {
    return <PageErrorState message={page.error} actionLabel="Спробувати ще раз" onAction={page.reload} />;
  }

  return (
    <Box sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' }}>
      <PageHeader
        title={title}
        titleLeadingActions={
          !isMobileLayout ? (
            <SidePanelToggleButton
              side="left"
              active={leftPanelVisible}
              label={toggleSidePanelLabel}
              onClick={() => setLeftPanelOpen((current) => !current)}
              disabled={isTopPanel}
            />
          ) : null
        }
        titleLeadingGap={2}
        actions={
          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              component="a"
              href="/rer-networks-neo"
            >
              До списку мереж
            </Button>
            <Button
              onClick={() => {
                saveRerNetworkDetailsPreferredView('classic');
                navigateWithinSpa(classicHref);
              }}
            >
              До класичної версії
            </Button>
            <Tooltip title="Скопіювати назву і район">
              <span>
                <IconButton
                  onClick={page.handleCopyNetworkInfo}
                  disabled={!page.network}
                  aria-label="Скопіювати назву і район мережі"
                >
                  <ContentCopyOutlinedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Дії">
              <IconButton
                onClick={(event) => page.openMenu(event.currentTarget)}
                aria-haspopup="true"
                aria-controls={page.menuAnchorEl ? 'network-details-actions-menu' : undefined}
                aria-label="Дії з мережею"
              >
                <MoreVertOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Menu
              id="network-details-actions-menu"
              open={page.menuAnchorEl !== null}
              anchorEl={page.menuAnchorEl}
              onClose={page.closeMenu}
            >
              <MenuItem onClick={page.openEditDrawer} disabled={!page.canEdit || !page.network}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <EditIcon fontSize="small" />
                  <span>Редагувати</span>
                </Stack>
              </MenuItem>
              <MenuItem onClick={page.openEtalonkaReportDialog} disabled={!page.network}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <SummarizeOutlinedIcon fontSize="small" />
                  <span>Еталонний опис</span>
                </Stack>
              </MenuItem>
              <MenuItem onClick={page.openDeleteDialog} disabled={!page.canDelete || !page.network} sx={{ color: 'error.main' }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <DeleteIcon fontSize="small" />
                  <span>Видалити</span>
                </Stack>
              </MenuItem>
            </Menu>
          </Stack>
        }
      />

      {page.error ? <PowerAlert severity="error">{page.error}</PowerAlert> : null}
      {page.referenceWarning ? <PowerAlert severity="warning">{page.referenceWarning}</PowerAlert> : null}
      {page.callsignWarning ? <PowerAlert severity="warning">{page.callsignWarning}</PowerAlert> : null}
      {page.copyStatus ? (
        <PowerAlert severity={page.copyStatusTone === 'error' ? 'error' : 'success'}>{page.copyStatus}</PowerAlert>
      ) : null}

      <NetworkDetailsNeoPageBody
        page={page}
        networkId={networkId}
        leftPanelVisible={leftPanelVisible}
        panelPlacement={panelPlacement}
        topPanelCollapsed={topPanelCollapsed}
        showAllAors={showAllAors}
      onToggleShowAllAors={() => setShowAllAors((current) => !current)}
      onSetPanelPlacement={setPanelPlacement}
      onSetTopPanelCollapsed={setTopPanelCollapsed}
      onToggleTopPanelCollapsed={() => setTopPanelCollapsed((current) => !current)}
    />
      <NetworkDetailsNeoPageDialogs page={page} editFreq={editFreq} techFreq={techFreq} />
    </Box>
  );
}
