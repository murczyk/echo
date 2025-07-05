module Pages.Admin exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Components.Button as Button
import Components.ModalDialog as ModalDialog
import Components.Tabs as Tabs
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
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.RerMessage
import Le.Types exposing (..)
import Le.Utils as Utils exposing (..)
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
    , userSelectorDialog : Maybe { zoneId : Int, sourceId : Int, groupKey : String }
    , allLogins : List String
    , userSelectorSelect :
        { selectState : Select.State
        , items : List (Select.MenuItem String)
        , selectedItems : List String
        }
    , userSelectorLoading : Bool
    , userSelectorError : Maybe String
    , groupUpdateInProgress : Maybe ( Int, Int, String )
    , groupUpdateError : Maybe { zoneId : Int, sourceId : Int, groupKey : String, error : String }
    , zoneActiveTabs : Dict Int Int
    , showOnlyHidden : Bool
    , groupNameFilter : String
    , orphanGroups : RemoteData ApiError (List B.OrphanSignalGroupEntry)
    , orphanGroupAssignmentInProgress : Maybe String  -- Track which group is being assigned
    , orphanGroupAssignmentError : Maybe String
    , groupRemovalConfirmation : Maybe { zoneId : Int, datasourceId : Int, groupKey : String, groupName : String }
    , orphanGroupZoneSelector : Maybe { groupKey : String, selectedZones : List Int }

    }


