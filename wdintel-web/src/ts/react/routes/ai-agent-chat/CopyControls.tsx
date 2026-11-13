import CheckIcon from '@mui/icons-material/Check';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import { IconButton, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import {
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from 'react';
import type { ExtraProps } from 'react-markdown';

import { copyTextToClipboard } from '../../../copy-to-clipboard';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { copyRenderedAnswer } from './answer-copy';

const COPY_FEEDBACK_MS = 2000;

/** Runs a clipboard write, then shows «Скопійовано» briefly or reports the failure. */
function useCopyAction() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>();
  const { notify } = usePowerSnackbar();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = useCallback(
    (write: () => Promise<void>) => {
      write().then(
        () => {
          window.clearTimeout(timer.current);
          setCopied(true);
          timer.current = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
        },
        () => notify({ severity: 'error', message: 'Не вдалося скопіювати' }),
      );
    },
    [notify],
  );
  return { copied, copy };
}

function codeLanguage(code: unknown): string {
  if (!isValidElement<{ className?: string }>(code)) return '';
  return /(?:^|\s)language-(\S+)/.exec(code.props.className ?? '')?.[1] ?? '';
}

/** A Markdown code block with its language and a copy button above the code. */
export function CodeBlock({ node: _node, children, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const { copied, copy } = useCopyAction();
  return (
    <div className="ai-code-block">
      <div
        className="flex min-h-echo-control-sm items-center justify-between gap-echo-sm pr-echo-xs pl-echo-md"
        data-copy-skip
      >
        <Typography variant="caption" color="text.secondary" noWrap>
          {codeLanguage(children)}
        </Typography>
        <PowerButton
          type="button"
          size="small"
          color="inherit"
          startIcon={copied ? <CheckIcon /> : <ContentCopyOutlinedIcon />}
          onClick={() =>
            copy(() => copyTextToClipboard((preRef.current?.textContent ?? '').replace(/\n$/, '')))
          }
          sx={{ color: 'text.secondary', textTransform: 'none' }}
        >
          {copied ? 'Скопійовано' : 'Копіювати'}
        </PowerButton>
      </div>
      <pre ref={preRef} {...props}>
        {children}
      </pre>
    </div>
  );
}

/** Copy menu under an answer: formatted text of what is shown, or the Markdown source. */
export function AnswerCopyMenu({
  markdown,
  contentRef,
}: {
  markdown: string;
  contentRef: RefObject<HTMLElement>;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const buttonId = useId();
  const { copied, copy } = useCopyAction();
  function choose(write: () => Promise<void>) {
    copy(write);
    setAnchor(null);
  }
  return (
    <>
      <Tooltip title={copied ? 'Скопійовано' : 'Копіювати відповідь'}>
        <IconButton
          id={buttonId}
          type="button"
          size="small"
          aria-label="Копіювати відповідь"
          aria-haspopup="menu"
          aria-expanded={Boolean(anchor)}
          onClick={(event) => setAnchor(event.currentTarget)}
          sx={{ color: 'text.secondary' }}
        >
          {copied ? <CheckIcon fontSize="small" /> : <ContentCopyOutlinedIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
      {/* Plain MUI Menu: PowerMenu wraps items in a div, which breaks arrow-key focus. */}
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ list: { 'aria-labelledby': buttonId } }}
      >
        <MenuItem onClick={() => choose(() => copyRenderedAnswer(contentRef.current))}>
          Копіювати текст
        </MenuItem>
        <MenuItem onClick={() => choose(() => copyTextToClipboard(markdown))}>
          Копіювати як Markdown
        </MenuItem>
      </Menu>
    </>
  );
}
