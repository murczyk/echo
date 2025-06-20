module Pages.Admin exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Components.Button as Button
import Components.ModalDialog as ModalDialog
import Components.Toggle as Toggle
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
    , userSelectorDialog : Maybe { zoneId : Int, sourceId : Int, groupKey : String, selected : List String }
    , allLogins : List String
    , userSelectorState : Select.State
    , userSelectorMenu : List (Select.MenuItem String)
    , userSelectorLoading : Bool
    , userSelectorError : Maybe String
    , groupUpdateInProgress : Maybe (Int, Int, String)
    , groupUpdateError : Maybe { zoneId : Int, sourceId : Int, groupKey : String, error : String }
    , zoneActiveTabs : Dict Int Int
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
      , userSelectorDialog = Nothing
      , allLogins = []
      , userSelectorState = Select.initState (Select.selectIdentifier "user-selector")
      , userSelectorMenu = []
      , userSelectorLoading = False
      , userSelectorError = Nothing
      , groupUpdateInProgress = Nothing
      , groupUpdateError = Nothing
      , zoneActiveTabs = Dict.empty
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
    | OpenUserSelector Int Int String (List String)
    | CloseUserSelector
    | UserSelectorSelMsg (Select.Msg String)
    | UserSelectorSave
    | UserSelectorLoginsLoaded (Result ApiError B.ListLoginsRsp)
    | UserSelectorSaveDone (Result ApiError B.ZoneDatasourceGroup)
    | ToggleGroupSecret Int Int String Bool (List String)
    | ToggleGroupSecretDone (Result ApiError B.ZoneDatasourceGroup) Int Int String
    | SwitchTab Int Int


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

        OpenUserSelector zoneId sourceId groupKey selected ->
            if List.isEmpty model.allLogins then
                ( { model | userSelectorDialog = Just { zoneId = zoneId, sourceId = sourceId, groupKey = groupKey, selected = selected }, userSelectorLoading = True, userSelectorError = Nothing }
                , E.sendCmd <| Api.list_logins UserSelectorLoginsLoaded { sortBy = Nothing }
                )
            else
                let
                    menu = List.map (\login -> Select.basicMenuItem { item = login, label = login }) model.allLogins
                in
                ( { model | userSelectorDialog = Just { zoneId = zoneId, sourceId = sourceId, groupKey = groupKey, selected = selected }, userSelectorMenu = menu, userSelectorState = Select.initState (Select.selectIdentifier "user-selector") }
                , E.none )

        UserSelectorLoginsLoaded (Ok rsp) ->
            let
                logins = List.map .login rsp.users
                menu = List.map (\login -> Select.basicMenuItem { item = login, label = login }) logins
            in
            ( { model | allLogins = logins, userSelectorMenu = menu, userSelectorLoading = False, userSelectorError = Nothing }
            , E.none )

        UserSelectorLoginsLoaded (Err e) ->
            ( { model | userSelectorLoading = False, userSelectorError = Just "Не вдалося завантажити користувачів" }
            , E.none
            )

        UserSelectorSelMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.userSelectorState

                selected =
                    Le.Block.Select.multiUpdS mAction (model.userSelectorDialog |> Maybe.map .selected |> Maybe.withDefault [])
            in
            ( { model | userSelectorState = imodel2, userSelectorDialog = model.userSelectorDialog |> Maybe.map (\d -> { d | selected = selected }) }
            , E.sendCmd <| Cmd.map UserSelectorSelMsg icmd
            )

        CloseUserSelector ->
            ( { model | userSelectorDialog = Nothing, userSelectorError = Nothing }
            , E.none
            )

        UserSelectorSave ->
            case model.userSelectorDialog of
                Just { zoneId, sourceId, groupKey, selected } ->
                    let
                        group =
                            Dict.get ( zoneId, sourceId ) model.zoneSourceGroups
                                |> def []
                                |> List.filter (\g -> g.groupMasterKey == groupKey)
                                |> List.head
                    in
                    case group of
                        Just g ->
                            let
                                req =
                                    { id = g.sigintZoneDatasourceId, isSecret = g.isGroupSecret, userLogins = selected }
                            in
                            ( model, E.sendCmd <| Api.zone_datasource_group_update UserSelectorSaveDone req )

                        Nothing ->
                            ( model, E.none )

                Nothing ->
                    ( model, E.none )

        UserSelectorSaveDone (Ok updatedGroup) ->
            let
                { sigintZoneDatasourceId, groupMasterKey } =
                    updatedGroup

                findZoneSource =
                    Dict.toList model.zoneSourceGroups
                        |> List.filterMap
                            (\( ( zid, sid ), groups ) ->
                                if List.any (\g -> g.sigintZoneDatasourceId == sigintZoneDatasourceId) groups then
                                    Just ( zid, sid )
                                else
                                    Nothing
                            )
                        |> List.head

                ( zoneId, sourceId ) =
                    case findZoneSource of
                        Just v ->
                            v

                        Nothing ->
                            ( 0, 0 )

                oldGroups =
                    Dict.get ( zoneId, sourceId ) model.zoneSourceGroups |> def []

                newGroups =
                    List.map (\g -> if g.groupMasterKey == groupMasterKey then updatedGroup else g) oldGroups

                m2 =
                    { model | userSelectorDialog = Nothing, userSelectorError = Nothing, zoneSourceGroups = Dict.insert ( zoneId, sourceId ) newGroups model.zoneSourceGroups }

                needInfo =
                    not (Dict.member updatedGroup.groupMasterKey model.groupInfos)

                eff =
                    if needInfo then
                        Api.rer_importer_signal_group_info_batch GotGroupInfos { groups = [ { masterKey = updatedGroup.groupMasterKey } ] }
                    else
                        Cmd.none
            in
            ( m2, E.sendCmd eff )

        UserSelectorSaveDone (Err e) ->
            ( { model | userSelectorError = Just "Не вдалося зберегти" }
            , E.none
            )

        ToggleGroupSecret zoneId sourceId groupKey newSecret allowedUsers ->
            let
                group =
                    Dict.get ( zoneId, sourceId ) model.zoneSourceGroups
                        |> def []
                        |> List.filter (\g -> g.groupMasterKey == groupKey)
                        |> List.head
            in
            case group of
                Just g ->
                    let
                        req =
                            { id = g.sigintZoneDatasourceId, isSecret = newSecret, userLogins = allowedUsers }
                    in
                    ( { model | groupUpdateInProgress = Just ( zoneId, sourceId, groupKey ), groupUpdateError = Nothing }
                    , E.sendCmd <| Api.zone_datasource_group_update (\res -> ToggleGroupSecretDone res zoneId sourceId groupKey) req
                    )

                Nothing ->
                    ( model, E.none )

        ToggleGroupSecretDone (Ok updatedGroup) zoneId sourceId groupKey ->
            let
                oldGroups =
                    Dict.get ( zoneId, sourceId ) model.zoneSourceGroups |> def []

                newGroups =
                    List.map (\g -> if g.groupMasterKey == groupKey then updatedGroup else g) oldGroups

                m2 =
                    { model | groupUpdateInProgress = Nothing, groupUpdateError = Nothing, zoneSourceGroups = Dict.insert ( zoneId, sourceId ) newGroups model.zoneSourceGroups }

                needInfo =
                    not (Dict.member updatedGroup.groupMasterKey model.groupInfos)

                eff =
                    if needInfo then
                        Api.rer_importer_signal_group_info_batch GotGroupInfos { groups = [ { masterKey = updatedGroup.groupMasterKey } ] }
                    else
                        Cmd.none
            in
            ( m2, E.sendCmd eff )

        ToggleGroupSecretDone (Err e) zoneId sourceId groupKey ->
            ( { model | groupUpdateInProgress = Nothing, groupUpdateError = Just { zoneId = zoneId, sourceId = sourceId, groupKey = groupKey, error = "Не вдалося зберегти" } }
            , E.none
            )

        SwitchTab zoneId sourceId ->
            ( { model | zoneActiveTabs = Dict.insert zoneId sourceId model.zoneActiveTabs }
            , E.none
            )


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none


