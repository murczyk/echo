export const CUSTOM_CELL_STYLES = {
  borderRight: '1px solid',
  borderBottom: '1px solid',
  borderColor: 'var(--bs-border-color)',
  color: 'var(--bs-body-color)',
  '&:hover': {},
  '&:last-child': {
    borderRight: 0,
  },
  transitionDuration: '0s',
};

export const FULL_WIDTH_TABLE_PAPER_SX = {
  minWidth: 0,
  maxWidth: '100%',
  width: '100%',
  height: '100%',
  minHeight: 0,
  overflow: 'hidden',
};

export const PAGE_SCROLL_TABLE_CONTAINER_SX = {
  flex: 1,
  minHeight: 0,
  height: '100%',
  minWidth: 0,
  maxWidth: '100%',
  width: '100%',
  maxHeight: '100%',
  overflowX: 'auto',
  overflowY: 'auto',
  WebkitOverflowScrolling: 'touch',
};

export function getPageScrollTableContainerSx({
  loading = false,
  height = '100%',
  minHeight = 0,
  maxHeight = '100%',
  idleOverflowX = 'auto',
  idleOverflowY = 'auto',
  idleOverflow,
}: {
  loading?: boolean;
  height?: string | number;
  minHeight?: string | number | undefined;
  maxHeight?: string | number;
  idleOverflowX?: 'auto' | 'hidden' | 'visible';
  idleOverflowY?: 'auto' | 'hidden' | 'visible';
  idleOverflow?: 'auto' | 'hidden' | 'visible' | undefined;
}) {
  return {
    ...PAGE_SCROLL_TABLE_CONTAINER_SX,
    height,
    minHeight,
    maxHeight,
    overflowX: loading ? 'hidden' : idleOverflowX,
    overflowY: loading ? 'hidden' : idleOverflowY,
    ...(loading || idleOverflow !== undefined
      ? { overflow: loading ? 'hidden' : idleOverflow }
      : {}),
  };
}

export const FULL_HEIGHT_LOADING_ROW_COUNT = 24;

function getAuthUserNameFromShell(): string {
  if (typeof document === 'undefined') return '';
  const name = document.querySelector('.app-shell')?.getAttribute('data-auth-user-name');
  if (!name || name === 'anonymous') return '';
  return name;
}

