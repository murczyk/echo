import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
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
import RemoveRedEyeIcon from '@mui/icons-material/RemoveRedEye';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import TextFieldsIcon from '@mui/icons-material/TextFields';
import UndoIcon from '@mui/icons-material/Undo';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import { ListItemIcon, ListSubheader, MenuItem, SvgIcon, useMediaQuery } from '@mui/material';
import { useState, type MouseEvent, type ReactNode } from 'react';

import { PowerButton } from '../../../components/PowerButton';
import { PowerMenu } from '../../../components/PowerMenu';
import { ImageEditorIconButton } from './ImageEditorIconButton';
import { ImageEditorViewControls } from './ImageEditorViewControls';
import type { ImageEditorTool } from './image-editor.types';

function ToolGroup({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-r border-echo-border pr-2 last:border-r-0">
      {children}
    </div>
  );
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
};

function DiagonalLineIcon() {
  return (
    <SvgIcon viewBox="0 0 24 24">
      <path
        d="M5 19 19 5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </SvgIcon>
  );
}

export function ImageEditorToolRail(props: Props) {
  const desktop = useMediaQuery('(min-width: 1280px)', { noSsr: true });
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const toolButton = (
    value: ImageEditorTool,
    label: string,
    icon: ReactNode,
    iconSize?: number,
  ) => (
    <ImageEditorIconButton
      label={label}
      icon={icon}
      onClick={() => props.onToolChange(value)}
      disabled={props.disabled}
      active={props.tool === value}
      iconSize={iconSize}
    />
  );
  const selectTool = (value: ImageEditorTool) => {
    setAnchor(null);
    props.onToolChange(value);
  };
  const action = (callback: () => void) => {
    setAnchor(null);
    callback();
  };
  const menuTool = (value: ImageEditorTool, label: string, icon: ReactNode) => (
    <MenuItem
      key={value}
      autoFocus={value === 'crop'}
      selected={props.tool === value}
      disabled={props.disabled}
      onClick={() => selectTool(value)}
    >
      <ListItemIcon>{icon}</ListItemIcon>
      {label}
    </MenuItem>
  );
  return (
    <nav
      aria-label="Інструменти редактора"
      className="flex h-14 shrink-0 items-center border-b border-echo-border px-2"
    >
      {desktop ? (
        <>
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
            <ToolGroup>
              {toolButton('select', 'Вибрати об’єкт', <HighlightAltIcon />)}
              {toolButton('pan', 'Перемістити полотно', <PanToolIcon />, 20)}
              {toolButton('crop', 'Обрізати', <CropIcon />)}
            </ToolGroup>
            <ToolGroup>
              {toolButton('text', 'Текст', <TextFieldsIcon />)}
              {toolButton('rectangle', 'Прямокутник', <RectangleOutlinedIcon />)}
              {toolButton('ellipse', 'Еліпс', <CircleOutlinedIcon />)}
              {toolButton('line', 'Лінія', <DiagonalLineIcon />)}
              {toolButton('arrow', 'Стрілка', <ArrowForwardIcon />)}
              {toolButton('brush', 'Пензель', <BrushIcon />)}
              {toolButton('highlight', 'Маркер', <BorderColorIcon />)}
            </ToolGroup>
            <ToolGroup>
              {toolButton('conceal', 'Розмиття', <BlurOnIcon />)}
              {toolButton('magnifier', 'Лупа', <RemoveRedEyeIcon />)}
            </ToolGroup>
            <ToolGroup>
              <ImageEditorIconButton
                label="Видалити вибране"
                icon={<DeleteIcon />}
                onClick={props.onDeleteSelected}
                disabled={props.disabled || !props.canDeleteSelected}
              />
            </ToolGroup>
            <ToolGroup>
              <ImageEditorIconButton
                label="Скасувати"
                icon={<UndoIcon />}
                onClick={props.onUndo}
                disabled={props.disabled || !props.canUndo}
              />
              <ImageEditorIconButton
                label="Повторити"
                icon={<RedoIcon />}
                onClick={props.onRedo}
                disabled={props.disabled || !props.canRedo}
              />
              <ImageEditorIconButton
                label="Скинути зміни"
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
            {toolButton('select', 'Вибрати об’єкт', <HighlightAltIcon />)}
            {toolButton('pan', 'Перемістити полотно', <PanToolIcon />, 20)}
            {toolButton('text', 'Текст', <TextFieldsIcon />)}
            {toolButton('conceal', 'Розмиття', <BlurOnIcon />)}
            {toolButton('magnifier', 'Лупа', <RemoveRedEyeIcon />)}
          </div>
          <PowerButton
            id="image-editor-more-button"
            aria-controls={anchor ? 'image-editor-more-menu' : undefined}
            aria-expanded={Boolean(anchor)}
            aria-haspopup="menu"
            size="small"
            startIcon={<MoreHorizIcon />}
            onClick={(event: MouseEvent<HTMLButtonElement>) => setAnchor(event.currentTarget)}
            disabled={props.disabled}
          >
            Більше
          </PowerButton>
          <PowerMenu
            id="image-editor-more-menu"
            anchorEl={anchor}
            open={Boolean(anchor)}
            onClose={() => setAnchor(null)}
            slotProps={{ list: { 'aria-labelledby': 'image-editor-more-button' } }}
          >
            <ListSubheader>Інші інструменти</ListSubheader>
            {menuTool('crop', 'Обрізати', <CropIcon />)}
            {menuTool('rectangle', 'Прямокутник', <RectangleOutlinedIcon />)}
            {menuTool('ellipse', 'Еліпс', <CircleOutlinedIcon />)}
            {menuTool('line', 'Лінія', <DiagonalLineIcon />)}
            {menuTool('arrow', 'Стрілка', <ArrowForwardIcon />)}
            {menuTool('brush', 'Пензель', <BrushIcon />)}
            {menuTool('highlight', 'Маркер', <BorderColorIcon />)}
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
              Скасувати
            </MenuItem>
            <MenuItem
              disabled={props.disabled || !props.canRedo}
              onClick={() => action(props.onRedo)}
            >
              <ListItemIcon>
                <RedoIcon />
              </ListItemIcon>
              Повторити
            </MenuItem>
            <MenuItem disabled={props.disabled} onClick={() => action(props.onResetEdits)}>
              <ListItemIcon>
                <RestartAltIcon />
              </ListItemIcon>
              Скинути зміни
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
                <CenterFocusStrongIcon />
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
