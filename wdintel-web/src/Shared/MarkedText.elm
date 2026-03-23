module Shared.MarkedText exposing (MetadataLink, Model, fromPlainText, new, view, viewWithHintResults)

import Bindings as B
import Core.Callsigns.HintStrategy as HintStrategy
import Dict exposing (Dict)
import Html exposing (..)
import Html.Attributes exposing (..)
import Route
import Route.Path
import Shared.Callsign
import Shared.Components.Tooltip as Tooltip


type alias MetadataLink =
    { startIndex : Int
    , endIndex : Int
    , href : String
    }


type Model msg
    = Model
        { contentNodes : List B.ContentNode
        }


new : List B.ContentNode -> Model msg
new contentNodes =
    Model
        { contentNodes = contentNodes
        }


fromPlainText : String -> Model msg
fromPlainText bodyText =
    plainTextToContentNodes bodyText
        |> new


{-| DEPRECATED:Використовуйте viewWithHintResults з повним HintResult замість цієї функції
-}
view : Dict String ( List B.CallsignInfo, List B.CallsignInfo ) -> Maybe (List B.Signal) -> List B.Network -> Maybe String -> Model msg -> List (Html msg)
view prioritizedCallsignsDict signals networks mFreq (Model config) =
    viewWithHintResults
        (Dict.map (\_ -> createHintResultFromTuple) prioritizedCallsignsDict)
        signals
        networks
        mFreq
        ""
        Nothing
        []
        (Model config)


{-| Конвертує tuple (prioritized, nonPrioritized) в HintResult
DEPRECATED: Використовуйте viewWithHintResults з повним HintResult замість цієї функції
-}
createHintResultFromTuple : ( List B.CallsignInfo, List B.CallsignInfo ) -> HintStrategy.HintResult
createHintResultFromTuple ( prioritized, nonPrioritized ) =
    let
        strategy =
            HintStrategy.NoHints
    in
    { strategy = strategy
    , prioritizedCallsigns = prioritized
    , iconClass = HintStrategy.getIconClass strategy
    }


{-| Нова функція для роботи з HintResult.
  bodyText: original message text; point tokens are rendered as the slice bodyText[begin..end].
  pointTokenClickUrl: when Just, point tokens are links to the analysis map; when Nothing, plain text (no highlight).
-}
viewWithHintResults : Dict String HintStrategy.HintResult -> Maybe (List B.Signal) -> List B.Network -> Maybe String -> String -> Maybe (String -> String) -> List MetadataLink -> Model msg -> List (Html msg)
viewWithHintResults hintResultsDict signals networks mFreq bodyText pointTokenClickUrl metadataLinks (Model config) =
    let
        sortedMetadataLinks =
            List.sortBy .startIndex metadataLinks

        renderContentNodes currentIndex remainingMetadataLinks contentNodes =
            case contentNodes of
                [] ->
                    []

                cn :: rest ->
                    let
                        currentMetadataLinks =
                            skipPastMetadataLinks currentIndex remainingMetadataLinks
                    in
                    case cn of
                        B.CnTextC obj ->
                            let
                                textLength =
                                    String.length obj.text

                                nextIndex =
                                    currentIndex + textLength

                                ( textNodes, nextMetadataLinks ) =
                                    renderTextSegment currentIndex obj.text currentMetadataLinks
                            in
                            textNodes
                                ++ renderContentNodes nextIndex nextMetadataLinks rest

                        B.CnNewlineC ->
                            br [] []
                                :: renderContentNodes
                                    (currentIndex + 1)
                                    currentMetadataLinks
                                    rest

                        B.CnCallsignC obj ->
                            renderContentNode cn
                                :: renderContentNodes
                                    obj.end
                                    currentMetadataLinks
                                    rest

                        B.CnSignalC obj ->
                            renderContentNode cn
                                :: renderContentNodes
                                    obj.end
                                    currentMetadataLinks
                                    rest

                        B.CnHighlightC obj ->
                            renderContentNode cn
                                :: renderContentNodes
                                    obj.end
                                    currentMetadataLinks
                                    rest

                        B.CnPointC obj ->
                            renderContentNode cn
                                :: renderContentNodes
                                    obj.end
                                    currentMetadataLinks
                                    rest

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
                                Shared.Callsign.viewWithHintResult obj.text hintResult

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

                B.CnPointC obj ->
                    let
                        sliceText =
                            String.slice obj.begin obj.end bodyText
                    in
                    case pointTokenClickUrl of
                        Just toUrl ->
                            a [ class "content-token--point hover:cursor-pointer", href (toUrl obj.etalon), target "_blank", rel "noopener noreferrer" ]
                                [ text sliceText ]

                        Nothing ->
                            text sliceText
    in
    [ div [ class "text-marked" ] <|
        renderContentNodes 0 sortedMetadataLinks config.contentNodes
    ]


plainTextToContentNodes : String -> List B.ContentNode
plainTextToContentNodes bodyText =
    let
        flushText currentText nodes =
            if currentText == "" then
                nodes

            else
                B.CnTextC { text = currentText } :: nodes

        step char ( currentText, nodes ) =
            if char == '\n' then
                ( "", B.CnNewlineC :: flushText currentText nodes )

            else
                ( String.fromChar char ++ currentText, nodes )

        ( trailingText, contentNodes ) =
            String.foldr step ( "", [] ) bodyText
    in
    flushText trailingText contentNodes


skipPastMetadataLinks : Int -> List MetadataLink -> List MetadataLink
skipPastMetadataLinks currentIndex metadataLinks =
    case metadataLinks of
        [] ->
            []

        metadataLink :: rest ->
            if metadataLink.endIndex < currentIndex then
                skipPastMetadataLinks currentIndex rest

            else
                metadataLinks


renderTextSegment :
    Int
    -> String
    -> List MetadataLink
    -> ( List (Html msg), List MetadataLink )
renderTextSegment segmentStart segmentText metadataLinks =
    case metadataLinks of
        [] ->
            ( textNode segmentText, [] )

        metadataLink :: rest ->
            let
                segmentLength =
                    String.length segmentText

                segmentEndExclusive =
                    segmentStart + segmentLength
            in
            if metadataLink.startIndex >= segmentEndExclusive then
                ( textNode segmentText, metadataLinks )

            else
                let
                    linkStartInSegment =
                        Basics.max 0 (metadataLink.startIndex - segmentStart)

                    linkEndExclusiveInSegment =
                        Basics.min
                            segmentLength
                            (metadataLink.endIndex - segmentStart + 1)

                    prefixText =
                        String.slice 0 linkStartInSegment segmentText

                    highlightedText =
                        String.slice
                            linkStartInSegment
                            linkEndExclusiveInSegment
                            segmentText

                    suffixText =
                        String.slice
                            linkEndExclusiveInSegment
                            segmentLength
                            segmentText

                    ( suffixNodes, remainingLinks ) =
                        renderTextSegment
                            (segmentStart + linkEndExclusiveInSegment)
                            suffixText
                            rest
                in
                ( textNode prefixText
                    ++ metadataLinkNode metadataLink.href highlightedText
                    ++ suffixNodes
                , remainingLinks
                )


textNode : String -> List (Html msg)
textNode segmentText =
    if segmentText == "" then
        []

    else
        [ span [] [ text segmentText ] ]


metadataLinkNode : String -> String -> List (Html msg)
metadataLinkNode href_ linkText =
    if linkText == "" then
        []

    else
        [ a
            [ class "content-token--metadata hover:cursor-pointer"
            , href href_
            ]
            [ text linkText ]
        ]
