module Pages.RerNetworks.Create exposing (Model, Msg, page)

import Api exposing (check_if_freq_exist)
import Auth
import Bindings as B
import Components.Button as Button
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
import Time
import Time.Extra
import View exposing (View)



-- VALIDATION


validateCreateNetworkReq : B.CreateNetworkReq -> Dict String String
validateCreateNetworkReq req =
    Dict.empty
        |> validateRequiredString "name" req.name
        |> validateRequiredString "location" req.location
        |> validateRequiredFreqs "freqs" req.freqs


validateRequiredString : String -> String -> Dict String String -> Dict String String
validateRequiredString fieldName value errors =
    if String.trim value == "" then
        Dict.insert fieldName "Це поле обов'язкове" errors

    else
        errors


validateRequiredFreqs : String -> List a -> Dict String String -> Dict String String
validateRequiredFreqs fieldName freqsList errors =
    if List.isEmpty freqsList then
        Dict.insert fieldName "Додайте хоча б одну частоту до мережі" errors

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
    , unitSelect : Le.Block.Select.SelectTypeSingle Int
    , postsSelect : Le.Block.Select.SelectType Int
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
    , freqInpDebounce : Debounce String
    , requestCounter : Int
    , currentRequestTracker : Maybe String
    , freqGroupsActivityForNetworkAdd : RemoteData ApiError B.FreqDailyActivityCount
    }


