module RerAnalysis.Query exposing (analysisStatsDefaultParams, analysisStatsParams, emptyQueryState, modelQueryState, updModelFromQueryState, updModelFromSavedFilter)

import Bindings as B
import Le.Block.DateTime
import Le.Utils exposing (..)
import RerAnalysis.Model exposing (..)
import Time exposing (Posix)


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
    , tags = []
    , unitsExactMatchOnly = True
    , adjacentFreqsRange = 0
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
    , tags = model.tagsSelected
    , unitsExactMatchOnly = model.unitsExactMatchOnly
    , adjacentFreqsRange = model.adjacentFreqsRangeSelect.selected
    }


updModelFromQueryState : Model -> B.RerAnalysisQueryState -> Model
updModelFromQueryState model ms =
    { model
        | from = Le.Block.DateTime.initFromDt { dateStr = ms.dateFromStr, timeStr = ms.timeFromStr }
        , to = Le.Block.DateTime.initFromDt { dateStr = ms.dateToStr, timeStr = ms.timeToStr }
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
        , unitsExactMatchOnly = ms.unitsExactMatchOnly
        , adjacentFreqsRangeSelect = 
            let
                current = model.adjacentFreqsRangeSelect
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
    , selectedTags = emptyToNothing model.tagsSelected
    , filterTagsOption = Nothing
    , unitsExactMatchOnly = Just model.unitsExactMatchOnly
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
    , selectedTags = Nothing
    , filterTagsOption = Nothing
    , unitsExactMatchOnly = Nothing
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
        , includePelengLocations = req.includePelengLocations |> def True
        , locationsSelected = req.selectedLocations |> def []
        , postsSelected = req.selectedPosts |> def []
    }


{-| Discards previous filter, applies a new one
-}
updModelFromSavedFilter : Model -> B.SavedFilter -> Model
updModelFromSavedFilter model sf =
    updModelFromRerAnalysisStatsReq model sf.req
