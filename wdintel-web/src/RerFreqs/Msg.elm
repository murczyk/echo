module RerFreqs.Msg exposing (Msg(..))

import Api
import Bindings as B
import Bytes exposing (Bytes)
import Components.Watermark as Watermark exposing (Watermark)
import Debounce exposing (Debounce)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Le.Block.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Le.Block.DateTime
import Le.Block.Toast
import Le.NetworksUtils as NetworksUtils
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Types as Types exposing (ApiError, GroupsActivityPerDayRsp)
import Le.Utils exposing (..)
import Page exposing (Page)
import RerFreqs.Model exposing (FilterState, ShowAllPopupFor)
import Route exposing (Route)
import Select
import Time exposing (Posix)
import TimeZone
import View exposing (View)


type Msg
    = ToastMsg Le.Block.Toast.Msg
    | Refresh
    | GotFreqs Bool (Result ApiError B.ListFreqsRsp)
    | GotFreqNetworks String (Result ApiError (List B.Network))
    | DateTimeFromMsg (Le.Block.DateTime.Msg Msg)
    | DateTimeToMsg (Le.Block.DateTime.Msg Msg)
    | GotZone (Result TimeZone.Error ( String, Time.Zone ))
    | GotTime Time.Zone Posix
    | UnitsReturnedByApi (Result ApiError B.ListUnitsRsp)
    | NetworkAddUnitSelMsg (Select.Msg Int)
    | NetworkAddKindSelMsg (Select.Msg NetworksUtils.NetworkKind)
    | NetworkAddModulationSelMsg (Select.Msg Int)
    | NetworkAddExistingKindSelMsg (Select.Msg NetworksUtils.NetworkKind)
    | NetworkAddExistingModulationSelMsg (Select.Msg Int)
    | NetworkAddPostsSelMsg (Select.Msg Int)
    | NetworkEditPostsSelMsg (Select.Msg Int)
    | NetworkEditKindSelMsg (Select.Msg NetworksUtils.NetworkKind)
    | NetworkEditModulationSelMsg (Select.Msg Int)
    | NetworkAddMsg B.CreateNetworkReq
    | NetworkEditMsg B.UpdateNetworkReq
    | NetworksReturnedByApi (Result ApiError (List B.Network))
    | FilterStateMsg FilterState
    | FilterStateDebounceMsg Debounce.Msg
    | UnitStatsReturnedByApi (Result ApiError B.FreqUnitStatsRsp)
    | UnitsReload
    | SwitchFromTextToMap String
    | MapClose String
    | PointsByFreqReturnedByApi String (Result ApiError B.ListPointsByFreqRsp)
    | CallsignsByFreqsReturnedByApi (Result ApiError Api.ListCallsignsByFreqsRsp)
    | GroupsMessageCountByDayReturnedByApi (Result ApiError GroupsActivityPerDayRsp)
    | CallsignsInfoReturnedByApi (Result ApiError (List B.CallsignInfoRes))
    | AltUnitsByFreqReturnedByApi (Result ApiError Api.ListAltUnitsByFreqsRsp)
    | SortByMessageNumber
    | FreqsLoadMore
    | RowShowAllPopupChanged (Maybe ( String, ShowAllPopupFor ))
    | SelCallsignMsg (Select.Msg String)
    | GotFilterCallsigns (Result ApiError B.CallsignsForFreqRsp)
    | ReportEtalonkaDownload Bool
    | ReportEtalonkaDownloadDone (Result ApiError Bytes)
    | OpenReportModal
    | CloseReportModal
    | ChangeReportStatus Bool
    | SelectReportAdjacentFreqsRange (Select.Msg B.AdjacentFreqDistance)
    | OpenAddNetworkSidebar String
    | CloseAddNetworkSidebar
    | NetworkCreate
    | NetworkCreated String (Result ApiError B.Network)
    | NetworkUpdate
    | NetworkUpdated String (Result ApiError B.Network)
    | NetworkStartCreatingFlow
    | FreqAddToExistingNetwork String Int
    | FreqRemoveFromExistingNetwork String B.Network
    | NetworkAddToggleExistingId Int
    | FreqAddedToNetwork String (Result ApiError B.Network)
    | FreqRemovedFromNetwork String (Result ApiError B.Network)
    | NetworkStartEditingFlow B.Network
    | ModulationsReturnedByApi (Result ApiError (List B.ModulationRec))
    | FreqGroupsActivityReturnedByApi (Result ApiError B.FreqDailyActivityCount)
    | NetworkPostsUpdated String B.UpdateNetworkReq (Result ApiError B.Network)
    | NetworkFreqUpdated String B.UpdateNetworkReq (Result ApiError B.Network)
    | ConfirmationInputChangedByUser String
    | Confirmation2InputChangedByUser String
    | NetworkConfirmationAdded (Result ApiError B.Network)
    | UnitsReloadClickedByUser
