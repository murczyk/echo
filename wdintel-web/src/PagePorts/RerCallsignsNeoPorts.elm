port module PagePorts.RerCallsignsNeoPorts exposing (rer_callsigns_neo_loadBetaBannerDismissed, rer_callsigns_neo_loadBetaBannerDismissedRes, rer_callsigns_neo_saveBetaBannerDismissed)


port rer_callsigns_neo_saveBetaBannerDismissed : Bool -> Cmd msg


port rer_callsigns_neo_loadBetaBannerDismissed : () -> Cmd msg


port rer_callsigns_neo_loadBetaBannerDismissedRes : (Bool -> msg) -> Sub msg
