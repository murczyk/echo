module RerNetworks.Id_.Msg exposing (..)

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
import RerNetworks.Id_.Model as Types exposing (CallsignCreateMode(..), CallsignTableRow, FreqActivityFilter(..), Mode(..), ShowAllPopupFor(..))
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


type Msg
    = CallsignsReturnedByApi (Result ApiError B.SingleNetworkCallsignsListRsp)
    | NetworkReturnedByApi (Result ApiError B.Network)
    | MapPointsReturnedByApi (Result ApiError B.ListNetworkPointsRsp)
    | GroupsActivityReturnedByApi (Result ApiError GroupsByDate)
    | NetworkFreqsActivityReturnedByApi (Result ApiError (Dict String (Dict String Int)))
    | FreqsReturnedByApi (Result ApiError B.SingleNetworkFreqsListRsp)
    | CallsignsPopupOpenedByUser String
    | CallsignsPopupClosedByUser
    | NetworkEditStartedByUser
    | NetworkEditingSavedByUser
    | NetworkEditingCanceledByUser
    | NetworkEditingMsg B.UpdateNetworkReq
    | MissingFieldsEditStartedByUser
    | MissingFieldsEditSavedByUser
    | MissingFieldsEditCanceledByUser
    | MissingFieldsEditingMsg B.UpdateNetworkReq
    | MissingFieldsUpdatedByApi (Result ApiError B.Network)
    | FreqsEditingMsg B.UpdateNetworkFreqReq
    | FreqsEditStartedByUser
    | FreqsEditSavedByUser
    | FreqsEditCanceledByUser
    | FreqUpdatedByApi (Result ApiError B.Network)
    | NetworkUpdatedByApi (Result ApiError B.Network)
    | NetworkPostsUpdatedByApi B.UpdateNetworkReq (Result ApiError B.Network)
    | NetworkUnitsUpdatedByApi B.UpdateNetworkReq (Result ApiError B.Network)
    | EditNetworkKindSelMsg (Select.Msg NetworksUtils.NetworkKind)
    | NetworkEditPostsSelMsg (Select.Msg Int)
    | NetworkEditUnitsSelMsg (Select.Msg Int)
    | NetworkEditAorSelMsg (Select.Msg Int)
    | AorListReturnedByApi (Result ApiError (List B.AreaOfResponsibility))
    | DescriptionAddClickedByUser Int B.NetworkDescrType
    | NetworkDescriptionAdded B.NetworkDescrType (Result ApiError B.Network)
    | ConfirmationInputChangedByUser String
    | SignsInputChangedByUser String
    | SignalsForNetworkLoaded (Result ApiError B.NetworkSignalsListRes)
    | DescriptionDeleteClickedByUser B.NetworkDescription
    | DescriptionEditClickedByUser B.NetworkDescription
    | DescriptionEditSave B.NetworkDescription
    | DescriptionEditUpdated Int (Result ApiError B.Network)
    | DescriptionDeleted (Result ApiError B.Network)
    | AddConfirmationFreqSelMsg (Select.Msg String)
    | ReportModalOpenedByUser
    | ReportModalClosedByUser
    | ReportDownloadClickedByUser
    | ReportDownloadReturnedByApi (Result ApiError Bytes)
    | ReportNetworksOnlyCheckedByUser Bool
    | ReportActiveFreqsOnlyCheckedByUser Bool
    | ReportIncludePelengsMapCheckedByUser Bool
    | ReportIncludeConfirmationCheckedByUser Bool
    | ReportIncludeSigintSignsCheckedByUser Bool
    | FreqsActivityFilterChangedByUser FreqActivityFilter
    | SetFreqsTableState Table.State
    | SetCallsignsTableState Table.State
    | NetworkCallsignsReturnedByApi (Result ApiError B.ListNetworkCallsignsRes)
    | SetNetworkCallsignsTableState Table.State
    | NetworkCallsignsPagerMsg Pager.Msg
    | CallsignsPagerMsg Pager.Msg
    | OpenFreqEditSidebar String B.UpdateNetworkFreqReq
    | CloseFreqEditSidebar
    | UpdateFreqEditSidebar B.UpdateNetworkFreqReq
    | SaveFreqEditSidebar
    | OpenFreqDetailPopup String
    | CloseFreqDetailPopup
    | ModulationsReturnedByApi (Result ApiError (List B.ModulationRec))
    | GotSources (Result ApiError B.ListSourcesRsp)
    | FreqKindSelectMsg (Select.Msg NetworksUtils.NetworkKind)
    | FreqModulationSelectMsg (Select.Msg Int)
    | ToggleFreqEditShowActiveTo
    | DeleteNetworkClickedByUser
    | DeleteNetworkConfirmedByUser
    | DeleteNetworkCanceledByUser
    | DeleteNetworkReturnedByApi (Result ApiError B.Network)
      -- Frequency creation messages
    | OpenFreqCreateSidebar
    | CloseFreqCreateSidebar
    | UpdateFreqCreateField (B.AddNetworkFreq -> B.AddNetworkFreq)
    | FreqCreateKindSelectMsg (Select.Msg NetworksUtils.NetworkKind)
    | FreqCreateModulationSelectMsg (Select.Msg Int)
    | FreqCreateDescriptionInputChangedByUser String
    | ToggleFreqCreateShowActiveTo
    | AddFreqToNetwork
    | FreqAddedToNetwork (Result ApiError B.Network)
    | DeleteFreqClickedByUser Int String
    | DeleteFreqConfirmedByUser
    | DeleteFreqCanceledByUser
    | DeleteFreqReturnedByApi (Result ApiError B.Network)
      -- Network callsign creation messages
    | OpenCallsignCreateSidebar
    | CloseCallsignCreateSidebar
    | UpdateCallsignCreateField (Maybe B.CreateNetworkCallsignReq -> Maybe B.CreateNetworkCallsignReq)
    | CreateCallsignClicked
    | CallsignCreated (Result ApiError B.NetworkCallsign)
    | CallsignCreateSourceSelMsg (Select.Msg Int)
    | CallsignCreateUnitSelMsg (Select.Msg Int)
    | ToggleCallsignCreateUnitSelector -- Показати/сховати селект підрозділів для створення
    | ResetCallsignCreateUnit -- Повернути підрозділ мережі для створення
      -- Callsign adding functionality
    | AddCallsignToNetwork Int -- Додавання позивного до мережі
    | CallsignAddedToNetwork (Result ApiError (List B.NetworkCallsign)) -- Результат додавання позивного
    | CallsignsSearchChanged String -- Зміна пошукового запиту для таблиці "Всі позивні"
    | NetworkCallsignsSearchChanged String -- Зміна пошукового запиту для таблиці "Позивні мережі"
      -- Callsign deletion functionality
    | DeleteCallsignFromNetwork Int -- Клік по кнопці видалення позивного з мережі
    | EditCallsignClicked Int -- Клік по кнопці редагування позивного з мережі
    | CloseEditCallsignSidebar -- Закриття сайдбару редагування
      -- Developing callsigns dropdown
    | ToggleDevelopingCallsignDropdown Int -- Відкрити/закрити dropdown для позивного
    | CloseDevelopingCallsignDropdown -- Закрити всі dropdown
    | NavigateToCallsignPage Int -- Перейти на сторінку позивного
      -- Unknown callsigns dropdown
    | ToggleUnknownCallsignDropdown String -- Відкрити/закрити dropdown для невідомого позивного
    | CloseUnknownCallsignDropdown -- Закрити всі dropdown для невідомих позивних
    | UpdateEditCallsignField (Maybe B.UpdateNetworkCallsignReq -> Maybe B.UpdateNetworkCallsignReq) -- Оновлення полів форми редагування
    | SaveEditCallsignClicked -- Збереження змін редагування
    | CallsignUpdated (Result ApiError B.NetworkCallsign) -- Результат оновлення позивного
    | EditCallsignSourceSelMsg (Select.Msg Int) -- Повідомлення від селекта джерела для редагування
    | EditCallsignUnitSelMsg (Select.Msg Int) -- Повідомлення від селекта підрозділу для редагування
    | ToggleEditCallsignUnitSelector -- Показати/сховати селект підрозділів для редагування
    | ResetEditCallsignUnit -- Повернути підрозділ мережі для редагування
    | OpenAddFromUnknownSidebar String -- Відкриття сайдбару додавання зі списку "Приналежність встановлюється"
    | DeleteCallsignConfirmed Int -- Підтвердження видалення позивного
    | DeleteCallsignCanceled -- Скасування видалення позивного
    | CallsignDeletedFromNetwork (Result ApiError B.NetworkCallsign) -- Результат видалення позивного
    | RowShowAllPopupChanged (Maybe ( Int, ShowAllPopupFor )) -- Зміна статусу popup для показу повного коментаря
      -- Sidebar management for creating descriptions
    | OpenConfirmationCreateSidebar
    | CloseConfirmationCreateSidebar
    | OpenSignsCreateSidebar
    | CloseSignsCreateSidebar
      -- Sidebar management for editing descriptions
    | OpenEditDescriptionSidebar B.NetworkDescription
    | CloseEditDescriptionSidebar
      -- Input field management for editing descriptions
    | EditDescriptionInputChanged String
    | EditDescriptionFreqSelMsg (Select.Msg String)
      -- Delete confirmation dialog management
    | DeleteDescriptionConfirmed B.NetworkDescription
    | DeleteDescriptionCanceled
