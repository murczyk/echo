module Pages.RerNetworks.Create exposing (Model, Msg, page)

import Api exposing (check_if_freq_exist)
import Auth
import Bindings as B
import Char
import Components.Button as Button
import Components.Checkbox as Checkbox
import Components.Sidebar as Sidebar
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
import Shared
import Shared.Model exposing (isDarkMode)
import Time
import Time.Extra
import View exposing (View)



-- VALIDATION


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
    { formErrors : Dict String String
    , toasts : Le.Block.Toast.Model
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

    -- Frequency creation sidebar
    , freqSidebarOpen : Bool
    , freqCreateState : B.AddNetworkFreq
    , freqKindSelect : Le.Block.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , freqModulationSelect : Le.Block.Select.SelectTypeSingle Int
    , modulations : RemoteData ApiError (List B.ModulationRec)
    , freqDescriptionInp : String
    , freqFormatError : Maybe String
    , freqShowActiveTo : Bool

    -- New states for two-stage creation
    , networkCreated : Maybe B.Network  -- нова мережа після створення
    }


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
      , toasts = Le.Block.Toast.init
      , createNetworkState =
            { freqs = []
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
      , freqSidebarOpen = shouldOpenSidebar
      , freqCreateState =
            { freq = freqToUse
            , kind = NetworksUtils.networkKindToString NetworksUtils.VHF
            , modulationId = Nothing
            , description = Nothing
            , activeFrom = Nothing
            , activeTo = Nothing
            }
      , freqKindSelect =
            { state = Select.initState (Select.selectIdentifier "freq-create-kind-state")
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
      , freqModulationSelect =
            { state = Select.initState (Select.selectIdentifier "freq-create-modulation-state")
            , items = []
            , selected = Nothing
            }
      , modulations = NotAsked
      , freqDescriptionInp = ""
      , freqFormatError = Nothing
      , freqShowActiveTo = False

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
        , E.getModulations ModulationsReturnedByApi
        , E.sendCmd (Api.aor_list AorListReturnedByApi { sortBy = Nothing })
        ]
    )



-- UPDATE


type Msg
    = ToastMsg Le.Block.Toast.Msg
    | UpdateNetworkState (B.CreateNetworkReq -> B.CreateNetworkReq)
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
      -- Frequency sidebar messages
    | OpenFreqSidebar
    | CloseFreqSidebar
    | UpdateFreqField (B.AddNetworkFreq -> B.AddNetworkFreq)
    | FreqKindSelectMsg (Select.Msg NetworksUtils.NetworkKind)
    | FreqModulationSelectMsg (Select.Msg Int)
    | FreqDescriptionInputChangedByUser String
    | ToggleFreqShowActiveTo
    | AddFreqToNetwork
    | ModulationsReturnedByApi (Result ApiError (List B.ModulationRec))