init : Route () -> Shared.Model -> () -> ( Model, Effect Msg )
init route shared () =
    ( { formErrors = Dict.empty
      , toasts = Le.Block.Toast.init
      , createNetworkState =
            { freqs = []
            , unitIds = Nothing
            , name = "управління"
            , location = ""
            , radioStation = Nothing
            , purpose = Just "для управління підлеглим особовим складом"
            , operationMode = Just "дуплекс"
            , operationType = Just "ведення службового радіообміну"
            , operationPeriod = Just "цілодобово"
            , activeFrom = Nothing
            , activeTo = Nothing
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
            , selected = Nothing
            }
      , postsSelect =
            { state = Select.initState (Select.selectIdentifier "create-network-posts-state")
            , items = []
            , selected = []
            }
      , units = NotAsked
      , addConfirmationInp = ""
      , addSignsInp = ""
      , creatingNetwork = False

      -- Frequency creation sidebar
      , freqSidebarOpen = False
      , freqCreateState =
            { freq = ""
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
      , freqInpDebounce = Debounce.init
      , requestCounter = 0
      , currentRequestTracker = Nothing
      , freqGroupsActivityForNetworkAdd = NotAsked
      }
    , E.batch
        [ E.getUnits UnitsReturnedByApi
            { sortBy = Nothing
            , afterUnitId = Nothing
            , beforeUnitId = Nothing
            }
        , E.loadPostsFromShared { sortBy = Nothing }
        , E.getModulations ModulationsReturnedByApi
        ]
    )


freqInpDebounceConfig : Debounce.Config Msg
freqInpDebounceConfig =
    { strategy = Debounce.later 2000
    , transform = FreqInpDebounceMsg
    }



-- UPDATE


type Msg
    = ToastMsg Le.Block.Toast.Msg
    | UpdateNetworkState (B.CreateNetworkReq -> B.CreateNetworkReq)
    | KindSelectMsg (Select.Msg NetworksUtils.NetworkKind)
    | UnitSelectMsg (Select.Msg Int)
    | PostsSelectMsg (Select.Msg Int)
    | UnitsReturnedByApi (Result ApiError B.ListUnitsRsp)
    | ConfirmationInputChangedByUser String
    | SignsInputChangedByUser String
    | DescriptionAddClickedByUser B.NetworkDescrType
    | CancelClicked
    | CreateClicked
    | NetworkCreated (Result ApiError B.Network)
      -- Frequency sidebar messages
    | OpenFreqSidebar
    | CloseFreqSidebar
    | UpdateFreqField (B.AddNetworkFreq -> B.AddNetworkFreq)
    | UpdateFreqName String
    | FreqKindSelectMsg (Select.Msg NetworksUtils.NetworkKind)
    | FreqModulationSelectMsg (Select.Msg Int)
    | AddFreqToNetwork
    | ModulationsReturnedByApi (Result ApiError (List B.ModulationRec))
    | FreqInpDebounceMsg Debounce.Msg
    | CheckIfFreqExistDone (Result ApiError ())
    | FreqGroupsActivityReturnedByApi (Result ApiError B.FreqDailyActivityCount)


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
            let
                oldActiveFrom = model.createNetworkState.activeFrom
                newState = updateFunc model.createNetworkState
                newActiveFrom = newState.activeFrom
                
                -- Check if activeFrom changed and we have a frequency to get activity for
                shouldLoadActivity = 
                    oldActiveFrom /= newActiveFrom 
                    && MaybeX.isJust newActiveFrom
                    && not (List.isEmpty newState.freqs)
                
                activityCmd = 
                    if shouldLoadActivity then
                        let
                            freq = List.head newState.freqs |> Maybe.map .freq |> Maybe.withDefault ""
                        in
                        E.getFreqActivityDaily FreqGroupsActivityReturnedByApi
                            { freq = freq
                            , sinceDateInclusiveMs = Time.posixToMillis (Le.Time.xDaysAgo 30 (Time.millisToPosix shared.now))
                            , tillDateInclusiveMs = Nothing
                            }
                    else
                        E.none
            in
            ( { model | createNetworkState = newState }
            , activityCmd
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
                    Le.Block.Select.singleUpd mAct model.unitSelect.selected

                newSelect =
                    { state = newState
                    , items = model.unitSelect.items
                    , selected = updatedUnit
                    }

                oldNetworkState =
                    model.createNetworkState

                newNetworkState =
                    { oldNetworkState | unitIds = Maybe.map List.singleton updatedUnit }
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
                validationErrors =
                    validateCreateNetworkReq model.createNetworkState
            in
            if Dict.isEmpty validationErrors then
                ( { model | creatingNetwork = True, formErrors = Dict.empty }
                , E.createNetwork NetworkCreated model.createNetworkState
                )

            else
                ( { model | formErrors = validationErrors }, E.none )

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
            ( { model | freqSidebarOpen = False }, E.none )

        UpdateFreqField updateFunc ->
            ( { model | freqCreateState = updateFunc model.freqCreateState }, E.none )

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

        AddFreqToNetwork ->
            let
                oldNetworkState =
                    model.createNetworkState

                newFreqs =
                    model.freqCreateState :: oldNetworkState.freqs

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
                
                -- Check if we should load activity data
                shouldLoadActivity = 
                    MaybeX.isJust newNetworkState.activeFrom
                    && not (List.isEmpty newFreqs)
                
                activityCmd = 
                    if shouldLoadActivity then
                        let
                            freq = List.head newFreqs |> Maybe.map .freq |> Maybe.withDefault ""
                        in
                        E.getFreqActivityDaily FreqGroupsActivityReturnedByApi
                            { freq = freq
                            , sinceDateInclusiveMs = Time.posixToMillis (Le.Time.xDaysAgo 30 (Time.millisToPosix shared.now))
                            , tillDateInclusiveMs = Nothing
                            }
                    else
                        E.none
            in
            ( { model
                | createNetworkState = newNetworkState
                , freqCreateState = resetFreqState
                , freqSidebarOpen = False
              }
            , E.batch
                [ E.sendCmd <| Le.Block.Toast.addWarning ToastMsg "Частоту додано до мережі"
                , activityCmd
                ]
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

        UpdateFreqName inp ->
            let
                ( debounce, cmd ) =
                    Debounce.push freqInpDebounceConfig inp model.freqInpDebounce

                freqCreateState =
                    model.freqCreateState

                freqCreateState2 =
                    { freqCreateState | freq = inp }

                m2 =
                    { model
                        | freqCreateState = freqCreateState2
                        , freqInpDebounce = debounce
                    }
            in
            ( m2, E.sendCmd cmd )

        FreqInpDebounceMsg imsg ->
            case model.createNetworkState.activeFrom of
                Just activeFrom ->
                    let
                        tracker =
                            "freq-" ++ String.fromInt (model.requestCounter + 1)

                        cancelPrevious =
                            case model.currentRequestTracker of
                                Just prevTracker ->
                                    Http.cancel prevTracker

                                Nothing ->
                                    Cmd.none

                        ( debounce, debounceCmd ) =
                            Debounce.update
                                freqInpDebounceConfig
                                (Debounce.takeLast
                                    (\_ ->
                                        checkIfFreqExist
                                            model.freqCreateState.freq
                                            activeFrom
                                            tracker
                                    )
                                )
                                imsg
                                model.freqInpDebounce

                        model2 =
                            { model
                                | freqInpDebounce = debounce
                                , currentRequestTracker = Just tracker
                                , requestCounter = model.requestCounter + 1
                            }
                    in
                    ( model2
                    , E.batch
                        [ E.sendCmd cancelPrevious
                        , E.sendCmd debounceCmd
                        ]
                    )

                _ ->
                    ( model, E.none )

        CheckIfFreqExistDone (Err e) ->
            Api.handleHttpError ToastMsg e model

        CheckIfFreqExistDone (Ok _) ->
            ( model, E.none )

        FreqGroupsActivityReturnedByApi (Ok r) ->
            ( { model | freqGroupsActivityForNetworkAdd = Success r }, E.none )

        FreqGroupsActivityReturnedByApi (Err err) ->
            Api.handleHttpError ToastMsg err { model | freqGroupsActivityForNetworkAdd = Failure err }


checkIfFreqExist : String -> Int -> String -> Cmd Msg
checkIfFreqExist freq sinceDate tracker =
    Api.check_if_freq_exist CheckIfFreqExistDone
        tracker
        { freq =
            freq
        , sinceDateInclusiveMs = sinceDate
        }



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
                    , viewMainLayout shared model
                    , viewFrequenciesSection model
                    ]
                ]
        ]
    }


