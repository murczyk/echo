import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import { IconButton, ListItemButton, ListItemText, MenuItem } from '@mui/material';
import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { PowerMenu } from '../../components/PowerMenu';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import type { AiAgentConversation } from '../../services/api/ai-agent';
import './history.css';

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVEMENT_PX = 10;

export function ConversationHistoryItem({
  conversation,
  selected,
  timestamp,
  onSelect,
  onDelete,
}: {
  conversation: AiAgentConversation;
  selected: boolean;
  timestamp: string;
  onSelect: () => void;
  onDelete: () => Promise<void>;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const mountedRef = useRef(true);
  const pressRef = useRef<{ x: number; y: number; timer: number } | null>(null);
  const suppressClickRef = useRef(false);
  const menuButtonId = useId();
  const { notify } = usePowerSnackbar();

  function cancelPress() {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer);
    pressRef.current = null;
  }

  useEffect(() => {
    mountedRef.current = true;
    const suppressReleaseClick = (event: MouseEvent) => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      if (event.detail === 0) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const resetSuppression = () => {
      suppressClickRef.current = false;
    };
    window.addEventListener('scroll', cancelPress, true);
    window.addEventListener('click', suppressReleaseClick, true);
    window.addEventListener('pointerdown', resetSuppression, true);
    return () => {
      mountedRef.current = false;
      cancelPress();
      window.removeEventListener('scroll', cancelPress, true);
      window.removeEventListener('click', suppressReleaseClick, true);
      window.removeEventListener('pointerdown', resetSuppression, true);
    };
  }, []);

  function startPress(event: PointerEvent<HTMLElement>) {
    cancelPress();
    suppressClickRef.current = false;
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    const target = event.currentTarget;
    pressRef.current = {
      x: event.clientX,
      y: event.clientY,
      timer: window.setTimeout(() => {
        pressRef.current = null;
        suppressClickRef.current = true;
        setAnchor(target);
      }, LONG_PRESS_MS),
    };
  }

  function movePress(event: PointerEvent<HTMLElement>) {
    const press = pressRef.current;
    if (
      press &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_MOVEMENT_PX
    ) {
      cancelPress();
    }
  }

  async function confirmDelete() {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      await onDelete();
      if (mountedRef.current) setConfirming(false);
    } catch (error) {
      if (mountedRef.current) {
        notify({
          severity: 'error',
          message: `Не вдалося видалити розмову: ${error instanceof Error ? error.message : 'Невідома помилка'}`,
        });
      }
    } finally {
      deletingRef.current = false;
      if (mountedRef.current) setDeleting(false);
    }
  }

  return (
    <li className="ai-conversation-history-item relative list-none">
      <ListItemButton
        selected={selected}
        onClick={(event) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            event.preventDefault();
            return;
          }
          onSelect();
        }}
        onPointerDown={startPress}
        onPointerMove={movePress}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onPointerLeave={cancelPress}
        onContextMenu={(event) => event.preventDefault()}
        className="!mb-0 touch-pan-y !rounded-none !pr-[calc(var(--echo-size-control-md)+var(--echo-spacing-sm))] select-none"
      >
        <ListItemText
          primary={conversation.title}
          secondary={timestamp}
          slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true } }}
        />
      </ListItemButton>
      <IconButton
        id={menuButtonId}
        className="ai-conversation-menu-button right-echo-sm !absolute top-1/2 -translate-y-1/2"
        aria-label={`Меню розмови «${conversation.title}»`}
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        onClick={(event) => setAnchor(event.currentTarget)}
        size="small"
      >
        <MoreHorizIcon fontSize="small" />
      </IconButton>
      <PowerMenu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        slotProps={{ list: { 'aria-labelledby': menuButtonId } }}
      >
        <MenuItem
          onClick={() => {
            setAnchor(null);
            setConfirming(true);
          }}
        >
          Видалити
        </MenuItem>
      </PowerMenu>
      <ConfirmDangerDialog
        open={confirming}
        title="Видалити розмову?"
        description={`Розмову «${conversation.title}» буде видалено з історії.`}
        submitting={deleting}
        onClose={() => setConfirming(false)}
        onConfirm={() => void confirmDelete()}
      />
    </li>
  );
}
