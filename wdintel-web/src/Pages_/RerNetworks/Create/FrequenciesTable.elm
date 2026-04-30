module Pages_.RerNetworks.Create.FrequenciesTable exposing (..)

import Auth
import Bindings as B
import Core.Auth
import Dict
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Styled as Styled
import Json.Encode as Encode
import List.Extra as ListX
import Pages_.RerNetworks.Create.Model exposing (FreqActivityFilter(..), Mode(..), Model)
import Pages_.RerNetworks.Create.Msg exposing (FrequenciesMsg(..))
import Select
import Shared
import Shared.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Shared.Components.Button as Button
import Shared.Components.Checkbox as Checkbox
import Shared.Components.ModalDialog as ModalDialog
import Shared.Components.SegmentedControl as SegmentedControl
import Shared.Components.Sidebar as Sidebar
import Shared.Components.Spinner
import Shared.Components.Table as Table
import Shared.Components.Table.Column as TableColumn
import Shared.Components.Table.Config as TableConfig
import Shared.Components.Table.Sorter as TableSorter
import Shared.Model exposing (isDarkMode)
import String
import Time
import Time.Extra
import Utils.Api.ErrorHandling
import Utils.Modulations as Modulations
import Utils.NetworksUtils as NetworksUtils
import Utils.RemoteData as RD exposing (RemoteData(..))
import Utils.Select
import Utils.Time


loadFreqsInit : Int -> List (Effect FrequenciesMsg)
loadFreqsInit networkId =
    [ E.getNetworkFreqsActivity NetworkFreqsActivityReturnedByApi { networkId = networkId }
    , E.getSingleNetworkFreqs FreqsReturnedByApi { networkId = networkId, includeCallsigns = Just False }
    ]


doNeedReloadCatalogCallsigns : FrequenciesMsg -> Bool
doNeedReloadCatalogCallsigns freqsMsg =
    case freqsMsg of
        FreqAddedToNetwork _ ->
            True

        DeleteFreqReturnedByApi _ (Ok _) ->
            True

        FreqUpdatedByApi _ ->
            True

        _ ->
            False


updateFreqCallsigns : Int -> List String -> List B.NetworkFreqsRes -> List B.NetworkFreqsRes
updateFreqCallsigns networkFreqId callsigns freqs =
    List.map
        (\freq ->
            if freq.networkFreqId == networkFreqId then
                { freq | callsigns = Just callsigns }

            else
                freq
        )
        freqs


