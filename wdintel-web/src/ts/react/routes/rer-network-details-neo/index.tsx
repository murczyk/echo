import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import MoreVertOutlinedIcon from '@mui/icons-material/MoreVertOutlined';
import {
  Box,
  Chip,
  IconButton,
  Menu,
  MenuItem,
  Skeleton,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { useState } from 'react';

import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { PageErrorState } from '../../components/PageErrorState';
import { PageHeader } from '../../components/PageHeader';
import { PowerAlert } from '../../components/PowerAlert';
import { navigateWithinSpa } from '../../utils/browser';
import { NetworkDescriptionDrawer } from './components/NetworkDescriptionDrawer';
import { NetworkDetailsJustificationsPanel } from './components/NetworkDetailsJustificationsPanel';
import { NetworkDetailsLeftPanel } from './components/NetworkDetailsLeftPanel';
import { NetworkEditDrawer } from './components/NetworkEditDrawer';
import { useRerNetworkDetailsNeoPage } from './use-rer-network-details-neo-page';
import { formatClassicNetworkHeaderName } from './use-rer-network-details-neo-page.shared';

type Props = {
  networkId: number;
};

export function RerNetworkDetailsNeoPage({ networkId }: Props) {
  const page = useRerNetworkDetailsNeoPage(networkId);
  const theme = useTheme();
  const [showAllAors, setShowAllAors] = useState(false);
  const aorVisible = showAllAors ? page.aorItems : page.aorItems.slice(0, 5);
  const aorCollapsedCount = Math.max(page.aorItems.length - aorVisible.length, 0);
  const statusDotColor = page.status.tone === 'success' ? 'success.main' : 'warning.main';
  const classicHref = `/rer-networks/${networkId}`;
  const title = page.network ? (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
      <Tooltip title={page.status.label} arrow placement="bottom-start">
        <Box
          component="span"
          aria-label={page.status.label}
          sx={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            bgcolor: statusDotColor,
            flexShrink: 0,
            cursor: 'default',
          }}
        />
      </Tooltip>
      <Box component="span" sx={{ minWidth: 0 }}>
        {formatClassicNetworkHeaderName(page.network.name, page.unitNames)}
      </Box>
    </Box>
  ) : (
    <Skeleton width={240} />
  );
  const isDark = theme.palette.mode === 'dark';
  const copyText = page.network ? `${formatClassicNetworkHeaderName(page.network.name, page.unitNames)}, ${page.network.location}` : '';
  const descriptionDrawerNetwork = page.network;
  const isLoading = page.loading && !page.network;

  const actions = (
    <Stack direction="row" spacing={1} alignItems="center">
      <Box
        component="button"
        type="button"
        onClick={() => navigateWithinSpa(classicHref)}
        aria-label="Перейти на стару версію"
        sx={{
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 1.5,
          border: 'none',
          borderRadius: 0,
          bgcolor: 'transparent',
          px: 0,
          py: 0,
          cursor: 'pointer',
          color: 'inherit',
          '&:hover': {
            bgcolor: 'transparent',
          },
          '&:focus-visible': {
            outline: 'none',
          },
        }}
      >
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 0 }}>
          <Switch
            checked
            disableRipple
            sx={{
              pointerEvents: 'none',
              width: 42,
              height: 26,
              p: 0,
              '& .MuiSwitch-switchBase': {
                p: 0.5,
                transitionDuration: '150ms',
                '&.Mui-checked': {
                  transform: 'translateX(16px)',
                  color: '#9cc9fb',
                },
              },
              '& .MuiSwitch-thumb': {
                width: 18,
                height: 18,
                boxShadow: '0 1px 2px rgba(0, 0, 0, 0.25)',
                bgcolor: '#9cc9fb',
              },
              '& .MuiSwitch-track': {
                borderRadius: 999,
                bgcolor: isDark ? '#55647a' : '#6d7f98',
                opacity: 1,
              },
            }}
          />
          <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ minWidth: 0 }}>
            <Typography component="span" sx={{ fontSize: '1rem', fontWeight: 400, color: isDark ? '#a9ccf2' : '#9cc9fb' }}>
              Нова версія
            </Typography>
            <Chip
              label="ALPHA"
              size="small"
              sx={{
                height: 24,
                fontSize: '0.72rem',
                fontWeight: 400,
                letterSpacing: '0.18em',
                color: isDark ? '#f2b15c' : '#b85b16',
                bgcolor: isDark ? alpha(theme.palette.warning.main, 0.12) : '#fff7dd',
                border: 'none',
                '& .MuiChip-label': { px: 1.1 },
              }}
            />
          </Stack>
        </Stack>
      </Box>
      <Tooltip title="Скопіювати назву і район">
        <span>
          <IconButton
            onClick={page.handleCopyNetworkInfo}
            disabled={!page.network}
            aria-label="Скопіювати назву і район мережі"
            title={copyText}
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
      <Menu id="network-details-actions-menu" open={page.menuAnchorEl !== null} anchorEl={page.menuAnchorEl} onClose={page.closeMenu}>
        <MenuItem onClick={page.openEditDrawer} disabled={!page.canEdit || !page.network}>
          <Stack direction="row" spacing={1} alignItems="center">
            <EditIcon fontSize="small" />
            <span>Редагувати</span>
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
  );

  if (page.error && !page.network) {
    return <PageErrorState message={page.error} actionLabel="Спробувати ще раз" onAction={page.reload} />;
  }

  return (
    <Box sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' }}>
      <PageHeader title={title} actions={actions} />

      {page.error ? <PowerAlert severity="error">{page.error}</PowerAlert> : null}
      {page.referenceWarning ? <PowerAlert severity="warning">{page.referenceWarning}</PowerAlert> : null}
      {page.callsignWarning ? <PowerAlert severity="warning">{page.callsignWarning}</PowerAlert> : null}

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', lg: 'minmax(360px, 420px) minmax(0,1fr)' },
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            minHeight: 0,
            overflow: 'auto',
          }}
        >
          <NetworkDetailsLeftPanel
            isLoading={isLoading}
            unitNames={page.unitNames}
            network={page.network}
            aorVisible={aorVisible}
            aorCollapsedCount={aorCollapsedCount}
            showAllAors={showAllAors}
            onToggleShowAllAors={() => setShowAllAors((current) => !current)}
            callsignCount={page.callsignCount}
            statusTone={page.status.tone}
            statusLabel={page.status.label}
            rangeLabel={page.rangeLabel}
            transferTypeLabel={page.transferTypeLabel}
            postItems={page.postItems}
          />
        </Box>

        <NetworkDetailsJustificationsPanel
          network={descriptionDrawerNetwork}
          loading={page.loading}
          descriptions={page.confirmationDescriptions}
          canManage={page.canManageDescriptionActions}
          expandedDescriptionIds={page.expandedDescriptionIds}
          onToggleExpanded={page.toggleDescriptionExpanded}
          onEdit={page.openDescriptionDrawerForEdit}
          onDelete={page.openDeleteDescriptionDialog}
          onCreate={page.openDescriptionDrawerForCreate}
        />
      </Box>

      <ConfirmDangerDialog
        open={page.deleteDialogOpen}
        onClose={page.closeDeleteDialog}
        onConfirm={page.handleDelete}
        title="Підтвердження видалення"
        description={`Видалити мережу «${formatClassicNetworkHeaderName(page.network?.name, page.unitNames)}»?`}
        submitting={page.deleteInProgress}
        disabled={!page.canDelete}
      />

      <ConfirmDangerDialog
        open={page.deleteDescriptionDialogOpen}
        onClose={page.closeDeleteDescriptionDialog}
        onConfirm={page.deleteDescription}
        title="Видалити обґрунтування"
        description="Ви впевнені, що хочете видалити це обґрунтування?"
        submitting={page.deleteDescriptionSubmitting}
        disabled={!page.canManageDescriptionActions || page.deleteDescriptionTarget === null}
      >
        {page.deleteDescriptionError ? <PowerAlert severity="error">{page.deleteDescriptionError}</PowerAlert> : null}
      </ConfirmDangerDialog>

      <NetworkDescriptionDrawer
        open={page.descriptionDrawerOpen}
        mode={page.descriptionDrawerMode}
        form={page.descriptionDrawerForm}
        saving={page.descriptionDrawerSaving}
        error={page.descriptionDrawerError}
        networkFreqs={descriptionDrawerNetwork?.freqs ?? []}
        onClose={page.closeDescriptionDrawer}
        onChange={page.setDescriptionDrawerForm}
        onSave={page.saveDescription}
      />

      <NetworkEditDrawer
        open={page.editDrawerOpen}
        form={page.editForm}
        saving={page.editInProgress}
        error={page.editError}
        referenceLoading={page.referenceLoading}
        aorOptions={page.aorOptions}
        unitOptions={page.unitOptions}
        postOptions={page.postOptions}
        onClose={page.closeEditDrawer}
        onChange={page.setEditForm}
        onSave={page.saveNetworkEdit}
      />
    </Box>
  );
}
