/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Button,
  DialogActions,
  IconButton,
  Slider,
  Table,
  TableBody,
  TableCell,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';

import type { InboxMessage } from '../../Bindings';
import { MessageCard } from './routes/shared/message-card/MessageCard';
import { NeoMuiThemeProvider } from './mui-theme';
import { emptyFilter } from './routes/rer-duty-neo/utils';
import { MessageCardDisabledControlCursorWrapper } from './routes/shared/message-card/MessageCardDisabledControlCursorWrapper';

function buildMessage(): InboxMessage {
  return {
    text: 'Повідомлення для перевірки',
    freq: '153.6250',
    bookmarked: false,
    important: false,
    extendedForm: 'Коментар',
    sender: 'sender-1',
    groupMasterKey: 'group-1',
    networkIds: [],
    tags: [],
    inboxTags: [],
    timestamp: null,
    time: '02:45',
    date: '2026-03-23',
    callsigns: ['ALPHA'],
    callsignsAlg2: ['ALPHA', 'BRAVO'],
    location: 'ЛИМАН ПЕРШИЙ',
    pointTokens: [],
    textMarked: [],
    metadata: [],
  } as InboxMessage;
}

function ThemeProbe() {
  const theme = useTheme();
  return <div data-testid="html-font-size">{theme.typography.htmlFontSize}</div>;
}

function Harness() {
  return (
    <NeoMuiThemeProvider>
      <div>
        <ThemeProbe />
        <DialogActions data-testid="dialog-actions-sample">
          <Button data-testid="dialog-action-first">First</Button>
          <Button data-testid="dialog-action-second">Second</Button>
        </DialogActions>
        <Typography data-testid="body2-sample" variant="body2">
          Body 2 sample
        </Typography>
        <Typography data-testid="caption-sample" variant="caption">
          Caption sample
        </Typography>
        <Button data-testid="button-sample" variant="contained">
          Button sample
        </Button>
        <Button data-testid="disabled-button" disabled>
          Disabled button
        </Button>
        <IconButton data-testid="disabled-icon-button" disabled aria-label="Disabled icon">
          Icon
        </IconButton>
        <Table data-testid="table-sample" size="small">
          <TableBody>
            <TableRow>
              <TableCell data-testid="table-cell-sample">Table sample</TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <TextField
          data-testid="input-sample"
          defaultValue="Input sample"
          label="Input sample"
          inputProps={{ 'data-testid': 'input-element' }}
        />
        <MessageCardDisabledControlCursorWrapper disabled data-testid="disabled-slider-wrapper">
          <Slider data-testid="disabled-slider" disabled value={25} />
        </MessageCardDisabledControlCursorWrapper>
        <TextField
          data-testid="disabled-input-sample"
          disabled
          defaultValue="Disabled input"
          inputProps={{ 'data-testid': 'disabled-input-element' }}
        />
        <MessageCard
          id={1}
          msg={buildMessage()}
          feedCount={1}
          referenceTimeMs={1_710_000_000_000}
          authUserName={null}
          groupName={null}
          senderName={null}
          copiedFeedbackId={null}
          networkDisplayMap={{}}
          filterState={emptyFilter()}
          messageComments={[]}
          tagsMap={{}}
          onBookmark={vi.fn()}
          onImportant={vi.fn()}
          onCopyText={vi.fn()}
          onCopyFreq={vi.fn()}
          onComment={vi.fn()}
          onToggleTag={vi.fn()}
        />
      </div>
    </NeoMuiThemeProvider>
  );
}

