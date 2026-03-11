export const CUSTOM_CELL_STYLES = {
  borderRight: '1px solid',
  borderBottom: '1px solid',
  borderColor: 'var(--bs-border-color)',
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
        },
      },
      muiTableBodyCellProps: {
        sx: {
          ...CUSTOM_CELL_STYLES,
          justifyContent: 'center',
          padding: '10px!important',
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
        },
      },
    },
  },
  muiTablePaperProps: ({ table }: { table: any }) => ({
    sx: {
      borderRadius: 0,
      boxShadow: 'none',
      display: 'flex',
      flexDirection: 'column',
      bgcolor: 'var(--bs-body-bg)',
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
      },
      '& .MuiTableHead-root .MuiTableRow-root': {
        backgroundColor: 'var(--bs-body-bg)',
      },
      '& .MuiTableHead-root .MuiTableCell-head': {
        backgroundColor: 'var(--bs-body-bg)',
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
