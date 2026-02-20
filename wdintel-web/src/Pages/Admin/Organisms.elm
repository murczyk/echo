module Pages.Admin.Organisms exposing (FieldError, FormField, Model, Msg, OrganismEdit, page)

import Api
import Auth
import Bindings as B
import Core.Types exposing (..)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Styled as Styled
import Layouts
import List.Extra as ListX
import Maybe
import Page exposing (Page)
import Route exposing (Route)
import Select
import Set exposing (Set)
import Shared
import Shared.Components.Button as Button
import Shared.Components.Checkbox as Checkbox
import Shared.Components.FloatingPopup as FloatingPopup
import Shared.Components.ModalDialog as ModalDialog
import Shared.Components.Sidebar as Sidebar
import Shared.Components.Spinner as Spinner
import Shared.Components.Table as Table
import Shared.Components.Table.Column as TableColumn
import Shared.Components.Table.Config as TableConfig
import Shared.Model exposing (isDarkMode)
import Time
import Utils.Api.ErrorHandling
import Utils.Components exposing (..)
import Utils.RemoteData as RD
import Utils.Select
import Utils.Time
import Utils.Utils exposing (..)
import Validate
import View exposing (View)


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared _ =
    Page.new
        { init = init
        , update = update
        , view = view (isDarkMode shared.themeMode) shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "organisms"
        }


groupName : B.SignalGroupFull -> String
groupName group =
    if group.name == "" then
        "Без назви (id=" ++ String.left 6 group.masterKey ++ "..." ++ ")"

    else
        group.name


filterOrganismsByName : String -> List B.Organism -> List B.Organism
filterOrganismsByName filter organisms =
    if String.isEmpty filter then
        organisms

    else
        let
            filterLower =
                String.toLower filter
        in
        organisms
            |> List.filter (\organism -> String.contains filterLower (String.toLower organism.name))


getOrganismGroups : Int -> List B.OrganismGroup -> List String
getOrganismGroups organismId organismGroups =
    organismGroups
        |> List.filter (\og -> og.organismId == organismId)
        |> List.map .masterKey


getParentGroups : Int -> List B.OrganismGroup -> List String
getParentGroups parentId organismGroups =
    getOrganismGroups parentId organismGroups


hasGroupRestrictions : Int -> List B.OrganismGroup -> Bool
hasGroupRestrictions organismId organismGroups =
    not (List.isEmpty (getOrganismGroups organismId organismGroups))


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


loadComputedGroups : Int -> Model -> ( Model, Effect Msg )
loadComputedGroups organismId model =
    if Set.member organismId model.loadingComputedGroups then
        -- Вже завантажуємо, не робимо повторний запит
        ( model, E.none )

    else
        let
            newModel =
                { model | loadingComputedGroups = Set.insert organismId model.loadingComputedGroups }
        in
        ( newModel, E.sendCmd <| Api.organism_available_groups (GotAvailableGroups organismId) organismId )


getComputedGroups : Int -> Model -> List B.SignalGroupFull
getComputedGroups organismId model =
    Dict.get organismId model.computedGroups
        |> Maybe.withDefault []


isLoadingComputedGroups : Int -> Model -> Bool
isLoadingComputedGroups organismId model =
    Set.member organismId model.loadingComputedGroups


buildUpdateOrganismReq : Int -> OrganismEdit -> B.UpdateOrganismReq
buildUpdateOrganismReq organismId editOrganism =
    { id = organismId
    , parentId = editOrganism.inpParentOrganism.selectedItem
    , name = Just editOrganism.inpName
    , roles = Just editOrganism.inpRole.selectedItems
    , enabled = editOrganism.enabled
    , aorIds = Just editOrganism.inpAors.selectedItems
    }


buildCreateOrganismReq : Model -> B.CreateOrganismReq
buildCreateOrganismReq model =
    { name = model.inpName
    , parentId = model.inpParentOrganism.selectedItem
    , roles = model.inpRole.selectedItems
    , aorIds = Just model.inpAors.selectedItems
    }


loadComputedGroupsForAll : Model -> ( Model, Effect Msg )
loadComputedGroupsForAll model =
    let
        organismIds =
            model.organisms |> List.map .id

        newModel =
            { model | loadingComputedGroups = Set.fromList organismIds }
    in
    if List.isEmpty organismIds then
        ( model, E.none )

    else
        ( newModel, E.sendCmd <| Api.organism_available_groups_batch GotAvailableGroupsBatch organismIds )


type SidebarType
    = CreateSidebar
    | EditSidebar


type ShowAllPopupFor
    = ShowAllGroups
    | ShowAllComputedGroups
    | ShowAllRoles
    | ShowAllAors


type alias Model =
    { formErrors : Dict String String
    , organisms : List B.Organism
    , tableState : Table.State
    , nameFilter : String
    , inpName : String
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
    , inpAors :
        { selectState : Select.State
        , items : List (Select.MenuItem Int)
        , selectedItems : List Int
        }
    , fieldsErrors : List FieldError
    , groups : List B.SignalGroupFull
    , organismGroups : List B.OrganismGroup
    , editOrganism : Maybe ( Int, OrganismEdit )
    , groupsValidation : Maybe (List String)
    , aorList : RD.RemoteData ApiError (List B.AreaOfResponsibility)
    , sidebarType : Maybe SidebarType
    , computedGroups : Dict Int (List B.SignalGroupFull)
    , loadingComputedGroups : Set Int
    , rowShowAllPopupStatus : Maybe ( Int, ShowAllPopupFor )
    , createComputedAvailableGroups : Maybe (List B.SignalGroupFull)
    , createLimitGroupsList : Bool
    , createIsLoadingComputedGroups : Bool
    , deleteModal : Maybe DeleteModalState
    }


type alias OrganismEdit =
    { inpName : String
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
    , inpAors :
        { selectState : Select.State
        , items : List (Select.MenuItem Int)
        , selectedItems : List Int
        }
    , fieldsErrors : List FieldError
    , groupsValidation : Maybe (List String)
    , computedAvailableGroups : Maybe (List B.SignalGroupFull)
    , limitGroupsList : Bool
    , isLoadingComputedGroups : Bool
    }


type alias DeleteModalState =
    { organism : B.Organism
    , isSubmitting : Bool
    , isLoadingLogins : Bool
    , activeLogins : Maybe (List String)
    }


type DeleteAction
    = DeleteSoft
    | DeletePermanent


roles : List String
roles =
    [ "Admin", "Rer", "Bpla", "Full", "Basic", "UnitsEditor", "CallsignsEditor" ]


type FormField
    = Name


type alias FieldError =
    ( FormField, String )


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , organisms = []
      , nameFilter = ""
      , inpName = ""
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
      , inpAors =
            { selectState = Select.initState (Select.selectIdentifier "sel-aor-add")
            , items = []
            , selectedItems = []
            }
      , fieldsErrors = []
      , groups = []
      , organismGroups = []
      , editOrganism = Nothing
      , groupsValidation = Nothing
      , aorList = RD.NotAsked
      , tableState = Table.initialSort "Назва"
      , sidebarType = Nothing
      , computedGroups = Dict.empty
      , loadingComputedGroups = Set.empty
      , rowShowAllPopupStatus = Nothing
      , createComputedAvailableGroups = Nothing
      , createLimitGroupsList = False
      , createIsLoadingComputedGroups = False
      , deleteModal = Nothing
      }
    , E.sendCmd <|
        Cmd.batch
            [ Api.list_organisms GotOrganisms { sortBy = Nothing }
            , Api.organism_all_groups GotAllGroups
            , Api.organism_group_list GotOrganismGroups
            , Api.aor_list GotAorList { sortBy = Nothing }
            ]
    )


