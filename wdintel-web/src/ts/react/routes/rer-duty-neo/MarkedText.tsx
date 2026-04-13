import { Badge, Box, IconButton, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import InfoIcon from '@mui/icons-material/Info';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { useId, useState } from 'react';
import type { CSSProperties, ReactNode, SyntheticEvent } from 'react';

import type { CallsignInfoRes, ContentNode, InboxMessage, Network, Unit } from '../../../../Bindings';
import { buildAnalysisMapHrefWithSearch, uniquePointEtalonsForMapSearch } from './utils';
import { formatCallsignHintTooltipData, getCallsignHintResult } from '../rer-analysis-neo/callsign-hints';

const ORANGE_TOKEN_BG = '#fd884f';
const ORANGE_TOKEN_FG = '#000';

export const CALLSIGN_TOOLTIP_ITEM_SX = {
  fontSize: '0.875rem',
  lineHeight: 1.35,
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
  minWidth: 0,
} as const;

function collectPointEtalons(nodes: ContentNode[]): string[] {
  const etalons: string[] = [];
  for (const n of nodes) {
    if (typeof n !== 'string' && 'CNPointC' in n && n.CNPointC?.etalon != null) {
      const e = String(n.CNPointC.etalon).trim();
      if (e !== '') etalons.push(e);
    }
  }
  return etalons;
}

function tokenPillBaseStyle(isInteractive: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    backgroundColor: ORANGE_TOKEN_BG,
    color: ORANGE_TOKEN_FG,
    borderRadius: 4,
    padding: '0.15em 0.3em',
    fontSize: '90%',
    fontWeight: 600,
    lineHeight: 1.2,
    cursor: isInteractive ? 'pointer' : 'inherit',
  };
}

function tokenInteractiveResetStyle(cursor: CSSProperties['cursor']): CSSProperties {
  return {
    color: 'inherit',
    textDecoration: 'none',
    cursor,
  };
}

function callsignLinkStyle(): CSSProperties {
  return {
    color: 'var(--message-callsign-color)',
    borderBottom: '2px solid var(--message-callsign-color)',
    textDecoration: 'none',
  };
}

function PointToken({
  text,
  hrefAll,
  hrefSingle,
  title,
  hasMultiplePoints,
}: {
  text: string;
  hrefAll: string;
  hrefSingle: string;
  title: string;
  hasMultiplePoints: boolean;
}) {
  const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement | null>(null);
  const menuId = useId();

  function openMenu(event: SyntheticEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    setMenuAnchorEl(event.currentTarget);
  }

  return (
    <>
      <span
        className="content-token--point"
        style={tokenPillBaseStyle(true)}
        title={title}
        role="button"
        tabIndex={0}
        onClick={openMenu}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            openMenu(event);
          }
        }}
      >
        <span className="content-token--point-link" style={tokenInteractiveResetStyle('pointer')}>
          {text}
        </span>
        <IconButton
          size="small"
          aria-label="Показати на мапі"
          aria-controls={menuAnchorEl ? menuId : undefined}
          aria-haspopup="menu"
          aria-expanded={menuAnchorEl ? 'true' : undefined}
          title={title}
          onClick={openMenu}
          sx={{
            color: ORANGE_TOKEN_FG,
            fontWeight: 600,
            padding: 0,
            ml: 0,
            cursor: 'pointer',
            '&:hover': { backgroundColor: 'transparent' },
          }}
        >
          <span aria-hidden style={{ lineHeight: 1, fontSize: '1em', fontWeight: 'inherit', margin: '0 2px' }}>
            ⋮
          </span>
        </IconButton>
      </span>
      <Menu
        id={menuId}
        anchorEl={menuAnchorEl}
        open={menuAnchorEl != null}
        onClose={() => setMenuAnchorEl(null)}
        MenuListProps={{ 'aria-label': 'Дії з точкою' }}
      >
        {hasMultiplePoints ? (
          <>
            <MenuItem
              component="a"
              href={hrefAll}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMenuAnchorEl(null)}
            >
              Показати на мапі всі точки
            </MenuItem>
            <MenuItem
              component="a"
              href={hrefSingle}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMenuAnchorEl(null)}
            >
              Показати на мапі цю точку
            </MenuItem>
          </>
        ) : (
          <MenuItem
            component="a"
            href={hrefSingle}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setMenuAnchorEl(null)}
          >
            Показати на мапі
          </MenuItem>
        )}
      </Menu>
    </>
  );
}

function KeywordToken({ text }: { text: string }) {
  return (
    <span className="badge-highlighed-token badge-highlighed-token--callsign" style={tokenPillBaseStyle(false)}>
      {text}
    </span>
  );
}

