module Pages.Admin exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Components.Tabs as Tabs
import Components.Watermark as Watermark
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Styled as Styled
import Layouts
import Le.Block.Select
import Le.Block.Spinner
import Le.Block.Toast
import Le.RerMessage
import Le.Types exposing (..)
import Le.Utils exposing (..)
import Maybe
import Page exposing (Page)
import Route exposing (Route)
import Select
import Set exposing (Set)
import Shared
import View exposing (View)
import Views


type alias Model =
    { formErrors : Dict String String
    , toasts : Le.Block.Toast.Model
    , datasources : List ( Int, B.Datasource )
    , zones : List ( Int, B.SigintZone )
    , zoneSourcesState : Dict Int Select.State
    , zoneSourcesMenu : Dict Int (List (Select.MenuItem Int))
    , zoneSources : Dict Int (List Int)
    , datasourceGroups : Dict Int (List String)
    , zoneSourceGroupsState : Dict ( Int, Int ) Select.State
    , zoneSourceGroupsMenu : Dict ( Int, Int ) (List (Select.MenuItem String))
    , zoneSourceGroups : Dict ( Int, Int ) (List B.ZoneDatasourceGroup)
    , groupInfos : Dict String B.SignalGroupEntry
    , saveInProgress : Dict Int (Set Int)
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , toasts = Le.Block.Toast.init
      , datasources = []
      , zones = []
      , zoneSourcesState = Dict.empty
      , zoneSourcesMenu = Dict.empty
      , zoneSources = Dict.empty
      , datasourceGroups = Dict.empty
      , zoneSourceGroupsState = Dict.empty
      , zoneSourceGroupsMenu = Dict.empty
      , zoneSourceGroups = Dict.empty
      , groupInfos = Dict.empty
      , saveInProgress = Dict.empty
      }
    , E.sendCmd <|
        Api.datasource_list GotDatasourceList
    )


type Msg
    = ToastMsg Le.Block.Toast.Msg
    | GotDatasourceList (Result ApiError (List ( Int, B.Datasource )))
    | GotZoneList (Result ApiError (List ( Int, B.SigintZone )))
    | SelectDatasourceMsg Int (Select.Msg Int)
    | GotZonesDatasources Int (Result ApiError (List Int))
    | GotDatasourceGroups Int (Result ApiError (List String))
    | GotZoneDatasourceGroups Int Int (Result ApiError B.ZoneDatasourceGroupListRsp)
    | GotGroupInfos (Result ApiError B.SignalGroupsRsp)
    | Save Int
    | SaveDone Int Int (Result ApiError ())


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared req =
    Page.new
        { init = init
        , update = update
        , view = view shared.isDarkMode shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "admin"
        }


