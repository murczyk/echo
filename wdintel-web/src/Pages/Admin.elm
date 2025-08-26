module Pages.Admin exposing (Model, Msg, page)
import Shared.Model exposing (isDarkMode)

import Api
import Auth
import Bindings as B
import Components.Button as Button
import Components.ModalDialog as ModalDialog
import Components.Pager as Pager
import Components.Sidebar as Sidebar
import Components.Table as Table
import Components.Table.Config as Config
import Components.Tabs as Tabs
import Components.Toggle as Toggle
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Styled as Styled
import Layouts
import Le.Block.Select
import Le.Block.Spinner
import Le.ErrorHandling
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.RerMessage
import Le.Types exposing (..)
import Le.Time
import Le.Utils as Utils exposing (..)
import Maybe
import Time
import TimeZone
import Page exposing (Page)
import Route exposing (Route)
import Select
import Set exposing (Set)
import Shared
import Shared.Model exposing (isDarkMode)
import View exposing (View)


type alias OrphanGroupAssignmentDialog =
    { groupKey : String
    , zoneIds : List Int
    , isSecret : Bool
    , selectedUsers : List String
    , userSelectState : Select.State
    }


type alias GroupEditDialog =
    { zoneId : Int
    , sourceId : Int
    , groupKey : String
    , groupName : String
    , shortNote : String
    , longNote : String
    , isSecret : Bool
    , selectedUsers : List String
    , userSelectState : Select.State
    , areaOfResponsibilitySelector :
        { selected : List Int
        , available : List B.AreaOfResponsibility
        , selectState : Select.State
        }
    , isLoading : Bool
    , error : Maybe String
    }


type alias OrphanGroupEditDialog =
    { groupKey : String
    , groupName : String
    , shortNote : String
    , longNote : String
    , areaOfResponsibilitySelector :
        { selected : List Int
        , available : List B.AreaOfResponsibility
        , selectState : Select.State
        }
    , isLoading : Bool
    , error : Maybe String
    }


type alias Model =
    { formErrors : Dict String String
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
    , orphanGroupAssignmentInProgress : Maybe String -- Track which group is being assigned
    , orphanGroupAssignmentError : Maybe String
    , groupRemovalConfirmation : Maybe { zoneId : Int, datasourceId : Int, groupKey : String, groupName : String }
    , orphanGroupZoneSelector : Maybe { groupKey : String, selectedZones : List Int }
    , orphanGroupsTableState : Table.State
    , orphanGroupsPager : Pager.Model
    , orphanGroupAssignmentDialog : Maybe OrphanGroupAssignmentDialog
    , expandedGroupNotes : Set String -- Track which groups have expanded long notes
    , groupEditDialog : Maybe GroupEditDialog
    , orphanGroupEditDialog : Maybe OrphanGroupEditDialog
    , orphanGroupEditInProgress : Maybe String -- groupKey being edited
    , orphanGroupEditError : Maybe String
    , areasOfResponsibility : RemoteData ApiError (List B.AreaOfResponsibility)
    , areaOfResponsibilityFilter : Maybe Int
    , areaOfResponsibilityFilterSelectState : Select.State
    , fullNoteModal : Maybe { groupKey : String, note : String }
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

        isExpanded : Bool
        isExpanded =
            Set.member group.groupMasterKey model.expandedGroupNotes

        shortNote : Maybe String
        shortNote =
            group.shortNote

        longNote : Maybe String
        longNote =
            group.longNote

        hasLongNote : Bool
        hasLongNote =
            case longNote of
                Just note ->
                    not (String.isEmpty (String.trim note))

                Nothing ->
                    False

        -- Get group stats from groupInfos
        groupStats : Maybe B.SignalGroupStats
        groupStats =
            Dict.get group.groupMasterKey model.groupInfos
                |> Maybe.map .groupStats
    in
    div [ class "border rounded-lg mb-3 p-2 bg-[var(--bs-tertiary-bg)]" ]
        [ -- Header row: Group name, secret icon, action buttons
          div [ class "flex items-center justify-between mb-2" ]
            [ div [ class "flex items-center" ]
                [ span [ class "font-semibold mr-2 text-base" ] [ text groupName ]
                , -- Group stats display
                  case groupStats of
                    Just stats ->
                        div [ class "flex items-center" ]
                            [ span [ class "text-gray-400 mx-2" ] [ text "|" ]
                            , span [ class "text-sm text-gray-600 flex items-center" ]
                                [ span [ class "mr-1" ] [ text "Активність" ]
                                , span [ class "ml-1 font-medium" ] [ text (": день " ++ String.fromInt stats.activityLastDay ++ " / тиждень " ++ String.fromInt stats.activityLastWeek) ]
                                ]
                            ]

                    Nothing ->
                        text ""
                , -- Areas of responsibility display
                  case group.areasOfResponsibility of
                    Just areas ->
                        if List.isEmpty areas then
                            text ""
                        else
                            div [ class "flex items-center" ]
                                [ span [ class "text-gray-400 mx-2" ] [ text "|" ]
                                , span [ class "text-sm text-gray-600 flex items-center" ]
                                    [ i [ class "bi bi-geo-alt mr-1" ] []
                                    , span [ class "mr-1" ] [ text "Смуги:" ]
                                    , span [ class "font-medium" ]
                                        [ text (areas |> List.map .name |> String.join ", ") ]
                                    ]
                                ]

                    Nothing ->
                        text ""
                , if group.isGroupSecret then
                    span [ class "ml-2 text-lg text-amber-600" ] [ i [ class "bi bi-eye-slash-fill" ] [] ]

                  else
                    text ""
                ]
            , div [ class "flex items-center gap-2" ]
                [ -- Info button for long note (only if has long note)
                  if hasLongNote then
                    button
                        [ class <|
                            "flex items-center justify-center w-6 h-6 rounded-full transition-colors "
                                ++ (if isExpanded then
                                        "bg-blue-100 text-blue-700 hover:bg-blue-200"

                                    else
                                        "bg-gray-100 text-gray-600 hover:bg-gray-200"
                                   )
                        , onClick (ToggleGroupNoteExpansion group.groupMasterKey)
                        , title <|
                            if isExpanded then
                                "Сховати детальну інформацію"

                            else
                                "Показати детальну інформацію"
                        ]
                        [ i
                            [ class <|
                                if isExpanded then
                                    "bi bi-chevron-up"

                                else
                                    "bi bi-info-circle"
                            ]
                            []
                        ]

                  else
                    text ""
                , -- Edit button
                  button
                    [ class "flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
                    , onClick (EditGroup zoneId activeSourceId group.groupMasterKey)
                    , title "Редагувати групу"
                    ]
                    [ i [ class "bi bi-pencil" ] [] ]
                , -- Loading spinner (for any ongoing operations)
                  if isLoading then
                    span [ class "ml-1" ] [ Le.Block.Spinner.loadingSpinner2Sm ]

                  else
                    text ""
                , -- Delete button
                  button
                    [ class "flex items-center justify-center w-6 h-6 rounded-full bg-red-100 text-red-600 hover:bg-red-200 transition-colors"
                    , onClick (ShowRemoveGroupConfirmation zoneId activeSourceId group.groupMasterKey)
                    , title "Видалити групу з цього напрямку"
                    ]
                    [ i [ class "bi bi-x-lg" ] [] ]
                ]
            ]
        , -- Short note row (always visible if exists)
          case shortNote of
            Just note ->
                if not (String.isEmpty (String.trim note)) then
                    div [ class "mb-2 text-sm text-gray-700 bg-blue-50 rounded px-3 py-2 border-l-4 border-blue-300" ]
                        [ i [ class "bi bi-sticky mr-2 text-blue-600" ] []
                        , text note
                        ]

                else
                    text ""

            Nothing ->
                text ""
        , -- User list row (always visible for secret groups)
          if group.isGroupSecret then
            div [ class "mb-2 flex items-center flex-wrap gap-2" ]
                [ span [ class "text-sm text-gray-600 mr-2" ] [ text "👥 Видима для:" ]
                , div [ class "flex flex-wrap gap-1" ]
                    (if List.isEmpty group.allowedUsers then
                        [ span [ class "text-sm text-gray-500 italic" ] [ text "немає користувачів" ] ]

                     else
                        List.map
                            (\user ->
                                span [ class "inline-block bg-blue-100 text-blue-800 text-xs px-2 py-1 rounded-full" ]
                                    [ text user ]
                            )
                            group.allowedUsers
                    )
                ]

          else
            text ""
        , -- Expandable long note section
          if hasLongNote && isExpanded then
            case longNote of
                Just note ->
                    div [ class "mt-3 p-3 bg-gray-50 rounded border border-gray-200" ]
                        [ div [ class "flex items-center mb-2" ]
                            [ i [ class "bi bi-file-text mr-2 text-gray-600" ] []
                            , span [ class "text-sm font-medium text-gray-700" ] [ text "Детальна інформація:" ]
                            ]
                        , div [ class "text-sm text-gray-800 whitespace-pre-wrap" ] [ text note ]
                        ]

                Nothing ->
                    text ""

          else
            text ""
        ]


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
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
              , orphanGroupsTableState = Table.initialSort "Тиждень"
      , orphanGroupsPager = Pager.init
      , orphanGroupAssignmentDialog = Nothing
      , expandedGroupNotes = Set.empty
      , groupEditDialog = Nothing
      , orphanGroupEditDialog = Nothing
      , orphanGroupEditInProgress = Nothing
              , orphanGroupEditError = Nothing
        , areasOfResponsibility = RD.NotAsked
        , areaOfResponsibilityFilter = Nothing
        , areaOfResponsibilityFilterSelectState = Select.initState (Select.selectIdentifier "area-filter")
        , fullNoteModal = Nothing
      }
    , E.sendCmd <|
        Cmd.batch
            [ Api.datasource_list GotDatasourceList
            , Api.orphan_signal_groups GotOrphanGroups
            , Api.aor_list AreasOfResponsibilityLoaded { sortBy = Nothing }
            ]
    )


