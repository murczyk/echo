module RerNetworks.Create.Model exposing (..)

import Api exposing (check_if_freq_exist)
import Auth
import Bindings as B
import Char
import Components.Button as Button
import Components.Checkbox as Checkbox
import Components.Pager as Pager
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
import Route exposing (Route)
import Route.Path
import Select
import Set exposing (Set)
import Shared
import Shared.Model exposing (isDarkMode)
import Time
import Time.Extra
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
    { formErrors : Dict String String
    , createNetworkState : B.CreateNetworkReq
    , kindSelect : Le.Block.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , unitSelect : Le.Block.Select.SelectType Int
    , postsSelect : Le.Block.Select.SelectType Int
    , aorSelect : Le.Block.Select.SelectType Int
    , aorList : RemoteData ApiError (List B.AreaOfResponsibility)
    , units : RemoteData ApiError (List B.Unit)
    , addConfirmationInp : String
    , addSignsInp : String
    , creatingNetwork : Bool

    -- FREQUENCIES
    , freqCreateSidebar : Bool
    , freqCreateState : B.AddNetworkFreq
    , freqCreateKindSelect : Le.Block.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , freqCreateModulationSelect : Le.Block.Select.SelectTypeSingle Int
    , freqCreateDescriptionInp : String
    , freqCreateFormatError : Maybe String
    , freqCreateShowActiveTo : Bool
    , networkFreqsActivity : RemoteData ApiError (Dict String (Dict String Int))
    , freqs : RemoteData ApiError (List B.NetworkFreqsRes)
    , freqsActivityFilter : FreqActivityFilter
    , freqsTableState : Table.State
    , freqsEditingState : Mode (Dict String B.UpdateNetworkFreqReq)
    , freqEditSaving : Bool
    , deleteFreqConfirmation : Maybe ( Int, String )
    , deleteFreqLoading : Bool
    , callsignsOpenedPopupId : Maybe String
    , freqEditSidebar : Maybe ( String, B.UpdateNetworkFreqReq )
    , freqDetailPopup : Maybe String
    , freqEditKindSelect : Le.Block.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , freqEditModulationSelect : Le.Block.Select.SelectTypeSingle Int
    , freqEditShowActiveTo : Bool
    , modulations : RemoteData ApiError (List B.ModulationRec)
    , addConfirmationFreqSelect : Le.Block.Select.SelectTypeSingle String

    -- CALLSIGNS
    , callsigns : RemoteData ApiError (List B.NetworkCallsignRes)
    , callsignsPager : Pager.Model
    , callsignsTableState : Table.State
    , developingCallsignDropdown : Maybe Int -- ID позивного з відкритим dropdown
    , unknownCallsignDropdown : Maybe String -- Позивний з відкритим dropdown
    , deleteCallsignConfirmation : Maybe Int -- ID позивного для видалення
    , deleteCallsignLoading : Bool -- Стан завантаження видалення
    , networkCallsigns : RemoteData ApiError (List B.NetworkCallsign)
    , networkCallsignsTableState : Table.State
    , networkCallsignsPager : Pager.Model
    , networkCallsignsSearchQuery : String -- Пошуковий запит для таблиці "Позивні мережі"
    , editCallsignSidebar : Maybe Int -- ID позивного для редагування
    , editCallsignState : Maybe B.UpdateNetworkCallsignReq -- Стан форми редагування
    , editCallsignSaving : Bool -- Стан збереження редагування
    , editCallsignErrors : Dict String String -- Помилки валідації редагування
    , editCallsignSourceSelState : Select.State -- Стан селекта джерела для редагування
    , editCallsignUnitSelState : Select.State -- Стан селекта підрозділу для редагування
    , editCallsignUnitSelectorVisible : Bool -- Чи показувати селект підрозділів
    , editKindSelect : Le.Block.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , editPostsSelect : Le.Block.Select.SelectType Int
    , editUnitsSelect : Le.Block.Select.SelectType Int
    , callsignCreateSidebar : Maybe CallsignCreateMode
    , callsignCreateState : Maybe B.CreateNetworkCallsignReq
    , callsignCreateSaving : Bool
    , callsignCreateErrors : Dict String String
    , callsignCreateSourceSelState : Select.State
    , callsignCreateUnitSelState : Select.State
    , callsignCreateUnitSelectorVisible : Bool -- Чи показувати селект підрозділів
    , callsignCreateSources : List B.Source
    , callsignAddingInProgress : Set Int -- Позивні, які зараз додаються до мережі
    , callsignsSearchQuery : String -- Пошуковий запит для таблиці "Всі позивні"
    , rowShowAllPopupStatus : Maybe ( Int, ShowAllPopupFor )

    -- New states for two-stage creation
    , networkCreated : Maybe B.Network -- нова мережа після створення
    }