renderGroup : Model -> Int -> Int -> B.ZoneDatasourceGroup -> Html Msg
renderGroup model zoneId activeSourceId group =
    let
        groupName : String
        groupName =
            Dict.get group.groupMasterKey model.groupInfos
                |> Maybe.map .name
                |> def group.groupMasterKey
                |> (\name ->
                        if String.isEmpty name then
                            String.right 5 group.groupMasterKey

                        else
                            name
                   )

        isLoading : Bool
        isLoading =
            case model.groupUpdateInProgress of
                Just ( z, s, k ) ->
                    z == zoneId && s == activeSourceId && k == group.groupMasterKey

                Nothing ->
                    False
    in
    div [ class "flex items-center border rounded-lg mb-3 p-4 bg-[var(--bs-tertiary-bg)]" ]
        [ div [ class "w-1/4 flex items-center" ]
            [ span [ class "font-semibold mr-2" ] [ text groupName ]
            , if group.isGroupSecret then
                span [ class "ml-1 text-lg" ] [ i [ class "bi bi-eye-slash-fill" ] [] ]

              else
                text ""
            ]
        , div [ class "w-1/2 flex flex-col justify-center" ]
            [ if group.isGroupSecret then
                div [ class "mb-2 flex items-center" ]
                    [ span [ class "mr-2 text-sm" ] [ text "видима для:" ]
                    , span
                        [ class "cursor-pointer ml-2"
                        , onClick (OpenUserSelector zoneId activeSourceId group.groupMasterKey group.allowedUsers)
                        ]
                        [ i [ class "bi bi-pencil-square text-action" ] [] ]
                    ]

              else
                text ""
            , if group.isGroupSecret then
                div [ class "text-sm" ] [ text (String.join ", " group.allowedUsers) ]

              else
                text ""
            ]
        , div [ class "w-1/4 flex items-center justify-end gap-4" ]
            [ div
                [ style "pointer-events"
                    (if isLoading then
                        "none"

                     else
                        "auto"
                    )
                ]
                [ Toggle.new
                    { onToggle = ToggleGroupSecret zoneId activeSourceId group
                    , label = "Прихована"
                    , id = "toggle-" ++ String.fromInt zoneId ++ "-" ++ String.fromInt activeSourceId ++ "-" ++ group.groupMasterKey
                    }
                    |> Toggle.view group.isGroupSecret
                ]
            , if isLoading then
                span [ class "ml-2" ] [ Le.Block.Spinner.loadingSpinner2Sm ]

              else
                text ""
            , button
                [ class "cursor-pointer text-red-600 hover:text-red-800 transition-colors ml-2"
                , onClick (ShowRemoveGroupConfirmation zoneId activeSourceId group.groupMasterKey)
                , title "Видалити групу з цього напрямку"
                ]
                [ i [ class "bi bi-x-lg" ] [] ]
            ]
        ]


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
      , userSelectorSelect = { selectState = Select.initState (Select.selectIdentifier "user-selector"), items = [], selectedItems = [] }
      , userSelectorLoading = False
      , userSelectorError = Nothing
      , groupUpdateInProgress = Nothing
      , groupUpdateError = Nothing
      , zoneActiveTabs = Dict.empty
      , showOnlyHidden = False
      , groupNameFilter = ""
      , orphanGroups = RD.NotAsked
      , orphanGroupAssignmentInProgress = Nothing
      , orphanGroupAssignmentError = Nothing
      , groupRemovalConfirmation = Nothing
      , orphanGroupZoneSelector = Nothing
      
      }
    , E.sendCmd <|
        Cmd.batch
            [ Api.datasource_list GotDatasourceList
            , Api.orphan_signal_groups GotOrphanGroups
            ]
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
    | ToggleGroupSecret Int Int B.ZoneDatasourceGroup
    | ToggleGroupSecretDone (Result ApiError B.ZoneDatasourceGroup) Int Int String
    | ZoneTabChanged Int Int
    | ToggleShowOnlyHidden
    | UpdateGroupNameFilter String
    | GotOrphanGroups (Result ApiError (List B.OrphanSignalGroupEntry))
    | AssignOrphanGroup Int String
    | AssignOrphanGroupDone (Result ApiError B.ZoneDatasourceGroupAddRsp)
    | ShowRemoveGroupConfirmation Int Int String  -- zoneId, datasourceId, groupKey
    | CancelRemoveGroup
    | ConfirmRemoveGroup
    | RemoveGroupFromDatasource Int Int String  -- zoneId, datasourceId, groupKey
    | RemoveGroupFromDatasourceDone (Result ApiError ()) Int Int String  -- result, zoneId, datasourceId, groupKey
    | OpenOrphanGroupZoneSelector String  -- groupKey
    | CloseOrphanGroupZoneSelector
    | ToggleOrphanGroupZone String Int  -- groupKey, zoneId
    | SaveOrphanGroupZones



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
        f1 : ( Int, B.SigintZone ) -> Model -> Model
        f1 ( zoneId, _ ) acc =
            List.foldl (f2 zoneId) acc (Dict.get zoneId acc.zoneSources |> def [])

        f2 : Int -> Int -> Model -> Model
        f2 zoneId sourceId acc =
            let
                selId : String
                selId =
                    "source-zone-groups-"
                        ++ String.fromInt zoneId
                        ++ "-"
                        ++ String.fromInt sourceId

                zoneSourceGroupsMenu2 : Dict ( Int, Int ) (List (Select.MenuItem String))
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

                        m2 : Model
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

                        m3 : Model
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
                groupKeysExisting : Set String
                groupKeysExisting =
                    Dict.keys model.groupInfos
                        |> Set.fromList

                groupKeysNew : List String
                groupKeysNew =
                    groupKeys
                        |> Set.fromList
                        |> (\x -> Set.diff x groupKeysExisting)
                        |> Set.toList

                m2 : Model
                m2 =
                    { model
                        | datasourceGroups = Dict.insert sourceId groupKeys model.datasourceGroups
                    }

                m3 : Model
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
                m2 : Model
                m2 =
                    { model
                        | zoneSourceGroups =
                            Dict.insert ( zoneId, sourceId )
                                res.zoneDatasourceGroups
                                model.zoneSourceGroups
                    }

                m3 : Model
                m3 =
                    resetDatasourceGroupsSelect m2

                signalGroupEff : Cmd Msg
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
                m2 : Model
                m2 =
                    { model | groupInfos = groups.data |> List.foldl (\group acc -> Dict.insert group.masterKey group acc) model.groupInfos }

                m3 : Model
                m3 =
                    resetDatasourceGroupsSelect m2
            in
            ( m3
            , E.none
            )

        Save zoneId ->
            let
                saveInProgress2 : Dict Int (Set Int)
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

                m2 : Model
                m2 =
                    { model | saveInProgress = saveInProgress2 }

                cmds : Cmd Msg
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
                saveInProgress2 : Dict Int (Set Int)
                saveInProgress2 =
                    model.saveInProgress
                        |> Dict.update zoneId (mmap (Set.remove sourceId))

                m2 : Model
                m2 =
                    { model | saveInProgress = saveInProgress2 }
            in
            Api.handleHttpError ToastMsg e m2

        SaveDone zoneId sourceId (Ok ()) ->
            let
                saveInProgress2 : Dict Int (Set Int)
                saveInProgress2 =
                    model.saveInProgress
                        |> Dict.update zoneId (mmap (Set.remove sourceId))

                m2 : Model
                m2 =
                    { model | saveInProgress = saveInProgress2 }
            in
            ( m2, E.none )

        OpenUserSelector zoneId sourceId groupKey selected ->
            if List.isEmpty model.allLogins then
                ( { model | userSelectorDialog = Just { zoneId = zoneId, sourceId = sourceId, groupKey = groupKey }, userSelectorLoading = True, userSelectorError = Nothing }
                , E.sendCmd <| Api.list_logins UserSelectorLoginsLoaded { sortBy = Nothing }
                )

            else
                let
                    menu : List (Select.MenuItem String)
                    menu =
                        List.map (\login -> Select.basicMenuItem { item = login, label = login }) model.allLogins
                in
                ( { model | userSelectorDialog = Just { zoneId = zoneId, sourceId = sourceId, groupKey = groupKey }, userSelectorSelect = { selectState = Select.initState (Select.selectIdentifier "user-selector"), items = menu, selectedItems = selected }, userSelectorLoading = False, userSelectorError = Nothing }
                , E.none
                )

        UserSelectorLoginsLoaded (Ok rsp) ->
            let
                logins : List String
                logins =
                    List.map .login rsp.users

                menu : List (Select.MenuItem String)
                menu =
                    List.map (\login -> Select.basicMenuItem { item = login, label = login }) logins

                -- Get the original selected users from the dialog context
                originalSelected : List String
                originalSelected =
                    case model.userSelectorDialog of
                        Just _ ->
                            -- We need to get the original selected users from the group
                            -- This is a bit tricky since we removed it from dialog state
                            -- Let's get it from the group data
                            case model.userSelectorDialog of
                                Just { zoneId, sourceId, groupKey } ->
                                    Dict.get ( zoneId, sourceId ) model.zoneSourceGroups
                                        |> def []
                                        |> List.filter (\g -> g.groupMasterKey == groupKey)
                                        |> List.head
                                        |> Maybe.map .allowedUsers
                                        |> Maybe.withDefault []

                                Nothing ->
                                    []

                        Nothing ->
                            []
            in
            ( { model | allLogins = logins, userSelectorSelect = { selectState = Select.initState (Select.selectIdentifier "user-selector"), items = menu, selectedItems = originalSelected }, userSelectorLoading = False, userSelectorError = Nothing }
            , E.none
            )

        UserSelectorLoginsLoaded (Err e) ->
            ( { model | userSelectorLoading = False, userSelectorError = Just "Не вдалося завантажити користувачів" }
            , E.none
            )

        UserSelectorSelMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.userSelectorSelect.selectState

                selected : List String
                selected =
                    Le.Block.Select.multiUpdS mAction model.userSelectorSelect.selectedItems
            in
            ( { model | userSelectorSelect = { selectState = imodel2, items = model.userSelectorSelect.items, selectedItems = selected } }
            , E.sendCmd <| Cmd.map UserSelectorSelMsg icmd
            )

        CloseUserSelector ->
            ( { model | userSelectorDialog = Nothing, userSelectorError = Nothing }
            , E.none
            )

        UserSelectorSave ->
            case model.userSelectorDialog of
                Just { zoneId, sourceId, groupKey } ->
                    let
                        group : Maybe B.ZoneDatasourceGroup
                        group =
                            Dict.get ( zoneId, sourceId ) model.zoneSourceGroups
                                |> def []
                                |> List.filter (\g -> g.groupMasterKey == groupKey)
                                |> List.head
                    in
                    case group of
                        Just g ->
                            let
                                req : B.ZoneDatasourceGroupUpdateReq
                                req =
                                    { id = g.sigintZoneDatasourceId, isSecret = g.isGroupSecret, userLogins = model.userSelectorSelect.selectedItems }
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

                findZoneSource : Maybe ( Int, Int )
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

                zoneSourceTuple : ( Int, Int )
                zoneSourceTuple =
                    case findZoneSource of
                        Just v ->
                            v

                        Nothing ->
                            ( 0, 0 )

                zoneId : Int
                zoneId =
                    Tuple.first zoneSourceTuple

                sourceId : Int
                sourceId =
                    Tuple.second zoneSourceTuple

                oldGroups : List B.ZoneDatasourceGroup
                oldGroups =
                    Dict.get ( zoneId, sourceId ) model.zoneSourceGroups |> def []

                newGroups : List B.ZoneDatasourceGroup
                newGroups =
                    List.map
                        (\g ->
                            if g.groupMasterKey == groupMasterKey then
                                updatedGroup

                            else
                                g
                        )
                        oldGroups

                m2 : Model
                m2 =
                    { model | userSelectorDialog = Nothing, userSelectorError = Nothing, zoneSourceGroups = Dict.insert ( zoneId, sourceId ) newGroups model.zoneSourceGroups }

                needInfo : Bool
                needInfo =
                    not (Dict.member updatedGroup.groupMasterKey model.groupInfos)

                eff : Cmd Msg
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

        ToggleGroupSecret zoneId sourceId group ->
            let
                req : B.ZoneDatasourceGroupUpdateReq
                req =
                    { id = group.sigintZoneDatasourceId, isSecret = not group.isGroupSecret, userLogins = group.allowedUsers }
            in
            ( { model | groupUpdateInProgress = Just ( zoneId, sourceId, group.groupMasterKey ), groupUpdateError = Nothing }
            , E.sendCmd <| Api.zone_datasource_group_update (\res -> ToggleGroupSecretDone res zoneId sourceId group.groupMasterKey) req
            )

        ToggleGroupSecretDone (Ok updatedGroup) zoneId sourceId groupKey ->
            let
                oldGroups : List B.ZoneDatasourceGroup
                oldGroups =
                    Dict.get ( zoneId, sourceId ) model.zoneSourceGroups |> def []

                newGroups : List B.ZoneDatasourceGroup
                newGroups =
                    List.map
                        (\g ->
                            if g.groupMasterKey == groupKey then
                                updatedGroup

                            else
                                g
                        )
                        oldGroups

                m2 : Model
                m2 =
                    { model | groupUpdateInProgress = Nothing, groupUpdateError = Nothing, zoneSourceGroups = Dict.insert ( zoneId, sourceId ) newGroups model.zoneSourceGroups }

                needInfo : Bool
                needInfo =
                    not (Dict.member updatedGroup.groupMasterKey model.groupInfos)

                eff : Cmd Msg
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

        ZoneTabChanged zoneId sourceId ->
            ( { model | zoneActiveTabs = Dict.insert zoneId sourceId model.zoneActiveTabs }
            , E.none
            )

        ToggleShowOnlyHidden ->
            ( { model | showOnlyHidden = not model.showOnlyHidden }
            , E.none
            )

        UpdateGroupNameFilter newFilter ->
            ( { model | groupNameFilter = newFilter }
            , E.none
            )

        GotOrphanGroups (Ok groups) ->
            ( { model | orphanGroups = RD.Success groups }
            , E.none
            )

        GotOrphanGroups (Err e) ->
            ( { model | orphanGroups = RD.Failure e }
            , E.none
            )

        AssignOrphanGroup zoneId groupKey ->
            case findOrphanGroup model groupKey of
                Just orphanGroup ->
                    case orphanGroup.datasourceId of
                        Just datasourceId ->
                            let
                                req : B.ZoneDatasourceGroupAddReq
                                req =
                                    { zoneId = zoneId
                                    , datasourceId = datasourceId
                                    , masterKey = groupKey
                                    , isSecret = False
                                    , userLogins = []
                                    }
                            in
                            ( { model | orphanGroupAssignmentInProgress = Just groupKey, orphanGroupAssignmentError = Nothing }
                            , E.sendCmd <| Api.zone_datasource_group_add AssignOrphanGroupDone req
                            )

                        Nothing ->
                            ( { model | orphanGroupAssignmentError = Just "У групи немає прив'язаного датасорса" }
                            , E.none
                            )

                Nothing ->
                    ( { model | orphanGroupAssignmentError = Just "Не вдалося знайти групу" }
                    , E.none
                    )

        AssignOrphanGroupDone (Ok response) ->
            -- Locally update the state instead of fetching from server
            let
                -- Remove the group from orphan groups
                updatedOrphanGroups = 
                    case model.orphanGroups of
                        RD.Success groups ->
                            groups
                            |> List.filter (\g -> g.masterKey /= response.groupMasterKey)
                            |> RD.Success
                        other -> other
                
                -- Add the group to the appropriate datasource groups
                updatedDatasourceGroups = 
                    Dict.update response.datasourceId
                        (\maybeGroups ->
                            case maybeGroups of
                                Just groups -> Just (response.groupMasterKey :: groups)
                                Nothing -> Just [response.groupMasterKey]
                        )
                        model.datasourceGroups
                
                -- Add the ZoneDatasourceGroup to the appropriate zone-datasource combination
                updatedZoneSourceGroups =
                    Dict.update (response.zoneId, response.datasourceId)
                        (\maybeGroups ->
                            case maybeGroups of
                                Just groups -> Just (response.zoneDatasourceGroup :: groups)
                                Nothing -> Just [response.zoneDatasourceGroup]
                        )
                        model.zoneSourceGroups
                
                -- Add group info if we have the name from the response
                updatedGroupInfos = 
                    case response.groupName of
                        Just name ->
                            Dict.insert response.groupMasterKey
                                { masterKey = response.groupMasterKey
                                , name = name
                                , ignoreOperativny = False  -- Default value
                                }
                                model.groupInfos
                        Nothing ->
                            model.groupInfos
            in
            ( { model 
                | orphanGroupAssignmentInProgress = Nothing
                , orphanGroupAssignmentError = Nothing
                , orphanGroups = updatedOrphanGroups
                , datasourceGroups = updatedDatasourceGroups
                , zoneSourceGroups = updatedZoneSourceGroups
                , groupInfos = updatedGroupInfos
              }
            , E.none  
            )

        AssignOrphanGroupDone (Err e) ->
            ( { model 
                | orphanGroupAssignmentInProgress = Nothing
                , orphanGroupAssignmentError = Just "Не вдалося призначити групу"
              }
            , E.none
            )

        ShowRemoveGroupConfirmation zoneId datasourceId groupKey ->
            let
                groupName : String
                groupName =
                    Dict.get groupKey model.groupInfos
                        |> Maybe.map .name
                        |> def groupKey
                        |> (\name ->
                                if String.isEmpty name then
                                    String.right 5 groupKey
                                else
                                    name
                           )
            in
            ( { model | groupRemovalConfirmation = Just { zoneId = zoneId, datasourceId = datasourceId, groupKey = groupKey, groupName = groupName } }
            , E.none
            )

        CancelRemoveGroup ->
            ( { model | groupRemovalConfirmation = Nothing }
            , E.none
            )

        ConfirmRemoveGroup ->
            case model.groupRemovalConfirmation of
                Just { zoneId, datasourceId, groupKey } ->
                    ( { model | groupRemovalConfirmation = Nothing }
                    , E.sendMsg (RemoveGroupFromDatasource zoneId datasourceId groupKey)
                    )
                Nothing ->
                    ( model, E.none )

        RemoveGroupFromDatasource zoneId datasourceId groupKey ->
            -- Find the sigintZoneDatasourceId for this group
            let
                groupToRemove : Maybe B.ZoneDatasourceGroup
                groupToRemove =
                    Dict.get ( zoneId, datasourceId ) model.zoneSourceGroups
                        |> def []
                        |> List.filter (\g -> g.groupMasterKey == groupKey)
                        |> List.head
            in
            case groupToRemove of
                Just group ->
                    ( model
                    , E.sendCmd <| Api.zone_datasource_group_delete 
                        (\result -> RemoveGroupFromDatasourceDone result zoneId datasourceId groupKey)
                        group.sigintZoneDatasourceId
                    )
                Nothing ->
                    ( model, E.none )

        RemoveGroupFromDatasourceDone (Ok ()) zoneId datasourceId groupKey ->
            -- Remove the group from local state and add it back to orphan groups
            let
                -- Remove from zoneSourceGroups
                updatedZoneSourceGroups =
                    Dict.update (zoneId, datasourceId)
                        (\maybeGroups ->
                            case maybeGroups of
                                Just groups -> 
                                    groups
                                    |> List.filter (\g -> g.groupMasterKey /= groupKey)
                                    |> Just
                                Nothing -> Nothing
                        )
                        model.zoneSourceGroups
                
                -- Remove from datasourceGroups
                updatedDatasourceGroups =
                    Dict.update datasourceId
                        (\maybeGroups ->
                            case maybeGroups of
                                Just groups -> 
                                    groups
                                    |> List.filter (\g -> g /= groupKey)
                                    |> Just
                                Nothing -> Nothing
                        )
                        model.datasourceGroups
                
                -- Add back to orphan groups
                updatedOrphanGroups =
                    case model.orphanGroups of
                        RD.Success groups ->
                            -- Get group info to create the orphan entry
                            let
                                groupInfo = Dict.get groupKey model.groupInfos
                                
                                newOrphanGroup : B.OrphanSignalGroupEntry
                                newOrphanGroup =
                                    { masterKey = groupKey
                                    , name = groupInfo |> Maybe.map .name |> Maybe.withDefault ""
                                    , datasourceId = Just datasourceId
                                    , ignoreOperativny = groupInfo |> Maybe.map .ignoreOperativny |> Maybe.withDefault False
                                    }
                            in
                            -- Only add if not already in orphan groups
                            if List.any (\g -> g.masterKey == groupKey) groups then
                                RD.Success groups
                            else
                                RD.Success (newOrphanGroup :: groups)
                        
                        other -> other
            in
            ( { model 
                | zoneSourceGroups = updatedZoneSourceGroups
                , datasourceGroups = updatedDatasourceGroups
                , orphanGroups = updatedOrphanGroups
              }
            , E.none
            )

        RemoveGroupFromDatasourceDone (Err e) _ _ _ ->
            -- Handle error - could show a toast or set an error state
            Api.handleHttpError ToastMsg e model

        OpenOrphanGroupZoneSelector groupKey ->
            ( { model | orphanGroupZoneSelector = Just { groupKey = groupKey, selectedZones = [] } }
            , E.none
            )

        CloseOrphanGroupZoneSelector ->
            ( { model | orphanGroupZoneSelector = Nothing }
            , E.none
            )

        ToggleOrphanGroupZone groupKey zoneId ->
            case model.orphanGroupZoneSelector of
                Just selector ->
                    if selector.groupKey == groupKey then
                        let
                            updatedZones = 
                                if List.member zoneId selector.selectedZones then
                                    List.filter ((/=) zoneId) selector.selectedZones
                                else
                                    zoneId :: selector.selectedZones
                        in
                        ( { model | orphanGroupZoneSelector = Just { selector | selectedZones = updatedZones } }
                        , E.none
                        )
                    else
                        -- Переключаємося на іншу групу
                        ( { model | orphanGroupZoneSelector = Just { groupKey = groupKey, selectedZones = [zoneId] } }
                        , E.none
                        )
                Nothing ->
                    -- Створюємо новий селектор для групи
                    ( { model | orphanGroupZoneSelector = Just { groupKey = groupKey, selectedZones = [zoneId] } }
                    , E.none
                    )

        SaveOrphanGroupZones ->
            let
                maybeSelector = model.orphanGroupZoneSelector
                maybeOrphanGroup = 
                    maybeSelector
                        |> Maybe.andThen (\selector -> findOrphanGroup model selector.groupKey)
                maybeDatasourceId = 
                    maybeOrphanGroup
                        |> Maybe.andThen .datasourceId
            in
            case (maybeSelector, maybeOrphanGroup, maybeDatasourceId) of
                (Just selector, Just orphanGroup, Just datasourceId) ->
                    let
                        requests = 
                            List.map (\zoneId ->
                                let
                                    req : B.ZoneDatasourceGroupAddReq
                                    req =
                                        { zoneId = zoneId
                                        , datasourceId = datasourceId
                                        , masterKey = selector.groupKey
                                        , isSecret = False
                                        , userLogins = []
                                        }
                                in
                                Api.zone_datasource_group_add AssignOrphanGroupDone req
                            ) selector.selectedZones
                    in
                    ( { model 
                        | orphanGroupAssignmentInProgress = Just selector.groupKey
                        , orphanGroupAssignmentError = Nothing
                        , orphanGroupZoneSelector = Nothing
                      }
                    , E.sendCmd <| Cmd.batch requests
                    )
                
                (Just _, Just _, Nothing) ->
                    ( { model | orphanGroupAssignmentError = Just "У групи немає прив'язаного напрямку" }
                    , E.none
                    )
                
                (Just _, Nothing, _) ->
                    ( { model | orphanGroupAssignmentError = Just "Не вдалося знайти групу" }
                    , E.none
                    )
                
                (Nothing, _, _) ->
                    ( model, E.none )




subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none



-- Helper functions for datasource grouping and tabs


type alias DatasourceType =
    { id : Int
    , name : String
    , datasources : List ( Int, B.Datasource )
    }


renderOrphanGroupsSection : Bool -> Model -> B.User -> Html Msg
renderOrphanGroupsSection isDark model user =
    case model.orphanGroups of
        RD.NotAsked ->
            div [ class "bg-[var(--bs-body-bg)] rounded-lg border p-6" ]
                [ div [ class "text-center opacity-70" ]
                    [ text "Завантаження..." ]
                ]

        RD.Loading ->
            div [ class "bg-[var(--bs-body-bg)] rounded-lg border p-6" ]
                [ Le.Block.Spinner.loadingSpinner ]

        RD.Failure _ ->
            div [ class "bg-[var(--bs-body-bg)] rounded-lg border p-6" ]
                [ div [ class "text-center text-red-600" ]
                    [ text "Помилка завантаження груп" ]
                ]

        RD.Success groups ->
            if List.isEmpty groups then
                div [ class "bg-[var(--bs-body-bg)] rounded-lg border p-6" ]
                    [ div [ class "text-center opacity-70" ]
                        [ text "Немає непризначених груп" ]
                    ]

            else
                div [ class "bg-[var(--bs-body-bg)] rounded-lg border p-6" ]
                    [ h3 [ class "text-lg font-semibold mb-4" ]
                        [ text <| "Непризначені групи (" ++ String.fromInt (List.length groups) ++ ")" ]
                    , div [ class "max-h-96 overflow-y-auto space-y-3" ]
                        (List.map (renderOrphanGroup model) groups)
                    ]

        RD.NeedsReload _ ->
            div [ class "bg-[var(--bs-body-bg)] rounded-lg border p-6" ]
                [ div [ class "text-center opacity-70" ]
                    [ text "Потрібно перезавантажити..." ]
                ]


