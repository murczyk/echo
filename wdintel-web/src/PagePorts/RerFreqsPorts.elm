port module PagePorts.RerFreqsPorts exposing (rer_freqs_closeMapRes, rer_freqs_openMap)

import Bindings as B


port rer_freqs_openMap : { points : List B.FreqPoint, containerId : String } -> Cmd msg


port rer_freqs_closeMapRes :
    (String
     -> msg
    )
    -> Sub msg
