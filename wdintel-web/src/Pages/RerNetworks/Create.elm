module Pages.RerNetworks.Create exposing (Model, Msg, page)

import Auth
import Bindings as B
import Components.Button as Button
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Styled as Styled
import Layouts
import Le.Block.Select
import Le.Block.Toast
import Le.NetworksUtils as NetworksUtils
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Types exposing (ApiError)
import Page exposing (Page)
import Route exposing (Route)
import Route.Path
import Select
import Shared
import View exposing (View)


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
    , modulationSelect : Le.Block.Select.SelectTypeSingle Int
    , unitSelect : Le.Block.Select.SelectTypeSingle Int
    , modulations : RemoteData ApiError (List B.ModulationRec)
    , units : RemoteData ApiError (List B.Unit)
    }


init : Route () -> Shared.Model -> () -> ( Model, Effect Msg )
init route shared () =
    ( { formErrors = Dict.empty
      , toasts = Le.Block.Toast.init
      , createNetworkState =
            { freqs = Nothing
            , unitIds = Nothing
            , name = ""
            , location = ""
            , comment = ""
            , radioStation = Nothing
            , purpose = Nothing
            , operationMode = Nothing
            , operationType = Nothing
            , operationPeriod = Nothing
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
      , modulationSelect =
            { state = Select.initState (Select.selectIdentifier "create-network-modulation-state")
            , items = []
            , selected = Nothing
            }
      , unitSelect =
            { state = Select.initState (Select.selectIdentifier "create-network-unit-state")
            , items = []
            , selected = Nothing
            }
      , modulations = NotAsked
      , units = NotAsked
      }
    , E.batch
        [ E.getModulations ModulationsReturnedByApi
        , E.getUnits UnitsReturnedByApi
            { sortBy = Nothing
            , afterUnitId = Nothing
            , beforeUnitId = Nothing
            }
        ]
    )



-- UPDATE


type Msg
    = ToastMsg Le.Block.Toast.Msg
    | UpdateName String
    | UpdateComment String
    | UpdateRadioStation String
    | KindSelectMsg (Select.Msg NetworksUtils.NetworkKind)
    | ModulationSelectMsg (Select.Msg Int)
    | UnitSelectMsg (Select.Msg Int)
    | ModulationsReturnedByApi (Result ApiError (List B.ModulationRec))
    | UnitsReturnedByApi (Result ApiError B.ListUnitsRsp)
    | CancelClicked
    | CreateClicked


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

        UpdateName newName ->
            let
                oldState = model.createNetworkState
                newState = { oldState | name = newName }
            in
            ( { model | createNetworkState = newState }, E.none )

        UpdateComment newComment ->
            let
                oldState = model.createNetworkState
                newState = { oldState | comment = newComment }
            in
            ( { model | createNetworkState = newState }, E.none )

        UpdateRadioStation newRadioStation ->
            let
                oldState = model.createNetworkState
                newState = { oldState | radioStation = Just newRadioStation }
            in
            ( { model | createNetworkState = newState }, E.none )

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

        ModulationSelectMsg selectMsg ->
            let
                ( mAct, newState, selectCmd ) =
                    Select.update selectMsg model.modulationSelect.state

                updatedModulation =
                    Le.Block.Select.singleUpd mAct model.modulationSelect.selected

                newSelect =
                    { state = newState
                    , items = model.modulationSelect.items
                    , selected = updatedModulation
                    }
            in
            ( { model | modulationSelect = newSelect }
            , E.sendCmd <| Cmd.map ModulationSelectMsg selectCmd
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

                oldNetworkState = model.createNetworkState
                newNetworkState = { oldNetworkState | unitIds = Maybe.map List.singleton updatedUnit }
            in
            ( { model | unitSelect = newSelect, createNetworkState = newNetworkState }
            , E.sendCmd <| Cmd.map UnitSelectMsg selectCmd
            )

        ModulationsReturnedByApi (Ok modulations) ->
            let
                items =
                    modulations
                        |> List.map
                            (\mod ->
                                Select.basicMenuItem
                                    { item = mod.id
                                    , label = mod.name
                                    }
                            )

                newSelect =
                    { state = model.modulationSelect.state
                    , items = items
                    , selected = model.modulationSelect.selected
                    }
            in
            ( { model 
                | modulations = RD.Success modulations
                , modulationSelect = newSelect
              }
            , E.none
            )

        ModulationsReturnedByApi (Err error) ->
            ( { model | modulations = RD.Failure error }, E.none )

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

        CancelClicked ->
            ( model, E.none )

        CreateClicked ->
            ( model, E.none )



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none



-- VIEW


view : Auth.User -> Shared.Model -> Model -> View Msg
view user shared model =
    { title = "Створення мережі"
    , body =
        [ Le.Block.Toast.view ToastMsg model.toasts <|
            div [ class "bg-[#F5F7F9] dark:bg-[#0E0E11] rer-network min-h-screen" ]
                [ div [ class "w-[85vw] mx-auto py-[16px]" ]
                    [ div [ class "flex justify-between items-center mb-[16px]" ]
                        [ h2 [] [ text "Створення нової мережі" ]
                        , div [ class "flex gap-[8px]" ]
                            [ Button.new { label = "Відмінити", onClick = CancelClicked } |> Button.withStyleSecondary |> Button.view
                            , Button.new { label = "Зберегти", onClick = CreateClicked } |> Button.view
                            ]
                        ]
                    , div [ class "bg-w dark:bg-[#1C1C21] p-[16px]" ]
                        [ h5 [ class "mb-4" ] [ text "Поля відсутні в Id_.elm" ]
                        , div [ class "grid grid-cols-12 gap-y-2 gap-x-4 mb-6" ]
                            [ div [ class "col-span-6" ]
                                [ label [ class "mb-1" ] [ text "Назва:*" ]
                                , input 
                                    [ class "form-field"
                                    , type_ "text"
                                    , value model.createNetworkState.name
                                    , onInput UpdateName
                                    ] 
                                    []
                                ]
                            , div [ class "col-span-6" ]
                                [ label [ class "mb-1" ] [ text "Підрозділ (необов'язково)" ]
                                , Html.map UnitSelectMsg <|
                                    Styled.toUnstyled <|
                                        Le.Block.Select.renderSelectSingle
                                            (Maybe.map
                                                (\unitId ->
                                                    Select.basicMenuItem
                                                        { item = unitId
                                                        , label = 
                                                            RD.withDefault [] model.units
                                                                |> List.filter (\u -> u.id == unitId)
                                                                |> List.head
                                                                |> Maybe.map .name
                                                                |> Maybe.withDefault ""
                                                        }
                                                )
                                                model.unitSelect.selected
                                            )
                                            model.unitSelect.state
                                            model.unitSelect.items
                                            "Виберіть підрозділ"
                                            (Le.Block.Select.defaultOptions shared.isDarkMode)
                                , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "Мережу можна створити без прив'язки до підрозділу" ]
                                ]
                            , div [ class "flex flex-col gap-1 col-span-3" ]
                                [ label [] [ text "Тип" ]
                                , let
                                    selectedItem =
                                        Select.basicMenuItem
                                            { item = model.kindSelect.selected
                                            , label = NetworksUtils.networkKindToLabel model.kindSelect.selected
                                            }
                                  in
                                  Html.map KindSelectMsg <|
                                    Styled.toUnstyled <|
                                        Le.Block.Select.renderSelectSingle
                                            (Just selectedItem)
                                            model.kindSelect.state
                                            model.kindSelect.items
                                            "жоден"
                                            { clearable = False
                                            , disabled = False
                                            , isDark = shared.isDarkMode
                                            , loading = False
                                            }
                                ]
                            , div [ class "col-span-3" ]
                                [ label [ class "mb-1" ] [ text "Вид передачі" ]
                                , Html.map ModulationSelectMsg <|
                                    Styled.toUnstyled <|
                                        Le.Block.Select.renderSelectSingle
                                            (Maybe.map
                                                (\modId ->
                                                    Select.basicMenuItem
                                                        { item = modId
                                                        , label = 
                                                            RD.withDefault [] model.modulations
                                                                |> List.filter (\m -> m.id == modId)
                                                                |> List.head
                                                                |> Maybe.map .name
                                                                |> Maybe.withDefault ""
                                                        }
                                                )
                                                model.modulationSelect.selected
                                            )
                                            model.modulationSelect.state
                                            model.modulationSelect.items
                                            "жоден"
                                            (Le.Block.Select.defaultOptions shared.isDarkMode)
                                ]
                            , div [ class "col-span-6" ]
                                [ label [ class "mb-1" ] [ text "Коментар" ]
                                , input 
                                    [ class "form-field"
                                    , value model.createNetworkState.comment
                                    , onInput UpdateComment
                                    ] 
                                    []
                                ]
                            , div [ class "col-span-6" ]
                                [ label [ class "mb-1" ] [ text "Радіостанція" ]
                                , input 
                                    [ class "form-field"
                                    , value (Maybe.withDefault "" model.createNetworkState.radioStation)
                                    , onInput UpdateRadioStation
                                    ] 
                                    []
                                , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "типи радіостанцій, що використовуються підрозділом" ]
                                ]
                            ]
                        ]
                    ]
                ]
        ]
    } 