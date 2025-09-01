module Pages.RerNetworks.Create exposing (Model, Msg, page)

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
import Le.ErrorHandling
import Le.NetworksUtils as NetworksUtils
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Time
import Le.Types exposing (ApiError)
import Maybe.Extra as MaybeX
import Page exposing (Page)
import RerNetworks.Create.CallsignsTables as CallsignsTables
import RerNetworks.Create.FrequenciesTable as FrequenciesTable
import RerNetworks.Create.Model exposing (FreqActivityFilter(..), Mode(..))
import RerNetworks.Create.Msg exposing (Msg(..))
import Route exposing (Route)
import Route.Path
import Select
import Set exposing (Set)
import Shared
import Shared.Model exposing (isDarkMode)
import Time
import Time.Extra
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
        , update = update shared
        , subscriptions = subscriptions
        , view = view user shared
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "rer"
        }



-- MODEL


type alias Model =
    RerNetworks.Create.Model.Model


init : Route () -> Shared.Model -> () -> ( Model, Effect Msg )
init route shared () =
    let
        -- Parse frequency from query parameters
        freqFromQuery =
            Dict.get "freq" route.query

        -- Determine if sidebar should be open and pre-filled
        shouldOpenSidebar =
            freqFromQuery /= Nothing

        freqToUse =
            Maybe.withDefault "" freqFromQuery
    in
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
            , postIds = []
            , descriptions = []
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
            , selected = NetworksUtils.VHF
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
      , freqCreateSidebar = shouldOpenSidebar
      , freqCreateState =
            { freq = freqToUse
            , kind = NetworksUtils.networkKindToString NetworksUtils.VHF
            , modulationId = Nothing
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
            , selected = NetworksUtils.VHF
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
            , selected = NetworksUtils.VHF
            }
      , freqEditModulationSelect =
            { state = Select.initState (Select.selectIdentifier "freq-edit-modulation-select-state")
            , items = []
            , selected = Nothing
            }
      , freqEditShowActiveTo = False
      , modulations = NotAsked
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
            , selected = NetworksUtils.VHF
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
      }
    , E.batch
        [ E.getUnits UnitsReturnedByApi
            { sortBy = Nothing
            , afterUnitId = Nothing
            , beforeUnitId = Nothing
            }
        , E.loadPostsFromShared { sortBy = Nothing }
        , E.sendCmd (Api.aor_list AorListReturnedByApi { sortBy = Nothing })
        , E.getModulations ModulationsReturnedByApi
        , E.map Callsigns CallsignsTables.initLoad
        ]
    )



-- UPDATE


type alias Msg =
    RerNetworks.Create.Msg.Msg