update : Shared.Model -> Msg -> Model -> ( Model, Effect Msg )
update shared msg model =
    case msg of
        ToastMsg imsg ->
            let
                ( im, icmds ) =
                    Le.Block.Toast.update imsg model.toasts
            in
            ( { model | toasts = im }
            , E.sendCmd <| Cmd.map ToastMsg icmds
            )

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
            ( { model | creatingNetwork = False }
            , E.batch
                [ E.sendCmd <| Le.Block.Toast.addWarning ToastMsg "Мережу успішно створено"
                , E.pushRoute { path = Route.Path.RerNetworks_Id_ { id = String.fromInt network.id }, hash = Nothing, query = Dict.empty }
                ]
            )

        NetworkCreated (Err error) ->
            ( { model | creatingNetwork = False }
            , E.sendCmd <| Le.Block.Toast.addError ToastMsg "Помилка при створенні мережі"
            )

        -- Frequency sidebar messages
        OpenFreqSidebar ->
            ( { model | freqSidebarOpen = True }, E.none )

        CloseFreqSidebar ->
            ( { model | freqSidebarOpen = False, freqDescriptionInp = "", freqFormatError = Nothing, freqShowActiveTo = False }, E.none )

        UpdateFreqField updateFunc ->
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
                , freqFormatError = formatError
              }
            , E.none
            )

        FreqKindSelectMsg selectMsg ->
            let
                ( mAct, newState, selectCmd ) =
                    Select.update selectMsg model.freqKindSelect.state

                updatedKind =
                    Le.Block.Select.singleUpdWithDefault mAct model.freqKindSelect.selected

                newSelect =
                    { state = newState
                    , items = model.freqKindSelect.items
                    , selected = updatedKind
                    }

                oldFreqState =
                    model.freqCreateState

                newFreqState =
                    { oldFreqState | kind = NetworksUtils.networkKindToString updatedKind }
            in
            ( { model | freqKindSelect = newSelect, freqCreateState = newFreqState }
            , E.sendCmd <| Cmd.map FreqKindSelectMsg selectCmd
            )

        FreqModulationSelectMsg selectMsg ->
            let
                ( mAct, newState, selectCmd ) =
                    Select.update selectMsg model.freqModulationSelect.state

                updatedModulation =
                    Le.Block.Select.singleUpd mAct model.freqModulationSelect.selected

                newSelect =
                    { state = newState
                    , items = model.freqModulationSelect.items
                    , selected = updatedModulation
                    }

                oldFreqState =
                    model.freqCreateState

                newFreqState =
                    { oldFreqState | modulationId = updatedModulation }
            in
            ( { model | freqModulationSelect = newSelect, freqCreateState = newFreqState }
            , E.sendCmd <| Cmd.map FreqModulationSelectMsg selectCmd
            )

        FreqDescriptionInputChangedByUser inp ->
            ( { model | freqDescriptionInp = inp }, E.none )

        ToggleFreqShowActiveTo ->
            let
                newShowActiveTo =
                    not model.freqShowActiveTo

                newFreqState =
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
                | freqShowActiveTo = newShowActiveTo
                , freqCreateState = newFreqState
              }
            , E.none
            )

        AddFreqToNetwork ->
            let
                oldNetworkState =
                    model.createNetworkState

                -- Create description object if input is not empty
                description =
                    if String.trim model.freqDescriptionInp == "" then
                        Nothing

                    else
                        Just
                            { descrType = B.Confirmation
                            , description = model.freqDescriptionInp
                            , freq = model.freqCreateState.freq
                            }

                -- Create frequency with description
                currentFreqState =
                    model.freqCreateState

                freqWithDescription =
                    { currentFreqState | description = description }

                newFreqs =
                    freqWithDescription :: oldNetworkState.freqs

                newNetworkState =
                    { oldNetworkState | freqs = newFreqs }

                -- Reset frequency form
                resetFreqState =
                    { freq = ""
                    , kind = NetworksUtils.networkKindToString NetworksUtils.VHF
                    , modulationId = Nothing
                    , description = Nothing
                    , activeFrom = Nothing
                    , activeTo = Nothing
                    }
            in
            ( { model
                | createNetworkState = newNetworkState
                , freqCreateState = resetFreqState
                , freqSidebarOpen = False
                , freqDescriptionInp = ""
                , freqFormatError = Nothing
                , freqShowActiveTo = False
              }
            , E.none
            )

        ModulationsReturnedByApi (Ok modulations) ->
            let
                items =
                    modulations
                        |> List.map
                            (\modulation ->
                                Select.basicMenuItem
                                    { item = modulation.id
                                    , label = modulation.name
                                    }
                            )

                newSelect =
                    { state = model.freqModulationSelect.state
                    , items = items
                    , selected = model.freqModulationSelect.selected
                    }
            in
            ( { model
                | modulations = RD.Success modulations
                , freqModulationSelect = newSelect
              }
            , E.none
            )

        ModulationsReturnedByApi (Err error) ->
            ( { model | modulations = RD.Failure error }, E.none )



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none



-- VIEW


