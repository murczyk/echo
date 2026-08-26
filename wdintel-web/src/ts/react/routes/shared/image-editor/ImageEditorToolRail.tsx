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
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import PanToolIcon from '@mui/icons-material/PanTool';
import BorderColorIcon from '@mui/icons-material/BorderColor';
import RectangleOutlinedIcon from '@mui/icons-material/RectangleOutlined';
import RedoIcon from '@mui/icons-material/Redo';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import TextFieldsIcon from '@mui/icons-material/TextFields';
import UndoIcon from '@mui/icons-material/Undo';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import { ListItemIcon, ListSubheader, MenuItem, useMediaQuery } from '@mui/material';
import { useEffect, useState, type ReactNode } from 'react';

import { PowerMenu } from '../../../components/PowerMenu';
import { ImageEditorIconButton } from './ImageEditorIconButton';
import { ImageEditorDiagonalLineIcon } from './ImageEditorIcons';
import { ImageEditorViewControls } from './ImageEditorViewControls';
import type { ImageEditorTool } from './image-editor.types';

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
  select: { label: 'Вибрати об’єкт', icon: <HighlightAltIcon /> },
  pan: { label: 'Перемістити полотно', icon: <PanToolIcon />, iconSize: 20 },
  crop: { label: 'Обрізати', icon: <CropIcon /> },
  text: { label: 'Текст', icon: <TextFieldsIcon /> },
  rectangle: { label: 'Прямокутник', icon: <RectangleOutlinedIcon /> },
  ellipse: { label: 'Еліпс', icon: <CircleOutlinedIcon /> },
  line: { label: 'Лінія', icon: <ImageEditorDiagonalLineIcon /> },
  arrow: { label: 'Стрілка', icon: <ArrowForwardIcon /> },
  brush: { label: 'Пензель', icon: <BrushIcon /> },
  highlight: { label: 'Маркер', icon: <BorderColorIcon /> },
  conceal: { label: 'Розмиття', icon: <BlurOnIcon /> },
  magnifier: { label: 'Лупа', icon: <ZoomInIcon /> },
};

const TABLET_VISIBLE_TOOLS: readonly ImageEditorTool[] = [
  'select',
  'pan',
  'crop',
  'text',
  'rectangle',
  'arrow',
  'brush',
  'conceal',
];
const MOBILE_VISIBLE_TOOLS: readonly ImageEditorTool[] = ['select', 'pan', 'text', 'conceal'];
const TOOL_ORDER = Object.keys(TOOLS) as ImageEditorTool[];

export function ImageEditorToolRail(props: Props) {
  const desktop = useMediaQuery('(min-width: 1280px)', { noSsr: true });
  const tablet = useMediaQuery('(min-width: 768px)', { noSsr: true });
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (props.dismissMenu) setAnchor(null);
  }, [props.dismissMenu]);
  const closeMenu = () => {
    setAnchor(null);
    props.onMenuOpenChange(false);
  };
  const toolButton = (value: ImageEditorTool) => {
    const { label, icon, iconSize } = TOOLS[value];
    return (
      <ImageEditorIconButton
        label={label}
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
    return (
      <MenuItem
        key={value}
        selected={props.tool === value}
        disabled={props.disabled}
        onClick={() => selectTool(value)}
      >
        <ListItemIcon>{icon}</ListItemIcon>
        {label}
      </MenuItem>
    );
  };
  const visibleTools = tablet ? TABLET_VISIBLE_TOOLS : MOBILE_VISIBLE_TOOLS;
  const overflowTools = TOOL_ORDER.filter((value) => !visibleTools.includes(value));
  const moreIsActive = !desktop && overflowTools.includes(props.tool);
  return (
    <nav
      aria-label="Інструменти редактора"
      className="flex h-[52px] shrink-0 items-center border-b border-echo-border px-2"
    >
      {desktop ? (
        <>
          <div className="flex min-w-0 flex-1 items-center">
            <ToolGroup>
              {toolButton('select')}
              {toolButton('pan')}
              {toolButton('crop')}
            </ToolGroup>
            <GroupSeparator />
            <ToolGroup>
              {toolButton('text')}
              {toolButton('rectangle')}
              {toolButton('ellipse')}
              {toolButton('line')}
              {toolButton('arrow')}
              {toolButton('brush')}
              {toolButton('highlight')}
            </ToolGroup>
            <GroupSeparator />
            <ToolGroup>
              {toolButton('conceal')}
              {toolButton('magnifier')}
            </ToolGroup>
            <div className="min-w-0 flex-1" />
            <ToolGroup>
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
          </PowerMenu>
        </>
      )}
    </nav>
  );
}
