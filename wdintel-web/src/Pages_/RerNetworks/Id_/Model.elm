module Pages_.RerNetworks.Id_.Model exposing (..)

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
import Pages_.RerNetworks.ReportConfig as ReportConfig
import Route exposing (Route)
import Route.Path
import Select
import Set exposing (Set)
import Shared
import Shared.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Shared.Components.Button as Button
import Shared.Components.Checkbox as Checkbox
import Shared.Components.DateTime
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


type Mode updateReq
    = Readonly
    | Editing updateReq


type FreqActivityFilter
    = AllFreqs
    | ActiveFreqs
    | InactiveFreqs


type CallsignCreateMode
    = CreateFromScratch -- Створення "з нуля" (кнопка + в таблиці)
    | CreateFromUnknown String -- Створення зі списку "Приналежність встановлюється"


type ShowAllPopupFor
    = ShowAllComment


type alias CallsignTableRow =
    { id : Int
    , callsign : String
    , messageCount : Int
    , lastDatetime : Maybe Int
    , position : String
    , unitName : String
    , comment : String
    , createdAt : Int
    , sourceName : String
    }


type alias Model =
    { network : RemoteData ApiError B.Network
    , callsigns : RemoteData ApiError (List B.NetworkCallsignRes)
    , mapPoints : RemoteData ApiError (List B.NetworkPoint)
    , groupsActivity : RemoteData ApiError GroupsByDate
    , networkFreqsActivity : RemoteData ApiError (Dict String (Dict String Int))
    , freqs : RemoteData ApiError (List B.NetworkFreqsRes)
    , networkKeys : RemoteData ApiError (List B.EncryptionKeyData)
    , freqsEditingState : Mode (Dict String B.UpdateNetworkFreqReq)
    , callsignsEditingState : Mode (Dict String Bool)
    , callsignsOpenedPopupId : Maybe String
    , mode : Mode B.UpdateNetworkReq
    , editLoading : Bool
    , editKindSelect : Utils.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , editPostsSelect : Utils.Select.SelectType Int
    , editUnitsSelect : Utils.Select.SelectType Int
    , editAorSelect : Utils.Select.SelectType Int
    , aorList : RemoteData ApiError (List B.AreaOfResponsibility)
    , addConfirmationInp : String
    , addConfirmationFreqSelect : Utils.Select.SelectTypeSingle String
    , addSignsInp : String
    , signals : RemoteData ApiError (List B.NetworkSignalsRes)
    , reportModalOpened : Bool
    , reportDownloadInProgress : Bool
    , report : ReportConfig.ReportType
    , reportFromDate : Shared.Components.DateTime.Model
    , reportToDate : Shared.Components.DateTime.Model
    , freqsActivityFilter : FreqActivityFilter
    , freqsTableState : Table.State
    , keysTableState : Table.State
    , callsignsTableState : Table.State
    , keyCreateSidebar : Bool
    , keyCreateState :
        { key : String
        , description : String
        , sigintNetworkFreqIds : List Int
        }
    , keyCreateFreqSelect : Utils.Select.SelectType Int
    , keyCreateModulationSelect : Utils.Select.SelectTypeSingle Int
    , keyCreateSaving : Bool
    , keyEditSidebar : Maybe B.UpdateEncryptionKeyReq
    , keyEditFreqSelect : Utils.Select.SelectType Int
    , keyEditModulationSelect : Utils.Select.SelectTypeSingle Int
    , keyEditSaving : Bool
    , deleteKeyConfirmation : Maybe ( Int, String )
    , deleteKeyLoading : Bool
    , freqEditSidebar : Maybe ( String, B.UpdateNetworkFreqReq )
    , freqDetailPopup : Maybe String
    , modulations : RemoteData ApiError (List B.ModulationRec)
    , freqEditKindSelect : Utils.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , freqEditModulationSelect : Utils.Select.SelectTypeSingle Int
    , freqEditKeySelect : Utils.Select.SelectType Int
    , freqEditSaving : Bool
    , freqEditShowActiveTo : Bool
    , deleteNetworkConfirmation : Maybe Int
    , deleteNetworkLoading : Bool
    , deleteFreqConfirmation : Maybe ( Int, String )
    , deleteFreqLoading : Bool

    -- Frequency creation sidebar
    , freqCreateSidebar : Bool
    , freqCreateState : B.AddNetworkFreq
    , freqCreateKindSelect : Utils.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , freqCreateModulationSelect : Utils.Select.SelectTypeSingle Int
    , freqCreateKeySelect : Utils.Select.SelectType Int
    , freqCreateDescriptionInp : String
    , freqCreateFormatError : Maybe String
    , freqCreateShowActiveTo : Bool

    -- Network callsigns (new table)
    , networkCallsigns : RemoteData ApiError (List B.NetworkCallsign)
    , networkCallsignsTableState : Table.State
    , networkCallsignsPager : Pager.Model
    , callsignsPager : Pager.Model

    -- Callsign adding functionality
    , callsignAddingInProgress : Set Int -- Позивні, які зараз додаються до мережі
    , callsignsSearchQuery : String -- Пошуковий запит для таблиці "Всі позивні"
    , networkCallsignsSearchQuery : String -- Пошуковий запит для таблиці "Позивні мережі"

    -- Network callsign creation sidebar
    , callsignCreateSidebar : Maybe CallsignCreateMode
    , callsignCreateState : Maybe B.CreateNetworkCallsignReq
    , callsignCreateSaving : Bool
    , callsignCreateErrors : Dict String String
    , callsignCreateSourceSelState : Select.State
    , callsignCreateUnitSelState : Select.State
    , callsignCreateUnitSelectorVisible : Bool -- Чи показувати селект підрозділів
    , callsignCreateSources : List B.Source

    -- Callsign deletion confirmation dialog
    , deleteCallsignConfirmation : Maybe Int -- ID позивного для видалення
    , deleteCallsignLoading : Bool -- Стан завантаження видалення

    -- Callsign editing functionality
    , editCallsignSidebar : Maybe Int -- ID позивного для редагування
    , editCallsignState : Maybe B.UpdateNetworkCallsignReq -- Стан форми редагування
    , editCallsignSaving : Bool -- Стан збереження редагування
    , editCallsignErrors : Dict String String -- Помилки валідації редагування
    , editCallsignSourceSelState : Select.State -- Стан селекта джерела для редагування
    , editCallsignUnitSelState : Select.State -- Стан селекта підрозділу для редагування
    , editCallsignUnitSelectorVisible : Bool -- Чи показувати селект підрозділів

    -- Developing callsigns dropdown
    , developingCallsignDropdown : Maybe Int -- ID позивного з відкритим dropdown

    -- Unknown callsigns dropdown
    , unknownCallsignDropdown : Maybe String -- Позивний з відкритим dropdown

    -- Row show all popup status for comments
    , rowShowAllPopupStatus : Maybe ( Int, ShowAllPopupFor )

    -- Sidebar states for creating descriptions
    , confirmationCreateSidebar : Bool
    , signsCreateSidebar : Bool

    -- Sidebar state for editing descriptions
    , editDescriptionSidebar : Maybe ( Int, B.NetworkDescription )

    -- Input fields for editing descriptions
    , editDescriptionInp : String
    , editDescriptionFreqSelect :
        { state : Select.State
        , items : List (Select.MenuItem Int)
        , selected : Maybe Int
        }

    -- Delete confirmation dialog state
    , deleteDescriptionConfirmation : Maybe B.NetworkDescription
    }
