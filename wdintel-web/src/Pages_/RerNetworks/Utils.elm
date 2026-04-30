module Pages_.RerNetworks.Utils exposing (..)

import Bindings as B
import Json.Encode as Encode
import Shared
import Time
import Url.Builder
import Utils.Time


createAnalysisUrl : Shared.Model -> B.Network -> String -> String
createAnalysisUrl shared network callsign =
    let
        -- Generate query state with network date range and callsign filter
        queryState =
            createAnalysisQueryState shared network callsign

        -- Encode the query state
        encodedState =
            Encode.encode 0 (B.rerAnalysisQueryStateEncoder queryState)

        -- Create query parameters using Url.Builder
        query =
            [ Url.Builder.string "state" encodedState ]
    in
    Url.Builder.absolute [ "rer-analysis" ] query


createAnalysisQueryState : Shared.Model -> B.Network -> String -> B.RerAnalysisQueryState
createAnalysisQueryState shared network callsign =
    let
        -- Get date range from network
        ( dateFromStr, dateToStr ) =
            let
                fromDate =
                    case network.activeFrom of
                        Just activeFrom ->
                            Utils.Time.renderDateF4 shared.timeZone (Time.millisToPosix activeFrom)

                        Nothing ->
                            Utils.Time.renderDateF4 shared.timeZone (Time.millisToPosix shared.now)

                toDate =
                    case network.activeTo of
                        Just activeTo ->
                            Utils.Time.renderDateF4 shared.timeZone (Time.millisToPosix activeTo)

                        Nothing ->
                            -- If no end date, use current date
                            Utils.Time.renderDateF4 shared.timeZone (Time.millisToPosix shared.now)
            in
            ( fromDate, toDate )

        -- Get frequencies from network for pre-selection
        freqsSelected =
            List.map .freq network.freqs
    in
    { dateFromStr = dateFromStr
    , timeFromStr = ""
    , dateToStr = dateToStr
    , timeToStr = "00:00"
    , aorsSelected = []
    , groupsSelected = []
    , sendersSelected = []
    , freqsSelected = freqsSelected
    , callsignsSelected = [ callsign ]
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
