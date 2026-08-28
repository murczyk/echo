module Pages_.RerAnalysis.Query exposing (analysisStatsDefaultParams, analysisStatsParams, canonicalUnitIdFromValue, emptyQueryState, isCanonicalUnitIdValue, modelQueryState, normalizeUnitNameFromMap, normalizeUnitSelections, partitionUnitSelections, unitIdFilterValue, updModelFromQueryState, updModelFromSavedFilter)

import Bindings as B
import Pages_.RerAnalysis.Model exposing (..)
import Shared.Components.DateTime
import String
import Time exposing (Posix)
import Utils.Utils exposing (..)


emptyQueryState : B.RerAnalysisQueryState
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
    , orWithoutCoords = False
    , search = ""
    , metadataCc = []
    , metadataSender = []
    , metadataReceiver = []
    , metadataHash = []
    , onlyWithMetadata = False
    , withoutMetadata = False
    , tags = []
    , unitsExactMatchOnly = Nothing
    , adjacentFreqsRange = 0
    , withoutModelTags = False
    , filterTagsOption = Nothing
    , reportTagsOnlyThisUnit = Nothing
    }


normalizeUnitNameFromMap : String -> String
normalizeUnitNameFromMap unitName =
    let
        trimmed =
            String.trim unitName
    in
    if trimmed == "" || trimmed == "Не визначено" || trimmed == "Не вказано" then
        ""

    else
        trimmed


normalizeUnitSelections : List String -> List String
normalizeUnitSelections unitNames =
    List.foldl
        (\unitName acc ->
            let
                normalized =
                    normalizeUnitNameFromMap unitName
            in
            if List.member normalized acc then
                acc

            else
                acc ++ [ normalized ]
        )
        []
        unitNames


partitionUnitSelections : List String -> ( List Int, List String )
partitionUnitSelections values =
    List.foldr
        (\value ( ids, legacy ) ->
            case canonicalUnitIdFromValue value of
                Just unitId ->
                    ( unitId :: ids, legacy )

                Nothing ->
                    ( ids, value :: legacy )
        )
        ( [], [] )
        values


isCanonicalUnitIdValue : String -> Bool
isCanonicalUnitIdValue value =
    canonicalUnitIdFromValue value /= Nothing


unitIdFilterValue : Int -> String
unitIdFilterValue unitId =
    "unit-id:" ++ String.fromInt unitId


canonicalUnitIdFromValue : String -> Maybe Int
canonicalUnitIdFromValue value =
    if String.startsWith "unit-id:" value then
        case String.dropLeft 8 value |> String.toInt of
            Just unitId ->
                if unitId > 0 && unitIdFilterValue unitId == value then
                    Just unitId

                else
                    Nothing

            Nothing ->
                Nothing

    else
        Nothing


normalizeQueryStateMetadata : B.RerAnalysisQueryState -> B.RerAnalysisQueryState
normalizeQueryStateMetadata queryState =
    if queryState.withoutMetadata then
        { queryState
            | metadataCc = []
            , metadataSender = []
            , metadataReceiver = []
            , metadataHash = []
            , onlyWithMetadata = False
        }

    else if queryState.onlyWithMetadata then
        { queryState | withoutMetadata = False }

    else
        queryState


normalizeQueryStateNetworks : B.RerAnalysisQueryState -> B.RerAnalysisQueryState
normalizeQueryStateNetworks queryState =
    if queryState.withoutNetwork then
        { queryState | networksSelected = [] }

    else
        queryState


normalizeAnalysisStatsReqMetadata : B.AnalysisStatsReq -> B.AnalysisStatsReq
normalizeAnalysisStatsReqMetadata req =
    if req.withoutMetadata == Just True then
        { req
            | metadataCc = Nothing
            , metadataSender = Nothing
            , metadataReceiver = Nothing
            , metadataHash = Nothing
            , onlyWithMetadata = Just False
        }

    else if req.onlyWithMetadata == Just True then
        { req | withoutMetadata = Just False }

    else
        req