describe('mui-theme', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    document.documentElement.style.fontSize = '14px';
    document.body.style.fontSize = '14px';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
      container.remove();
    });
    document.documentElement.style.fontSize = '';
    document.body.style.fontSize = '';
    document.body.innerHTML = '';
  });

  it('calibrates shared typography to the 14px application root', async () => {
    await act(async () => {
      root.render(<Harness />);
    });

    const htmlFontSize = container.querySelector('[data-testid="html-font-size"]');
    expect(htmlFontSize?.textContent).toBe('14');

    const body2 = container.querySelector('[data-testid="body2-sample"]');
    const caption = container.querySelector('[data-testid="caption-sample"]');
    const button = container.querySelector('[data-testid="button-sample"]');
    const tableCell = container.querySelector('[data-testid="table-cell-sample"]');
    const input = container.querySelector('[data-testid="input-element"]');
    const inputBase = input?.closest('.MuiInputBase-root');
    const messageCard = container.querySelector('.message-card-root');

    expect(body2).not.toBeNull();
    expect(caption).not.toBeNull();
    expect(button).not.toBeNull();
    expect(tableCell).not.toBeNull();
    expect(input).not.toBeNull();
    expect(inputBase).not.toBeNull();
    expect(messageCard).not.toBeNull();

    if (!body2 || !caption || !button || !tableCell || !input || !inputBase || !messageCard) {
      throw new Error('Expected shared theme fixture nodes to render');
    }

    const body2FontSize = window.getComputedStyle(body2).fontSize;
    const captionFontSize = window.getComputedStyle(caption).fontSize;
    const buttonFontSize = window.getComputedStyle(button).fontSize;
    const tableCellFontSize = window.getComputedStyle(tableCell).fontSize;
    const inputBaseFontSize = window.getComputedStyle(inputBase).fontSize;
    const messageCardFontSize = window.getComputedStyle(messageCard).fontSize;

    expect(body2FontSize).toBe('14px');
    expect(captionFontSize).toBe('12px');
    expect(buttonFontSize).toBe('14px');
    expect(tableCellFontSize).toBe('14px');
    expect(Number.parseFloat(inputBaseFontSize)).toBeGreaterThan(0);
    expect(messageCardFontSize).toBe('14px');
    expect(Number.parseFloat(captionFontSize)).toBeLessThan(Number.parseFloat(body2FontSize));
    expect(tableCellFontSize).toBe(body2FontSize);
  });

  it('provides the standard dialog footer spacing globally', async () => {
    await act(async () => {
      root.render(<Harness />);
    });

    const dialogActions = container.querySelector('[data-testid="dialog-actions-sample"]');
    const secondAction = container.querySelector('[data-testid="dialog-action-second"]');
    expect(dialogActions).not.toBeNull();
    expect(secondAction).not.toBeNull();
    if (!(dialogActions instanceof HTMLElement) || !(secondAction instanceof HTMLElement)) {
      throw new Error('Expected dialog action fixture nodes');
    }

    const styles = window.getComputedStyle(dialogActions);
    expect(styles.padding).toBe('24px');
    expect(styles.gap).toBe('12px');
    expect(window.getComputedStyle(secondAction).marginLeft).toBe('0px');
  });

  it('keeps native disabled controls visible with a forbidden cursor', async () => {
    await act(async () => {
      root.render(<Harness />);
    });

    for (const selector of [
      '[data-testid="disabled-button"]',
      '[data-testid="disabled-icon-button"]',
      '[data-testid="disabled-input-element"]',
    ]) {
      const control = container.querySelector(selector);
      expect(control).not.toBeNull();
      if (!(control instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
      const styles = window.getComputedStyle(control);
      expect(styles.cursor).toBe('not-allowed');
      expect(styles.pointerEvents).toBe('auto');
    }
  });

  it('uses the cursor wrapper without re-enabling disabled non-native sliders', async () => {
    await act(async () => {
      root.render(<Harness />);
    });

    const wrapper = container.querySelector('[data-testid="disabled-slider-wrapper"]');
    const slider = container.querySelector('[data-testid="disabled-slider"]');
    expect(wrapper).not.toBeNull();
    expect(slider).not.toBeNull();
    if (!(wrapper instanceof HTMLElement) || !(slider instanceof HTMLElement)) {
      throw new Error('Expected disabled slider fixture nodes');
    }

    expect(window.getComputedStyle(wrapper).cursor).toBe('not-allowed');
    expect(window.getComputedStyle(slider).pointerEvents).toBe('none');
  });
});
