import Chip, { ChipProps } from '@mui/material/Chip';
import { SxProps, Theme, getContrastRatio } from '@mui/material/styles';
import React from 'react';

type PowerChipProps = {
  label: React.ReactNode;
  color?: ChipProps['color'];
  selected?: boolean;
  onClick?: () => void;
  interactive?: boolean;
  backgroundColor?: string;
  selectedBackgroundColor?: string;
  unselectedBackgroundColor?: string;
  selectedTextColor?: string;
  unselectedTextColor?: string;
  selectedBorderColor?: string;
  unselectedBorderColor?: string;
  autoTextContrast?: boolean;
  unselectedOpacity?: number;
  fontSize?: string | number;
  fontWeight?: string | number;
  fontFamily?: string;
  minWidth?: string | number;
  labelPaddingX?: number;
  labelPaddingY?: number;
  sx?: SxProps<Theme>;
  size?: ChipProps['size'];
  title?: string;
};

function getReadableTextColor(backgroundColor: string): string {
  try {
    const whiteContrast = getContrastRatio(backgroundColor, '#ffffff');
    const blackContrast = getContrastRatio(backgroundColor, '#000000');
    return whiteContrast >= blackContrast ? '#ffffff' : '#000000';
  } catch (_) {
    return '#000000';
  }
}

export function PowerChip({
  label,
  color = 'primary',
  selected = false,
  onClick,
  interactive,
  backgroundColor,
  selectedBackgroundColor,
  unselectedBackgroundColor,
  selectedTextColor,
  unselectedTextColor,
  selectedBorderColor,
  unselectedBorderColor,
  autoTextContrast = false,
  unselectedOpacity,
  fontSize = '0.8125rem',
  fontWeight = 500,
  fontFamily,
  minWidth,
  labelPaddingX = 0.75,
  labelPaddingY = 0,
  sx,
  size = 'small',
  title,
}: PowerChipProps) {
  const isInteractive = interactive ?? Boolean(onClick);
  const hasExplicitPalette =
    backgroundColor !== undefined ||
    selectedBackgroundColor !== undefined ||
    unselectedBackgroundColor !== undefined ||
    selectedTextColor !== undefined ||
    unselectedTextColor !== undefined ||
    selectedBorderColor !== undefined ||
    unselectedBorderColor !== undefined ||
    autoTextContrast;

  const hasSemanticColor = color !== undefined && color !== 'default';
  const defaultSelectedBackgroundColor = hasSemanticColor ? `${color}.main` : 'action.selected';
  const defaultUnselectedBackgroundColor = hasSemanticColor ? 'transparent' : 'transparent';
  const defaultSelectedTextColor = hasSemanticColor ? `${color}.contrastText` : 'text.primary';
  const defaultUnselectedTextColor = hasSemanticColor ? `${color}.main` : 'text.secondary';
  const defaultSelectedBorderColor = hasSemanticColor ? `${color}.main` : 'transparent';
  const defaultUnselectedBorderColor = hasSemanticColor ? `${color}.main` : 'divider';

  const activeBackgroundColor = selected
    ? selectedBackgroundColor ?? backgroundColor ?? defaultSelectedBackgroundColor
    : unselectedBackgroundColor ?? backgroundColor ?? defaultUnselectedBackgroundColor;
  const activeTextColor = autoTextContrast
    ? getReadableTextColor(activeBackgroundColor)
    : selected
      ? selectedTextColor ?? defaultSelectedTextColor
      : unselectedTextColor ?? defaultUnselectedTextColor;
  const activeBorderColor = selected
    ? selectedBorderColor ?? defaultSelectedBorderColor
    : unselectedBorderColor ?? defaultUnselectedBorderColor;
  const inactiveOpacity = unselectedOpacity ?? (hasExplicitPalette ? (isInteractive ? 0.75 : 1) : 1);
  const variant: ChipProps['variant'] = hasExplicitPalette ? 'filled' : selected ? 'filled' : 'outlined';

  return (
    <Chip
      size={size}
      color={hasExplicitPalette ? undefined : color}
      label={label}
      title={title}
      onClick={isInteractive ? onClick : undefined}
      variant={variant}
      sx={[
        {
          backgroundColor: activeBackgroundColor,
          color: activeTextColor,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: activeBorderColor,
          fontSize,
          fontWeight,
          fontFamily,
          minWidth,
          opacity: selected ? 1 : inactiveOpacity,
          cursor: isInteractive ? 'pointer' : 'text',
          '& .MuiChip-label': {
            px: labelPaddingX,
            py: labelPaddingY,
            display: 'inline-flex',
            alignItems: 'center',
            lineHeight: 'normal',
          },
          ...(isInteractive && !selected ? { '&:hover': { opacity: 1 } } : {}),
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    />
  );
}
