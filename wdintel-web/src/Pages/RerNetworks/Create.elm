module Pages.RerNetworks.Create exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Html.Styled as Styled
import Layouts
import Page exposing (Page)
import Pages_.RerNetworks.Create.CallsignsTables as CallsignsTables
import Pages_.RerNetworks.Create.FrequenciesTable as FrequenciesTable
import Pages_.RerNetworks.Create.Model exposing (FreqActivityFilter(..), Mode(..))
import Pages_.RerNetworks.Create.Msg exposing (Msg(..))
import Route exposing (Route)
import Route.Path
import Select
import Set
import Shared
import Shared.Components.Button as Button
import Shared.Components.Pager as Pager
import Shared.Components.Spinner
import Shared.Components.Table as Table
import Shared.Model exposing (isDarkMode)
import Utils.Api.ErrorHandling
import Utils.Components exposing (fieldError, isInvalidCls)
import Utils.Modulations as Modulations
import Utils.NetworksUtils as NetworksUtils
import Utils.RerNetworkDetails
import Utils.RemoteData as RD exposing (RemoteData(..))
import Utils.Select
import View exposing (View)


type alias ValidationResult =
    { errors : Dict String String
    , isValid : Bool
    }


validateCreateNetworkReq : B.CreateNetworkReq -> ValidationResult
validateCreateNetworkReq req =
    let
        errors =
            Dict.empty
                |> validateRequiredString "name" req.name
                |> validateRequiredString "location" req.location
    in
    { errors = errors
    , isValid = Dict.isEmpty errors
    }



-- Helper function to check if form is valid for save button


isFormValid : B.CreateNetworkReq -> Bool
isFormValid req =
    let
        hasAor =
            case req.areaOfResponsibilityIds of
                Just ids ->
                    not (List.isEmpty ids)

                Nothing ->
                    False
    in
    not
        (String.trim req.name
            == ""
            || String.trim req.location
            == ""
            || not hasAor
        )



-- Helper function to check if network has at least one frequency


hasAtLeastOneFrequency : Model -> Bool
hasAtLeastOneFrequency model =
    case model.freqs of
        RD.Success freqs ->
            List.length freqs > 0

        _ ->
            False


validateRequiredString : String -> String -> Dict String String -> Dict String String
validateRequiredString fieldName value errors =
    if String.trim value == "" then
        Dict.insert fieldName "Це поле обов'язкове" errors

    else
        errors


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared route =
    Page.new
        { init = init route shared
        , update = update shared route
        , subscriptions = subscriptions
        , view = view user shared
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "networks"
        }



-- MODEL


type alias Model =
    Pages_.RerNetworks.Create.Model.Model


