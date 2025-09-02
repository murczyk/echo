module RerNetworks.Create.Msg exposing (..)

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
import RerNetworks.Create.Model exposing (FreqActivityFilter, ShowAllPopupFor)
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
    | Callsigns CallsignsMsg
    | NavigateToIdPage


type CallsignsMsg
    = CallsignsReturnedByApi (Result ApiError B.SingleNetworkCallsignsListRsp)
    | NetworkCallsignsReturnedByApi (Result ApiError B.ListNetworkCallsignsRes)
    | CallsignCreated (Result ApiError B.NetworkCallsign)
    | CallsignAddedToNetwork (Result ApiError (List B.NetworkCallsign))
    | CallsignUpdated (Result ApiError B.NetworkCallsign)
    | CallsignDeletedFromNetwork (Result ApiError B.NetworkCallsign)
    | GotSources (Result ApiError B.ListSourcesRsp)
    | OpenCallsignCreateSidebar
    | CloseCallsignCreateSidebar
    | UpdateCallsignCreateField (Maybe B.CreateNetworkCallsignReq -> Maybe B.CreateNetworkCallsignReq)
    | CreateCallsignClicked
    | CallsignCreateSourceSelMsg (Select.Msg Int)
    | CallsignCreateUnitSelMsg (Select.Msg Int)
    | ToggleCallsignCreateUnitSelector -- Показати/сховати селект підрозділів для створення
    | ResetCallsignCreateUnit -- Повернути підрозділ мережі для створення
    | AddCallsignToNetwork Int -- Додавання позивного до мережі
    | OpenAddFromUnknownSidebar String -- Відкриття сайдбару додавання зі списку "Приналежність встановлюється"
    | EditCallsignClicked Int -- Клік по кнопці редагування позивного з мережі
    | CloseEditCallsignSidebar -- Закриття сайдбару редагування
    | UpdateEditCallsignField (Maybe B.UpdateNetworkCallsignReq -> Maybe B.UpdateNetworkCallsignReq) -- Оновлення полів форми редагування
    | SaveEditCallsignClicked -- Збереження змін редагування
    | EditCallsignSourceSelMsg (Select.Msg Int) -- Повідомлення від селекта джерела для редагування
    | EditCallsignUnitSelMsg (Select.Msg Int) -- Повідомлення від селекта підрозділу для редагування
    | ToggleEditCallsignUnitSelector -- Показати/сховати селект підрозділів для редагування
    | ResetEditCallsignUnit -- Повернути підрозділ мережі для редагування
    | DeleteCallsignFromNetwork Int -- Клік по кнопці видалення позивного з мережі
    | DeleteCallsignConfirmed Int -- Підтвердження видалення позивного
    | DeleteCallsignCanceled -- Скасування видалення позивного
    | ToggleDevelopingCallsignDropdown Int -- Відкрити/закрити dropdown для позивного
    | CloseDevelopingCallsignDropdown -- Закрити всі dropdown
    | NavigateToCallsignPage Int -- Перейти на сторінку позивного
    | ToggleUnknownCallsignDropdown String -- Відкрити/закрити dropdown для невідомого позивного
    | CloseUnknownCallsignDropdown -- Закрити всі dropdown для невідомих позивних
    | SetCallsignsTableState Table.State
    | SetNetworkCallsignsTableState Table.State
    | NetworkCallsignsPagerMsg Pager.Msg
    | CallsignsPagerMsg Pager.Msg
    | CallsignsSearchChanged String -- Зміна пошукового запиту для таблиці "Всі позивні"
    | NetworkCallsignsSearchChanged String -- Зміна пошукового запиту для таблиці "Позивні мережі"
    | RowShowAllPopupChanged (Maybe ( Int, ShowAllPopupFor )) -- Зміна статусу popup для показу повного коментаря


type FrequenciesMsg
    = FreqsReturnedByApi (Result ApiError B.SingleNetworkFreqsListRsp)
    | FreqUpdatedByApi (Result ApiError B.Network)
    | FreqAddedToNetwork (Result ApiError B.Network)
    | DeleteFreqReturnedByApi Int (Result ApiError B.Network)
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