zoneCard2 : Bool -> Model -> B.User -> ( Int, B.SigintZone ) -> Html Msg
zoneCard2 isDark model user ( zoneId, zone ) =
    let
        sources =
            Dict.get zoneId model.zoneSources
                |> def []
                |> List.filterMap
                    (\sourceId ->
                        let
                            source =
                                findK sourceId model.datasources
                        in
                        case source of
                            Nothing ->
                                Nothing

                            Just ds ->
                                Just ( sourceId, ds )
                    )

        activeSourceId =
            let
                currentActive =
                    Dict.get zoneId model.zoneActiveTabs

                firstAvailable =
                    List.head sources |> Maybe.map Tuple.first
            in
            case ( currentActive, firstAvailable ) of
                ( Just active, _ ) ->
                    if List.any (\( id, _ ) -> id == active) sources then
                        active
                    else
                        firstAvailable |> Maybe.withDefault 0

                ( Nothing, Just first ) ->
                    first

                ( Nothing, Nothing ) ->
                    0

        activeSource =
            List.filter (\( id, _ ) -> id == activeSourceId) sources
                |> List.head

        groups =
            case activeSource of
                Just ( sourceId, _ ) ->
                    Dict.get ( zoneId, sourceId ) model.zoneSourceGroups |> def []

                Nothing ->
                    []

        renderTab ( sourceId, source ) =
            let
                isActive =
                    sourceId == activeSourceId
            in
            Button.view
                ((if isActive then
                    Button.new { label = source.displayName ++ " (" ++ source.kind ++ ")", onClick = SwitchTab zoneId sourceId }
                  else
                    Button.new { label = source.displayName ++ " (" ++ source.kind ++ ")", onClick = SwitchTab zoneId sourceId }
                        |> Button.withOutlined True
                 )
                    |> Button.withDisabled (sourceId == activeSourceId)
                )

        renderGroup group =
            let
                groupName =
                    Dict.get group.groupMasterKey model.groupInfos
                        |> Maybe.map .name
                        |> def group.groupMasterKey

                isLoading =
                    case model.groupUpdateInProgress of
                        Just ( z, s, k ) ->
                            z == zoneId && s == activeSourceId && k == group.groupMasterKey

                        Nothing ->
                            False

                errorMsg =
                    case model.groupUpdateError of
                        Just err ->
                            if err.zoneId == zoneId && err.sourceId == activeSourceId && err.groupKey == group.groupMasterKey then
                                Just err.error
                            else
                                Nothing

                        Nothing ->
                            Nothing
            in
            div [ class "flex items-center border rounded-lg mb-3 p-4 bg-white shadow-sm" ]
                [ div [ class "w-1/4 flex items-center" ]
                    [ span [ class "font-semibold text-gray-900 mr-2" ] [ text groupName ]
                    , if group.isGroupSecret then
                        span [ class "ml-1 text-gray-500" ] [ text "🔒" ]
                      else
                        text ""
                    ]
                , div [ class "w-1/2 flex flex-col justify-center" ]
                    [ if group.isGroupSecret then
                        div [ class "mb-2 flex items-center" ]
                            [ span [ class "mr-2 text-sm text-gray-600" ] [ text "видима для:" ]
                            , Button.view
                                (Button.new { label = "✏️", onClick = OpenUserSelector zoneId activeSourceId group.groupMasterKey group.allowedUsers }
                                    |> Button.withOutlined True
                                )
                            ]
                      else
                        text ""
                    , if group.isGroupSecret then
                        div [ class "text-sm text-gray-700" ] [ text (String.join ", " group.allowedUsers) ]
                      else
                        text ""
                    ]
                , div [ class "w-1/4 flex items-center justify-end" ]
                    [ div [ style "pointer-events" (if isLoading then "none" else "auto") ]
                        [ Toggle.view group.isGroupSecret <|
                            Toggle.new
                                { onToggle = ToggleGroupSecret zoneId activeSourceId group.groupMasterKey (not group.isGroupSecret) group.allowedUsers
                                , label = "Прихована"
                                }
                        ]
                    , if isLoading then
                        span [ class "ml-2" ] [ Le.Block.Spinner.loadingSpinner2Sm ]
                      else
                        text ""
                    , case errorMsg of
                        Just msg ->
                            div [ class "text-red-600 text-sm mt-1 ml-2" ] [ text msg ]

                        Nothing ->
                            text ""
                    ]
                ]
    in
    div [ class "bg-white rounded-lg shadow-md mb-6 overflow-hidden" ]
        [ div [ class "bg-gray-50 px-6 py-4 border-b border-gray-200" ]
            [ h3 [ class "text-lg font-semibold text-gray-900" ]
                [ text <| "Напрямок: " ++ zone.name ]
            ]
        , if List.isEmpty sources then
            div [ class "p-6 text-center text-gray-500" ]
                [ text "Немає доступних джерел даних" ]
          else
            div []
                [ div [ class "border-b border-gray-200" ]
                    [ div [ class "flex items-center gap-1 p-1" ]
                        (List.map renderTab sources)
                    ]
                , div [ class "p-6" ]
                    (if List.isEmpty groups then
                        [ div [ class "text-center text-gray-500 py-8" ]
                            [ text "Немає груп для цього джерела" ]
                        ]
                     else
                        List.map renderGroup groups
                    )
                ]
        ]


