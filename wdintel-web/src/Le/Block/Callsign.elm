module Le.Block.Callsign exposing (view, viewDefault)

import Bindings as B
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Extra as HtmlX
import Le.Block.Tooltip as Tooltip


viewCallsign : { a | position : String, unit1 : String, unit2 : String } -> String
viewCallsign callsignInfo =
    "🐷 "
        ++ String.trim callsignInfo.position
        ++ " "
        ++ String.trim callsignInfo.unit1
        ++ " "
        ++ String.trim callsignInfo.unit2


viewDefault : String -> Bool -> Html msg
viewDefault callsign isBlock =
    let
        styles =
            if isBlock then
                [ style "display" "block" ]

            else
                []
    in
    span styles [ text <| String.toUpper callsign ]


view : String -> ( List B.CallsignInfo, List B.CallsignInfo ) -> Html msg
view callsign ( prioritizedCallsigns, nonPrioritizedCallsigns ) =
    if (List.length prioritizedCallsigns == 0) && (List.length nonPrioritizedCallsigns == 0) then
        viewDefault callsign False

    else
        let
            prioritizedBlock =
                prioritizedCallsigns
                    |> List.map viewCallsign
                    |> String.join " "

            noPrioritizedCallsigns =
                List.length prioritizedCallsigns == 0

            tooltip =
                div [ id "tooltip-content" ]
                    [ HtmlX.viewIf (not noPrioritizedCallsigns) <|
                        div []
                            [ span []
                                [ text prioritizedBlock
                                ]
                            ]
                    , HtmlX.viewIf noPrioritizedCallsigns <|
                        div []
                            [ p []
                                [ span [] [ text "В прив'язках частоти позивний відсутній." ]
                                , span [ class "inline-block" ] [ text "В інших підрозділах: " ]
                                ]
                            , span []
                                [ text
                                    (nonPrioritizedCallsigns
                                        |> List.map viewCallsign
                                        |> String.join " "
                                    )
                                ]
                            ]
                    ]

            infoCircleClass =
                if noPrioritizedCallsigns then
                    "bi-info-circle"

                else
                    "bi-info-circle-fill"
        in
        Tooltip.new (String.toUpper callsign) |> Tooltip.withIconName infoCircleClass |> Tooltip.withTextNoWrap |> Tooltip.view tooltip