init : Route () -> Shared.Model -> () -> ( Model, Effect Msg )
init _ _ () =
    ( { formErrors = Dict.empty
      , createNetworkState =
            { freqs = Nothing
            , unitIds = Nothing
            , areaOfResponsibilityIds = Nothing
            , name = "управління"
            , location = ""
            , radioStation = Nothing
            , purpose = Just "для управління підлеглим особовим складом"
            , operationMode = Just "дуплекс"
            , operationType = Just "ведення службового радіообміну"
            , operationPeriod = Just "цілодобово"
            , doNotArchive = False
            , postIds = []
            , descriptions = []
            , unitMask = []
            }
      , kindSelect =
            { state = Select.initState (Select.selectIdentifier "create-network-kind-state")
            , items =
                NetworksUtils.networkKinds
                    |> List.map
                        (\kind ->
                            Select.basicMenuItem
                                { item = kind
                                , label = NetworksUtils.networkKindToLabel kind
                                }
                        )
            , selected = NetworksUtils.NFM
            }
      , unitSelect =
            { state = Select.initState (Select.selectIdentifier "create-network-unit-state")
            , items = []
            , selected = []
            }
      , postsSelect =
            { state = Select.initState (Select.selectIdentifier "create-network-posts-state")
            , items = []
            , selected = []
            }
      , aorSelect =
            { state = Select.initState (Select.selectIdentifier "create-network-aor-state")
            , items = []
            , selected = []
            }
      , aorList = NotAsked
      , units = NotAsked
      , addConfirmationInp = ""
      , addSignsInp = ""
      , creatingNetwork = False

      -- Frequency creation sidebar
      , freqCreateSidebar = False
      , freqCreateState =
            { freq = ""
            , modulation = NetworksUtils.networkKindToString NetworksUtils.NFM
            , encryptionId = Nothing
            , encryptionKeyIds = []
            , description = Nothing
            , activeFrom = Nothing
            , activeTo = Nothing
            }
      , freqCreateKindSelect =
            { state = Select.initState (Select.selectIdentifier "freq-create-kind-select-state")
            , items =
                NetworksUtils.networkKinds
                    |> List.map
                        (\kind ->
                            Select.basicMenuItem
                                { item = kind
                                , label = NetworksUtils.networkKindToLabel kind
                                }
                        )
            , selected = NetworksUtils.NFM
            }
      , freqCreateModulationSelect =
            { state = Select.initState (Select.selectIdentifier "freq-create-modulation-select-state")
            , items = []
            , selected = Nothing
            }
      , freqCreateDescriptionInp = ""
      , freqCreateFormatError = Nothing
      , freqCreateShowActiveTo = False
      , networkFreqsActivity = NotAsked
      , freqs = NotAsked
      , freqsActivityFilter = AllFreqs
      , freqsTableState = Table.initialSort "Частота"
      , freqsEditingState = Readonly
      , freqEditSaving = False
      , deleteFreqConfirmation = Nothing
      , deleteFreqLoading = False
      , callsignsOpenedPopupId = Nothing
      , freqEditSidebar = Nothing
      , freqDetailPopup = Nothing
      , freqEditKindSelect =
            { state = Select.initState (Select.selectIdentifier "freq-edit-kind-select-state")
            , items =
                NetworksUtils.networkKinds
                    |> List.map
                        (\kind ->
                            Select.basicMenuItem
                                { item = kind
                                , label = NetworksUtils.networkKindToLabel kind
                                }
                        )
            , selected = NetworksUtils.NFM
            }
      , freqEditModulationSelect =
            { state = Select.initState (Select.selectIdentifier "freq-edit-modulation-select-state")
            , items = []
            , selected = Nothing
            }
      , freqEditShowActiveTo = False
      , encryptions = NotAsked
      , addConfirmationFreqSelect =
            { state = Select.initState (Select.selectIdentifier "add-confirmation-freq-select-state")
            , items = []
            , selected = Nothing
            }

      -- CALLSIGNS
      , callsigns = NotAsked
      , callsignsPager = Pager.initWithPageSize 5
      , callsignsTableState = Table.initialSort "Позивний"
      , developingCallsignDropdown = Nothing
      , unknownCallsignDropdown = Nothing
      , unknownCallsignsShowMessages = False
      , unknownCallsignsSortByMessages = False
      , deleteCallsignConfirmation = Nothing
      , deleteCallsignLoading = False
      , networkCallsigns = NotAsked
      , networkCallsignsTableState = Table.initialSort "Позивний"
      , networkCallsignsPager = Pager.initWithPageSize 5
      , networkCallsignsSearchQuery = ""
      , editCallsignSidebar = Nothing
      , editCallsignState = Nothing
      , editCallsignSaving = False
      , editCallsignErrors = Dict.empty
      , editCallsignSourceSelState = Select.initState (Select.selectIdentifier "edit-callsign-source-state")
      , editCallsignUnitSelState = Select.initState (Select.selectIdentifier "edit-callsign-unit-state")
      , editCallsignUnitSelectorVisible = False
      , editKindSelect =
            { state = Select.initState (Select.selectIdentifier "edit-network-kind-state")
            , items =
                NetworksUtils.networkKinds
                    |> List.map
                        (\kind ->
                            Select.basicMenuItem
                                { item = kind
                                , label = NetworksUtils.networkKindToLabel kind
                                }
                        )
            , selected = NetworksUtils.NFM
            }
      , editPostsSelect =
            { state = Select.initState (Select.selectIdentifier "edit-network-posts-state")
            , items = []
            , selected = []
            }
      , editUnitsSelect =
            { state = Select.initState (Select.selectIdentifier "edit-network-units-state")
            , items = []
            , selected = []
            }
      , callsignCreateSidebar = Nothing
      , callsignCreateState = Nothing
      , callsignCreateSaving = False
      , callsignCreateErrors = Dict.empty
      , callsignCreateSourceSelState = Select.initState (Select.selectIdentifier "create-callsign-source-state")
      , callsignCreateUnitSelState = Select.initState (Select.selectIdentifier "create-callsign-unit-state")
      , callsignCreateUnitSelectorVisible = False
      , callsignCreateSources = []
      , callsignAddingInProgress = Set.empty
      , callsignsSearchQuery = ""
      , rowShowAllPopupStatus = Nothing

      -- New states for two-stage creation
      , networkCreated = Nothing
      , deletingNetwork = False
      }
    , E.batch
        [ E.getUnits UnitsReturnedByApi
            { sortBy = Nothing
            , afterUnitId = Nothing
            , beforeUnitId = Nothing
            , includeInactive = False
            , filterActive = Nothing
            , filterText = Nothing
            , filterName = Nothing
            , filterOther = Nothing
            , filterTeamOrCrew = Nothing
            , filterSection = Nothing
            , filterSquad = Nothing
            , filterPlatoon = Nothing
            , filterCompany = Nothing
            , filterBattalion = Nothing
            , filterRegiment = Nothing
            , filterBrigade = Nothing
            , filterDivision = Nothing
            , filterCorps = Nothing
            , filterArmy = Nothing
            , filterMilitaryDistrict = Nothing
            , filterArmyRegion = Nothing
            , filterComment = Nothing
            , filterOrbitNote = Nothing
            , filterIsDeduplicateCandidate = Nothing
            , filterHasOrbit = Nothing
            , filterHasOrbitNote = Nothing
            , searchMode = Nothing
            , limit = Nothing
            , offset = Nothing
            }
        , E.loadPostsFromShared { sortBy = Nothing }
        , E.sendCmd (Api.aor_list AorListReturnedByApi { sortBy = Nothing })
        , E.getEncryptions EncryptionsReturnedByApi
        , E.map Callsigns CallsignsTables.initLoad
        ]
    )



