module Pages_.RerFreqs.Model exposing (FilterState, FurtherInvestigationFilter(..), Model, NetworkSearchState, NetworkWorkflowStatus(..), NetworkWorkflowTab(..), ShowAllPopupFor(..), TextLocation(..))

import Api
import Bindings as B
import Core.Types exposing (ApiError, GroupsActivityPerDayRsp)
import Debounce exposing (Debounce)
import Dict exposing (Dict)
import Select
import Set exposing (Set)
import Shared.Components.DateTime
import Shared.Components.Table as Table
import Time
import Utils.NetworksUtils as NetworksUtils
import Utils.RemoteData exposing (RemoteData)
import Utils.Select


type FurtherInvestigationFilter
    = All
    | NeedsInvestigation
    | DoesNotNeedInvestigation


type alias Model =
    { now : Maybe Time.Posix
    , loading : Bool
    , loadingMore : Bool
    , currentRequestTracker : Maybe String
    , requestCounter : Int
    , newOnly : Bool
    , includeNonActive : Bool
    , freqs : List B.Freq
    , from : Shared.Components.DateTime.Model
    , to : Shared.Components.DateTime.Model
    , filterState : FilterState
    , filterStateDebounce : Debounce FilterState
    , loadingUnitStats : Bool
    , unitStats : List B.FreqUnitStatRow
    , locationTexts : Dict String TextLocation
    , openMapRowId : Maybe String
    , callsignsByFreq : Api.ListCallsignsByFreqsRsp
    , callsignsInfo : Dict String (List B.CallsignInfo)
    , networksExtra : Dict Int B.Network
    , rowShowAllPopupStatus : Maybe ( String, ShowAllPopupFor )
    , selCallsignState : Select.State
    , callsignSearchQuery : String
    , callsignSearchDebounce : Debounce String
    , callsignSearchResults : RemoteData ApiError (List B.FreqCallsign)

    --TODO Remove when back returns proper list of data for table
    , callsigns : List String
    , sortingOrder : B.ListFreqsSortBy
    , groupsMessageCountByDay : GroupsActivityPerDayRsp
    , noMoreToLoad : Bool
    , networkWorkflowStatus : NetworkWorkflowStatus
    , networkAddLoading : Bool
    , networkDialogUnitSelect : Utils.Select.SelectTypeSingle Int
    , showNetworksWithoutUnit : Bool
    , furtherInvestigationFilter : FurtherInvestigationFilter
    , addKindSelect : Utils.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , addModulationSelect : Utils.Select.SelectTypeSingle Int
    , addExistingConfirmationInp : Maybe String
    , addConfirmationInp : Maybe String
    , addExistingKindSelect : Utils.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , addExistingModulationSelect : Utils.Select.SelectTypeSingle Int
    , addPostsSelect : Utils.Select.SelectType Int
    , editPostsSelect : Utils.Select.SelectType Int
    , editKindSelect : Utils.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , editModulationSelect : Utils.Select.SelectTypeSingle Int
    , modulations : RemoteData ApiError (List B.ModulationRec)
    , freqGroupsActivityForNetworkAdd : RemoteData ApiError B.FreqDailyActivityCount
    , addExistingActiveFrom : Maybe Int
    , addExistingActiveTo : Maybe Int
    , showSidebar : Bool
    , expandedArmies : Set.Set String
    , expandedDivisions : Set.Set String
    , expandedRegiments : Set.Set String
    , expandedBattalions : Set.Set String
    , showOnlyInvestigating : Bool
    , showOnlyUnknownNetwork : Bool
    , networkWorkflowTab : NetworkWorkflowTab
    , tableState : Table.State
    }


type NetworkWorkflowTab
    = Search
    | Manage


type alias FilterState =
    { freq : String
    , unit : String
    , callsigns : List String
    }


type alias NetworkSearchState =
    { showNetworksWithoutUnit : Bool
    , selectedNetworkId : Maybe Int
    }


type NetworkWorkflowStatus
    = NotStarted
    | SelectingNetwork String (Maybe Int)


type TextLocation
    = NoCoords
    | LocationText


type ShowAllPopupFor
    = ShowAllCallsigns
    | ShowAllLocations
