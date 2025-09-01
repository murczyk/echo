module RerNetworks.Utils exposing (..)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Char
import Components.Button as Button
import Components.Checkbox as Checkbox
import Components.DropdownBadge as DropdownBadge exposing (DropdownAction(..))
import Components.ModalDialog as ModalDialog
import Components.Pager as Pager
import Components.SegmentedControl as SegmentedControl
import Components.Sidebar as Sidebar
import Components.Table as Table
import Components.Table.Column as TableColumn
import Components.Table.Config as TableConfig
import Components.Table.Sorter as TableSorter
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
import Le.Auth
import Le.Block.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Le.Block.Popup as Popup
import Le.Block.Select
import Le.Block.Spinner
import Le.ErrorHandling
import Le.NetworksUtils as NetworksUtils
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Time
import Le.Types exposing (ApiError, GroupsActivityPerDayRsp, GroupsByDate)
import Le.Utils exposing (networkKindVHFMapping)
import List.Extra as ListX
import Page exposing (Page)
import RerNetworks.Id_.FrequenciesTable as FreqsTable
import RerNetworks.Id_.Model as Types exposing (CallsignCreateMode(..), CallsignTableRow, FreqActivityFilter(..), Mode(..), Model, ShowAllPopupFor(..))
import RerNetworks.Id_.Msg as Msgs exposing (Msg(..))
import Route exposing (Route)
import Route.Path
import Select
import Set exposing (Set)
import Shared
import Shared.Model exposing (isDarkMode)
import Time
import Time.Extra
import Url.Builder
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
                            Le.Time.renderDateF4 shared.timeZone (Time.millisToPosix activeFrom)

                        Nothing ->
                            Le.Time.renderDateF4 shared.timeZone (Time.millisToPosix shared.now)

                toDate =
                    case network.activeTo of
                        Just activeTo ->
                            Le.Time.renderDateF4 shared.timeZone (Time.millisToPosix activeTo)

                        Nothing ->
                            -- If no end date, use current date
                            Le.Time.renderDateF4 shared.timeZone (Time.millisToPosix shared.now)
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
    , tags = []
    , unitsExactMatchOnly = True
    , adjacentFreqsRange = 0
    }
