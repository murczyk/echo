import AddIcon from '@mui/icons-material/Add';
import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrong';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import RemoveIcon from '@mui/icons-material/Remove';

import { PowerButton } from '../../../components/PowerButton';
import { ImageEditorIconButton } from './ImageEditorIconButton';

export function ImageEditorViewControls({
  disabled,
  zoom,
  onZoomChange,
  onFit,
  onActualSize,
  onCenter,
}: {
  disabled: boolean;
  zoom: number;
  onZoomChange: (value: number) => void;
  onFit: () => void;
  onActualSize: () => void;
  onCenter: () => void;
}) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      <span className="min-w-12 text-center text-echo-sm tabular-nums">{zoom}%</span>
      <ImageEditorIconButton
        label="Зменшити масштаб"
        icon={<RemoveIcon />}
        onClick={() => onZoomChange(zoom / 100 - 0.1)}
        disabled={disabled}
      />
      <ImageEditorIconButton
        label="Збільшити масштаб"
        icon={<AddIcon />}
        onClick={() => onZoomChange(zoom / 100 + 0.1)}
        disabled={disabled}
      />
      <ImageEditorIconButton
        label="Вмістити у вікно"
        icon={<FitScreenIcon />}
        onClick={onFit}
        disabled={disabled}
      />
      <PowerButton size="small" onClick={onActualSize} disabled={disabled}>
        1:1
      </PowerButton>
      <ImageEditorIconButton
        label="Центрувати"
        icon={<CenterFocusStrongIcon />}
        onClick={onCenter}
        disabled={disabled}
      />
    </div>
  );
}
