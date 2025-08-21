module Pages.Admin.Organisms exposing (FieldError, FormField, Model, Msg, OrganismEdit, page)

import Api
import Auth
import Bindings as B
import Components.Button as Button
import Components.Checkbox as Checkbox
import Components.Sidebar as Sidebar
import Components.Table as Table
import Components.Table.Column as TableColumn
import Components.Table.Config as TableConfig
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Styled as Styled
import Layouts
import Le.Block.Select
import Le.Components exposing (..)
import Le.ErrorHandling
import Le.Time
import Le.Types exposing (..)
import Le.Utils exposing (..)
import List.Extra as ListX
import Maybe
import Page exposing (Page)
import Route exposing (Route)
import Select
import Set
import Shared
import Shared.Model exposing (isDarkMode)
import Task
import Time
import TimeZone
import Validate
import View exposing (View)
import Views


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


groupName : B.SignalGroupFull -> String
groupName group =
    if group.name == "" then
        "Без назви (id=" ++ String.left 6 group.masterKey ++ "..." ++ ")"

    else
        group.name


getOrganismGroups : Int -> List B.OrganismGroup -> List String
getOrganismGroups organismId organismGroups =
    organismGroups
        |> List.filter (\og -> og.organismId == organismId)
        |> List.map .masterKey


getParentGroups : Int -> List B.OrganismGroup -> List String
getParentGroups parentId organismGroups =
    getOrganismGroups parentId organismGroups


getAvailableGroupsForOrganism : Maybe Int -> List B.OrganismGroup -> List B.SignalGroupFull -> List B.SignalGroupFull
getAvailableGroupsForOrganism maybeParentId organismGroups allGroups =
    case maybeParentId of
        Nothing ->
            -- Немає батька, всі групи доступні
            allGroups

        Just parentId ->
            let
                parentGroups =
                    getParentGroups parentId organismGroups
            in
            if List.isEmpty parentGroups then
                -- У батька немає груп, всі групи доступні
                allGroups

            else
                -- Тільки групи батька доступні
                allGroups
                    |> List.filter (\group -> List.member group.masterKey parentGroups)


type alias Model =
    { formErrors : Dict String String
    , timeZone : Maybe Time.Zone
    , organisms : List B.Organism
    , tableState : Table.State
    , inpName : String
    , autoAddGroups : Bool
    , inpRole :
        { selectState : Select.State
        , items : List (Select.MenuItem String)
        , selectedItems : List String
        }
    , inpGroups :
        { selectState : Select.State
        , items : List (Select.MenuItem String)
        , selectedItems : List String
        }
    , inpParentOrganism :
        { selectState : Select.State
        , items : List (Select.MenuItem Int)
        , selectedItem : Maybe Int
        }
    , fieldsErrors : List FieldError
    , groups : List B.SignalGroupFull
    , organismGroups : List B.OrganismGroup
    , editOrganism : Maybe ( Int, OrganismEdit )
    , groupsValidation : Maybe (List String)
    }


type alias OrganismEdit =
    { inpName : String
    , autoAddGroups : Bool
    , enabled : Bool
    , inpRole :
        { selectState : Select.State
        , items : List (Select.MenuItem String)
        , selectedItems : List String
        }
    , inpGroups :
        { selectState : Select.State
        , items : List (Select.MenuItem String)
        , selectedItems : List String
        }
    , inpParentOrganism :
        { selectState : Select.State
        , items : List (Select.MenuItem Int)
        , selectedItem : Maybe Int
        }
    , fieldsErrors : List FieldError
    , groupsValidation : Maybe (List String)
    }


roles : List String
roles =
    [ "Admin", "Rer", "Bpla", "Full", "Basic", "UnitsEditor", "CallsignsEditor" ]


type FormField
    = Name
    | Roles


type alias FieldError =
    ( FormField, String )


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , organisms = []
      , inpName = ""
      , autoAddGroups = False
      , inpGroups =
            { selectState = Select.initState (Select.selectIdentifier "sel-group-add")
            , items = []
            , selectedItems = []
            }
      , inpRole =
            { selectState = Select.initState (Select.selectIdentifier "sel-role-add")
            , items = roles |> List.map (\x -> Select.basicMenuItem { item = x, label = x })
            , selectedItems = []
            }
      , inpParentOrganism =
            { selectState = Select.initState (Select.selectIdentifier "sel-parent-add")
            , items = []
            , selectedItem = Nothing
            }
      , fieldsErrors = []
      , timeZone = Nothing
      , groups = []
      , organismGroups = []
      , editOrganism = Nothing
      , groupsValidation = Nothing
      , tableState = Table.initialSort "Назва"
      }
    , E.sendCmd <|
        Cmd.batch
            [ Api.list_organisms GotOrganisms { sortBy = Nothing }
            , Api.organism_all_groups GotAllGroups
            , Api.organism_group_list GotOrganismGroups
            , Task.attempt GotTimeZone Le.Time.getZone
            ]
    )