findOrphanGroup : Model -> String -> Maybe B.OrphanSignalGroupEntry
findOrphanGroup model groupKey =
    case model.orphanGroups of
        RD.Success groups ->
            List.filter (\g -> g.masterKey == groupKey) groups |> List.head
        _ ->
            Nothing


renderOrphanGroup : Model -> B.OrphanSignalGroupEntry -> Html Msg
renderOrphanGroup model group =
    let
        groupName : String
        groupName =
            if String.isEmpty group.name then
                String.right 5 group.masterKey

            else
                group.name

        isAssigning : Bool
        isAssigning = model.orphanGroupAssignmentInProgress == Just group.masterKey

        zoneCount : Int
        zoneCount = List.length model.zones
    in
    div [ class "flex items-center justify-between border rounded-lg p-4 bg-[var(--bs-tertiary-bg)] hover:bg-[var(--bs-secondary-bg)] transition-colors" ]
        [ div [ class "flex-1" ]
            [ div [ class "font-semibold" ] [ text groupName ]
            , div [ class "text-sm text-gray-600" ] [ text group.masterKey ]
            , case model.orphanGroupAssignmentError of
                Just error ->
                    div [ class "mt-2 text-xs text-red-600" ] [ text error ]
                Nothing -> text ""
            ]
        , div [ class "flex items-center gap-3" ]
            [ if isAssigning then
                div [ class "flex items-center gap-2" ]
                    [ Le.Block.Spinner.loadingSpinner2Sm
                    , span [ class "text-sm text-gray-600" ] [ text "Призначення..." ]
                    ]
              else if zoneCount == 0 then
                span [ class "text-sm text-gray-500" ] [ text "Немає напрямків" ]
              else if zoneCount == 1 then
                -- Тільки одна зона - показуємо тільки іконку додати
                case List.head model.zones of
                    Just (zoneId, zone) ->
                        div [ class "flex items-center gap-2" ]
                            [ span [ class "text-sm text-gray-700" ] [ text ("→ " ++ zone.name) ]
                            , button
                                [ class "flex items-center justify-center w-8 h-8 rounded-full bg-green-100 hover:bg-green-200 text-green-700 transition-colors"
                                , onClick (AssignOrphanGroup zoneId group.masterKey)
                                , title ("Додати до " ++ zone.name)
                                ]
                                [ i [ class "bi bi-plus text-lg" ] [] ]
                            ]
                    Nothing -> text ""
              else
                -- Кілька зон - показуємо теги з напрямками
                let
                    selectedZones = 
                        case model.orphanGroupZoneSelector of
                            Just selector -> 
                                if selector.groupKey == group.masterKey then
                                    selector.selectedZones
                                else
                                    []
                            Nothing -> []
                    
                    hasSelection = not (List.isEmpty selectedZones)
                in
                div [ class "flex items-center gap-2 flex-wrap" ]
                    ([ span [ class "text-sm text-gray-700" ] [ text "→" ] ]
                    ++ (List.map (\(zoneId, zone) ->
                        let
                            isSelected = List.member zoneId selectedZones
                        in
                        button
                            [ class <| "px-2 py-1 text-xs rounded-full transition-colors " ++
                                if isSelected then
                                    "bg-blue-100 text-blue-700 border border-blue-300"
                                else
                                    "bg-gray-100 text-gray-700 border border-gray-300 hover:bg-gray-200"
                            , onClick (ToggleOrphanGroupZone group.masterKey zoneId)
                            , title <| if isSelected then "Прибрати " ++ zone.name else "Додати " ++ zone.name
                            ]
                            [ text zone.name ]
                    ) model.zones)
                    ++ (if hasSelection then
                        [ button
                            [ class "flex items-center justify-center w-6 h-6 rounded-full bg-green-100 hover:bg-green-200 text-green-700 transition-colors ml-1"
                            , onClick SaveOrphanGroupZones
                            , title "Додати до вибраних напрямків"
                            ]
                            [ i [ class "bi bi-plus text-sm" ] [] ]
                        ]
                    else
                        []
                    )
                    )
            ]
        ]


