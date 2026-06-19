#[derive(Clone, Copy)]
pub(super) struct ReportColors {
    pub(super) blue: u32,
    pub(super) yellow: u32,
    pub(super) gray: u32,
    pub(super) orange: u32,
    pub(super) pink: u32,
    pub(super) green: u32,
    pub(super) brown: u32,
}

const DEFAULT: ReportColors = ReportColors {
    blue: 0xf4f8fc,
    yellow: 0xfffbef,
    gray: 0xf7f7f7,
    orange: 0xfff7ed,
    pink: 0xfff5fb,
    green: 0xf4fbf3,
    brown: 0xfff2ec,
};

const LEGACY: ReportColors = ReportColors {
    blue: 0x5b9bd5,
    yellow: 0xfef2cb,
    gray: 0xd8d8d8,
    orange: 0xffc000,
    pink: 0xff33cc,
    green: 0x77bc65,
    brown: 0xf67315,
};

pub(super) fn for_keep_old_colors(keep_old_colors: bool) -> ReportColors {
    if keep_old_colors {
        LEGACY
    } else {
        DEFAULT
    }
}
