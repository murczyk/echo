import PublicOutlinedIcon from '@mui/icons-material/PublicOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import HandshakeOutlinedIcon from '@mui/icons-material/HandshakeOutlined';
import QuestionAnswerOutlinedIcon from '@mui/icons-material/QuestionAnswerOutlined';
import RssFeedOutlinedIcon from '@mui/icons-material/RssFeedOutlined';
import SecurityOutlinedIcon from '@mui/icons-material/SecurityOutlined';
import SettingsInputAntennaOutlinedIcon from '@mui/icons-material/SettingsInputAntennaOutlined';
import { Box, Tooltip, Typography } from '@mui/material';
import { type ReactNode } from 'react';

import type { Source } from '../../../../../Bindings';
import { PowerChip } from '../../../components/PowerChip';
import { renderMrtCellWithFallback } from '../../../components/mui-customized/table/mrt-cell-text';

const SOURCE_DISPLAY_ORDER = ['РЕР', 'ПРОЛОМ', 'ДОПИТ', 'ВЗАЄМОДІЯ', 'OSINT', 'ДОКУМЕНТ'] as const;

type SourceMeta = {
  label: string;
  icon: ReactNode;
};

export function sortNetworkCallsignSources(sources: Source[]): Source[] {
  return [...sources].sort((left, right) => {
    const leftIndex = SOURCE_DISPLAY_ORDER.indexOf(normalizeSourceName(left.name) as (typeof SOURCE_DISPLAY_ORDER)[number]);
    const rightIndex = SOURCE_DISPLAY_ORDER.indexOf(normalizeSourceName(right.name) as (typeof SOURCE_DISPLAY_ORDER)[number]);
    const leftOrder = leftIndex === -1 ? SOURCE_DISPLAY_ORDER.length : leftIndex;
    const rightOrder = rightIndex === -1 ? SOURCE_DISPLAY_ORDER.length : rightIndex;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.name.localeCompare(right.name, 'uk-UA');
  });
}

function normalizeSourceName(value: string): string {
  return value.trim().toLocaleUpperCase('uk-UA');
}

function getNetworkCallsignSourceMeta(sourceName: string): SourceMeta {
  const normalized = normalizeSourceName(sourceName);

  if (normalized === 'РЕР' || normalized === 'РЕP') {
    return { label: sourceName, icon: <SettingsInputAntennaOutlinedIcon fontSize="small" /> };
  }

  if (normalized === 'ПРОЛОМ') {
    return { label: sourceName, icon: <SecurityOutlinedIcon fontSize="small" /> };
  }

  if (normalized === 'ДОПИТ') {
    return { label: sourceName, icon: <QuestionAnswerOutlinedIcon fontSize="small" /> };
  }

  if (normalized === 'ВЗАЄМОДІЯ') {
    return { label: sourceName, icon: <HandshakeOutlinedIcon fontSize="small" /> };
  }

  if (normalized === 'OSINT') {
    return { label: sourceName, icon: <PublicOutlinedIcon fontSize="small" /> };
  }

  if (normalized === 'ДОКУМЕНТ') {
    return { label: sourceName, icon: <DescriptionOutlinedIcon fontSize="small" /> };
  }

  return { label: sourceName, icon: <RssFeedOutlinedIcon fontSize="small" /> };
}

export function NetworkCallsignSourceIcon({ sourceName }: { sourceName: string }) {
  const meta = getNetworkCallsignSourceMeta(sourceName);
  return (
    <Tooltip title={meta.label}>
      <Box
        component="span"
        aria-label={meta.label}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-icons)',
          lineHeight: 0,
          flexShrink: 0,
        }}
      >
        {meta.icon}
      </Box>
    </Tooltip>
  );
}

export function NetworkCallsignSourceCell({ sourceName }: { sourceName: string }) {
  return renderMrtCellWithFallback(sourceName, (text) => <NetworkCallsignSourceIcon sourceName={text} />);
}

export function NetworkCallsignSourceChipLabel({ sourceName }: { sourceName: string }) {
  const meta = getNetworkCallsignSourceMeta(sourceName);
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
      <Box
        component="span"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          lineHeight: 0,
          flexShrink: 0,
        }}
      >
        {meta.icon}
      </Box>
      <Typography variant="inherit" noWrap sx={{ minWidth: 0 }}>
        {meta.label}
      </Typography>
    </Box>
  );
}

export function NetworkCallsignSourceChip({
  source,
  selected,
  disabled,
  onClick,
}: {
  source: Source;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <PowerChip
      label={<NetworkCallsignSourceChipLabel sourceName={source.name} />}
      selected={selected}
      onClick={disabled ? undefined : onClick}
      interactive={!disabled}
      title={source.name}
      fontSize="0.75rem"
      fontWeight={600}
      labelPaddingX={0.85}
      labelPaddingY={0.1}
      size="small"
      sx={{ height: 30, lineHeight: 1 }}
    />
  );
}
