module Pages_.RerAnalysis.Utils exposing (buildMetadataLinks, updateQueryWithSelectedFreq, updateQueryWithSearch)

import Bindings as B
import Dict exposing (Dict)
import Json.Decode as Decode
import Json.Encode as Encode
import Maybe
import Route exposing (Route)
import Time
import Time.Extra
import Url.Builder
import Utils.Time


type MetadataFilter
    = MetadataCc String
    | MetadataSender String
    | MetadataReceiver String
    | MetadataHash String


type alias MetadataSpan =
    { startIndex : Int
    , endIndex : Int
    , filter : MetadataFilter
    }


buildMetadataLinks :
    Time.Zone
    -> B.InboxMessage
    -> List { startIndex : Int, endIndex : Int, href : String }
buildMetadataLinks zone message =
    case messageDayRange zone message of
        Nothing ->
            []

        Just ( dateFromStr, dateToStr ) ->
            message.metadata
                |> List.concatMap metadataSpans
                |> dedupeMetadataSpans
                |> List.sortBy .startIndex
                |> List.map
                    (\metadataSpan_ ->
                        { startIndex = metadataSpan_.startIndex
                        , endIndex = metadataSpan_.endIndex
                        , href =
                            metadataHref
                                dateFromStr
                                dateToStr
                                metadataSpan_.filter
                        }
                    )


messageDayRange : Time.Zone -> B.InboxMessage -> Maybe ( String, String )
messageDayRange zone message =
    case message.timestamp of
        Just timestamp ->
            Just
                ( Utils.Time.renderDateF4 zone (Time.millisToPosix timestamp)
                , Utils.Time.renderDateF4
                    zone
                    (Time.millisToPosix
                        (timestamp + Utils.Time.xDaysInMillis 1)
                    )
                )

        Nothing ->
            message.date
                |> Maybe.andThen
                    (\dateStr ->
                        Utils.Time.parseDateParts dateStr
                            |> Result.toMaybe
                    )
                |> Maybe.map
                    (\parts ->
                        let
                            dayStart =
                                Time.Extra.partsToPosix zone parts

                            dayStartMillis =
                                Time.posixToMillis dayStart
                        in
                        ( Utils.Time.renderDateF4 zone dayStart
                        , Utils.Time.renderDateF4
                            zone
                            (Time.millisToPosix
                                (dayStartMillis + Utils.Time.xDaysInMillis 1)
                            )
                        )
                    )


metadataSpans : B.InboxMessageMetadata -> List MetadataSpan
metadataSpans metadata =
    [ metadataSpan
        metadata.colorCode
        metadata.colorCodeStartIndex
        metadata.colorCodeEndIndex
        MetadataCc
    , metadataSpan
        metadata.senderId
        metadata.senderIdStartIndex
        metadata.senderIdEndIndex
        MetadataSender
    , metadataSpan
        metadata.senderName
        metadata.senderNameStartIndex
        metadata.senderNameEndIndex
        MetadataSender
    , metadataSpan
        metadata.callGroupId
        metadata.callGroupIdStartIndex
        metadata.callGroupIdEndIndex
        MetadataReceiver
    , metadataSpan
        metadata.callGroupName
        metadata.callGroupNameStartIndex
        metadata.callGroupNameEndIndex
        MetadataReceiver
    , metadataSpan
        metadata.hashId
        metadata.hashIdStartIndex
        metadata.hashIdEndIndex
        MetadataHash
    ]
        |> List.filterMap identity


metadataSpan :
    Maybe String
    -> Maybe Int
    -> Maybe Int
    -> (String -> MetadataFilter)
    -> Maybe MetadataSpan
metadataSpan mValue mStartIndex mEndIndex toFilter =
    case ( mValue, mStartIndex, mEndIndex ) of
        ( Just value, Just startIndex, Just endIndex ) ->
            if value /= "" && startIndex >= 0 && endIndex >= startIndex then
                Just
                    { startIndex = startIndex
                    , endIndex = endIndex
                    , filter = toFilter value
                    }

            else
                Nothing

        _ ->
            Nothing


