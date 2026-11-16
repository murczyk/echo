import CheckIcon from '@mui/icons-material/Check';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import {
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from '@mui/material';
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

import { copyTextToClipboardInPlace } from '../../../copy-to-clipboard';
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
            copy(() =>
              copyTextToClipboardInPlace((preRef.current?.textContent ?? '').replace(/\n$/, '')),
            )
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

const ANSWER_ACTIONS_LABEL = 'Дії з відповіддю';

/**
 * «⋯» menu at the top right of an answer: copies the formatted text of what is
 * shown, or the Markdown source. Briefly shows a check after a copy.
 */
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
      <Tooltip title={copied ? 'Скопійовано' : ANSWER_ACTIONS_LABEL}>
        <IconButton
          id={buttonId}
          type="button"
          size="small"
          aria-label={ANSWER_ACTIONS_LABEL}
          aria-haspopup="menu"
          aria-expanded={Boolean(anchor)}
          onClick={(event) => setAnchor(event.currentTarget)}
          // Negative margins keep the header row as tall as its caption.
          sx={{ color: 'text.secondary', my: -0.75, mr: -1 }}
        >
          {copied ? <CheckIcon fontSize="small" /> : <MoreHorizIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
      {/* Plain MUI Menu: PowerMenu wraps items in a div, which breaks arrow-key focus. */}
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ list: { 'aria-labelledby': buttonId } }}
      >
        <MenuItem onClick={() => choose(() => copyRenderedAnswer(contentRef.current))}>
          <ListItemIcon>
            <ContentCopyOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Копіювати текст</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => choose(() => copyTextToClipboardInPlace(markdown))}>
          <ListItemIcon>
            <CodeOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Копіювати як Markdown</ListItemText>
        </MenuItem>
      </Menu>
    </>
  );
}
