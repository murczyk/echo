import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { Box, Tooltip, Typography } from '@mui/material';
import type { ReactNode } from 'react';

type ResponsiveSpacing = number | string | { xs?: number | string; sm?: number | string };

type Props = {
  title: ReactNode;
  titleInfo?: ReactNode;
  titleLeadingActions?: ReactNode;
  titleLeadingGap?: ResponsiveSpacing;
  titleTrailing?: ReactNode;
  titleTrailingGap?: ResponsiveSpacing;
  titleActions?: ReactNode;
  titleActionsGap?: ResponsiveSpacing;
  pinTitleActionsToRight?: boolean;
  middleGap?: ResponsiveSpacing;
  middle?: ReactNode;
  actions?: ReactNode;
  compactLayout?: boolean;
  fullWidthActions?: boolean;
  className?: string;
  titleClassName?: string;
};

export function PageHeader({
  title,
  titleInfo,
  titleLeadingActions,
  titleLeadingGap = 1,
  titleTrailing,
  titleTrailingGap = 1,
  titleActions,
  titleActionsGap = { xs: 'auto', sm: 0 },
  pinTitleActionsToRight = false,
  middleGap = 2,
  middle,
  actions,
  compactLayout = false,
  fullWidthActions = false,
  className,
  titleClassName,
}: Props) {
  return (
    <Box
      className={className}
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        rowGap: 2,
        columnGap: 0,
        width: '100%',
        position: 'relative',
      }}
    >
      <Box
        sx={{
          minHeight: 48,
          display: 'flex',
          alignItems: 'center',
          flexShrink: 0,
          minWidth: 0,
          width: compactLayout ? '100%' : { xs: '100%', sm: 'auto' },
          flexWrap: compactLayout ? 'wrap' : 'nowrap',
          rowGap: compactLayout ? 1 : 0,
        }}
      >
        {titleLeadingActions ? (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              minWidth: 0,
              flexShrink: 0,
              mr: titleLeadingGap,
            }}
          >
            {titleLeadingActions}
          </Box>
        ) : null}
        <Typography
          component="h1"
          variant="h5"
          sx={{ m: 0, fontWeight: 600, lineHeight: 1.2 }}
          className={titleClassName}
        >
          {title}
        </Typography>
        {titleTrailing ? (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              minWidth: 0,
              flexShrink: 0,
              ml: titleTrailingGap,
            }}
          >
            {titleTrailing}
          </Box>
        ) : null}
        {titleActions ? (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              minWidth: 0,
              flexShrink: 0,
              ...(pinTitleActionsToRight
                ? {
                    position: 'absolute',
                    top: 4,
                    right: 0,
                    zIndex: 1,
                  }
                : { ml: titleActionsGap }),
            }}
          >
            {titleActions}
          </Box>
        ) : null}
        {titleInfo ? (
          <Tooltip title={titleInfo} arrow placement="right-start">
            <Box
              component="span"
              aria-label="Інформація про сторінку"
              sx={{
                ml: 0.75,
                display: 'inline-flex',
                alignSelf: 'center',
                lineHeight: 0,
                cursor: 'default',
              }}
            >
              <InfoOutlinedIcon fontSize="small" />
            </Box>
          </Tooltip>
        ) : null}
      </Box>
      {middle ? (
        <Box
          sx={{
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-start',
            width: compactLayout ? '100%' : { xs: '100%', sm: 'fit-content' },
            maxWidth: '100%',
            flexShrink: 0,
            flexBasis: compactLayout ? '100%' : { xs: '100%', sm: 'auto' },
            ml: compactLayout ? 0 : { xs: 0, sm: middleGap },
          }}
        >
          {middle}
        </Box>
      ) : null}
      {actions ? (
        <Box
          sx={{
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            marginLeft: 'auto',
            flexShrink: 0,
            ...(fullWidthActions ? { width: '100%', marginLeft: 0 } : {}),
          }}
        >
          {actions}
        </Box>
      ) : null}
    </Box>
  );
}