mainBlock : Bool -> Model -> B.User -> Html Msg
mainBlock isDark model user =
    div [ class "space-y-6" ] (List.map (zoneCard2 isDark model user) model.zones)


body : Bool -> Shared.Model -> B.User -> Model -> List (Html Msg)
body dark shared user model =
    [ Views.noHeaderAndContent ToastMsg model.toasts <|
        div [ class "mt-2" ] [ mainBlock dark model user ]
    ]
        ++ (case model.userSelectorDialog of
                Just dialog ->
                    [ ModalDialog.modalDialog True CloseUserSelector []
                        [ div [ class "p-4" ]
                            [ div [ class "mb-2 font-semibold text-gray-900" ] [ text "Виберіть користувачів, яким видима група" ]
                            , if model.userSelectorLoading then
                                div [ class "text-gray-600" ] [ text "Завантаження..." ]
                              else
                                div [ class "max-h-96 overflow-y-auto" ]
                                    [ Html.map UserSelectorSelMsg <|
                                        Styled.toUnstyled <|
                                            Le.Block.Select.renderSelectVirtual
                                                (List.map (\login -> Select.basicMenuItem { item = login, label = login }) dialog.selected)
                                                model.userSelectorState
                                                model.userSelectorMenu
                                                "користувачі"
                                                { loading = False, disabled = False, isDark = dark }
                                    ]
                            , case model.userSelectorError of
                                Just err ->
                                    div [ class "text-red-600 mt-2" ] [ text err ]

                                Nothing ->
                                    text ""
                            , div [ class "mt-3 flex justify-end gap-2" ]
                                [ Button.view
                                    (Button.new { label = "Скасувати", onClick = CloseUserSelector }
                                        |> Button.withOutlined True
                                    )
                                , Button.view
                                    (Button.new { label = "Зберегти", onClick = UserSelectorSave }
                                    )
                                ]
                            ]
                        ]
                    ]

                Nothing ->
                    []
           )


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "Адмін: напрямки"
    , body = body dark shared user model
    }
