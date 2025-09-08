module Shared.Callsign exposing (view, viewDefault, viewWithHintResult, viewWithNetworkInfo)

import Bindings as B
import Core.Callsigns.HintStrategy as HintStrategy
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Extra as HtmlX
import Shared.Components.Tooltip as Tooltip


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
            tooltip =
                div [ id "tooltip-content" ]
                    [ div []
                        [ div [ class "text-sm mb-1" ]
                            [ case hintResult.strategy of
                                HintStrategy.NetworkBased _ ->
                                    text "Позивні підрозділів мережі:"

                                HintStrategy.SystemWide ->
                                    text "Позивні з каталогу:"

                                HintStrategy.NoHints ->
                                    text "Немає підказок"
                            ]
                        , div []
                            (hintResult.prioritizedCallsigns
                                |> List.map
                                    (\callsignInfo ->
                                        div [ class "text-sm py-1" ] [ text (viewCallsign callsignInfo) ]
                                    )
                            )
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
                            [ div [ class "text-xs mb-1" ]
                                [ text
                                    (if hasNetwork then
                                        "📍 Підказки по мережі"

                                     else
                                        "🌐 Підказки по всій системі"
                                    )
                                ]
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