modelQueryState : Model -> B.RerAnalysisQueryState
modelQueryState model =
    normalizeQueryStateNetworks <|
        normalizeQueryStateMetadata
            { dateFromStr = model.from.dateStr
            , timeFromStr = model.from.timeStr
            , dateToStr = model.to.dateStr
            , timeToStr = model.to.timeStr
            , aorsSelected = model.aorsSelected
            , groupsSelected = model.groupsSelected
            , sendersSelected = model.sendersSelected
            , freqsSelected = model.freqsSelected
            , callsignsSelected = model.callsignsSelected
            , unitsSelected = normalizeUnitSelections model.unitsSelected
            , locationsSelected = model.locationsSelected
            , postsSelected = model.postsSelected
            , networksSelected = model.networksSelected
            , withoutNetwork = model.withoutNetwork
            , includePelengLocations = model.includePelengLocations
            , orWithExtendedForm = model.orWithExtendedForm
            , orBookmarked = model.orBookmarked
            , orImportant = model.orImportant
            , orWithCoords = model.orWithCoords
            , orWithoutCoords = model.orWithoutCoords
            , search = model.searchInput
            , metadataCc = model.metadataCc
            , metadataSender = model.metadataSender
            , metadataReceiver = model.metadataReceiver
            , metadataHash = model.metadataHash
            , onlyWithMetadata = model.onlyWithMetadata
            , withoutMetadata = model.withoutMetadata
            , tags = model.tagsSelected
            , unitsExactMatchOnly =
                if model.unitsExactMatchOnlyExplicit then
                    Just model.unitsExactMatchOnly

                else
                    Nothing
            , adjacentFreqsRange = model.adjacentFreqsRangeSelect.selected
            , withoutModelTags = model.withoutModelTags
            , filterTagsOption = Just model.filterTagsOption
            , reportTagsOnlyThisUnit = Just model.reportTagsOnlyThisUnit
            }


updModelFromQueryState : Model -> B.RerAnalysisQueryState -> Model
updModelFromQueryState model ms =
    let
        queryState =
            ms
                |> normalizeQueryStateMetadata
                |> normalizeQueryStateNetworks

        modelWithBaseState =
            { model
                | from = Shared.Components.DateTime.initFromDt { dateStr = queryState.dateFromStr, timeStr = queryState.timeFromStr }
                , to = Shared.Components.DateTime.initFromDt { dateStr = queryState.dateToStr, timeStr = queryState.timeToStr }
                , aorsSelected = queryState.aorsSelected
                , groupsSelected = queryState.groupsSelected
                , sendersSelected = queryState.sendersSelected
                , freqsSelected = queryState.freqsSelected
                , callsignsSelected = queryState.callsignsSelected
                , unitsSelected = normalizeUnitSelections queryState.unitsSelected
                , locationsSelected = queryState.locationsSelected
                , postsSelected = queryState.postsSelected
                , networksSelected = queryState.networksSelected
                , withoutNetwork = queryState.withoutNetwork
                , includePelengLocations = queryState.includePelengLocations
                , tagsSelected = queryState.tags
                , orWithExtendedForm = queryState.orWithExtendedForm
                , orBookmarked = queryState.orBookmarked
                , orImportant = queryState.orImportant
                , orWithCoords = queryState.orWithCoords
                , orWithoutCoords = queryState.orWithoutCoords
                , searchInput = queryState.search
                , metadataCc = queryState.metadataCc
                , metadataSender = queryState.metadataSender
                , metadataReceiver = queryState.metadataReceiver
                , metadataHash = queryState.metadataHash
                , onlyWithMetadata = queryState.onlyWithMetadata
                , withoutMetadata = queryState.withoutMetadata
                , filterTagsOption =
                    queryState.filterTagsOption
                        |> Maybe.withDefault B.OneOfTags
                , reportTagsOnlyThisUnit =
                    queryState.reportTagsOnlyThisUnit
                        |> Maybe.withDefault False
                , unitsExactMatchOnlyExplicit =
                    case queryState.unitsExactMatchOnly of
                        Just _ ->
                            True

                        Nothing ->
                            False
                , withoutModelTags = queryState.withoutModelTags
                , adjacentFreqsRangeSelect =
                    let
                        current =
                            model.adjacentFreqsRangeSelect
                    in
                    { current | selected = queryState.adjacentFreqsRange }
            }
    in
    case queryState.unitsExactMatchOnly of
        Just unitsExactMatchOnly ->
            { modelWithBaseState | unitsExactMatchOnly = unitsExactMatchOnly }

        Nothing ->
            modelWithBaseState