groupDatasourcesByType : Int -> Model -> List DatasourceType
groupDatasourcesByType zoneId model =
    let
        zoneSources : List Int
        zoneSources =
            Dict.get zoneId model.zoneSources |> Maybe.withDefault []

        -- Get datasources for this zone
        zoneDatasources : List ( Int, B.Datasource )
        zoneDatasources =
            List.filterMap
                (\sourceId ->
                    let
                        source : Maybe B.Datasource
                        source =
                            findK sourceId model.datasources
                    in
                    case source of
                        Nothing ->
                            Nothing

                        Just ds ->
                            Just ( sourceId, ds )
                )
                zoneSources

        -- Group by kind
        groupedByKind : Dict String (List ( Int, B.Datasource ))
        groupedByKind =
            List.foldl
                (\( sourceId, datasource ) acc ->
                    Dict.update datasource.kind
                        (\maybeList ->
                            case maybeList of
                                Just list ->
                                    Just (( sourceId, datasource ) :: list)

                                Nothing ->
                                    Just [ ( sourceId, datasource ) ]
                        )
                        acc
                )
                Dict.empty
                zoneDatasources

        -- Convert to DatasourceType list
        datasourceTypes : List DatasourceType
        datasourceTypes =
            Dict.toList groupedByKind
                |> List.indexedMap
                    (\index ( kind, datasources ) ->
                        let
                            -- Get signal_phone from the first datasource in the group
                            -- All datasources in a group should have the same signal_phone
                            signalPhone : String
                            signalPhone =
                                List.head datasources
                                    |> Maybe.map (\( _, ds ) -> ds.signalPhone)
                                    |> Maybe.withDefault Nothing
                                    |> Maybe.withDefault "Unknown"

                            -- Calculate total groups for this datasource type
                            totalGroups : Int
                            totalGroups =
                                List.foldl
                                    (\( sourceId, _ ) acc ->
                                        let
                                            groups : List B.ZoneDatasourceGroup
                                            groups =
                                                Dict.get ( zoneId, sourceId ) model.zoneSourceGroups |> def []
                                        in
                                        acc + List.length groups
                                    )
                                    0
                                    datasources
                        in
                        { id = index + 1
                        , name = Utils.capitalize kind ++ " " ++ signalPhone ++ " (" ++ String.fromInt totalGroups ++ " груп)"
                        , datasources = List.reverse datasources -- Keep original order
                        }
                    )
    in
    datasourceTypes