dedupeMetadataSpans : List MetadataSpan -> List MetadataSpan
dedupeMetadataSpans metadataSpans_ =
    List.foldl
        (\metadataSpan_ acc ->
            if List.any (sameMetadataSpan metadataSpan_) acc then
                acc

            else
                metadataSpan_ :: acc
        )
        []
        metadataSpans_
        |> List.reverse


sameMetadataSpan : MetadataSpan -> MetadataSpan -> Bool
sameMetadataSpan left right =
    left.startIndex == right.startIndex
        && left.endIndex == right.endIndex
        && metadataFilterKey left.filter == metadataFilterKey right.filter


metadataFilterKey : MetadataFilter -> ( String, String )
metadataFilterKey metadataFilter =
    case metadataFilter of
        MetadataCc value ->
            ( "cc", value )

        MetadataSender value ->
            ( "sender", value )

        MetadataReceiver value ->
            ( "receiver", value )

        MetadataHash value ->
            ( "hash", value )


metadataHref : String -> String -> MetadataFilter -> String
metadataHref dateFromStr dateToStr metadataFilter =
    let
        emptyQueryState =
            { dateFromStr = ""
            , timeFromStr = ""
            , dateToStr = ""
            , timeToStr = ""
            , aorsSelected = []
            , groupsSelected = []
            , sendersSelected = []
            , freqsSelected = []
            , callsignsSelected = []
            , unitsSelected = []
            , locationsSelected = []
            , postsSelected = []
            , networksSelected = []
            , withoutNetwork = False
            , includePelengLocations = True
            , orWithExtendedForm = False
            , orBookmarked = False
            , orImportant = False
            , orWithCoords = False
            , search = ""
            , metadataCc = []
            , metadataSender = []
            , metadataReceiver = []
            , metadataHash = []
            , onlyWithMetadata = False
            , withoutMetadata = False
            , tags = []
            , unitsExactMatchOnly = True
            , adjacentFreqsRange = 0
            , withoutModelTags = False
            }

        baseState =
            { emptyQueryState
                | dateFromStr = dateFromStr
                , timeFromStr = "00:00"
                , dateToStr = dateToStr
                , timeToStr = "00:00"
            }

        state =
            case metadataFilter of
                MetadataCc value ->
                    { baseState | metadataCc = [ value ] }

                MetadataSender value ->
                    { baseState | metadataSender = [ value ] }

                MetadataReceiver value ->
                    { baseState | metadataReceiver = [ value ] }

                MetadataHash value ->
                    { baseState | metadataHash = [ value ] }
    in
    Url.Builder.absolute
        [ "rer-analysis" ]
        [ Url.Builder.string
            "state"
            (Encode.encode 0 (B.rerAnalysisQueryStateEncoder state))
        ]


updateQueryWithSearch : String -> Route () -> Route ()
updateQueryWithSearch searchQuery route =
    let
        ms : Maybe B.RerAnalysisQueryState
        ms =
            Dict.get "state" route.query
                |> Maybe.andThen
                    (Decode.decodeString B.rerAnalysisQueryStateDecoder
                        >> Result.toMaybe
                    )
    in
    case ms of
        Just v ->
            let
                w =
                    { v | search = searchQuery }

                updatedQuery =
                    Dict.insert "state" (Encode.encode 0 <| B.rerAnalysisQueryStateEncoder w) route.query
            in
            { route | query = updatedQuery }

        Nothing ->
            { route | query = Dict.insert "search" searchQuery route.query }


updateQueryWithSelectedFreq : String -> Route () -> Route ()
updateQueryWithSelectedFreq freq route =
    let
        ms : Maybe B.RerAnalysisQueryState
        ms =
            Dict.get "state" route.query
                |> Maybe.andThen
                    (Decode.decodeString B.rerAnalysisQueryStateDecoder
                        >> Result.toMaybe
                    )
    in
    case ms of
        Just v ->
            let
                w =
                    { v | freqsSelected = [ freq ] }

                updatedQuery =
                    Dict.insert "state" (Encode.encode 0 <| B.rerAnalysisQueryStateEncoder w) route.query
            in
            { route | query = updatedQuery }

        Nothing ->
            route