type Msg
    = GotDatasourceList (Result ApiError (List ( Int, B.Datasource )))
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
    | ZoneTabChanged Int Int
    | ToggleShowOnlyHidden
    | UpdateGroupNameFilter String
    | GotOrphanGroups (Result ApiError (List B.OrphanSignalGroupEntry))
    | AssignOrphanGroup Int String
    | AssignOrphanGroupDone (Result ApiError B.ZoneDatasourceGroupAddRsp)
    | ShowRemoveGroupConfirmation Int Int String -- zoneId, datasourceId, groupKey
    | CancelRemoveGroup
    | ConfirmRemoveGroup
    | RemoveGroupFromDatasource Int Int String -- zoneId, datasourceId, groupKey
    | RemoveGroupFromDatasourceDone (Result ApiError ()) Int Int String -- result, zoneId, datasourceId, groupKey
    | OpenOrphanGroupZoneSelector String -- groupKey
    | CloseOrphanGroupZoneSelector
    | ToggleOrphanGroupZone String Int -- groupKey, zoneId
    | SaveOrphanGroupZones
    | OrphanGroupsTableStateChanged Table.State
    | OrphanGroupsPagerMsg Pager.Msg
    | UpdateOrphanGroupsPagerTotalItems Int
    | EditOrphanGroup String -- groupKey
    | CloseOrphanGroupEdit
    | UpdateOrphanGroupShortNote String
    | UpdateOrphanGroupLongNote String
    | SaveOrphanGroupEdit
    | OrphanGroupEditDone (Result ApiError B.GroupEntryF1)
    | OpenOrphanGroupAssignmentDialog String (List Int) -- groupKey, zoneIds
    | CloseOrphanGroupAssignmentDialog
    | ToggleOrphanGroupSecret
    | ConfirmOrphanGroupAssignment
    | OrphanGroupUserSelectMsg (Select.Msg String)
    | ToggleGroupNoteExpansion String -- groupMasterKey
    | EditGroup Int Int String -- zoneId, sourceId, groupMasterKey
    | CloseGroupEdit
    | UpdateGroupShortNote String
    | UpdateGroupLongNote String
    | ToggleGroupSecretInDialog
    | GroupEditUserSelectMsg (Select.Msg String)
    | SaveGroupEdit
    | SaveGroupEditDone (Result ApiError B.ZoneDatasourceGroup)
    | LoadAreasOfResponsibility
    | AreasOfResponsibilityLoaded (Result ApiError (List B.AreaOfResponsibility))
    | OrphanGroupAreaSelectMsg (Select.Msg Int)
    | UpdateOrphanGroupAreaOfResponsibility (Maybe Int)
    | ShowFullNoteModal String String -- groupKey, note
    | CloseFullNoteModal
    | GroupAreaSelectMsg (Select.Msg Int)
    | UpdateGroupAreaOfResponsibility (Maybe Int)
    | UpdateAreaOfResponsibilityFilter (Maybe Int)
    | AreaOfResponsibilityFilterMsg (Select.Msg Int)


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared req =
    Page.new
        { init = init
        , update = update
        , view = view (isDarkMode shared.themeMode) shared user
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
        GotDatasourceList (Err e) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження джерел даних" e
            )

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
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження зон" e
            )

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
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження джерел зон" e
            )

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
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження груп джерел" e
            )

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
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження груп зон" e
            )

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
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження інформації про групи" e
            )

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
            ( m2
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка збереження груп" e
            )

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

                -- Update the group edit dialog if it's open and was loading
                updatedModel =
                    case model.groupEditDialog of
                        Just dialog ->
                            if dialog.isLoading then
                                { model
                                    | groupEditDialog =
                                        Just { dialog | isLoading = False }
                                }

                            else
                                model

                        Nothing ->
                            model

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
            ( { updatedModel | allLogins = logins, userSelectorSelect = { selectState = Select.initState (Select.selectIdentifier "user-selector"), items = menu, selectedItems = originalSelected }, userSelectorLoading = False, userSelectorError = Nothing }
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
                                    { id = g.sigintZoneDatasourceId
                                    , isSecret = g.isGroupSecret
                                    , userLogins = model.userSelectorSelect.selectedItems
                                    , shortNote = g.shortNote
                                    , longNote = g.longNote
                                    , areaOfResponsibilityId = Nothing -- Deprecated field, use areaOfResponsibilityIds
                                    , areaOfResponsibilityIds = Nothing -- Not setting areas in user selector save
                                    }
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
            let
                updatedPager = Pager.updateForNewTotalItems (List.length groups) model.orphanGroupsPager
            in
            ( { model
                | orphanGroups = RD.Success groups
                , orphanGroupsPager = updatedPager
              }
            , E.none
            )

        GotOrphanGroups (Err e) ->
            let
                currentPager = model.orphanGroupsPager
                updatedPager = { currentPager | totalItems = 0 }
            in
            ( { model
                | orphanGroups = RD.Failure e
                , orphanGroupsPager = updatedPager
              }
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
                                    , shortNote = orphanGroup.groupAdminData |> Maybe.andThen .shortNote
                                    , longNote = orphanGroup.groupAdminData |> Maybe.andThen .longNote
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

                        other ->
                            other

                -- Add the group to the appropriate datasource groups
                updatedDatasourceGroups =
                    Dict.update response.datasourceId
                        (\maybeGroups ->
                            case maybeGroups of
                                Just groups ->
                                    Just (response.groupMasterKey :: groups)

                                Nothing ->
                                    Just [ response.groupMasterKey ]
                        )
                        model.datasourceGroups

                -- Add the ZoneDatasourceGroup to the appropriate zone-datasource combination
                updatedZoneSourceGroups =
                    Dict.update ( response.zoneId, response.datasourceId )
                        (\maybeGroups ->
                            case maybeGroups of
                                Just groups ->
                                    Just (response.zoneDatasourceGroup :: groups)

                                Nothing ->
                                    Just [ response.zoneDatasourceGroup ]
                        )
                        model.zoneSourceGroups

                -- Add group info if we have the name from the response
                updatedGroupInfos =
                    case response.groupName of
                        Just name ->
                            -- Get existing group stats and admin data from orphan group data
                            let
                                existingOrphanGroup =
                                    findOrphanGroup model response.groupMasterKey

                                existingGroupStats =
                                    case existingOrphanGroup of
                                        Just orphanGroup ->
                                            orphanGroup.groupStats

                                        Nothing ->
                                            { activityLastDay = 0, activityLastWeek = 0 }

                                existingAdminData =
                                    case existingOrphanGroup of
                                        Just orphanGroup ->
                                            orphanGroup.groupAdminData

                                        Nothing ->
                                            Nothing
                            in
                            Dict.insert response.groupMasterKey
                                { masterKey = response.groupMasterKey
                                , name = name
                                , ignoreOperativny = False
                                , groupStats = existingGroupStats
                                , adminData = existingAdminData
                                , areasOfResponsibility = Nothing
                                }
                                model.groupInfos

                        Nothing ->
                            model.groupInfos
                -- Update pager totalItems based on new orphan groups count
                newOrphanGroupsCount =
                    case updatedOrphanGroups of
                        RD.Success groups ->
                            List.length groups

                        _ ->
                            0

                currentPager = model.orphanGroupsPager
                updatedPager = { currentPager | totalItems = newOrphanGroupsCount }
            in
            ( { model
                | orphanGroupAssignmentInProgress = Nothing
                , orphanGroupAssignmentError = Nothing
                , orphanGroups = updatedOrphanGroups
                , datasourceGroups = updatedDatasourceGroups
                , zoneSourceGroups = updatedZoneSourceGroups
                , groupInfos = updatedGroupInfos
                , orphanGroupsPager = updatedPager
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
                    , E.sendCmd <|
                        Api.zone_datasource_group_delete
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
                    Dict.update ( zoneId, datasourceId )
                        (\maybeGroups ->
                            case maybeGroups of
                                Just groups ->
                                    groups
                                        |> List.filter (\g -> g.groupMasterKey /= groupKey)
                                        |> Just

                                Nothing ->
                                    Nothing
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

                                Nothing ->
                                    Nothing
                        )
                        model.datasourceGroups

                -- Add back to orphan groups only if the group is not assigned to any other zone
                updatedOrphanGroups =
                    case model.orphanGroups of
                        RD.Success groups ->
                            -- Check if the group is still assigned to any other zone
                            let
                                isStillAssigned =
                                    updatedZoneSourceGroups
                                        |> Dict.values
                                        |> List.concat
                                        |> List.any (\g -> g.groupMasterKey == groupKey)
                            in
                            if isStillAssigned then
                                -- Group is still assigned to other zones, don't add to orphans
                                RD.Success groups

                            else
                                -- Group is no longer assigned anywhere, add to orphans
                                let
                                    groupInfo =
                                        Dict.get groupKey model.groupInfos

                                    newOrphanGroup : B.OrphanSignalGroupEntry
                                    newOrphanGroup =
                                        { masterKey = groupKey
                                        , name = groupInfo |> Maybe.map .name |> Maybe.withDefault ""
                                        , datasourceId = Just datasourceId
                                        , ignoreOperativny = groupInfo |> Maybe.map .ignoreOperativny |> Maybe.withDefault False
                                        , createdAt = 0 -- We don't have the original creation time, so use 0
                                        , groupStats = groupInfo |> Maybe.map .groupStats |> Maybe.withDefault { activityLastDay = 0, activityLastWeek = 0 }
                                        , groupAdminData = groupInfo |> Maybe.andThen .adminData
                                        , areasOfResponsibility = Nothing
                                        }
                                in
                                -- Only add if not already in orphan groups
                                if List.any (\g -> g.masterKey == groupKey) groups then
                                    RD.Success groups

                                else
                                    RD.Success (newOrphanGroup :: groups)

                        other ->
                            other
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
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення групи" e
            )

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
                        ( { model | orphanGroupZoneSelector = Just { groupKey = groupKey, selectedZones = [ zoneId ] } }
                        , E.none
                        )

                Nothing ->
                    -- Створюємо новий селектор для групи
                    ( { model | orphanGroupZoneSelector = Just { groupKey = groupKey, selectedZones = [ zoneId ] } }
                    , E.none
                    )

        SaveOrphanGroupZones ->
            let
                maybeSelector =
                    model.orphanGroupZoneSelector

                maybeOrphanGroup =
                    maybeSelector
                        |> Maybe.andThen (\selector -> findOrphanGroup model selector.groupKey)

                maybeDatasourceId =
                    maybeOrphanGroup
                        |> Maybe.andThen .datasourceId
            in
            case ( maybeSelector, maybeOrphanGroup, maybeDatasourceId ) of
                ( Just selector, Just orphanGroup, Just datasourceId ) ->
                    let
                        requests =
                            List.map
                                (\zoneId ->
                                    let
                                        req : B.ZoneDatasourceGroupAddReq
                                        req =
                                            { zoneId = zoneId
                                            , datasourceId = datasourceId
                                            , masterKey = selector.groupKey
                                            , isSecret = False
                                            , userLogins = []
                                            , shortNote = orphanGroup.groupAdminData |> Maybe.andThen .shortNote
                                            , longNote = orphanGroup.groupAdminData |> Maybe.andThen .longNote
                                            }
                                    in
                                    Api.zone_datasource_group_add AssignOrphanGroupDone req
                                )
                                selector.selectedZones
                    in
                    ( { model
                        | orphanGroupAssignmentInProgress = Just selector.groupKey
                        , orphanGroupAssignmentError = Nothing
                        , orphanGroupZoneSelector = Nothing
                      }
                    , E.sendCmd <| Cmd.batch requests
                    )

                ( Just _, Just _, Nothing ) ->
                    ( { model | orphanGroupAssignmentError = Just "У групи немає прив'язаного напрямку" }
                    , E.none
                    )

                ( Just _, Nothing, _ ) ->
                    ( { model | orphanGroupAssignmentError = Just "Не вдалося знайти групу" }
                    , E.none
                    )

                ( Nothing, _, _ ) ->
                    ( model, E.none )

        OrphanGroupsTableStateChanged newState ->
            ( { model | orphanGroupsTableState = newState }
            , E.none
            )

        OrphanGroupsPagerMsg pagerMsg ->
            ( { model | orphanGroupsPager = Pager.update pagerMsg model.orphanGroupsPager }
            , E.none
            )

        UpdateOrphanGroupsPagerTotalItems totalItems ->
            let
                currentPager = model.orphanGroupsPager
                updatedPager = { currentPager | totalItems = totalItems }
            in
            ( { model | orphanGroupsPager = updatedPager }
            , E.none
            )

        OpenOrphanGroupAssignmentDialog groupKey zoneIds ->
            if List.isEmpty model.allLogins then
                ( { model
                    | orphanGroupAssignmentDialog =
                        Just
                            { groupKey = groupKey
                            , zoneIds = zoneIds
                            , isSecret = False
                            , selectedUsers = []
                            , userSelectState = Select.initState (Select.selectIdentifier "orphan-group-users")
                            }
                  }
                , E.sendCmd <| Api.list_logins UserSelectorLoginsLoaded { sortBy = Nothing }
                )

            else
                ( { model
                    | orphanGroupAssignmentDialog =
                        Just
                            { groupKey = groupKey
                            , zoneIds = zoneIds
                            , isSecret = False
                            , selectedUsers = []
                            , userSelectState = Select.initState (Select.selectIdentifier "orphan-group-users")
                            }
                  }
                , E.none
                )

        CloseOrphanGroupAssignmentDialog ->
            ( { model | orphanGroupAssignmentDialog = Nothing }
            , E.none
            )

        ToggleOrphanGroupSecret ->
            case model.orphanGroupAssignmentDialog of
                Just dialog ->
                    ( { model
                        | orphanGroupAssignmentDialog =
                            Just
                                { dialog | isSecret = not dialog.isSecret }
                      }
                    , E.none
                    )

                Nothing ->
                    ( model, E.none )

        ConfirmOrphanGroupAssignment ->
            case model.orphanGroupAssignmentDialog of
                Just dialog ->
                    case findOrphanGroup model dialog.groupKey of
                        Just orphanGroup ->
                            case orphanGroup.datasourceId of
                                Just datasourceId ->
                                    let
                                        requests =
                                            List.map
                                                (\zoneId ->
                                                    let
                                                        req : B.ZoneDatasourceGroupAddReq
                                                        req =
                                                            { zoneId = zoneId
                                                            , datasourceId = datasourceId
                                                            , masterKey = dialog.groupKey
                                                            , isSecret = dialog.isSecret
                                                            , userLogins = dialog.selectedUsers
                                                            , shortNote = orphanGroup.groupAdminData |> Maybe.andThen .shortNote
                                                            , longNote = orphanGroup.groupAdminData |> Maybe.andThen .longNote
                                                            }
                                                    in
                                                    Api.zone_datasource_group_add AssignOrphanGroupDone req
                                                )
                                                dialog.zoneIds
                                    in
                                    ( { model
                                        | orphanGroupAssignmentInProgress = Just dialog.groupKey
                                        , orphanGroupAssignmentError = Nothing
                                        , orphanGroupAssignmentDialog = Nothing
                                      }
                                    , E.sendCmd <| Cmd.batch requests
                                    )

                                Nothing ->
                                    ( { model | orphanGroupAssignmentError = Just "У групи немає прив'язаного датасорса" }
                                    , E.none
                                    )

                        Nothing ->
                            ( { model | orphanGroupAssignmentError = Just "Не вдалося знайти групу" }
                            , E.none
                            )

                Nothing ->
                    ( model, E.none )

        OrphanGroupUserSelectMsg imsg ->
            case model.orphanGroupAssignmentDialog of
                Just dialog ->
                    let
                        ( mAction, imodel2, icmd ) =
                            Select.update imsg dialog.userSelectState

                        selected : List String
                        selected =
                            Le.Block.Select.multiUpdS mAction dialog.selectedUsers
                    in
                    ( { model
                        | orphanGroupAssignmentDialog =
                            Just
                                { dialog
                                    | userSelectState = imodel2
                                    , selectedUsers = selected
                                }
                      }
                    , E.sendCmd <| Cmd.map OrphanGroupUserSelectMsg icmd
                    )

                Nothing ->
                    ( model, E.none )

        ToggleGroupNoteExpansion groupMasterKey ->
            let
                updatedExpanded =
                    if Set.member groupMasterKey model.expandedGroupNotes then
                        Set.remove groupMasterKey model.expandedGroupNotes

                    else
                        Set.insert groupMasterKey model.expandedGroupNotes
            in
            ( { model | expandedGroupNotes = updatedExpanded }
            , E.none
            )

        EditGroup zoneId sourceId groupMasterKey ->
            let
                group : Maybe B.ZoneDatasourceGroup
                group =
                    Dict.get ( zoneId, sourceId ) model.zoneSourceGroups
                        |> def []
                        |> List.filter (\g -> g.groupMasterKey == groupMasterKey)
                        |> List.head

                groupName : String
                groupName =
                    Dict.get groupMasterKey model.groupInfos
                        |> Maybe.map .name
                        |> def groupMasterKey
                        |> (\name ->
                                if String.isEmpty name then
                                    String.right 5 groupMasterKey

                                else
                                    name
                           )
            in
            case group of
                Just g ->
                    if List.isEmpty model.allLogins then
                        ( { model
                            | groupEditDialog =
                                Just
                                    { zoneId = zoneId
                                    , sourceId = sourceId
                                    , groupKey = groupMasterKey
                                    , groupName = groupName
                                    , shortNote = g.shortNote |> Maybe.withDefault ""
                                    , longNote = g.longNote |> Maybe.withDefault ""
                                    , isSecret = g.isGroupSecret
                                    , selectedUsers = g.allowedUsers
                                    , userSelectState = Select.initState (Select.selectIdentifier ("group-edit-users-" ++ groupMasterKey))
                                    , areaOfResponsibilitySelector =
                                        { selected = g.areasOfResponsibility |> Maybe.withDefault [] |> List.map .id
                                        , available = RD.withDefault [] model.areasOfResponsibility
                                        , selectState = Select.initState (Select.selectIdentifier "group-area-select")
                                        }
                                    , isLoading = True
                                    , error = Nothing
                                    }
                          }
                        , E.sendCmd <| Api.list_logins UserSelectorLoginsLoaded { sortBy = Nothing }
                        )

                    else
                        ( { model
                            | groupEditDialog =
                                Just
                                    { zoneId = zoneId
                                    , sourceId = sourceId
                                    , groupKey = groupMasterKey
                                    , groupName = groupName
                                    , shortNote = g.shortNote |> Maybe.withDefault ""
                                    , longNote = g.longNote |> Maybe.withDefault ""
                                    , isSecret = g.isGroupSecret
                                    , selectedUsers = g.allowedUsers
                                    , userSelectState = Select.initState (Select.selectIdentifier ("group-edit-users-" ++ groupMasterKey))
                                    , areaOfResponsibilitySelector =
                                        { selected = g.areasOfResponsibility |> Maybe.withDefault [] |> List.map .id
                                        , available = RD.withDefault [] model.areasOfResponsibility
                                        , selectState = Select.initState (Select.selectIdentifier "group-area-select")
                                        }
                                    , isLoading = False
                                    , error = Nothing
                                    }
                          }
                        , E.none
                        )

                Nothing ->
                    ( model, E.none )

        CloseGroupEdit ->
            ( { model | groupEditDialog = Nothing }
            , E.none
            )

        UpdateGroupShortNote newShortNote ->
            case model.groupEditDialog of
                Just dialog ->
                    ( { model
                        | groupEditDialog =
                            Just { dialog | shortNote = newShortNote }
                      }
                    , E.none
                    )

                Nothing ->
                    ( model, E.none )

        UpdateGroupLongNote newLongNote ->
            case model.groupEditDialog of
                Just dialog ->
                    ( { model
                        | groupEditDialog =
                            Just { dialog | longNote = newLongNote }
                      }
                    , E.none
                    )

                Nothing ->
                    ( model, E.none )

        ToggleGroupSecretInDialog ->
            case model.groupEditDialog of
                Just dialog ->
                    ( { model
                        | groupEditDialog =
                            Just
                                { dialog
                                    | isSecret = not dialog.isSecret
                                    , selectedUsers =
                                        if not dialog.isSecret then
                                            dialog.selectedUsers
                                            -- Keep existing users when enabling secret mode

                                        else
                                            []

                                    -- Clear users when disabling secret mode
                                }
                      }
                    , E.none
                    )

                Nothing ->
                    ( model, E.none )

        GroupEditUserSelectMsg imsg ->
            case model.groupEditDialog of
                Just dialog ->
                    let
                        ( mAction, imodel2, icmd ) =
                            Select.update imsg dialog.userSelectState

                        selected : List String
                        selected =
                            Le.Block.Select.multiUpdS mAction dialog.selectedUsers
                    in
                    ( { model
                        | groupEditDialog =
                            Just
                                { dialog
                                    | userSelectState = imodel2
                                    , selectedUsers = selected
                                }
                      }
                    , E.sendCmd <| Cmd.map GroupEditUserSelectMsg icmd
                    )

                Nothing ->
                    ( model, E.none )

        SaveGroupEdit ->
            case model.groupEditDialog of
                Just dialog ->
                    let
                        group : Maybe B.ZoneDatasourceGroup
                        group =
                            Dict.get ( dialog.zoneId, dialog.sourceId ) model.zoneSourceGroups
                                |> def []
                                |> List.filter (\g -> g.groupMasterKey == dialog.groupKey)
                                |> List.head
                    in
                    case group of
                        Just g ->
                            let
                                req : B.ZoneDatasourceGroupUpdateReq
                                req =
                                    { id = g.sigintZoneDatasourceId
                                    , isSecret = dialog.isSecret
                                    , userLogins = dialog.selectedUsers
                                    , shortNote =
                                        if String.isEmpty (String.trim dialog.shortNote) then
                                            Nothing

                                        else
                                            Just dialog.shortNote
                                    , longNote =
                                        if String.isEmpty (String.trim dialog.longNote) then
                                            Nothing

                                        else
                                            Just dialog.longNote
                                    , areaOfResponsibilityId = Nothing
                                    , areaOfResponsibilityIds = if List.isEmpty dialog.areaOfResponsibilitySelector.selected then Nothing else Just dialog.areaOfResponsibilitySelector.selected
                                    }
                            in
                            ( { model
                                | groupEditDialog =
                                    Just { dialog | isLoading = True, error = Nothing }
                              }
                            , E.sendCmd <| Api.zone_datasource_group_update SaveGroupEditDone req
                            )

                        Nothing ->
                            ( { model
                                | groupEditDialog =
                                    Just { dialog | error = Just "Група не знайдена" }
                              }
                            , E.none
                            )

                Nothing ->
                    ( model, E.none )

        SaveGroupEditDone (Ok updatedGroup) ->
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
                                -- Update the area of responsibility from the dialog state
                                let
                                    newAreasOfResponsibility =
                                        case model.groupEditDialog of
                                            Just dialog ->
                                                let
                                                    selectedAreas =
                                                        dialog.areaOfResponsibilitySelector.selected
                                                            |> List.filterMap (\areaId ->
                                                                RD.withDefault [] model.areasOfResponsibility
                                                                    |> List.filter (\area -> area.id == areaId)
                                                                    |> List.head
                                                            )
                                                in
                                                if List.isEmpty selectedAreas then
                                                    Nothing
                                                else
                                                    Just selectedAreas

                                            Nothing ->
                                                updatedGroup.areasOfResponsibility
                                in
                                { updatedGroup | areasOfResponsibility = newAreasOfResponsibility }

                            else
                                g
                        )
                        oldGroups

                m2 : Model
                m2 =
                    { model
                        | groupEditDialog = Nothing
                        , zoneSourceGroups = Dict.insert ( zoneId, sourceId ) newGroups model.zoneSourceGroups
                    }
            in
            ( m2, E.none )

        SaveGroupEditDone (Err e) ->
            case model.groupEditDialog of
                Just dialog ->
                    ( { model
                        | groupEditDialog =
                            Just
                                { dialog
                                    | isLoading = False
                                    , error = Just "Не вдалося зберегти зміни"
                                }
                      }
                    , E.none
                    )

                Nothing ->
                    ( model, E.none )

        EditOrphanGroup groupKey ->
            case findOrphanGroup model groupKey of
                Just orphanGroup ->
                    let
                        groupName : String
                        groupName =
                            if String.isEmpty orphanGroup.name then
                                String.right 5 groupKey

                            else
                                orphanGroup.name
                    in
                    ( { model
                        | orphanGroupEditDialog =
                            Just
                                { groupKey = groupKey
                                , groupName = groupName
                                , shortNote = orphanGroup.groupAdminData |> Maybe.andThen .shortNote |> Maybe.withDefault ""
                                , longNote = orphanGroup.groupAdminData |> Maybe.andThen .longNote |> Maybe.withDefault ""
                                , areaOfResponsibilitySelector =
                                    { selected = orphanGroup.areasOfResponsibility |> Maybe.withDefault [] |> List.map .id
                                    , available = RD.withDefault [] model.areasOfResponsibility
                                    , selectState = Select.initState (Select.selectIdentifier "area-select")
                                    }
                                , isLoading = False
                                , error = Nothing
                                }
                      }
                    , E.none
                    )

                Nothing ->
                    ( model, E.none )

        CloseOrphanGroupEdit ->
            ( { model | orphanGroupEditDialog = Nothing }
            , E.none
            )

        UpdateOrphanGroupShortNote newShortNote ->
            case model.orphanGroupEditDialog of
                Just dialog ->
                    ( { model
                        | orphanGroupEditDialog =
                            Just { dialog | shortNote = newShortNote }
                      }
                    , E.none
                    )

                Nothing ->
                    ( model, E.none )

        UpdateOrphanGroupLongNote newLongNote ->
            case model.orphanGroupEditDialog of
                Just dialog ->
                    ( { model
                        | orphanGroupEditDialog =
                            Just { dialog | longNote = newLongNote }
                      }
                    , E.none
                    )

                Nothing ->
                    ( model, E.none )

        SaveOrphanGroupEdit ->
            case model.orphanGroupEditDialog of
                Just dialog ->
                    let
                        req : B.GroupUpdateReq
                        req =
                            { masterKey = dialog.groupKey
                            , shortNote =
                                if String.isEmpty (String.trim dialog.shortNote) then
                                    Nothing

                                else
                                    Just dialog.shortNote
                            , longNote =
                                if String.isEmpty (String.trim dialog.longNote) then
                                    Nothing

                                else
                                    Just dialog.longNote
                            , areaOfResponsibilityId = Nothing
                            , areaOfResponsibilityIds = if List.isEmpty dialog.areaOfResponsibilitySelector.selected then Nothing else Just dialog.areaOfResponsibilitySelector.selected
                            }
                    in
                    ( { model
                        | orphanGroupEditDialog =
                            Just { dialog | isLoading = True, error = Nothing }
                      }
                    , E.sendCmd <| Api.messenger_edit_group OrphanGroupEditDone req
                    )

                Nothing ->
                    ( model, E.none )

        OrphanGroupEditDone (Ok updatedGroup) ->
            let
                -- Update the orphan groups list with the new data
                updatedOrphanGroups =
                    case model.orphanGroups of
                        RD.Success groups ->
                            groups
                                |> List.map
                                    (\group ->
                                        if group.masterKey == updatedGroup.masterKey then
                                            let
                                                newAdminData =
                                                    case ( updatedGroup.shortNote, updatedGroup.longNote ) of
                                                        ( Nothing, Nothing ) ->
                                                            Nothing

                                                        _ ->
                                                            Just
                                                                { shortNote = updatedGroup.shortNote
                                                                , longNote = updatedGroup.longNote
                                                                }

                                                -- Use the areas of responsibility from the updated group
                                                newAreasOfResponsibility =
                                                    updatedGroup.areasOfResponsibility
                                            in
                                            { group
                                                | groupAdminData = newAdminData
                                                , areasOfResponsibility = newAreasOfResponsibility
                                            }

                                        else
                                            group
                                    )
                                |> RD.Success

                        other ->
                            other
            in
            ( { model
                | orphanGroupEditDialog = Nothing
                , orphanGroups = updatedOrphanGroups
              }
            , E.none
            )

        OrphanGroupEditDone (Err e) ->
            case model.orphanGroupEditDialog of
                Just dialog ->
                    ( { model
                        | orphanGroupEditDialog =
                            Just
                                { dialog
                                    | isLoading = False
                                    , error = Just "Не вдалося зберегти зміни"
                                }
                      }
                    , E.none
                    )

                Nothing ->
                    ( model, E.none )

        LoadAreasOfResponsibility ->
            ( model, E.sendCmd <| Api.aor_list AreasOfResponsibilityLoaded { sortBy = Nothing } )

        AreasOfResponsibilityLoaded (Ok areas) ->
            ( { model | areasOfResponsibility = RD.Success areas }
            , E.none
            )

        AreasOfResponsibilityLoaded (Err e) ->
            ( { model | areasOfResponsibility = RD.Failure e }
            , E.none
            )

        OrphanGroupAreaSelectMsg imsg ->
            case model.orphanGroupEditDialog of
                Just dialog ->
                    let
                        ( mAction, imodel2, icmd ) =
                            Select.update imsg dialog.areaOfResponsibilitySelector.selectState

                        selected : List Int
                        selected =
                            Le.Block.Select.multiUpdI mAction dialog.areaOfResponsibilitySelector.selected
                    in
                    ( { model
                        | orphanGroupEditDialog =
                            Just { dialog | areaOfResponsibilitySelector = { selected = selected, available = dialog.areaOfResponsibilitySelector.available, selectState = imodel2 } }
                      }
                    , E.sendCmd <| Cmd.map OrphanGroupAreaSelectMsg icmd
                    )

                Nothing ->
                    ( model, E.none )

        UpdateOrphanGroupAreaOfResponsibility newArea ->
            case model.orphanGroupEditDialog of
                Just dialog ->
                    ( { model
                        | orphanGroupEditDialog =
                            Just { dialog | areaOfResponsibilitySelector = { selected = newArea |> Maybe.map List.singleton |> Maybe.withDefault [], available = dialog.areaOfResponsibilitySelector.available, selectState = dialog.areaOfResponsibilitySelector.selectState } }
                      }
                    , E.none
                    )

                Nothing ->
                    ( model, E.none )

        ShowFullNoteModal groupKey note ->
            ( { model | fullNoteModal = Just { groupKey = groupKey, note = note } }
            , E.none
            )

        CloseFullNoteModal ->
            ( { model | fullNoteModal = Nothing }
            , E.none
            )

        GroupAreaSelectMsg imsg ->
            case model.groupEditDialog of
                Just dialog ->
                    let
                        ( mAction, imodel2, icmd ) =
                            Select.update imsg dialog.areaOfResponsibilitySelector.selectState

                        selected : List Int
                        selected =
                            Le.Block.Select.multiUpdI mAction dialog.areaOfResponsibilitySelector.selected
                    in
                    ( { model
                        | groupEditDialog =
                            Just { dialog | areaOfResponsibilitySelector = { selected = selected, available = dialog.areaOfResponsibilitySelector.available, selectState = imodel2 } }
                      }
                    , E.sendCmd <| Cmd.map GroupAreaSelectMsg icmd
                    )

                Nothing ->
                    ( model, E.none )

        UpdateGroupAreaOfResponsibility newArea ->
            case model.groupEditDialog of
                Just dialog ->
                    ( { model
                        | groupEditDialog =
                            Just { dialog | areaOfResponsibilitySelector = { selected = newArea |> Maybe.map List.singleton |> Maybe.withDefault [], available = dialog.areaOfResponsibilitySelector.available, selectState = dialog.areaOfResponsibilitySelector.selectState } }
                      }
                    , E.none
                    )

                Nothing ->
                    ( model, E.none )

        UpdateAreaOfResponsibilityFilter newFilter ->
            ( { model | areaOfResponsibilityFilter = newFilter }
            , E.none
            )

        AreaOfResponsibilityFilterMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.areaOfResponsibilityFilterSelectState

                selected : Maybe Int
                selected =
                    Le.Block.Select.singleUpd mAction model.areaOfResponsibilityFilter
            in
            ( { model
                | areaOfResponsibilityFilter = selected
                , areaOfResponsibilityFilterSelectState = imodel2
              }
            , E.sendCmd <| Cmd.map AreaOfResponsibilityFilterMsg icmd
            )


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none



-- Helper functions for datasource grouping and tabs


type alias DatasourceType =
    { id : Int
    , name : String
    , datasources : List ( Int, B.Datasource )
    }


renderFullNoteModal : Bool -> Model -> Html Msg
renderFullNoteModal isDark model =
    case model.fullNoteModal of
        Just modal ->
            div [ class "fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" ]
                [ div
                    [ class
                        (if isDark then
                            "bg-gray-800 border border-gray-600 rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto"
                         else
                            "bg-white border border-gray-300 rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto"
                        )
                    ]
                    [ div [ class "flex items-center justify-between mb-4" ]
                        [ h3
                            [ class
                                (if isDark then
                                    "text-gray-100 text-lg font-semibold"
                                 else
                                    "text-gray-900 text-lg font-semibold"
                                )
                            ]
                            [ text "Повна нотатка" ]
                        , button
                            [ class "text-gray-500 hover:text-gray-700 transition-colors"
                            , onClick CloseFullNoteModal
                            ]
                            [ i [ class "bi bi-x-lg text-xl" ] [] ]
                        ]
                    , div
                        [ class
                            (if isDark then
                                "text-gray-200 whitespace-pre-wrap"
                             else
                                "text-gray-800 whitespace-pre-wrap"
                            )
                        ]
                        [ text modal.note ]
                    ]
                ]

        Nothing ->
            text ""

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
                        [ text <| "Неприв'язані групи (" ++ String.fromInt (List.length groups) ++ ")" ]
                    , div [ class "table-responsive-modern" ]
                        [ renderOrphanGroupsTable model groups ]
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


getGroupDisplayName : Model -> String -> String
getGroupDisplayName model groupKey =
    case findOrphanGroup model groupKey of
        Just group ->
            if String.isEmpty group.name then
                String.right 5 group.masterKey

            else
                group.name

        Nothing ->
            groupKey


getZoneName : Model -> Int -> String
getZoneName model zoneId =
    List.filterMap
        (\( id, zone ) ->
            if id == zoneId then
                Just zone.name

            else
                Nothing
        )
        model.zones
        |> List.head
        |> Maybe.withDefault (String.fromInt zoneId)


renderOrphanGroupEditSidebar : Bool -> Model -> OrphanGroupEditDialog -> Html Msg
renderOrphanGroupEditSidebar isDark model dialog =
    Sidebar.view True
        CloseOrphanGroupEdit
        [ div [ class "flex flex-col h-full" ]
            [ -- Header
              div
                [ class <|
                    "px-6 py-3 border-b "
                        ++ (if isDark then
                                "border-gray-600"

                            else
                                "border-gray-200"
                           )
                ]
                [ div [ class "flex items-center justify-between" ]
                    [ div []
                        [ div
                            [ class <|
                                "text-sm "
                                    ++ (if isDark then
                                            "text-gray-400"

                                        else
                                            "text-gray-500"
                                       )
                            ]
                            [ text "Редагувати групу" ]
                        , h3
                            [ class <|
                                "text-lg font-semibold leading-tight "
                                    ++ (if isDark then
                                            "text-gray-100"

                                        else
                                            "text-gray-900"
                                       )
                            ]
                            [ text dialog.groupName ]
                        ]
                    , button
                        [ class <|
                            if isDark then
                                "text-gray-400 hover:text-gray-200"

                            else
                                "text-gray-500 hover:text-gray-700"
                        , onClick CloseOrphanGroupEdit
                        ]
                        [ i [ class "bi bi-x-lg" ] [] ]
                    ]
                ]
            , -- Content
              div [ class "flex-1 overflow-y-auto px-6 py-4" ]
                [ div [ class "space-y-6" ]
                    [ -- Notes section
                      div []
                        [ h4
                            [ class <|
                                "text-sm font-semibold mb-3 "
                                    ++ (if isDark then
                                            "text-gray-300"

                                        else
                                            "text-gray-700"
                                       )
                            ]
                            [ text "📝 Нотатки" ]
                        , div [ class "space-y-3" ]
                            [ -- Short note field
                              div []
                                [ label
                                    [ class <|
                                        "block text-sm font-medium mb-1 "
                                            ++ (if isDark then
                                                    "text-gray-300"

                                                else
                                                    "text-gray-700"
                                               )
                                    ]
                                    [ text "Коротка нотатка:" ]
                                , input
                                    [ type_ "text"
                                    , value dialog.shortNote
                                    , onInput UpdateOrphanGroupShortNote
                                    , placeholder "Коротка нотатка для швидкого перегляду..."
                                    , class <|
                                        "w-full px-3 py-2 border rounded-md "
                                            ++ (if isDark then
                                                    "bg-gray-700 border-gray-600 text-gray-100"

                                                else
                                                    "bg-white border-gray-300 text-gray-900"
                                               )
                                    ]
                                    []
                                ]
                            , -- Long note field
                              div []
                                [ label
                                    [ class <|
                                        "block text-sm font-medium mb-1 "
                                            ++ (if isDark then
                                                    "text-gray-300"

                                                else
                                                    "text-gray-700"
                                               )
                                    ]
                                    [ text "Довга нотатка:" ]
                                , textarea
                                    [ value dialog.longNote
                                    , onInput UpdateOrphanGroupLongNote
                                    , placeholder "Детальна інформація про групу..."
                                    , rows 6
                                    , class <|
                                        "w-full px-3 py-2 border rounded-md "
                                            ++ (if isDark then
                                                    "bg-gray-700 border-gray-600 text-gray-100"

                                                else
                                                    "bg-white border-gray-300 text-gray-900"
                                               )
                                    ]
                                    []
                                ]
                            ]
                        ]
                    , -- Секція смуг
                      div []
                        [ h4
                            [ class <|
                                "text-sm font-semibold mb-3 "
                                    ++ (if isDark then
                                            "text-gray-300"

                                        else
                                            "text-gray-700"
                                       )
                            ]
                            [ text "🗺️ Смуга відповідальності" ]
                        , div [ class "space-y-3" ]
                            [ -- Селектор смуг
                              div []
                                [ label
                                    [ class <|
                                        "block text-sm font-medium mb-2 "
                                            ++ (if isDark then
                                                    "text-gray-300"

                                                else
                                                    "text-gray-700"
                                               )
                                    ]
                                    [ text "Смуга відповідальності:" ]
                                , let
                                    selectedItems =
                                        dialog.areaOfResponsibilitySelector.selected
                                            |> List.filterMap (\areaId ->
                                                dialog.areaOfResponsibilitySelector.available
                                                    |> List.filter (\area -> area.id == areaId)
                                                    |> List.head
                                                    |> Maybe.map (\area -> Select.basicMenuItem { item = area.id, label = area.name })
                                            )

                                    availableItems =
                                        dialog.areaOfResponsibilitySelector.available
                                            |> List.map (\area -> Select.basicMenuItem { item = area.id, label = area.name })

                                    selectConfig =
                                        { loading = False
                                        , disabled = dialog.isLoading
                                        , isDark = isDark
                                        , clearable = True
                                        }
                                  in
                                  Html.map OrphanGroupAreaSelectMsg <|
                                    Styled.toUnstyled <|
                                        Le.Block.Select.renderSelect
                                            selectedItems
                                            dialog.areaOfResponsibilitySelector.selectState
                                            availableItems
                                            "виберіть смуги"
                                            selectConfig
                                ]
                            , -- Інформація про вибрані смуги
                              let
                                selectedAreas =
                                    dialog.areaOfResponsibilitySelector.selected
                                        |> List.filterMap (\areaId ->
                                            dialog.areaOfResponsibilitySelector.available
                                                |> List.filter (\area -> area.id == areaId)
                                                |> List.head
                                        )
                              in
                              if List.isEmpty selectedAreas then
                                div [ class "text-sm text-gray-500 italic" ] [ text "Смуги не вибрані" ]
                              else
                                div [ class "space-y-2" ]
                                    (selectedAreas |> List.map (\area ->
                                        div [ class "p-3 bg-blue-50 rounded border border-blue-200" ]
                                            [ div [ class "text-sm font-medium text-blue-800" ] [ text area.name ]
                                            , case area.description of
                                                Just desc ->
                                                    div [ class "text-sm text-blue-600 mt-1" ] [ text desc ]

                                                Nothing ->
                                                    text ""
                                            , div [ class "text-xs text-blue-500 mt-2" ]
                                                [ text ("Діапазон: " ++ String.fromFloat area.leftBound ++ " - " ++ String.fromFloat area.rightBound)
                                                ]
                                            ]
                                    ))
                            ]
                        ]
                    , -- Error message
                      case dialog.error of
                        Just error ->
                            div [ class "p-3 bg-red-50 border border-red-200 rounded-md" ]
                                [ div [ class "text-sm text-red-600" ] [ text error ]
                                ]

                        Nothing ->
                            text ""
                    ]
                ]
            , -- Footer
              div
                [ class <|
                    "px-6 py-3 border-t "
                        ++ (if isDark then
                                "border-gray-600"

                            else
                                "border-gray-200"
                           )
                ]
                [ div [ class "flex justify-end gap-3" ]
                    [ Button.view
                        (Button.new { label = "Скасувати", onClick = CloseOrphanGroupEdit }
                            |> Button.withStyleSecondary
                        )
                    , if dialog.isLoading then
                        div [ class "flex items-center gap-2" ]
                            [ Le.Block.Spinner.loadingSpinner2Sm
                            , span [ class "text-sm text-gray-600" ] [ text "Збереження..." ]
                            ]

                      else
                        Button.view
                            (Button.new { label = "Зберегти", onClick = SaveOrphanGroupEdit }
                                |> Button.withPrimary
                            )
                    ]
                ]
            ]
        ]


renderGroupEditSidebar : Bool -> Model -> GroupEditDialog -> Html Msg
renderGroupEditSidebar isDark model dialog =
    Sidebar.view True
        CloseGroupEdit
        [ div [ class "flex flex-col h-full" ]
            [ -- Header
              div
                [ class <|
                    "px-6 py-3 border-b "
                        ++ (if isDark then
                                "border-gray-600"

                            else
                                "border-gray-200"
                           )
                ]
                [ div [ class "flex items-center justify-between" ]
                    [ div []
                        [ div
                            [ class <|
                                "text-sm "
                                    ++ (if isDark then
                                            "text-gray-400"

                                        else
                                            "text-gray-500"
                                       )
                            ]
                            [ text "Редагувати групу" ]
                        , h3
                            [ class <|
                                "text-lg font-semibold leading-tight "
                                    ++ (if isDark then
                                            "text-gray-100"

                                        else
                                            "text-gray-900"
                                       )
                            ]
                            [ text dialog.groupName ]
                        ]
                    , button
                        [ class <|
                            if isDark then
                                "text-gray-400 hover:text-gray-200"

                            else
                                "text-gray-500 hover:text-gray-700"
                        , onClick CloseGroupEdit
                        ]
                        [ i [ class "bi bi-x-lg" ] [] ]
                    ]
                ]
            , -- Content
              div [ class "flex-1 overflow-y-auto px-6 py-4" ]
                [ div [ class "space-y-6" ]
                    [ -- Area of Responsibility section (first)
                      div []
                        [ h4
                            [ class <|
                                "text-sm font-semibold mb-3 "
                                    ++ (if isDark then
                                            "text-gray-300"

                                        else
                                            "text-gray-700"
                                       )
                            ]
                            [ text "🗺️ Смуга відповідальності" ]
                        , div [ class "space-y-3" ]
                            [ -- Area selector
                              div []
                                [ label
                                    [ class <|
                                        "block text-sm font-medium mb-2 "
                                            ++ (if isDark then
                                                    "text-gray-300"

                                                else
                                                    "text-gray-700"
                                               )
                                    ]
                                    [ text "Виберіть смугу:" ]
                                , let
                                    selectedItems =
                                        dialog.areaOfResponsibilitySelector.selected
                                            |> List.filterMap (\areaId ->
                                                dialog.areaOfResponsibilitySelector.available
                                                    |> List.filter (\area -> area.id == areaId)
                                                    |> List.head
                                                    |> Maybe.map (\area -> Select.basicMenuItem { item = area.id, label = area.name })
                                            )

                                    availableItems =
                                        dialog.areaOfResponsibilitySelector.available
                                            |> List.map (\area -> Select.basicMenuItem { item = area.id, label = area.name })

                                    selectConfig =
                                        { loading = False
                                        , disabled = dialog.isLoading
                                        , isDark = isDark
                                        , clearable = True
                                        }
                                  in
                                  Html.map GroupAreaSelectMsg <|
                                    Styled.toUnstyled <|
                                        Le.Block.Select.renderSelect
                                            selectedItems
                                            dialog.areaOfResponsibilitySelector.selectState
                                            availableItems
                                            "виберіть смуги"
                                            selectConfig
                                ]
                            , -- Selected areas info
                              div []
                                [ let
                                    selectedAreas =
                                        dialog.areaOfResponsibilitySelector.selected
                                            |> List.filterMap (\areaId ->
                                                dialog.areaOfResponsibilitySelector.available
                                                    |> List.filter (\area -> area.id == areaId)
                                                    |> List.head
                                            )
                                  in
                                  if List.isEmpty selectedAreas then
                                    div [ class "text-sm text-gray-500 italic" ] [ text "Смуги не вибрані" ]
                                  else
                                    div [ class "space-y-2" ]
                                        (selectedAreas |> List.map (\area ->
                                            div [ class "p-3 bg-blue-50 rounded border border-blue-200" ]
                                                [ div [ class "text-sm font-medium text-blue-800" ] [ text area.name ]
                                                , case area.description of
                                                    Just desc ->
                                                        div [ class "text-sm text-blue-600 mt-1" ] [ text desc ]

                                                    Nothing ->
                                                        text ""
                                                , div [ class "text-xs text-blue-500 mt-2" ]
                                                    [ text ("Діапазон: " ++ String.fromFloat area.leftBound ++ " - " ++ String.fromFloat area.rightBound)
                                                    ]
                                                ]
                                        ))
                                ]
                            ]
                        ]
                    , -- Visibility section (second)
                      div []
                        [ h4
                            [ class <|
                                "text-sm font-semibold mb-3 "
                                    ++ (if isDark then
                                            "text-gray-300"

                                        else
                                            "text-gray-700"
                                       )
                            ]
                            [ text "🔒 Видимість" ]
                        , div [ class "space-y-3" ]
                            [ -- Secret checkbox
                              Toggle.new
                                { onToggle = ToggleGroupSecretInDialog
                                , label = "Прихована група"
                                , id = "group-edit-secret-toggle"
                                }
                                |> Toggle.view dialog.isSecret
                            , -- Reserved space for user selector (always present to prevent layout shift)
                              div [ class "min-h-16" ]
                                [ if dialog.isSecret then
                                    div []
                                        [ label
                                            [ class <|
                                                "block text-sm font-medium mb-2 "
                                                    ++ (if isDark then
                                                            "text-gray-300"

                                                        else
                                                            "text-gray-700"
                                                       )
                                            ]
                                            [ text "👥 Користувачі, яким видима група:" ]
                                        , Html.map GroupEditUserSelectMsg <|
                                            Styled.toUnstyled <|
                                                Le.Block.Select.renderSelectVirtual
                                                    (List.map (\user -> Select.basicMenuItem { item = user, label = user }) dialog.selectedUsers)
                                                    dialog.userSelectState
                                                    (List.map (\user -> Select.basicMenuItem { item = user, label = user }) model.allLogins)
                                                    "виберіть користувачів"
                                                    { loading = False, disabled = dialog.isLoading, isDark = isDark }
                                        ]

                                  else
                                    div
                                        [ class <|
                                            "flex items-center h-16 text-sm "
                                                ++ (if isDark then
                                                        "text-gray-400"

                                                    else
                                                        "text-gray-500"
                                                   )
                                        ]
                                        [ text "👁️ Група видима всім користувачам" ]
                                ]
                            ]
                        ]
                    , -- Notes section (third)
                      div []
                        [ h4
                            [ class <|
                                "text-sm font-semibold mb-3 "
                                    ++ (if isDark then
                                            "text-gray-300"

                                        else
                                            "text-gray-700"
                                       )
                            ]
                            [ text "📝 Нотатки" ]
                        , div [ class "space-y-3" ]
                            [ -- Short note field
                              div []
                                [ label
                                    [ class <|
                                        "block text-sm font-medium mb-1 "
                                            ++ (if isDark then
                                                    "text-gray-300"

                                                else
                                                    "text-gray-700"
                                               )
                                    ]
                                    [ text "Коротка нотатка:" ]
                                , input
                                    [ type_ "text"
                                    , value dialog.shortNote
                                    , onInput UpdateGroupShortNote
                                    , placeholder "Коротка нотатка для швидкого перегляду..."
                                    , class <|
                                        "w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 "
                                            ++ (if isDark then
                                                    "bg-gray-700 border-gray-600 text-gray-100 placeholder-gray-400"

                                                else
                                                    "bg-white border-gray-300"
                                               )
                                    , disabled dialog.isLoading
                                    ]
                                    []
                                ]
                            , -- Long note field
                              div []
                                [ label
                                    [ class <|
                                        "block text-sm font-medium mb-1 "
                                            ++ (if isDark then
                                                    "text-gray-300"

                                                else
                                                    "text-gray-700"
                                               )
                                    ]
                                    [ text "Детальна інформація:" ]
                                , textarea
                                    [ value dialog.longNote
                                    , onInput UpdateGroupLongNote
                                    , placeholder "Детальна інформація про групу, яка буде показана при розгортанні..."
                                    , rows 4
                                    , class <|
                                        "w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-vertical "
                                            ++ (if isDark then
                                                    "bg-gray-700 border-gray-600 text-gray-100 placeholder-gray-400"

                                                else
                                                    "bg-white border-gray-300"
                                               )
                                    , disabled dialog.isLoading
                                    ]
                                    []
                                ]
                            ]
                        ]
                    , -- Error display
                      case dialog.error of
                        Just error ->
                            div [ class "p-3 bg-red-100 border border-red-400 text-red-700 rounded" ]
                                [ text error ]

                        Nothing ->
                            text ""
                    ]
                ]
            , -- Footer with actions
              div
                [ class <|
                    "px-6 py-4 border-t "
                        ++ (if isDark then
                                "border-gray-600 bg-gray-800"

                            else
                                "border-gray-200 bg-gray-50"
                           )
                ]
                [ div [ class "flex justify-end gap-3" ]
                    [ Button.view
                        (Button.new { label = "Скасувати", onClick = CloseGroupEdit }
                            |> Button.withStyleSecondary
                            |> Button.withDisabled dialog.isLoading
                        )
                    , if dialog.isLoading then
                        div [ class "flex items-center gap-2 px-4 py-2" ]
                            [ Le.Block.Spinner.loadingSpinner2Sm
                            , span
                                [ class <|
                                    "text-sm "
                                        ++ (if isDark then
                                                "text-gray-300"

                                            else
                                                "text-gray-600"
                                           )
                                ]
                                [ text "Збереження..." ]
                            ]

                      else
                        Button.view
                            (Button.new { label = "Зберегти", onClick = SaveGroupEdit })
                    ]
                ]
            ]
        ]


renderOrphanGroupAssignmentDialog : Bool -> Model -> OrphanGroupAssignmentDialog -> Html Msg
renderOrphanGroupAssignmentDialog isDark model dialog =
    ModalDialog.modalDialog True
        CloseOrphanGroupAssignmentDialog
        [ class "medium-modal overflow-visible" ]
        [ div [ class "p-6" ]
            [ div [ class "mb-4" ]
                [ h3 [ class "text-lg font-semibold" ]
                    [ text "Налаштування групи" ]
                ]
            , div [ class "mb-4" ]
                [ text ("Група: " ++ getGroupDisplayName model dialog.groupKey)
                , br [] []
                , text ("Напрямки: " ++ String.join ", " (List.map (getZoneName model) dialog.zoneIds))
                ]
            , div [ class "mb-4" ]
                [ Toggle.new
                    { onToggle = ToggleOrphanGroupSecret
                    , label = "Прихована група"
                    , id = "orphan-group-secret-toggle"
                    }
                    |> Toggle.view dialog.isSecret
                ]
            , div [ class "mb-4" ]
                [ if dialog.isSecret then
                    div []
                        [ label [ class "block text-sm font-medium mb-2" ]
                            [ text "Користувачі, яким видима група:" ]
                        , Html.map OrphanGroupUserSelectMsg <|
                            Styled.toUnstyled <|
                                Le.Block.Select.renderSelectVirtual
                                    (List.map (\user -> Select.basicMenuItem { item = user, label = user }) dialog.selectedUsers)
                                    dialog.userSelectState
                                    (List.map (\user -> Select.basicMenuItem { item = user, label = user }) model.allLogins)
                                    "виберіть користувачів"
                                    { loading = False, disabled = False, isDark = isDark }
                        ]

                  else
                    div [ class "h-16" ] []

                -- Зарезервоване місце під select
                ]
            , case model.orphanGroupAssignmentError of
                Just error ->
                    div [ class "mb-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded" ]
                        [ text error ]

                Nothing ->
                    text ""
            , div [ class "flex justify-end gap-3" ]
                [ Button.view
                    (Button.new { label = "Скасувати", onClick = CloseOrphanGroupAssignmentDialog }
                        |> Button.withStyleSecondary
                    )
                , if model.orphanGroupAssignmentInProgress == Just dialog.groupKey then
                    div [ class "flex items-center gap-2" ]
                        [ Le.Block.Spinner.loadingSpinner2Sm
                        , span [ class "text-sm text-gray-600" ] [ text "Додавання..." ]
                        ]

                  else
                    Button.view
                        (Button.new { label = "Додати групу", onClick = ConfirmOrphanGroupAssignment })
                ]
            ]
        ]


renderOrphanGroupsTable : Model -> List B.OrphanSignalGroupEntry -> Html Msg
renderOrphanGroupsTable model groups =
    let
        pager =
            model.orphanGroupsPager

        totalItems =
            List.length groups

        updatedPager =
            { pager | totalItems = totalItems }

        tableConfig : Table.Config B.OrphanSignalGroupEntry Msg
        tableConfig =
            Table.customConfig
                { toId = .masterKey
                , toMsg = OrphanGroupsTableStateChanged
                , columns =
                    [ Table.stringColumn "Назва групи" getGroupDisplayNameLocal |> Table.withColumnWidth "16%"
                    , Table.veryCustomColumn
                        { name = "Створено"
                        , viewData =
                            \o ->
                                { attributes = [ class "col-narrow" ]
                                , children =
                                    [ text <| formatCreatedAt o
                                    ]
                                }
                        , sorter = Table.decreasingOrIncreasingBy .createdAt
                        }
                        |> Table.withColumnWidth "10%"
                    , Table.veryCustomColumn
                        { name = "Джерело"
                        , viewData = renderDatasourceIcon
                        , sorter = Table.unsortable
                        }
                        |> Table.withColumnWidth "15%"
                    , Table.veryCustomColumn
                        { name = "Смуга"
                        , viewData = renderAreaOfResponsibilityColumn
                        , sorter = Table.unsortable
                        }
                        |> Table.withColumnWidth "14%"
                    -- Колонки з двостороннім сортуванням: за замовчуванням спадаюче (найновіші/найбільш активні спочатку)
                    , Table.veryCustomColumn
                        { name = "День"
                        , viewData = renderDayActivityColumn
                        , sorter = Table.decreasingOrIncreasingBy (.groupStats >> .activityLastDay)
                        }
                        |> Table.withColumnWidth "6%"
                    , Table.veryCustomColumn
                        { name = "Тиждень"
                        , viewData = renderWeekActivityColumn
                        , sorter = Table.decreasingOrIncreasingBy (.groupStats >> .activityLastWeek)
                        }
                        |> Table.withColumnWidth "6%"
                    , Table.veryCustomColumn
                        { name = "Нотатки"
                        , viewData = renderCombinedNoteColumn
                        , sorter = Table.unsortable
                        }
                        |> Table.withColumnWidth "23%"
                    , Table.veryCustomColumn
                        { name = "Дії"
                        , viewData = renderActionsColumn model
                        , sorter = Table.unsortable
                        }
                        |> Table.withColumnWidth "10%"
                    ]
                , customizations =
                    { tableAttrs = [ class "base-table" ]
                    , caption = Nothing
                    , thead = customThead
                    , tfoot = Nothing
                    , tbodyAttrs = []
                    , rowAttrs = customRowAttrs
                    }
                }

        customTheadHelp : ( String, Config.Status, Attribute Msg ) -> Html Msg
        customTheadHelp ( name, status, click ) =
            let
                sortIcon =
                    case status of
                        Config.Unsortable ->
                            text ""

                        Config.Sortable selected ->
                            span
                                [ style "color"
                                    (if selected then
                                        "var(--ochre-normal)"

                                     else
                                        "var(--color-text-muted)"
                                    )
                                ]
                                [ text " ⇓" ]

                        Config.Reversible Nothing ->
                            span [ style "color" "var(--color-text-muted)" ] [ text " ⇕" ]

                        Config.Reversible (Just isReversed) ->
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

        customThead : List ( String, Config.Status, Attribute Msg ) -> Table.HtmlDetails Msg
        customThead headers =
            { attributes = []
            , children = List.map customTheadHelp headers
            }

        customRowAttrs : B.OrphanSignalGroupEntry -> List (Attribute Msg)
        customRowAttrs _ =
            []

        getGroupDisplayNameLocal : B.OrphanSignalGroupEntry -> String
        getGroupDisplayNameLocal group =
            if String.isEmpty group.name then
                String.right 5 group.masterKey

            else
                group.name

        formatCreatedAt : B.OrphanSignalGroupEntry -> String
        formatCreatedAt group =
            let
                timestamp : Int
                timestamp =
                    group.createdAt

                date : String
                date =
                    -- Convert milliseconds to date string in DD-MM-YY format
                    if timestamp > 0 then
                        let
                            posixTime =
                                Time.millisToPosix timestamp

                            -- Use Europe/Kyiv timezone (hardcoded for now)
                            timeZone =
                                TimeZone.europe__kyiv ()
                        in
                        Le.Time.renderDateF6 timeZone posixTime
                            |> String.replace "." "-"

                    else
                        "-"
            in
            date

        renderDatasourceIcon : B.OrphanSignalGroupEntry -> Table.HtmlDetails Msg
        renderDatasourceIcon group =
            let
                datasourceInfo =
                    case group.datasourceId of
                        Just datasourceId ->
                            List.filterMap
                                (\( id, datasource ) ->
                                    if id == datasourceId then
                                        Just datasource

                                    else
                                        Nothing
                                )
                                model.datasources
                                |> List.head

                        Nothing ->
                            Nothing

                ( iconClass, tooltipText, iconColor ) =
                    case datasourceInfo of
                        Just datasource ->
                            case String.toLower datasource.kind of
                                "signal" ->
                                    ( "bi-signal", "Signal", "text-blue-600" )

                                "whatsapp" ->
                                    ( "bi-whatsapp", "WhatsApp", "text-green-600" )

                                _ ->
                                    ( "bi-question-circle", datasource.displayName, "text-gray-500" )

                        Nothing ->
                            ( "bi-question-circle", "Невідоме джерело", "text-gray-500" )
            in
            { attributes = []
            , children =
                [ div [ class "flex items-center justify-start gap-2" ]
                    [ i [ class ("bi " ++ iconClass ++ " " ++ iconColor ++ " text-lg"), title tooltipText ] []
                    , case datasourceInfo of
                        Just datasource ->
                            span [ class "text-sm text-muted" ] [ text datasource.displayName ]

                        Nothing ->
                            text ""
                    ]
                ]
            }

        renderDayActivityColumn : B.OrphanSignalGroupEntry -> Table.HtmlDetails Msg
        renderDayActivityColumn group =
            { attributes = []
            , children =
                [ span [ class "text-sm", title "Активність за день" ]
                    [ text (String.fromInt group.groupStats.activityLastDay) ]
                ]
            }

        renderWeekActivityColumn : B.OrphanSignalGroupEntry -> Table.HtmlDetails Msg
        renderWeekActivityColumn group =
            { attributes = []
            , children =
                [ span [ class "text-sm", title "Активність за тиждень" ]
                    [ text (String.fromInt group.groupStats.activityLastWeek) ]
                ]
            }

        renderAreaOfResponsibilityColumn : B.OrphanSignalGroupEntry -> Table.HtmlDetails Msg
        renderAreaOfResponsibilityColumn group =
            let
                areas = group.areasOfResponsibility |> Maybe.withDefault []

                displayText : String
                displayText =
                    if List.isEmpty areas then
                        "-"
                    else
                        areas |> List.map .name |> String.join ", "

                tooltipText : String
                tooltipText =
                    if List.isEmpty areas then
                        "Смуги не призначені"
                    else
                        areas
                            |> List.map (\area ->
                                case area.description of
                                    Just desc ->
                                        area.name ++ " - " ++ desc

                                    Nothing ->
                                        area.name
                            )
                            |> String.join "; "
            in
            { attributes = []
            , children =
                [ span [ class "text-sm", title tooltipText ]
                    [ text displayText ]
                ]
            }



        renderCombinedNoteColumn : B.OrphanSignalGroupEntry -> Table.HtmlDetails Msg
        renderCombinedNoteColumn group =
            let
                shortNote : Maybe String
                shortNote =
                    group.groupAdminData |> Maybe.andThen .shortNote

                longNote : Maybe String
                longNote =
                    group.groupAdminData |> Maybe.andThen .longNote

                displayText : String
                displayText =
                    case shortNote of
                        Just note ->
                            if String.length note > 50 then
                                String.left 50 note ++ "..."

                            else
                                note

                        Nothing ->
                            "-"

                hasLongNote : Bool
                hasLongNote =
                    case longNote of
                        Just note ->
                            not (String.isEmpty (String.trim note))

                        Nothing ->
                            False
            in
            { attributes = []
            , children =
                [ div [ class "flex items-center gap-2" ]
                    [ span [ class "text-sm" ] [ text displayText ]
                    , if hasLongNote then
                        button
                            [ class "flex items-center justify-center w-5 h-5 rounded-full text-blue-500 hover:text-blue-600 transition-all duration-200"
                            , onClick (ShowFullNoteModal group.masterKey (Maybe.withDefault "" longNote))
                            , title "Показати повну нотатку"
                            ]
                            [ i [ class "bi bi-info-circle-fill text-xs" ] [] ]

                      else
                        text ""
                    ]
                ]
            }

        renderActionsColumn : Model -> B.OrphanSignalGroupEntry -> Table.HtmlDetails Msg
        renderActionsColumn currentModel group =
            let
                isAssigning : Bool
                isAssigning =
                    currentModel.orphanGroupAssignmentInProgress == Just group.masterKey

                zoneCount : Int
                zoneCount =
                    List.length currentModel.zones
            in
            { attributes = []
            , children =
                [ if isAssigning then
                    div [ class "flex items-center gap-1" ]
                        [ Le.Block.Spinner.loadingSpinner2Sm
                        , span [ class "text-xs text-gray-600" ] [ text "Призначення..." ]
                        ]

                  else if zoneCount == 0 then
                    span [ class "text-xs text-gray-500" ] [ text "Немає напрямків" ]

                  else
                    div [ class "flex items-center gap-1" ]
                        [ -- Edit button
                          button
                            [ class "flex items-center justify-center w-6 h-6 rounded bg-blue-100 hover:bg-blue-200 text-blue-700 transition-colors"
                            , onClick (EditOrphanGroup group.masterKey)
                            , title "Редагувати нотатки"
                            ]
                            [ i [ class "bi bi-pencil text-xs" ] [] ]
                        , -- Zone assignment controls
                          if zoneCount == 1 then
                            -- Single zone - compact display
                            case List.head currentModel.zones of
                                Just ( zoneId, zone ) ->
                                    button
                                        [ class "flex items-center justify-center w-6 h-6 rounded bg-green-100 hover:bg-green-200 text-green-700 transition-colors"
                                        , onClick (OpenOrphanGroupAssignmentDialog group.masterKey [ zoneId ])
                                        , title ("Додати до " ++ zone.name)
                                        ]
                                        [ i [ class "bi bi-plus text-xs" ] [] ]

                                Nothing ->
                                    text ""

                          else
                            -- Multiple zones - compact zone selector
                            let
                                selectedZones =
                                    case currentModel.orphanGroupZoneSelector of
                                        Just selector ->
                                            if selector.groupKey == group.masterKey then
                                                selector.selectedZones

                                            else
                                                []

                                        Nothing ->
                                            []

                                hasSelection =
                                    not (List.isEmpty selectedZones)
                            in
                            div [ class "flex items-center gap-1" ]
                                [ -- Zone count indicator
                                  span [ class "text-xs text-gray-600" ]
                                    [ text (String.fromInt (List.length selectedZones) ++ "/" ++ String.fromInt zoneCount) ]
                                , -- Add button if zones selected
                                  if hasSelection then
                                    button
                                        [ class "flex items-center justify-center w-6 h-6 rounded bg-green-100 hover:bg-green-200 text-green-700 transition-colors"
                                        , onClick (OpenOrphanGroupAssignmentDialog group.masterKey selectedZones)
                                        , title "Додати до вибраних напрямків"
                                        ]
                                        [ i [ class "bi bi-plus text-xs" ] [] ]

                                  else
                                    button
                                        [ class "flex items-center justify-center w-6 h-6 rounded bg-gray-100 hover:bg-gray-200 text-gray-600 transition-colors"
                                        , onClick (OpenOrphanGroupZoneSelector group.masterKey)
                                        , title "Вибрати напрямки"
                                        ]
                                        [ i [ class "bi bi-gear text-xs" ] [] ]
                                ]
                        ]
                ]
            }

        -- Спочатку сортуємо всі дані, потім застосовуємо пагінацію
        sortedGroups =
            Table.getSortedData tableConfig model.orphanGroupsTableState groups

        paginatedGroups =
            Pager.getPageData updatedPager sortedGroups
    in
    div []
        [ Table.view tableConfig model.orphanGroupsTableState paginatedGroups
        , Pager.view updatedPager
            |> Html.map OrphanGroupsPagerMsg
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

        -- Convert each datasource to its own DatasourceType (no grouping)
        datasourceTypes : List DatasourceType
        datasourceTypes =
            List.indexedMap
                (\index ( sourceId, datasource ) ->
                    let
                        -- Get icon for datasource type
                        iconClass : String
                        iconClass =
                            case String.toLower datasource.kind of
                                "signal" ->
                                    "bi-signal"

                                "whatsapp" ->
                                    "bi-whatsapp"

                                _ ->
                                    "bi-question-circle"

                        -- Calculate total groups for this datasource
                        totalGroups : Int
                        totalGroups =
                            let
                                groups : List B.ZoneDatasourceGroup
                                groups =
                                    Dict.get ( zoneId, sourceId ) model.zoneSourceGroups |> def []
                            in
                            List.length groups
                    in
                    { id = sourceId -- Use sourceId as the tab ID instead of index
                    , name = iconClass ++ " " ++ datasource.displayName ++ " (" ++ String.fromInt totalGroups ++ " груп)"
                    , datasources = [ ( sourceId, datasource ) ] -- Single datasource per tab
                    }
                )
                zoneDatasources
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

        -- Create tab definitions with icon info
        tabDefinitions : List { id : Int, label : String, iconClass : String, displayName : String, totalGroups : Int }
        tabDefinitions =
            List.map
                (\dsType ->
                    let
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
                                dsType.datasources

                        -- Get icon class for datasource type
                        iconClass : String
                        iconClass =
                            case List.head dsType.datasources of
                                Just ( _, datasource ) ->
                                    case String.toLower datasource.kind of
                                        "signal" ->
                                            "bi-signal"

                                        "whatsapp" ->
                                            "bi-whatsapp"

                                        _ ->
                                            "bi-question-circle"

                                Nothing ->
                                    "bi-question-circle"
                    in
                    { id = dsType.id
                    , label = dsType.name
                    , iconClass = iconClass
                    , displayName =
                        case List.head dsType.datasources of
                            Just ( _, datasource ) ->
                                datasource.displayName
                            Nothing ->
                                dsType.name
                    , totalGroups = totalGroups
                    }
                )
                datasourceTypes

        -- Create tab definitions with icons for custom rendering
        tabDefinitionsWithIcons : List { id : Int, label : String, iconClass : String, displayName : String, totalGroups : Int }
        tabDefinitionsWithIcons =
            List.map
                (\dsType ->
                    let
                        parts = String.split " " dsType.name
                        iconClass = List.head parts |> Maybe.withDefault "bi-question-circle"
                        displayName = List.drop 1 parts |> List.take (List.length parts - 2) |> String.join " "
                        totalGroups = List.drop (List.length parts - 1) parts |> List.head |> Maybe.withDefault "0" |> String.dropLeft 1 |> String.dropRight 6 |> String.toInt |> Maybe.withDefault 0
                    in
                    { id = dsType.id
                    , label = dsType.name
                    , iconClass = iconClass
                    , displayName = displayName
                    , totalGroups = totalGroups
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
                        |> List.filter
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
                                let
                                    nameMatches : Bool
                                    nameMatches =
                                        String.isEmpty model.groupNameFilter
                                            || String.contains (String.toLower model.groupNameFilter) (String.toLower groupName)

                                    areaMatches : Bool
                                    areaMatches =
                                        case model.areaOfResponsibilityFilter of
                                            Just areaId ->
                                                group.areasOfResponsibility
                                                    |> Maybe.withDefault []
                                                    |> List.any (\area -> area.id == areaId)

                                            Nothing ->
                                                True
                                in
                                nameMatches && areaMatches
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

        -- Custom tab rendering with HTML icons
        renderCustomTabs : Html Msg
        renderCustomTabs =
            div [ class "tabs-container" ]
                [ div [ class "tabs-nav tabs-nav-scrollable" ]
                    (List.map (renderCustomTab activeTab) tabDefinitions)
                ]

        renderCustomTab : Int -> { id : Int, label : String, iconClass : String, displayName : String, totalGroups : Int } -> Html Msg
        renderCustomTab activeTabId tab =
            let
                isActive = tab.id == activeTabId
            in
            button
                [ classList
                    [ ( "tab-button active", isActive )
                    , ( "tab-button", not isActive )
                    ]
                , onClick (ZoneTabChanged zoneId tab.id)
                ]
                [ i [ class ("bi " ++ tab.iconClass ++ " mr-2") ] []
                , span [] [ text tab.displayName ]
                , span [ class "ml-1 text-xs opacity-70" ] [ text ("(" ++ String.fromInt tab.totalGroups ++ ")") ]
                , if isActive then
                    div [ class "tab-indicator" ] []
                  else
                    text ""
                ]


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
                [ -- Tab navigation with HTML icons
                  renderCustomTabs
                , -- Tab content
                  div [ class "mt-4" ] [ tabContent ]
                ]
        ]


mainBlock : Bool -> Model -> B.User -> Html Msg
mainBlock isDark model user =
    div [ class "space-y-6" ]
        [ renderOrphanGroupsSection isDark model user
        , renderFullNoteModal isDark model
        , div [ class "bg-[var(--bs-body-bg)] rounded-lg border p-6" ]
            [ h2 [ class "text-xl font-semibold mb-4" ] [ text "Напрямки" ]
            , div
                [ class
                    (if isDark then
                        "mb-6 flex items-center gap-6 p-4 bg-gradient-to-r from-gray-800 to-gray-700 border border-gray-600 rounded-lg shadow-lg transform transition-all duration-300 ease-in-out hover:shadow-xl"

                     else
                        "mb-6 flex items-center gap-6 p-4 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg shadow-sm transform transition-all duration-300 ease-in-out hover:shadow-md hover:border-blue-300"
                    )
                ]
                [ div
                    [ class
                        (if isDark then
                            "flex items-center gap-2 text-blue-300"

                         else
                            "flex items-center gap-2 text-blue-700"
                        )
                    ]
                    [ i [ class "bi bi-funnel-fill text-lg" ] []
                    , span [ class "font-medium text-sm" ] [ text "Фільтри" ]
                    ]
                , div [ class "flex-1 flex items-center gap-3" ]
                    [ div [ class "flex items-center gap-2" ]
                        [ i [ class "text-gray-500" ] [ i [ class "bi bi-search" ] [] ]
                        , input
                            [ type_ "text"
                            , id "group-name-filter"
                            , value model.groupNameFilter
                            , onInput UpdateGroupNameFilter
                            , placeholder "Пошук по назві групи..."
                            , class
                                (if isDark then
                                    "px-3 py-2 text-sm border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 bg-gray-700 text-gray-100 placeholder-gray-400 shadow-sm transition-all duration-200"

                                 else
                                    "px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white shadow-sm transition-all duration-200"
                                )
                            ]
                            []
                        ]
                    , div
                        [ class
                            (if isDark then
                                "flex items-center gap-2 px-3 py-2 bg-gray-700 border border-gray-600 rounded-md shadow-sm"

                             else
                                "flex items-center gap-2 px-3 py-2 bg-white border border-gray-300 rounded-md shadow-sm"
                            )
                        ]
                        [ i [ class "text-gray-500" ] [ i [ class "bi bi-eye-slash" ] [] ]
                        , Toggle.new
                            { onToggle = ToggleShowOnlyHidden
                            , label = "Лише приховані"
                            , id = "show-only-hidden-filter"
                            }
                            |> Toggle.view model.showOnlyHidden
                        ]
                    , let
                        selectedItem =
                            Maybe.map
                                (\areaId ->
                                    Select.basicMenuItem
                                        { item = areaId
                                        , label =
                                            RD.withDefault [] model.areasOfResponsibility
                                                |> List.filter (\area -> area.id == areaId)
                                                |> List.head
                                                |> Maybe.map .name
                                                |> Maybe.withDefault ("Смуга " ++ String.fromInt areaId)
                                        }
                                )
                                model.areaOfResponsibilityFilter

                        availableItems =
                            RD.withDefault [] model.areasOfResponsibility
                                |> List.map (\area -> Select.basicMenuItem { item = area.id, label = area.name })

                        selectConfig =
                            { loading = False
                            , disabled = False
                            , isDark = isDark
                            , clearable = True
                            }
                      in
                      div [ class "w-64" ]
                        [ Html.map AreaOfResponsibilityFilterMsg <|
                            Styled.toUnstyled <|
                                Le.Block.Select.renderSelectSingle
                                    selectedItem
                                    model.areaOfResponsibilityFilterSelectState
                                    availableItems
                                    "Всі смуги"
                                    selectConfig
                        ]
                    ]
                ]
            , div [ class "space-y-6" ] (List.map (zoneCard2 isDark model user) model.zones)
            ]
        ]


body : Bool -> Shared.Model -> B.User -> Model -> List (Html Msg)
body dark shared user model =
    [ div [ class "mt-2 w-5/6 mx-auto" ] [ mainBlock dark model user ]
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
                                        |> Button.withStyleSecondary
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
                                        |> Button.withStyleSecondary
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
        ++ (case model.orphanGroupAssignmentDialog of
                Just dialog ->
                    [ renderOrphanGroupAssignmentDialog dark model dialog ]

                Nothing ->
                    []
           )
        ++ (case model.groupEditDialog of
                Just dialog ->
                    [ renderGroupEditSidebar dark model dialog ]

                Nothing ->
                    []
           )
        ++ (case model.orphanGroupEditDialog of
                Just dialog ->
                    [ renderOrphanGroupEditSidebar dark model dialog ]

                Nothing ->
                    []
           )


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "Адмін: напрямки"
    , body = body dark shared user model
    }
