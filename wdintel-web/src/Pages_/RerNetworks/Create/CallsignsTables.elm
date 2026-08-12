module Pages_.RerNetworks.Create.CallsignsTables exposing
    ( createCallsignsSidebar
    , deleteCallsignModal
    , editCallsignsSidebar
    , initLoad
    , loadCatalogAndNetworkCallsigns
    , loadCatalogCallsigns
    , update
    , view
    )

import Api
import Auth
import Bindings as B
import Core.Auth
import Dict
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Styled as Styled
import List.Extra as ListX
import Pages_.RerNetworks.Create.Model exposing (CallsignCreateMode(..), CallsignTableRow, Model, ShowAllPopupFor(..))
import Pages_.RerNetworks.Create.Msg exposing (CallsignsMsg(..))
import Pages_.RerNetworks.Utils as NetworkUtils
import Select
import Set
import Shared
import Shared.Components.Button as Button
import Shared.Components.Checkbox as Checkbox
import Shared.Components.DropdownBadge as DropdownBadge
import Shared.Components.ModalDialog as ModalDialog
import Shared.Components.Pager as Pager
import Shared.Components.Popup as Popup
import Shared.Components.Sidebar as Sidebar
import Shared.Components.Spinner
import Shared.Components.SegmentedControl as SegmentedControl
import Shared.Components.Table as Table
import Shared.Components.Table.Column as TableColumn
import Shared.Components.Table.Config as TableConfig
import Shared.Components.Table.Sorter as TableSorter
import Shared.Model exposing (isDarkMode)
import Time
import Utils.Api.ErrorHandling
import Utils.RemoteData exposing (RemoteData(..))
import Utils.Select
import Utils.Time


initLoad : Effect CallsignsMsg
initLoad =
    E.sendCmd (Api.sigint_list_sources GotSources ())


loadCallsignsActivity : Int -> List String -> Effect CallsignsMsg
loadCallsignsActivity networkId callsigns =
    let
        selectedCallsigns =
            callsigns
                |> List.filter (\callsign -> String.trim callsign /= "")
                |> ListX.unique
    in
    if List.isEmpty selectedCallsigns then
        E.none

    else
        E.getNetworkCallsignsActivity CallsignsActivityReturnedByApi
            { networkId = networkId
            , callsigns = selectedCallsigns
            }


knownCallsignActivityCallsigns : List B.NetworkCallsignRes -> List String
knownCallsignActivityCallsigns callsigns =
    callsigns
        |> List.filterMap
            (\callsign ->
                case callsign.knownCallsigns of
                    Just knownCallsigns ->
                        if List.isEmpty knownCallsigns then
                            Nothing

                        else
                            Just callsign.callsign

                    Nothing ->
                        Nothing
            )


unknownCallsignActivityCallsigns : List B.NetworkCallsignRes -> List String
unknownCallsignActivityCallsigns callsigns =
    callsigns
        |> List.filterMap
            (\callsign ->
                case callsign.knownCallsigns of
                    Just knownCallsigns ->
                        if List.isEmpty knownCallsigns then
                            Just callsign.callsign

                        else
                            Nothing

                    Nothing ->
                        Just callsign.callsign
            )


loadUnknownCallsignsActivity : Model -> Effect CallsignsMsg
loadUnknownCallsignsActivity model =
    case ( model.networkCreated, model.callsigns ) of
        ( Just network, Success callsigns ) ->
            loadCallsignsActivity network.id (unknownCallsignActivityCallsigns callsigns)

        _ ->
            E.none


loadUnknownCallsignsActivityForCallsigns : Model -> List B.NetworkCallsignRes -> Effect CallsignsMsg
loadUnknownCallsignsActivityForCallsigns model callsigns =
    case model.networkCreated of
        Just network ->
            loadCallsignsActivity network.id (unknownCallsignActivityCallsigns callsigns)

        Nothing ->
            E.none


applyCallsignsActivity : B.NetworkCallsignsActivityRsp -> List B.NetworkCallsignRes -> List B.NetworkCallsignRes
applyCallsignsActivity rsp callsigns =
    let
        activityByCallsign =
            rsp.callsignsActivity
                |> List.foldl
                    (\row dict -> Dict.insert row.callsign row.activity dict)
                    Dict.empty
    in
    List.map
        (\callsign ->
            case Dict.get callsign.callsign activityByCallsign of
                Just activity ->
                    { callsign
                        | messageCount = activity.messageCount
                        , lastDatetime = activity.lastDatetime
                        , freqs = activity.freqs
                    }

                Nothing ->
                    callsign
        )
        callsigns


type MarkerSelection
    = MainRadioStation
    | CommandControl
    | NoMarker


markerSelectionFromState : { a | mainRadioStation : Bool, commandControl : Bool } -> MarkerSelection
markerSelectionFromState state =
    if state.mainRadioStation then
        MainRadioStation

    else if state.commandControl then
        CommandControl

    else
        NoMarker


applyMarkerSelection : MarkerSelection -> { a | mainRadioStation : Bool, commandControl : Bool } -> { a | mainRadioStation : Bool, commandControl : Bool }
applyMarkerSelection markerSelection state =
    case markerSelection of
        MainRadioStation ->
            { state | mainRadioStation = True, commandControl = False }

        CommandControl ->
            { state | mainRadioStation = False, commandControl = True }

        NoMarker ->
            { state | mainRadioStation = False, commandControl = False }


loadCatalogAndNetworkCallsigns : Int -> List (Effect CallsignsMsg)
loadCatalogAndNetworkCallsigns networkId =
    [ loadCatalogCallsigns networkId
    , E.getNetworkCallsignsList NetworkCallsignsReturnedByApi { networkId = networkId, sortBy = Nothing }
    ]


loadCatalogCallsigns : Int -> Effect CallsignsMsg
loadCatalogCallsigns networkId =
    E.getNetworkCallsigns CallsignsReturnedByApi
        { networkId = networkId
        , includeActivityInfo = Just False
        , section = Just B.Everything
        }