view : Auth.User -> Shared.Model -> Model -> View Msg
view user shared model =
    { title = "Створення нової мережі"
    , body =
        [ Le.Block.Toast.view ToastMsg model.toasts <|
            div [ class "bg-[#F5F7F9] dark:bg-[#0E0E11] rer-network min-h-screen" ]
                [ Sidebar.view model.freqSidebarOpen CloseFreqSidebar (viewFreqSidebar shared model)
                , div [ class "w-[85vw] mx-auto py-[16px]" ]
                    [ viewHeader model

                    , viewNetworkCreatedInfo model
                    , viewMainLayout shared model


                    , if model.networkCreated /= Nothing then
                        div [] [ 
                            viewFrequenciesSection shared model
                            , viewCallsignsSection shared model
                        ]
                      else
                        text ""
                    , viewActionButtons model


                    ]
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


viewNetworkCreatedInfo : Model -> Html Msg
viewNetworkCreatedInfo model =
    case model.networkCreated of
        Just network ->
            div [ class "bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4 mb-6" ]
                [ div [ class "flex items-center justify-between" ]
                    [ div [ class "flex items-center gap-3" ]
                        [ i [ class "bi bi-check-circle text-green-600 text-xl" ] []
                        , div []
                            [ h3 [ class "text-lg font-semibold text-green-800 dark:text-green-200" ] 
                                [ text "Мережу створено успішно!" ]
                            , p [ class "text-green-700 dark:text-green-300 mt-1" ] 
                                [ text ("ID: " ++ String.fromInt network.id ++ " | Назва: " ++ network.name) ]
                            ]
                        ]
                    ]
                    , Button.new { label = "Переглянути мережу", onClick = CreateClicked }
                        |> Button.withStyleSecondary
                        |> Button.view
                ]
        
        Nothing ->
            text ""


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


viewFrequenciesSection : Shared.Model -> Model -> Html Msg
viewFrequenciesSection shared model =
    section [ class "grid grid-cols-12 gap-[30px] mt-[30px]" ]
        [ div [ class "col-span-12 bg-w dark:bg-[#1C1C21] p-[16px] flex flex-col" ]
            [ div [ class "mb-[8px] flex justify-between items-center" ]
                [ div []
                    [ h4 [] [ text "Частоти" ]
                    , if model.networkCreated /= Nothing then
                        p [ class "text-sm text-muted-foreground mt-1" ] 
                            [ text "Додавайте частоти до створеної мережі" ]
                      else
                        p [ class "text-sm text-muted-foreground mt-1" ] 
                            [ text "Додайте частоти для роботи з мережею" ]
                    ]
                , button
                    [ title "Додати частоту"
                    , class "outline-0! border-1! border-border rounded-sm! bg-transparent text-[21px]! transition-colors duration-350 hover:bg-action! hover:text-bw! py-[1px] px-[6px]"
                    , onClick OpenFreqSidebar
                    ]
                    [ i [ class "bi bi-plus-lg" ] [] ]
                ]
            , if List.isEmpty model.createNetworkState.freqs then
                div [ class "flex flex-col items-center justify-center h-48 border-2 border-dashed border-border rounded-lg text-muted-foreground bg-muted/20" ]
                    [ h3 [ class "text-lg font-semibold" ] [ text "Частоти відсутні" ]
                    , p [ class "text-sm text-muted-foreground/80" ] [ text "Додайте частоти для роботи з мережею." ]
                    , div [ class "flex justify-center mt-3" ]
                        [ Button.new { label = "Додати частоту", onClick = OpenFreqSidebar }
                            |> Button.withStyleSecondary
                            |> Button.withIcon [ i [ class "bi bi-plus-lg" ] [] ]
                            |> Button.view
                        ]
                    ]

              else
                div [ class "space-y-2" ]
                    (List.indexedMap (viewFrequencyRow shared model) model.createNetworkState.freqs
                        ++ [ div [ class "flex justify-center mt-3" ]
                                [ Button.new { label = "Додати ще", onClick = OpenFreqSidebar }
                                    |> Button.withStyleSecondary
                                    |> Button.withIcon [ i [ class "bi bi-plus-lg" ] [] ]
                                    |> Button.view
                                ]
                           ]
                    )
            ]
        ]


viewFrequencyRow : Shared.Model -> Model -> Int -> B.AddNetworkFreq -> Html Msg
viewFrequencyRow shared model index freq =
    let
        -- Get modulation name if available
        modulationName =
            case freq.modulationId of
                Just modId ->
                    case model.modulations of
                        RD.Success modulations ->
                            modulations
                                |> List.filter (\mod -> mod.id == modId)
                                |> List.head
                                |> Maybe.map .name
                                |> Maybe.withDefault "Невідома модуляція"

                        _ ->
                            "Завантаження..."

                Nothing ->
                    "Не встановлено"
    in
    div [ class "border border-border rounded p-3 bg-card" ]
        [ div [ class "flex justify-between items-start" ]
            [ div [ class "flex-1" ]
                [ div [ class "flex gap-4 mb-2" ]
                    [ div [ class "font-semibold" ] [ text freq.freq ]
                    , div [ class "text-sm text-muted-foreground" ] [ text (NetworksUtils.networkStringToLabel freq.kind) ]
                    ]
                , case freq.modulationId of
                    Just _ ->
                        div [ class "text-sm text-muted-foreground" ] [ text ("Модуляція: " ++ modulationName) ]

                    Nothing ->
                        text ""
                , case freq.description of
                    Just desc ->
                        div [ class "text-sm text-muted-foreground mt-1" ] [ text ("Обґрунтування: " ++ desc.description) ]

                    Nothing ->
                        text ""
                , case ( freq.activeFrom, freq.activeTo ) of
                    ( Just from, Just to ) ->
                        div [ class "text-sm text-muted-foreground mt-1" ]
                            [ text ("Активна: " ++ Le.Time.renderDateF5FromMillis from (Just shared.timeZone) ++ " - " ++ Le.Time.renderDateF5FromMillis to (Just shared.timeZone)) ]

                    ( Just from, Nothing ) ->
                        div [ class "text-sm text-muted-foreground mt-1" ]
                            [ text ("Активна з: " ++ Le.Time.renderDateF5FromMillis from (Just shared.timeZone)) ]

                    _ ->
                        text ""
                ]
            , button
                [ class "text-destructive hover:text-destructive/80"
                , onClick
                    (UpdateNetworkState
                        (\state ->
                            { state
                                | freqs =
                                    List.take index state.freqs ++ List.drop (index + 1) state.freqs
                            }
                        )
                    )
                , title "Видалити частоту"
                ]
                [ i [ class "bi bi-trash" ] [] ]
            ]
        ]


viewFreqSidebar : Shared.Model -> Model -> List (Html Msg)
viewFreqSidebar shared model =
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
                            ++ (if String.trim model.freqCreateState.freq == "" || model.freqFormatError /= Nothing then
                                    "border-red-500"

                                else
                                    "border-border"
                               )
                    , placeholder "наприклад, 146.5000"
                    , value model.freqCreateState.freq
                    , onInput (\freq -> UpdateFreqField (\state -> { state | freq = freq }))
                    ]
                    []
                , div [ class "mt-1 min-h-[20px]" ]
                    [ if String.trim model.freqCreateState.freq == "" then
                        div [ class "text-sm text-red-600" ]
                            [ text "Це поле обов'язкове" ]

                      else
                        case model.freqFormatError of
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
                            { item = model.freqKindSelect.selected
                            , label = NetworksUtils.networkKindToLabel model.freqKindSelect.selected
                            }

                    defaultOptions =
                        Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                  in
                  Html.map FreqKindSelectMsg <|
                    Styled.toUnstyled <|
                        Le.Block.Select.renderSelectSingle
                            (Just selectedItem)
                            model.freqKindSelect.state
                            model.freqKindSelect.items
                            "Виберіть тип"
                            { defaultOptions | clearable = False }
                ]
            , div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Модуляція" ]
                , case model.modulations of
                    RD.Success modulations ->
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
                                                    |> Maybe.map .name
                                                    |> Maybe.withDefault ""
                                            }
                                    )
                                    model.freqModulationSelect.selected

                            defaultOptions =
                                Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                        in
                        Html.map FreqModulationSelectMsg <|
                            Styled.toUnstyled <|
                                Le.Block.Select.renderSelectSingle
                                    selectedItem
                                    model.freqModulationSelect.state
                                    model.freqModulationSelect.items
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
                    , value model.freqDescriptionInp
                    , onInput FreqDescriptionInputChangedByUser
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
                            value <| Le.Time.renderDateF4 shared.timeZone <| Time.millisToPosix millis

                        Nothing ->
                            value ""
                    , onInput <|
                        UpdateFreqField
                            << (\v state ->
                                    { state
                                        | activeFrom =
                                            case Le.Time.parseDateParts v of
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
                [ Checkbox.new { isChecked = model.freqShowActiveTo, onToggle = \_ -> ToggleFreqShowActiveTo }
                    |> Checkbox.withContent [ text "Частота вже не активна" ]
                    |> Checkbox.view
                ]
            , if model.freqShowActiveTo then
                div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Активна по:" ]
                    , input
                        [ type_ "date"
                        , class "w-full p-2 border border-border rounded"
                        , case model.freqCreateState.activeTo of
                            Just millis ->
                                value <| Le.Time.renderDateF4 shared.timeZone <| Time.millisToPosix millis

                            Nothing ->
                                value ""
                        , onInput <|
                            UpdateFreqField
                                << (\v state ->
                                        { state
                                            | activeTo =
                                                case Le.Time.parseDateParts v of
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
                [ Button.new { label = "Скасувати", onClick = CloseFreqSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , Button.new { label = "Додати", onClick = AddFreqToNetwork }
                    |> Button.withDisabled
                        (String.trim model.freqCreateState.freq == "" || model.freqFormatError /= Nothing)
                    |> Button.view
                ]
            ]
        ]
    ]


viewCallsignsSection : Shared.Model -> Model -> Html Msg
viewCallsignsSection shared model =
    section [ class "bg-w dark:bg-[#1C1C21] w-full mt-[30px] p-[16px] flex flex-col" ]
        [ div [ class "mb-[8px] flex justify-between items-center" ]
            [ div []
                [ h4 [ class "" ] [ text "Позивні мережі" ]
                , p [ class "text-sm text-muted-foreground mt-1" ] 
                    [ text "Додайте позивні для роботи з мережею" ]
                ]
            , Button.new { label = "Створити", onClick = CreateClicked }
                |> Button.withStyleSecondary
                |> Button.view
            ]
        , div [ class "text-center text-gray-500 p-4" ]
            [ text "Секція позивних буде доступна після створення мережі" ]
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



-- Helper function to create the main info block for creation


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
