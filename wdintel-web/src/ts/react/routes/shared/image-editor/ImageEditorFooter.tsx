import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import { ButtonGroup, CircularProgress, Menu, MenuItem } from '@mui/material';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MutableRefObject,
  type Ref,
} from 'react';

import { PowerButton } from '../../../components/PowerButton';

const SAVE_MENU_HEIGHT = 64;
const VIEWPORT_MARGIN = 16;
const SAVE_MENU_GAP = 4;

type SaveMenuPosition = {
  top: number;
  left: number;
  placement: 'above' | 'below';
};

function saveMenuPosition(button: HTMLButtonElement): SaveMenuPosition {
  const bounds = button.getBoundingClientRect();
  const roomBelow = window.innerHeight - bounds.bottom;
  const roomAbove = bounds.top;
  const placement =
    roomBelow >= SAVE_MENU_HEIGHT + VIEWPORT_MARGIN || roomBelow >= roomAbove ? 'below' : 'above';

  return {
    top: placement === 'below' ? bounds.bottom + SAVE_MENU_GAP : bounds.top - SAVE_MENU_GAP,
    left: bounds.right,
    placement,
  };
}

export function ImageEditorFooter({
  saving,
  disabled,
  cropActive,
  ready,
  onCancel,
  onSaveReplacement,
  onSaveAsNew,
  onSaveAsNewHandoffChange,
  onMenuOpenChange,
  dismissMenu,
  saveOptionsButtonRef,
  saveReplacementButtonRef,
}: {
  saving: boolean;
  disabled: boolean;
  cropActive: boolean;
  ready: boolean;
  onCancel: () => void;
  onSaveReplacement: () => void;
  onSaveAsNew: () => void;
  onSaveAsNewHandoffChange: (active: boolean) => void;
  onMenuOpenChange: (open: boolean) => void;
  dismissMenu: number;
  saveOptionsButtonRef: Ref<HTMLButtonElement>;
  saveReplacementButtonRef: Ref<HTMLButtonElement>;
}) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<SaveMenuPosition | null>(null);
  const openSaveAsNewAfterCloseRef = useRef(false);
  const [saveOptionsButton, setSaveOptionsButton] = useState<HTMLButtonElement | null>(null);
  const menuId = useId();
  const open = Boolean(menuAnchor);
  const saveAvailable = ready && !disabled && !cropActive;
  const closeMenu = () => {
    setMenuAnchor(null);
    setMenuPosition(null);
    onMenuOpenChange(false);
  };
  const openSaveAsNew = () => {
    openSaveAsNewAfterCloseRef.current = true;
    onSaveAsNewHandoffChange(true);
    closeMenu();
  };
  const handleMenuExited = () => {
    if (openSaveAsNewAfterCloseRef.current) {
      openSaveAsNewAfterCloseRef.current = false;
      onSaveAsNew();
      return;
    }
    saveOptionsButton?.focus();
  };
  const cancelSaveAsNewHandoff = () => {
    openSaveAsNewAfterCloseRef.current = false;
    onSaveAsNewHandoffChange(false);
  };
  const setSaveOptionsRef = useCallback(
    (button: HTMLButtonElement | null) => {
      setSaveOptionsButton(button);
      if (typeof saveOptionsButtonRef === 'function') saveOptionsButtonRef(button);
      else (saveOptionsButtonRef as MutableRefObject<HTMLButtonElement | null>).current = button;
    },
    [saveOptionsButtonRef],
  );

  useEffect(() => {
    if (dismissMenu > 0) {
      cancelSaveAsNewHandoff();
      closeMenu();
    }
  }, [dismissMenu]);

  useEffect(() => {
    if (!saveAvailable) {
      cancelSaveAsNewHandoff();
      closeMenu();
    }
  }, [saveAvailable]);

  useEffect(
    () => () => {
      openSaveAsNewAfterCloseRef.current = false;
      onSaveAsNewHandoffChange(false);
    },
    [onSaveAsNewHandoffChange],
  );

  useEffect(() => {
    if (!menuAnchor) return;
    const updatePosition = () => setMenuPosition(saveMenuPosition(menuAnchor));
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [menuAnchor]);

  return (
    <footer className="flex items-center justify-end gap-2 border-t border-echo-border p-2">
      <PowerButton type="button" onClick={onCancel} disabled={disabled}>
        Скасувати
      </PowerButton>
      <ButtonGroup variant="contained" aria-label="Дії збереження зображення">
        <PowerButton
          ref={saveReplacementButtonRef}
          type="button"
          onClick={onSaveReplacement}
          disabled={!saveAvailable}
        >
          {saving ? <CircularProgress size={18} color="inherit" /> : 'Зберегти'}
        </PowerButton>
        <PowerButton
          ref={setSaveOptionsRef}
          type="button"
          sx={{ minWidth: 40, width: 40, px: 0 }}
          aria-label="Додаткові дії збереження"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={(event) => {
            setMenuAnchor(event.currentTarget);
            setMenuPosition(saveMenuPosition(event.currentTarget));
            onMenuOpenChange(true);
          }}
          disabled={!saveAvailable}
        >
          <ArrowDropDownIcon fontSize="small" />
        </PowerButton>
      </ButtonGroup>
      <Menu
        anchorReference="anchorPosition"
        anchorPosition={menuPosition ?? undefined}
        open={open}
        onClose={closeMenu}
        marginThreshold={VIEWPORT_MARGIN}
        slotProps={{
          list: {
            id: menuId,
            'aria-label': 'Додаткові дії збереження',
            onKeyDown: (event) => event.stopPropagation(),
          },
          transition: { onExited: handleMenuExited },
        }}
        transformOrigin={{
          vertical: menuPosition?.placement === 'above' ? 'bottom' : 'top',
          horizontal: 'right',
        }}
      >
        <MenuItem onClick={openSaveAsNew} disabled={!saveAvailable}>
          Зберегти як...
        </MenuItem>
      </Menu>
    </footer>
  );
}
