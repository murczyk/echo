import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import MoreVertOutlinedIcon from '@mui/icons-material/MoreVertOutlined';
import { Box, Button, Chip, Divider, IconButton, Menu, MenuItem, Paper, Skeleton, Stack, Switch, Tooltip, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useState, type ReactNode } from 'react';
import { useTheme } from '@mui/material/styles';

import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { PageErrorState } from '../../components/PageErrorState';
import { PageHeader } from '../../components/PageHeader';
import { PowerAlert } from '../../components/PowerAlert';
import { navigateWithinSpa } from '../../utils/browser';
import { useRerNetworkDetailsNeoPage } from './use-rer-network-details-neo-page';
import { NetworkEditDrawer } from './components/NetworkEditDrawer';

type Props = {
  networkId: number;
};

function FieldRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: '180px minmax(0,1fr)' },
        gap: 1,
        alignItems: 'start',
      }}
    >
      <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 600 }}>
        {label}
      </Typography>
      <Box sx={{ minWidth: 0 }}>{value}</Box>
    </Box>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <Typography
      variant="overline"
      sx={{
        display: 'block',
        fontSize: '0.95rem',
        lineHeight: 1.2,
        fontWeight: 700,
        letterSpacing: '0.04em',
        color: 'text.secondary',
      }}
    >
      {children}
    </Typography>
  );
}

function ChipList({ labels, collapsedCountLabel, onToggleCollapsed, collapsed }: {
  labels: string[];
  collapsedCountLabel?: string;
  onToggleCollapsed?: () => void;
  collapsed?: boolean;
}) {
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
      {labels.map((label) => (
        <Chip key={label} size="small" label={label} />
      ))}
      {collapsedCountLabel && onToggleCollapsed ? (
        <Button size="small" onClick={onToggleCollapsed} variant="text" sx={{ minWidth: 0, px: 0.5 }}>
          {collapsed ? collapsedCountLabel : 'Згорнути'}
        </Button>
      ) : null}
    </Stack>
  );
}

function formatNetworkName(networkName: string | null | undefined): string {
  const value = networkName?.trim() ?? '';
  return value === '' ? '—' : value;
}

function formatClassicNetworkHeaderName(networkName: string | null | undefined, unitNames: string[]): string {
  const name = networkName?.trim() ?? '';
  const units = unitNames.map((unitName) => unitName.trim()).filter((unitName) => unitName !== '');

  if (name === '' && units.length === 0) {
    return '—';
  }

  return ['р/м', name, units.join(', ')].filter((part) => part !== '').join(' ');
}

function formatUnitLabel(unitCount: number): string {
  return unitCount === 1 ? 'Підрозділ' : 'Підрозділи';
}

