module Pages_.RerNetworks.Id_.Msg exposing (..)

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
import Pages_.RerNetworks.Id_.Model as Types exposing (CallsignCreateMode(..), CallsignTableRow, FreqActivityFilter(..), Mode(..), ShowAllPopupFor(..))
import Pages_.RerNetworks.ReportConfig as ReportConfig
import Shared.Components.DateTime
import Route exposing (Route)
import Route.Path
import Select
import Set exposing (Set)
import Shared
import Shared.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Shared.Components.Button as Button
import Shared.Components.Checkbox as Checkbox
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


type
    Msg
    -- =============================================================================
    -- NETWORK
    -- =============================================================================
    = NetworkReturnedByApi (Result ApiError B.Network)
    | MapPointsReturnedByApi (Result ApiError B.ListNetworkPointsRsp)
    | GroupsActivityReturnedByApi (Result ApiError GroupsByDate)
    | NetworkUpdatedByApi (Result ApiError B.Network)
    | NetworkPostsUpdatedByApi B.UpdateNetworkReq (Result ApiError B.Network)
    | NetworkUnitsUpdatedByApi B.UpdateNetworkReq (Result ApiError B.Network)
    | AorListReturnedByApi (Result ApiError (List B.AreaOfResponsibility))
    | SignalsForNetworkLoaded (Result ApiError B.NetworkSignalsListRes)
    | DeleteNetworkReturnedByApi (Result ApiError B.Network)
    | NetworkEditStartedByUser
    | NetworkEditingSavedByUser
    | NetworkEditingCanceledByUser
    | NetworkEditingMsg B.UpdateNetworkReq
    | EditNetworkKindSelMsg (Select.Msg NetworksUtils.NetworkKind)
    | NetworkEditPostsSelMsg (Select.Msg Int)
    | NetworkEditUnitsSelMsg (Select.Msg Int)
    | NetworkEditAorSelMsg (Select.Msg Int)
    | DeleteNetworkClickedByUser
    | DeleteNetworkConfirmedByUser
    | DeleteNetworkCanceledByUser
      -- =============================================================================
      -- CALLSIGNS
      -- =============================================================================
    | Callsigns CallsignsMsg
      -- =============================================================================
      -- FREQUENCIES
      -- =============================================================================
    | Frequencies FrequenciesMsg
    | ModulationsReturnedByApi (Result ApiError (List B.ModulationRec))
      -- =============================================================================
      -- KEYS
      -- =============================================================================
    | Keys KeysMsg
      -- =============================================================================
      -- DESCRIPTIONS
      -- =============================================================================
    | Descriptions DescriptionsMsg
      -- =============================================================================
      -- UI
      -- =============================================================================
    | ReportModalOpenedByUser
    | ReportModalClosedByUser
    | ReportDownloadClickedByUser
    | ReportDownloadReturnedByApi (Result ApiError Bytes)
    | ReportTypeChanged ReportConfig.ReportTypeOption
    | ReportActiveFreqsOnlyChanged Bool
    | ReportIncludeSigintSignsChanged Bool
    | ReportIncludeConfirmationChanged Bool
    | ReportIncludeUnitCallsignsChanged Bool
    | ReportIncludePelengsMapChanged Bool
    | ReportDateTimeFromMsg (Shared.Components.DateTime.Msg Msg)
    | ReportDateTimeToMsg (Shared.Components.DateTime.Msg Msg)


type CallsignsMsg
    = CallsignsReturnedByApi (Result ApiError B.SingleNetworkCallsignsListRsp)
    | CallsignsActivityReturnedByApi (Result ApiError B.NetworkCallsignsActivityRsp)
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
    | ToggleUnknownCallsignsMessages
    | ToggleUnknownCallsignsSortByMessages
    | SetCallsignsTableState Table.State
    | SetNetworkCallsignsTableState Table.State
    | NetworkCallsignsPagerMsg Pager.Msg
    | CallsignsPagerMsg Pager.Msg
    | CallsignsSearchChanged String -- Зміна пошукового запиту для таблиці "Всі позивні"
    | NetworkCallsignsSearchChanged String -- Зміна пошукового запиту для таблиці "Позивні мережі"
    | RowShowAllPopupChanged (Maybe ( Int, ShowAllPopupFor )) -- Зміна статусу popup для показу повного коментаря