export const CUSTOM_STYLES = {
  muiTableHeadCellProps: {
    sx: {
      ...CUSTOM_CELL_STYLES,
      paddingTop: '10px',
      paddingBottom: '10px',
      paddingLeft: '10px',
      paddingRight: '10px',
      minHeight: '56px',
      backgroundColor: 'var(--bs-body-bg)',
      '& .Mui-TableHeadCell-Content': {
        width: '100%',
        height: '100%',
        minHeight: '36px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      },
      '& .Mui-TableHeadCell-Content-Wrapper': {
        whiteSpace: 'pre-wrap',
      },
    },
  },
  muiTableBodyCellProps: {
    sx: {
      ...CUSTOM_CELL_STYLES,
      padding: '10px',
      backgroundColor: 'transparent',
    },
  },
  muiTableBodyProps: {
    sx: {
      backgroundColor: 'transparent',
    },
  },
  displayColumnDefOptions: {
    'mrt-row-actions': {
      size: 80,
      enableHiding: true,
      enableColumnOrdering: false,
      visibleInShowHideMenu: false,
      muiTableHeadCellProps: {
        sx: {
          ...CUSTOM_CELL_STYLES,
          justifyContent: 'center',
          display: 'flex',
          flexDirection: 'row',
          padding: '10px!important',
          minHeight: '56px',
          backgroundColor: 'var(--bs-body-bg)',

          '& .Mui-TableHeadCell-Content': {
            width: '100%',
            minHeight: '28px',
            justifyContent: 'center',
          },
          '& .Mui-TableHeadCell-Content-Labels': {
            flex: 1,
            justifyContent: 'center',
          },
          '& .Mui-TableHeadCell-Content-Wrapper': {
            width: '100%',
            textAlign: 'center',
          },
          '&:last-child': {
            borderRight: '1px solid',
            borderColor: 'var(--bs-border-color)',
          },
        },
      },
      muiTableBodyCellProps: {
        sx: {
          ...CUSTOM_CELL_STYLES,
          justifyContent: 'center',
          padding: '10px!important',
          backgroundColor: 'transparent',
          '&:last-child': {
            borderRight: '1px solid',
            borderColor: 'var(--bs-border-color)',
          },
        },
      },
      grow: false,
    },
    'mrt-row-select': {
      size: 54,
      grow: false,
      enableHiding: true,
      enableColumnOrdering: false,
      visibleInShowHideMenu: false,
      muiTableHeadCellProps: {
        sx: {
          ...CUSTOM_CELL_STYLES,
          justifyContent: 'center',
          paddingTop: '0px',
          paddingBottom: '0px',
          paddingLeft: '0px',
          paddingRight: '0px',
          backgroundColor: 'var(--bs-body-bg)',

          '& .Mui-TableHeadCell-Content': {
            justifyContent: 'center',
          },
          '& .Mui-TableHeadCell-Content-Wrapper': {
            minWidth: '0px',
          },
        },
      },
      muiTableBodyCellProps: {
        sx: {
          justifyContent: 'center',
          ...CUSTOM_CELL_STYLES,
          backgroundColor: 'transparent',
        },
      },
    },
    'mrt-row-numbers': {
      size: 48,
      grow: false,
      enableHiding: true,
      enableColumnOrdering: false,
      visibleInShowHideMenu: false,
      muiTableHeadCellProps: {
        sx: {
          justifyContent: 'center',
          padding: '5px!important',
          ...CUSTOM_CELL_STYLES,
          backgroundColor: 'var(--bs-body-bg)',
          '& .Mui-TableHeadCell-Content': {
            justifyContent: 'center',
          },
          '& .Mui-TableHeadCell-Content-Wrapper': {
            minWidth: '0px',
          },
        },
      },
      muiTableBodyCellProps: {
        sx: {
          justifyContent: 'center',
          ...CUSTOM_CELL_STYLES,
          backgroundColor: 'transparent',
        },
      },
    },
  },
  muiTablePaperProps: ({ table }: { table: any }) => ({
    'data-table-watermark': getAuthUserNameFromShell(),
    sx: {
      ...(table.getState().showSkeletons
        ? {
            backgroundImage:
              'repeating-linear-gradient(to bottom, transparent 0, transparent 54px, color-mix(in srgb, var(--bs-border-color) 78%, transparent) 54px, color-mix(in srgb, var(--bs-border-color) 78%, transparent) 55px)',
            backgroundSize: '100% 56px',
            backgroundPosition: '0 56px',
          }
        : {}),
      borderRadius: 0,
      boxShadow: 'none',
      display: 'flex',
      flexDirection: 'column',
      position: 'relative',
      bgcolor: 'var(--bs-body-bg)',
      color: 'var(--bs-body-color)',
      '&::before, &::after': {
        content: 'attr(data-table-watermark)',
        position: 'absolute',
        fontSize: 'clamp(2.2rem, 4vw, 3.8rem)',
        fontWeight: 600,
        lineHeight: 1,
        letterSpacing: '0.02em',
        color: 'var(--bs-body-color)',
        opacity: 0.14,
        transform: 'rotate(-28deg)',
        pointerEvents: 'none',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        zIndex: 0,
      },
      '&::before': {
        left: '8%',
        top: '16%',
      },
      '&::after': {
        right: '6%',
        top: '56%',
      },
      '& > *': {
        position: 'relative',
        zIndex: 1,
      },
    },
    style: {
      padding: table.getState().isFullScreen ? 16 : undefined,
    },
  }),
  muiTableContainerProps: {
    sx: {
      flex: 1,
      minHeight: 0,
      border: '1px solid',
      borderColor: 'var(--bs-border-color)',
      '& .MuiTableBody-root .MuiTableRow-root:last-of-type > .MuiTableCell-root': {
        borderBottom: 0,
      },
      '& .MuiTableBody-root .MuiTableRow-root:last-child > .MuiTableCell-root': {
        borderBottom: 0,
      },
      '& .MuiTableHead-root': {
        opacity: 1,
        backgroundColor: 'var(--bs-body-bg)',
        color: 'var(--bs-body-color)',
      },
      '& .MuiTableHead-root .MuiTableRow-root': {
        backgroundColor: 'var(--bs-body-bg)',
      },
      '& .MuiTableHead-root .MuiTableCell-head': {
        backgroundColor: 'var(--bs-body-bg)',
        color: 'var(--bs-body-color)',
      },
      '& .MuiTable-root': {
        backgroundColor: 'transparent',
      },
      '& .MuiTableBody-root': {
        backgroundColor: 'transparent',
      },
      '& .MuiTableBody-root .MuiTableRow-root': {
        backgroundColor: 'transparent',
        color: 'var(--bs-body-color)',
      },
      '& .MuiTableBody-root .MuiTableCell-root': {
        backgroundColor: 'transparent',
        color: 'var(--bs-body-color)',
      },
    },
  },
  muiTopToolbarProps: {
    sx: {
      backgroundColor: 'transparent',
      minHeight: 'unset',
      paddingBottom: 1.5,

      '& .MuiBox-root': {
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: 0,
        paddingBottom: 0,
      },
    },
  },
};
