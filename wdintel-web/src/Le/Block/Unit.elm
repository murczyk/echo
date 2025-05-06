module Le.Block.Unit exposing (boldMasterUnit, sameRegiment, unitName)

import Bindings as B
import Dict exposing (Dict)
import Html exposing (..)
import Html.Attributes exposing (class)
import Le.Utils as Utils


unitName : Dict Int B.Unit -> Int -> String
unitName masterUnits unitId =
    case Dict.get unitId masterUnits of
        Just unit ->
            unit.name

        Nothing ->
            "Невідомий підрозділ (id=" ++ String.fromInt unitId ++ ")"


sameRegiment : B.Unit -> B.Unit -> Bool
sameRegiment unit1 unit2 =
    if not (String.isEmpty unit1.regiment) && not (String.isEmpty unit2.regiment) then
        unit1.regiment == unit2.regiment && unit1.army == unit2.army && unit1.division == unit2.division

    else
        unit1.id == unit2.id


boldMasterUnit : Dict Int B.Unit -> B.Network -> Html msg
boldMasterUnit masterUnits network =
    div [ class "fw-semibold" ]
        [ div []
            [ text <| Utils.networkKindVHFMapping network.kind
            , text " р/м "
            , text network.name
            , text " "
            , text <|
                String.join ", "
                    (List.map (unitName masterUnits)
                        network.unitIds
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
