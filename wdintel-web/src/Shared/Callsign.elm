module Shared.Callsign exposing (viewDefault, viewWithHintResult, viewWithMessageHintResult)

import Core.Callsigns.HintStrategy as HintStrategy
import Core.Callsigns.MessageHint as MessageHint
import Html exposing (..)
import Html.Attributes exposing (..)
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


viewWithMessageHintResult : String -> MessageHint.MessageHintResult -> Html msg
viewWithMessageHintResult callsign result =
    case MessageHint.tooltipSections result of
        [] ->
            viewDefault callsign False

        sections ->
            let
                tooltip =
                    div [ id "tooltip-content" ]
                        (List.concatMap
                            (\section ->
                                [ div [ class "text-sm mb-1" ] [ text section.header ]
                                , div [] (List.map (\item -> div [ class "text-sm py-1" ] [ text item ]) section.items)
                                ]
                            )
                            sections
                        )
            in
            Tooltip.new (String.toUpper callsign)
                |> Tooltip.withIconName (MessageHint.iconClass result)
                |> Tooltip.withTextNoWrap
                |> Tooltip.view tooltip