zoneCard2 : Bool -> Model -> B.User -> ( Int, B.SigintZone ) -> Html Msg
zoneCard2 isDark model user ( zoneId, zone ) =
    let
        activeTab : Int
        activeTab =
            Dict.get zoneId model.zoneActiveTabs |> Maybe.withDefault 1

        -- Group datasources by type
        datasourceTypes : List DatasourceType
        datasourceTypes =
            groupDatasourcesByType zoneId model

        -- Create tab definitions
        tabDefinitions : List { id : Int, label : String }
        tabDefinitions =
            List.map
                (\dsType ->
                    { id = dsType.id
                    , label = dsType.name
                    }
                )
                datasourceTypes

        renderDatasourceSection : ( Int, B.Datasource ) -> Html Msg
        renderDatasourceSection ( sourceId, source ) =
            let
                groups : List B.ZoneDatasourceGroup
                groups =
                    Dict.get ( zoneId, sourceId ) model.zoneSourceGroups
                        |> def []
                        |> List.filter (\group -> not model.showOnlyHidden || group.isGroupSecret)
                        |> List.filter (\group ->
                            let
                                groupName : String
                                groupName =
                                    Dict.get group.groupMasterKey model.groupInfos
                                        |> Maybe.map .name
                                        |> def group.groupMasterKey
                                        |> (\name ->
                                                if String.isEmpty name then
                                                    String.right 5 group.groupMasterKey
                                                else
                                                    name
                                           )
                            in
                            String.isEmpty model.groupNameFilter ||
                            String.contains (String.toLower model.groupNameFilter) (String.toLower groupName)
                        )
                        |> List.sortBy
                            (\group ->
                                let
                                    groupName : String
                                    groupName =
                                        Dict.get group.groupMasterKey model.groupInfos
                                            |> Maybe.map .name
                                            |> def group.groupMasterKey
                                            |> (\name ->
                                                    if String.isEmpty name then
                                                        String.right 5 group.groupMasterKey

                                                    else
                                                        name
                                               )
                                in
                                groupName
                            )
            in
            if List.isEmpty groups then
                text ""

            else
                div [ class "space-y-3" ]
                    (List.map (renderGroup model zoneId sourceId) groups)

        -- Get active datasource type
        activeType : Maybe DatasourceType
        activeType =
            List.filter (\dsType -> dsType.id == activeTab) datasourceTypes |> List.head

        -- Render tab content
        tabContent : Html Msg
        tabContent =
            case activeType of
                Just dsType ->
                    div [ class "space-y-3" ]
                        (List.map renderDatasourceSection dsType.datasources)

                Nothing ->
                    div [ class "text-center opacity-70" ]
                        [ text "Немає доступних джерел даних" ]
    in
    div [ class "bg-[var(--bs-body-bg)] rounded-lg border p-0 mb-6 overflow-hidden" ]
        [ div [ class "px-6 py-4 border-b" ]
            [ h3 [ class "text-lg font-semibold mb-0" ]
                [ text <| "Напрямок: " ++ zone.name ]
            ]
        , if List.isEmpty datasourceTypes then
            div [ class "p-6 text-center opacity-70" ]
                [ text "Немає доступних джерел даних" ]

          else
            div [ class "p-6" ]
                [ -- Tab navigation
                  Tabs.view tabDefinitions activeTab (ZoneTabChanged zoneId)
                , -- Tab content
                  div [ class "mt-4" ] [ tabContent ]
                ]
        ]