function formatDateOnly(value: number | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function LeftPanelSkeleton() {
  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Paper
        variant="outlined"
        sx={{
          height: '100%',
          minHeight: 0,
          p: 2,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          overflow: 'hidden',
        }}
      >
        <Skeleton variant="text" width="28%" height={28} />
        <Skeleton variant="rounded" height={28} />
        <Skeleton variant="rounded" height={88} />
        <Skeleton variant="rounded" height={28} />
        <Skeleton variant="rounded" height={28} />
        <Skeleton variant="text" width="24%" height={28} />
        <Skeleton variant="rounded" height={28} />
        <Skeleton variant="rounded" height={28} />
        <Skeleton variant="rounded" height={88} />
        <Skeleton variant="text" width="24%" height={28} />
        <Skeleton variant="rounded" height={28} />
        <Skeleton variant="rounded" height={28} />
        <Skeleton variant="rounded" height={28} />
      </Paper>
    </Box>
  );
}

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
        <MenuItem onClick={page.openDeleteDialog} disabled={!page.canDelete || !page.network} sx={{ color: 'error.main' }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <DeleteIcon fontSize="small" />
            <span>Видалити</span>
          </Stack>
        </MenuItem>
      </Menu>
    </Stack>
  );

  const isLoading = page.loading && !page.network;

  if (page.error && !page.network) {
    return <PageErrorState message={page.error} actionLabel="Спробувати ще раз" onAction={page.reload} />;
  }

  return (
    <Box
      sx={{
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        overflow: 'hidden',
      }}
    >
      <PageHeader
        title={title}
        actions={actions}
      />

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
        <Paper
          variant="outlined"
          sx={{
            minHeight: 0,
            p: 2,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'auto',
          }}
        >
          {isLoading ? (
            <LeftPanelSkeleton />
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, boxSizing: 'border-box' }}>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <SectionTitle>Основне</SectionTitle>
                <FieldRow
                  label={formatUnitLabel(page.unitNames.length)}
                  value={
                    page.unitNames.length > 0 ? (
                      <Typography
                        variant="body2"
                        sx={{
                          whiteSpace: 'normal',
                          overflowWrap: 'anywhere',
                          wordBreak: 'break-word',
                        }}
                      >
                        {page.unitNames.join(', ')}
                      </Typography>
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        —
                      </Typography>
                    )
                  }
                />
                <FieldRow
                  label="Район функціонування"
                  value={<Typography variant="body2">{formatNetworkName(page.network?.location)}</Typography>}
                />
                <FieldRow
                  label="Смуги"
                  value={
                    page.aorItems.length > 0 ? (
                      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                        {aorVisible.map((item) => (
                          <Chip key={item.id} size="small" label={item.label} />
                        ))}
                        {aorCollapsedCount > 0 ? (
                          <Button size="small" onClick={() => setShowAllAors((current) => !current)} sx={{ minWidth: 0, px: 0.5 }}>
                            {showAllAors ? 'Згорнути' : `+${aorCollapsedCount}`}
                          </Button>
                        ) : null}
                      </Stack>
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        —
                      </Typography>
                    )
                  }
                />
                <FieldRow
                  label="Склад кореспондентів"
                  value={<Typography variant="body2">{page.callsignCount ?? '—'}</Typography>}
                />
                <FieldRow
                  label="Активність"
                  value={
                    page.status.tone === 'success' && page.network?.activeFrom ? (
                      <Typography variant="body2" sx={{ color: 'success.main', fontWeight: 700 }}>
                        {formatDateOnly(page.network.activeFrom)} — досі
                      </Typography>
                    ) : (
                      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                        <Chip size="small" color={page.status.tone === 'success' ? 'success' : 'warning'} label={page.status.label} />
                      </Stack>
                    )
                  }
                />
              </Box>

              <Divider />

              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <SectionTitle>Операційні</SectionTitle>
                <FieldRow label="Призначення" value={<Typography variant="body2">{formatNetworkName(page.network?.purpose)}</Typography>} />
                <FieldRow label="Діапазон" value={<Typography variant="body2">{page.rangeLabel}</Typography>} />
                <FieldRow label="Тип передачі" value={<Typography variant="body2">{page.transferTypeLabel}</Typography>} />
                <FieldRow label="Режим" value={<Typography variant="body2">{formatNetworkName(page.network?.operationMode)}</Typography>} />
                <FieldRow label="Характер" value={<Typography variant="body2">{formatNetworkName(page.network?.operationType)}</Typography>} />
                <FieldRow
                  label="Період функціонування"
                  value={<Typography variant="body2">{formatNetworkName(page.network?.operationPeriod)}</Typography>}
                />
                <FieldRow
                  label="Пости"
                  value={
                    page.postItems.length > 0 ? (
                      <ChipList labels={page.postItems.map((item) => item.label)} />
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        —
                      </Typography>
                    )
                  }
                />
                <FieldRow
                  label="Радіостанція"
                  value={
                    page.network?.radioStation?.trim() ? (
                      <Typography variant="body2">{formatNetworkName(page.network.radioStation)}</Typography>
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        —
                      </Typography>
                    )
                  }
                />
              </Box>

              <Divider />

              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <SectionTitle>Додатково</SectionTitle>
                <FieldRow label="Створено" value={<Typography variant="body2">{formatDateOnly(page.network?.createdAt)}</Typography>} />
                <FieldRow label="Оновлено" value={<Typography variant="body2">{formatDateOnly(page.network?.lastUpdatedAt)}</Typography>} />
                <FieldRow
                  label="Оператор"
                  value={<Typography variant="body2">{formatNetworkName(page.network?.lastUpdatedBy)}</Typography>}
                />
              </Box>
            </Box>
          )}
        </Paper>

        <Paper
          variant="outlined"
          sx={{
            minHeight: 0,
            overflow: 'hidden',
          }}
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