analysisStatsParams : Posix -> Posix -> Model -> B.AnalysisStatsReq
analysisStatsParams dtFromPosix dtToPosix model =
    let
        ( selectedUnitIds, selectedLegacyUnits ) =
            partitionUnitSelections (normalizeUnitSelections model.unitsSelected)

        selectedNetworks =
            if model.withoutNetwork then
                Nothing

            else
                model.networksSelected
                    |> List.filterMap String.toInt
                    |> emptyToNothing
    in
    normalizeAnalysisStatsReqMetadata
        { sinceDateInclusiveMs = Time.posixToMillis dtFromPosix
        , tillDateNoninclusiveMs = Time.posixToMillis dtToPosix
        , selectedGroups = emptyToNothing model.groupsSelected
        , selectedSenders = emptyToNothing model.sendersSelected
        , selectedFreqs = emptyToNothing (model.freqsSelected ++ model.filterSelectedAdjacentFreqs)
        , selectedCallsigns = emptyToNothing model.callsignsSelected
        , selectedUnits = emptyToNothing selectedLegacyUnits
        , selectedUnitIds = emptyToNothing selectedUnitIds
        , selectedDeviceNames = Nothing
        , selectedLocations = emptyToNothing model.locationsSelected
        , selectedPosts = emptyToNothing model.postsSelected
        , selectedAors =
            model.aorsSelected
                |> List.filterMap String.toInt
                |> emptyToNothing
        , includePelengLocations = Just model.includePelengLocations
        , orWithExtendedForm = Just model.orWithExtendedForm
        , orBookmarked = Just model.orBookmarked
        , orImportant = Just model.orImportant
        , orWithCoords = Just model.orWithCoords
        , orWithoutCoords = Just model.orWithoutCoords
        , search = Just model.searchInput
        , metadataCc = emptyToNothing model.metadataCc
        , metadataSender = emptyToNothing model.metadataSender
        , metadataReceiver = emptyToNothing model.metadataReceiver
        , metadataHash = emptyToNothing model.metadataHash
        , onlyWithMetadata = Just model.onlyWithMetadata
        , withoutMetadata = Just model.withoutMetadata
        , selectedTags = emptyToNothing model.tagsSelected
        , deniedTags = Nothing
        , tagPresence = Nothing
        , selectedNetworks = selectedNetworks
        , withoutNetwork = Just model.withoutNetwork
        , filterTagsOption = Nothing
        , unitsExactMatchOnly =
            if List.isEmpty selectedLegacyUnits then
                Nothing

            else
                Just model.unitsExactMatchOnly
        , withoutModelTags = Just model.withoutModelTags
        , reportTagsOnlyThisUnit = Just model.reportTagsOnlyThisUnit
        }


