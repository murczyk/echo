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

export const CUSTOM_STYLES = {
  muiTableHeadCellProps: {
    sx: {
      ...CUSTOM_CELL_STYLES,
      paddingTop: '10px',
      paddingBottom: '10px',
      '& .Mui-TableHeadCell-Content': {
        width: '100%',
        height: '100%',
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
    sx: CUSTOM_CELL_STYLES,
  },
  displayColumnDefOptions: {
    'mrt-row-actions': {
      size: 80,
      enableHiding: true,
      visibleInShowHideMenu: false,
      muiTableHeadCellProps: {
        sx: {
          ...CUSTOM_CELL_STYLES,
          justifyContent: 'center',
          display: 'flex',
          flexDirection: 'row',
          padding: '0 5px!important',

          '& .Mui-TableHeadCell-Content': {
            width: '18px',
          },
        },
      },
      muiTableBodyCellProps: {
        sx: {
          ...CUSTOM_CELL_STYLES,
          justifyContent: 'center',
        },
      },
      grow: false,
    },
    'mrt-row-select': {
      size: 54,
      grow: false,
      enableHiding: true,
      visibleInShowHideMenu: false,
      muiTableHeadCellProps: {
        sx: {
          ...CUSTOM_CELL_STYLES,
          justifyContent: 'center',
          paddingTop: '0px',
          paddingBottom: '0px',
          paddingLeft: '0px',
          paddingRight: '0px',

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
      visibleInShowHideMenu: false,
      muiTableHeadCellProps: {
        sx: {
          justifyContent: 'center',
          padding: '5px!important',
          ...CUSTOM_CELL_STYLES,
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
      border: '1px solid',
      borderColor: 'var(--bs-border-color)',
      '& .MuiTableHead-root': {
        opacity: 1,
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
