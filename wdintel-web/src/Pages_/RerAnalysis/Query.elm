module Pages_.RerAnalysis.Query exposing (analysisStatsDefaultParams, analysisStatsParams, emptyQueryState, modelQueryState, updModelFromQueryState, updModelFromSavedFilter)

import Bindings as B
import Pages_.RerAnalysis.Model exposing (..)
import Shared.Components.DateTime
import Time exposing (Posix)
import Utils.Utils exposing (..)


emptyQueryState : B.RerAnalysisQueryState
emptyQueryState =
    { dateFromStr = ""
    , timeFromStr = ""
    , dateToStr = ""
    , timeToStr = ""
    , groupsSelected = []
    , sendersSelected = []
    , freqsSelected = []
    , callsignsSelected = []
    , unitsSelected = []
    , locationsSelected = []
    , includePelengLocations = True
    , orWithExtendedForm = False
    , orBookmarked = False
    , orImportant = False
    , orWithCoords = False
    , search = ""
    , metadataCc = ""
    , metadataCcExact = False
    , metadataSender = ""
    , metadataSenderExact = False
    , metadataReceiver = ""
    , metadataReceiverExact = False
    , metadataHash = ""
    , metadataHashExact = False
    , withoutMetadata = False
    , tags = []
    , unitsExactMatchOnly = True
    , adjacentFreqsRange = 0
    , withoutModelTags = False
    }


modelQueryState : Model -> B.RerAnalysisQueryState
modelQueryState model =
    { dateFromStr = model.from.dateStr
    , timeFromStr = model.from.timeStr
    , dateToStr = model.to.dateStr
    , timeToStr = model.to.timeStr
    , groupsSelected = model.groupsSelected
    , sendersSelected = model.sendersSelected
    , freqsSelected = model.freqsSelected
    , callsignsSelected = model.callsignsSelected
    , unitsSelected = model.unitsSelected
    , locationsSelected = model.locationsSelected
    , includePelengLocations = model.includePelengLocations
    , orWithExtendedForm = model.orWithExtendedForm
    , orBookmarked = model.orBookmarked
    , orImportant = model.orImportant
    , orWithCoords = model.orWithCoords
    , search = model.searchInput
    , metadataCc = model.metadataCc
    , metadataCcExact = model.metadataCcExact
    , metadataSender = model.metadataSender
    , metadataSenderExact = model.metadataSenderExact
    , metadataReceiver = model.metadataReceiver
    , metadataReceiverExact = model.metadataReceiverExact
    , metadataHash = model.metadataHash
    , metadataHashExact = model.metadataHashExact
    , withoutMetadata = model.withoutMetadata
    , tags = model.tagsSelected
    , unitsExactMatchOnly = model.unitsExactMatchOnly
    , adjacentFreqsRange = model.adjacentFreqsRangeSelect.selected
    , withoutModelTags = model.withoutModelTags
    }


updModelFromQueryState : Model -> B.RerAnalysisQueryState -> Model
updModelFromQueryState model ms =
    { model
        | from = Shared.Components.DateTime.initFromDt { dateStr = ms.dateFromStr, timeStr = ms.timeFromStr }
        , to = Shared.Components.DateTime.initFromDt { dateStr = ms.dateToStr, timeStr = ms.timeToStr }
        , groupsSelected = ms.groupsSelected
        , sendersSelected = ms.sendersSelected
        , freqsSelected = ms.freqsSelected
        , callsignsSelected = ms.callsignsSelected
        , unitsSelected = ms.unitsSelected
        , locationsSelected = ms.locationsSelected
        , includePelengLocations = ms.includePelengLocations
        , tagsSelected = ms.tags
        , orWithExtendedForm = ms.orWithExtendedForm
        , orBookmarked = ms.orBookmarked
        , searchInput = ms.search
        , metadataCc = ms.metadataCc
        , metadataCcExact = ms.metadataCcExact
        , metadataSender = ms.metadataSender
        , metadataSenderExact = ms.metadataSenderExact
        , metadataReceiver = ms.metadataReceiver
        , metadataReceiverExact = ms.metadataReceiverExact
        , metadataHash = ms.metadataHash
        , metadataHashExact = ms.metadataHashExact
        , withoutMetadata = ms.withoutMetadata
        , unitsExactMatchOnly = ms.unitsExactMatchOnly
        , withoutModelTags = ms.withoutModelTags
        , adjacentFreqsRangeSelect =
            let
                current =
                    model.adjacentFreqsRangeSelect
            in
            { current | selected = ms.adjacentFreqsRange }
    }