analysisStatsDefaultParams : Posix -> Posix -> B.AnalysisStatsReq
analysisStatsDefaultParams dtFromPosix dtToPosix =
    { sinceDateInclusiveMs = Time.posixToMillis dtFromPosix
    , tillDateNoninclusiveMs = Time.posixToMillis dtToPosix
    , selectedGroups = Nothing
    , selectedSenders = Nothing
    , selectedFreqs = Nothing
    , selectedCallsigns = Nothing
    , selectedUnits = Nothing
    , selectedUnitIds = Nothing
    , selectedDeviceNames = Nothing
    , selectedLocations = Nothing
    , selectedPosts = Nothing
    , selectedAors = Nothing
    , includePelengLocations = Nothing
    , orWithExtendedForm = Nothing
    , orBookmarked = Nothing
    , orImportant = Nothing
    , orWithCoords = Nothing
    , orWithoutCoords = Nothing
    , search = Nothing
    , metadataCc = Nothing
    , metadataSender = Nothing
    , metadataReceiver = Nothing
    , metadataHash = Nothing
    , onlyWithMetadata = Nothing
    , withoutMetadata = Nothing
    , selectedTags = Nothing
    , deniedTags = Nothing
    , tagPresence = Nothing
    , selectedNetworks = Nothing
    , withoutNetwork = Nothing
    , filterTagsOption = Nothing
    , unitsExactMatchOnly = Nothing
    , withoutModelTags = Nothing
    , reportTagsOnlyThisUnit = Nothing
    }


updModelFromRerAnalysisStatsReq : Model -> B.AnalysisStatsReq -> Model
updModelFromRerAnalysisStatsReq model req =
    let
        normalizedReq =
            normalizeAnalysisStatsReqMetadata req
    in
    { model
        | aorsSelected =
            normalizedReq.selectedAors
                |> def []
                |> List.map String.fromInt
        , groupsSelected = normalizedReq.selectedGroups |> def []
        , sendersSelected = normalizedReq.selectedSenders |> def []
        , freqsSelected = normalizedReq.selectedFreqs |> def []
        , callsignsSelected = normalizedReq.selectedCallsigns |> def []
        , unitsSelected =
            (normalizedReq.selectedUnitIds |> def [] |> List.map unitIdFilterValue)
                ++ (normalizedReq.selectedUnits |> def [])
                |> normalizeUnitSelections
        , tagsSelected = normalizedReq.selectedTags |> def []
        , orWithExtendedForm = normalizedReq.orWithExtendedForm |> def False
        , orBookmarked = normalizedReq.orBookmarked |> def False
        , orImportant = normalizedReq.orImportant |> def False
        , orWithCoords = normalizedReq.orWithCoords |> def False
        , orWithoutCoords = normalizedReq.orWithoutCoords |> def False
        , withoutModelTags = normalizedReq.withoutModelTags |> def False
        , includePelengLocations = normalizedReq.includePelengLocations |> def True
        , searchInput = normalizedReq.search |> def ""
        , metadataCc = normalizedReq.metadataCc |> def []
        , metadataSender = normalizedReq.metadataSender |> def []
        , metadataReceiver = normalizedReq.metadataReceiver |> def []
        , metadataHash = normalizedReq.metadataHash |> def []
        , onlyWithMetadata = normalizedReq.onlyWithMetadata |> def False
        , withoutMetadata = normalizedReq.withoutMetadata |> def False
        , locationsSelected = normalizedReq.selectedLocations |> def []
        , postsSelected = normalizedReq.selectedPosts |> def []
        , networksSelected =
            normalizedReq.selectedNetworks
                |> def []
                |> List.map String.fromInt
        , withoutNetwork = normalizedReq.withoutNetwork |> def False
        , unitsExactMatchOnly = normalizedReq.unitsExactMatchOnly |> def True
        , unitsExactMatchOnlyExplicit =
            case normalizedReq.unitsExactMatchOnly of
                Just _ ->
                    True

                Nothing ->
                    False
        , reportTagsOnlyThisUnit = normalizedReq.reportTagsOnlyThisUnit |> def False
    }


{-| Discards previous filter, applies a new one
-}
updModelFromSavedFilter : Model -> B.SavedFilter -> Model
updModelFromSavedFilter model sf =
    updModelFromRerAnalysisStatsReq model sf.req
