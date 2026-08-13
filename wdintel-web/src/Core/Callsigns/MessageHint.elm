module Core.Callsigns.MessageHint exposing (MessageHintResult, MessageHintState(..), TooltipSection, callsignsFromMessage, iconClass, mergeResponses, resolve, tooltipSections)

import Bindings as B
import Dict exposing (Dict)
import List.Extra as ListX
import String


type MessageHintState
    = MessageNetwork
    | KnownElsewhere
    | Unresolved


type alias MessageHintResult =
    { state : MessageHintState
    , catalogRows : List B.CallsignInfo
    , exactNetworkHints : List B.CallsignNetworkHint
    , otherNetworkHints : List B.CallsignNetworkHint
    , networkNames : Dict Int String
    }


type alias TooltipSection =
    { header : String
    , items : List String
    }


normalize : String -> String
normalize value =
    value |> String.trim |> String.toLower


callsignsFromMessage : B.InboxMessage -> List String
callsignsFromMessage message =
    let
        marked =
            message.textMarked
                |> Maybe.withDefault []
                |> List.filterMap
                    (\node ->
                        case node of
                            B.CnCallsignC callsign ->
                                Just callsign.text

                            _ ->
                                Nothing
                    )

        values =
            if List.isEmpty marked then
                message.callsigns

            else
                marked
    in
    values
        |> List.map normalize
        |> List.filter ((/=) "")
        |> ListX.unique


resolve : Maybe (List Int) -> Dict Int B.Network -> Dict String B.CallsignInfoRes -> String -> MessageHintResult
resolve maybeNetworkIds networks responses callsign =
    let
        networkIds =
            Maybe.withDefault [] maybeNetworkIds

        response =
            Dict.get (normalize callsign) responses

        catalogRows =
            response |> Maybe.map .res |> Maybe.withDefault []

        allHints =
            response |> Maybe.map .networkHints |> Maybe.withDefault []

        exactHints =
            allHints |> List.filter (\hint -> List.member hint.networkId networkIds)

        otherHints =
            allHints |> List.filter (\hint -> not (List.member hint.networkId networkIds))

        state =
            if not (List.isEmpty exactHints) then
                MessageNetwork

            else if not (List.isEmpty catalogRows) || not (List.isEmpty otherHints) then
                KnownElsewhere

            else
                Unresolved
    in
    { state = state
    , catalogRows = catalogRows
    , exactNetworkHints = exactHints
    , otherNetworkHints = otherHints
    , networkNames = networks |> Dict.map (\_ network -> network.name)
    }


iconClass : MessageHintResult -> String
iconClass result =
    case result.state of
        MessageNetwork ->
            "bi-info-circle-fill"

        KnownElsewhere ->
            "bi-info-circle"

        Unresolved ->
            ""


networkLine : Dict Int String -> B.CallsignNetworkHint -> String
networkLine names hint =
    let
        details =
            [ String.trim hint.position, String.trim hint.formation ]
                |> List.filter ((/=) "")
    in
    if List.isEmpty details then
        "Позивний присутній у мережі «" ++ (Dict.get hint.networkId names |> Maybe.withDefault ("#" ++ String.fromInt hint.networkId)) ++ "». Додатковий опис відсутній."

    else
        "🐷 " ++ String.join " " details


catalogLine : B.CallsignInfo -> String
catalogLine row =
    let
        details =
            [ String.trim row.position, String.trim row.unit1, String.trim row.unit2 ] |> List.filter ((/=) "")
    in
    if List.isEmpty details then
        "Позивний присутній у каталозі. Додатковий опис відсутній."

    else
        "🐷 " ++ String.join " " details


tooltipSections : MessageHintResult -> List TooltipSection
tooltipSections result =
    case result.state of
        Unresolved ->
            []

        MessageNetwork ->
            [ { header = "Позивні підрозділів мережі:"
              , items = List.map (networkLine result.networkNames) result.exactNetworkHints
              }
            ]

        KnownElsewhere ->
            (if List.isEmpty result.catalogRows then
                []

             else
                [ { header = "Позивні з каталогу:", items = List.map catalogLine result.catalogRows } ]
            )
                ++ (if List.isEmpty result.otherNetworkHints then
                        []

                    else
                        [ { header = "Позивний присутній в інших мережах:", items = List.map (networkLine result.networkNames) result.otherNetworkHints } ]
                   )


mergeResponses : List B.CallsignInfoRes -> Dict String B.CallsignInfoRes -> Dict String B.CallsignInfoRes
mergeResponses incoming existing =
    List.foldl mergeOne existing incoming


mergeOne : B.CallsignInfoRes -> Dict String B.CallsignInfoRes -> Dict String B.CallsignInfoRes
mergeOne incoming dict =
    let
        key =
            normalize incoming.callsign

        mergeRows old new =
            new
                |> List.foldl (\row rows -> Dict.insert row.id row rows) (old |> List.map (\row -> ( row.id, row )) |> Dict.fromList)
                |> Dict.values

        merged =
            case Dict.get key dict of
                Nothing ->
                    incoming

                Just old ->
                    { incoming
                        | callsign =
                            if String.trim incoming.callsign == "" then
                                old.callsign

                            else
                                incoming.callsign
                        , res = mergeRows old.res incoming.res
                        , networkHints = mergeRows old.networkHints incoming.networkHints
                    }
    in
    Dict.insert key merged dict
