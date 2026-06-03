module Utils.RerNetworkDetails exposing (href, query)

import Dict exposing (Dict)
import Shared.Model exposing (RerNetworkDetailsPreferredView(..))
import String


query : RerNetworkDetailsPreferredView -> Dict String String
query preferredView =
    case preferredView of
        Classic ->
            Dict.fromList [ ( "view", "classic" ) ]

        Neo ->
            Dict.empty


href : RerNetworkDetailsPreferredView -> Int -> String
href preferredView networkId =
    let
        baseHref =
            "/rer-networks/" ++ String.fromInt networkId
    in
    case preferredView of
        Classic ->
            baseHref ++ "?view=classic"

        Neo ->
            baseHref