function CallsignWithHint({
  text,
  callsignInfoMap,
  networks,
  unitsMap,
  freq,
  networkIds,
}: {
  text: string;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  networks?: Network[];
  unitsMap?: Record<number, Unit>;
  freq?: string | null;
  networkIds?: number[] | null;
}) {
  const displayText = text.toUpperCase();
  const href = `/rer-callsigns-neo?callsign=${encodeURIComponent(displayText)}`;

  // If we don't have networks or unitsMap, just render as plain link
  if (!networks || !unitsMap) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="content-token--ADP hover:cursor-pointer"
        style={callsignLinkStyle()}
      >
        {displayText}
      </a>
    );
  }

  const hintResult = getCallsignHintResult({
    hintContext: 'message',
    freq: freq ?? null,
    networkIds,
    networks,
    unitsMap,
    callsignInfoMap,
    callsign: displayText,
  });

  const tooltipText = formatCallsignHintTooltipData(hintResult);
  const isNetworkHint = hintResult.strategy === 'network';

  if (!tooltipText) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="content-token--ADP hover:cursor-pointer"
        style={callsignLinkStyle()}
      >
        {displayText}
      </a>
    );
  }

  return (
    <Tooltip
      placement="top"
      arrow
      describeChild
      slotProps={{
        tooltip: {
          sx: {
            maxWidth: 420,
            width: 'min(420px, calc(100vw - 32px))',
            px: 1.5,
            py: 1.25,
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
          },
        },
      }}
      title={
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, maxHeight: 320, overflowY: 'auto', overflowX: 'hidden', minWidth: 0 }}>
          <Typography component="div" sx={{ fontSize: '0.875rem', fontWeight: 600, lineHeight: 1.3 }}>
            {tooltipText.header}
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 0 }}>
            {tooltipText.items.map((item, index) => (
              <Typography
                key={`${displayText}-${index}`}
                component="li"
                sx={CALLSIGN_TOOLTIP_ITEM_SX}
              >
                {item}
              </Typography>
            ))}
          </Box>
        </Box>
      }
    >
      <Badge
        overlap="rectangular"
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        badgeContent={
          <Box
            component="span"
            aria-label={isNetworkHint ? 'Підказка по мережі' : 'Підказка з каталогу'}
            data-testid={isNetworkHint ? 'callsign-hint-badge-network' : 'callsign-hint-badge-system'}
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 18,
              height: 18,
              borderRadius: '50%',
              bgcolor: 'var(--color-card)',
              color: 'var(--message-callsign-color)',
              boxShadow: '0 0 0 1px var(--color-card)',
              pointerEvents: 'none',
            }}
          >
            {isNetworkHint ? <InfoIcon sx={{ fontSize: 16 }} /> : <InfoOutlinedIcon sx={{ fontSize: 16 }} />}
          </Box>
        }
        sx={{
          display: 'inline-flex',
          verticalAlign: 'baseline',
          mr: '0.1em',
          '& .MuiBadge-badge': {
            p: 0,
            border: 'none',
            bgcolor: 'transparent',
            minWidth: 18,
            height: 18,
            transform: 'translate(45%, -35%)',
          },
          '&:focus-within': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: '2px',
            borderRadius: '4px',
          },
        }}
      >
        <Box component="span" sx={{ display: 'inline-block', pr: '8px' }}>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="content-token--ADP hover:cursor-pointer"
            style={callsignLinkStyle()}
          >
            {displayText}
          </a>
        </Box>
      </Badge>
    </Tooltip>
  );
}

export function renderMarkedText(
  nodes: ContentNode[],
  _bodyText: string,
  messagePointEtalons?: string[],
  options?: {
    showPointLinks?: boolean;
    message?: InboxMessage;
    callsignInfoMap?: Record<string, CallsignInfoRes>;
    networks?: Network[];
    unitsMap?: Record<number, Unit>;
    freq?: string | null;
    networkIds?: number[] | null;
  },
): ReactNode[] {
  const showPointLinks = options?.showPointLinks !== false;
  const messageForMap = options?.message;
  const fromNodes = collectPointEtalons(nodes);
  const allPointEtalons = uniquePointEtalonsForMapSearch(
    messagePointEtalons != null && messagePointEtalons.length > 0 ? messagePointEtalons : fromNodes,
  );
  return nodes.map((node, i) => {
    if (typeof node === 'string') {
      if (node === 'CNNewlineC') return <br key={i} />;
      return null;
    }
    if ('CNTextC' in node) {
      return <span key={i}>{node.CNTextC.text}</span>;
    }
    if ('CNCallsignC' in node) {
      const { text } = node.CNCallsignC;
      const callsignText = text.trim();
      if (callsignText === '') return null;
      return (
        <CallsignWithHint
          key={i}
          text={callsignText}
          callsignInfoMap={options?.callsignInfoMap}
          networks={options?.networks}
          unitsMap={options?.unitsMap}
          freq={options?.freq}
          networkIds={options?.networkIds}
        />
      );
    }
    if ('CNHighlightC' in node) {
      const { text } = node.CNHighlightC;
      if (text.trim() === '') return null;
      return <KeywordToken key={i} text={text} />;
    }
    if ('CNSignalC' in node) {
      const { text } = node.CNSignalC;
      if (text.trim() === '') return null;
      return (
        <span key={i} className="content-token--ADV">
          {text}
        </span>
      );
    }
    if ('CNPointC' in node) {
      const { etalon, text } = node.CNPointC;
      if (text.trim() === '') return null;
      const cleanEtalon = String(etalon ?? '').trim();
      if (!showPointLinks) {
        return <span key={i}>{text}</span>;
      }
      if (cleanEtalon === '') {
        return <span key={i}>{text}</span>;
      }
      const etalonsForUrl = allPointEtalons.length > 0 ? allPointEtalons : [etalon];
      const hrefAll = buildAnalysisMapHrefWithSearch(etalonsForUrl, messageForMap);
      const hrefSingle = buildAnalysisMapHrefWithSearch(etalon, messageForMap);
      const title =
        allPointEtalons.length > 1
          ? `Відкрити на мапі аналізу: ${allPointEtalons.join(', ')}`
          : `Відкрити на мапі аналізу: ${cleanEtalon}`;
      return (
        <PointToken
          key={i}
          text={text}
          hrefAll={hrefAll}
          hrefSingle={hrefSingle}
          title={title}
          hasMultiplePoints={allPointEtalons.length > 1}
        />
      );
    }
    return null;
  });
}
