module RerNetworks.Create.Msg exposing (..)

import Api exposing (check_if_freq_exist)
import Auth
import Bindings as B
import Char
import Components.Button as Button
import Components.Checkbox as Checkbox
import Components.Sidebar as Sidebar
import Components.Table as Table
import Debounce exposing (Debounce)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Html.Styled as Styled
import Http
import Layouts
import Le.Block.Select
import Le.Block.Toast
import Le.Components exposing (fieldError, isInvalidCls)
import Le.NetworksUtils as NetworksUtils
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Time
import Le.Types exposing (ApiError)
import Maybe.Extra as MaybeX
import Page exposing (Page)
import RerNetworks.Create.Model exposing (FreqActivityFilter)
import Route exposing (Route)
import Route.Path
import Select
import Shared
import Shared.Model exposing (isDarkMode)
import Time
import Time.Extra
import View exposing (View)


type Msg
    = UpdateNetworkState (B.CreateNetworkReq -> B.CreateNetworkReq)
    | KindSelectMsg (Select.Msg NetworksUtils.NetworkKind)
    | UnitSelectMsg (Select.Msg Int)
    | PostsSelectMsg (Select.Msg Int)
    | AorSelectMsg (Select.Msg Int)
    | AorListReturnedByApi (Result ApiError (List B.AreaOfResponsibility))
    | UnitsReturnedByApi (Result ApiError B.ListUnitsRsp)
    | ConfirmationInputChangedByUser String
    | SignsInputChangedByUser String
    | DescriptionAddClickedByUser B.NetworkDescrType
    | CancelClicked
    | CreateClicked
    | ValidateField String
    | NetworkCreated (Result ApiError B.Network)
    | Frequencies FrequenciesMsg
    | ModulationsReturnedByApi (Result ApiError (List B.ModulationRec))


type FrequenciesMsg
    = FreqsReturnedByApi (Result ApiError B.SingleNetworkFreqsListRsp)
    | FreqUpdatedByApi (Result ApiError B.Network)
    | FreqAddedToNetwork (Result ApiError B.Network)
    | DeleteFreqReturnedByApi (Result ApiError B.Network)
    | FreqsEditingMsg B.UpdateNetworkFreqReq
    | FreqsEditStartedByUser
    | FreqsEditSavedByUser
    | FreqsEditCanceledByUser
    | OpenFreqEditSidebar String B.UpdateNetworkFreqReq
    | CloseFreqEditSidebar
    | UpdateFreqEditSidebar B.UpdateNetworkFreqReq
    | SaveFreqEditSidebar
    | FreqKindSelectMsg (Select.Msg NetworksUtils.NetworkKind)
    | FreqModulationSelectMsg (Select.Msg Int)
    | ToggleFreqEditShowActiveTo
    | OpenFreqCreateSidebar
    | CloseFreqCreateSidebar
    | UpdateFreqCreateField (B.AddNetworkFreq -> B.AddNetworkFreq)
    | FreqCreateKindSelectMsg (Select.Msg NetworksUtils.NetworkKind)
    | FreqCreateModulationSelectMsg (Select.Msg Int)
    | FreqCreateDescriptionInputChangedByUser String
    | ToggleFreqCreateShowActiveTo
    | AddFreqToNetwork
    | DeleteFreqClickedByUser Int String
    | DeleteFreqConfirmedByUser
    | DeleteFreqCanceledByUser
    | OpenFreqDetailPopup String
    | CloseFreqDetailPopup
    | FreqsActivityFilterChangedByUser FreqActivityFilter
    | SetFreqsTableState Table.State
    | CallsignsPopupOpenedByUser String
    | CallsignsPopupClosedByUser
    | NetworkFreqsActivityReturnedByApi (Result ApiError (Dict String (Dict String Int)))
