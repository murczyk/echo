import AddIcon from '@mui/icons-material/Add';
import HearingOutlinedIcon from '@mui/icons-material/HearingOutlined';
import MoreVertOutlinedIcon from '@mui/icons-material/MoreVertOutlined';
import { Box, Button, Chip, CircularProgress, ListItemIcon, MenuItem, Skeleton, Stack } from '@mui/material';
import { useState } from 'react';

import type { NetworkCallsignInterceptedView } from '../network-callsigns.types';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerMenu } from '../../../components/PowerMenu';
import { formatCountLabel } from './NetworkCallsignsTableShared';
import { normalizeCallsignDisplay } from '../network-callsigns.utils';
import { NetworkDetailsEmptyState } from './NetworkDetailsEmptyState';

type InterceptedPanelProps = {
  rows: NetworkCallsignInterceptedView[];
  canManage: boolean;
  expanded: boolean;
  loading: boolean;
  loadingError: string | null;
  mutationBusy: boolean;
  onToggleExpanded: () => void;
  onAddToDeveloping: (callsign: string) => void;
  onAddToNetwork: (callsign: string) => void;
  inFlightCreateCallsigns: string[];
};

function InterceptedCallsignChip({
  item,
  canManage,
  onAddToDeveloping,
  onAddToNetwork,
  inFlightCreateCallsigns,
}: {
  item: NetworkCallsignInterceptedView;
  canManage: boolean;
  onAddToDeveloping: (callsign: string) => void;
  onAddToNetwork: (callsign: string) => void;
  inFlightCreateCallsigns: string[];
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const normalizedCallsign = normalizeCallsignDisplay(item.callsign);
  const isInFlight = inFlightCreateCallsigns.includes(normalizedCallsign);

  return (
    <>
      <Chip
        label={
          <Stack direction="row" spacing={0.75} alignItems="center">
            <span>{normalizedCallsign}</span>
            <Chip
              size="small"
              label={formatCountLabel(item.messageCount)}
              sx={{
                height: 20,
                fontSize: '0.72rem',
                fontWeight: 700,
                bgcolor: 'action.selected',
                color: 'text.primary',
                '& .MuiChip-label': { px: 0.75 },
              }}
            />
            {canManage ? <MoreVertOutlinedIcon fontSize="small" sx={{ opacity: 0.75 }} /> : null}
          </Stack>
        }
        onClick={(event) => {
          if (!canManage) return;
          setAnchorEl(event.currentTarget);
        }}
        clickable={canManage}
        variant="outlined"
        sx={{
          height: 34,
          maxWidth: '100%',
          bgcolor: 'transparent',
          borderColor: 'divider',
          '& .MuiChip-label': {
            display: 'inline-flex',
            alignItems: 'center',
            px: 1,
            py: 0.25,
          },
        }}
      />
      <PowerMenu anchorEl={anchorEl} open={anchorEl !== null} onClose={() => setAnchorEl(null)} slotProps={{ paper: { sx: { minWidth: 250 } } }}>
        <MenuItem
          onClick={() => {
            setAnchorEl(null);
            onAddToDeveloping(normalizedCallsign);
          }}
          disabled={!canManage || isInFlight}
        >
          <ListItemIcon>
            <AddIcon fontSize="small" />
          </ListItemIcon>
          Додати в дорозвідку
        </MenuItem>
        <MenuItem
          onClick={() => {
            setAnchorEl(null);
            onAddToNetwork(normalizedCallsign);
          }}
          disabled={!canManage || isInFlight}
        >
          <ListItemIcon>
            <AddIcon fontSize="small" />
          </ListItemIcon>
          Додати в позивні мережі
        </MenuItem>
      </PowerMenu>
    </>
  );
}

function InterceptedLoadingSkeleton() {
  return (
    <Stack spacing={1.25} sx={{ width: '100%', minHeight: 126, justifyContent: 'center', py: 1 }}>
      {Array.from({ length: 4 }).map((_, index) => (
        <Skeleton key={index} variant="rounded" height={34} />
      ))}
    </Stack>
  );
}

export function NetworkCallsignsInterceptedPanel({
  rows,
  canManage,
  expanded,
  loading,
  loadingError,
  mutationBusy,
  onToggleExpanded,
  onAddToDeveloping,
  onAddToNetwork,
  inFlightCreateCallsigns,
}: InterceptedPanelProps) {
  if (loading && rows.length === 0) {
    return (
      <Box
        sx={{
          px: 2,
          py: 1.5,
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 2,
          bgcolor: 'background.paper',
          minHeight: 126,
        }}
      >
        <InterceptedLoadingSkeleton />
      </Box>
    );
  }

  const visibleRows = expanded ? rows : rows.slice(0, 10);
  const overflowCount = Math.max(rows.length - visibleRows.length, 0);
  const showEmptyState = !loading && rows.length === 0;

  return (
    <Box
      sx={{
        px: 2,
        py: 1.5,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 2,
        bgcolor: 'background.paper',
        flex: '0 0 auto',
        minHeight: 0,
        position: 'relative',
        overflowY: 'visible',
      }}
    >
      <Stack spacing={1.5} sx={{ minHeight: 0 }}>
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'flex-start',
            alignContent: 'flex-start',
            gap: 1.25,
            width: '100%',
          }}
        >
          {visibleRows.map((item) => (
            <InterceptedCallsignChip
              key={item.callsign}
              item={item}
              canManage={canManage}
              onAddToDeveloping={onAddToDeveloping}
              onAddToNetwork={onAddToNetwork}
              inFlightCreateCallsigns={inFlightCreateCallsigns}
            />
          ))}
        </Box>
        {!expanded && overflowCount > 0 ? (
          <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
            <Button size="small" onClick={onToggleExpanded}>
              Показати ще {overflowCount}
            </Button>
          </Box>
        ) : null}
        {expanded && rows.length > 10 ? (
          <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
            <Button size="small" onClick={onToggleExpanded}>
              Згорнути
            </Button>
          </Box>
        ) : null}
        {loadingError ? (
          <PowerAlert severity="error">{loadingError}</PowerAlert>
        ) : null}
        {showEmptyState ? (
          <NetworkDetailsEmptyState
            icon={<HearingOutlinedIcon />}
            title="Немає перехоплених позивних без каталогу"
            minHeight={180}
          />
        ) : null}
      </Stack>
      {mutationBusy ? (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'rgba(0, 0, 0, 0.12)',
            borderRadius: 2,
            pointerEvents: 'none',
          }}
        >
          <CircularProgress size={26} />
        </Box>
      ) : null}
    </Box>
  );
}
