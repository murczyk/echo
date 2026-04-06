port module PagePorts.RerAnalysisNeoPorts exposing (rer_analysis_neo_loadAlphaBannerDismissed, rer_analysis_neo_loadAlphaBannerDismissedRes, rer_analysis_neo_saveAlphaBannerDismissed)


port rer_analysis_neo_saveAlphaBannerDismissed : Bool -> Cmd msg


port rer_analysis_neo_loadAlphaBannerDismissed : () -> Cmd msg


port rer_analysis_neo_loadAlphaBannerDismissedRes : (Bool -> msg) -> Sub msg
