module RerAnalysis.Graphs exposing (graphsBlock)

import Bindings as B
import Dict
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events as Events exposing (..)
import Json.Decode as Decode
import Json.Encode as Encode
import Le.Block.Spinner
import Le.RemoteData as RD exposing (RemoteData(..))
import RerAnalysis.Constants exposing (..)
import RerAnalysis.FreqBadge
import RerAnalysis.Model exposing (..)
import RerAnalysis.Msg exposing (..)
import RerAnalysis.Utils exposing (..)
import Shared
import String exposing (fromInt)


graphsBlock : Model -> Shared.Model -> List (Html Msg)
graphsBlock model shared =
    let
        correlationBlock =
            let
                renderCorrelatedFreq cf =
                    div [ class "d-flex justify-content-start align-items-center" ] <|
                        [ RerAnalysis.FreqBadge.freqBadge model cf.freq
                        , div [ class "mb-2 d-flex justify-content-start align-items-center" ] <|
                            List.map
                                (\x ->
                                    span [ class "me-1", style "font-size" ".9rem" ]
                                        [ text x ]
                                )
                                cf.commonCallsigns
                        ]
            in
            [ div [ class "fade-in border border-light shadow-sm p-2 mb-2 py-2", style "height" "100%" ] <|
                [ case model.correlatedFreqs of
                    Success cfs ->
                        if List.length cfs > 0 then
                            div [ style "overflow-y" "auto", style "height" "100%" ] <|
                                List.map renderCorrelatedFreq
                                    (List.take correlatedFreqsLimit cfs)

                        else
                            div [ class "text-center" ] [ text "Список суміжних частот пустий" ]

                    NotAsked ->
                        div [ class "text-center d-flex justify-content-center align-items-center", style "height" "100%" ]
                            [ if List.length model.freqsSelected > 0 then
                                button [ class "btn btn-outline-secondary btn-sm", onClick GetCorrelatedFreqs ] [ text "завантажити частоти" ]

                              else
                                span [ style "font-size" "14px" ] [ text "Виберіть хоча б 1 частоту щоб завантажити дані" ]
                            ]

                    Loading ->
                        div [ class "text-center d-flex justify-content-center align-items-center", style "height" "100%" ] [ Le.Block.Spinner.loadingSpinner2Sm ]

                    _ ->
                        text ""
                ]
            ]

        frameWidth =
            500

        frameHeight =
            250
    in
    [ div [ class "d-flex justify-content-center align-items-center" ]
        [ 

                let
                    data = RD.withDefault2 {dataPerDate = Dict.empty}  model.groupsMessageCountByDay
                    groupsMessageCountByDayJson =
                        B.freqDailyActivityCountEncoder data
                    groupsActivityPeriodEncoded = case model.groupsActivityPeriod of 
                                                    FilterSelectedRange ->
                                                        "selected" 
                                                    Month -> 
                                                        "month" 
                                                    Quarter ->
                                                        "quarter" 
                                                    Year ->
                                                        "year"

                    groupsActivityPeriodDecoder =
                        Decode.at [ "target" ]
                            (Decode.field "value" Decode.string
                                |> Decode.andThen
                                    (\period ->
                                        case period of
                                            "month" ->
                                                Decode.succeed Month

                                            "year" ->
                                                Decode.succeed Year

                                            "quarter" ->
                                                Decode.succeed Quarter

                                            "selected" ->
                                                Decode.succeed FilterSelectedRange

                                            _ ->
                                                Decode.fail ("Invalid period: " ++ period)
                                    )
                            )
                    periodRadioBlock = div [Attr.attribute "slot" "period"] [
                        Html.node "sl-radio-group" [ value groupsActivityPeriodEncoded, Attr.attribute "size" "small", onChange ]
                        [ Html.node "sl-radio-button" [ value "selected"  ] [ text "Вибраний період" ]
                        , Html.node "sl-radio-button" [ value "month" ] [ text "Місяць" ]
                        , Html.node "sl-radio-button" [ value "quarter" ] [ text "3 місяці" ]
                        , Html.node "sl-radio-button" [ value "year" ] [ text "Рік" ]
                        ]

                        ]                 
                    onChange =
                        Events.on "sl-change" (Decode.map GroupsActivityPeriodChanged groupsActivityPeriodDecoder)
                in
                div [ class "me-2", style "height" "250px", style "width" "500px" ]
                    [ Html.node "bar-chart-2"
                        [ Attr.property "data" <| groupsMessageCountByDayJson
                        , Attr.property "period" <|Encode.string  groupsActivityPeriodEncoded
                        , Attr.property "isAnalysis" <|Encode.bool True
                        , style "display" "block"
                        , Events.on "period-changed" (Decode.map GroupsActivityPeriodChanged groupsActivityPeriodDecoder)
                        ]
                        [
                            periodRadioBlock
                            ]
                    ]

           -- _ ->
           --     div
           --         [ class "d-flex justify-content-center align-items-center border shadow-sm"
           --         , style "width" (fromInt frameWidth ++ "px")
           --         , style "min-height" (fromInt frameHeight ++ "px")
           --         ]
           --         [ text "Виберіть рівно одну частоту для відображення графіку"
           --         ]
        , div [ style "height" "250px", style "width" "500px" ] correlationBlock
        ]
    ]