viewHeader : Model -> Html Msg
viewHeader model =
    div [ class "flex justify-between items-center mb-[16px]" ]
        [ h2 [] [ text "Створення нової мережі" ]
        , div [ class "flex gap-[8px]" ]
            [ Button.new { label = "Відмінити", onClick = CancelClicked } |> Button.withStyleSecondary |> Button.view
            , Button.new { label = "Зберегти", onClick = CreateClicked }
                |> Button.withDisabled model.creatingNetwork
                |> Button.view
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
    div [ class "col-span-7 flex flex-col gap-[30px]" ]
        [ viewMissingFieldsBlock shared model
        , viewMainInfoBlock shared model
        , viewActivityBlock shared model
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
        [ h5 [ class "mb-4" ] [ text "Поля відсутні в стандартній формі" ]
        , div [ class "space-y-4" ]
            [ div [ class "grid grid-cols-2 gap-4" ]
                [ div []
                    ([ label [ class "mb-1" ] [ text "Назва:*" ]
                     , input
                        [ class "form__field"
                        , type_ "text"
                        , value model.createNetworkState.name
                        , onInput (\newName -> UpdateNetworkState (\state -> { state | name = newName }))
                        , isInvalidCls "name" model.formErrors
                        ]
                        []
                     ]
                        ++ fieldError "name" model.formErrors
                    )
                , div []
                    [ label [ class "mb-1" ] [ text "Підрозділ (необов'язково)" ]
                    , let
                        selectedItem =
                            Maybe.map
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
                                model.unitSelect.selected

                        defaultOptions =
                            Le.Block.Select.defaultOptions shared.isDarkMode
                      in
                      Html.map UnitSelectMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelectSingle
                                selectedItem
                                model.unitSelect.state
                                model.unitSelect.items
                                "Виберіть підрозділ"
                                defaultOptions
                    ]
                ]
            , div [ class "grid grid-cols-2 gap-4" ]
                [ div []
                    [ label [ class "mb-1" ] [ text "Радіостанція" ]
                    , input
                        [ class "form__field"
                        , value (Maybe.withDefault "" model.createNetworkState.radioStation)
                        , onInput (\newRadioStation -> UpdateNetworkState (\state -> { state | radioStation = Just newRadioStation }))
                        ]
                        []
                    ]
                , div []
                    [ label [ class "mb-1" ] [ text "Пости:" ]
                    , let
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
                            Le.Block.Select.defaultOptions shared.isDarkMode
                      in
                      Html.map PostsSelectMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelect
                                selectedItems
                                model.postsSelect.state
                                model.postsSelect.items
                                "Виберіть пости"
                                defaultOptions
                    ]
                ]
            ]
        ]


viewActivityBlock : Shared.Model -> Model -> Html Msg
viewActivityBlock shared model =
    div [ class "bg-w dark:bg-[#1C1C21] p-[16px]" ]
        [ h5 [ class "mb-4" ] [ text "Активність мережі" ]
        , div [ class "space-y-4" ]
            [ div [ class "mb-4" ]
                [ span [ class "opacity-70 text-sm" ] [ text "Виберіть дату початку функціонування мережі на основі графіку активності частоти за місяць" ]
                ]
            , div [ class "grid grid-cols-12 gap-[8px]" ]
                [ div [ class "col-span-4" ]
                    [ label [ class "mb-1" ] [ text "Активна з:" ]
                    , input
                        [ type_ "date"
                        , class "form-control w-[150px]!"
                        , required True
                        , case model.createNetworkState.activeFrom of
                            Just millis ->
                                value <| Le.Time.renderDateF4 shared.timeZone <| Time.millisToPosix millis

                            Nothing ->
                                value ""
                        , onInput <|
                            UpdateNetworkState
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
                , div [ class "col-span-4" ]
                    [ label [ class "mb-1" ] [ text "Активна по:" ]
                    , input
                        [ type_ "date"
                        , class "form-control w-[150px]!"
                        , case model.createNetworkState.activeTo of
                            Just millis ->
                                value <| Le.Time.renderDateF4 shared.timeZone <| Time.millisToPosix millis

                            Nothing ->
                                value ""
                        , onInput <|
                            UpdateNetworkState
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
                , div [ class "col-span-4" ]
                    [ text "" ]
                ]
            , div [ class "h-[300px]" ]
                [ let
                    groupsMessageCountByDayJson =
                        B.freqDailyActivityCountEncoder (RD.withDefault { dataPerDate = Dict.empty } model.freqGroupsActivityForNetworkAdd)
                  in
                  Html.node "bar-chart-2"
                    [ Attr.property "data" <| groupsMessageCountByDayJson
                    ]
                    []
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
        [ h5 [ class "" ] [ text "Обґрунтування прив'язки" ]
        , div [ class "py-[4px] mb-[8px] flex flex-col items-end gap-[4px]" ]
            [ textarea [ class "textarea__field", placeholder "Введіть обґрунтування прив'язки", value model.addConfirmationInp, onInput ConfirmationInputChangedByUser ] []
            , div [ class "flex justify-between w-full" ]
                [ div [ class "w-[200px] flex items-center gap-2" ]
                    [ div [ class "relative" ]
                        [ select [ class "form-control opacity-50", disabled True ]
                            [ option [] [ text "Виберіть частоту" ]
                            ]
                        , div [ class "absolute -top-2 -right-2" ]
                            [ span
                                [ class "text-gray-400 cursor-help"
                                , title "Додайте хоча б одну частоту до мережі"
                                ]
                                [ i [ class "bi bi-question-circle" ] [] ]
                            ]
                        ]
                    ]
                , Button.new { label = "Зберегти", onClick = DescriptionAddClickedByUser B.Confirmation }
                    |> Button.withStyleSecondary
                    |> Button.withDisabled (String.isEmpty model.addConfirmationInp)
                    |> Button.view
                ]
            ]
        , div [ class "max-h-[200px] overflow-y-auto" ]
            (List.map
                (\description ->
                    div [ class "min-h-[50px] border-b-1 border-border py-[4px]" ]
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
        [ h5 [ class "" ] [ text "Розвідувальні ознаки" ]
        , div [ class "py-[4px] mb-[8px] flex flex-col items-end gap-[4px]" ]
            [ textarea [ class "textarea__field", placeholder "Введіть розвідувальні ознаки", value model.addSignsInp, onInput SignsInputChangedByUser ] []
            , Button.new { label = "Зберегти", onClick = DescriptionAddClickedByUser B.Sign }
                |> Button.withStyleSecondary
                |> Button.withDisabled (String.isEmpty model.addSignsInp)
                |> Button.view
            ]
        , div [ class "max-h-[200px] overflow-y-auto" ]
            (List.map
                (\description ->
                    div [ class "min-h-[50px] border-b-1 border-border py-[4px]" ]
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


viewFrequenciesSection : Model -> Html Msg
viewFrequenciesSection model =
    section [ class "grid grid-cols-12 gap-[30px] mt-[30px]" ]
        [ div [ class "col-span-12 bg-w dark:bg-[#1C1C21] p-[16px] flex flex-col" ]
            [ div [ class "mb-[8px] flex justify-between items-center" ]
                [ h4 [] [ text "Частоти" ]
                , Button.new { label = "Додати частоту", onClick = OpenFreqSidebar }
                    |> Button.withStyleSecondary
                    |> Button.withDisabled (MaybeX.isNothing model.createNetworkState.activeFrom)
                    |> Button.view
                ]
            , div [] (fieldError "freqs" model.formErrors)
            , if List.isEmpty model.createNetworkState.freqs then
                div [ class "grow-1 flex justify-center items-center h-[200px] text-gray-500" ]
                    [ div [ class "text-center" ]
                        [ div [ class "text-lg mb-2" ] [ text "Частоти ще не додані" ]
                        , div [ class "text-sm" ]
                            [ case model.createNetworkState.activeFrom of
                                Nothing ->
                                    text "Заповність поле 'Активна з', щоб почати додавати частоти"

                                Just _ ->
                                    text "Натисніть 'Додати частоту' для додавання першої частоти"
                            ]
                        ]
                    ]

              else
                div [ class "space-y-2" ]
                    (List.indexedMap viewFrequencyRow model.createNetworkState.freqs)
            ]
        ]


viewFrequencyRow : Int -> B.AddNetworkFreq -> Html Msg
viewFrequencyRow index freq =
    div [ class "border border-border rounded p-3 bg-card" ]
        [ div [ class "flex justify-between items-start" ]
            [ div [ class "flex-1" ]
                [ div [ class "flex gap-4 mb-2" ]
                    [ div [ class "font-semibold" ] [ text freq.freq ]
                    , div [ class "text-sm text-muted-foreground" ] [ text freq.kind ]
                    ]
                , case freq.modulationId of
                    Just _ ->
                        div [ class "text-sm text-muted-foreground" ] [ text "Модуляція: Так" ]

                    Nothing ->
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
                    , class "w-full p-2 border border-border rounded"
                    , placeholder "наприклад, 146.500"
                    , value model.freqCreateState.freq
                    , onInput UpdateFreqName
                    ]
                    []
                ]
            , div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Тип частоти*" ]
                , let
                    selectedItem =
                        Select.basicMenuItem
                            { item = model.freqKindSelect.selected
                            , label = NetworksUtils.networkKindToLabel model.freqKindSelect.selected
                            }

                    defaultOptions =
                        Le.Block.Select.defaultOptions shared.isDarkMode
                  in
                  Html.map FreqKindSelectMsg <|
                    Styled.toUnstyled <|
                        Le.Block.Select.renderSelectSingle
                            (Just selectedItem)
                            model.freqKindSelect.state
                            model.freqKindSelect.items
                            "Виберіть тип"
                            defaultOptions
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
                                Le.Block.Select.defaultOptions shared.isDarkMode
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
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseFreqSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , Button.new { label = "Додати", onClick = AddFreqToNetwork }
                    |> Button.withDisabled (String.trim model.freqCreateState.freq == "")
                    |> Button.view
                ]
            ]
        ]
    ]



-- Helper function to create the main info block for creation


createMainInfoBlock : B.CreateNetworkReq -> Shared.Model -> Model -> List (Html Msg)
createMainInfoBlock createReq shared model =
    [ div [ class "mb-[8px] flex justify-between items-center" ]
        [ h5 []
            [ text "Згідно форми" ]
        ]
    , div
        [ class "network-list-container" ]
        [ div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%]" ] [ text "Район функціонування/розгортання:" ]
            , div [ class "flex-1" ]
                ([ input
                    [ value createReq.location
                    , onInput (\newLocation -> UpdateNetworkState (\state -> { state | location = newLocation }))
                    , class "form__field"
                    , placeholder "введіть район функціонування/розгортання"
                    , isInvalidCls "location" model.formErrors
                    ]
                    []
                 ]
                    ++ fieldError "location" model.formErrors
                )
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium  basis-[33%]" ] [ text "Призначення:" ]
            , input
                [ value <| Maybe.withDefault "" createReq.purpose
                , onInput (\newPurpose -> UpdateNetworkState (\state -> { state | purpose = Just newPurpose }))
                , class "form__field"
                , placeholder "введіть призначення"
                ]
                []
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Режим роботи радіомережі:" ]
            , input
                [ value <| Maybe.withDefault "" createReq.operationMode
                , onInput (\newOperationMode -> UpdateNetworkState (\state -> { state | operationMode = Just newOperationMode }))
                , class "form__field"
                , placeholder "введіть режим роботи радіомережі"
                ]
                []
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Характер роботи:" ]
            , input
                [ value <| Maybe.withDefault "" createReq.operationType
                , onInput (\newOperationType -> UpdateNetworkState (\state -> { state | operationType = Just newOperationType }))
                , class "form__field"
                , placeholder "введіть характер роботи"
                ]
                []
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Період функціонування:" ]
            , input
                [ value <| Maybe.withDefault "" createReq.operationPeriod
                , onInput (\newOperationPeriod -> UpdateNetworkState (\state -> { state | operationPeriod = Just newOperationPeriod }))
                , class "form__field"
                , placeholder "введіть період функціонування"
                ]
                []
            ]
        ]
    ]
