import { IconButton, Menu, MenuItem } from '@mui/material';
import { useId, useState } from 'react';
import type { CSSProperties, ReactNode, SyntheticEvent } from 'react';

import type { ContentNode, InboxMessage } from '../../../../Bindings';
import { buildAnalysisMapHrefWithSearch, uniquePointEtalonsForMapSearch } from './utils';

const ORANGE_TOKEN_BG = '#fd884f';
const ORANGE_TOKEN_FG = '#000';

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

export function renderMarkedText(
  nodes: ContentNode[],
  bodyText: string,
  messagePointEtalons?: string[],
  options?: { showPointLinks?: boolean; message?: InboxMessage },
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
      const displayText = text.toUpperCase();
      const href = `/rer-callsigns?callsign=${encodeURIComponent(displayText)}`;
      return (
        <a
          key={i}
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
    if ('CNHighlightC' in node) {
      const { text } = node.CNHighlightC;
      return <KeywordToken key={i} text={text} />;
    }
    if ('CNSignalC' in node) {
      const { text } = node.CNSignalC;
      return (
        <span key={i} className="content-token--ADV">
          {text}
        </span>
      );
    }
    if ('CNPointC' in node) {
      const { begin, end, etalon } = node.CNPointC;
      const sliceText = bodyText.slice(begin, end);
      if (!showPointLinks) {
        return <span key={i}>{sliceText}</span>;
      }
      const etalonsForUrl = allPointEtalons.length > 0 ? allPointEtalons : [etalon];
      const hrefAll = buildAnalysisMapHrefWithSearch(etalonsForUrl, messageForMap);
      const hrefSingle = buildAnalysisMapHrefWithSearch(etalon, messageForMap);
      const title =
        allPointEtalons.length > 1
          ? `Відкрити на мапі аналізу: ${allPointEtalons.join(', ')}`
          : `Відкрити на мапі аналізу: ${etalon}`;
      return (
        <PointToken
          key={i}
          text={sliceText}
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
