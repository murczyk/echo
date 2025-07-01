module Le.NetworksUtils exposing (..)

import Bindings as B
import Dict exposing (Dict)
import Html exposing (..)
import Le.Block.Unit as Unit
import Le.Utils exposing (networkKindVHFMapping)


renderNetworkNameWithoutType network masterUnits =
    div []
        [ div []
            [ text " р/м "
            , text network.name
            , text " "
            , text <|
                String.join ", "
                    (List.map (Unit.unitName masterUnits)
                        (Maybe.withDefault [] network.unitIds)
                    )
            ]
        ]


renderNetwork : B.Network -> Dict Int B.Unit -> Html msg
renderNetwork network masterUnits =
    div []
        [ div []
            [ --text <| networkKindVHFMapping network.kind
              text " р/м "
            , text network.name
            , text " "
            , text <|
                String.join ", "
                    (List.map (Unit.unitName masterUnits)
                        (Maybe.withDefault [] network.unitIds)
                    )
            , text <|
                if network.location /= "" then
                    " (" ++ String.toUpper network.location ++ ")"

                else
                    ""
            , text <|
                if network.comment /= "" then
                    " (коментар: " ++ network.comment ++ ")"

                else
                    ""
            ]
        ]


networkKinds : List NetworkKind
networkKinds =
    [ VHF, DMR, DMRe ]


type NetworkKind
    = VHF
    | DMR
    | DMRe


networkKindFromString str =
    case str of
        "DMR" ->
            DMR

        "DMRe" ->
            DMRe

        "VHF" ->
            VHF

        _ ->
            VHF


networkKindToString networkKind =
    case networkKind of
        DMR ->
            "DMR"

        DMRe ->
            "DMRe"

        VHF ->
            "VHF"


networkKindToLabel networkKind =
    case networkKind of
        DMR ->
            "DMR"

        DMRe ->
            "DMRe"

        VHF ->
            "УКХ"


networkStringToLabel networkString =
    case networkString of
        "VHF" ->
            "УКХ"

        a ->
            a