analysisStatsParams : Posix -> Posix -> Model -> B.AnalysisStatsReq
analysisStatsParams dtFromPosix dtToPosix model =
    { sinceDateInclusiveMs = Time.posixToMillis dtFromPosix
    , tillDateNoninclusiveMs = Time.posixToMillis dtToPosix
    , selectedGroups = emptyToNothing model.groupsSelected
    , selectedSenders = emptyToNothing model.sendersSelected
    , selectedFreqs = emptyToNothing (model.freqsSelected ++ model.filterSelectedAdjacentFreqs)
    , selectedCallsigns = emptyToNothing model.callsignsSelected
    , selectedUnits = emptyToNothing model.unitsSelected
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
    , search = Just model.searchInput
    , metadataCc = emptySToNothing model.metadataCc
    , metadataCcExact = Just model.metadataCcExact
    , metadataSender = emptySToNothing model.metadataSender
    , metadataSenderExact = Just model.metadataSenderExact
    , metadataReceiver = emptySToNothing model.metadataReceiver
    , metadataReceiverExact = Just model.metadataReceiverExact
    , metadataHash = emptySToNothing model.metadataHash
    , metadataHashExact = Just model.metadataHashExact
    , withoutMetadata = Just model.withoutMetadata
    , selectedTags = emptyToNothing model.tagsSelected
    , selectedNetworks = 
        model.networksSelected
            |> List.filterMap String.toInt
            |> emptyToNothing
    , filterTagsOption = Nothing
    , unitsExactMatchOnly = Just model.unitsExactMatchOnly
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
    , selectedLocations = Nothing
    , selectedPosts = Nothing
    , selectedAors = Nothing
    , includePelengLocations = Nothing
    , orWithExtendedForm = Nothing
    , orBookmarked = Nothing
    , orImportant = Nothing
    , orWithCoords = Nothing
    , search = Nothing
    , metadataCc = Nothing
    , metadataCcExact = Nothing
    , metadataSender = Nothing
    , metadataSenderExact = Nothing
    , metadataReceiver = Nothing
    , metadataReceiverExact = Nothing
    , metadataHash = Nothing
    , metadataHashExact = Nothing
    , withoutMetadata = Nothing
    , selectedTags = Nothing
    , selectedNetworks = Nothing
    , filterTagsOption = Nothing
    , unitsExactMatchOnly = Nothing
    , withoutModelTags = Nothing
    , reportTagsOnlyThisUnit = Nothing
    }


updModelFromRerAnalysisStatsReq : Model -> B.AnalysisStatsReq -> Model
updModelFromRerAnalysisStatsReq model req =
    { model
        | groupsSelected = req.selectedGroups |> def []
        , sendersSelected = req.selectedSenders |> def []
        , freqsSelected = req.selectedFreqs |> def []
        , callsignsSelected = req.selectedCallsigns |> def []
        , unitsSelected = req.selectedUnits |> def []
        , orWithExtendedForm = req.orWithExtendedForm |> def False
        , orBookmarked = req.orBookmarked |> def False
        , withoutModelTags = req.withoutModelTags |> def False
        , includePelengLocations = req.includePelengLocations |> def True
        , metadataCc = req.metadataCc |> def ""
        , metadataCcExact = req.metadataCcExact |> def False
        , metadataSender = req.metadataSender |> def ""
        , metadataSenderExact = req.metadataSenderExact |> def False
        , metadataReceiver = req.metadataReceiver |> def ""
        , metadataReceiverExact = req.metadataReceiverExact |> def False
        , metadataHash = req.metadataHash |> def ""
        , metadataHashExact = req.metadataHashExact |> def False
        , withoutMetadata = req.withoutMetadata |> def False
        , locationsSelected = req.selectedLocations |> def []
        , postsSelected = req.selectedPosts |> def []
        , reportTagsOnlyThisUnit = req.reportTagsOnlyThisUnit |> def False
    }


{-| Discards previous filter, applies a new one
-}
updModelFromSavedFilter : Model -> B.SavedFilter -> Model
updModelFromSavedFilter model sf =
    updModelFromRerAnalysisStatsReq model sf.req
