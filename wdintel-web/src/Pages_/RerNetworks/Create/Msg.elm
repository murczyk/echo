module Pages_.RerNetworks.Create.Msg exposing (..)

import Bindings as B
import Core.Types exposing (ApiError)
import Dict exposing (Dict)
import Pages_.RerNetworks.Create.Model exposing (FreqActivityFilter, ShowAllPopupFor)
import Select
import Shared.Components.Pager as Pager
import Shared.Components.Table as Table
import Utils.NetworksUtils as NetworksUtils


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
    | EncryptionsReturnedByApi (Result ApiError (List B.EncryptionRec))
    | Callsigns CallsignsMsg
    | NavigateToIdPage
    | NetworkDeleted (Result ApiError B.Network)


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
    | CallsignsPopupOpenedByUser Int
    | CallsignsPopupClosedByUser
    | NetworkFreqCallsignsReturnedByApi (Result ApiError B.NetworkFreqCallsignsRsp)
    | NetworkFreqsActivityReturnedByApi (Result ApiError (Dict String (Dict String Int)))