resetDatasourceGroupsSelect : Model -> Model
resetDatasourceGroupsSelect model =
    let
        f1 ( zoneId, _ ) acc =
            List.foldl (f2 zoneId) acc (Dict.get zoneId acc.zoneSources |> def [])

        f2 zoneId sourceId acc =
            let
                selId =
                    "source-zone-groups-"
                        ++ String.fromInt zoneId
                        ++ "-"
                        ++ String.fromInt sourceId

                zoneSourceGroupsMenu2 =
                    Dict.insert ( zoneId, sourceId )
                        (List.map
                            (\groupKey ->
                                Select.basicMenuItem
                                    { item = groupKey
                                    , label = Le.RerMessage.groupName groupKey acc.groupInfos
                                    }
                            )
                            (Dict.get sourceId acc.datasourceGroups |> def [])
                        )
                        acc.zoneSourceGroupsMenu
            in
            { acc
                | zoneSourceGroupsState =
                    Dict.insert ( zoneId, sourceId )
                        (Select.initState (Select.selectIdentifier selId))
                        acc.zoneSourceGroupsState
                , zoneSourceGroupsMenu = zoneSourceGroupsMenu2
            }
    in
    List.foldl f1 model model.zones


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        ToastMsg imsg ->
            let
                ( im, icmds ) =
                    Le.Block.Toast.update imsg model.toasts
            in
            ( { model | toasts = im }
            , E.sendCmd <| Cmd.map ToastMsg icmds
            )

        GotDatasourceList (Err e) ->
            Api.handleHttpError ToastMsg e model

        GotDatasourceList (Ok vs) ->
            ( { model | datasources = vs }
            , E.sendCmd <|
                Cmd.batch <|
                    Api.sigint_zones_list GotZoneList
                        :: List.map
                            (\( sourceId, _ ) ->
                                Api.datasource_group_list
                                    (GotDatasourceGroups sourceId)
                                    sourceId
                            )
                            vs
            )

        GotZoneList (Err e) ->
            Api.handleHttpError ToastMsg e model

        GotZoneList (Ok vs) ->
            ( { model
                | zones = vs
                , zoneSourcesState =
                    vs
                        |> List.map
                            (\( i, _ ) ->
                                ( i
                                , Select.initState
                                    (Select.selectIdentifier
                                        ("zone-list-" ++ String.fromInt i)
                                    )
                                )
                            )
                        |> Dict.fromList
                , zoneSourcesMenu =
                    vs
                        |> List.map
                            (\( i, _ ) ->
                                ( i
                                , List.map
                                    (\( dsId, ds ) ->
                                        Select.basicMenuItem
                                            { item = dsId
                                            , label = ds.displayName
                                            }
                                    )
                                    model.datasources
                                )
                            )
                        |> Dict.fromList
                , zoneSources =
                    vs
                        |> List.map (\( i, _ ) -> ( i, [] ))
                        |> Dict.fromList
              }
            , E.sendCmd <|
                Cmd.batch <|
                    List.map (\( i, _ ) -> Api.zones_datasources_list (GotZonesDatasources i) i) vs
            )

        SelectDatasourceMsg zoneId imsg ->
            case Dict.get zoneId model.zoneSourcesState of
                Nothing ->
                    ( model, E.none )

                Just zoneSourceState ->
                    let
                        ( mAction, imodel2, icmd ) =
                            Select.update imsg zoneSourceState

                        m2 =
                            { model
                                | zoneSourcesState =
                                    Dict.insert zoneId
                                        imodel2
                                        model.zoneSourcesState
                                , zoneSources =
                                    Dict.update zoneId
                                        (def [] >> Le.Block.Select.multiUpdI mAction >> Just)
                                        model.zoneSources
                            }

                        m3 =
                            resetDatasourceGroupsSelect m2
                    in
                    ( m3
                    , E.sendCmd <| Cmd.map (SelectDatasourceMsg zoneId) icmd
                    )

        GotZonesDatasources _ (Err e) ->
            Api.handleHttpError ToastMsg e model

        GotZonesDatasources zoneId (Ok zds) ->
            ( { model | zoneSources = Dict.insert zoneId zds model.zoneSources }
            , E.sendCmd
                (Cmd.batch
                    (zds
                        |> List.map
                            (\datasourceId ->
                                Api.zones_datasources_groups_list
                                    (GotZoneDatasourceGroups zoneId datasourceId)
                                    { zoneId = zoneId, datasourceId = datasourceId }
                            )
                    )
                )
            )

        GotDatasourceGroups _ (Err e) ->
            Api.handleHttpError ToastMsg e model

        GotDatasourceGroups sourceId (Ok groupKeys) ->
            let
                groupKeysExisting =
                    Dict.keys model.groupInfos
                        |> Set.fromList

                groupKeysNew =
                    groupKeys
                        |> Set.fromList
                        |> (\x -> Set.diff x groupKeysExisting)
                        |> Set.toList

                m2 =
                    { model
                        | datasourceGroups = Dict.insert sourceId groupKeys model.datasourceGroups
                    }

                m3 =
                    resetDatasourceGroupsSelect m2
            in
            ( m3
            , E.sendCmd <|
                Api.rer_importer_signal_group_info_batch
                    GotGroupInfos
                    { groups = groupKeysNew |> List.map (\key -> { masterKey = key }) }
            )

        GotZoneDatasourceGroups _ _ (Err e) ->
            Api.handleHttpError ToastMsg e model

        GotZoneDatasourceGroups zoneId sourceId (Ok res) ->
            let
                m2 =
                    { model
                        | zoneSourceGroups =
                            Dict.insert ( zoneId, sourceId )
                                res.zoneDatasourceGroups
                                model.zoneSourceGroups
                    }

                m3 =
                    resetDatasourceGroupsSelect m2

                signalGroupEff =
                    Api.rer_importer_signal_group_info_batch
                        GotGroupInfos
                        { groups = res.zoneDatasourceGroups |> List.map (\group -> { masterKey = group.groupMasterKey }) }
            in
            ( m3
            , E.sendCmd signalGroupEff
            )

        -- SelectGroupsMsg zoneId sourceId imsg ->
        --     case Dict.get ( zoneId, sourceId ) model.zoneSourceGroupsState of
        --         Nothing ->
        --             ( model, E.none )
        --         Just state ->
        --             let
        --                 ( mAction, imodel2, icmd ) =
        --                     Select.update imsg state
        --                 m2 =
        --                     { model
        --                         | zoneSourceGroupsState =
        --                             Dict.insert ( zoneId, sourceId )
        --                                 imodel2
        --                                 model.zoneSourceGroupsState
        --                         , zoneSourceGroups =
        --                             Dict.update ( zoneId, sourceId )
        --                                 (def [] >> Le.Block.Select.multiUpdS mAction >> Just)
        --                                 model.zoneSourceGroups
        --                     }
        --             in
        --             ( m2
        --             , E.sendCmd <| Cmd.map (SelectGroupsMsg zoneId sourceId) icmd
        --             )
        GotGroupInfos (Err e) ->
            Api.handleHttpError ToastMsg e model

        GotGroupInfos (Ok groups) ->
            let
                m2 =
                    { model | groupInfos = groups.data |> List.foldl (\group acc -> Dict.insert group.masterKey group acc) model.groupInfos }

                m3 =
                    resetDatasourceGroupsSelect m2
            in
            ( m3
            , E.none
            )

        Save zoneId ->
            let
                saveInProgress2 =
                    Dict.update zoneId
                        (always
                            (Set.fromList
                                (Dict.get zoneId model.zoneSources
                                    |> def []
                                )
                            )
                            >> Just
                        )
                        model.saveInProgress

                m2 =
                    { model | saveInProgress = saveInProgress2 }

                cmds =
                    Dict.get zoneId model.zoneSources
                        |> def []
                        |> List.map
                            (\sourceId ->
                                Dict.get ( zoneId, sourceId ) model.zoneSourceGroups
                                    |> def []
                                    |> (\groups ->
                                            -- Api.zones_datasources_groups_list_save
                                            --     (SaveDone zoneId sourceId)
                                            --     { zoneId = zoneId
                                            --     , datasourceId = sourceId
                                            --     , groups = groups
                                            --     }
                                            Cmd.none
                                       )
                            )
                        |> Cmd.batch
            in
            ( m2, E.sendCmd cmds )

        SaveDone zoneId sourceId (Err e) ->
            let
                saveInProgress2 =
                    model.saveInProgress
                        |> Dict.update zoneId (mmap (Set.remove sourceId))

                m2 =
                    { model | saveInProgress = saveInProgress2 }
            in
            Api.handleHttpError ToastMsg e m2

        SaveDone zoneId sourceId (Ok ()) ->
            let
                saveInProgress2 =
                    model.saveInProgress
                        |> Dict.update zoneId (mmap (Set.remove sourceId))

                m2 =
                    { model | saveInProgress = saveInProgress2 }
            in
            ( m2, E.none )


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none