type DescriptionsMsg
    = NetworkDescriptionAdded B.NetworkDescrType (Result ApiError B.Network)
    | DescriptionEditUpdated Int (Result ApiError B.Network)
    | DescriptionDeleted (Result ApiError B.Network)
    | DescriptionAddClickedByUser Int B.NetworkDescrType
    | ConfirmationInputChangedByUser String
    | SignsInputChangedByUser String
    | AddConfirmationFreqSelMsg (Select.Msg String)
    | DescriptionEditClickedByUser B.NetworkDescription
    | DescriptionEditSave B.NetworkDescription
    | EditDescriptionInputChanged String
    | EditDescriptionFreqSelMsg (Select.Msg Int)
    | DescriptionDeleteClickedByUser B.NetworkDescription
    | DeleteDescriptionConfirmed B.NetworkDescription
    | DeleteDescriptionCanceled
    | OpenConfirmationCreateSidebar
    | CloseConfirmationCreateSidebar
    | OpenSignsCreateSidebar
    | CloseSignsCreateSidebar
    | OpenEditDescriptionSidebar B.NetworkDescription
    | CloseEditDescriptionSidebar


type FrequenciesMsg
    = FreqsReturnedByApi (Result ApiError B.SingleNetworkFreqsListRsp)
    | FreqUpdatedByApi (Result ApiError B.Network)
    | FreqAddedToNetwork (Result ApiError B.Network)
    | DeleteFreqReturnedByApi Int (Result ApiError B.Network)
    | FreqsEditingMsg B.UpdateNetworkFreqReq
    | FreqsEditStartedByUser
    | FreqsEditSavedByUser
    | FreqsEditCanceledByUser
    | OpenFreqEditSidebar Int String B.UpdateNetworkFreqReq
    | ReactivateFreqClicked
    | FreqReactivatedByApi (Result ApiError B.Network)
    | CloseFreqEditSidebar
    | UpdateFreqEditSidebar B.UpdateNetworkFreqReq
    | SaveFreqEditSidebar
    | FreqKindSelectMsg (Select.Msg NetworksUtils.NetworkKind)
    | FreqModulationSelectMsg (Select.Msg Int)
    | FreqKeySelectMsg (Select.Msg Int)
    | ToggleFreqEditShowActiveTo
    | OpenFreqCreateSidebar
    | CloseFreqCreateSidebar
    | UpdateFreqCreateField (B.AddNetworkFreq -> B.AddNetworkFreq)
    | FreqCreateKindSelectMsg (Select.Msg NetworksUtils.NetworkKind)
    | FreqCreateModulationSelectMsg (Select.Msg Int)
    | FreqCreateKeySelectMsg (Select.Msg Int)
    | FreqCreateDescriptionInputChangedByUser String
    | FreqCreateNewKeyInputChanged String
    | FreqCreateNewKeyClicked
    | FreqCreateNewKeyCreated (Result ApiError B.EncryptionKeyData)
    | ToggleFreqCreateShowActiveTo
    | AddFreqToNetwork
    | DeleteFreqClickedByUser Int String
    | DeleteFreqConfirmedByUser
    | DeleteFreqCanceledByUser
    | OpenFreqDetailPopup String
    | CloseFreqDetailPopup
    | FreqEditNewKeyInputChanged String
    | FreqEditNewKeyClicked
    | FreqEditNewKeyCreated (Result ApiError B.EncryptionKeyData)
    | FreqsActivityFilterChangedByUser FreqActivityFilter
    | SetFreqsTableState Table.State
    | CallsignsPopupOpenedByUser Int
    | CallsignsPopupClosedByUser
    | NetworkFreqCallsignsReturnedByApi (Result ApiError B.NetworkFreqCallsignsRsp)
    | NetworkFreqsActivityReturnedByApi (Result ApiError (Dict String (Dict String Int)))


type KeysMsg
    = KeysReturnedByApi (Result ApiError B.ListKeysRsp)
    | SetKeysTableState Table.State
    | OpenKeyCreateSidebar
    | CloseKeyCreateSidebar
    | KeyCreateKeyChanged String
    | KeyCreateHashChanged String
    | KeyCreateDescriptionChanged String
    | KeyCreateFreqSelMsg (Select.Msg Int)
    | KeyCreateModulationSelMsg (Select.Msg Int)
    | CreateKeyClicked
    | KeyCreated (Result ApiError B.EncryptionKeyData)
    | OpenKeyEditSidebar B.EncryptionKeyData
    | CloseKeyEditSidebar
    | KeyEditKeyChanged String
    | KeyEditHashChanged String
    | KeyEditDescriptionChanged String
    | KeyEditFreqSelMsg (Select.Msg Int)
    | KeyEditModulationSelMsg (Select.Msg Int)
    | SaveKeyEditClicked
    | KeyUpdated (Result ApiError B.EncryptionKeyData)
    | DeleteKeyClickedByUser Int String
    | DeleteKeyConfirmedByUser
    | DeleteKeyCanceledByUser
    | DeleteKeyReturnedByApi (Result ApiError B.EncryptionKeyData)
