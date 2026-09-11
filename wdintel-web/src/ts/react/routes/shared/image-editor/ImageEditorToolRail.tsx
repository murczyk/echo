import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import AspectRatioIcon from '@mui/icons-material/AspectRatio';
import BlurOnIcon from '@mui/icons-material/BlurOn';
import BrushIcon from '@mui/icons-material/Brush';
import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrong';
import CircleOutlinedIcon from '@mui/icons-material/CircleOutlined';
import CropIcon from '@mui/icons-material/Crop';
import DeleteIcon from '@mui/icons-material/Delete';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import HighlightAltIcon from '@mui/icons-material/HighlightAlt';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import PanToolIcon from '@mui/icons-material/PanTool';
import RectangleOutlinedIcon from '@mui/icons-material/RectangleOutlined';
import RedoIcon from '@mui/icons-material/Redo';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SearchIcon from '@mui/icons-material/Search';
import TextFieldsIcon from '@mui/icons-material/TextFields';
import UndoIcon from '@mui/icons-material/Undo';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import {
  IconButton,
  ListItemIcon,
  ListSubheader,
  MenuItem,
  Popover,
  Tooltip,
  useMediaQuery,
} from '@mui/material';
import { useEffect, useState, type ReactNode } from 'react';

import { PowerMenu } from '../../../components/PowerMenu';
import { ImageEditorIconButton } from './ImageEditorIconButton';
import { ImageEditorDiagonalLineIcon } from './ImageEditorIcons';
import { ImageEditorViewControls } from './ImageEditorViewControls';
import { ImageEditorTool } from './image-editor.types';
import {
  IMAGE_EDITOR_TOOL_SHORTCUTS,
  imageEditorPrimaryModifierLabel,
  imageEditorToolShortcutLabel,
} from './image-editor-shortcuts';

function ToolGroup({ children }: { children: ReactNode }) {
  return <div className="flex shrink-0 items-center gap-1">{children}</div>;
}

function GroupSeparator() {
  return <span aria-hidden="true" className="mx-1 h-6 w-px shrink-0 bg-echo-border" />;
}

type Props = {
  disabled: boolean;
  tool: ImageEditorTool;
  onToolChange: (tool: ImageEditorTool) => void;
  canUndo: boolean;
  canRedo: boolean;
  canDeleteSelected: boolean;
  onDeleteSelected: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onResetEdits: () => void;
  zoom: number;
  onZoomChange: (next: number) => void;
  onFitViewport: () => void;
  onActualSize: () => void;
  onCenterViewport: () => void;
  onMenuOpenChange: (open: boolean) => void;
  dismissMenu: number;
};

const TOOLS: Record<ImageEditorTool, { label: string; icon: ReactNode; iconSize?: number }> = {
  [ImageEditorTool.Select]: { label: 'Вибрати об’єкт', icon: <HighlightAltIcon /> },
  [ImageEditorTool.Pan]: { label: 'Перемістити полотно', icon: <PanToolIcon />, iconSize: 20 },
  [ImageEditorTool.Crop]: { label: 'Обрізати', icon: <CropIcon /> },
  [ImageEditorTool.Text]: { label: 'Текст', icon: <TextFieldsIcon /> },
  [ImageEditorTool.Rectangle]: { label: 'Прямокутник', icon: <RectangleOutlinedIcon /> },
  [ImageEditorTool.Ellipse]: { label: 'Еліпс', icon: <CircleOutlinedIcon /> },
  [ImageEditorTool.Line]: { label: 'Лінія', icon: <ImageEditorDiagonalLineIcon /> },
  [ImageEditorTool.Arrow]: { label: 'Стрілка', icon: <ArrowForwardIcon /> },
  [ImageEditorTool.Brush]: { label: 'Пензель', icon: <BrushIcon /> },
  [ImageEditorTool.Conceal]: { label: 'Розмиття', icon: <BlurOnIcon /> },
  [ImageEditorTool.Magnifier]: { label: 'Лупа', icon: <SearchIcon /> },
};