update : Shared.Model -> Msg -> Model -> ( Model, Effect Msg )
update shared msg model =
    case msg of
        Frequencies freqsMsg ->
            let
                ( m1, freqsEff ) =
                    FrequenciesTable.update shared freqsMsg model
            in
            ( m1, E.map Frequencies freqsEff )

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
                    Le.Block.Select.singleUpdWithDefault mAct model.kindSelect.selected

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
                    Le.Block.Select.multiUpdI mAct model.unitSelect.selected

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
                    Le.Block.Select.multiUpdI mAct model.postsSelect.selected

                postsSelect =
                    model.postsSelect

                -- Update items from shared.posts if needed (similar to Id_.elm pattern)
                items =
                    case ( postsSelect.items, shared.posts ) of
                        ( [], RD.Success posts ) ->
                            if List.length (Dict.toList posts) > 0 then
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
                    Le.Block.Select.multiUpdI mAct model.aorSelect.selected

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
                            , description = model.addConfirmationInp
                            }

                        B.Sign ->
                            { descrType = B.Sign
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
            ( model, E.none )

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

        NetworkCreated (Ok network) ->
            ( { model | creatingNetwork = False, networkCreated = Just network }
            , case model.networkCreated of
                Just network_ ->
                    E.pushRoute { path = Route.Path.RerNetworks_Id_ { id = String.fromInt network.id }, hash = Nothing, query = Dict.empty }

                Nothing ->
                    E.batch
                        ([]
                            ++ (FrequenciesTable.loadFreqsInit network.id
                                    |> List.map (E.map Frequencies)
                               )
                            ++ (CallsignsTables.getCatalogAndNetworkCallsigns network.id
                                    |> List.map (E.map Callsigns)
                               )
                        )
            )

        NetworkCreated (Err error) ->
            ( { model | creatingNetwork = False }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка створення мережі" error
            )

        ModulationsReturnedByApi (Err e) ->
            ( { model | modulations = Failure e }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження модуляцій" e
            )

        ModulationsReturnedByApi (Ok res) ->
            let
                modulationSelect =
                    model.freqEditModulationSelect

                updatedModulationSelect =
                    { modulationSelect
                        | items = List.map (\mod -> Select.basicMenuItem { item = mod.id, label = mod.name }) res
                    }

                freqCreateModulationSelect =
                    model.freqCreateModulationSelect

                updatedFreqCreateModulationSelect =
                    { freqCreateModulationSelect
                        | items = List.map (\mod -> Select.basicMenuItem { item = mod.id, label = mod.name }) res
                    }
            in
            ( { model
                | modulations = Success res
                , freqEditModulationSelect = updatedModulationSelect
                , freqCreateModulationSelect = updatedFreqCreateModulationSelect
              }
            , E.none
            )



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions model =
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
viewHeader model =
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
                    ([ input
                        [ class "form-input w-full h-[40px]"
                        , type_ "text"
                        , value model.createNetworkState.name
                        , onInput (\newName -> UpdateNetworkState (\state -> { state | name = newName }))
                        , onBlur (ValidateField "name")
                        , isInvalidCls "name" model.formErrors
                        , placeholder "введіть назву"
                        ]
                        []
                     ]
                        ++ fieldError "name" model.formErrors
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
                            Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map AorSelectMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelect
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
                                                case RD.withDefault [] model.units of
                                                    units ->
                                                        List.filter (\u -> u.id == unitId) units
                                                            |> List.head
                                                            |> Maybe.map .name
                                                            |> Maybe.withDefault (String.fromInt unitId)
                                            }
                                    )

                        defaultOptions =
                            Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map UnitSelectMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelect
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
                            Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map PostsSelectMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelect
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

        disabledTooltip =
            if model.creatingNetwork then
                "Збереження..."

            else if String.trim model.createNetworkState.name == "" then
                "Введіть назву мережі"

            else if String.trim model.createNetworkState.location == "" then
                "Введіть район функціонування/розгортання"

            else if Maybe.withDefault [] model.createNetworkState.areaOfResponsibilityIds |> List.isEmpty then
                "Оберіть смугу відповідальності"

            else
                ""

        buttonLabel =
            if model.networkCreated /= Nothing then
                "Зберегти мережу"

            else
                "Продовжити"
    in
    div [ class "flex justify-end gap-[8px] mt-[16px]" ]
        [ Button.new { label = "Відмінити", onClick = CancelClicked } |> Button.withStyleSecondary |> Button.view
        , div [ Attr.title disabledTooltip ]
            [ Button.new { label = buttonLabel, onClick = CreateClicked }
                |> Button.withDisabled isSaveDisabled
                |> Button.view
            ]
        ]



-- Helper functions for working with Maybe (List AddNetworkFreq)


createMainInfoBlock : B.CreateNetworkReq -> Shared.Model -> Model -> List (Html Msg)
createMainInfoBlock createReq shared model =
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
                ([ input
                    [ value createReq.location
                    , onInput (\newLocation -> UpdateNetworkState (\state -> { state | location = newLocation }))
                    , onBlur (ValidateField "location")
                    , class "form-input w-full  h-[40px]"
                    , placeholder "введіть район функціонування/розгортання"
                    , isInvalidCls "location" model.formErrors
                    ]
                    []
                 ]
                    ++ fieldError "location" model.formErrors
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