update : Shared.Model -> CallsignsMsg -> Model -> ( Model, Effect CallsignsMsg )
update _ msg model =
    case msg of
        CallsignsReturnedByApi (Err e) ->
            ( { model | callsigns = Failure e }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження позивних" e
            )

        CallsignsReturnedByApi (Ok res) ->
            let
                -- Обчислюємо загальну кількість позивних для пагінації
                totalCallsigns =
                    res.callsigns
                        |> List.concatMap
                            (\callsign ->
                                case callsign.knownCallsigns of
                                    Just knownCallsigns ->
                                        knownCallsigns

                                    Nothing ->
                                        []
                            )
                        |> List.length

                updatedPager =
                    Pager.updateForNewTotalItems totalCallsigns model.callsignsPager

                knownActivityEffect =
                    case model.networkCreated of
                        Just network ->
                            loadCallsignsActivity network.id (knownCallsignActivityCallsigns res.callsigns)

                        Nothing ->
                            E.none
            in
            ( { model
                | callsigns = Success res.callsigns
                , callsignsPager = updatedPager
              }
            , E.batch
                [ knownActivityEffect
                , if model.unknownCallsignsShowMessages then
                    loadUnknownCallsignsActivityForCallsigns model res.callsigns

                  else
                    E.none
                ]
            )

        CallsignsActivityReturnedByApi (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження активності позивних" e
            )

        CallsignsActivityReturnedByApi (Ok rsp) ->
            ( { model
                | callsigns =
                    case model.callsigns of
                        Success callsigns ->
                            Success (applyCallsignsActivity rsp callsigns)

                        NeedsReload callsigns ->
                            NeedsReload (applyCallsignsActivity rsp callsigns)

                        _ ->
                            model.callsigns
              }
            , E.none
            )

        SetCallsignsTableState newState ->
            ( { model | callsignsTableState = newState }, E.none )

        NetworkCallsignsReturnedByApi (Err e) ->
            ( { model | networkCallsigns = Failure e }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження позивних мережі" e
            )

        NetworkCallsignsReturnedByApi (Ok res) ->
            ( { model
                | networkCallsigns = Success res.networkCallsigns
                , networkCallsignsPager = Pager.updateForNewTotalItems (List.length (getRegularCallsigns res.networkCallsigns)) (Pager.initWithPageSize 5)
              }
            , E.none
            )

        SetNetworkCallsignsTableState newState ->
            ( { model | networkCallsignsTableState = newState }, E.none )

        NetworkCallsignsPagerMsg pagerMsg ->
            let
                updatedPager =
                    Pager.update pagerMsg model.networkCallsignsPager

                -- Якщо змінюється розмір сторінки, перевіряємо поточну сторінку
                finalPager =
                    case pagerMsg of
                        Pager.ChangePageSize newPageSize ->
                            Pager.updateForNewTotalItems updatedPager.totalItems { updatedPager | pageSize = newPageSize }

                        _ ->
                            updatedPager
            in
            ( { model | networkCallsignsPager = finalPager }, E.none )

        CallsignsPagerMsg pagerMsg ->
            let
                updatedPager =
                    Pager.update pagerMsg model.callsignsPager

                -- Якщо змінюється розмір сторінки, перевіряємо поточну сторінку
                finalPager =
                    case pagerMsg of
                        Pager.ChangePageSize newPageSize ->
                            Pager.updateForNewTotalItems updatedPager.totalItems { updatedPager | pageSize = newPageSize }

                        _ ->
                            updatedPager
            in
            ( { model | callsignsPager = finalPager }, E.none )

        GotSources (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження джерел" err
            )

        GotSources (Ok rsp) ->
            ( { model | callsignCreateSources = rsp.sources }
            , E.none
            )

        -- Network callsign creation messages
        OpenCallsignCreateSidebar ->
            case model.networkCreated of
                Just network ->
                    let
                        updatedState =
                            { networkId = network.id
                            , callsign = ""
                            , fullName = Nothing
                            , position = Nothing
                            , comment = Nothing
                            , sourceId = Nothing -- No default source ID
                            , radioFreq = Nothing
                            , developing = False
                            , unitId =
                                -- Автоматично встановлюємо перший підрозділ мережі
                                case model.editUnitsSelect.selected of
                                    firstUnitId :: _ ->
                                        Just firstUnitId

                                    [] ->
                                        Nothing
                            , unitDeveloping = False
                            , mainRadioStation = False
                            , commandControl = False
                            }
                    in
                    ( { model
                        | callsignCreateSidebar = Just CreateFromScratch
                        , callsignCreateState = Just updatedState
                        , callsignCreateErrors = Dict.empty
                      }
                    , E.none
                    )

                _ ->
                    ( model, E.none )

        CloseCallsignCreateSidebar ->
            ( { model
                | callsignCreateSidebar = Nothing
                , callsignCreateState = Nothing
                , callsignCreateErrors = Dict.empty
                , callsignCreateSourceSelState = Select.initState (Select.selectIdentifier "callsign-create-source-state")
              }
            , E.none
            )

        UpdateCallsignCreateField updateFunc ->
            ( { model | callsignCreateState = updateFunc model.callsignCreateState }
            , E.none
            )

        CreateCallsignClicked ->
            case model.callsignCreateState of
                Just createReq ->
                    ( { model | callsignCreateSaving = True }
                    , E.createNetworkCallsign CallsignCreated createReq
                    )

                Nothing ->
                    ( model, E.none )

        CallsignCreated (Ok networkCallsign) ->
            let
                -- Отримуємо callsign з створеного позивного
                createdCallsign =
                    networkCallsign.callsign

                -- Оновлюємо список "Приналежність встановлюється" - видаляємо створений позивний
                updatedCallsigns =
                    case model.callsigns of
                        Success existingCallsigns ->
                            existingCallsigns
                                |> List.filter (\callsignGroup -> callsignGroup.callsign /= createdCallsign)
                                |> Success

                        _ ->
                            model.callsigns

                -- Оновлюємо список позивних мережі
                updatedNetworkCallsigns =
                    case model.networkCallsigns of
                        Success existingCallsigns ->
                            Success (networkCallsign :: existingCallsigns)

                        _ ->
                            Success [ networkCallsign ]

                -- Оновлюємо пагінацію
                updatedPager =
                    case updatedNetworkCallsigns of
                        Success callsigns ->
                            Pager.updateForNewTotalItems (List.length callsigns) model.networkCallsignsPager

                        _ ->
                            model.networkCallsignsPager
            in
            ( { model
                | callsignCreateSaving = False
                , callsignCreateSidebar = Nothing
                , callsignCreateState = Nothing
                , callsignCreateErrors = Dict.empty
                , callsignCreateSourceSelState = Select.initState (Select.selectIdentifier "callsign-create-source-state")
                , networkCallsigns = updatedNetworkCallsigns
                , networkCallsignsPager = updatedPager
                , callsigns = updatedCallsigns
              }
            , E.none
            )

        CallsignCreated (Err error) ->
            ( { model
                | callsignCreateSaving = False
                , callsignCreateErrors = Dict.singleton "general" (Utils.Api.ErrorHandling.formatErrorForShowError "Помилка створення позивного" error)
              }
            , E.none
            )

        CallsignCreateSourceSelMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.callsignCreateSourceSelState

                updatedSourceId =
                    Utils.Select.singleUpd mAction (Maybe.andThen .sourceId model.callsignCreateState)
            in
            ( { model
                | callsignCreateSourceSelState = imodel2
                , callsignCreateState =
                    Maybe.map (\state -> { state | sourceId = updatedSourceId }) model.callsignCreateState
              }
            , E.sendCmd <| Cmd.map CallsignCreateSourceSelMsg icmd
            )

        CallsignCreateUnitSelMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.callsignCreateUnitSelState

                updatedUnitId =
                    Utils.Select.singleUpd mAction (Maybe.andThen .unitId model.callsignCreateState)

                -- Закриваємо селект тільки коли користувач дійсно вибрав підрозділ
                shouldCloseSelector =
                    case mAction of
                        Just (Select.Select _) ->
                            True

                        Just Select.Clear ->
                            True

                        _ ->
                            False
            in
            ( { model
                | callsignCreateUnitSelState = imodel2
                , callsignCreateUnitSelectorVisible =
                    if shouldCloseSelector then
                        False

                    else
                        model.callsignCreateUnitSelectorVisible
                , callsignCreateState =
                    Maybe.map (\state -> { state | unitId = updatedUnitId }) model.callsignCreateState
              }
            , E.sendCmd <| Cmd.map CallsignCreateUnitSelMsg icmd
            )

        ToggleCallsignCreateUnitSelector ->
            ( { model | callsignCreateUnitSelectorVisible = not model.callsignCreateUnitSelectorVisible }
            , E.none
            )

        ResetCallsignCreateUnit ->
            ( { model
                | callsignCreateUnitSelectorVisible = False
                , callsignCreateState =
                    Maybe.map
                        (\state ->
                            { state
                                | unitId =
                                    -- Повертаємо до першого підрозділу мережі
                                    case model.editUnitsSelect.selected of
                                        firstUnitId :: _ ->
                                            Just firstUnitId

                                        [] ->
                                            Nothing
                            }
                        )
                        model.callsignCreateState
              }
            , E.none
            )

        AddCallsignToNetwork knownCallsignId ->
            -- Перевіряємо, чи не додається вже цей позивний
            if Set.member knownCallsignId model.callsignAddingInProgress then
                ( model, E.none )

            else
                case model.networkCreated of
                    Just network ->
                        let
                            payload =
                                { networkId = network.id
                                , knownCallsignIds = [ knownCallsignId ]
                                }
                        in
                        ( { model | callsignAddingInProgress = Set.insert knownCallsignId model.callsignAddingInProgress }
                        , E.addMultipleCallsignsToNetwork CallsignAddedToNetwork payload
                        )

                    _ ->
                        ( model, E.none )

        CallsignAddedToNetwork (Err e) ->
            ( { model | callsignAddingInProgress = Set.empty }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання позивного до мережі" e
            )

        CallsignAddedToNetwork (Ok networkCallsigns) ->
            let
                -- Оновлюємо networkCallsigns, додаючи нові
                updatedNetworkCallsigns =
                    case model.networkCallsigns of
                        Success existing ->
                            Success (existing ++ networkCallsigns)

                        _ ->
                            Success networkCallsigns

                -- Оновлюємо пагінацію для таблиці "Мережеві позивні"
                updatedPager =
                    case updatedNetworkCallsigns of
                        Success callsigns ->
                            Pager.updateForNewTotalItems (List.length callsigns) model.networkCallsignsPager

                        _ ->
                            model.networkCallsignsPager

                -- Оновлюємо модель
                updatedModel =
                    { model
                        | networkCallsigns = updatedNetworkCallsigns
                        , networkCallsignsPager = updatedPager
                        , callsignAddingInProgress = Set.empty
                    }

                -- Перезавантажуємо тільки таблицю "Всі позивні" для прибирання доданих позивних
                reloadEffect =
                    case model.networkCreated of
                        Just network ->
                            loadCatalogCallsigns network.id

                        _ ->
                            E.none
            in
            ( updatedModel, reloadEffect )

        DeleteCallsignFromNetwork callsignId ->
            ( { model | deleteCallsignConfirmation = Just callsignId, developingCallsignDropdown = Nothing }, E.none )

        EditCallsignClicked callsignId ->
            case ( model.networkCallsigns, model.networkCreated ) of
                ( Success networkCallsigns, Just network ) ->
                    case ListX.find (\c -> c.id == callsignId) networkCallsigns of
                        Just callsign ->
                            let
                                editState =
                                    { id = callsign.id
                                    , networkId =
                                        network.id
                                    , callsign = String.toUpper callsign.callsign
                                    , fullName = callsign.fullName
                                    , position = callsign.position
                                    , comment = callsign.comment
                                    , sourceId = callsign.sourceId
                                    , radioFreq = callsign.radioFreq -- Тепер це окреме поле
                                    , developing = callsign.developing
                                    , unitId = callsign.unitId
                                    , unitDeveloping = callsign.unitDeveloping
                                    , mainRadioStation = callsign.mainRadioStation
                                    , commandControl = callsign.commandControl
                                    }
                            in
                            ( { model
                                | editCallsignSidebar = Just callsignId
                                , editCallsignState = Just editState
                                , editCallsignErrors = Dict.empty
                                , editCallsignSourceSelState = Select.initState (Select.selectIdentifier "callsign-edit-source-state")
                                , developingCallsignDropdown = Nothing -- Закриваємо dropdown
                              }
                            , E.none
                            )

                        Nothing ->
                            ( model, E.none )

                _ ->
                    ( model, E.none )

        ToggleDevelopingCallsignDropdown callsignId ->
            let
                newDropdown =
                    if model.developingCallsignDropdown == Just callsignId then
                        Nothing

                    else
                        Just callsignId
            in
            ( { model | developingCallsignDropdown = newDropdown }, E.none )

        CloseDevelopingCallsignDropdown ->
            ( { model | developingCallsignDropdown = Nothing }, E.none )

        NavigateToCallsignPage _ ->
            ( { model | developingCallsignDropdown = Nothing }, E.none )

        ToggleUnknownCallsignDropdown callsign ->
            let
                newDropdown =
                    if model.unknownCallsignDropdown == Just callsign then
                        Nothing

                    else
                        Just callsign
            in
            ( { model | unknownCallsignDropdown = newDropdown }, E.none )

        CloseUnknownCallsignDropdown ->
            ( { model | unknownCallsignDropdown = Nothing }, E.none )

        ToggleUnknownCallsignsMessages ->
            let
                showMessages =
                    not model.unknownCallsignsShowMessages
            in
            ( { model
                | unknownCallsignsShowMessages = showMessages
                , unknownCallsignsSortByMessages =
                    if model.unknownCallsignsShowMessages then
                        model.unknownCallsignsSortByMessages

                    else
                        False
              }
            , if showMessages then
                loadUnknownCallsignsActivity model

              else
                E.none
            )

        ToggleUnknownCallsignsSortByMessages ->
            ( { model
                | unknownCallsignsSortByMessages = not model.unknownCallsignsSortByMessages
              }
            , E.none
            )

        DeleteCallsignConfirmed callsignId ->
            ( { model | deleteCallsignLoading = True, deleteCallsignConfirmation = Nothing }
            , E.deleteNetworkCallsign CallsignDeletedFromNetwork callsignId
            )

        DeleteCallsignCanceled ->
            ( { model | deleteCallsignConfirmation = Nothing }, E.none )

        CallsignDeletedFromNetwork (Ok deletedCallsign) ->
            let
                -- Видаляємо позивний зі списку networkCallsigns
                updatedNetworkCallsigns =
                    case model.networkCallsigns of
                        Success existingCallsigns ->
                            Success (List.filter (\c -> c.id /= deletedCallsign.id) existingCallsigns)

                        _ ->
                            model.networkCallsigns

                -- Оновлюємо пагінацію та перевіряємо поточну сторінку
                updatedPager =
                    case updatedNetworkCallsigns of
                        Success callsigns ->
                            Pager.updateForNewTotalItems (List.length callsigns) model.networkCallsignsPager

                        _ ->
                            model.networkCallsignsPager

                -- Перезавантажуємо тільки таблицю "Всі позивні" для додавання видаленого позивного назад
                reloadEffect =
                    case model.networkCreated of
                        Just network ->
                            loadCatalogCallsigns network.id

                        _ ->
                            E.none
            in
            ( { model
                | deleteCallsignLoading = False
                , networkCallsigns = updatedNetworkCallsigns
                , networkCallsignsPager = updatedPager
              }
            , reloadEffect
            )

        CallsignDeletedFromNetwork (Err error) ->
            ( { model | deleteCallsignLoading = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення позивного з мережі" error
            )

        -- Edit callsign handlers
        CloseEditCallsignSidebar ->
            ( { model
                | editCallsignSidebar = Nothing
                , editCallsignState = Nothing
                , editCallsignErrors = Dict.empty
                , editCallsignSourceSelState = Select.initState (Select.selectIdentifier "callsign-edit-source-state")
              }
            , E.none
            )

        UpdateEditCallsignField updateFunc ->
            ( { model | editCallsignState = updateFunc model.editCallsignState }
            , E.none
            )

        SaveEditCallsignClicked ->
            case model.editCallsignState of
                Just updateReq ->
                    ( { model | editCallsignSaving = True }
                    , E.updateNetworkCallsign CallsignUpdated updateReq
                    )

                Nothing ->
                    ( model, E.none )

        CallsignUpdated (Ok updatedCallsign) ->
            let
                -- Update the callsign in networkCallsigns list
                updatedNetworkCallsigns =
                    case model.networkCallsigns of
                        Success existingCallsigns ->
                            Success
                                (List.map
                                    (\c ->
                                        if c.id == updatedCallsign.id then
                                            updatedCallsign

                                        else
                                            c
                                    )
                                    existingCallsigns
                                )

                        _ ->
                            model.networkCallsigns
            in
            ( { model
                | editCallsignSaving = False
                , editCallsignSidebar = Nothing
                , editCallsignState = Nothing
                , editCallsignErrors = Dict.empty
                , networkCallsigns = updatedNetworkCallsigns
              }
            , E.none
            )

        CallsignUpdated (Err error) ->
            ( { model
                | editCallsignSaving = False
                , editCallsignErrors = Dict.singleton "general" (Utils.Api.ErrorHandling.formatErrorForShowError "Помилка оновлення позивного" error)
              }
            , E.none
            )

        EditCallsignSourceSelMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.editCallsignSourceSelState

                updatedSourceId =
                    Utils.Select.singleUpd mAction (Maybe.andThen .sourceId model.editCallsignState)
            in
            ( { model
                | editCallsignSourceSelState = imodel2
                , editCallsignState =
                    Maybe.map (\state -> { state | sourceId = updatedSourceId }) model.editCallsignState
              }
            , E.sendCmd <| Cmd.map EditCallsignSourceSelMsg icmd
            )

        EditCallsignUnitSelMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.editCallsignUnitSelState

                updatedUnitId =
                    Utils.Select.singleUpd mAction (Maybe.andThen .unitId model.editCallsignState)

                -- Закриваємо селект тільки коли користувач дійсно вибрав підрозділ
                shouldCloseSelector =
                    case mAction of
                        Just (Select.Select _) ->
                            True

                        Just Select.Clear ->
                            True

                        _ ->
                            False
            in
            ( { model
                | editCallsignUnitSelState = imodel2
                , editCallsignUnitSelectorVisible =
                    if shouldCloseSelector then
                        False

                    else
                        model.editCallsignUnitSelectorVisible
                , editCallsignState =
                    Maybe.map (\state -> { state | unitId = updatedUnitId }) model.editCallsignState
              }
            , E.sendCmd <| Cmd.map EditCallsignUnitSelMsg icmd
            )

        ToggleEditCallsignUnitSelector ->
            ( { model | editCallsignUnitSelectorVisible = not model.editCallsignUnitSelectorVisible }
            , E.none
            )

        ResetEditCallsignUnit ->
            ( { model
                | editCallsignUnitSelectorVisible = False
                , editCallsignState =
                    Maybe.map
                        (\state ->
                            { state
                                | unitId =
                                    -- Повертаємо до першого підрозділу мережі
                                    case model.editUnitsSelect.selected of
                                        firstUnitId :: _ ->
                                            Just firstUnitId

                                        [] ->
                                            Nothing
                            }
                        )
                        model.editCallsignState
              }
            , E.none
            )

        OpenAddFromUnknownSidebar callsign ->
            case model.networkCreated of
                Just network ->
                    let
                        updatedState =
                            { networkId = network.id
                            , callsign = String.toUpper callsign
                            , fullName = Nothing
                            , position = Nothing
                            , comment = Nothing
                            , sourceId = Nothing -- No default source ID
                            , radioFreq = Nothing
                            , developing = False
                            , unitId =
                                -- Автоматично встановлюємо перший підрозділ мережі
                                case model.editUnitsSelect.selected of
                                    firstUnitId :: _ ->
                                        Just firstUnitId

                                    [] ->
                                        Nothing
                            , unitDeveloping = False
                            , mainRadioStation = False
                            , commandControl = False
                            }
                    in
                    ( { model
                        | callsignCreateSidebar = Just (CreateFromUnknown callsign)
                        , callsignCreateState = Just updatedState
                        , callsignCreateErrors = Dict.empty
                      }
                    , E.none
                    )

                _ ->
                    ( model, E.none )

        -- Search functionality
        CallsignsSearchChanged query ->
            ( { model | callsignsSearchQuery = query }, E.none )

        NetworkCallsignsSearchChanged query ->
            ( { model | networkCallsignsSearchQuery = query }, E.none )

        RowShowAllPopupChanged popupStatus ->
            ( { model | rowShowAllPopupStatus = popupStatus }
            , E.none
            )


getRegularCallsigns : List B.NetworkCallsign -> List B.NetworkCallsign
getRegularCallsigns callsigns =
    List.filter (\callsign -> not callsign.developing) callsigns


getDevelopingCallsigns : List B.NetworkCallsign -> List B.NetworkCallsign
getDevelopingCallsigns callsigns =
    List.filter (\callsign -> callsign.developing) callsigns


view : Model -> Auth.User -> Shared.Model -> Html CallsignsMsg
view model user shared =
    section [ class "bg-w dark:bg-[#1C1C21] w-full mt-[30px] p-[16px] flex flex-col" ]
        [ div [ class "mb-[8px] flex justify-between items-center" ]
            [ h4 [ class "" ] [ text "Позивні мережі" ]
            , if Core.Auth.hasRole "Admin" user || Core.Auth.hasRole "UnitsEditor" user then
                Button.new { label = "Створити", onClick = OpenCallsignCreateSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view

              else
                text ""
            ]
        , case model.networkCallsigns of
            Success networkCallsigns ->
                viewNetworkCallsigns networkCallsigns model user shared

            Loading ->
                Shared.Components.Spinner.loadingSpinnerSm

            Failure _ ->
                div [ class "text-red-500" ] [ text "Помилка завантаження позивних мережі" ]

            NotAsked ->
                text ""

            NeedsReload _ ->
                Shared.Components.Spinner.loadingSpinnerSm
        , case model.networkCallsigns of
            Success networkCallsigns ->
                let
                    -- Використовуємо helper функцію для фільтрації позивних що розвиваються
                    developingCallsigns =
                        getDevelopingCallsigns networkCallsigns
                in
                div [ class "p-3 bg-[var(--color-bg-muted)] rounded" ]
                    [ span [ class "font-medium" ] [ text "В дорозвідці: " ]
                    , if List.isEmpty developingCallsigns then
                        div [ class "text-[var(--color-text-muted)] text-sm mt-2" ]
                            [ text "Немає позивних в дорозвідці" ]

                      else
                        div [ class "flex flex-wrap gap-[4px] text-[13px] mt-2" ]
                            (List.map
                                (\callsign ->
                                    DropdownBadge.view
                                        (DropdownBadge.config
                                            (String.toUpper callsign.callsign)
                                            (model.developingCallsignDropdown == Just callsign.id)
                                            (ToggleDevelopingCallsignDropdown callsign.id)
                                            CloseDevelopingCallsignDropdown
                                            ([ DropdownBadge.InternalAction
                                                { icon = "bi-pencil"
                                                , label = "Редагувати"
                                                , action = EditCallsignClicked callsign.id
                                                }
                                             , DropdownBadge.InternalAction
                                                { icon = "bi-trash"
                                                , label = "Видалити"
                                                , action = DeleteCallsignFromNetwork callsign.id
                                                }
                                             ]
                                                ++ (case model.networkCreated of
                                                        Just network ->
                                                            [ DropdownBadge.ExternalLink
                                                                { icon = "bi-arrow-right"
                                                                , label = "Проаналізувати"
                                                                , url = NetworkUtils.createAnalysisUrl shared network callsign.callsign
                                                                }
                                                            ]

                                                        Nothing ->
                                                            []
                                                   )
                                            )
                                        )
                                )
                                developingCallsigns
                            )
                    ]

            _ ->
                text ""
        , div [ class "mb-[8px] flex justify-between items-center" ]
            [ h4 [ class "" ] [ text "Співпадіння з каталогом" ]
            ]
        , case model.callsigns of
            Success callsigns ->
                viewCallsigns callsigns model user shared

            _ ->
                Shared.Components.Spinner.loadingSpinnerSm
        ]


viewCallsigns : List B.NetworkCallsignRes -> Model -> Auth.User -> Shared.Model -> Html CallsignsMsg
viewCallsigns callsigns model user shared =
    div [ class "flex flex-col flex-1" ]
        [ div [ class "overflow-y-auto flex-1" ]
            [ let
                -- Перетворюємо дані у плоску структуру для таблиці
                allCallsignsTableRows =
                    callsigns
                        |> List.concatMap
                            (\callsign ->
                                case callsign.knownCallsigns of
                                    Just knownCallsigns ->
                                        List.map
                                            (\knownCallsign ->
                                                { id = knownCallsign.id
                                                , callsign = callsign.callsign
                                                , messageCount = callsign.messageCount
                                                , lastDatetime = callsign.lastDatetime
                                                , position = knownCallsign.position
                                                , unitName = knownCallsign.unitName
                                                , comment = knownCallsign.comment
                                                , createdAt = knownCallsign.createdAt
                                                , sourceName = knownCallsign.sourceName
                                                }
                                            )
                                            knownCallsigns

                                    Nothing ->
                                        []
                            )

                -- Спочатку сортуємо всі дані, потім застосовуємо пагінацію
                sortedCallsigns =
                    Table.getSortedData (callsignsTableConfig shared model user) model.callsignsTableState allCallsignsTableRows

                paginatedCallsigns =
                    Pager.getPageData model.callsignsPager sortedCallsigns

                callsignsUnknown =
                    callsigns
                        |> List.filterMap
                            (\callsign ->
                                case callsign.knownCallsigns of
                                    Just knownCallsigns ->
                                        if List.isEmpty knownCallsigns then
                                            Just
                                                { callsign = callsign.callsign
                                                , messageCount = callsign.messageCount
                                                }

                                        else
                                            Nothing

                                    Nothing ->
                                        Just
                                            { callsign = callsign.callsign
                                            , messageCount = callsign.messageCount
                                            }
                            )

                callsignsUnknownSorted =
                    if model.unknownCallsignsShowMessages then
                        if model.unknownCallsignsSortByMessages then
                            List.sortWith
                                (\left right ->
                                    case compare right.messageCount left.messageCount of
                                        EQ ->
                                            compare (String.toUpper left.callsign) (String.toUpper right.callsign)

                                        ordering ->
                                            ordering
                                )
                                callsignsUnknown

                        else
                            List.sortBy (\entry -> String.toUpper entry.callsign) callsignsUnknown

                    else
                        List.sortBy (\entry -> String.toUpper entry.callsign) callsignsUnknown
              in
              div [ class "table-responsive-modern" ]
                [ -- Таблиця "Всі позивні" (з пагінацією)
                  Table.view (callsignsTableConfig shared model user) model.callsignsTableState paginatedCallsigns
                , -- Пейджер для таблиці
                  Pager.view model.callsignsPager
                    |> Html.map CallsignsPagerMsg
                , div [ class "mt-4 p-3 bg-[var(--color-bg-muted)] rounded" ]
                    [ div [ class "flex flex-wrap items-center gap-2" ]
                        [ span [ class "font-medium" ] [ text "Присутні в перехопленнях: " ]
                        , Button.new
                            { label =
                                if model.unknownCallsignsShowMessages then
                                    "Сховати повідомлення"

                                else
                                    "Показати повідомлення"
                            , onClick = ToggleUnknownCallsignsMessages
                            }
                            |> Button.withStyleSecondary
                            |> Button.view
                        , if model.unknownCallsignsShowMessages then
                            Button.new
                                { label =
                                    if model.unknownCallsignsSortByMessages then
                                        "Сортувати по імені"

                                    else
                                        "Сортувати по повідомленням"
                                , onClick = ToggleUnknownCallsignsSortByMessages
                                }
                                |> Button.withStyleSecondary
                                |> Button.view

                          else
                            text ""
                        ]
                    , div [ class "flex flex-wrap gap-[4px] text-[13px] mt-2" ]
                        (List.map
                            (\entry ->
                                let
                                    config =
                                        DropdownBadge.config
                                            (String.toUpper entry.callsign)
                                            (model.unknownCallsignDropdown == Just entry.callsign)
                                            (ToggleUnknownCallsignDropdown entry.callsign)
                                            CloseUnknownCallsignDropdown
                                            (DropdownBadge.InternalAction
                                                { icon = "bi-plus"
                                                , label = "Додати"
                                                , action = OpenAddFromUnknownSidebar entry.callsign
                                                }
                                                :: (case model.networkCreated of
                                                        Just network ->
                                                            [ DropdownBadge.ExternalLink
                                                                { icon = "bi-arrow-right"
                                                                , label = "Проаналізувати"
                                                                , url = NetworkUtils.createAnalysisUrl shared network entry.callsign
                                                                }
                                                            ]

                                                        Nothing ->
                                                            []
                                                   )
                                            )
                                in
                                div [ class "relative inline-flex items-start" ]
                                    (DropdownBadge.view
                                        (DropdownBadge.withAutoDirection DropdownBadge.Up config)
                                        :: (if model.unknownCallsignsShowMessages then
                                                [ span [ class "badge badge-messages" ]
                                                    [ text <| String.fromInt entry.messageCount ]
                                                ]

                                            else
                                                []
                                           )
                                    )
                            )
                            callsignsUnknownSorted
                        )
                    ]
                ]
            ]
        ]


viewNetworkCallsigns : List B.NetworkCallsign -> Model -> Auth.User -> Shared.Model -> Html CallsignsMsg
viewNetworkCallsigns networkCallsigns model user shared =
    let
        -- Використовуємо helper функцію для фільтрації звичайних позивних
        regularCallsigns =
            getRegularCallsigns networkCallsigns

        -- Спочатку сортуємо всі дані, потім застосовуємо пагінацію
        sortedCallsigns =
            Table.getSortedData (networkCallsignsTableConfig shared model user) model.networkCallsignsTableState regularCallsigns

        paginatedCallsigns =
            Pager.getPageData model.networkCallsignsPager sortedCallsigns
    in
    div [ class "flex flex-col flex-1 mb-2" ]
        [ div [ class "overflow-y-auto flex-1" ]
            [ Table.view (networkCallsignsTableConfig shared model user) model.networkCallsignsTableState paginatedCallsigns
            ]
        , Pager.view model.networkCallsignsPager
            |> Html.map NetworkCallsignsPagerMsg
        ]


callsignPriority : B.NetworkCallsign -> Int
callsignPriority row =
    if row.mainRadioStation then
        0

    else if row.commandControl then
        1

    else
        2


callsignsTableConfig : Shared.Model -> Model -> Auth.User -> Table.Config CallsignTableRow CallsignsMsg
callsignsTableConfig shared model _ =
    let
        defaultCustomizations =
            Table.defaultCustomizations

        customTheadHelp : ( String, TableConfig.Status, Html.Attribute CallsignsMsg ) -> Html CallsignsMsg
        customTheadHelp ( name, status, click ) =
            let
                sortIcon =
                    case status of
                        TableConfig.Unsortable ->
                            text ""

                        TableConfig.Sortable selected ->
                            span
                                [ style "color"
                                    (if selected then
                                        "var(--ochre-normal)"

                                     else
                                        "var(--color-text-muted)"
                                    )
                                ]
                                [ text " ⇓" ]

                        TableConfig.Reversible Nothing ->
                            span [ style "color" "var(--color-text-muted)" ] [ text " ⇕" ]

                        TableConfig.Reversible (Just isReversed) ->
                            span [ style "color" "var(--ochre-normal)" ]
                                [ text
                                    (if isReversed then
                                        " ⇑"

                                     else
                                        " ⇓"
                                    )
                                ]

                headerContent =
                    div [ class "table-header-content", title name ]
                        [ span [] [ text name ]
                        , sortIcon
                        ]
            in
            Html.th [ click ] [ headerContent ]

        customThead : List ( String, TableConfig.Status, Html.Attribute CallsignsMsg ) -> TableColumn.HtmlDetails CallsignsMsg
        customThead headers =
            TableColumn.HtmlDetails [] (List.map customTheadHelp headers)

        customizations =
            { defaultCustomizations
                | tableAttrs = [ class "base-table" ]
                , thead = customThead
            }
    in
    Table.customConfig
        { toId = .callsign
        , toMsg = SetCallsignsTableState
        , columns =
            [ Table.veryCustomColumn
                { name = ""
                , viewData =
                    \row ->
                        { attributes = []
                        , children =
                            [ let
                                isAdding =
                                    Set.member row.id model.callsignAddingInProgress
                              in
                              button
                                [ class <|
                                    if isAdding then
                                        "icon-btn icon-btn-primary opacity-50 cursor-not-allowed"

                                    else
                                        "icon-btn icon-btn-primary"
                                , title <|
                                    if isAdding then
                                        "Додається до мережі..."

                                    else
                                        "Додати до мережі"
                                , if isAdding then
                                    attribute "disabled" "true"

                                  else
                                    onClick (AddCallsignToNetwork row.id)
                                ]
                                [ if isAdding then
                                    Shared.Components.Spinner.loadingSpinner2Sm

                                  else
                                    i [ class "bi bi-plus" ] []
                                ]
                            ]
                        }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "4%"
            , Table.veryCustomColumn
                { name = "Позивний"
                , viewData =
                    \row ->
                        { attributes = []
                        , children =
                            [ div [ class "relative inline-flex items-start" ]
                                [ span [ class "flex items-center flex-wrap" ]
                                    [ text <| String.toUpper row.callsign
                                    , case model.networkCreated of
                                        Just network ->
                                            a
                                                [ href (NetworkUtils.createAnalysisUrl shared network row.callsign)
                                                , target "_blank"
                                                , title "Відкрити позивний в аналізі"
                                                , class "ml-2"
                                                ]
                                                [ i [ class "bi bi-box-arrow-up-right text-action text-sm" ] [] ]

                                        Nothing ->
                                            text ""
                                    ]
                                ]
                            ]
                        }
                , sorter = TableSorter.increasingOrDecreasingBy .callsign
                }
                |> Table.withColumnWidth "13%"
            , Table.veryCustomColumn
                { name = "Посада"
                , viewData = \row -> { attributes = [], children = [ text row.position ] }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "20%"
            , Table.veryCustomColumn
                { name = "Підрозділ"
                , viewData = \row -> { attributes = [], children = [ text row.unitName ] }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "18%"
            , Table.veryCustomColumn
                { name = "Останній раз в етері"
                , viewData =
                    \row ->
                        case row.lastDatetime of
                            Just lastDatetime ->
                                { attributes = []
                                , children = [ text <| Utils.Time.renderDateF6 shared.timeZone (Time.millisToPosix lastDatetime) ]
                                }

                            Nothing ->
                                { attributes = []
                                , children = [ text "" ]
                                }
                , sorter = TableSorter.increasingOrDecreasingBy (\row -> Maybe.withDefault 0 row.lastDatetime)
                }
                |> Table.withColumnWidth "8%"
            , Table.intColumn "К-сть" .messageCount |> Table.withColumnWidth "6%"
            , Table.veryCustomColumn
                { name = "Коментар"
                , viewData =
                    \row ->
                        { attributes = [ class "relative" ]
                        , children =
                            [ div [ class "flex flex-col gap-2" ]
                                [ div
                                    [ class "comment-preview"
                                    , style "max-height" "4.5rem" -- ~3 рядки
                                    , style "overflow" "hidden"
                                    , style "white-space" "pre-line"
                                    ]
                                    [ text row.comment ]
                                , if String.length row.comment > 100 then
                                    let
                                        isOpen =
                                            case model.rowShowAllPopupStatus of
                                                Just ( callsignId, ShowAllComment ) ->
                                                    callsignId == row.id

                                                _ ->
                                                    False
                                    in
                                    Popup.new
                                        { body =
                                            span
                                                [ class "inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                                                ]
                                                [ text "Показати повністю"
                                                , i [ class "bi bi-chevron-down text-xs" ] []
                                                ]
                                        , popupBody =
                                            div [ class "comment-popup-content p-4" ]
                                                [ div [ class "mb-3 pb-2 border-b border-gray-200 dark:border-gray-700" ]
                                                    [ h4 [ class "text-sm font-semibold text-gray-900 dark:text-gray-100" ]
                                                        [ text "Повний коментар" ]
                                                    ]
                                                , div [ class "whitespace-pre-line text-sm" ]
                                                    [ text row.comment ]
                                                ]
                                        , isOpen = isOpen
                                        , onClose = RowShowAllPopupChanged Nothing
                                        , onOpen = RowShowAllPopupChanged <| Just ( row.id, ShowAllComment )
                                        , disabled = False
                                        }
                                        |> Popup.view

                                  else
                                    text ""
                                ]
                            ]
                        }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "20%"
            , Table.veryCustomColumn
                { name = "Дата прив'язки"
                , viewData =
                    \row ->
                        { attributes = []
                        , children = [ text <| Utils.Time.renderDateF6 shared.timeZone (Time.millisToPosix row.createdAt) ]
                        }
                , sorter = TableSorter.increasingOrDecreasingBy .createdAt
                }
                |> Table.withColumnWidth "12%"
            , Table.veryCustomColumn
                { name = "Джерело"
                , viewData = \row -> { attributes = [], children = [ span [ class "text-sm" ] [ text row.sourceName ] ] }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "10%"
            ]
        , customizations = customizations
        }


networkCallsignsTableConfig : Shared.Model -> Model -> Auth.User -> Table.Config B.NetworkCallsign CallsignsMsg
networkCallsignsTableConfig shared model _ =
    let
        defaultCustomizations =
            Table.defaultCustomizations

        customTheadHelp : ( String, TableConfig.Status, Html.Attribute CallsignsMsg ) -> Html CallsignsMsg
        customTheadHelp ( name, status, click ) =
            let
                sortIcon =
                    case status of
                        TableConfig.Unsortable ->
                            text ""

                        TableConfig.Sortable selected ->
                            span
                                [ style "color"
                                    (if selected then
                                        "var(--ochre-normal)"

                                     else
                                        "var(--color-text-muted)"
                                    )
                                ]
                                [ text " ⇓" ]

                        TableConfig.Reversible Nothing ->
                            span [ style "color" "var(--color-text-muted)" ] [ text " ⇕" ]

                        TableConfig.Reversible (Just isReversed) ->
                            span [ style "color" "var(--ochre-normal)" ]
                                [ text
                                    (if isReversed then
                                        " ⇑"

                                     else
                                        " ⇓"
                                    )
                                ]

                headerContent =
                    div [ class "table-header-content", title name ]
                        [ span [] [ text name ]
                        , sortIcon
                        ]
            in
            Html.th [ click ] [ headerContent ]

        customThead : List ( String, TableConfig.Status, Html.Attribute CallsignsMsg ) -> TableColumn.HtmlDetails CallsignsMsg
        customThead headers =
            TableColumn.HtmlDetails [] (List.map customTheadHelp headers)

        customizations =
            { defaultCustomizations
                | tableAttrs = [ class "base-table" ]
                , thead = customThead
            }
    in
    Table.customConfig
        { toId = String.fromInt << .id
        , toMsg = SetNetworkCallsignsTableState
        , columns =
            [ Table.veryCustomColumn
                { name = ""
                , viewData =
                    \row ->
                        { attributes = []
                        , children =
                            [ button
                                [ class "icon-btn icon-btn-danger"
                                , title "Відв'язати від мережі"
                                , onClick (DeleteCallsignFromNetwork row.id)
                                ]
                                [ i [ class "bi bi-dash" ] [] ]
                            ]
                        }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "4%"
            , Table.veryCustomColumn
                { name = "Позивний"
                , viewData =
                    \row ->
                        let
                            callsignText =
                                String.toUpper row.callsign

                            callsignContent =
                                List.concat
                                    [ [ text callsignText ]
                                    , if row.mainRadioStation then
                                        [ i [ class "bi bi-star-fill ml-2", title "Головна радіостанція" ] []
                                        ]

                                      else
                                        []
                                    , if row.commandControl then
                                        [ i [ class "bi bi-person-badge-fill ml-2", title "Ланка управління" ] []
                                        ]

                                      else
                                        []
                                    ]
                        in
                        { attributes = [], children = callsignContent }
                , sorter = TableSorter.increasingOrDecreasingBy (\row -> ( callsignPriority row, String.toUpper row.callsign ))
                }
                |> Table.withColumnWidth "12%"
            , Table.veryCustomColumn
                { name = "Посада"
                , viewData = \row -> { attributes = [], children = [ text (Maybe.withDefault "-" row.position) ] }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "14%"
            , Table.veryCustomColumn
                { name = "ПІП"
                , viewData =
                    \row ->
                        { attributes = []
                        , children = [ text (Maybe.withDefault "-" row.fullName) ]
                        }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "14%"
            , Table.veryCustomColumn
                { name = "Підрозділ"
                , viewData =
                    \row ->
                        let
                            unitText =
                                Maybe.withDefault "-" row.unitName

                            unitContent =
                                if row.unitDeveloping then
                                    [ text unitText
                                    , span [ class "ml-2 badge badge-no-unit" ]
                                        [ text "в дорозвідці" ]
                                    ]

                                else
                                    [ text unitText ]
                        in
                        { attributes = [], children = unitContent }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "16%"
            , Table.veryCustomColumn
                { name = "Остання активність"
                , viewData =
                    \row ->
                        case row.lastDatetime of
                            Just lastDatetime ->
                                { attributes = []
                                , children = [ text <| Utils.Time.renderDateF6 shared.timeZone (Time.millisToPosix lastDatetime) ]
                                }

                            Nothing ->
                                { attributes = []
                                , children = [ text "-" ]
                                }
                , sorter = TableSorter.increasingOrDecreasingBy (\row -> Maybe.withDefault 0 row.lastDatetime)
                }
                |> Table.withColumnWidth "8%"
            , Table.intColumn "К-сть" .messageCount |> Table.withColumnWidth "7%"
            , Table.veryCustomColumn
                { name = "Коментар"
                , viewData =
                    \row ->
                        { attributes = [ class "relative" ]
                        , children =
                            [ div [ class "flex flex-col gap-2" ]
                                [ div
                                    [ class "comment-preview"
                                    , style "max-height" "4.5rem" -- ~3 рядки
                                    , style "overflow" "hidden"
                                    , style "white-space" "pre-line"
                                    ]
                                    [ text (Maybe.withDefault "-" row.comment) ]
                                , if String.length (Maybe.withDefault "" row.comment) > 100 then
                                    let
                                        isOpen =
                                            case model.rowShowAllPopupStatus of
                                                Just ( callsignId, ShowAllComment ) ->
                                                    callsignId == row.id

                                                _ ->
                                                    False
                                    in
                                    Popup.new
                                        { body =
                                            span
                                                [ class "inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                                                ]
                                                [ text "Показати повний коментар"
                                                , i [ class "bi bi-chevron-down text-xs" ] []
                                                ]
                                        , popupBody =
                                            div [ class "comment-popup-content p-4" ]
                                                [ div [ class "mb-3 pb-2 border-b border-gray-200 dark:border-gray-700" ]
                                                    [ h4 [ class "text-sm font-semibold text-gray-900 dark:text-gray-100" ]
                                                        [ text "Повний коментар" ]
                                                    ]
                                                , div [ class "whitespace-pre-line text-sm" ]
                                                    [ text (Maybe.withDefault "-" row.comment) ]
                                                ]
                                        , isOpen = isOpen
                                        , onClose = RowShowAllPopupChanged Nothing
                                        , onOpen = RowShowAllPopupChanged <| Just ( row.id, ShowAllComment )
                                        , disabled = False
                                        }
                                        |> Popup.view

                                  else
                                    text ""
                                ]
                            ]
                        }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "15%"
            , Table.veryCustomColumn
                { name = "Дата створення"
                , viewData =
                    \row ->
                        { attributes = []
                        , children = [ text <| Utils.Time.renderDateF6 shared.timeZone (Time.millisToPosix row.createdAt) ]
                        }
                , sorter = TableSorter.increasingOrDecreasingBy .createdAt
                }
                |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "Джерело"
                , viewData =
                    \row ->
                        { attributes = []
                        , children =
                            [ case row.sourceId of
                                Just sourceId ->
                                    case ListX.find (\s -> s.id == sourceId) model.callsignCreateSources of
                                        Just source ->
                                            div []
                                                [ span [ class "text-sm" ] [ text source.name ]
                                                , if sourceId == 2 && row.radioFreq /= Nothing then
                                                    span [ class "text-xs text-muted-foreground ml-1" ]
                                                        [ text <| Maybe.withDefault "" row.radioFreq ]

                                                  else
                                                    text ""
                                                ]

                                        Nothing ->
                                            span [ class "text-sm" ] [ text (String.fromInt sourceId) ]

                                Nothing ->
                                    text "-"
                            ]
                        }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "Дії"
                , viewData =
                    \row ->
                        { attributes = [ class "col-narrow" ]
                        , children =
                            [ div [ class "flex gap-[4px] text-sm" ]
                                [ button
                                    [ title "Редагувати"
                                    , class "icon-btn icon-btn-primary"
                                    , onClick (EditCallsignClicked row.id)
                                    ]
                                    [ i [ class "bi bi-pencil" ] [] ]
                                ]
                            ]
                        }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "5%"
            ]
        , customizations = customizations
        }



-- SIDEBAR CONTENTS


createCallsignsSidebar : Model -> Auth.User -> Shared.Model -> Html CallsignsMsg
createCallsignsSidebar model user shared =
    case model.callsignCreateSidebar of
        Just _ ->
            Sidebar.view True CloseCallsignCreateSidebar [ callsignCreateSidebarContent shared model user ]

        Nothing ->
            text ""


editCallsignsSidebar : Model -> Auth.User -> Shared.Model -> Html CallsignsMsg
editCallsignsSidebar model user shared =
    if model.editCallsignSidebar /= Nothing then
        Sidebar.view True CloseEditCallsignSidebar [ editCallsignSidebarContent shared model user ]

    else
        text ""


callsignCreateSidebarContent : Shared.Model -> Model -> Auth.User -> Html CallsignsMsg
callsignCreateSidebarContent shared model _ =
    div [ class "flex flex-col h-full" ]
        [ div [ class "flex-1 p-6 overflow-y-auto" ]
            [ h2 [ class "text-lg font-semibold mb-6" ] [ text "Створити позивний мережі" ]
            , div [ class "space-y-4" ]
                [ div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Позивний *" ]
                    , input
                        [ type_ "text"
                        , class "w-full p-2 border border-border rounded"
                        , placeholder "Введіть позивний"
                        , value (Maybe.map .callsign model.callsignCreateState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateCallsignCreateField
                                << (\v maybeState ->
                                        Maybe.map (\s -> { s | callsign = String.toUpper v }) maybeState
                                   )
                        ]
                        []
                    ]
                , let
                    markerSelection =
                        Maybe.withDefault NoMarker <|
                            Maybe.map markerSelectionFromState model.callsignCreateState
                  in
                  div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Маркер" ]
                    , SegmentedControl.new
                        markerSelection
                        (\marker ->
                            UpdateCallsignCreateField (Maybe.map (applyMarkerSelection marker))
                        )
                        [ { value = MainRadioStation, label = "Головна радіостанція" }
                        , { value = CommandControl, label = "Ланка управління" }
                        , { value = NoMarker, label = "Без маркера" }
                        ]
                        |> (\control -> { control | ariaLabel = Just "Маркер" })
                        |> SegmentedControl.view
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Джерело" ]
                    , let
                        sourceMenu =
                            model.callsignCreateSources
                                |> List.map (\source -> Select.basicMenuItem { item = source.id, label = source.name })

                        selectItem =
                            Maybe.andThen .sourceId model.callsignCreateState
                                |> Maybe.andThen
                                    (\sourceId ->
                                        ListX.find (\s -> s.id == sourceId) model.callsignCreateSources
                                            |> Maybe.map (\source -> Select.basicMenuItem { item = source.id, label = source.name })
                                    )
                      in
                      Html.map CallsignCreateSourceSelMsg <|
                        Styled.toUnstyled <|
                            Utils.Select.renderSelectSingle
                                selectItem
                                model.callsignCreateSourceSelState
                                sourceMenu
                                "Виберіть джерело (необов'язково)"
                                (Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                                    |> (\opts ->
                                            { opts
                                                | clearable = True
                                            }
                                       )
                                )
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Підрозділ" ]
                    , div [ class "flex items-center gap-2 p-2 border border-border rounded bg-gray-50 dark:bg-gray-700" ]
                        [ span [ class "text-sm text-gray-700 dark:text-gray-300" ]
                            [ text
                                (case Maybe.andThen .unitId model.callsignCreateState of
                                    Just unitId ->
                                        case shared.masterUnits of
                                            Success units ->
                                                Dict.get unitId units
                                                    |> Maybe.map .name
                                                    |> Maybe.withDefault "Невідомий підрозділ"

                                            _ ->
                                                "Завантаження..."

                                    Nothing ->
                                        -- Показуємо назву першого підрозділу мережі
                                        case model.editUnitsSelect.selected of
                                            firstUnitId :: _ ->
                                                case shared.masterUnits of
                                                    Success units ->
                                                        Dict.get firstUnitId units
                                                            |> Maybe.map .name
                                                            |> Maybe.withDefault "Підрозділ мережі"

                                                    _ ->
                                                        "Підрозділ мережі"

                                            [] ->
                                                "Підрозділ мережі"
                                )
                            ]
                        , button
                            [ type_ "button"
                            , class "text-blue-600 hover:text-blue-800 text-sm"
                            , title "Змінити підрозділ"
                            , onClick ToggleCallsignCreateUnitSelector
                            ]
                            [ text "✏️" ]
                        , button
                            [ type_ "button"
                            , class "text-gray-600 hover:text-gray-800 text-sm"
                            , title "Повернути підрозділ мережі"
                            , onClick ResetCallsignCreateUnit
                            ]
                            [ text "✖️" ]
                        ]
                    , if model.callsignCreateUnitSelectorVisible then
                        -- Показуємо селект підрозділів
                        div [ class "mt-2" ]
                            [ let
                                unitMenu =
                                    case shared.masterUnits of
                                        Success units ->
                                            Dict.values units |> List.filter .active |> List.map (\unit -> Select.basicMenuItem { item = unit.id, label = unit.name })

                                        _ ->
                                            []

                                selectedUnit =
                                    Maybe.andThen .unitId model.callsignCreateState
                                        |> Maybe.andThen
                                            (\unitId ->
                                                case shared.masterUnits of
                                                    Success units ->
                                                        Dict.get unitId units
                                                            |> Maybe.map (\unit -> Select.basicMenuItem { item = unit.id, label = unit.name })

                                                    _ ->
                                                        Nothing
                                            )
                              in
                              Html.map CallsignCreateUnitSelMsg <|
                                Styled.toUnstyled <|
                                    Utils.Select.renderSelectSingle
                                        selectedUnit
                                        model.callsignCreateUnitSelState
                                        unitMenu
                                        "Виберіть підрозділ"
                                        (Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                                            |> (\opts ->
                                                    { opts
                                                        | clearable = True
                                                    }
                                               )
                                        )
                            ]

                      else
                        text ""
                    ]
                , div []
                    [ div [ class "flex items-center" ]
                        [ Checkbox.new
                            { isChecked = Maybe.map .unitDeveloping model.callsignCreateState |> Maybe.withDefault False
                            , onToggle =
                                \_ ->
                                    UpdateCallsignCreateField
                                        (Maybe.map (\s -> { s | unitDeveloping = not s.unitDeveloping }))
                            }
                            |> Checkbox.withContent [ text "Підрозділ в дорозвідці" ]
                            |> Checkbox.view
                        ]
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Посада" ]
                    , input
                        [ type_ "text"
                        , class "w-full p-2 border border-border rounded"
                        , placeholder "Введіть посаду (необов'язково)"
                        , value (Maybe.andThen .position model.callsignCreateState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateCallsignCreateField
                                << (\v maybeState ->
                                        Maybe.map
                                            (\s ->
                                                { s
                                                    | position =
                                                        if String.trim v == "" then
                                                            Nothing

                                                        else
                                                            Just v
                                                }
                                            )
                                            maybeState
                                   )
                        ]
                        []
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "ПІП" ]
                    , input
                        [ type_ "text"
                        , class "w-full p-2 border border-border rounded"
                        , placeholder "Введіть ПІП (необов'язково)"
                        , value (Maybe.andThen .fullName model.callsignCreateState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateCallsignCreateField
                                << (\v maybeState ->
                                        Maybe.map
                                            (\s ->
                                                { s
                                                    | fullName =
                                                        if String.trim v == "" then
                                                            Nothing

                                                        else
                                                            Just v
                                                }
                                            )
                                            maybeState
                                   )
                        ]
                        []
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Коментар" ]
                    , textarea
                        [ class "w-full p-2 border border-border rounded resize-none"
                        , rows 3
                        , placeholder "Введіть коментар (необов'язково)"
                        , value (Maybe.andThen .comment model.callsignCreateState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateCallsignCreateField
                                << (\v maybeState ->
                                        Maybe.map
                                            (\s ->
                                                { s
                                                    | comment =
                                                        if String.trim v == "" then
                                                            Nothing

                                                        else
                                                            Just v
                                                }
                                            )
                                            maybeState
                                   )
                        ]
                        []
                    ]
                , div []
                    [ div [ class "flex items-center" ]
                        [ Checkbox.new
                            { isChecked = Maybe.map .developing model.callsignCreateState |> Maybe.withDefault False
                            , onToggle =
                                \_ ->
                                    UpdateCallsignCreateField
                                        (Maybe.map (\s -> { s | developing = not s.developing }))
                            }
                            |> Checkbox.withContent [ text "Позначити як позивний в дорозвідці" ]
                            |> Checkbox.view
                        ]
                    ]
                , if Maybe.andThen .sourceId model.callsignCreateState == Just 2 then
                    div []
                        [ label [ class "block text-sm font-medium mb-1" ] [ text "Частота *" ]
                        , input
                            [ type_ "text"
                            , class "w-full p-2 border border-border rounded"
                            , placeholder "Введіть частоту (обов'язково для РО)"
                            , value (Maybe.andThen .radioFreq model.callsignCreateState |> Maybe.withDefault "")
                            , onInput <|
                                UpdateCallsignCreateField
                                    << (\v maybeState ->
                                            Maybe.map
                                                (\s ->
                                                    { s
                                                        | radioFreq =
                                                            if String.trim v == "" then
                                                                Nothing

                                                            else
                                                                Just v
                                                    }
                                                )
                                                maybeState
                                       )
                            ]
                            []
                        ]

                  else
                    text ""
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseCallsignCreateSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , if model.callsignCreateSaving then
                    Button.new { label = "Створення...", onClick = CreateCallsignClicked }
                        |> Button.withDisabled True
                        |> Button.view

                  else
                    Button.new { label = "Створити", onClick = CreateCallsignClicked }
                        |> Button.withDisabled
                            (let
                                callsignEmpty =
                                    Maybe.map .callsign model.callsignCreateState
                                        |> Maybe.map (String.trim >> (==) "")
                                        |> Maybe.withDefault True

                                isRO =
                                    Maybe.andThen .sourceId model.callsignCreateState == Just 2

                                roFreqEmpty =
                                    if isRO then
                                        Maybe.andThen .radioFreq model.callsignCreateState
                                            |> Maybe.map (String.trim >> (==) "")
                                            |> Maybe.withDefault True

                                    else
                                        False
                             in
                             callsignEmpty || roFreqEmpty
                            )
                        |> Button.view
                ]
            ]
        ]


editCallsignSidebarContent : Shared.Model -> Model -> B.User -> Html CallsignsMsg
editCallsignSidebarContent shared model _ =
    div [ class "flex flex-col h-full" ]
        [ div [ class "flex-1 p-6 overflow-y-auto" ]
            [ h2 [ class "text-lg font-semibold mb-6" ] [ text "Редагувати позивний мережі" ]
            , div [ class "space-y-4" ]
                [ div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Позивний *" ]
                    , input
                        [ type_ "text"
                        , class "w-full p-2 border border-border rounded"
                        , placeholder "Введіть позивний"
                        , value (Maybe.map .callsign model.editCallsignState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateEditCallsignField
                                << (\v maybeState ->
                                        Maybe.map (\s -> { s | callsign = String.toUpper v }) maybeState
                                   )
                        ]
                        []
                    ]
                , let
                    markerSelection =
                        Maybe.withDefault NoMarker <|
                            Maybe.map markerSelectionFromState model.editCallsignState
                  in
                  div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Маркер" ]
                    , SegmentedControl.new
                        markerSelection
                        (\marker ->
                            UpdateEditCallsignField (Maybe.map (applyMarkerSelection marker))
                        )
                        [ { value = MainRadioStation, label = "Головна радіостанція" }
                        , { value = CommandControl, label = "Ланка управління" }
                        , { value = NoMarker, label = "Без маркера" }
                        ]
                        |> (\control -> { control | ariaLabel = Just "Маркер" })
                        |> SegmentedControl.view
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Джерело" ]
                    , let
                        sourceMenu =
                            model.callsignCreateSources
                                |> List.map (\source -> Select.basicMenuItem { item = source.id, label = source.name })

                        selectItem =
                            Maybe.andThen .sourceId model.editCallsignState
                                |> Maybe.andThen
                                    (\sourceId ->
                                        ListX.find (\s -> s.id == sourceId) model.callsignCreateSources
                                            |> Maybe.map (\source -> Select.basicMenuItem { item = source.id, label = source.name })
                                    )
                      in
                      Html.map EditCallsignSourceSelMsg <|
                        Styled.toUnstyled <|
                            Utils.Select.renderSelectSingle
                                selectItem
                                model.editCallsignSourceSelState
                                sourceMenu
                                "Виберіть джерело (необов'язково)"
                                (Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                                    |> (\opts ->
                                            { opts
                                                | clearable = True
                                            }
                                       )
                                )
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Підрозділ" ]
                    , div [ class "flex items-center gap-2 p-2 border border-border rounded bg-gray-50 dark:bg-gray-700" ]
                        [ span [ class "text-sm text-gray-700 dark:text-gray-300" ]
                            [ text
                                (case Maybe.andThen .unitId model.editCallsignState of
                                    Just unitId ->
                                        case shared.masterUnits of
                                            Success units ->
                                                Dict.get unitId units
                                                    |> Maybe.map .name
                                                    |> Maybe.withDefault "Невідомий підрозділ"

                                            _ ->
                                                "Завантаження..."

                                    Nothing ->
                                        -- Показуємо назву першого підрозділу мережі
                                        case model.editUnitsSelect.selected of
                                            firstUnitId :: _ ->
                                                case shared.masterUnits of
                                                    Success units ->
                                                        Dict.get firstUnitId units
                                                            |> Maybe.map .name
                                                            |> Maybe.withDefault "Підрозділ мережі"

                                                    _ ->
                                                        "Підрозділ мережі"

                                            [] ->
                                                "Підрозділ мережі"
                                )
                            ]
                        , button
                            [ type_ "button"
                            , class "text-blue-600 hover:text-blue-800 text-sm"
                            , title "Змінити підрозділ"
                            , onClick ToggleEditCallsignUnitSelector
                            ]
                            [ text "✏️" ]
                        , button
                            [ type_ "button"
                            , class "text-gray-600 hover:text-gray-800 text-sm"
                            , title "Повернути підрозділ мережі"
                            , onClick ResetEditCallsignUnit
                            ]
                            [ text "✖️" ]
                        ]
                    , if model.editCallsignUnitSelectorVisible then
                        -- Показуємо селект підрозділів
                        div [ class "mt-2" ]
                            [ let
                                unitMenu =
                                    case shared.masterUnits of
                                        Success units ->
                                            Dict.values units |> List.filter .active |> List.map (\unit -> Select.basicMenuItem { item = unit.id, label = unit.name })

                                        _ ->
                                            []

                                selectedUnit =
                                    Maybe.andThen .unitId model.editCallsignState
                                        |> Maybe.andThen
                                            (\unitId ->
                                                case shared.masterUnits of
                                                    Success units ->
                                                        Dict.get unitId units
                                                            |> Maybe.map (\unit -> Select.basicMenuItem { item = unit.id, label = unit.name })

                                                    _ ->
                                                        Nothing
                                            )
                              in
                              Html.map EditCallsignUnitSelMsg <|
                                Styled.toUnstyled <|
                                    Utils.Select.renderSelectSingle
                                        selectedUnit
                                        model.editCallsignUnitSelState
                                        unitMenu
                                        "Виберіть підрозділ"
                                        (Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                                            |> (\opts ->
                                                    { opts
                                                        | clearable = True
                                                    }
                                               )
                                        )
                            ]

                      else
                        text ""
                    ]
                , div []
                    [ div [ class "flex items-center" ]
                        [ Checkbox.new
                            { isChecked = Maybe.map .unitDeveloping model.editCallsignState |> Maybe.withDefault False
                            , onToggle =
                                \_ ->
                                    UpdateEditCallsignField
                                        (Maybe.map (\s -> { s | unitDeveloping = not s.unitDeveloping }))
                            }
                            |> Checkbox.withContent [ text "Підрозділ в дорозвідці" ]
                            |> Checkbox.view
                        ]
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Посада" ]
                    , input
                        [ type_ "text"
                        , class "w-full p-2 border border-border rounded"
                        , placeholder "Введіть посаду (необов'язково)"
                        , value (Maybe.andThen .position model.editCallsignState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateEditCallsignField
                                << (\v maybeState ->
                                        Maybe.map
                                            (\s ->
                                                { s
                                                    | position =
                                                        if String.trim v == "" then
                                                            Nothing

                                                        else
                                                            Just v
                                                }
                                            )
                                            maybeState
                                   )
                        ]
                        []
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "ПІП" ]
                    , input
                        [ type_ "text"
                        , class "w-full p-2 border border-border rounded"
                        , placeholder "Введіть ПІП (необов'язково)"
                        , value (Maybe.andThen .fullName model.editCallsignState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateEditCallsignField
                                << (\v maybeState ->
                                        Maybe.map
                                            (\s ->
                                                { s
                                                    | fullName =
                                                        if String.trim v == "" then
                                                            Nothing

                                                        else
                                                            Just v
                                                }
                                            )
                                            maybeState
                                   )
                        ]
                        []
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Коментар" ]
                    , textarea
                        [ class "w-full p-2 border border-border rounded resize-none"
                        , rows 3
                        , placeholder "Введіть коментар (необов'язково)"
                        , value (Maybe.andThen .comment model.editCallsignState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateEditCallsignField
                                << (\v maybeState ->
                                        Maybe.map
                                            (\s ->
                                                { s
                                                    | comment =
                                                        if String.trim v == "" then
                                                            Nothing

                                                        else
                                                            Just v
                                                }
                                            )
                                            maybeState
                                   )
                        ]
                        []
                    ]
                , div []
                    [ div [ class "flex items-center" ]
                        [ Checkbox.new
                            { isChecked = Maybe.map .developing model.editCallsignState |> Maybe.withDefault False
                            , onToggle =
                                \_ ->
                                    UpdateEditCallsignField
                                        (Maybe.map (\s -> { s | developing = not s.developing }))
                            }
                            |> Checkbox.withContent [ text "Позначити як позивний в дорозвідці" ]
                            |> Checkbox.view
                        ]
                    ]
                , if Maybe.andThen .sourceId model.editCallsignState == Just 2 then
                    div []
                        [ label [ class "block text-sm font-medium mb-1" ] [ text "Частота *" ]
                        , input
                            [ type_ "text"
                            , class "w-full p-2 border border-border rounded"
                            , placeholder "Введіть частоту (обов'язково для РО)"
                            , value (Maybe.andThen .radioFreq model.editCallsignState |> Maybe.withDefault "")
                            , onInput <|
                                UpdateEditCallsignField
                                    << (\v maybeState ->
                                            Maybe.map
                                                (\s ->
                                                    { s
                                                        | radioFreq =
                                                            if String.trim v == "" then
                                                                Nothing

                                                            else
                                                                Just v
                                                    }
                                                )
                                                maybeState
                                       )
                            ]
                            []
                        ]

                  else
                    text ""

                -- Display errors if any
                , case Dict.get "general" model.editCallsignErrors of
                    Just error ->
                        div [ class "p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm" ]
                            [ text error ]

                    Nothing ->
                        text ""
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseEditCallsignSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , if model.editCallsignSaving then
                    Button.new { label = "Збереження...", onClick = SaveEditCallsignClicked }
                        |> Button.withDisabled True
                        |> Button.view

                  else
                    Button.new { label = "Зберегти", onClick = SaveEditCallsignClicked }
                        |> Button.withDisabled
                            (let
                                callsignEmpty =
                                    Maybe.map .callsign model.editCallsignState
                                        |> Maybe.map (String.trim >> (==) "")
                                        |> Maybe.withDefault True

                                isRO =
                                    Maybe.andThen .sourceId model.editCallsignState == Just 2

                                roFreqEmpty =
                                    if isRO then
                                        Maybe.andThen .radioFreq model.editCallsignState
                                            |> Maybe.map (String.trim >> (==) "")
                                            |> Maybe.withDefault True

                                    else
                                        False
                             in
                             callsignEmpty || roFreqEmpty
                            )
                        |> Button.view
                ]
            ]
        ]


deleteCallsignModal : Model -> Html CallsignsMsg
deleteCallsignModal model =
    let
        deleteCallsignDialogContent =
            [ div [ class "flex flex-col justify-between gap-4 p-2 w-[400px]" ]
                [ div [ class "pb-6" ]
                    [ h2 [] [ text "Відв'язати позивний" ]
                    , p [] [ text "Ви впевнені, що хочете відв'язати цей позивний від мережі?" ]
                    ]
                , div [ class "flex justify-between" ]
                    [ Button.new { label = "Скасувати", onClick = DeleteCallsignCanceled } |> Button.withStyleSecondary |> Button.view
                    , Button.new { label = "Відв'язати", onClick = DeleteCallsignConfirmed (Maybe.withDefault 0 model.deleteCallsignConfirmation) }
                        |> Button.withStyleDanger
                        |> (if model.deleteCallsignLoading then
                                Button.withIcon
                                    [ Shared.Components.Spinner.loadingSpinner2Sm
                                    ]

                            else
                                identity
                           )
                        |> Button.view
                    ]
                ]
            ]
    in
    ModalDialog.modalDialog (model.deleteCallsignConfirmation /= Nothing) DeleteCallsignCanceled [] deleteCallsignDialogContent
