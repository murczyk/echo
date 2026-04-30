module Pages_.RerFreqs.Msg exposing (Msg(..))

import Api
import Bindings as B
import Core.Types exposing (ApiError, GroupsActivityPerDayRsp)
import Debounce
import Pages_.RerFreqs.Model exposing (FilterState, ShowAllPopupFor)
import Select
import Shared.Components.DateTime
import Shared.Components.Table as Table
import Time exposing (Posix)
import Utils.NetworksUtils as NetworksUtils


type Msg
    = Refresh
    | GotFreqs Bool (Result ApiError B.ListFreqsRsp)
    | GotFreqNetworks String (Result ApiError (List B.Network))
    | DateTimeFromMsg (Shared.Components.DateTime.Msg Msg)
    | DateTimeToMsg (Shared.Components.DateTime.Msg Msg)
    | GotTime Posix
    | NetworkAddUnitSelMsg (Select.Msg Int)
    | NetworkAddExistingKindSelMsg (Select.Msg NetworksUtils.NetworkKind)
    | NetworkAddExistingModulationSelMsg (Select.Msg Int)
    | FilterStateMsg FilterState
    | FilterStateDebounceMsg Debounce.Msg
    | UnitStatsReturnedByApi (Result ApiError B.FreqUnitStatsRsp)
    | SwitchFromTextToMap String
    | MapClose String
    | PointsByFreqReturnedByApi String (Result ApiError B.ListPointsByFreqRsp)
    | CallsignsByFreqsReturnedByApi (Result ApiError Api.ListCallsignsByFreqsRsp)
    | AltUnitsByFreqReturnedByApi Int Bool (Result ApiError Api.ListAltUnitsByFreqsRsp)
    | GroupsMessageCountByDayReturnedByApi (Result ApiError GroupsActivityPerDayRsp)
    | CallsignsInfoReturnedByApi (Result ApiError (List B.CallsignInfoRes))
    | NetworksInfoLoaded (Result ApiError (List B.Network))
    | SortByMessageNumber
    | FreqsLoadMore
    | RowShowAllPopupChanged (Maybe ( String, ShowAllPopupFor ))
    | SelCallsignMsg (Select.Msg String)
    | CallsignSearchDebounceMsg Debounce.Msg
    | CallsignSearchResultsReturned (Result ApiError B.CallsignsForFreqRsp)
    | OpenAddNetworkSidebar String
    | CloseAddNetworkSidebar
    | FreqAddToExistingNetwork String Int
    | FreqRemoveFromExistingNetwork String B.Network
    | NetworkAddToggleExistingId Int
    | FreqAddedToNetwork String (Result ApiError B.Network)
    | FreqRemovedFromNetwork String (Result ApiError B.Network)
    | ModulationsReturnedByApi (Result ApiError (List B.ModulationRec))
    | FreqGroupsActivityReturnedByApi (Result ApiError B.FreqDailyActivityCount)
    | NetworkPostsUpdated String B.UpdateNetworkReq (Result ApiError B.Network)
    | NetworkFreqUpdated String B.UpdateNetworkReq (Result ApiError B.Network)
    | ConfirmationInputChangedByUser String
    | Confirmation2InputChangedByUser String
    | NetworkConfirmationAdded (Result ApiError B.Network)
    | NetworkAddExistingActiveFromChanged String
    | NetworkAddExistingActiveToChanged String
    | NetworkSearchWithoutUnitToggled Bool
    | NetworkSearchWithoutUnitToggle
    | FurtherInvestigationFilterChanged Pages_.RerFreqs.Model.FurtherInvestigationFilter
    | ToggleSidebar
    | ToggleShowOnlyInvestigating Bool
    | ToggleShowOnlyUnknownNetwork Bool
    | ToggleArmyExpanded String
    | ToggleDivisionExpanded String String
    | ToggleRegimentExpanded String String String
    | ToggleBattalionExpanded String String String String
    | FilterUnitMsg String
    | ClearAllFilters
    | NetworkWorkflowTabClicked Pages_.RerFreqs.Model.NetworkWorkflowTab
    | NetworkUpdated String (Result ApiError B.Network)
    | UnitsSearchReturned (Result ApiError B.ListUnitsByIdRsp)
    | UnitsSearchDebounceTimerExpired String
    | SetTableState Table.State