mainBlock : Bool -> Model -> B.User -> Html Msg
mainBlock isDark model user =
    div [ class "space-y-6" ]
        [ div [ class "bg-[var(--bs-tertiary-bg)] rounded-lg border p-4" ]
            [ h3 [ class "text-lg font-semibold mb-4" ] [ text "Фільтри" ]
            , div [ class "flex flex-col space-y-6" ]
                [ div [ class "flex flex-col" ]
                    [ label
                        [ for "group-name-filter"
                        , class "mb-1 text-sm font-medium"
                        ]
                        [ text "Назва групи:" ]
                    , input
                        [ type_ "text"
                        , id "group-name-filter"
                        , value model.groupNameFilter
                        , onInput UpdateGroupNameFilter
                        , placeholder "Введіть назву групи..."
                        , class "flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-[var(--bs-body-bg)]"
                        ] []
                    ]
                , div [ class "flex items-center pt-2 border-t border-gray-100" ]
                    [ Toggle.new
                        { onToggle = ToggleShowOnlyHidden
                        , label = "Лише приховані"
                        , id = "show-only-hidden-filter"
                        }
                        |> Toggle.view model.showOnlyHidden
                    ]
                ]
            ]
        , renderOrphanGroupsSection isDark model user
        , div [ class "space-y-6" ] (List.map (zoneCard2 isDark model user) model.zones)
        ]