-- UPDATE


type alias Msg =
    Pages_.RerNetworks.Create.Msg.Msg


update : Shared.Model -> Route () -> Msg -> Model -> ( Model, Effect Msg )
update shared route msg model =
    case msg of
        Frequencies freqsMsg ->
            let
                ( m1, freqsEff ) =
                    FrequenciesTable.update shared freqsMsg model

                loadCatalogCallsigns =
                    case ( FrequenciesTable.doNeedReloadCatalogCallsigns freqsMsg, m1.networkCreated ) of
                        ( True, Just network ) ->
                            E.map Callsigns <| CallsignsTables.loadCatalogCallsigns network.id

                        _ ->
                            E.none
            in
            ( m1, E.batch [ E.map Frequencies freqsEff, loadCatalogCallsigns ] )

        Callsigns callsMsg ->
            let
                ( m1, callsEff ) =
                    CallsignsTables.update shared callsMsg model
            in
            ( m1, E.map Callsigns callsEff )

        UpdateNetworkState updateFunc ->
            ( { model | createNetworkState = updateFunc model.createNetworkState }
            , E.none
            )

        KindSelectMsg selectMsg ->
            let
                ( mAct, newState, selectCmd ) =
                    Select.update selectMsg model.kindSelect.state

                updatedNetworkKind =
                    Utils.Select.singleUpdWithDefault mAct model.kindSelect.selected

                newSelect =
                    { state = newState
                    , items = model.kindSelect.items
                    , selected = updatedNetworkKind
                    }
            in
            ( { model | kindSelect = newSelect }
            , E.sendCmd <| Cmd.map KindSelectMsg selectCmd
            )

        UnitSelectMsg selectMsg ->
            let
                ( mAct, newState, selectCmd ) =
                    Select.update selectMsg model.unitSelect.state

                updatedUnit =
                    Utils.Select.multiUpdI mAct model.unitSelect.selected

                newSelect =
                    { state = newState
                    , items = model.unitSelect.items
                    , selected = updatedUnit
                    }

                oldNetworkState =
                    model.createNetworkState

                newNetworkState =
                    { oldNetworkState
                        | unitIds =
                            if List.isEmpty updatedUnit then
                                Nothing

                            else
                                Just updatedUnit
                    }
            in
            ( { model | unitSelect = newSelect, createNetworkState = newNetworkState }
            , E.sendCmd <| Cmd.map UnitSelectMsg selectCmd
            )

        PostsSelectMsg selectMsg ->
            let
                ( mAct, newState, selectCmd ) =
                    Select.update selectMsg model.postsSelect.state

                updatedPosts =
                    Utils.Select.multiUpdI mAct model.postsSelect.selected

                postsSelect =
                    model.postsSelect

                -- Update items from shared.posts if needed (similar to Id_.elm pattern)
                items =
                    case ( postsSelect.items, shared.posts ) of
                        ( [], RD.Success posts ) ->
                            if Dict.size posts > 0 then
                                List.map (\post -> Select.basicMenuItem { item = post.id, label = post.name }) (Dict.values posts)

                            else
                                postsSelect.items

                        _ ->
                            postsSelect.items

                newSelect =
                    { state = newState
                    , items = items
                    , selected = updatedPosts
                    }

                oldNetworkState =
                    model.createNetworkState

                newNetworkState =
                    { oldNetworkState | postIds = updatedPosts }
            in
            ( { model | postsSelect = newSelect, createNetworkState = newNetworkState }
            , E.sendCmd <| Cmd.map PostsSelectMsg selectCmd
            )

        AorSelectMsg selectMsg ->
            let
                ( mAct, newState, selectCmd ) =
                    Select.update selectMsg model.aorSelect.state

                updatedAors =
                    Utils.Select.multiUpdI mAct model.aorSelect.selected

                newSelect =
                    { state = newState
                    , items = model.aorSelect.items
                    , selected = updatedAors
                    }

                oldNetworkState =
                    model.createNetworkState

                newNetworkState =
                    { oldNetworkState
                        | areaOfResponsibilityIds =
                            if List.isEmpty updatedAors then
                                Nothing

                            else
                                Just updatedAors
                    }
            in
            ( { model | aorSelect = newSelect, createNetworkState = newNetworkState }
            , E.sendCmd <| Cmd.map AorSelectMsg selectCmd
            )

        AorListReturnedByApi (Ok aors) ->
            let
                items =
                    aors |> List.map (\a -> Select.basicMenuItem { item = a.id, label = a.name })

                sel =
                    model.aorSelect
            in
            ( { model | aorList = RD.Success aors, aorSelect = { sel | items = items } }, E.none )

        AorListReturnedByApi (Err e) ->
            ( { model | aorList = RD.Failure e }, E.none )

        UnitsReturnedByApi (Ok response) ->
            let
                items =
                    response.units
                        |> List.map
                            (\unit ->
                                Select.basicMenuItem
                                    { item = unit.id
                                    , label = unit.name
                                    }
                            )

                newSelect =
                    { state = model.unitSelect.state
                    , items = items
                    , selected = model.unitSelect.selected
                    }
            in
            ( { model
                | units = RD.Success response.units
                , unitSelect = newSelect
              }
            , E.none
            )

        UnitsReturnedByApi (Err error) ->
            ( { model | units = RD.Failure error }, E.none )

        ConfirmationInputChangedByUser inp ->
            ( { model | addConfirmationInp = inp }, E.none )

        SignsInputChangedByUser inp ->
            ( { model | addSignsInp = inp }, E.none )

        DescriptionAddClickedByUser descType ->
            let
                description =
                    case descType of
                        B.Confirmation ->
                            { descrType = B.Confirmation
                            , topic = Nothing
                            , description = model.addConfirmationInp
                            }

                        B.Sign ->
                            { descrType = B.Sign
                            , topic = Nothing
                            , description = model.addSignsInp
                            }

                oldState =
                    model.createNetworkState

                newDescriptions =
                    description :: oldState.descriptions

                newState =
                    { oldState | descriptions = newDescriptions }

                clearedModel =
                    case descType of
                        B.Confirmation ->
                            { model | addConfirmationInp = "", createNetworkState = newState }

                        B.Sign ->
                            { model | addSignsInp = "", createNetworkState = newState }
            in
            ( clearedModel, E.none )

        CancelClicked ->
            case model.networkCreated of
                Just network ->
                    -- Сценарій 2: Спочатку видалити мережу, потім перейти назад
                    ( { model | deletingNetwork = True }
                    , E.deleteNetwork NetworkDeleted { networkId = network.id }
                    )

                Nothing ->
                    -- Сценарій 1: Просто перейти назад
                    ( model
                    , E.pushRoute { path = Route.Path.RerNetworks, hash = Nothing, query = Dict.empty }
                    )

        CreateClicked ->
            let
                validationResult =
                    validateCreateNetworkReq model.createNetworkState
            in
            if validationResult.isValid then
                ( { model | creatingNetwork = True, formErrors = Dict.empty }
                , E.createNetwork NetworkCreated model.createNetworkState
                )

            else
                ( { model | formErrors = validationResult.errors }, E.none )

        ValidateField fieldName ->
            let
                validationResult =
                    validateCreateNetworkReq model.createNetworkState

                fieldError =
                    Dict.get fieldName validationResult.errors

                updatedErrors =
                    case fieldError of
                        Just error ->
                            Dict.insert fieldName error model.formErrors

                        Nothing ->
                            Dict.remove fieldName model.formErrors
            in
            ( { model | formErrors = updatedErrors }, E.none )

        NavigateToIdPage ->
            case model.networkCreated of
                Just network ->
                    ( model
                    , E.pushRoute
                        { path = Route.Path.RerNetworks_Id_ { id = String.fromInt network.id }
                        , hash = Nothing
                        , query = Utils.RerNetworkDetails.query shared.rerNetworkDetailsPreferredView
                        }
                    )

                Nothing ->
                    ( model, E.none )

        NetworkCreated (Ok network) ->
            let
                -- Check if there's a freq parameter in URL
                freqFromQuery =
                    Dict.get "freq" route.query

                -- Update model based on URL parameter
                ( updatedModel, urlEffect ) =
                    case freqFromQuery of
                        Just freq ->
                            let
                                currentFreqState =
                                    model.freqCreateState

                                updatedFreqState =
                                    { currentFreqState | freq = freq }
                            in
                            ( { model
                                | creatingNetwork = False
                                , networkCreated = Just network
                                , freqCreateSidebar = True
                                , freqCreateState = updatedFreqState
                              }
                            , E.pushRoute { path = Route.Path.RerNetworks_Create, hash = Nothing, query = Dict.empty }
                            )

                        Nothing ->
                            ( { model | creatingNetwork = False, networkCreated = Just network }
                            , E.none
                            )
            in
            ( updatedModel
            , E.batch
                (urlEffect
                    :: ((FrequenciesTable.loadFreqsInit network.id
                            |> List.map (E.map Frequencies)
                        )
                            ++ (CallsignsTables.loadCatalogAndNetworkCallsigns network.id
                                    |> List.map (E.map Callsigns)
                               )
                       )
                )
            )

        NetworkCreated (Err error) ->
            ( { model | creatingNetwork = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка створення мережі" error
            )

        EncryptionsReturnedByApi (Err e) ->
            ( { model | encryptions = Failure e }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження модуляцій" e
            )

        EncryptionsReturnedByApi (Ok res) ->
            let
                modulationSelect =
                    model.freqEditModulationSelect

                updatedModulationSelect =
                    { modulationSelect
                        | items =
                            List.map
                                (\mod ->
                                    Select.basicMenuItem
                                        { item = mod.id
                                        , label = mod.name
                                        }
                                )
                                res
                    }

                freqCreateModulationSelect =
                    model.freqCreateModulationSelect

                updatedFreqCreateModulationSelect =
                    { freqCreateModulationSelect
                        | items =
                            List.map
                                (\mod ->
                                    Select.basicMenuItem
                                        { item = mod.id
                                        , label = mod.name
                                        }
                                )
                                res
                    }
            in
            ( { model
                | encryptions = Success res
                , freqEditModulationSelect = updatedModulationSelect
                , freqCreateModulationSelect = updatedFreqCreateModulationSelect
              }
            , E.none
            )

        NetworkDeleted (Ok _) ->
            ( { model | deletingNetwork = False }
            , E.pushRoute { path = Route.Path.RerNetworks, hash = Nothing, query = Dict.empty }
            )

        NetworkDeleted (Err error) ->
            ( { model | deletingNetwork = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення мережі" error
            )



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none



-- VIEW


view : Auth.User -> Shared.Model -> Model -> View Msg
view user shared model =
    { title = "Створення нової мережі"
    , body =
        [ div [ class "bg-[#F5F7F9] dark:bg-[#0E0E11] rer-network min-h-screen" ]
            [ div [ class "w-[85vw] mx-auto py-[16px]" ]
                [ viewHeader model
                , viewMainLayout shared model
                , if model.networkCreated /= Nothing then
                    div []
                        [ Html.map Frequencies <| FrequenciesTable.view model user shared
                        , Html.map Callsigns <| CallsignsTables.view model user shared
                        ]

                  else
                    text ""
                , viewActionButtons model
                ]
            , Html.map Frequencies <| FrequenciesTable.editSidebar model user shared
            , Html.map Frequencies <| FrequenciesTable.createSidebar model user shared
            , Html.map Frequencies <| FrequenciesTable.deleteFreqConfirmationModal model
            , Html.map Frequencies <| FrequenciesTable.freqActivityChartDetailed model shared
            , Html.map Callsigns <| CallsignsTables.createCallsignsSidebar model user shared
            , Html.map Callsigns <| CallsignsTables.editCallsignsSidebar model user shared
            , Html.map Callsigns <| CallsignsTables.deleteCallsignModal model
            ]
        ]
    }


viewHeader : Model -> Html Msg
viewHeader _ =
    div [ class "flex justify-between items-center mb-[16px]" ]
        [ div []
            [ h2 [] [ text "Створення нової мережі" ]
            ]
        ]


viewMainLayout : Shared.Model -> Model -> Html Msg
viewMainLayout shared model =
    div [ class "grid grid-cols-12 gap-[30px]" ]
        [ viewLeftColumn shared model
        , viewRightColumn model
        ]


viewLeftColumn : Shared.Model -> Model -> Html Msg
viewLeftColumn shared model =
    div [ class "col-span-7 flex flex-col gap-[16px]" ]
        [ viewMissingFieldsBlock shared model
        , viewMainInfoBlock shared model
        ]


viewRightColumn : Model -> Html Msg
viewRightColumn model =
    div [ class "col-span-5 bg-w dark:bg-[#1C1C21] p-[16px]" ]
        [ viewConfirmationBlock model
        , viewSignsBlock model
        , viewSignalsBlock
        ]


viewMissingFieldsBlock : Shared.Model -> Model -> Html Msg
viewMissingFieldsBlock shared model =
    div [ class "bg-w dark:bg-[#1C1C21] p-[16px]" ]
        [ div [ class "mb-[8px] flex justify-between items-center" ]
            [ h5 [] [ text "Загальне" ]
            ]
        , div [ class "space-y-3" ]
            [ div [ class "grid grid-cols-3 gap-x-4 items-center" ]
                [ span [ class "text-[13px] font-medium" ]
                    [ text "Назва"
                    , span [ class "text-red-500 ml-1" ] [ text "*" ]
                    ]
                , div [ class "col-span-2" ]
                    (input
                        [ class "form-input w-full h-[40px]"
                        , type_ "text"
                        , value model.createNetworkState.name
                        , onInput (\newName -> UpdateNetworkState (\state -> { state | name = newName }))
                        , onBlur (ValidateField "name")
                        , isInvalidCls "name" model.formErrors
                        , placeholder "введіть назву"
                        ]
                        []
                        :: fieldError "name" model.formErrors
                    )
                ]
            , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
                [ span [ class "text-[13px] font-medium" ] [ text "Радіостанція" ]
                , div [ class "col-span-2" ]
                    [ input
                        [ class "form-input w-full h-[40px]"
                        , value (Maybe.withDefault "" model.createNetworkState.radioStation)
                        , onInput (\newRadioStation -> UpdateNetworkState (\state -> { state | radioStation = Just newRadioStation }))
                        , placeholder "введіть радіостанцію"
                        ]
                        []
                    ]
                ]
            , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
                [ span [ class "text-[13px] font-medium" ]
                    [ text "Смуги"
                    , span [ class "text-red-500 ml-1" ] [ text "*" ]
                    ]
                , div [ class "col-span-2" ]
                    [ let
                        selectedItems =
                            model.aorSelect.selected
                                |> List.map
                                    (\aorId ->
                                        Select.basicMenuItem
                                            { item = aorId
                                            , label =
                                                case model.aorList of
                                                    RD.Success aors ->
                                                        aors
                                                            |> List.filter (\a -> a.id == aorId)
                                                            |> List.head
                                                            |> Maybe.map .name
                                                            |> Maybe.withDefault (String.fromInt aorId)

                                                    _ ->
                                                        String.fromInt aorId
                                            }
                                    )

                        defaultOptions =
                            Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map AorSelectMsg <|
                        Styled.toUnstyled <|
                            Utils.Select.renderSelect
                                selectedItems
                                model.aorSelect.state
                                model.aorSelect.items
                                "виберіть смуги"
                                defaultOptions
                    ]
                ]
            , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
                [ span [ class "text-[13px] font-medium" ] [ text "Підрозділи" ]
                , div [ class "col-span-2" ]
                    [ let
                        selectedItems =
                            model.unitSelect.selected
                                |> List.map
                                    (\unitId ->
                                        Select.basicMenuItem
                                            { item = unitId
                                            , label =
                                                let
                                                    units =
                                                        RD.withDefault [] model.units
                                                in
                                                List.filter (\u -> u.id == unitId) units
                                                    |> List.head
                                                    |> Maybe.map .name
                                                    |> Maybe.withDefault (String.fromInt unitId)
                                            }
                                    )

                        defaultOptions =
                            Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map UnitSelectMsg <|
                        Styled.toUnstyled <|
                            Utils.Select.renderSelect
                                selectedItems
                                model.unitSelect.state
                                model.unitSelect.items
                                "виберіть підрозділи"
                                defaultOptions
                    ]
                ]
            , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
                [ span [ class "text-[13px] font-medium" ] [ text "Пости:" ]
                , div [ class "col-span-2" ]
                    [ let
                        selectedItems =
                            model.postsSelect.selected
                                |> List.map
                                    (\postId ->
                                        Select.basicMenuItem
                                            { item = postId
                                            , label =
                                                case shared.posts of
                                                    RD.Success posts ->
                                                        Dict.get postId posts
                                                            |> Maybe.map .name
                                                            |> Maybe.withDefault (String.fromInt postId)

                                                    _ ->
                                                        String.fromInt postId
                                            }
                                    )

                        defaultOptions =
                            Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map PostsSelectMsg <|
                        Styled.toUnstyled <|
                            Utils.Select.renderSelect
                                selectedItems
                                model.postsSelect.state
                                model.postsSelect.items
                                "виберіть пости"
                                defaultOptions
                    ]
                ]
            ]
        ]


viewMainInfoBlock : Shared.Model -> Model -> Html Msg
viewMainInfoBlock shared model =
    div [ class "bg-w dark:bg-[#1C1C21] p-[16px]" ]
        (createMainInfoBlock model.createNetworkState shared model)


viewConfirmationBlock : Model -> Html Msg
viewConfirmationBlock model =
    div [ class "mb-[16px]" ]
        [ h5 [ class "mb-3" ] [ text "Обґрунтування прив'язки" ]
        , div [ class "space-y-3" ]
            [ textarea [ class "textarea__field", placeholder "Введіть обґрунтування прив'язки", value model.addConfirmationInp, onInput ConfirmationInputChangedByUser ] []
            , div [ class "flex justify-end" ]
                [ Button.new { label = "Зберегти", onClick = DescriptionAddClickedByUser B.Confirmation }
                    |> Button.withStyleSecondary
                    |> Button.withDisabled (String.isEmpty model.addConfirmationInp)
                    |> Button.view
                ]
            ]
        , div [ class "max-h-[200px] overflow-y-auto space-y-2" ]
            (List.map
                (\description ->
                    div [ class "min-h-[50px] p-3 bg-muted rounded-md" ]
                        [ div [ class "opacity-70 flex gap-[4px] items-center mb-2" ]
                            [ span [] [ text "Для мережі" ]
                            ]
                        , div []
                            [ text description.description ]
                        ]
                )
                (List.filter (\desc -> desc.descrType == B.Confirmation) model.createNetworkState.descriptions)
            )
        ]


viewSignsBlock : Model -> Html Msg
viewSignsBlock model =
    div []
        [ h5 [ class "mb-3" ] [ text "Розвідувальні ознаки" ]
        , div [ class "space-y-3" ]
            [ textarea [ class "textarea__field", placeholder "Введіть розвідувальні ознаки", value model.addSignsInp, onInput SignsInputChangedByUser ] []
            , div [ class "flex justify-end" ]
                [ Button.new { label = "Зберегти", onClick = DescriptionAddClickedByUser B.Sign }
                    |> Button.withStyleSecondary
                    |> Button.withDisabled (String.isEmpty model.addSignsInp)
                    |> Button.view
                ]
            ]
        , div [ class "max-h-[200px] overflow-y-auto space-y-2" ]
            (List.map
                (\description ->
                    div [ class "min-h-[50px] p-3 bg-muted rounded-md" ]
                        [ div [ class "opacity-70 flex gap-[4px] items-center mb-2" ]
                            [ span [] [ text "Для мережі" ]
                            ]
                        , div []
                            [ text description.description ]
                        ]
                )
                (List.filter (\desc -> desc.descrType == B.Sign) model.createNetworkState.descriptions)
            )
        ]


viewSignalsBlock : Html Msg
viewSignalsBlock =
    section [ class "mt-[8px]" ]
        [ h5 [] [ text "Сигнали" ]
        , div [ class "h-[100px] overflow-y-auto" ]
            [ div [ class "text-center text-gray-500 p-4" ]
                [ text "Сигнали будуть доступні після створення мережі" ]
            ]
        ]


viewActionButtons : Model -> Html Msg
viewActionButtons model =
    let
        isSaveDisabled =
            model.creatingNetwork || not (isFormValid model.createNetworkState)

        hasFrequencies =
            hasAtLeastOneFrequency model

        disabledTooltip =
            if model.creatingNetwork then
                "Збереження..."

            else if String.trim model.createNetworkState.name == "" then
                "Введіть назву мережі"

            else if String.trim model.createNetworkState.location == "" then
                "Введіть район функціонування/розгортання"

            else if Maybe.withDefault [] model.createNetworkState.areaOfResponsibilityIds |> List.isEmpty then
                "Оберіть смугу відповідальності"

            else if not hasFrequencies then
                "Додайте мінімум одну частоту до мережі"

            else
                ""
    in
    div [ class "flex justify-end gap-[8px] mt-[16px]" ]
        [ Button.new { label = "Відмінити", onClick = CancelClicked }
            |> Button.withStyleSecondary
            |> Button.withDisabled model.deletingNetwork
            |> Button.withIcon
                (if model.deletingNetwork then
                    [ Shared.Components.Spinner.loadingSpinner2Sm ]

                 else
                    []
                )
            |> Button.view
        , div [ Attr.title disabledTooltip ]
            [ case model.networkCreated of
                Just _ ->
                    Button.new { label = "Зберегти", onClick = NavigateToIdPage }
                        |> Button.withDisabled (isSaveDisabled || not hasFrequencies)
                        |> Button.view

                Nothing ->
                    Button.new { label = "Продовжити", onClick = CreateClicked }
                        |> Button.withDisabled isSaveDisabled
                        |> Button.withIcon
                            (if model.creatingNetwork then
                                [ Shared.Components.Spinner.loadingSpinner2Sm ]

                             else
                                []
                            )
                        |> Button.view
            ]
        ]



-- Helper functions for working with Maybe (List AddNetworkFreq)


createMainInfoBlock : B.CreateNetworkReq -> Shared.Model -> Model -> List (Html Msg)
createMainInfoBlock createReq _ model =
    [ div [ class "mb-[8px] flex justify-between items-center" ]
        [ h5 []
            [ text "Згідно форми" ]
        ]
    , div [ class "space-y-3" ]
        [ div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ]
                [ text "Район функціонування/розгортання"
                , span [ class "text-red-500 ml-1" ] [ text "*" ]
                ]
            , div [ class "col-span-2" ]
                (input
                    [ value createReq.location
                    , onInput (\newLocation -> UpdateNetworkState (\state -> { state | location = newLocation }))
                    , onBlur (ValidateField "location")
                    , class "form-input w-full  h-[40px]"
                    , placeholder "введіть район функціонування/розгортання"
                    , isInvalidCls "location" model.formErrors
                    ]
                    []
                    :: fieldError "location" model.formErrors
                )
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Призначення:" ]
            , input
                [ value <| Maybe.withDefault "" createReq.purpose
                , onInput (\newPurpose -> UpdateNetworkState (\state -> { state | purpose = Just newPurpose }))
                , class "form-input col-span-2 h-[40px]"
                , placeholder "введіть призначення"
                ]
                []
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Режим роботи радіомережі:" ]
            , input
                [ value <| Maybe.withDefault "" createReq.operationMode
                , onInput (\newOperationMode -> UpdateNetworkState (\state -> { state | operationMode = Just newOperationMode }))
                , class "form-input col-span-2 h-[40px]"
                , placeholder "введіть режим роботи радіомережі"
                ]
                []
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Характер роботи:" ]
            , input
                [ value <| Maybe.withDefault "" createReq.operationType
                , onInput (\newOperationType -> UpdateNetworkState (\state -> { state | operationType = Just newOperationType }))
                , class "form-input col-span-2 h-[40px]"
                , placeholder "введіть характер роботи"
                ]
                []
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Період функціонування:" ]
            , input
                [ value <| Maybe.withDefault "" createReq.operationPeriod
                , onInput (\newOperationPeriod -> UpdateNetworkState (\state -> { state | operationPeriod = Just newOperationPeriod }))
                , class "form-input col-span-2 h-[40px]"
                , placeholder "введіть період функціонування"
                ]
                []
            ]
        ]
    ]
