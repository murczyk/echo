module Le.NetworksUtils exposing (..)

import Bindings as B
import Char
import Dict exposing (Dict)
import Html exposing (..)
import Html.Attributes exposing (class)
import Le.Block.Unit as Unit
import Le.Utils exposing (networkKindVHFMapping)


renderNetworkNameWithoutType network masterUnits =
    let
        hasNoUnits =
            case network.unitIds of
                Nothing ->
                    True

                Just ids ->
                    List.isEmpty ids
    in
    div []
        [ div []
            ([ text " р/м "
             , text network.name
             , text " "
             , text <|
                String.join ", "
                    (List.map (Unit.unitName masterUnits)
                        (Maybe.withDefault [] network.unitIds)
                    )
             ]
                ++ (if hasNoUnits then
                        [ span [ class "badge badge-no-unit" ] [ text "в дорозвідці" ] ]

                    else
                        []
                   )
            )
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
                    " (" ++ network.location ++ ")"

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



-- Frequency format validation
-- Перевіряє формат ЦЦЦ.ЦЦЦЦ (3 цифри до крапки, рівно 4 цифри після крапки)
-- Приклади: 130.1000 ✅, 130.100 ❌, 13.1000 ❌, 1300.1000 ❌


validateFrequencyFormat : String -> Bool
validateFrequencyFormat freq =
    let
        trimmed =
            String.trim freq
    in
    if String.isEmpty trimmed then
        True
        -- Empty is handled by required validation

    else
        case String.split "." trimmed of
            [ wholePart, decimalPart ] ->
                -- Перевіряємо що до крапки рівно 3 цифри
                String.length wholePart
                    == 3
                    && String.all Char.isDigit wholePart
                    -- Перевіряємо що після крапки рівно 4 цифри
                    && String.length decimalPart
                    == 4
                    && String.all Char.isDigit decimalPart

            _ ->
                False