--zoneCard : Bool -> Model -> B.User -> ( Int, B.SigintZone ) -> Html Msg
--zoneCard isDark model user ( zoneId, zone ) =
--    let
--        groupSelectBlock sourceId =
--            case Dict.get ( zoneId, sourceId ) model.zoneSourceGroupsState of
--                Nothing ->
--                    []
--
--                Just state ->
--                    let
--                        items =
--                            Dict.get ( zoneId, sourceId ) model.zoneSourceGroups
--                                |> def []
--                                |> List.map
--                                    (\groupKey ->
--                                        Select.basicMenuItem
--                                            { item = groupKey
--                                            , label =
--                                                Dict.get groupKey model.groupInfos
--                                                    |> Maybe.map .name
--                                                    |> def groupKey
--                                            }
--                                    )
--
--                        menu =
--                            Dict.get ( zoneId, sourceId ) model.zoneSourceGroupsMenu |> def []
--                    in
--                    [ Html.map (SelectGroupsMsg zoneId sourceId)
--                        (Styled.toUnstyled <|
--                            Le.Block.Select.renderSelect
--                                items
--                                state
--                                menu
--                                "жодна"
--                                (Le.Block.Select.defaultOptions isDark)
--                        )
--                    ]
--
--        renderSourceConfig sourceId =
--            case findK sourceId model.datasources of
--                Nothing ->
--                    []
--
--                Just source ->
--                    if source.kind == "signal" || source.kind == "whatsapp" then
--                        [ div [ class "d-flex justify-content-center align-items-center" ]
--                            [ div
--                                [ class "me-2 text-end"
--                                , style "width" "260px"
--                                ]
--                                [ span [ class "badge bg-secondary" ]
--                                    [ text <| source.displayName ]
--                                ]
--                            , div
--                                [ style "width" "600px"
--                                , style "font-size" ".8rem"
--                                ]
--                                (groupSelectBlock sourceId)
--                            ]
--                        ]
--
--                    else if source.kind == "api" then
--                        let
--                            groupKeys =
--                                Dict.get ( zoneId, sourceId ) model.zoneSourceGroups
--                                    |> def []
--                        in
--                        [ div [ class "d-flex justify-content-center align-items-center" ]
--                            [ div
--                                [ class "me-2 text-end"
--                                , style "width" "260px"
--                                ]
--                                [ span [ class "badge bg-secondary" ]
--                                    [ text <| source.displayName ]
--                                ]
--                            , div
--                                [ style "width" "600px"
--                                ]
--                                (List.map
--                                    (\gk ->
--                                        span [ class "badge bg-secondary me-2" ]
--                                            [ text <| Le.RerMessage.groupName gk model.groupInfos
--                                            ]
--                                    )
--                                    groupKeys
--                                )
--                            ]
--                        ]
--
--                    else
--                        []
--    in
--    case Dict.get zoneId model.zoneSourcesState of
--        Nothing ->
--            div [] []
--
--        Just state ->
--            let
--                items =
--                    Dict.get zoneId model.zoneSources
--                        |> def []
--                        |> List.map
--                            (\sourceId ->
--                                Select.basicMenuItem
--                                    { item = sourceId
--                                    , label =
--                                        findK sourceId model.datasources
--                                            |> mmap .displayName
--                                            |> def (String.fromInt sourceId)
--                                    }
--                            )
--
--                menu =
--                    Dict.get zoneId model.zoneSourcesMenu |> def []
--            in
--            div [ class "card mb-4" ]
--                [ div [ class "card-header" ]
--                    [ text <| "Напрямок: " ++ zone.name ]
--                , div [ class "card-body relative" ] <|
--                    div [ class "flex justify-center items-center mb-2" ]
--                        [ div
--                            [ class "me-2 text-end"
--                            , style "width" "260px"
--                            ]
--                            [ text "Джерела: " ]
--                        , div
--                            [ style "width" "600px"
--                            , style "font-size" ".8rem"
--                            ]
--                            [ Html.map (SelectDatasourceMsg zoneId)
--                                (Styled.toUnstyled <|
--                                    Le.Block.Select.renderSelect
--                                        items
--                                        state
--                                        menu
--                                        "жодне"
--                                        (Le.Block.Select.defaultOptions isDark)
--                                )
--                            ]
--                        ]
--                        :: List.concatMap renderSourceConfig
--                            (Dict.get zoneId model.zoneSources |> def [])
--                        ++ [ div [ class "d-flex justify-content-center align-items-center mt-4" ]
--                                [ button
--                                    [ class "btn btn-primary btn-sm"
--                                    , onClick (Save zoneId)
--                                    ]
--                                  <|
--                                    (if
--                                        Set.isEmpty
--                                            (Dict.get zoneId model.saveInProgress
--                                                |> def Set.empty
--                                            )
--                                     then
--                                        [ i [ class "bi bi-save fade-in" ] [] ]
--
--                                     else
--                                        [ Le.Block.Spinner.loadingSpinner2Sm ]
--                                    )
--                                        ++ [ text " зберегти"
--                                           ]
--                                ]
--                           ]
--                        ++ [ Watermark.new user.name |> Watermark.withPositioning ( 5, 50 ) |> Watermark.view
--                           ]
--                ]
--


zoneCard2 : Bool -> Model -> B.User -> ( Int, B.SigintZone ) -> Html Msg
zoneCard2 isDark model user zone =
    section [] []


mainBlock : Bool -> Model -> B.User -> List (Html Msg)
mainBlock isDark model user =
    List.map (zoneCard2 isDark model user) model.zones


body : Bool -> Shared.Model -> B.User -> Model -> List (Html Msg)
body dark shared user model =
    [ -- , Views.navBarAdmin dark "zones"
      Views.noHeaderAndContent ToastMsg model.toasts <|
        div [ class "mt-2" ] (mainBlock dark model user)
    ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "Адмін: напрямки"
    , body = body dark shared user model
    }
