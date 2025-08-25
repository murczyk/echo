module Le.Block.MarkedText exposing (Model, new, view, viewWithHintResults)

import Bindings as B
import Dict exposing (Dict)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (onClick)
import Le.Block.Callsign
import Le.Block.Tooltip as Tooltip
import Le.Callsign.HintStrategy as HintStrategy
import Route
import Route.Path


type Model msg
    = Model
        { contentNodes : List B.ContentNode
        }


new : List B.ContentNode -> Model msg
new contentNodes =
    Model
        { contentNodes = contentNodes
        }


view : Dict String ( List B.CallsignInfo, List B.CallsignInfo ) -> Maybe (List B.Signal) -> List B.Network -> Maybe String -> Model msg -> List (Html msg)
view prioritizedCallsignsDict signals networks mFreq (Model config) =
    viewWithHintResults (Dict.map (\_ -> createHintResultFromTuple) prioritizedCallsignsDict) signals networks mFreq (Model config)


{-| Конвертує tuple (prioritized, nonPrioritized) в HintResult
-}
createHintResultFromTuple : ( List B.CallsignInfo, List B.CallsignInfo ) -> HintStrategy.HintResult
createHintResultFromTuple ( prioritized, nonPrioritized ) =
    let
        hasNetwork =
            List.length prioritized > 0

        strategy =
            if hasNetwork then
                HintStrategy.NetworkBased { networks = [], units = [] }

            else
                HintStrategy.SystemWide
    in
    { strategy = strategy
    , prioritizedCallsigns = prioritized
    , iconClass = HintStrategy.getIconClass strategy
    }


{-| Нова функція для роботи з HintResult
-}
viewWithHintResults : Dict String HintStrategy.HintResult -> Maybe (List B.Signal) -> List B.Network -> Maybe String -> Model msg -> List (Html msg)
viewWithHintResults hintResultsDict signals networks mFreq (Model config) =
    let
        renderContentNode cn =
            case cn of
                B.CnTextC obj ->
                    span [] [ text obj.text ]

                B.CnNewlineC ->
                    br [] []

                B.CnCallsignC obj ->
                    let
                        a2 =
                            Dict.insert "callsign" obj.text Dict.empty

                        a3 =
                            case mFreq of
                                Just freq ->
                                    case networks |> List.filter (\x -> List.map .freq x.freqs |> List.member freq) |> List.head |> Maybe.andThen .unitIds |> Maybe.andThen List.head of
                                        Just unitId ->
                                            Dict.insert "unitId" (String.fromInt unitId) a2

                                        Nothing ->
                                            a2

                                Nothing ->
                                    a2
                    in
                    a [ class "content-token--ADP hover:cursor-pointer", Route.href { path = Route.Path.RerCallsigns, query = a3, hash = Nothing }, target "_blank" ]
                        [ case Dict.get (String.toLower obj.text) hintResultsDict of
                            Just hintResult ->
                                Le.Block.Callsign.viewWithHintResult obj.text hintResult

                            Nothing ->
                                text obj.text
                        ]

                B.CnSignalC obj ->
                    let
                        signal =
                            signals
                                |> Maybe.withDefault []
                                |> List.filter (\s -> s.text == obj.etalon)
                                |> List.head

                        signalTooltip : B.Signal -> Html msg
                        signalTooltip s =
                            div []
                                [ span [] [ text (Maybe.withDefault "" s.meaning) ]
                                ]
                    in
                    span [ class "content-token--ADV" ]
                        [ case signal of
                            Nothing ->
                                text obj.text

                            Just s ->
                                Tooltip.new obj.text
                                    |> Tooltip.withTextNoWrap
                                    |> Tooltip.view (signalTooltip s)
                        ]

                B.CnHighlightC obj ->
                    span [ class "badge-highlighed-token badge-highlighed-token--callsign" ]
                        [ text obj.text ]
    in
    [ div [ class "text-marked" ] <|
        List.map renderContentNode config.contentNodes
    ]
