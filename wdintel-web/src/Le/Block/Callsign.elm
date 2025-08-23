module Le.Block.Callsign exposing (view, viewDefault, viewWithNetworkInfo, viewWithHintResult)

import Bindings as B
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Extra as HtmlX
import Le.Block.Tooltip as Tooltip
import Le.Callsign.HintStrategy as HintStrategy


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
    viewWithNetworkInfo callsign ( prioritizedCallsigns, nonPrioritizedCallsigns ) True


{-| Нова функція для роботи з HintResult
-}
viewWithHintResult : String -> HintStrategy.HintResult -> Html msg
viewWithHintResult callsign hintResult =
    if List.length hintResult.prioritizedCallsigns == 0 then
        viewDefault callsign False
    else
        let
            prioritizedBlock =
                hintResult.prioritizedCallsigns
                    |> List.map viewCallsign
                    |> String.join " "

            tooltip =
                div [ id "tooltip-content" ]
                    [ div []
                        [ div [ class "text-xs text-muted mb-1" ]
                            [ text hintResult.tooltipText ]
                        , span []
                            [ text prioritizedBlock
                            ]
                        ]
                    ]
        in
        Tooltip.new (String.toUpper callsign) 
            |> Tooltip.withIconName hintResult.iconClass 
            |> Tooltip.withTextNoWrap 
            |> Tooltip.view tooltip


viewWithNetworkInfo : String -> ( List B.CallsignInfo, List B.CallsignInfo ) -> Bool -> Html msg
viewWithNetworkInfo callsign ( prioritizedCallsigns, nonPrioritizedCallsigns ) hasNetwork =
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
                            [ div [ class "text-xs text-muted mb-1" ]
                                [ text (if hasNetwork then "📍 Підказки по мережі" else "🌐 Підказки по всій системі") ]
                            , span []
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
                if hasNetwork then
                    "bi-info-circle-fill"

                else
                    "bi-info-circle"
        in
        Tooltip.new (String.toUpper callsign) |> Tooltip.withIconName infoCircleClass |> Tooltip.withTextNoWrap |> Tooltip.view tooltip
