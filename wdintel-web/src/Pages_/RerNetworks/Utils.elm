module Pages_.RerNetworks.Utils exposing (..)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Char
import Core.Auth
import Core.Types exposing (ApiError, GroupsActivityPerDayRsp, GroupsByDate)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import File.Download as Download
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Keyed
import Html.Styled as Styled
import Json.Encode as Encode
import Layouts
import List.Extra as ListX
import Page exposing (Page)
import Pages_.RerNetworks.Id_.FrequenciesTable as FreqsTable
import Pages_.RerNetworks.Id_.Model as Types exposing (CallsignCreateMode(..), CallsignTableRow, FreqActivityFilter(..), Mode(..), Model, ShowAllPopupFor(..))
import Pages_.RerNetworks.Id_.Msg as Msgs exposing (Msg(..))
import Route exposing (Route)
import Route.Path
import Select
import Set exposing (Set)
import Shared
import Shared.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Shared.Components.Button as Button
import Shared.Components.Checkbox as Checkbox
import Shared.Components.DropdownBadge as DropdownBadge exposing (DropdownAction(..))
import Shared.Components.ModalDialog as ModalDialog
import Shared.Components.Pager as Pager
import Shared.Components.Popup as Popup
import Shared.Components.SegmentedControl as SegmentedControl
import Shared.Components.Sidebar as Sidebar
import Shared.Components.Spinner
import Shared.Components.Table as Table
import Shared.Components.Table.Column as TableColumn
import Shared.Components.Table.Config as TableConfig
import Shared.Components.Table.Sorter as TableSorter
import Shared.Model exposing (isDarkMode)
import Time
import Time.Extra
import Url.Builder
import Utils.Api.ErrorHandling
import Utils.NetworksUtils as NetworksUtils
import Utils.RemoteData as RD exposing (RemoteData(..))
import Utils.Select
import Utils.Time
import Utils.Utils exposing (networkKindVHFMapping)
import View exposing (View)


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
    , groupsSelected = []
    , sendersSelected = []
    , freqsSelected = freqsSelected
    , callsignsSelected = [ callsign ]
    , unitsSelected = []
    , locationsSelected = []
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