type Msg
    = SetTableState Table.State
    | GotOrganisms (Result ApiError (List B.Organism))
    | AddRoleSelMsg (Select.Msg String)
    | EditRoleSelMsg (Select.Msg String)
    | AddGroupSelMsg (Select.Msg String)
    | EditGroupSelMsg (Select.Msg String)
    | AddParentSelMsg (Select.Msg Int)
    | EditParentSelMsg (Select.Msg Int)
    | AddOrganism
    | AddOrganismDone (Result ApiError B.Organism)
    | ToggleAutoAddGroups
    | ToggleEditAutoAddGroups
    | ToggleEditEnabled
    | EditOrganism Int
    | CloseEditSidebar
    | GotTimeZone (Result TimeZone.Error ( String, Time.Zone ))
    | SetName String
    | SetEditName String
    | GotAllGroups (Result ApiError (List B.SignalGroupFull))
    | GotOrganismGroups (Result ApiError (List B.OrganismGroup))
    | AddGroupToOrganismDone Int String Bool (Result ApiError ())
    | RemoveGroupFromOrganismDone Int String (Result ApiError ())
    | EditOrganismSave
    | EditOrganismCancel
    | EditOrganismDone (Result ApiError B.Organism)


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        SetTableState newTableState ->
            ( { model | tableState = newTableState }, E.none )

        GotOrganisms (Err e) ->
            ( model, Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження організмів" e )

        GotOrganisms (Ok res) ->
            let
                organismsMenuItems =
                    res |> List.map (\x -> Select.basicMenuItem { item = x.id, label = x.name })

                inpParentOrganism =
                    model.inpParentOrganism

                inpParentOrganism2 =
                    { inpParentOrganism | items = organismsMenuItems }
            in
            ( { model | organisms = res, inpParentOrganism = inpParentOrganism2 }, E.none )

        AddRoleSelMsg selMsg ->
            let
                ( mAction, iState, iCmd ) =
                    Select.update selMsg model.inpRole.selectState

                inpRole =
                    model.inpRole

                inpRole2 =
                    { inpRole | selectedItems = Le.Block.Select.multiUpdS mAction inpRole.selectedItems, selectState = iState }
            in
            ( { model | inpRole = inpRole2 }
            , E.batch
                [ E.sendCmd <| Cmd.map AddRoleSelMsg iCmd
                ]
            )

        EditRoleSelMsg selMsg ->
            case model.editOrganism of
                Just ( id, editOrganism ) ->
                    let
                        ( mAction, iState, iCmd ) =
                            Select.update selMsg editOrganism.inpRole.selectState

                        inpRole =
                            editOrganism.inpRole

                        inpRole2 =
                            { inpRole | selectedItems = Le.Block.Select.multiUpdS mAction inpRole.selectedItems, selectState = iState }

                        editOrganism2 =
                            { editOrganism | inpRole = inpRole2 }
                    in
                    ( { model | editOrganism = Just ( id, editOrganism2 ) }
                    , E.batch
                        [ E.sendCmd <| Cmd.map EditRoleSelMsg iCmd
                        ]
                    )

                Nothing ->
                    ( model, E.none )

        AddGroupSelMsg selMsg ->
            let
                ( mAction, iState, iCmd ) =
                    Select.update selMsg model.inpGroups.selectState

                inpGroups =
                    model.inpGroups

                inpGroups2 =
                    { inpGroups | selectedItems = Le.Block.Select.multiUpdS mAction inpGroups.selectedItems, selectState = iState }

                selectedParentId =
                    model.inpParentOrganism.selectedItem

                -- Only validate on meaningful selection actions, not on hover/menu events
                groupsValidation =
                    case mAction of
                        Just (Select.Select _) ->
                            let
                                groups =
                                    validateGroupsForParent model.organismGroups model.groups inpGroups2.selectedItems selectedParentId
                            in
                            if List.isEmpty groups then
                                Nothing

                            else
                                Just groups

                        Just (Select.Deselect _) ->
                            let
                                groups =
                                    validateGroupsForParent model.organismGroups model.groups inpGroups2.selectedItems selectedParentId
                            in
                            if List.isEmpty groups then
                                Nothing

                            else
                                Just groups

                        Just Select.Clear ->
                            Nothing

                        _ ->
                            model.groupsValidation

                -- Keep existing validation state
            in
            ( { model | inpGroups = inpGroups2, groupsValidation = groupsValidation }
            , E.batch
                [ E.sendCmd <| Cmd.map AddGroupSelMsg iCmd
                ]
            )

        EditGroupSelMsg selMsg ->
            case model.editOrganism of
                Just ( id, editOrganism ) ->
                    let
                        ( mAction, iState, iCmd ) =
                            Select.update selMsg editOrganism.inpGroups.selectState

                        inpGroups =
                            editOrganism.inpGroups

                        inpGroups2 =
                            { inpGroups | selectedItems = Le.Block.Select.multiUpdS mAction inpGroups.selectedItems, selectState = iState }

                        selectedParentId =
                            editOrganism.inpParentOrganism.selectedItem

                        -- Only validate on meaningful selection actions, not on hover/menu events
                        groupsValidation =
                            case mAction of
                                Just (Select.Select _) ->
                                    let
                                        groups =
                                            validateGroupsForParent model.organismGroups model.groups inpGroups2.selectedItems selectedParentId
                                    in
                                    if List.isEmpty groups then
                                        Nothing

                                    else
                                        Just groups

                                Just (Select.Deselect _) ->
                                    let
                                        groups =
                                            validateGroupsForParent model.organismGroups model.groups inpGroups2.selectedItems selectedParentId
                                    in
                                    if List.isEmpty groups then
                                        Nothing

                                    else
                                        Just groups

                                Just Select.Clear ->
                                    Nothing

                                _ ->
                                    editOrganism.groupsValidation

                        -- Keep existing validation state
                        editOrganism2 =
                            { editOrganism | inpGroups = inpGroups2, groupsValidation = groupsValidation }
                    in
                    ( { model | editOrganism = Just ( id, editOrganism2 ) }
                    , E.batch
                        [ E.sendCmd <| Cmd.map EditGroupSelMsg iCmd
                        ]
                    )

                Nothing ->
                    ( model, E.none )

        AddParentSelMsg selMsg ->
            let
                ( mAction, iState, iCmd ) =
                    Select.update selMsg model.inpParentOrganism.selectState

                inpParentOrganism =
                    model.inpParentOrganism

                inpParentOrganism2 =
                    { inpParentOrganism | selectedItem = Le.Block.Select.singleUpd mAction inpParentOrganism.selectedItem, selectState = iState }

                selectedParentId =
                    inpParentOrganism2.selectedItem

                -- Only validate on meaningful selection actions, not on hover/menu events
                groupsValidation =
                    case mAction of
                        Just (Select.Select _) ->
                            let
                                groups =
                                    validateGroupsForParent model.organismGroups model.groups model.inpGroups.selectedItems selectedParentId
                            in
                            if List.isEmpty groups then
                                Nothing

                            else
                                Just groups

                        Just (Select.Deselect _) ->
                            let
                                groups =
                                    validateGroupsForParent model.organismGroups model.groups model.inpGroups.selectedItems selectedParentId
                            in
                            if List.isEmpty groups then
                                Nothing

                            else
                                Just groups

                        Just Select.Clear ->
                            Nothing

                        _ ->
                            model.groupsValidation

                -- Keep existing validation state
            in
            ( { model | inpParentOrganism = inpParentOrganism2, groupsValidation = groupsValidation }
            , E.batch
                [ E.sendCmd <| Cmd.map AddParentSelMsg iCmd
                ]
            )

        EditParentSelMsg selMsg ->
            case model.editOrganism of
                Just ( id, editOrganism ) ->
                    let
                        ( mAction, iState, iCmd ) =
                            Select.update selMsg editOrganism.inpParentOrganism.selectState

                        inpParentOrganism =
                            editOrganism.inpParentOrganism

                        inpParentOrganism2 =
                            { inpParentOrganism | selectedItem = Le.Block.Select.singleUpd mAction inpParentOrganism.selectedItem, selectState = iState }

                        selectedParentId =
                            inpParentOrganism2.selectedItem

                        -- Only validate on meaningful selection actions, not on hover/menu events
                        groupsValidation =
                            case mAction of
                                Just (Select.Select _) ->
                                    let
                                        groups =
                                            validateGroupsForParent model.organismGroups model.groups editOrganism.inpGroups.selectedItems selectedParentId
                                    in
                                    if List.isEmpty groups then
                                        Nothing

                                    else
                                        Just groups

                                Just (Select.Deselect _) ->
                                    let
                                        groups =
                                            validateGroupsForParent model.organismGroups model.groups editOrganism.inpGroups.selectedItems selectedParentId
                                    in
                                    if List.isEmpty groups then
                                        Nothing

                                    else
                                        Just groups

                                Just Select.Clear ->
                                    Nothing

                                _ ->
                                    editOrganism.groupsValidation

                        -- Keep existing validation state
                        editOrganism2 =
                            { editOrganism | inpParentOrganism = inpParentOrganism2, groupsValidation = groupsValidation }
                    in
                    ( { model | editOrganism = Just ( id, editOrganism2 ) }
                    , E.batch
                        [ E.sendCmd <| Cmd.map EditParentSelMsg iCmd
                        ]
                    )

                Nothing ->
                    ( model, E.none )

        AddOrganism ->
            case Validate.validate validator model of
                Ok _ ->
                    ( { model | fieldsErrors = [] }
                    , E.sendCmd <|
                        Api.create_organism AddOrganismDone
                            { name = model.inpName
                            , parentId = model.inpParentOrganism.selectedItem
                            , groupAutoLink = Just model.autoAddGroups
                            , roles = model.inpRole.selectedItems
                            }
                    )

                Err errors ->
                    ( { model | fieldsErrors = errors }, E.none )

        AddOrganismDone (Ok organism) ->
            let
                inpRole =
                    model.inpRole

                inpRole2 =
                    { inpRole | items = [] }

                inpParentOrganism =
                    model.inpParentOrganism

                inpParentOrganism2 =
                    { inpParentOrganism | items = [] }

                m2 =
                    { model
                        | inpName = ""
                        , inpRole = inpRole2
                        , inpParentOrganism = inpParentOrganism2
                        , autoAddGroups = False
                        , organisms = organism :: model.organisms
                        , fieldsErrors = []
                        , groupsValidation = Nothing
                    }
            in
            let
                selectedParentId =
                    model.inpParentOrganism.selectedItem

                -- Filter groups based on parent constraints
                groupsToAdd =
                    case selectedParentId of
                        Nothing ->
                            model.inpGroups.selectedItems

                        Just pId ->
                            let
                                parentOrganism =
                                    model.organisms |> ListX.find (\o -> o.id == pId)

                                parentGroups =
                                    case parentOrganism of
                                        Nothing ->
                                            []

                                        Just p ->
                                            getOrganismGroups p.id model.organismGroups

                                -- If parent has empty groups list, it means access to all groups
                                -- Only filter if parent has specific groups defined
                            in
                            if List.isEmpty parentGroups then
                                model.inpGroups.selectedItems

                            else
                                let
                                    parentGroupsSet =
                                        Set.fromList parentGroups

                                    selectedGroupsSet =
                                        Set.fromList model.inpGroups.selectedItems
                                in
                                Set.toList (Set.intersect selectedGroupsSet parentGroupsSet)
            in
            ( m2
            , E.sendCmd <|
                Cmd.batch
                    (List.map
                        (\x ->
                            Api.add_group_to_organism (AddGroupToOrganismDone organism.id x False) { organismId = organism.id, groupName = x }
                        )
                        groupsToAdd
                    )
            )

        AddOrganismDone (Err e) ->
            ( model, Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання організму" e )

        AddGroupToOrganismDone organismId groupId edited (Ok _) ->
            if edited then
                let
                    -- Додаємо новий зв'язок організм-група до organismGroups
                    newOrganismGroup =
                        { organismId = organismId, masterKey = groupId }

                    organismGroups =
                        newOrganismGroup :: model.organismGroups
                in
                ( { model | organismGroups = organismGroups }, E.none )

            else
                let
                    inpGroups =
                        model.inpGroups

                    inpGroups2 =
                        { inpGroups | selectedItems = inpGroups.selectedItems |> ListX.remove groupId }

                    -- Додаємо новий зв'язок організм-група до organismGroups
                    newOrganismGroup =
                        { organismId = organismId, masterKey = groupId }

                    organismGroups =
                        newOrganismGroup :: model.organismGroups
                in
                ( { model | inpGroups = inpGroups2, organismGroups = organismGroups }, E.none )

        AddGroupToOrganismDone _ _ _ (Err e) ->
            ( model, Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання групи до організму" e )

        RemoveGroupFromOrganismDone organismId groupId (Ok _) ->
            let
                -- Видаляємо зв'язок організм-група з organismGroups
                organismGroups =
                    model.organismGroups
                        |> List.filter (\og -> not (og.organismId == organismId && og.masterKey == groupId))
            in
            ( { model | organismGroups = organismGroups }, E.none )

        RemoveGroupFromOrganismDone _ _ (Err e) ->
            ( model, Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення групи з організму" e )

        ToggleAutoAddGroups ->
            ( { model | autoAddGroups = not model.autoAddGroups }, E.none )

        ToggleEditAutoAddGroups ->
            case model.editOrganism of
                Just ( id, editOrganism ) ->
                    let
                        editOrganism2 =
                            { editOrganism | autoAddGroups = not editOrganism.autoAddGroups }
                    in
                    ( { model | editOrganism = Just ( id, editOrganism2 ) }, E.none )

                Nothing ->
                    ( model, E.none )

        ToggleEditEnabled ->
            case model.editOrganism of
                Just ( id, editOrganism ) ->
                    let
                        editOrganism2 =
                            { editOrganism | enabled = not editOrganism.enabled }
                    in
                    ( { model | editOrganism = Just ( id, editOrganism2 ) }, E.none )

                Nothing ->
                    ( model, E.none )

        EditOrganism rowId ->
            let
                organism =
                    model.organisms
                        |> ListX.find (\o -> o.id == rowId)
                        |> Maybe.map
                            (\o ->
                                ( rowId
                                , { inpName = o.name
                                  , autoAddGroups = False
                                  , enabled = o.enabled
                                  , inpRole =
                                        { selectState = Select.initState (Select.selectIdentifier "sel-role-edit")
                                        , items = roles |> List.map (\x -> Select.basicMenuItem { item = x, label = x })
                                        , selectedItems = o.roles
                                        }
                                  , inpGroups =
                                        { selectState = Select.initState (Select.selectIdentifier "sel-groups-edit")
                                        , items = model.groups |> List.map (\x -> Select.basicMenuItem { item = x.masterKey, label = x.name })
                                        , selectedItems = getOrganismGroups o.id model.organismGroups
                                        }
                                  , inpParentOrganism =
                                        { selectState = Select.initState (Select.selectIdentifier "sel-parent-edit")
                                        , items = model.organisms |> List.filter (\x -> x.id /= o.id) |> List.map (\x -> Select.basicMenuItem { item = x.id, label = x.name })
                                        , selectedItem = o.parentId
                                        }
                                  , fieldsErrors = []
                                  , groupsValidation = Nothing
                                  }
                                )
                            )
            in
            ( { model | editOrganism = organism }, E.none )

        GotTimeZone (Ok ( _, zone )) ->
            ( { model | timeZone = Just zone }
            , E.none
            )

        GotTimeZone (Err e) ->
            ( model
            , E.showError "Помилка завантаження часового поясу"
            )

        SetName value ->
            ( { model | inpName = value }, E.none )

        SetEditName value ->
            case model.editOrganism of
                Just ( id, editOrganism ) ->
                    let
                        editOrganism2 =
                            { editOrganism | inpName = value }
                    in
                    ( { model | editOrganism = Just ( id, editOrganism2 ) }, E.none )

                Nothing ->
                    ( model, E.none )

        GotAllGroups (Err e) ->
            ( model, Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження груп" e )

        GotAllGroups (Ok res) ->
            let
                groupsMenuItems =
                    res |> List.map (\x -> Select.basicMenuItem { item = x.masterKey, label = x.name })

                inpGroups =
                    model.inpGroups

                inpGroups2 =
                    { inpGroups | items = groupsMenuItems }
            in
            ( { model | groups = res, inpGroups = inpGroups2 }, E.none )

        GotOrganismGroups (Err e) ->
            ( model, Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження зв'язків організм-група" e )

        GotOrganismGroups (Ok res) ->
            ( { model | organismGroups = res }, E.none )

        EditOrganismSave ->
            case model.editOrganism of
                Just ( id, editOrganism ) ->
                    case Validate.validate validator editOrganism of
                        Ok _ ->
                            let
                                editOrganism2 =
                                    { editOrganism | fieldsErrors = [] }

                                originalSet =
                                    getOrganismGroups id model.organismGroups
                                        |> Set.fromList

                                selectedParentId =
                                    editOrganism.inpParentOrganism.selectedItem

                                -- Groups that should be available considering parent constraints
                                availableGroups =
                                    case selectedParentId of
                                        Nothing ->
                                            editOrganism.inpGroups.selectedItems

                                        Just pId ->
                                            let
                                                parentOrganism =
                                                    model.organisms |> ListX.find (\o -> o.id == pId)

                                                parentGroups =
                                                    case parentOrganism of
                                                        Nothing ->
                                                            []

                                                        Just p ->
                                                            getOrganismGroups p.id model.organismGroups

                                                -- If parent has empty groups list, it means access to all groups
                                                -- Only filter if parent has specific groups defined
                                            in
                                            if List.isEmpty parentGroups then
                                                editOrganism.inpGroups.selectedItems

                                            else
                                                let
                                                    parentGroupsSet =
                                                        Set.fromList parentGroups

                                                    selectedGroupsSet =
                                                        Set.fromList editOrganism.inpGroups.selectedItems
                                                in
                                                Set.toList (Set.intersect selectedGroupsSet parentGroupsSet)

                                editedSet =
                                    Set.fromList availableGroups

                                added =
                                    Set.toList (Set.diff editedSet originalSet)

                                removed =
                                    Set.toList (Set.diff originalSet editedSet)
                            in
                            ( { model | editOrganism = Just ( id, editOrganism2 ) }
                            , E.sendCmd <|
                                Cmd.batch
                                    (Api.update_organism EditOrganismDone
                                        { name = Just editOrganism.inpName
                                        , parentId = editOrganism.inpParentOrganism.selectedItem
                                        , roles = Le.Utils.emptyToNothing editOrganism.inpRole.selectedItems
                                        , groupAutoLink = Just editOrganism.autoAddGroups
                                        , id = id
                                        , enabled = editOrganism.enabled
                                        }
                                        :: (if List.length added > 0 then
                                                List.map (\x -> Api.add_group_to_organism (AddGroupToOrganismDone id x True) { organismId = id, groupName = x }) added

                                            else
                                                []
                                           )
                                        ++ (if List.length removed > 0 then
                                                List.map (\x -> Api.remove_group_from_organism (RemoveGroupFromOrganismDone id x) { organismId = id, groupName = x }) removed

                                            else
                                                []
                                           )
                                    )
                            )

                        Err errors ->
                            let
                                editOrganism2 =
                                    { editOrganism | fieldsErrors = errors }
                            in
                            ( { model | editOrganism = Just ( id, editOrganism2 ) }, E.none )

                Nothing ->
                    ( model, E.none )

        EditOrganismCancel ->
            ( { model | editOrganism = Nothing }, E.none )

        CloseEditSidebar ->
            ( { model | editOrganism = Nothing }, E.none )

        EditOrganismDone (Ok o) ->
            ( { model | editOrganism = Nothing, organisms = model.organisms |> ListX.updateIf (\x -> x.id == o.id) (\y -> { y | name = o.name, parentId = o.parentId, roles = o.roles, groupAutoLink = o.groupAutoLink, enabled = o.enabled }) }, E.none )

        EditOrganismDone (Err e) ->
            ( model, Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення організму" e )


validator : Validate.Validator ( FormField, String ) { a | inpName : String }
validator =
    Validate.all
        [ Validate.ifBlank .inpName ( Name, "Ім'я не може бути пустим" )
        ]


validateGroupsForParent : List B.OrganismGroup -> List B.SignalGroupFull -> List String -> Maybe Int -> List String
validateGroupsForParent organismGroups allGroups selectedGroups parentId =
    case parentId of
        Nothing ->
            []

        Just pId ->
            let
                parentGroups =
                    getParentGroups pId organismGroups

                -- If parent has empty groups list, it means access to all groups
                -- Only validate if parent has specific groups defined
                unavailableGroupNames =
                    if List.isEmpty parentGroups then
                        []

                    else
                        let
                            parentGroupsSet =
                                Set.fromList parentGroups

                            selectedGroupsSet =
                                Set.fromList selectedGroups

                            unavailableGroupIds =
                                Set.diff selectedGroupsSet parentGroupsSet
                        in
                        unavailableGroupIds
                            |> Set.toList
                            |> List.filterMap
                                (\groupId ->
                                    allGroups
                                        |> ListX.find (\g -> g.masterKey == groupId)
                                        |> Maybe.map
                                            (\g ->
                                                if String.isEmpty g.name then
                                                    "Без назви (id=" ++ String.left 6 g.masterKey ++ "...)"

                                                else
                                                    g.name
                                            )
                                )
            in
            unavailableGroupNames


viewFormErrors : FormField -> List FieldError -> Html msg
viewFormErrors field errors =
    errors
        |> List.filter (\( fieldError, _ ) -> fieldError == field)
        |> List.map (\( _, error ) -> p [] [ text error ])
        |> div [ style "color" "red", style "font-size" "14px" ]


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none



-- TABLE CONFIGURATION


organismsTableConfig : List B.SignalGroupFull -> List B.OrganismGroup -> List B.Organism -> Maybe Time.Zone -> Maybe Int -> Table.Config B.Organism Msg
organismsTableConfig groups organismGroups allOrganisms timeZone editingOrganismId =
    let
        defaultCustomizations =
            Table.defaultCustomizations

        customTheadHelp : ( String, TableConfig.Status, Html.Attribute Msg ) -> Html Msg
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
                                [ text " ↓" ]

                        TableConfig.Reversible Nothing ->
                            span [ style "color" "var(--color-text-muted)" ] [ text " ↕" ]

                        TableConfig.Reversible (Just isReversed) ->
                            span [ style "color" "var(--ochre-normal)" ]
                                [ text
                                    (if isReversed then
                                        " ↑"

                                     else
                                        " ↓"
                                    )
                                ]

                headerContent =
                    div [ class "table-header-content", title name ]
                        [ span [] [ text name ]
                        , sortIcon
                        ]
            in
            Html.th [ click ] [ headerContent ]

        customThead : List ( String, TableConfig.Status, Html.Attribute Msg ) -> TableColumn.HtmlDetails Msg
        customThead headers =
            TableColumn.HtmlDetails [] (List.map customTheadHelp headers)

        customRowAttrs : B.Organism -> List (Html.Attribute Msg)
        customRowAttrs organism =
            case editingOrganismId of
                Just editId ->
                    if organism.id == editId then
                        [ class "table-row-editing" ]

                    else
                        []

                Nothing ->
                    []

        customizations =
            { defaultCustomizations
                | tableAttrs = [ class "base-table" ]
                , thead = customThead
                , rowAttrs = customRowAttrs
            }
    in
    Table.customConfig
        { toId = \o -> String.fromInt o.id
        , toMsg = SetTableState
        , columns =
            [ Table.stringColumn "Назва" .name |> Table.withColumnWidth "14%"
            , Table.customColumn
                { name = "Батьківський"
                , viewData =
                    \o ->
                        o.parentId
                            |> Maybe.andThen (\parentId -> ListX.find (\x -> x.id == parentId) allOrganisms)
                            |> Maybe.map .name
                            |> Maybe.withDefault ""
                , sorter =
                    Table.increasingOrDecreasingBy
                        (\o ->
                            o.parentId
                                |> Maybe.andThen (\parentId -> ListX.find (\x -> x.id == parentId) allOrganisms)
                                |> Maybe.map .name
                                |> Maybe.withDefault ""
                        )
                }
                |> Table.withColumnWidth "14%"
            , Table.veryCustomColumn
                { name = "Групи"
                , viewData =
                    \o ->
                        { attributes = [ class "col-wide" ]
                        , children =
                            [ div [ class "flex flex-wrap gap-1" ]
                                (getOrganismGroups o.id organismGroups
                                    |> List.filterMap (\groupId -> ListX.find (\x -> x.masterKey == groupId) groups)
                                    |> List.sortBy (\group -> String.toLower (groupName group))
                                    |> List.map
                                        (\group ->
                                            span
                                                [ class "badge badge--ochre-light"
                                                , title (groupName group)
                                                ]
                                                [ text (groupName group) ]
                                        )
                                )
                            ]
                        }
                , sorter =
                    Table.increasingOrDecreasingBy
                        (\o ->
                            getOrganismGroups o.id organismGroups
                                |> List.filterMap (\groupId -> ListX.find (\x -> x.masterKey == groupId) groups)
                                |> List.map groupName
                                |> String.join ", "
                        )
                }
                |> Table.withColumnWidth "25%"
            , Table.veryCustomColumn
                { name = "Ролі"
                , viewData =
                    \o ->
                        { attributes = []
                        , children =
                            [ div [ class "flex flex-wrap gap-1" ]
                                (o.roles
                                    |> List.map
                                        (\role ->
                                            span
                                                [ class "badge badge--neutral"
                                                , title role
                                                ]
                                                [ text role ]
                                        )
                                )
                            ]
                        }
                , sorter = Table.increasingOrDecreasingBy (\o -> String.join ", " o.roles)
                }
                |> Table.withColumnWidth "14%"
            , Table.veryCustomColumn
                { name = "Автододавання груп"
                , viewData =
                    \o ->
                        { attributes = [ class "col-narrow" ]
                        , children =
                            [ i
                                [ class
                                    (if o.groupAutoLink then
                                        "bi bi-check-circle-fill text-green-500"

                                     else
                                        "bi bi-x-circle-fill text-red-500"
                                    )
                                ]
                                []
                            ]
                        }
                , sorter =
                    Table.increasingOrDecreasingBy
                        (\o ->
                            if o.groupAutoLink then
                                "1"

                            else
                                "0"
                        )
                }
                |> Table.withColumnWidth "10%"
            , Table.veryCustomColumn
                { name = "Активна"
                , viewData =
                    \o ->
                        { attributes = [ class "col-narrow" ]
                        , children =
                            [ i
                                [ class
                                    (if o.enabled then
                                        "bi bi-check-circle-fill text-green-500"

                                     else
                                        "bi bi-x-circle-fill text-red-500"
                                    )
                                ]
                                []
                            ]
                        }
                , sorter =
                    Table.increasingOrDecreasingBy
                        (\o ->
                            if o.enabled then
                                "1"

                            else
                                "0"
                        )
                }
                |> Table.withColumnWidth "6%"
            , Table.veryCustomColumn
                { name = "Створено"
                , viewData =
                    \o ->
                        { attributes = [ class "col-narrow" ]
                        , children = [ text (Le.Time.renderDateF5FromMillis o.createdAt timeZone) ]
                        }
                , sorter = Table.increasingOrDecreasingBy (\o -> String.fromInt o.createdAt)
                }
                |> Table.withColumnWidth "10%"
            , Table.veryCustomColumn
                { name = ""
                , viewData =
                    \o ->
                        { attributes = [ class "col-narrow" ]
                        , children =
                            [ button
                                [ class "table-action-btn"
                                , type_ "button"
                                , onClick <| EditOrganism o.id
                                ]
                                [ i [ class "bi bi-pencil-square" ] []
                                ]
                            ]
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "5%"
            ]
        , customizations = customizations
        }


editOrganismSidebarContent : Bool -> Model -> Int -> OrganismEdit -> List (Html Msg)
editOrganismSidebarContent isDark model organismId editState =
    let
        organism =
            model.organisms |> ListX.find (\o -> o.id == organismId)

        -- Отримуємо ID вибраного батьківського організму для редагування
        selectedParentId =
            editState.inpParentOrganism.selectedItem

        -- Визначаємо доступні групи з урахуванням батька для редагування
        availableGroups =
            getAvailableGroupsForOrganism selectedParentId model.organismGroups model.groups

        groupsSelectedItems =
            editState.inpGroups.selectedItems
                |> List.filterMap (\x -> ListX.find (\y -> y.masterKey == x) availableGroups)
                |> List.map (\x -> Select.basicMenuItem { item = x.masterKey, label = x.name })
    in
    [ div [ class "flex flex-col h-full" ]
        [ div [ class "p-6 border-b border-border" ]
            [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Редагувати організм" ]
            , case organism of
                Just o ->
                    p [ class "text-sm text-muted-foreground" ] [ text ("ID: " ++ String.fromInt o.id) ]

                Nothing ->
                    text ""
            ]
        , div [ class "flex-1 overflow-y-auto p-6" ]
            [ div [ class "space-y-6" ]
                [ div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Назва" ]
                    , input
                        [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                        , type_ "text"
                        , placeholder "Назва організму"
                        , value editState.inpName
                        , onInput SetEditName
                        ]
                        []
                    , viewFormErrors Name editState.fieldsErrors
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Батьківський організм" ]
                    , div [ class "w-full" ]
                        [ Html.map EditParentSelMsg <|
                            Styled.toUnstyled <|
                                Le.Block.Select.renderSelectSingle
                                    (case editState.inpParentOrganism.selectedItem of
                                        Just id ->
                                            ListX.find (\o -> o.id == id) model.organisms
                                                |> Maybe.map (\o -> Select.basicMenuItem { item = id, label = o.name })

                                        Nothing ->
                                            Nothing
                                    )
                                    editState.inpParentOrganism.selectState
                                    editState.inpParentOrganism.items
                                    "батьківський організм"
                                    (Le.Block.Select.defaultOptions isDark)
                        ]
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Групи" ]
                    , div [ class "w-full" ]
                        [ Html.map EditGroupSelMsg <|
                            Styled.toUnstyled <|
                                Le.Block.Select.renderSelect
                                    groupsSelectedItems
                                    editState.inpGroups.selectState
                                    (availableGroups |> List.map (\x -> Select.basicMenuItem { item = x.masterKey, label = x.name }))
                                    "групи"
                                    (Le.Block.Select.defaultOptions isDark)
                        ]
                    , case editState.groupsValidation of
                        Just groups ->
                            div [ class "mt-2 p-3 rounded-md bg-yellow-50 border border-yellow-200 dark:bg-yellow-900/20 dark:border-yellow-800" ]
                                [ p [ class "text-sm text-yellow-800 dark:text-yellow-200" ]
                                    [ text "⚠️ Попередження: при виборі цього батьківського організму буде втрачено доступ до груп: "
                                    , strong [] [ text (String.join ", " groups) ]
                                    ]
                                ]

                        Nothing ->
                            text ""
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Ролі" ]
                    , div [ class "w-full" ]
                        [ Html.map EditRoleSelMsg <|
                            Styled.toUnstyled <|
                                Le.Block.Select.renderSelect
                                    (editState.inpRole.selectedItems |> List.map (\x -> Select.basicMenuItem { item = x, label = x }))
                                    editState.inpRole.selectState
                                    editState.inpRole.items
                                    "роль"
                                    (Le.Block.Select.defaultOptions isDark)
                        ]
                    ]
                , div [ class "grid grid-cols-2 gap-4" ]
                    [ div [ class "flex items-center" ]
                        [ Checkbox.new { isChecked = editState.autoAddGroups, onToggle = \_ -> ToggleEditAutoAddGroups }
                            |> Checkbox.withContent [ text "Автододавання груп" ]
                            |> Checkbox.view
                        ]
                    , div [ class "flex items-center" ]
                        [ Checkbox.new { isChecked = editState.enabled, onToggle = \_ -> ToggleEditEnabled }
                            |> Checkbox.withContent [ text "Активна" ]
                            |> Checkbox.view
                        ]
                    ]
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseEditSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , Button.new
                    { label =
                        case editState.groupsValidation of
                            Just groups ->
                                "Зберегти (втратити " ++ String.fromInt (List.length groups) ++ " груп)"

                            Nothing ->
                                "Зберегти"
                    , onClick = EditOrganismSave
                    }
                    |> Button.view
                ]
            ]
        ]
    ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "Адмін: організми"
    , body = body dark shared user model
    }


body : Bool -> Shared.Model -> B.User -> Model -> List (Html Msg)
body dark shared user model =
    let
        sidebarOpen =
            case model.editOrganism of
                Just _ ->
                    True

                Nothing ->
                    False

        sidebarContent =
            case model.editOrganism of
                Just ( organismId, editState ) ->
                    editOrganismSidebarContent (isDarkMode shared.themeMode) model organismId editState

                Nothing ->
                    []
    in
    [ div
        [ classList [ ( "overflow-hidden", sidebarOpen ) ]
        , class "w-5/6 mx-auto"
        ]
        [ Sidebar.view sidebarOpen CloseEditSidebar sidebarContent
        , div [] (mainBlock dark model)
        ]
    ]


mainBlock : Bool -> Model -> List (Html Msg)
mainBlock isDark model =
    let
        addOrganismPanel : Model -> Html Msg
        addOrganismPanel m =
            let
                -- Отримуємо ID вибраного батьківського організму
                selectedParentId =
                    m.inpParentOrganism.selectedItem

                -- Визначаємо доступні групи з урахуванням батька
                availableGroups =
                    getAvailableGroupsForOrganism selectedParentId m.organismGroups m.groups

                groupsSelectedItems =
                    m.inpGroups.selectedItems
                        |> List.filterMap (\x -> ListX.find (\y -> y.masterKey == x) availableGroups)
                        |> List.map (\x -> Select.basicMenuItem { item = x.masterKey, label = x.name })
            in
            div
                [ class "flex items-center gap-4"
                ]
                [ div [ class "flex-1" ]
                    [ input
                        [ class "form-input w-full"
                        , type_ "text"
                        , placeholder "Назва"
                        , value m.inpName
                        , onInput <| SetName
                        ]
                        []
                    , viewFormErrors Name m.fieldsErrors
                    ]
                , div [ class "flex-1" ]
                    [ div
                        [ class "flex justify-between items-center text-sm"
                        ]
                        [ div [ class "flex-grow w-full" ]
                            [ Html.map AddParentSelMsg <|
                                Styled.toUnstyled <|
                                    Le.Block.Select.renderSelectSingle
                                        (case m.inpParentOrganism.selectedItem of
                                            Just id ->
                                                ListX.find (\o -> o.id == id) model.organisms
                                                    |> Maybe.map (\o -> Select.basicMenuItem { item = id, label = o.name })

                                            Nothing ->
                                                Nothing
                                        )
                                        m.inpParentOrganism.selectState
                                        m.inpParentOrganism.items
                                        "батьківський організм"
                                        (Le.Block.Select.defaultOptions isDark)
                            ]
                        ]
                    ]
                , div [ class "flex-1 relative" ]
                    [ div
                        [ class "flex justify-between items-center text-sm"
                        ]
                        [ div [ class "flex-grow w-full" ]
                            [ Html.map AddGroupSelMsg <|
                                Styled.toUnstyled <|
                                    Le.Block.Select.renderSelect
                                        groupsSelectedItems
                                        m.inpGroups.selectState
                                        (availableGroups |> List.map (\x -> Select.basicMenuItem { item = x.masterKey, label = x.name }))
                                        "групи"
                                        (Le.Block.Select.defaultOptions isDark)
                            ]
                        ]
                    , viewFormErrors Roles m.fieldsErrors
                    , case m.groupsValidation of
                        Just groups ->
                            div [ class "absolute bottom-full -left-1/2 -right-1/2 z-40 mt-16 p-3 rounded-md bg-yellow-50 border border-yellow-200 dark:bg-yellow-900/20 dark:border-yellow-800 text-xs shadow-lg" ]
                                [ text "⚠️ Попередження: при виборі цього батьківського організму буде втрачено доступ до груп: "
                                , strong [] [ text (String.join ", " groups) ]
                                ]

                        Nothing ->
                            text ""
                    ]
                , div [ class "flex-1" ]
                    [ div
                        [ class "flex justify-between items-center text-sm"
                        ]
                        [ div [ class "flex-grow w-full" ]
                            [ Html.map AddRoleSelMsg <|
                                Styled.toUnstyled <|
                                    Le.Block.Select.renderSelect
                                        (m.inpRole.selectedItems |> List.map (\x -> Select.basicMenuItem { item = x, label = x }))
                                        m.inpRole.selectState
                                        m.inpRole.items
                                        "роль"
                                        (Le.Block.Select.defaultOptions isDark)
                            ]
                        ]
                    ]
                , div [ class "flex items-center justify-center flex-1" ]
                    [ Checkbox.new { isChecked = m.autoAddGroups, onToggle = \_ -> ToggleAutoAddGroups }
                        |> Checkbox.withContent [ text "Автододавання груп" ]
                        |> Checkbox.view
                    ]
                , div [ class "flex justify-center" ]
                    [ Button.new { label = "Додати", onClick = AddOrganism }
                        |> Button.view
                    ]
                ]
    in
    [ div []
        [ h1 [ class "py-4 text-2xl font-bold text-foreground" ] [ text "Організми" ]
        , div
            [ class "border border-border rounded-lg mb-4 p-4 bg-[var(--bs-tertiary-bg)]"
            ]
            [ addOrganismPanel
                model
            ]
        , div [ class "table-responsive-modern" ]
            [ Table.view
                (organismsTableConfig model.groups model.organismGroups model.organisms model.timeZone (Maybe.map Tuple.first model.editOrganism))
                model.tableState
                model.organisms
            ]
        ]
    ]