type Msg
    = SetTableState Table.State
    | SetNameFilter String
    | GotOrganisms (Result ApiError (List B.Organism))
    | AddRoleSelMsg (Select.Msg String)
    | EditRoleSelMsg (Select.Msg String)
    | AddGroupSelMsg (Select.Msg String)
    | EditGroupSelMsg (Select.Msg String)
    | AddParentSelMsg (Select.Msg Int)
    | EditParentSelMsg (Select.Msg Int)
    | AddAorSelMsg (Select.Msg Int)
    | EditAorSelMsg (Select.Msg Int)
    | AddOrganism
    | AddOrganismDone (Result ApiError B.Organism)
    | ToggleEditEnabled
    | ToggleLimitGroupsList
    | ToggleLimitGroupsListCreate
    | EditOrganism Int
    | CloseEditSidebar
    | OpenCreateSidebar
    | CloseCreateSidebar
    | SetName String
    | SetEditName String
    | GotAllGroups (Result ApiError (List B.SignalGroupFull))
    | GotOrganismGroups (Result ApiError (List B.OrganismGroup))
    | GotAorList (Result ApiError (List B.AreaOfResponsibility))
    | GotAvailableGroups Int (Result ApiError (List B.SignalGroupFull))
    | GotAvailableGroupsBatch (Result ApiError (Dict Int (List B.SignalGroupFull)))
    | GotComputedAvailableGroups (Result ApiError (List B.SignalGroupFull))
    | GotComputedAvailableGroupsCreate (Result ApiError (List B.SignalGroupFull))
    | RowShowAllPopupChanged (Maybe ( Int, ShowAllPopupFor ))
    | AddGroupToOrganismDone Int String Bool (Result ApiError ())
    | RemoveGroupFromOrganismDone Int String (Result ApiError ())
    | EditOrganismSave
    | EditOrganismCancel
    | EditOrganismDone (Result ApiError B.Organism)
    | OpenDeleteModal Int
    | CloseDeleteModal
    | PerformDelete DeleteAction
    | DeleteOrganismSoftDone (Result ApiError B.Organism)
    | DeleteOrganismHardDone Int (Result ApiError ())
    | GotActiveLogins Int (Result ApiError (List String))


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        SetTableState newTableState ->
            ( { model | tableState = newTableState }, E.none )

        SetNameFilter filter ->
            ( { model | nameFilter = filter }, E.none )

        GotOrganisms (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження організмів" e )

        GotOrganisms (Ok res) ->
            let
                organismsMenuItems =
                    res |> List.map (\x -> Select.basicMenuItem { item = x.id, label = x.name })

                inpParentOrganism =
                    model.inpParentOrganism

                inpParentOrganism2 =
                    { inpParentOrganism | items = organismsMenuItems }

                newModel =
                    { model | organisms = res, inpParentOrganism = inpParentOrganism2 }
            in
            loadComputedGroupsForAll newModel

        AddRoleSelMsg selMsg ->
            let
                ( mAction, iState, iCmd ) =
                    Select.update selMsg model.inpRole.selectState

                inpRole =
                    model.inpRole

                inpRole2 =
                    { inpRole | selectedItems = Utils.Select.multiUpdS mAction inpRole.selectedItems, selectState = iState }
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
                            { inpRole | selectedItems = Utils.Select.multiUpdS mAction inpRole.selectedItems, selectState = iState }

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
                    { inpGroups | selectedItems = Utils.Select.multiUpdS mAction inpGroups.selectedItems, selectState = iState }

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
                            { inpGroups | selectedItems = Utils.Select.multiUpdS mAction inpGroups.selectedItems, selectState = iState }

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
                    { inpParentOrganism | selectedItem = Utils.Select.singleUpd mAction inpParentOrganism.selectedItem, selectState = iState }

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

                -- Check if we need to reload computed groups (only on meaningful actions)
                shouldReloadComputedGroups =
                    case mAction of
                        Just (Select.Select _) ->
                            True

                        Just (Select.Deselect _) ->
                            True

                        Just Select.Clear ->
                            True

                        _ ->
                            False

                modelWithUpdatedParent =
                    { model | inpParentOrganism = inpParentOrganism2, groupsValidation = groupsValidation }

                modelFinal =
                    if shouldReloadComputedGroups then
                        { modelWithUpdatedParent
                            | createIsLoadingComputedGroups = True
                            , createComputedAvailableGroups = Nothing
                        }

                    else
                        modelWithUpdatedParent

                effects =
                    if shouldReloadComputedGroups then
                        let
                            createReq =
                                buildCreateOrganismReq modelFinal
                        in
                        [ E.sendCmd <| Cmd.map AddParentSelMsg iCmd
                        , E.sendCmd <| Api.organism_compute_available_groups_for_new GotComputedAvailableGroupsCreate createReq
                        ]

                    else
                        [ E.sendCmd <| Cmd.map AddParentSelMsg iCmd ]
            in
            ( modelFinal, E.batch effects )

        EditParentSelMsg selMsg ->
            case model.editOrganism of
                Just ( id, editOrganism ) ->
                    let
                        ( mAction, iState, iCmd ) =
                            Select.update selMsg editOrganism.inpParentOrganism.selectState

                        inpParentOrganism =
                            editOrganism.inpParentOrganism

                        inpParentOrganism2 =
                            { inpParentOrganism | selectedItem = Utils.Select.singleUpd mAction inpParentOrganism.selectedItem, selectState = iState }

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

                        -- Check if we need to reload computed groups (only on meaningful actions)
                        shouldReloadComputedGroups =
                            case mAction of
                                Just (Select.Select _) ->
                                    True

                                Just (Select.Deselect _) ->
                                    True

                                Just Select.Clear ->
                                    True

                                _ ->
                                    False

                        editOrganism2 =
                            { editOrganism | inpParentOrganism = inpParentOrganism2, groupsValidation = groupsValidation }

                        editOrganismFinal =
                            if shouldReloadComputedGroups then
                                { editOrganism2
                                    | isLoadingComputedGroups = True
                                    , computedAvailableGroups = Nothing
                                }

                            else
                                editOrganism2

                        effects =
                            if shouldReloadComputedGroups then
                                let
                                    updateReq =
                                        buildUpdateOrganismReq id editOrganismFinal
                                in
                                [ E.sendCmd <| Cmd.map EditParentSelMsg iCmd
                                , E.sendCmd <| Api.organism_compute_available_groups GotComputedAvailableGroups updateReq
                                ]

                            else
                                [ E.sendCmd <| Cmd.map EditParentSelMsg iCmd ]
                    in
                    ( { model | editOrganism = Just ( id, editOrganismFinal ) }
                    , E.batch effects
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
                            , roles = model.inpRole.selectedItems
                            , aorIds = emptyToNothing model.inpAors.selectedItems
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

                inpAors =
                    model.inpAors

                inpAors2 =
                    { inpAors | selectedItems = [] }

                inpGroups =
                    model.inpGroups

                inpGroups2 =
                    { inpGroups | selectedItems = [] }

                m2 =
                    { model
                        | inpName = ""
                        , inpRole = inpRole2
                        , inpParentOrganism = inpParentOrganism2
                        , inpAors = inpAors2
                        , inpGroups = inpGroups2
                        , organisms = organism :: model.organisms
                        , fieldsErrors = []
                        , groupsValidation = Nothing
                        , sidebarType = Nothing
                        , createComputedAvailableGroups = Nothing
                        , createLimitGroupsList = False
                        , createIsLoadingComputedGroups = False
                    }
            in
            let
                {- NEW LOGIC: Groups to save based on createLimitGroupsList checkbox

                   Previous behavior: Always saved selected groups as restrictions with parent filtering

                   New behavior:
                   - createLimitGroupsList = False: No organism-group restrictions (empty list)
                     → Organism gets ALL groups from bands automatically
                   - createLimitGroupsList = True: Save selected groups as restrictions
                     → Organism limited to only these specific groups
                -}
                groupsToAdd =
                    if model.createLimitGroupsList then
                        -- User wants to limit groups - use selected groups from selector
                        model.inpGroups.selectedItems

                    else
                        -- User wants NO additional limitations - organism gets all groups from bands
                        -- Save empty list (no organism-group restrictions)
                        []
            in
            ( m2
            , E.sendCmd <|
                Cmd.batch
                    (Api.organism_available_groups (GotAvailableGroups organism.id) organism.id
                        :: List.map
                            (\x ->
                                Api.add_group_to_organism (AddGroupToOrganismDone organism.id x False) { organismId = organism.id, groupName = x }
                            )
                            groupsToAdd
                    )
            )

        AddOrganismDone (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання організму" e )

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
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання групи до організму" e )

        RemoveGroupFromOrganismDone organismId groupId (Ok _) ->
            let
                -- Видаляємо зв'язок організм-група з organismGroups
                organismGroups =
                    model.organismGroups
                        |> List.filter (\og -> not (og.organismId == organismId && og.masterKey == groupId))
            in
            ( { model | organismGroups = organismGroups }, E.none )

        RemoveGroupFromOrganismDone _ _ (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення групи з організму" e )

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

        ToggleLimitGroupsList ->
            case model.editOrganism of
                Just ( id, editOrganism ) ->
                    let
                        editOrganism2 =
                            { editOrganism | limitGroupsList = not editOrganism.limitGroupsList }
                    in
                    ( { model | editOrganism = Just ( id, editOrganism2 ) }, E.none )

                Nothing ->
                    ( model, E.none )

        ToggleLimitGroupsListCreate ->
            ( { model | createLimitGroupsList = not model.createLimitGroupsList }, E.none )

        EditOrganism rowId ->
            let
                organism =
                    model.organisms
                        |> ListX.find (\o -> o.id == rowId)
                        |> Maybe.map
                            (\o ->
                                ( rowId
                                , { inpName = o.name
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
                                  , inpAors =
                                        { selectState = Select.initState (Select.selectIdentifier "sel-aor-edit")
                                        , items =
                                            case RD.toMaybe model.aorList of
                                                Just aors ->
                                                    aors |> List.map (\aor -> Select.basicMenuItem { item = aor.id, label = aor.name })

                                                Nothing ->
                                                    []
                                        , selectedItems = o.aorIds
                                        }
                                  , fieldsErrors = []
                                  , groupsValidation = Nothing
                                  , computedAvailableGroups = Nothing
                                  , limitGroupsList = hasGroupRestrictions o.id model.organismGroups
                                  , isLoadingComputedGroups = True
                                  }
                                )
                            )
            in
            case organism of
                Just ( id, editOrg ) ->
                    let
                        updateReq =
                            buildUpdateOrganismReq id editOrg
                    in
                    ( { model | editOrganism = organism, sidebarType = Just EditSidebar }
                    , E.sendCmd <| Api.organism_compute_available_groups GotComputedAvailableGroups updateReq
                    )

                Nothing ->
                    ( { model | editOrganism = organism, sidebarType = Just EditSidebar }, E.none )

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
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження груп" e )

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
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження зв'язків організм-група" e )

        GotOrganismGroups (Ok res) ->
            ( { model | organismGroups = res }, E.none )

        GotAorList (Ok aors) ->
            let
                aorMenuItems =
                    aors |> List.map (\aor -> Select.basicMenuItem { item = aor.id, label = aor.name })

                inpAors =
                    model.inpAors

                inpAors2 =
                    { inpAors | items = aorMenuItems }
            in
            ( { model | aorList = RD.Success aors, inpAors = inpAors2 }, E.none )

        GotAorList (Err e) ->
            ( { model | aorList = RD.Failure e }, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження смуг відповідальності" e )

        GotAvailableGroups organismId (Ok groups) ->
            ( { model | computedGroups = Dict.insert organismId groups model.computedGroups, loadingComputedGroups = Set.remove organismId model.loadingComputedGroups }, E.none )

        GotAvailableGroups organismId (Err e) ->
            ( { model | loadingComputedGroups = Set.remove organismId model.loadingComputedGroups }, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails ("Помилка завантаження computed груп для організму " ++ String.fromInt organismId) e )

        GotAvailableGroupsBatch (Ok groupsDict) ->
            ( { model | computedGroups = Dict.union groupsDict model.computedGroups, loadingComputedGroups = Set.empty }, E.none )

        GotAvailableGroupsBatch (Err e) ->
            ( { model | loadingComputedGroups = Set.empty }, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження computed груп для всіх організмів" e )

        GotComputedAvailableGroups (Ok groups) ->
            case model.editOrganism of
                Just ( id, editOrganism ) ->
                    let
                        editOrganism2 =
                            { editOrganism
                                | computedAvailableGroups = Just groups
                                , isLoadingComputedGroups = False
                            }
                    in
                    ( { model | editOrganism = Just ( id, editOrganism2 ) }, E.none )

                Nothing ->
                    ( model, E.none )

        GotComputedAvailableGroups (Err e) ->
            case model.editOrganism of
                Just ( id, editOrganism ) ->
                    let
                        editOrganism2 =
                            { editOrganism | isLoadingComputedGroups = False }
                    in
                    ( { model | editOrganism = Just ( id, editOrganism2 ) }
                    , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження computed груп для редагування" e
                    )

                Nothing ->
                    ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження computed груп для редагування" e )

        GotComputedAvailableGroupsCreate (Ok groups) ->
            ( { model
                | createComputedAvailableGroups = Just groups
                , createIsLoadingComputedGroups = False
              }
            , E.none
            )

        GotComputedAvailableGroupsCreate (Err e) ->
            ( { model | createIsLoadingComputedGroups = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження computed груп для створення" e
            )

        RowShowAllPopupChanged popupStatus ->
            ( { model | rowShowAllPopupStatus = popupStatus }
            , E.none
            )

        AddAorSelMsg selMsg ->
            let
                ( mAction, iState, iCmd ) =
                    Select.update selMsg model.inpAors.selectState

                inpAors =
                    model.inpAors

                inpAors2 =
                    { inpAors | selectedItems = Utils.Select.multiUpdI mAction inpAors.selectedItems, selectState = iState }

                -- Check if we need to reload computed groups (only on meaningful actions)
                shouldReloadComputedGroups =
                    case mAction of
                        Just (Select.Select _) ->
                            True

                        Just (Select.Deselect _) ->
                            True

                        Just Select.Clear ->
                            True

                        _ ->
                            False

                modelWithUpdatedAors =
                    { model | inpAors = inpAors2 }

                modelFinal =
                    if shouldReloadComputedGroups then
                        { modelWithUpdatedAors
                            | createIsLoadingComputedGroups = True
                            , createComputedAvailableGroups = Nothing
                        }

                    else
                        modelWithUpdatedAors

                effects =
                    if shouldReloadComputedGroups then
                        let
                            createReq =
                                buildCreateOrganismReq modelFinal
                        in
                        [ E.sendCmd <| Cmd.map AddAorSelMsg iCmd
                        , E.sendCmd <| Api.organism_compute_available_groups_for_new GotComputedAvailableGroupsCreate createReq
                        ]

                    else
                        [ E.sendCmd <| Cmd.map AddAorSelMsg iCmd ]
            in
            ( modelFinal, E.batch effects )

        EditAorSelMsg selMsg ->
            case model.editOrganism of
                Just ( id, editOrganism ) ->
                    let
                        ( mAction, iState, iCmd ) =
                            Select.update selMsg editOrganism.inpAors.selectState

                        inpAors =
                            editOrganism.inpAors

                        inpAors2 =
                            { inpAors | selectedItems = Utils.Select.multiUpdI mAction inpAors.selectedItems, selectState = iState }

                        editOrganism2 =
                            { editOrganism | inpAors = inpAors2 }

                        -- Check if we need to reload computed groups (only on meaningful actions)
                        shouldReloadComputedGroups =
                            case mAction of
                                Just (Select.Select _) ->
                                    True

                                Just (Select.Deselect _) ->
                                    True

                                Just Select.Clear ->
                                    True

                                _ ->
                                    False

                        editOrganismFinal =
                            if shouldReloadComputedGroups then
                                { editOrganism2
                                    | isLoadingComputedGroups = True
                                    , computedAvailableGroups = Nothing
                                }

                            else
                                editOrganism2

                        effects =
                            if shouldReloadComputedGroups then
                                let
                                    updateReq =
                                        buildUpdateOrganismReq id editOrganismFinal
                                in
                                [ E.sendCmd <| Cmd.map EditAorSelMsg iCmd
                                , E.sendCmd <| Api.organism_compute_available_groups GotComputedAvailableGroups updateReq
                                ]

                            else
                                [ E.sendCmd <| Cmd.map EditAorSelMsg iCmd ]
                    in
                    ( { model | editOrganism = Just ( id, editOrganismFinal ) }
                    , E.batch effects
                    )

                Nothing ->
                    ( model, E.none )

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

                                {- NEW LOGIC: Groups to save based on limitGroupsList checkbox

                                   Previous behavior: Always saved selected groups as restrictions

                                   New behavior:
                                   - limitGroupsList = False: No organism-group restrictions (empty list)
                                     → Organism gets ALL groups from bands automatically
                                   - limitGroupsList = True: Save selected groups as restrictions
                                     → Organism limited to only these specific groups
                                -}
                                groupsToSave =
                                    if editOrganism.limitGroupsList then
                                        -- User wants to limit groups - use selected groups from selector
                                        editOrganism.inpGroups.selectedItems

                                    else
                                        -- User wants NO additional limitations - organism gets all groups from bands
                                        -- Save empty list (no organism-group restrictions)
                                        []

                                editedSet =
                                    Set.fromList groupsToSave

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
                                        , roles = Utils.Utils.emptyToNothing editOrganism.inpRole.selectedItems
                                        , id = id
                                        , enabled = editOrganism.enabled
                                        , aorIds = Just editOrganism.inpAors.selectedItems
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
            ( { model | editOrganism = Nothing, sidebarType = Nothing }, E.none )

        CloseEditSidebar ->
            ( { model | editOrganism = Nothing, sidebarType = Nothing }, E.none )

        OpenCreateSidebar ->
            let
                modelWithSidebar =
                    { model
                        | sidebarType = Just CreateSidebar
                        , createIsLoadingComputedGroups = True
                        , createComputedAvailableGroups = Nothing
                    }

                createReq =
                    buildCreateOrganismReq modelWithSidebar
            in
            ( modelWithSidebar
            , E.sendCmd <| Api.organism_compute_available_groups_for_new GotComputedAvailableGroupsCreate createReq
            )

        CloseCreateSidebar ->
            ( { model
                | sidebarType = Nothing
                , createComputedAvailableGroups = Nothing
                , createLimitGroupsList = False
                , createIsLoadingComputedGroups = False
              }
            , E.none
            )

        EditOrganismDone (Ok o) ->
            let
                newModel =
                    { model
                        | editOrganism = Nothing
                        , sidebarType = Nothing
                        , organisms =
                            model.organisms
                                |> ListX.updateIf (\x -> x.id == o.id)
                                    (\y ->
                                        { y
                                            | name = o.name
                                            , parentId = o.parentId
                                            , roles = o.roles
                                            , enabled = o.enabled
                                            , aorIds = o.aorIds
                                            , loginsCount = o.loginsCount
                                        }
                                    )
                    }
            in
            loadComputedGroups o.id newModel

        EditOrganismDone (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення організму" e )

        OpenDeleteModal organismId ->
            case ListX.find (\o -> o.id == organismId) model.organisms of
                Just organism ->
                    let
                        requiresLock =
                            organism.loginsCount > 1

                        modalState =
                            { organism = organism
                            , isSubmitting = False
                            , isLoadingLogins = requiresLock
                            , activeLogins = Nothing
                            }

                        effect =
                            if requiresLock then
                                E.sendCmd <| Api.organism_active_logins (GotActiveLogins organism.id) organism.id

                            else
                                E.none
                    in
                    ( { model | deleteModal = Just modalState }, effect )

                Nothing ->
                    ( model, E.none )

        CloseDeleteModal ->
            ( { model | deleteModal = Nothing }, E.none )

        PerformDelete action ->
            case model.deleteModal of
                Nothing ->
                    ( model, E.none )

                Just modalState ->
                    let
                        hasMultipleActiveUsers =
                            modalState.organism.loginsCount > 1
                    in
                    if hasMultipleActiveUsers then
                        ( model, E.none )

                    else
                        case action of
                            DeleteSoft ->
                                let
                                    req =
                                        { id = modalState.organism.id
                                        , parentId = modalState.organism.parentId
                                        , name = Just modalState.organism.name
                                        , roles = Just modalState.organism.roles
                                        , enabled = False
                                        , aorIds = Just modalState.organism.aorIds
                                        }
                                in
                                ( { model | deleteModal = Just { modalState | isSubmitting = True } }
                                , E.sendCmd <| Api.update_organism DeleteOrganismSoftDone req
                                )

                            DeletePermanent ->
                                ( { model | deleteModal = Just { modalState | isSubmitting = True } }
                                , E.sendCmd <| Api.delete_organism (DeleteOrganismHardDone modalState.organism.id) modalState.organism.id
                                )

        DeleteOrganismSoftDone (Ok updatedOrganism) ->
            let
                updatedOrganisms =
                    model.organisms
                        |> ListX.updateIf (\x -> x.id == updatedOrganism.id) (\_ -> updatedOrganism)

                parentItems =
                    parentMenuItems updatedOrganisms

                currentParentOrganism =
                    model.inpParentOrganism

                inpParentOrganism2 =
                    { currentParentOrganism | items = parentItems }

                editOrganism2 =
                    model.editOrganism
                        |> Maybe.map
                            (\( editId, editState ) ->
                                let
                                    editParentOrganism =
                                        editState.inpParentOrganism
                                in
                                ( editId
                                , { editState
                                    | inpParentOrganism =
                                        { editParentOrganism | items = parentItems }
                                  }
                                )
                            )

                newModel =
                    { model
                        | organisms = updatedOrganisms
                        , inpParentOrganism = inpParentOrganism2
                        , editOrganism = editOrganism2
                        , deleteModal = Nothing
                    }
            in
            loadComputedGroups updatedOrganism.id newModel

        DeleteOrganismSoftDone (Err e) ->
            ( { model | deleteModal = Maybe.map (\state -> { state | isSubmitting = False }) model.deleteModal }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка вимкнення організму" e
            )

        DeleteOrganismHardDone deletedId (Ok _) ->
            let
                updatedOrganisms =
                    model.organisms |> List.filter (\o -> o.id /= deletedId)

                parentItems =
                    parentMenuItems updatedOrganisms

                ( editOrganism2, sidebarType2 ) =
                    case model.editOrganism of
                        Just ( editId, editState ) ->
                            if editId == deletedId then
                                ( Nothing, Nothing )

                            else
                                let
                                    editParentOrganism =
                                        editState.inpParentOrganism
                                in
                                ( Just
                                    ( editId
                                    , { editState
                                        | inpParentOrganism =
                                            { editParentOrganism | items = parentItems }
                                      }
                                    )
                                , model.sidebarType
                                )

                        Nothing ->
                            ( Nothing, model.sidebarType )

                currentParentOrganism =
                    model.inpParentOrganism

                inpParentOrganism2 =
                    { currentParentOrganism | items = parentItems }

                rowPopup2 =
                    model.rowShowAllPopupStatus
                        |> Maybe.andThen
                            (\( orgId, popup ) ->
                                if orgId == deletedId then
                                    Nothing

                                else
                                    Just ( orgId, popup )
                            )
            in
            ( { model
                | organisms = updatedOrganisms
                , deleteModal = Nothing
                , inpParentOrganism = inpParentOrganism2
                , editOrganism = editOrganism2
                , sidebarType = sidebarType2
                , computedGroups = Dict.remove deletedId model.computedGroups
                , loadingComputedGroups = Set.remove deletedId model.loadingComputedGroups
                , organismGroups = model.organismGroups |> List.filter (\og -> og.organismId /= deletedId)
                , rowShowAllPopupStatus = rowPopup2
              }
            , E.none
            )

        DeleteOrganismHardDone _ (Err e) ->
            ( { model | deleteModal = Maybe.map (\state -> { state | isSubmitting = False }) model.deleteModal }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка остаточного видалення організму" e
            )

        GotActiveLogins organismId result ->
            case model.deleteModal of
                Just modalState ->
                    if modalState.organism.id /= organismId then
                        ( model, E.none )

                    else
                        case result of
                            Ok logins ->
                                ( { model
                                    | deleteModal =
                                        Just
                                            { modalState
                                                | isLoadingLogins = False
                                                , activeLogins = Just logins
                                            }
                                  }
                                , E.none
                                )

                            Err e ->
                                ( { model
                                    | deleteModal =
                                        Just
                                            { modalState
                                                | isLoadingLogins = False
                                                , activeLogins = Nothing
                                            }
                                  }
                                , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося завантажити активних користувачів" e
                                )

                Nothing ->
                    ( model, E.none )


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


parentMenuItems : List B.Organism -> List (Select.MenuItem Int)
parentMenuItems organisms =
    organisms |> List.map (\x -> Select.basicMenuItem { item = x.id, label = x.name })


organismDisplayName : B.Organism -> String
organismDisplayName organism =
    if String.isEmpty organism.name then
        "ID " ++ String.fromInt organism.id

    else
        organism.name


viewFormErrors : FormField -> List FieldError -> Html msg
viewFormErrors field errors =
    errors
        |> List.filter (\( fieldError, _ ) -> fieldError == field)
        |> List.map (\( _, error ) -> p [] [ text error ])
        |> div [ style "color" "red", style "font-size" "14px" ]


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none



-- TABLE CONFIGURATION


organismsTableConfig : List B.SignalGroupFull -> List B.OrganismGroup -> List B.Organism -> Time.Zone -> Maybe Int -> RD.RemoteData ApiError (List B.AreaOfResponsibility) -> Model -> Table.Config B.Organism Msg
organismsTableConfig groups organismGroups allOrganisms timeZone editingOrganismId aorList model =
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
            [ Table.intColumn "ID" .id |> Table.withColumnWidth "6%"
            , Table.stringColumn "Назва" .name |> Table.withColumnWidth "14%"
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
                { name = "Смуги"
                , viewData =
                    \o ->
                        { attributes = []
                        , children =
                            [ div [ class "flex flex-wrap gap-1" ]
                                (let
                                    allAors =
                                        o.aorIds
                                            |> List.filterMap
                                                (\aorId ->
                                                    RD.toMaybe aorList
                                                        |> Maybe.andThen (ListX.find (\aor -> aor.id == aorId))
                                                )

                                    visibleAors =
                                        List.take 10 allAors
                                 in
                                 List.map
                                    (\aor ->
                                        span [ class "badge badge--neutral", title aor.name ]
                                            [ text aor.name ]
                                    )
                                    visibleAors
                                    ++ (if List.length allAors > 10 then
                                            let
                                                isOpen =
                                                    case model.rowShowAllPopupStatus of
                                                        Just ( organismId, ShowAllAors ) ->
                                                            organismId == o.id

                                                        _ ->
                                                            False
                                            in
                                            [ FloatingPopup.new
                                                { anchorContent =
                                                    span [ class "inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors" ]
                                                        [ text ("Показати всі " ++ String.fromInt (List.length allAors))
                                                        , i [ class "bi bi-chevron-down text-xs" ] []
                                                        ]
                                                , popupContent =
                                                    div [ class "p-1 max-h-[300px] max-w-[400px] overflow-y-auto" ]
                                                        [ div [ class "mb-3 pb-2 border-b border-gray-200 dark:border-gray-700" ]
                                                            [ h4 [ class "text-sm font-semibold text-gray-900 dark:text-gray-100" ]
                                                                [ text ("Смуги (" ++ String.fromInt (List.length allAors) ++ ")") ]
                                                            ]
                                                        , div [ class "space-y-2" ]
                                                            (List.map
                                                                (\aor ->
                                                                    div [ class "px-3 py-2 bg-gray-50 dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700" ]
                                                                        [ text aor.name ]
                                                                )
                                                                allAors
                                                            )
                                                        ]
                                                , isOpen = isOpen
                                                , onClose = RowShowAllPopupChanged Nothing
                                                , onOpen = RowShowAllPopupChanged <| Just ( o.id, ShowAllAors )
                                                }
                                                |> FloatingPopup.withPlacement FloatingPopup.Top
                                                |> FloatingPopup.view
                                            ]

                                        else
                                            []
                                       )
                                )
                            ]
                        }
                , sorter =
                    Table.increasingOrDecreasingBy
                        (\o ->
                            case RD.toMaybe aorList of
                                Just aors ->
                                    o.aorIds
                                        |> List.filterMap (\aorId -> ListX.find (\aor -> aor.id == aorId) aors)
                                        |> List.map .name
                                        |> String.join ", "

                                Nothing ->
                                    ""
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
                                (let
                                    computedGroups =
                                        getComputedGroups o.id model

                                    isLoading =
                                        isLoadingComputedGroups o.id model
                                 in
                                 if isLoading then
                                    [ Spinner.loadingSpinner2Sm ]

                                 else
                                    let
                                        sortedGroups =
                                            computedGroups |> List.sortBy (\group -> String.toLower (groupName group))

                                        visibleGroups =
                                            List.take 10 sortedGroups
                                    in
                                    List.map
                                        (\group ->
                                            span
                                                [ class "badge badge--ochre-light"
                                                , title (groupName group)
                                                ]
                                                [ text (groupName group) ]
                                        )
                                        visibleGroups
                                        ++ (if List.length sortedGroups > 10 then
                                                let
                                                    isOpen =
                                                        case model.rowShowAllPopupStatus of
                                                            Just ( organismId, ShowAllComputedGroups ) ->
                                                                organismId == o.id

                                                            _ ->
                                                                False
                                                in
                                                [ FloatingPopup.new
                                                    { anchorContent =
                                                        span [ class "inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors" ]
                                                            [ text ("Показати всі " ++ String.fromInt (List.length sortedGroups))
                                                            , i [ class "bi bi-chevron-down text-xs" ] []
                                                            ]
                                                    , popupContent =
                                                        div [ class "p-1 max-h-[300px] max-w-[400px] overflow-y-auto" ]
                                                            [ div [ class "mb-3 pb-2 border-b border-gray-200 dark:border-gray-700" ]
                                                                [ h4 [ class "text-sm font-semibold text-gray-900 dark:text-gray-100" ]
                                                                    [ text ("Доступні групи (" ++ String.fromInt (List.length sortedGroups) ++ ")") ]
                                                                ]
                                                            , div [ class "space-y-2" ]
                                                                (List.map
                                                                    (\group ->
                                                                        div [ class "px-3 py-2 bg-gray-50 dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700" ]
                                                                            [ text (groupName group) ]
                                                                    )
                                                                    sortedGroups
                                                                )
                                                            ]
                                                    , isOpen = isOpen
                                                    , onClose = RowShowAllPopupChanged Nothing
                                                    , onOpen = RowShowAllPopupChanged <| Just ( o.id, ShowAllComputedGroups )
                                                    }
                                                    |> FloatingPopup.withPlacement FloatingPopup.Top
                                                    |> FloatingPopup.view
                                                ]

                                            else
                                                []
                                           )
                                )
                            ]
                        }
                , sorter =
                    Table.increasingOrDecreasingBy
                        (\o ->
                            let
                                computedGroups =
                                    getComputedGroups o.id model
                            in
                            computedGroups
                                |> List.map groupName
                                |> String.join ", "
                        )
                }
                |> Table.withColumnWidth "19%"
            , Table.veryCustomColumn
                { name = "Ролі"
                , viewData =
                    \o ->
                        { attributes = []
                        , children =
                            [ div [ class "flex flex-wrap gap-1" ]
                                (let
                                    visibleRoles =
                                        List.take 10 o.roles
                                 in
                                 List.map
                                    (\role ->
                                        span
                                            [ class "badge badge--neutral"
                                            , title role
                                            ]
                                            [ text role ]
                                    )
                                    visibleRoles
                                    ++ (if List.length o.roles > 10 then
                                            let
                                                isOpen =
                                                    case model.rowShowAllPopupStatus of
                                                        Just ( organismId, ShowAllRoles ) ->
                                                            organismId == o.id

                                                        _ ->
                                                            False
                                            in
                                            [ FloatingPopup.new
                                                { anchorContent =
                                                    span [ class "inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors" ]
                                                        [ text ("Показати всі " ++ String.fromInt (List.length o.roles))
                                                        , i [ class "bi bi-chevron-down text-xs" ] []
                                                        ]
                                                , popupContent =
                                                    div [ class "p-1 max-h-[300px] max-w-[400px] overflow-y-auto" ]
                                                        [ div [ class "mb-3 pb-2 border-b border-gray-200 dark:border-gray-700" ]
                                                            [ h4 [ class "text-sm font-semibold text-gray-900 dark:text-gray-100" ]
                                                                [ text ("Ролі (" ++ String.fromInt (List.length o.roles) ++ ")") ]
                                                            ]
                                                        , div [ class "space-y-2" ]
                                                            (List.map
                                                                (\role ->
                                                                    div [ class "px-3 py-2 bg-gray-50 dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700" ]
                                                                        [ text role ]
                                                                )
                                                                o.roles
                                                            )
                                                        ]
                                                , isOpen = isOpen
                                                , onClose = RowShowAllPopupChanged Nothing
                                                , onOpen = RowShowAllPopupChanged <| Just ( o.id, ShowAllRoles )
                                                }
                                                |> FloatingPopup.withPlacement FloatingPopup.Top
                                                |> FloatingPopup.view
                                            ]

                                        else
                                            []
                                       )
                                )
                            ]
                        }
                , sorter = Table.increasingOrDecreasingBy (\o -> String.join ", " o.roles)
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
                { name = "Обмежити групами"
                , viewData =
                    \o ->
                        { attributes = [ class "col-wide" ]
                        , children =
                            [ div [ class "flex flex-wrap gap-1" ]
                                (let
                                    organismGroupIds =
                                        getOrganismGroups o.id organismGroups

                                    allGroups =
                                        organismGroupIds
                                            |> List.filterMap (\groupId -> ListX.find (\x -> x.masterKey == groupId) groups)
                                            |> List.sortBy (\group -> String.toLower (groupName group))

                                    visibleGroups =
                                        List.take 10 allGroups
                                 in
                                 List.map
                                    (\group ->
                                        span
                                            [ class "badge badge--ochre-light"
                                            , title (groupName group)
                                            ]
                                            [ text (groupName group) ]
                                    )
                                    visibleGroups
                                    ++ (if List.length allGroups > 10 then
                                            let
                                                isOpen =
                                                    case model.rowShowAllPopupStatus of
                                                        Just ( organismId, ShowAllGroups ) ->
                                                            organismId == o.id

                                                        _ ->
                                                            False
                                            in
                                            [ FloatingPopup.new
                                                { anchorContent =
                                                    span [ class "inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors" ]
                                                        [ text ("Показати всі " ++ String.fromInt (List.length allGroups))
                                                        , i [ class "bi bi-chevron-down text-xs" ] []
                                                        ]
                                                , popupContent =
                                                    div [ class "p-1 max-h-[300px] max-w-[400px] overflow-y-auto" ]
                                                        [ div [ class "mb-3 pb-2 border-b border-gray-200 dark:border-gray-700" ]
                                                            [ h4 [ class "text-sm font-semibold text-gray-900 dark:text-gray-100" ]
                                                                [ text ("Групи (" ++ String.fromInt (List.length allGroups) ++ ")") ]
                                                            ]
                                                        , div [ class "space-y-2" ]
                                                            (List.map
                                                                (\group ->
                                                                    div [ class "px-3 py-2 bg-gray-50 dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700" ]
                                                                        [ text (groupName group) ]
                                                                )
                                                                allGroups
                                                            )
                                                        ]
                                                , isOpen = isOpen
                                                , onClose = RowShowAllPopupChanged Nothing
                                                , onOpen = RowShowAllPopupChanged <| Just ( o.id, ShowAllGroups )
                                                }
                                                |> FloatingPopup.withPlacement FloatingPopup.Top
                                                |> FloatingPopup.view
                                            ]

                                        else
                                            []
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
                |> Table.withColumnWidth "19%"
            , Table.veryCustomColumn
                { name = "Створено"
                , viewData =
                    \o ->
                        { attributes = [ class "col-narrow" ]
                        , children = [ text (Utils.Time.renderDateF5FromMillis o.createdAt timeZone) ]
                        }
                , sorter = Table.increasingOrDecreasingBy (\o -> String.fromInt o.createdAt)
                }
                |> Table.withColumnWidth "10%"
            , Table.intColumn "Користувачі" .loginsCount
                |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = ""
                , viewData =
                    \o ->
                        { attributes = [ class "col-narrow" ]
                        , children =
                            [ div [ class "flex items-center gap-2" ]
                                [ button
                                    [ class "table-action-btn"
                                    , type_ "button"
                                    , onClick <| EditOrganism o.id
                                    ]
                                    [ i [ class "bi bi-pencil-square" ] []
                                    ]
                                , button
                                    [ class "table-action-btn border border-red-200"
                                    , style "color" "#dc2626"
                                    , style "background-color" "#fef2f2"
                                    , style "border-color" "#fecaca"
                                    , type_ "button"
                                    , onClick <| OpenDeleteModal o.id
                                    , title "Видалити організм"
                                    ]
                                    [ i [ class "bi bi-trash" ] [] ]
                                ]
                            ]
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "10%"
            ]
        , customizations = customizations
        }


addOrganismSidebarContent : Bool -> Model -> List (Html Msg)
addOrganismSidebarContent isDark model =
    let
        -- Отримуємо ID вибраного батьківського організму
        selectedParentId =
            model.inpParentOrganism.selectedItem

        -- Визначаємо доступні групи з урахуванням батька
        availableGroups =
            getAvailableGroupsForOrganism selectedParentId model.organismGroups model.groups

        groupsSelectedItems =
            model.inpGroups.selectedItems
                |> List.filterMap (\x -> ListX.find (\y -> y.masterKey == x) availableGroups)
                |> List.map (\x -> Select.basicMenuItem { item = x.masterKey, label = x.name })
    in
    [ div [ class "flex flex-col h-full" ]
        [ div [ class "p-6 border-b border-border" ]
            [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Створити організм" ]
            ]
        , div [ class "flex-1 overflow-y-auto p-6" ]
            [ div [ class "space-y-6" ]
                [ div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Назва" ]
                    , input
                        [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                        , type_ "text"
                        , placeholder "Назва організму"
                        , value model.inpName
                        , onInput SetName
                        ]
                        []
                    , viewFormErrors Name model.fieldsErrors
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Батьківський організм" ]
                    , div [ class "w-full" ]
                        [ Html.map AddParentSelMsg <|
                            Styled.toUnstyled <|
                                Utils.Select.renderSelectSingle
                                    (model.inpParentOrganism.selectedItem
                                        |> Maybe.andThen
                                            (\id ->
                                                ListX.find (\o -> o.id == id) model.organisms
                                                    |> Maybe.map (\o -> Select.basicMenuItem { item = id, label = o.name })
                                            )
                                    )
                                    model.inpParentOrganism.selectState
                                    model.inpParentOrganism.items
                                    "батьківський організм"
                                    (Utils.Select.defaultOptions isDark)
                        ]
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Ролі" ]
                    , div [ class "w-full" ]
                        [ Html.map AddRoleSelMsg <|
                            Styled.toUnstyled <|
                                Utils.Select.renderSelect
                                    (model.inpRole.selectedItems |> List.map (\x -> Select.basicMenuItem { item = x, label = x }))
                                    model.inpRole.selectState
                                    model.inpRole.items
                                    "роль"
                                    (Utils.Select.defaultOptions isDark)
                        ]
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Смуги" ]
                    , div [ class "w-full" ]
                        [ Html.map AddAorSelMsg <|
                            Styled.toUnstyled <|
                                Utils.Select.renderSelect
                                    (model.inpAors.selectedItems
                                        |> List.map
                                            (\id ->
                                                case RD.toMaybe model.aorList of
                                                    Just aors ->
                                                        ListX.find (\aor -> aor.id == id) aors
                                                            |> Maybe.map (\aor -> Select.basicMenuItem { item = id, label = aor.name })
                                                            |> Maybe.withDefault (Select.basicMenuItem { item = id, label = "Unknown" })

                                                    Nothing ->
                                                        Select.basicMenuItem { item = id, label = "Loading..." }
                                            )
                                    )
                                    model.inpAors.selectState
                                    (case RD.toMaybe model.aorList of
                                        Just aors ->
                                            aors |> List.map (\aor -> Select.basicMenuItem { item = aor.id, label = aor.name })

                                        Nothing ->
                                            []
                                    )
                                    "смуги"
                                    (Utils.Select.defaultOptions isDark)
                        ]
                    ]

                -- Computed Available Groups (read-only display)
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Доступні групи для організму" ]
                    , div [ class "p-3 rounded-md bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700" ]
                        [ if model.createIsLoadingComputedGroups then
                            div [ class "flex items-center gap-2" ]
                                [ Spinner.loadingSpinner2Sm
                                , p [ class "text-sm text-muted-foreground italic" ] [ text "Завантаження доступних груп..." ]
                                ]

                          else
                            case model.createComputedAvailableGroups of
                                Just computedGroups ->
                                    if List.isEmpty computedGroups then
                                        p [ class "text-sm text-muted-foreground italic" ] [ text "Немає доступних груп" ]

                                    else
                                        div [ class "flex flex-wrap gap-1" ]
                                            (computedGroups
                                                |> List.map
                                                    (\group ->
                                                        span
                                                            [ class "badge badge--ochre-light"
                                                            , title
                                                                (if String.isEmpty group.name then
                                                                    "Без назви (id=" ++ String.left 6 group.masterKey ++ "...)"

                                                                 else
                                                                    group.name
                                                                )
                                                            ]
                                                            [ text
                                                                (if String.isEmpty group.name then
                                                                    "Без назви (id=" ++ String.left 6 group.masterKey ++ "...)"

                                                                 else
                                                                    group.name
                                                                )
                                                            ]
                                                    )
                                            )

                                Nothing ->
                                    p [ class "text-sm text-muted-foreground italic" ] [ text "Оберіть смуги для отримання доступних груп" ]
                        ]
                    , p [ class "text-xs text-muted-foreground" ]
                        [ text "Ці групи будуть доступні організму на основі вибраних смуг та батьківського організму" ]
                    ]

                -- Checkbox to limit groups list
                , div [ class "space-y-2" ]
                    [ Checkbox.new { isChecked = model.createLimitGroupsList, onToggle = \_ -> ToggleLimitGroupsListCreate }
                        |> Checkbox.withContent [ text "Обмежити перелік груп" ]
                        |> Checkbox.view
                    , p [ class "text-xs text-muted-foreground ml-6" ]
                        [ text "За замовчуванням організм має доступ до всіх груп від смуг. Увімкніть для додаткового обмеження." ]
                    ]

                -- Groups selector (only when checkbox is enabled)
                , if model.createLimitGroupsList then
                    div [ class "space-y-2" ]
                        [ label [ class "text-sm font-medium text-foreground" ] [ text "Обмежити групами" ]
                        , div [ class "w-full" ]
                            [ Html.map AddGroupSelMsg <|
                                Styled.toUnstyled <|
                                    Utils.Select.renderSelect
                                        groupsSelectedItems
                                        model.inpGroups.selectState
                                        (availableGroups |> List.map (\x -> Select.basicMenuItem { item = x.masterKey, label = x.name }))
                                        "групи"
                                        (Utils.Select.defaultOptions isDark)
                            ]
                        , case model.groupsValidation of
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

                  else
                    text ""
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseCreateSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , Button.new
                    { label =
                        case model.groupsValidation of
                            Just groups ->
                                "Створити (втратити " ++ String.fromInt (List.length groups) ++ " груп)"

                            Nothing ->
                                if model.createLimitGroupsList then
                                    "Створити з обмеженням груп"

                                else
                                    "Створити (доступ до всіх груп від смуг)"
                    , onClick = AddOrganism
                    }
                    |> Button.view
                ]
            ]
        ]
    ]


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
                                Utils.Select.renderSelectSingle
                                    (editState.inpParentOrganism.selectedItem
                                        |> Maybe.andThen
                                            (\id ->
                                                ListX.find (\o -> o.id == id) model.organisms
                                                    |> Maybe.map (\o -> Select.basicMenuItem { item = id, label = o.name })
                                            )
                                    )
                                    editState.inpParentOrganism.selectState
                                    editState.inpParentOrganism.items
                                    "батьківський організм"
                                    (Utils.Select.defaultOptions isDark)
                        ]
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Ролі" ]
                    , div [ class "w-full" ]
                        [ Html.map EditRoleSelMsg <|
                            Styled.toUnstyled <|
                                Utils.Select.renderSelect
                                    (editState.inpRole.selectedItems |> List.map (\x -> Select.basicMenuItem { item = x, label = x }))
                                    editState.inpRole.selectState
                                    editState.inpRole.items
                                    "роль"
                                    (Utils.Select.defaultOptions isDark)
                        ]
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Смуги" ]
                    , div [ class "w-full" ]
                        [ Html.map EditAorSelMsg <|
                            Styled.toUnstyled <|
                                Utils.Select.renderSelect
                                    (editState.inpAors.selectedItems
                                        |> List.map
                                            (\id ->
                                                case RD.toMaybe model.aorList of
                                                    Just aors ->
                                                        ListX.find (\aor -> aor.id == id) aors
                                                            |> Maybe.map (\aor -> Select.basicMenuItem { item = id, label = aor.name })
                                                            |> Maybe.withDefault (Select.basicMenuItem { item = id, label = "Unknown" })

                                                    Nothing ->
                                                        Select.basicMenuItem { item = id, label = "Loading..." }
                                            )
                                    )
                                    editState.inpAors.selectState
                                    (case RD.toMaybe model.aorList of
                                        Just aors ->
                                            aors |> List.map (\aor -> Select.basicMenuItem { item = aor.id, label = aor.name })

                                        Nothing ->
                                            []
                                    )
                                    "смуги"
                                    (Utils.Select.defaultOptions isDark)
                        ]
                    ]

                -- Computed Available Groups (read-only display)
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Доступні групи для організму" ]
                    , div [ class "p-3 rounded-md bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700" ]
                        [ if editState.isLoadingComputedGroups then
                            div [ class "flex items-center gap-2" ]
                                [ Spinner.loadingSpinner2Sm
                                , p [ class "text-sm text-muted-foreground italic" ] [ text "Завантаження доступних груп..." ]
                                ]

                          else
                            case editState.computedAvailableGroups of
                                Just computedGroups ->
                                    if List.isEmpty computedGroups then
                                        p [ class "text-sm text-muted-foreground italic" ] [ text "Немає доступних груп" ]

                                    else
                                        div [ class "flex flex-wrap gap-1" ]
                                            (computedGroups
                                                |> List.map
                                                    (\group ->
                                                        span
                                                            [ class "badge badge--ochre-light"
                                                            , title
                                                                (if String.isEmpty group.name then
                                                                    "Без назви (id=" ++ String.left 6 group.masterKey ++ "...)"

                                                                 else
                                                                    group.name
                                                                )
                                                            ]
                                                            [ text
                                                                (if String.isEmpty group.name then
                                                                    "Без назви (id=" ++ String.left 6 group.masterKey ++ "...)"

                                                                 else
                                                                    group.name
                                                                )
                                                            ]
                                                    )
                                            )

                                Nothing ->
                                    p [ class "text-sm text-muted-foreground italic" ] [ text "Оберіть смуги для отримання доступних груп" ]
                        ]
                    , p [ class "text-xs text-muted-foreground" ]
                        [ text "Ці групи будуть доступні організму на основі вибраних смуг та батьківського організму" ]
                    ]

                -- Checkbox to limit groups list
                , div [ class "space-y-2" ]
                    [ Checkbox.new { isChecked = editState.limitGroupsList, onToggle = \_ -> ToggleLimitGroupsList }
                        |> Checkbox.withContent [ text "Обмежити перелік груп" ]
                        |> Checkbox.view
                    , p [ class "text-xs text-muted-foreground ml-6" ]
                        [ text "За замовчуванням організм має доступ до всіх груп від смуг. Увімкніть для додаткового обмеження." ]
                    ]

                -- Groups selector (only when checkbox is enabled)
                , if editState.limitGroupsList then
                    div [ class "space-y-2" ]
                        [ label [ class "text-sm font-medium text-foreground" ] [ text "Обмежити групами" ]
                        , div [ class "w-full" ]
                            [ Html.map EditGroupSelMsg <|
                                Styled.toUnstyled <|
                                    Utils.Select.renderSelect
                                        groupsSelectedItems
                                        editState.inpGroups.selectState
                                        (availableGroups |> List.map (\x -> Select.basicMenuItem { item = x.masterKey, label = x.name }))
                                        "групи"
                                        (Utils.Select.defaultOptions isDark)
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

                  else
                    text ""
                , div [ class "grid grid-cols-2 gap-4" ]
                    [ div [ class "flex items-center" ]
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
                                if editState.limitGroupsList then
                                    "Зберегти з обмеженням груп"

                                else
                                    "Зберегти (доступ до всіх груп від смуг)"
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
body dark shared _ model =
    let
        sidebarOpen =
            model.sidebarType /= Nothing

        sidebarContent =
            case model.sidebarType of
                Just CreateSidebar ->
                    addOrganismSidebarContent (isDarkMode shared.themeMode) model

                Just EditSidebar ->
                    case model.editOrganism of
                        Just ( organismId, editState ) ->
                            editOrganismSidebarContent (isDarkMode shared.themeMode) model organismId editState

                        Nothing ->
                            []

                Nothing ->
                    []
    in
    [ div
        [ classList [ ( "overflow-hidden", sidebarOpen ) ]
        , class "w-5/6 mx-auto my-4"
        ]
        [ Sidebar.view sidebarOpen
            (case model.sidebarType of
                Just CreateSidebar ->
                    CloseCreateSidebar

                Just EditSidebar ->
                    CloseEditSidebar

                Nothing ->
                    CloseCreateSidebar
            )
            sidebarContent
        , div [] (mainBlock dark model shared)
        ]
    , deleteModalView model.deleteModal
    ]


mainBlock : Bool -> Model -> Shared.Model -> List (Html Msg)
mainBlock _ model shared =
    [ div []
        [ div [ class "flex justify-between items-center mb-6" ]
            [ div [ class "flex items-center gap-4" ]
                [ h1 [ class "text-2xl font-bold text-foreground" ] [ text "Організми" ]
                , input
                    [ class "px-3 py-2 border border-border rounded-md bg-background text-foreground w-64"
                    , type_ "text"
                    , placeholder "Фільтр по назві..."
                    , value model.nameFilter
                    , onInput SetNameFilter
                    ]
                    []
                ]
            , Button.new { label = "Створити організм", onClick = OpenCreateSidebar }
                |> Button.view
            ]
        , div [ class "table-responsive-modern" ]
            [ Table.view
                (organismsTableConfig model.groups model.organismGroups model.organisms shared.timeZone (Maybe.map Tuple.first model.editOrganism) model.aorList model)
                model.tableState
                (filterOrganismsByName model.nameFilter model.organisms)
            ]
        ]
    ]


deleteModalView : Maybe DeleteModalState -> Html Msg
deleteModalView maybeModal =
    case maybeModal of
        Nothing ->
            text ""

        Just modalState ->
            let
                orgName =
                    organismDisplayName modalState.organism

                hasMultipleActiveUsers =
                    modalState.organism.loginsCount > 1

                buttonDisabled =
                    modalState.isSubmitting || hasMultipleActiveUsers
            in
            ModalDialog.modalDialog
                True
                CloseDeleteModal
                [ class "bg-background border border-border rounded-lg p-6 max-w-md w-full mx-4" ]
                [ h3 [ class "text-lg font-semibold mb-2" ] [ text "Видалити організм" ]
                , p [ class "text-sm text-muted-foreground mb-4" ]
                    [ text "Оберіть дію для "
                    , strong [] [ text orgName ]
                    ]
                , div [ class "space-y-3 mb-6 text-sm" ]
                    [ div []
                        [ strong [ class "font-semibold" ] [ text "Видалити" ]
                        , text " — організм стане неактивним (enabled = false)."
                        ]
                    , div []
                        [ strong [ class "font-semibold" ] [ text "Видалити назавжди" ]
                        , text " — організм вимикається та позначається як остаточно видалений."
                        ]
                    , if hasMultipleActiveUsers then
                        div [ class "p-3 rounded-md bg-yellow-50 border border-yellow-200 text-yellow-900 text-sm" ]
                            ((strong [] [ text "Активні користувачі організму:" ])
                                :: [ renderActiveLogins modalState ]
                            )

                      else
                        text ""
                    ]
                , div [ class "flex flex-col gap-2 sm:flex-row sm:justify-end" ]
                    [ Button.new { label = "Скасувати", onClick = CloseDeleteModal }
                        |> Button.withStyleSecondary
                        |> Button.withDisabled modalState.isSubmitting
                        |> Button.view
                    , Button.new { label = "Видалити", onClick = PerformDelete DeleteSoft }
                        |> Button.withStyleSecondary
                        |> Button.withDisabled buttonDisabled
                        |> Button.view
                    , Button.new { label = "Видалити назавжди", onClick = PerformDelete DeletePermanent }
                        |> Button.withStyleDanger
                        |> Button.withDisabled buttonDisabled
                        |> Button.view
                    ]
                ]


renderActiveLogins : DeleteModalState -> Html Msg
renderActiveLogins modalState =
    if modalState.isLoadingLogins then
        div [ class "mt-2 flex items-center gap-2" ]
            [ Spinner.loadingSpinner2Sm
            , text "Завантаження списку..."
            ]

    else
        case modalState.activeLogins of
            Just logins ->
                if List.isEmpty logins then
                    p [ class "mt-2" ] [ text "(немає активних користувачів)" ]

                else
                    ul [ class "mt-2 list-disc list-inside space-y-1" ]
                        (List.map
                            (\loginName -> li [] [ text loginName ])
                            logins
                        )

            Nothing ->
                p [ class "mt-2 text-red-600" ] [ text "Не вдалося завантажити активних користувачів" ]
