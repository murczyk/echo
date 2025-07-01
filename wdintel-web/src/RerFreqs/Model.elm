module RerFreqs.Model exposing (FilterName(..), FilterState, Model, NetworkWorkflowStatus(..), NetworkSearchState, ShowAllPopupFor(..), TextLocation(..), FurtherInvestigationFilter(..))

import Api
import Bindings as B
import Debounce exposing (Debounce)
import Dict exposing (Dict)
import Le.Block.DateTime
import Le.Block.Select
import Le.Block.Toast
import Le.NetworksUtils as NetworksUtils
import Le.RemoteData exposing (RemoteData)
import Le.Types exposing (ApiError, GroupsActivityPerDayRsp)
import Select
import Set exposing (Set)
import Time


type FurtherInvestigationFilter
    = All
    | NeedsInvestigation
    | DoesNotNeedInvestigation


type alias Model =
    { formErrors : Dict String String
    , toasts : Le.Block.Toast.Model
    , zone : Maybe Time.Zone
    , now : Maybe Time.Posix
    , loading : Bool
    , newOnly : Bool
    , includeNonActive : Bool
    , freqs : List B.Freq
    , from : Le.Block.DateTime.Model
    , to : Le.Block.DateTime.Model
    , masterUnits : Dict Int B.Unit
    , networks : Dict Int B.Network
    , filterState : FilterState
    , filterStateDebounce : Debounce FilterState
    , loadingUnitStats : Bool
    , unitStats : List B.FreqUnitStatRow
    , locationTexts : Dict String TextLocation
    , openMapRowId : Maybe String
    , callsignsByFreq : Api.ListCallsignsByFreqsRsp
    , callsignsInfo : Dict String (List B.CallsignInfo)
    , rowShowAllPopupStatus : Maybe ( String, ShowAllPopupFor )
    , selCallsignState : Select.State
    , selCallsignMenu : List (Select.MenuItem String)
    , callsignsForFilter : RemoteData ApiError (List B.FreqCallsign)
    , focusedFilterItemsBeforeChange : Maybe (List String)

    --TODO Remove when back returns proper list of data for table
    , callsigns : List String
    , altUnitsByFreq : Api.ListAltUnitsByFreqsRsp
    , sortingOrder : B.ListFreqsSortBy
    , groupsMessageCountByDay : GroupsActivityPerDayRsp
    , noMoreToLoad : Bool
    , networkWorkflowStatus : NetworkWorkflowStatus
    , networkAddLoading : Bool
    , networkDialogUnitSelect : Le.Block.Select.SelectTypeSingle Int
    , showNetworksWithoutUnit : Bool
    , furtherInvestigationFilter : FurtherInvestigationFilter
    , addKindSelect : Le.Block.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , addModulationSelect : Le.Block.Select.SelectTypeSingle Int
    , addExistingConfirmationInp : Maybe String
    , addConfirmationInp : Maybe String
    , addExistingKindSelect : Le.Block.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , addExistingModulationSelect : Le.Block.Select.SelectTypeSingle Int
    , addPostsSelect : Le.Block.Select.SelectType Int
    , editPostsSelect : Le.Block.Select.SelectType Int
    , editKindSelect : Le.Block.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , editModulationSelect : Le.Block.Select.SelectTypeSingle Int
    , modulations : RemoteData ApiError (List B.ModulationRec)
    , freqGroupsActivityForNetworkAdd : RemoteData ApiError B.FreqDailyActivityCount
    , addExistingActiveFrom : Maybe Int
    , addExistingActiveTo : Maybe Int
    }


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
    | EditingNetwork String B.UpdateNetworkReq
    | CreateNewNetwork String B.CreateNetworkReq


type TextLocation
    = NoCoords
    | LocationText


type FilterName
    = CallsignsFilter


type ShowAllPopupFor
    = ShowAllCallsigns
    | ShowAllLocations
    | ShowAllAltUnits