body : Bool -> Shared.Model -> B.User -> Model -> List (Html Msg)
body dark shared user model =
    [ Views.noHeaderAndContent ToastMsg model.toasts <|
        div [ class "mt-2" ] [ mainBlock dark model user ]
    ]
        ++ (case model.userSelectorDialog of
                Just dialog ->
                    [ ModalDialog.modalDialog True
                        CloseUserSelector
                        [ class "medium-modal overflow-visible"
                        ]
                        [ div [ class "p-8" ]
                            [ div [ class "mb-2 font-semibold text-gray-900" ] [ text "Виберіть користувачів, яким видима група" ]
                            , if model.userSelectorLoading then
                                div [ class "text-gray-600" ] [ text "Завантаження..." ]

                              else
                                div [ class "" ]
                                    [ Html.map UserSelectorSelMsg <|
                                        Styled.toUnstyled <|
                                            Le.Block.Select.renderSelectVirtual
                                                (List.map (\login -> Select.basicMenuItem { item = login, label = login }) model.userSelectorSelect.selectedItems)
                                                model.userSelectorSelect.selectState
                                                model.userSelectorSelect.items
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
                                    (Button.new { label = "Зберегти", onClick = UserSelectorSave })
                                ]
                            ]
                        ]
                    ]

                Nothing ->
                    []
           )
        ++ (case model.groupRemovalConfirmation of
                Just confirmation ->
                    [ ModalDialog.modalDialog True
                        CancelRemoveGroup
                        [ class "small-modal"
                        ]
                        [ div [ class "p-6" ]
                            [ div [ class "mb-4 text-lg font-semibold text-gray-900" ] 
                                [ text "Підтвердження видалення" ]
                            , div [ class "mb-6 text-gray-700" ] 
                                [ text ("Ви дійсно хочете видалити групу \"" ++ confirmation.groupName ++ "\" з цього напрямку?") ]
                            , div [ class "flex justify-end gap-3" ]
                                [ Button.view
                                    (Button.new { label = "Скасувати", onClick = CancelRemoveGroup }
                                        |> Button.withOutlined True
                                    )
                                , Button.view
                                    (Button.new { label = "Видалити", onClick = ConfirmRemoveGroup })
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