update : Shared.Model -> FrequenciesMsg -> Model -> ( Model, Effect FrequenciesMsg )
update _ msg model =
    case msg of
        NetworkFreqsActivityReturnedByApi (Err e) ->
            ( { model | networkFreqsActivity = Failure e }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження активності частот мережі" e
            )

        NetworkFreqsActivityReturnedByApi (Ok res) ->
            ( { model | networkFreqsActivity = Success res }, E.none )

        FreqsEditStartedByUser ->
            case ( model.freqs, model.networkCreated ) of
                ( Success freqs, Just network ) ->
                    let
                        editFreqsDict =
                            List.map
                                (\f ->
                                    ( f.freq
                                    , { networkId = network.id
                                      , freq = f.freq
                                      , kind = Maybe.withDefault "VHF" f.kind
                                      , modulationId = f.modulationId
                                      , encryptionKeyIds = f.encryptionKeyIds
                                      , activeFrom = f.activeFrom
                                      , activeTo = f.activeTo
                                      }
                                    )
                                )
                                freqs
                                |> Dict.fromList
                    in
                    ( { model
                        | freqsEditingState =
                            Editing editFreqsDict
                      }
                    , E.none
                    )

                _ ->
                    ( model, E.none )

        FreqsEditSavedByUser ->
            let
                compareTwoFreqs : B.UpdateNetworkFreqReq -> B.NetworkFreqsRes -> Bool
                compareTwoFreqs updateReq originalFreq =
                    updateReq.freq
                        == originalFreq.freq
                        && updateReq.activeFrom
                        == originalFreq.activeFrom
                        && updateReq.encryptionKeyIds
                        == originalFreq.encryptionKeyIds
                        && updateReq.activeTo
                        == originalFreq.activeTo

                ( m1, eff1 ) =
                    case model.freqsEditingState of
                        Editing editingDict ->
                            let
                                effects =
                                    Dict.values editingDict
                                        |> List.filterMap
                                            (\updateFreqReq ->
                                                case model.freqs of
                                                    Success freqs ->
                                                        ListX.find (\f -> f.freq == updateFreqReq.freq) freqs
                                                            |> Maybe.andThen
                                                                (\originalFreq ->
                                                                    if compareTwoFreqs updateFreqReq originalFreq then
                                                                        Nothing

                                                                    else
                                                                        Just updateFreqReq
                                                                )

                                                    _ ->
                                                        Nothing
                                            )
                                        |> List.map (\updateFreqReq -> E.updateNetworkFreq FreqUpdatedByApi updateFreqReq)
                            in
                            ( { model
                                | freqsEditingState =
                                    if List.length effects > 0 then
                                        model.freqsEditingState

                                    else
                                        Readonly
                              }
                            , E.batch effects
                            )

                        Readonly ->
                            ( model, E.none )
            in
            ( m1
            , eff1
            )

        FreqsEditCanceledByUser ->
            ( { model | freqsEditingState = Readonly }, E.none )

        FreqsEditingMsg updFreqState ->
            ( { model
                | freqsEditingState =
                    case model.freqsEditingState of
                        Editing editingFreqsDict ->
                            Editing (Dict.insert updFreqState.freq updFreqState editingFreqsDict)

                        Readonly ->
                            Readonly
              }
            , E.none
            )

        FreqUpdatedByApi (Err e) ->
            ( { model | freqEditSaving = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення частоти" e
            )

        FreqUpdatedByApi (Ok network) ->
            ( { model
                | networkCreated = Just network
                , freqsEditingState = Readonly
                , freqEditSaving = False
                , freqEditSidebar = Nothing
              }
            , E.batch
                [ E.getSingleNetworkFreqs FreqsReturnedByApi { networkId = network.id, includeCallsigns = Just False }
                , E.getNetworkFreqsActivity NetworkFreqsActivityReturnedByApi { networkId = network.id }
                ]
            )

        FreqsActivityFilterChangedByUser filter ->
            ( { model | freqsActivityFilter = filter }, E.none )

        SetFreqsTableState newState ->
            ( { model | freqsTableState = newState }, E.none )

        OpenFreqEditSidebar freqId updateReq ->
            let
                -- Оновлюємо селекти з даними з частоти
                kindSelect =
                    model.freqEditKindSelect

                updatedKindSelect =
                    { kindSelect | selected = NetworksUtils.networkKindFromString updateReq.kind }

                modulationSelect =
                    model.freqEditModulationSelect

                updatedModulationSelect =
                    { modulationSelect | selected = updateReq.modulationId }

                -- Встановлюємо freqEditShowActiveTo на основі того, чи є activeTo
                showActiveTo =
                    updateReq.activeTo /= Nothing
            in
            ( { model
                | freqEditSidebar = Just ( freqId, updateReq )
                , freqEditKindSelect = updatedKindSelect
                , freqEditModulationSelect = updatedModulationSelect
                , freqEditShowActiveTo = showActiveTo
              }
            , E.none
            )

        CloseFreqEditSidebar ->
            ( { model | freqEditSidebar = Nothing, freqEditShowActiveTo = False }, E.none )

        UpdateFreqEditSidebar updateReq ->
            ( { model | freqEditSidebar = Maybe.map (\( freqId, _ ) -> ( freqId, updateReq )) model.freqEditSidebar }, E.none )

        SaveFreqEditSidebar ->
            case model.freqEditSidebar of
                Just ( _, updateReq ) ->
                    ( { model | freqEditSaving = True }
                    , E.updateNetworkFreq FreqUpdatedByApi updateReq
                    )

                Nothing ->
                    ( model, E.none )

        OpenFreqDetailPopup freqId ->
            ( { model | freqDetailPopup = Just freqId }, E.none )

        CloseFreqDetailPopup ->
            ( { model | freqDetailPopup = Nothing }, E.none )

        FreqsReturnedByApi (Err e) ->
            ( { model | freqs = Failure e }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження частот" e
            )

        FreqsReturnedByApi (Ok res) ->
            let
                addConfirmationFreqSelect =
                    model.addConfirmationFreqSelect

                acfs2 =
                    { addConfirmationFreqSelect | items = List.map .freq res.freqs |> List.map (\freq -> Select.basicMenuItem { item = freq, label = freq }) }
            in
            ( { model | freqs = Success res.freqs, addConfirmationFreqSelect = acfs2 }, E.none )

        FreqKindSelectMsg imsg ->
            let
                ( mAct, imodel, icmd ) =
                    Select.update imsg model.freqEditKindSelect.state

                updatedNetworkKind =
                    Utils.Select.singleUpdWithDefault mAct model.freqEditKindSelect.selected

                kindSelect =
                    model.freqEditKindSelect

                kindSelect2 =
                    { kindSelect
                        | state = imodel
                        , selected = updatedNetworkKind
                    }

                updatedSidebar =
                    case model.freqEditSidebar of
                        Just ( freqId, updateReq ) ->
                            Just ( freqId, { updateReq | kind = NetworksUtils.networkKindToString updatedNetworkKind } )

                        Nothing ->
                            model.freqEditSidebar
            in
            ( { model
                | freqEditKindSelect = kindSelect2
                , freqEditSidebar = updatedSidebar
              }
            , E.sendCmd <|
                Cmd.map
                    FreqKindSelectMsg
                    icmd
            )

        FreqModulationSelectMsg imsg ->
            let
                ( mAct, imodel, icmd ) =
                    Select.update imsg model.freqEditModulationSelect.state

                updatedModulationId =
                    Utils.Select.singleUpd mAct model.freqEditModulationSelect.selected

                modulationSelect =
                    model.freqEditModulationSelect

                modulationSelect2 =
                    { modulationSelect
                        | state = imodel
                        , selected = updatedModulationId
                    }

                updatedSidebar =
                    case model.freqEditSidebar of
                        Just ( freqId, updateReq ) ->
                            Just ( freqId, { updateReq | modulationId = updatedModulationId } )

                        Nothing ->
                            model.freqEditSidebar
            in
            ( { model
                | freqEditModulationSelect = modulationSelect2
                , freqEditSidebar = updatedSidebar
              }
            , E.sendCmd <|
                Cmd.map
                    FreqModulationSelectMsg
                    icmd
            )

        ToggleFreqEditShowActiveTo ->
            let
                newShowActiveTo =
                    not model.freqEditShowActiveTo

                updatedModel =
                    if not newShowActiveTo then
                        -- очистити activeTo при знятті чекбокса
                        case model.freqEditSidebar of
                            Just ( freqId, updateReq ) ->
                                let
                                    newUpdateReq =
                                        { updateReq | activeTo = Nothing }
                                in
                                { model | freqEditSidebar = Just ( freqId, newUpdateReq ) }

                            Nothing ->
                                model

                    else
                        model
            in
            ( { updatedModel | freqEditShowActiveTo = newShowActiveTo }
            , E.none
            )

        DeleteFreqClickedByUser freqId freqStr ->
            ( { model | deleteFreqConfirmation = Just ( freqId, freqStr ) }
            , E.none
            )

        DeleteFreqCanceledByUser ->
            ( { model | deleteFreqConfirmation = Nothing }
            , E.none
            )

        DeleteFreqConfirmedByUser ->
            case ( model.networkCreated, model.deleteFreqConfirmation ) of
                ( Just _, Just ( freqId, _ ) ) ->
                    ( { model | deleteFreqLoading = True, deleteFreqConfirmation = Nothing }
                    , E.removeFreqFromNetwork (DeleteFreqReturnedByApi freqId) { id = Just freqId, networkId = Nothing, freq = Nothing }
                    )

                _ ->
                    ( model, E.none )

        DeleteFreqReturnedByApi _ (Err e) ->
            ( { model | deleteFreqLoading = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення частоти" e
            )

        DeleteFreqReturnedByApi freqId (Ok network) ->
            ( { model
                | deleteFreqLoading = False
                , networkCreated = Just network
                , freqs =
                    RD.withDefault [] model.freqs
                        |> List.filter (\freq -> freq.networkFreqId /= freqId)
                        |> Success
              }
            , E.none
            )

        OpenFreqCreateSidebar ->
            ( { model | freqCreateSidebar = True }, E.none )

        CloseFreqCreateSidebar ->
            ( { model
                | freqCreateSidebar = False
                , freqCreateDescriptionInp = ""
                , freqCreateFormatError = Nothing
                , freqCreateShowActiveTo = False
                , freqCreateState =
                    { freq = ""
                    , kind = NetworksUtils.networkKindToString NetworksUtils.VHF
                    , modulationId = Nothing
                    , encryptionKeyIds = []
                    , description = Nothing
                    , activeFrom = Nothing
                    , activeTo = Nothing
                    }
              }
            , E.none
            )

        UpdateFreqCreateField updateFunc ->
            let
                newFreqState =
                    updateFunc model.freqCreateState

                formatError =
                    if String.trim newFreqState.freq == "" then
                        Nothing

                    else if not (NetworksUtils.validateFrequencyFormat newFreqState.freq) then
                        Just "Невірний формат частоти (наприклад: 146.5000)"

                    else
                        Nothing
            in
            ( { model
                | freqCreateState = newFreqState
                , freqCreateFormatError = formatError
              }
            , E.none
            )

        FreqCreateKindSelectMsg selectMsg ->
            let
                ( mAct, newState, selectCmd ) =
                    Select.update selectMsg model.freqCreateKindSelect.state

                updatedKind =
                    Utils.Select.singleUpdWithDefault mAct model.freqCreateKindSelect.selected

                newSelect =
                    { state = newState
                    , items = model.freqCreateKindSelect.items
                    , selected = updatedKind
                    }

                oldFreqState =
                    model.freqCreateState

                newFreqState =
                    { oldFreqState | kind = NetworksUtils.networkKindToString updatedKind }
            in
            ( { model | freqCreateKindSelect = newSelect, freqCreateState = newFreqState }
            , E.sendCmd <| Cmd.map FreqCreateKindSelectMsg selectCmd
            )

        FreqCreateModulationSelectMsg selectMsg ->
            let
                ( mAct, newState, selectCmd ) =
                    Select.update selectMsg model.freqCreateModulationSelect.state

                updatedModulation =
                    Utils.Select.singleUpd mAct model.freqCreateModulationSelect.selected

                newSelect =
                    { state = newState
                    , items = model.freqCreateModulationSelect.items
                    , selected = updatedModulation
                    }

                oldFreqState =
                    model.freqCreateState

                newFreqState =
                    { oldFreqState | modulationId = updatedModulation }
            in
            ( { model | freqCreateModulationSelect = newSelect, freqCreateState = newFreqState }
            , E.sendCmd <| Cmd.map FreqCreateModulationSelectMsg selectCmd
            )

        FreqCreateDescriptionInputChangedByUser inp ->
            ( { model | freqCreateDescriptionInp = inp }, E.none )

        ToggleFreqCreateShowActiveTo ->
            let
                newShowActiveTo =
                    not model.freqCreateShowActiveTo

                updatedFreqState =
                    if not newShowActiveTo then
                        -- очистити activeTo при знятті чекбокса
                        let
                            freqState =
                                model.freqCreateState
                        in
                        { freqState | activeTo = Nothing }

                    else
                        model.freqCreateState
            in
            ( { model
                | freqCreateShowActiveTo = newShowActiveTo
                , freqCreateState = updatedFreqState
              }
            , E.none
            )

        AddFreqToNetwork ->
            case model.networkCreated of
                Just network ->
                    let
                        -- Create description object if input is not empty
                        description =
                            if String.trim model.freqCreateDescriptionInp == "" then
                                Nothing

                            else
                                Just
                                    { descrType = B.Confirmation
                                    , description = model.freqCreateDescriptionInp
                                    , freq = model.freqCreateState.freq
                                    }

                        -- Create the API request payload
                        addFreqReq =
                            { networkId = network.id
                            , freqRec =
                                { freq = model.freqCreateState.freq
                                , kind = model.freqCreateState.kind
                                , modulationId = model.freqCreateState.modulationId
                                , encryptionKeyIds = model.freqCreateState.encryptionKeyIds
                                , description = description
                                , activeFrom = model.freqCreateState.activeFrom
                                , activeTo = model.freqCreateState.activeTo
                                }
                            }
                    in
                    ( { model | freqEditSaving = True }
                      -- Reuse existing loading state
                    , E.addFreqToNetwork FreqAddedToNetwork addFreqReq
                    )

                _ ->
                    ( model, E.none )

        FreqAddedToNetwork (Err e) ->
            ( { model | freqEditSaving = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання частоти до мережі" e
            )

        FreqAddedToNetwork (Ok network) ->
            ( { model
                | networkCreated = Just network
                , freqEditSaving = False
                , freqCreateSidebar = False
                , freqCreateDescriptionInp = ""
                , freqCreateFormatError = Nothing
                , freqCreateShowActiveTo = False
                , freqCreateState =
                    { freq = ""
                    , kind = NetworksUtils.networkKindToString NetworksUtils.VHF
                    , modulationId = Nothing
                    , encryptionKeyIds = []
                    , description = Nothing
                    , activeFrom = Nothing
                    , activeTo = Nothing
                    }
              }
            , E.batch
                [ E.getSingleNetworkFreqs FreqsReturnedByApi { networkId = network.id, includeCallsigns = Just False }
                , E.getNetworkFreqsActivity NetworkFreqsActivityReturnedByApi { networkId = network.id }
                ]
            )

        CallsignsPopupOpenedByUser networkFreqId ->
            let
                maybeFreq =
                    model.freqs
                        |> RD.withDefault []
                        |> ListX.find (\freq -> freq.networkFreqId == networkFreqId)
            in
            case maybeFreq of
                Just freq ->
                    ( { model | callsignsOpenedPopupId = Just networkFreqId }
                    , case freq.callsigns of
                        Just _ ->
                            E.none

                        Nothing ->
                            E.getNetworkFreqCallsigns NetworkFreqCallsignsReturnedByApi { networkFreqId = networkFreqId }
                    )

                Nothing ->
                    ( model, E.none )

        CallsignsPopupClosedByUser ->
            ( { model | callsignsOpenedPopupId = Nothing }, E.none )

        NetworkFreqCallsignsReturnedByApi (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження позивних частоти" e
            )

        NetworkFreqCallsignsReturnedByApi (Ok rsp) ->
            let
                updatedFreqs =
                    model.freqs
                        |> RD.withDefault []
                        |> updateFreqCallsigns rsp.networkFreqId rsp.callsigns
            in
            ( { model | freqs = Success updatedFreqs }
            , E.getCallsignsInfoShared rsp.callsigns
            )


filterFreqsByActivity : FreqActivityFilter -> List B.NetworkFreqsRes -> List B.NetworkFreqsRes
filterFreqsByActivity filter freqs =
    case filter of
        AllFreqs ->
            freqs

        ActiveFreqs ->
            List.filter .isActive freqs

        InactiveFreqs ->
            List.filter (\freq -> not freq.isActive) freqs


view : Model -> Auth.User -> Shared.Model -> Html FrequenciesMsg
view model user shared =
    section [ class "bg-w dark:bg-[#1C1C21] p-[16px] mt-[30px] flex flex-col" ]
        [ div [ class "mb-[8px] flex justify-between items-center" ]
            [ h4 [ class "" ] [ text "Частоти" ]
            , if Core.Auth.hasRole "Admin" user || Core.Auth.hasRole "UnitsEditor" user then
                Button.new { label = "Створити", onClick = OpenFreqCreateSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view

              else
                text ""
            ]
        , freqsActivityFilterView model
        , case model.freqs of
            Success freqs_ ->
                let
                    filteredFreqs =
                        filterFreqsByActivity model.freqsActivityFilter freqs_
                in
                div [ class "table-responsive-modern" ]
                    [ if List.isEmpty filteredFreqs then
                        emptyFreqsPlaceholder model.freqsActivityFilter

                      else
                        Table.view (freqsTableConfig shared model user) model.freqsTableState filteredFreqs
                    ]

            _ ->
                Shared.Components.Spinner.loadingSpinnerSm
        ]


freqsActivityFilterView : Model -> Html FrequenciesMsg
freqsActivityFilterView model =
    let
        options =
            [ { value = AllFreqs, label = "Всі" }
            , { value = ActiveFreqs, label = "Активні" }
            , { value = InactiveFreqs, label = "Неактивні" }
            ]
    in
    div [ class "flex gap-2 items-center mb-4" ]
        [ SegmentedControl.new model.freqsActivityFilter FreqsActivityFilterChangedByUser options
            |> SegmentedControl.view
        ]


deleteFreqConfirmationModal : Model -> Html FrequenciesMsg
deleteFreqConfirmationModal model =
    let
        ( isOpen, freqStr ) =
            case model.deleteFreqConfirmation of
                Just ( _, f ) ->
                    ( True, f )

                Nothing ->
                    ( False, "" )

        deleteFreqDialogContent =
            [ div [ class "flex flex-col justify-between gap-4 p-2 w-[400px]" ]
                [ div [ class "pb-6" ]
                    [ h2 [] [ text "Видалити частоту" ]
                    , p [] [ text ("Ви впевнені, що хочете видалити частоту " ++ freqStr ++ "?") ]
                    ]
                , div [ class "flex justify-between" ]
                    [ Button.new { label = "Скасувати", onClick = DeleteFreqCanceledByUser } |> Button.withStyleSecondary |> Button.view
                    , Button.new { label = "Видалити", onClick = DeleteFreqConfirmedByUser }
                        |> Button.withStyleDanger
                        |> (if model.deleteFreqLoading then
                                Button.withIcon [ Shared.Components.Spinner.loadingSpinner2Sm ]

                            else
                                identity
                           )
                        |> Button.view
                    ]
                ]
            ]
    in
    ModalDialog.modalDialog isOpen DeleteFreqCanceledByUser [] deleteFreqDialogContent


emptyFreqsPlaceholder : FreqActivityFilter -> Html msg
emptyFreqsPlaceholder filter =
    let
        message =
            case filter of
                AllFreqs ->
                    "Немає частот в мережі"

                ActiveFreqs ->
                    "Немає активних частот"

                InactiveFreqs ->
                    "Немає неактивних частот"
    in
    div
        [ class "flex flex-col items-center justify-center py-12 text-center" ]
        [ i [ class "bi bi-radio-tower text-4xl text-gray-400 mb-4" ] []
        , p [ class "text-gray-600 dark:text-gray-400 text-lg font-medium" ] [ text message ]
        , p [ class "text-gray-500 dark:text-gray-500 text-sm mt-2" ]
            [ text "Спробуйте змінити фільтр або перевірте налаштування мережі" ]
        ]


freqsTableConfig : Shared.Model -> Model -> Auth.User -> Table.Config B.NetworkFreqsRes FrequenciesMsg
freqsTableConfig shared model user =
    let
        defaultCustomizations =
            Table.defaultCustomizations

        customTheadHelp : ( String, TableConfig.Status, Html.Attribute FrequenciesMsg ) -> Html FrequenciesMsg
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

        customThead : List ( String, TableConfig.Status, Html.Attribute FrequenciesMsg ) -> TableColumn.HtmlDetails FrequenciesMsg
        customThead headers =
            TableColumn.HtmlDetails [] (List.map customTheadHelp headers)

        customRowAttrs : B.NetworkFreqsRes -> List (Html.Attribute FrequenciesMsg)
        customRowAttrs freq =
            if not freq.isActive then
                [ class "bg-[#f8f9fa] dark:bg-[#2C2C2E]" ]

            else
                []

        customizations =
            { defaultCustomizations
                | tableAttrs = [ class "base-table" ]
                , thead = customThead
                , rowAttrs = customRowAttrs
            }
    in
    Table.customConfig
        { toId = .freq
        , toMsg = SetFreqsTableState
        , columns =
            [ Table.stringColumn "Частота" .freq |> Table.withColumnWidth "9%"
            , Table.customColumn
                { name = "Модуляція"
                , viewData =
                    \freq ->
                        Maybe.withDefault "" freq.modulation
                            |> Modulations.displayModulationName
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "10%"
            , Table.veryCustomColumn
                { name = "Ключ"
                , viewData =
                    \freq ->
                        { attributes =
                            [ style "white-space" "pre-wrap"
                            , style "word-break" "break-all"
                            ]
                        , children = [ text <| String.join "\n" freq.encryptionKeys ]
                        }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "16%"
            , Table.customColumn
                { name = "Тип"
                , viewData =
                    \freq ->
                        Maybe.withDefault "" freq.kind
                            |> NetworksUtils.networkKindFromString
                            |> NetworksUtils.networkKindToLabel
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "8%"
            , Table.intColumn "Кількість перехоплень" .messageCount |> Table.withColumnWidth "6%"
            , Table.veryCustomColumn
                { name = "Позивні"
                , viewData =
                    \freq ->
                        let
                            isOpen =
                                case model.callsignsOpenedPopupId of
                                    Just openCallsignsPopup ->
                                        openCallsignsPopup == freq.networkFreqId

                                    Nothing ->
                                        False
                        in
                        case freq.callsigns of
                            Just callsigns ->
                                { attributes = []
                                , children =
                                    [ CallsignsPopup.view
                                        { isOpened = isOpen
                                        , onClose = CallsignsPopupClosedByUser
                                        , onOpen = CallsignsPopupOpenedByUser freq.networkFreqId
                                        , callsigns = callsigns
                                        , callsignsInfo = shared.callsignsInfo
                                        , masterUnits = RD.withDefault Dict.empty shared.masterUnits
                                        }
                                        (FreqsPage
                                            freq.freq
                                            (RD.withDefault Dict.empty shared.networks)
                                        )
                                    ]
                                }

                            Nothing ->
                                { attributes = []
                                , children =
                                    [ if isOpen then
                                        span
                                            [ class "text-[12px] text-slate-500" ]
                                            [ text "Завантаження..." ]

                                      else
                                        button
                                            [ class "text-[12px] underline decoration-dotted"
                                            , onClick (CallsignsPopupOpenedByUser freq.networkFreqId)
                                            ]
                                            [ text "Показати" ]
                                    ]
                                }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "12%"
            , Table.veryCustomColumn
                { name = "Останній раз в етері"
                , viewData =
                    \freq ->
                        case freq.lastDatetime of
                            Just lastDatetime ->
                                { attributes = []
                                , children = [ text <| Utils.Time.renderDateF6 shared.timeZone (Time.millisToPosix lastDatetime) ]
                                }

                            Nothing ->
                                { attributes = []
                                , children = [ text "" ]
                                }
                , sorter = TableSorter.increasingOrDecreasingBy (\freq -> Maybe.withDefault 0 freq.lastDatetime)
                }
                |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "Дата прив'язки"
                , viewData =
                    \freq ->
                        { attributes = []
                        , children = [ text <| Utils.Time.renderDateF6 shared.timeZone (Time.millisToPosix freq.createdAt) ]
                        }
                , sorter = TableSorter.increasingOrDecreasingBy .createdAt
                }
                |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "Активність"
                , viewData =
                    \freq ->
                        case model.networkFreqsActivity of
                            Success data ->
                                case Dict.get freq.freq data of
                                    Just freqActivity ->
                                        let
                                            freqActivityJson =
                                                Encode.dict identity (Encode.dict identity Encode.int) (Dict.singleton freq.freq freqActivity)
                                        in
                                        { attributes = []
                                        , children =
                                            [ div [ style "width" "150px", style "height" "60px", style "cursor" "pointer", style "position" "relative", style "border-radius" "4px", style "transition" "all 0.2s ease", onClick (OpenFreqDetailPopup freq.freq) ]
                                                [ Html.node "freq-activity-chart"
                                                    [ property "data" <| freqActivityJson
                                                    , property "lastDay" <| Encode.int shared.now
                                                    ]
                                                    []
                                                , i [ class "bi bi-zoom-in", style "position" "absolute", style "top" "0", style "right" "4px", style "font-size" "12px", style "color" "#6b7280", style "opacity" "0.7", style "pointer-events" "none", style "z-index" "10", style "transition" "all 0.2s ease" ] []
                                                ]
                                            ]
                                        }

                                    Nothing ->
                                        { attributes = []
                                        , children = [ text "Немає активності" ]
                                        }

                            _ ->
                                { attributes = []
                                , children = [ Shared.Components.Spinner.loadingSpinnerSm ]
                                }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "15%"
            , Table.veryCustomColumn
                { name = "З"
                , viewData =
                    \freq ->
                        { attributes = []
                        , children = [ text <| Utils.Time.renderDateF6 shared.timeZone (Time.millisToPosix freq.activeFrom) ]
                        }
                , sorter = TableSorter.increasingOrDecreasingBy .activeFrom
                }
                |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "По"
                , viewData =
                    \freq ->
                        case freq.activeTo of
                            Just x ->
                                { attributes = []
                                , children = [ text <| Utils.Time.renderDateF6 shared.timeZone (Time.millisToPosix x) ]
                                }

                            Nothing ->
                                { attributes = []
                                , children = [ text "" ]
                                }
                , sorter = TableSorter.increasingOrDecreasingBy (\freq -> Maybe.withDefault 0 freq.activeTo)
                }
                |> Table.withColumnWidth "8%"
            ]
                ++ (if Core.Auth.hasRole "Admin" user || Core.Auth.hasRole "UnitsEditor" user then
                        [ Table.veryCustomColumn
                            { name = "Дії"
                            , viewData =
                                \freq ->
                                    { attributes = [ class "col-narrow" ]
                                    , children =
                                        [ case model.networkCreated of
                                            Just network ->
                                                div [ class "flex gap-[4px] text-sm" ]
                                                    [ button
                                                        [ title "Редагувати"
                                                        , class "icon-btn icon-btn-primary"
                                                        , onClick <|
                                                            OpenFreqEditSidebar freq.freq
                                                                { networkId = network.id
                                                                , freq = freq.freq
                                                                , kind = Maybe.withDefault "VHF" freq.kind
                                                                , modulationId = freq.modulationId
                                                                , encryptionKeyIds = freq.encryptionKeyIds
                                                                , activeFrom = freq.activeFrom
                                                                , activeTo = freq.activeTo
                                                                }
                                                        ]
                                                        [ i [ class "bi bi-pencil-square" ] [] ]
                                                    , button
                                                        [ title "Видалити частоту"
                                                        , class "icon-btn icon-btn-danger"
                                                        , onClick (DeleteFreqClickedByUser freq.networkFreqId freq.freq)
                                                        ]
                                                        [ i [ class "bi bi-trash" ] [] ]
                                                    ]

                                            _ ->
                                                text ""
                                        ]
                                    }
                            , sorter = TableSorter.unsortable
                            }
                            |> Table.withColumnWidth "8%"
                        ]

                    else
                        []
                   )
        , customizations = customizations
        }



-- SIDEBAR CONTENT


editSidebar : Model -> Auth.User -> Shared.Model -> Html FrequenciesMsg
editSidebar model user shared =
    case model.freqEditSidebar of
        Just ( freqId, updateReq ) ->
            Sidebar.view True CloseFreqEditSidebar (freqEditSidebarContent shared model user freqId updateReq)

        Nothing ->
            text ""


createSidebar : Model -> Auth.User -> Shared.Model -> Html FrequenciesMsg
createSidebar model user shared =
    if model.freqCreateSidebar then
        Sidebar.view True CloseFreqCreateSidebar (freqCreateSidebarContent shared model user)

    else
        text ""


freqActivityChartDetailed : Model -> Shared.Model -> Html FrequenciesMsg
freqActivityChartDetailed model shared =
    case model.freqDetailPopup of
        Just freqId ->
            let
                -- Знаходимо дані активності для цієї частоти
                freqActivityData =
                    case model.networkFreqsActivity of
                        Success data ->
                            case Dict.get freqId data of
                                Just freqActivity ->
                                    let
                                        -- Використовуємо новий freq-detail-chart
                                        freqActivityJson =
                                            Encode.dict identity (Encode.dict identity Encode.int) (Dict.singleton freqId freqActivity)
                                    in
                                    div [ style "width" "100%", style "height" "300px", style "border" "1px solid #e5e7eb", style "border-radius" "8px", style "padding" "16px" ]
                                        [ h4 [ class "text-sm font-medium mb-4", style "color" "#374151" ] [ text ("Активність частоти " ++ freqId) ]
                                        , div [ style "width" "100%", style "height" "250px", style "min-height" "250px", style "display" "block" ]
                                            [ Html.node "freq-detail-chart"
                                                [ property "data" <| freqActivityJson
                                                , property "lastDay" <| Encode.int shared.now
                                                , style "width" "100%"
                                                , style "height" "100%"
                                                , style "display" "block"
                                                ]
                                                []
                                            ]
                                        ]

                                Nothing ->
                                    div [ class "text-center text-gray-500", style "height" "300px", style "display" "flex", style "align-items" "center", style "justify-content" "center" ] [ text "Немає даних активності" ]

                        _ ->
                            div [ class "text-center", style "height" "300px", style "display" "flex", style "align-items" "center", style "justify-content" "center" ] [ Shared.Components.Spinner.loadingSpinnerSm ]
            in
            ModalDialog.modalDialog True
                CloseFreqDetailPopup
                []
                [ div [ class "p-6", style "width" "600px", style "height" "400px" ]
                    [ h3 [ class "text-lg font-semibold mb-4" ] [ text ("Детальний графік активності: " ++ freqId) ]
                    , freqActivityData
                    ]
                ]

        Nothing ->
            text ""


freqEditSidebarContent : Shared.Model -> Model -> Auth.User -> String -> B.UpdateNetworkFreqReq -> List (Html FrequenciesMsg)
freqEditSidebarContent shared model _ freqId updateReq =
    [ div [ class "flex flex-col h-full" ]
        [ div [ class "p-6 border-b border-border" ]
            [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Редагувати частоту" ]
            , p [ class "text-sm text-muted-foreground" ] [ text ("Частота: " ++ freqId) ]
            ]
        , div [ class "flex-1 overflow-y-auto p-6" ]
            [ div [ class "space-y-6" ]
                [ div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Тип" ]
                    , let
                        selectedItem =
                            Just <|
                                Select.basicMenuItem
                                    { item = model.freqEditKindSelect.selected
                                    , label = NetworksUtils.networkKindToLabel model.freqEditKindSelect.selected
                                    }

                        defaultOptions =
                            Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map FreqKindSelectMsg <|
                        Styled.toUnstyled <|
                            Utils.Select.renderSelectSingle
                                selectedItem
                                model.freqEditKindSelect.state
                                model.freqEditKindSelect.items
                                "Виберіть тип"
                                defaultOptions
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Модуляція" ]
                    , let
                        selectedItem =
                            Maybe.map
                                (\modulationId ->
                                    Select.basicMenuItem
                                        { item = modulationId
                                        , label =
                                            case model.modulations of
                                                Success modulations ->
                                                    modulations
                                                        |> List.filter (\mod -> mod.id == modulationId)
                                                        |> List.head
                                                        |> Maybe.map (.name >> Modulations.displayModulationName)
                                                        |> Maybe.withDefault ""

                                                _ ->
                                                    ""
                                        }
                                )
                                model.freqEditModulationSelect.selected

                        defaultOptions =
                            Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map FreqModulationSelectMsg <|
                        Styled.toUnstyled <|
                            Utils.Select.renderSelectSingle
                                selectedItem
                                model.freqEditModulationSelect.state
                                model.freqEditModulationSelect.items
                                "Не вибрано"
                                defaultOptions
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Активна з" ]
                    , input
                        [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                        , type_ "date"
                        , Time.millisToPosix updateReq.activeFrom
                            |> Utils.Time.renderDateF4 shared.timeZone
                            |> value
                        , onInput <|
                            UpdateFreqEditSidebar
                                << (\v ->
                                        { updateReq
                                            | activeFrom =
                                                case Utils.Time.parseDateParts v of
                                                    Err _ ->
                                                        updateReq.activeFrom

                                                    Ok parts ->
                                                        Time.Extra.partsToPosix shared.timeZone parts
                                                            |> Time.posixToMillis
                                        }
                                   )
                        ]
                        []
                    ]
                , div [ class "space-y-2" ]
                    [ Checkbox.new { isChecked = model.freqEditShowActiveTo, onToggle = \_ -> ToggleFreqEditShowActiveTo }
                        |> Checkbox.withContent [ text "Частота вже не активна" ]
                        |> Checkbox.view
                    ]
                , if model.freqEditShowActiveTo then
                    div [ class "space-y-2" ]
                        [ label [ class "text-sm font-medium text-foreground" ] [ text "Активна по" ]
                        , input
                            [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                            , type_ "date"
                            , Maybe.map Time.millisToPosix updateReq.activeTo
                                |> Maybe.map (Utils.Time.renderDateF4 shared.timeZone)
                                |> Maybe.withDefault ""
                                |> value
                            , onInput <|
                                UpdateFreqEditSidebar
                                    << (\v ->
                                            { updateReq
                                                | activeTo = updateActiveToFromInput v shared.timeZone updateReq.activeTo
                                            }
                                       )
                            ]
                            []
                        ]

                  else
                    text ""
                ]
            ]
        , div [ class "p-6 border-t border-border" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseFreqEditSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , if model.freqEditSaving then
                    Button.new { label = "Збереження...", onClick = SaveFreqEditSidebar }
                        |> Button.withDisabled True
                        |> Button.view

                  else
                    Button.new { label = "Зберегти", onClick = SaveFreqEditSidebar }
                        |> Button.view
                ]
            ]
        ]
    ]


freqCreateSidebarContent : Shared.Model -> Model -> Auth.User -> List (Html FrequenciesMsg)
freqCreateSidebarContent shared model _ =
    [ div [ class "flex flex-col h-full" ]
        [ div [ class "p-6 border-b border-border" ]
            [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Додати частоту" ]
            , p [ class "text-sm text-muted-foreground" ] [ text "Заповніть інформацію про нову частоту" ]
            ]
        , div [ class "flex-1 overflow-y-auto p-6 space-y-4" ]
            [ div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Частота*" ]
                , input
                    [ type_ "text"
                    , class <|
                        "w-full p-2 border rounded "
                            ++ (if String.trim model.freqCreateState.freq == "" || model.freqCreateFormatError /= Nothing then
                                    "border-red-500"

                                else
                                    "border-border"
                               )
                    , placeholder "наприклад, 146.5000"
                    , value model.freqCreateState.freq
                    , onInput (\freq -> UpdateFreqCreateField (\state -> { state | freq = freq }))
                    ]
                    []
                , div [ class "mt-1 min-h-[20px]" ]
                    [ if String.trim model.freqCreateState.freq == "" then
                        div [ class "text-sm text-red-600" ]
                            [ text "Це поле обов'язкове" ]

                      else
                        case model.freqCreateFormatError of
                            Just error ->
                                div [ class "text-sm text-red-600" ]
                                    [ text error ]

                            Nothing ->
                                text ""
                    ]
                ]
            , div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Тип" ]
                , let
                    selectedItem =
                        Select.basicMenuItem
                            { item = model.freqCreateKindSelect.selected
                            , label = NetworksUtils.networkKindToLabel model.freqCreateKindSelect.selected
                            }

                    defaultOptions =
                        Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                  in
                  Html.map FreqCreateKindSelectMsg <|
                    Styled.toUnstyled <|
                        Utils.Select.renderSelectSingle
                            (Just selectedItem)
                            model.freqCreateKindSelect.state
                            model.freqCreateKindSelect.items
                            "Виберіть тип"
                            defaultOptions
                ]
            , div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Модуляція" ]
                , case model.modulations of
                    Success modulations ->
                        let
                            selectedItem =
                                Maybe.map
                                    (\item ->
                                        Select.basicMenuItem
                                            { item = item
                                            , label =
                                                modulations
                                                    |> List.filter (\mod -> mod.id == item)
                                                    |> List.head
                                                    |> Maybe.map (.name >> Modulations.displayModulationName)
                                                    |> Maybe.withDefault ""
                                            }
                                    )
                                    model.freqCreateModulationSelect.selected

                            defaultOptions =
                                Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                        in
                        Html.map FreqCreateModulationSelectMsg <|
                            Styled.toUnstyled <|
                                Utils.Select.renderSelectSingle
                                    selectedItem
                                    model.freqCreateModulationSelect.state
                                    model.freqCreateModulationSelect.items
                                    "Не вибрано"
                                    defaultOptions

                    _ ->
                        div [ class "text-sm text-muted-foreground" ] [ text "Завантаження модуляцій..." ]
                ]
            , div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Обґрунтування прив'язки" ]
                , textarea
                    [ class "w-full p-2 border border-border rounded resize-none"
                    , rows 3
                    , placeholder "Введіть обґрунтування прив'язки"
                    , value model.freqCreateDescriptionInp
                    , onInput FreqCreateDescriptionInputChangedByUser
                    ]
                    []
                ]
            , div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Активна з:" ]
                , input
                    [ type_ "date"
                    , class "w-full p-2 border border-border rounded"
                    , case model.freqCreateState.activeFrom of
                        Just millis ->
                            value <| Utils.Time.renderDateF4 shared.timeZone <| Time.millisToPosix millis

                        Nothing ->
                            value ""
                    , onInput <|
                        UpdateFreqCreateField
                            << (\v state ->
                                    { state
                                        | activeFrom =
                                            case Utils.Time.parseDateParts v of
                                                Err _ ->
                                                    state.activeFrom

                                                Ok parts ->
                                                    Time.Extra.partsToPosix shared.timeZone parts
                                                        |> Time.posixToMillis
                                                        |> Just
                                    }
                               )
                    ]
                    []
                ]
            , div []
                [ Checkbox.new { isChecked = model.freqCreateShowActiveTo, onToggle = \_ -> ToggleFreqCreateShowActiveTo }
                    |> Checkbox.withContent [ text "Частота вже не активна" ]
                    |> Checkbox.view
                ]
            , if model.freqCreateShowActiveTo then
                div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Активна по:" ]
                    , input
                        [ type_ "date"
                        , class "w-full p-2 border border-border rounded"
                        , case model.freqCreateState.activeTo of
                            Just millis ->
                                value <| Utils.Time.renderDateF4 shared.timeZone <| Time.millisToPosix millis

                            Nothing ->
                                value ""
                        , onInput <|
                            UpdateFreqCreateField
                                << (\v state ->
                                        { state
                                            | activeTo =
                                                case Utils.Time.parseDateParts v of
                                                    Err _ ->
                                                        state.activeTo

                                                    Ok parts ->
                                                        Time.Extra.partsToPosix shared.timeZone parts
                                                            |> Time.posixToMillis
                                                            |> Just
                                        }
                                   )
                        ]
                        []
                    ]

              else
                text ""
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseFreqCreateSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , if model.freqEditSaving then
                    Button.new { label = "Додавання...", onClick = AddFreqToNetwork }
                        |> Button.withDisabled True
                        |> Button.view

                  else
                    Button.new { label = "Додати", onClick = AddFreqToNetwork }
                        |> Button.withDisabled
                            (String.trim model.freqCreateState.freq == "" || model.freqCreateFormatError /= Nothing)
                        |> Button.view
                ]
            ]
        ]
    ]


updateActiveToFromInput : String -> Time.Zone -> Maybe Int -> Maybe Int
updateActiveToFromInput input timeZone currentValue =
    case ( String.isEmpty input, Utils.Time.parseDateParts input ) of
        ( True, _ ) ->
            Nothing

        ( False, Err _ ) ->
            currentValue

        ( False, Ok parts ) ->
            Time.Extra.partsToPosix timeZone parts
                |> Time.posixToMillis
                |> Just
