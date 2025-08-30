module RerNetworks.Id_.Model exposing (..)

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
    , freqsEditingState : Mode (Dict String B.UpdateNetworkFreqReq)
    , callsignsEditingState : Mode (Dict String Bool)
    , callsignsOpenedPopupId : Maybe String
    , mode : Mode B.UpdateNetworkReq
    , missingFieldsMode : Mode B.UpdateNetworkReq
    , missingFieldsEditLoading : Bool
    , editKindSelect : Le.Block.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , editPostsSelect : Le.Block.Select.SelectType Int
    , editUnitsSelect : Le.Block.Select.SelectType Int
    , editAorSelect : Le.Block.Select.SelectType Int
    , aorList : RemoteData ApiError (List B.AreaOfResponsibility)
    , addConfirmationInp : String
    , addConfirmationFreqSelect : Le.Block.Select.SelectTypeSingle String
    , addSignsInp : String
    , signals : RemoteData ApiError (List B.NetworkSignalsRes)
    , reportModalOpened : Bool
    , reportDownloadInProgress : Bool
    , reportNetworksOnly : Bool
    , reportActiveFreqsOnly : Bool
    , reportIncludePelengsMap : Bool
    , reportIncludeSigintSigns : Bool
    , reportIncludeConfirmation : Bool
    , freqsActivityFilter : FreqActivityFilter
    , freqsTableState : Table.State
    , callsignsTableState : Table.State
    , freqEditSidebar : Maybe ( String, B.UpdateNetworkFreqReq )
    , freqDetailPopup : Maybe String
    , modulations : RemoteData ApiError (List B.ModulationRec)
    , freqEditKindSelect : Le.Block.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , freqEditModulationSelect : Le.Block.Select.SelectTypeSingle Int
    , freqEditSaving : Bool
    , freqEditShowActiveTo : Bool
    , deleteNetworkConfirmation : Maybe Int
    , deleteNetworkLoading : Bool
    , deleteFreqConfirmation : Maybe ( Int, String )
    , deleteFreqLoading : Bool

    -- Frequency creation sidebar
    , freqCreateSidebar : Bool
    , freqCreateState : B.AddNetworkFreq
    , freqCreateKindSelect : Le.Block.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , freqCreateModulationSelect : Le.Block.Select.SelectTypeSingle Int
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
        , items : List (Select.MenuItem String)
        , selected : Maybe String
        }

    -- Delete confirmation dialog state
    , deleteDescriptionConfirmation : Maybe B.NetworkDescription
    }
