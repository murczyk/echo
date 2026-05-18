module Utils.NetworksUtils exposing (..)

import Bindings as B
import Char
import Core.Unit as Unit
import Dict exposing (Dict)
import Html exposing (..)
import Html.Attributes exposing (class)
import String


renderNetworkNameWithoutType : B.Network -> Dict Int B.Unit -> Html msg
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


networkKindFromString : String -> NetworkKind
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


networkKindToString : NetworkKind -> String
networkKindToString networkKind =
    case networkKind of
        DMR ->
            "DMR"

        DMRe ->
            "DMRe"

        VHF ->
            "VHF"


networkKindToLabel : NetworkKind -> String
networkKindToLabel networkKind =
    case networkKind of
        DMR ->
            "DMR"

        DMRe ->
            "DMRe"

        VHF ->
            "УКХ"


signalTypeFromNetworkKind : NetworkKind -> String
signalTypeFromNetworkKind networkKind =
    case networkKind of
        VHF ->
            "analog"

        DMR ->
            "digital"

        DMRe ->
            "digital"


signalTypeFromModulationName : String -> Maybe String
signalTypeFromModulationName modulationName =
    case String.toUpper (String.trim modulationName) of
        "DMR" ->
            Just "digital"

        "NFM" ->
            Just "analog"

        "AM" ->
            Just "analog"

        _ ->
            Nothing


modulationMatchesSignalType : String -> String -> Bool
modulationMatchesSignalType modulationName signalType =
    case signalTypeFromModulationName modulationName of
        Nothing ->
            True

        Just modulationSignalType ->
            modulationSignalType == String.toLower (String.trim signalType)


clearIncompatibleModulationId : List B.ModulationRec -> Maybe Int -> String -> Maybe Int
clearIncompatibleModulationId modulations modulationId signalType =
    case modulationId of
        Nothing ->
            Nothing

        Just id ->
            case List.filter (\mod -> mod.id == id) modulations |> List.head of
                Just modulation ->
                    if modulationMatchesSignalType modulation.name signalType then
                        Just id

                    else
                        Nothing

                Nothing ->
                    Nothing


signalTypeToLabel : String -> String
signalTypeToLabel signalType =
    case String.toLower (String.trim signalType) of
        "analog" ->
            "аналоговий"

        "digital" ->
            "цифровий"

        _ ->
            "—"


networkStringToLabel : String -> String
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