const TABLET_VISIBLE_TOOLS: readonly ImageEditorTool[] = [
  ImageEditorTool.Select,
  ImageEditorTool.Pan,
  ImageEditorTool.Crop,
  ImageEditorTool.Text,
  ImageEditorTool.Rectangle,
  ImageEditorTool.Arrow,
  ImageEditorTool.Brush,
  ImageEditorTool.Conceal,
];
const MOBILE_VISIBLE_TOOLS: readonly ImageEditorTool[] = [
  ImageEditorTool.Select,
  ImageEditorTool.Pan,
  ImageEditorTool.Text,
  ImageEditorTool.Conceal,
];
const TOOL_ORDER = Object.values(ImageEditorTool);

export function ImageEditorToolRail(props: Props) {
  const desktop = useMediaQuery('(min-width: 1280px)', { noSsr: true });
  const tablet = useMediaQuery('(min-width: 768px)', { noSsr: true });
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [helpAnchor, setHelpAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (props.dismissMenu) {
      setAnchor(null);
      setHelpAnchor(null);
    }
  }, [props.dismissMenu]);
  const closeMenu = () => {
    setAnchor(null);
    props.onMenuOpenChange(false);
  };
  const toolButton = (value: ImageEditorTool) => {
    const { label, icon, iconSize } = TOOLS[value];
    const shortcut = imageEditorToolShortcutLabel(value);
    return (
      <ImageEditorIconButton
        key={value}
        label={label}
        tooltipLabel={shortcut ? `${label} (${shortcut})` : label}
        icon={icon}
        onClick={() => props.onToolChange(value)}
        disabled={props.disabled}
        active={props.tool === value}
        iconSize={iconSize}
      />
    );
  };
  const selectTool = (value: ImageEditorTool) => {
    closeMenu();
    props.onToolChange(value);
  };
  const action = (callback: () => void) => {
    closeMenu();
    callback();
  };
  const menuTool = (value: ImageEditorTool) => {
    const { label, icon } = TOOLS[value];
    const shortcut = imageEditorToolShortcutLabel(value);
    return (
      <MenuItem
        key={value}
        selected={props.tool === value}
        disabled={props.disabled}
        onClick={() => selectTool(value)}
      >
        <ListItemIcon>{icon}</ListItemIcon>
        {label}
        {shortcut ? ` (${shortcut})` : ''}
      </MenuItem>
    );
  };
  const visibleTools = tablet ? TABLET_VISIBLE_TOOLS : MOBILE_VISIBLE_TOOLS;
  const overflowTools = TOOL_ORDER.filter((value) => !visibleTools.includes(value));
  const moreIsActive = !desktop && overflowTools.includes(props.tool);
  const helpButton = (
    <Tooltip title="Гарячі клавіші">
      <span>
        <IconButton
          aria-label="Гарячі клавіші"
          aria-expanded={Boolean(helpAnchor)}
          aria-haspopup="dialog"
          onClick={(event) => {
            setHelpAnchor(event.currentTarget);
            props.onMenuOpenChange(true);
          }}
          disabled={props.disabled}
          className="size-10 shrink-0 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-echo-focus"
        >
          <HelpOutlineIcon />
        </IconButton>
      </span>
    </Tooltip>
  );
  const helpPopover = (
    <Popover
      open={Boolean(helpAnchor)}
      anchorEl={helpAnchor}
      onClose={() => {
        setHelpAnchor(null);
        props.onMenuOpenChange(false);
      }}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
    >
      <section className="max-w-sm p-echo-md" aria-label="Гарячі клавіші">
        <h2 className="mb-echo-sm text-echo-md font-semibold">Гарячі клавіші</h2>
        <p className="mb-echo-sm text-echo-sm">
          Літерні клавіші не працюють під час введення тексту.
        </p>
        <ul className="m-0 list-none p-0 text-echo-sm">
          {IMAGE_EDITOR_TOOL_SHORTCUTS.map((shortcut) => (
            <li key={shortcut.tool} className="flex justify-between gap-echo-lg py-1">
              <span>{TOOLS[shortcut.tool].label}</span>
              <kbd>
                {shortcut.key} / {shortcut.ukrainianKey}
              </kbd>
            </li>
          ))}
          <li className="flex justify-between gap-echo-lg py-1">
            <span>Скасувати / повторити</span>
            <kbd>
              {imageEditorPrimaryModifierLabel()}+Z / {imageEditorPrimaryModifierLabel()}+Shift+Z /{' '}
              {imageEditorPrimaryModifierLabel()}+Y
            </kbd>
          </li>
          <li className="flex justify-between gap-echo-lg py-1">
            <span>Видалити вибране</span>
            <kbd>Delete / Backspace</kbd>
          </li>
          <li className="flex justify-between gap-echo-lg py-1">
            <span>Застосувати обрізання</span>
            <kbd>Enter</kbd>
          </li>
          <li className="flex justify-between gap-echo-lg py-1">
            <span>Скасувати дію</span>
            <kbd>Escape</kbd>
          </li>
          <li className="flex justify-between gap-echo-lg py-1">
            <span>Тимчасове переміщення полотна</span>
            <kbd>Space + drag / middle button</kbd>
          </li>
          <li className="flex justify-between gap-echo-lg py-1">
            <span>Масштаб</span>
            <kbd>Wheel</kbd>
          </li>
        </ul>
      </section>
    </Popover>
  );
  return (
    <nav
      aria-label="Інструменти редактора"
      className="flex h-[52px] shrink-0 items-center border-b border-echo-border px-2"
    >
      {desktop ? (
        <>
          <div className="flex min-w-0 flex-1 items-center">
            <ToolGroup>
              {toolButton(ImageEditorTool.Select)}
              {toolButton(ImageEditorTool.Pan)}
              {toolButton(ImageEditorTool.Crop)}
            </ToolGroup>
            <GroupSeparator />
            <ToolGroup>
              {toolButton(ImageEditorTool.Text)} {toolButton(ImageEditorTool.Rectangle)}
              {toolButton(ImageEditorTool.Ellipse)} {toolButton(ImageEditorTool.Line)}
              {toolButton(ImageEditorTool.Arrow)} {toolButton(ImageEditorTool.Brush)}
            </ToolGroup>
            <GroupSeparator />
            <ToolGroup>
              {toolButton(ImageEditorTool.Conceal)}
              {toolButton(ImageEditorTool.Magnifier)}
            </ToolGroup>
            <div className="min-w-0 flex-1" />
            <ToolGroup>
              {helpButton}
              <ImageEditorIconButton
                label="Видалити вибране"
                icon={<DeleteIcon />}
                onClick={props.onDeleteSelected}
                disabled={props.disabled || !props.canDeleteSelected}
              />
            </ToolGroup>
            <GroupSeparator />
            <ToolGroup>
              <ImageEditorIconButton
                label="Скасувати останню дію"
                icon={<UndoIcon />}
                onClick={props.onUndo}
                disabled={props.disabled || !props.canUndo}
              />
              <ImageEditorIconButton
                label="Повторити останню дію"
                icon={<RedoIcon />}
                onClick={props.onRedo}
                disabled={props.disabled || !props.canRedo}
              />
              <ImageEditorIconButton
                label="Скинути всі зміни"
                icon={<RestartAltIcon />}
                onClick={props.onResetEdits}
                disabled={props.disabled}
              />
            </ToolGroup>
          </div>
          <div className="ml-2 flex shrink-0 border-l border-echo-border pl-2">
            <ImageEditorViewControls
              disabled={props.disabled}
              zoom={props.zoom}
              onZoomChange={props.onZoomChange}
              onFit={props.onFitViewport}
              onActualSize={props.onActualSize}
              onCenter={props.onCenterViewport}
            />
          </div>
        </>
      ) : (
        <>
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            {visibleTools.map(toolButton)}
          </div>
          <ImageEditorIconButton
            id="image-editor-more-button"
            ariaControls={anchor ? 'image-editor-more-menu' : undefined}
            ariaExpanded={Boolean(anchor)}
            ariaHaspopup="menu"
            label="Ще"
            icon={<MoreHorizIcon />}
            onClick={(event) => {
              setAnchor(event.currentTarget);
              props.onMenuOpenChange(true);
            }}
            disabled={props.disabled}
            active={moreIsActive}
          />
          <PowerMenu
            id="image-editor-more-menu"
            anchorEl={anchor}
            open={Boolean(anchor)}
            onClose={closeMenu}
            slotProps={{ list: { 'aria-labelledby': 'image-editor-more-button' } }}
          >
            <ListSubheader>Інші інструменти</ListSubheader>
            {overflowTools.map(menuTool)}
            <ListSubheader>Редагування</ListSubheader>
            <MenuItem
              disabled={props.disabled || !props.canDeleteSelected}
              onClick={() => action(props.onDeleteSelected)}
            >
              <ListItemIcon>
                <DeleteIcon />
              </ListItemIcon>
              Видалити вибране
            </MenuItem>
            <MenuItem
              disabled={props.disabled || !props.canUndo}
              onClick={() => action(props.onUndo)}
            >
              <ListItemIcon>
                <UndoIcon />
              </ListItemIcon>
              Скасувати останню дію
            </MenuItem>
            <MenuItem
              disabled={props.disabled || !props.canRedo}
              onClick={() => action(props.onRedo)}
            >
              <ListItemIcon>
                <RedoIcon />
              </ListItemIcon>
              Повторити останню дію
            </MenuItem>
            <MenuItem disabled={props.disabled} onClick={() => action(props.onResetEdits)}>
              <ListItemIcon>
                <RestartAltIcon />
              </ListItemIcon>
              Скинути всі зміни
            </MenuItem>
            <ListSubheader>Вигляд</ListSubheader>
            <MenuItem
              disabled={props.disabled}
              onClick={() => action(() => props.onZoomChange(props.zoom / 100 - 0.1))}
            >
              <ListItemIcon>
                <ZoomOutIcon />
              </ListItemIcon>
              Зменшити масштаб
            </MenuItem>
            <MenuItem
              disabled={props.disabled}
              onClick={() => action(() => props.onZoomChange(props.zoom / 100 + 0.1))}
            >
              <ListItemIcon>
                <ZoomInIcon />
              </ListItemIcon>
              Збільшити масштаб
            </MenuItem>
            <MenuItem disabled={props.disabled} onClick={() => action(props.onFitViewport)}>
              <ListItemIcon>
                <FitScreenIcon />
              </ListItemIcon>
              Вмістити у вікно
            </MenuItem>
            <MenuItem disabled={props.disabled} onClick={() => action(props.onActualSize)}>
              <ListItemIcon>
                <AspectRatioIcon />
              </ListItemIcon>
              1:1
            </MenuItem>
            <MenuItem disabled={props.disabled} onClick={() => action(props.onCenterViewport)}>
              <ListItemIcon>
                <CenterFocusStrongIcon />
              </ListItemIcon>
              Центрувати
            </MenuItem>
            <MenuItem
              disabled={props.disabled}
              onClick={(event) => {
                const moreButton = anchor;
                closeMenu();
                setHelpAnchor(moreButton);
                props.onMenuOpenChange(true);
              }}
            >
              <ListItemIcon>
                <HelpOutlineIcon />
              </ListItemIcon>
              Гарячі клавіші
            </MenuItem>
          </PowerMenu>
        </>
      )}
      {helpPopover}
    </nav>
  );
}
