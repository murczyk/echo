port module PagePorts.RerAnalysisNeoPorts exposing (rer_analysis_neo_loadBetaBannerDismissed, rer_analysis_neo_loadBetaBannerDismissedRes, rer_analysis_neo_saveBetaBannerDismissed)


port rer_analysis_neo_saveBetaBannerDismissed : Bool -> Cmd msg


port rer_analysis_neo_loadBetaBannerDismissed : () -> Cmd msg


port rer_analysis_neo_loadBetaBannerDismissedRes : (Bool -> msg) -> Sub msg
