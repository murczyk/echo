module Pages.Admin.Organisms exposing (FieldError, FormField, Model, Msg, OrganismEdit, page)

import Api
import Auth
import Bindings as B
import Components.Table as Table
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Styled as Styled
import Layouts
import Le.Block.Select
import Le.Block.Toast
import Le.Components exposing (..)
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


groupName : B.SignalGroupFull -> String
groupName group =
    if group.name == "" then
        "Без назви (id=" ++ String.left 6 group.masterKey ++ "..." ++ ")"

    else
        group.name


type alias Model =
    { formErrors : Dict String String
    , toasts : Le.Block.Toast.Model
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
        , items : List (Select.MenuItem String)
        , selectedItems : List String
        }
    , fieldsErrors : List FieldError
    , groups : List B.SignalGroupFull
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
        , items : List (Select.MenuItem String)
        , selectedItems : List String
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
      , toasts = Le.Block.Toast.init
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
            , selectedItems = []
            }
      , fieldsErrors = []
      , timeZone = Nothing
      , groups = []
      , editOrganism = Nothing
      , groupsValidation = Nothing
      , tableState = Table.initialSort "Назва"
      }
    , E.sendCmd <|
        Cmd.batch
            [ Api.list_organisms GotOrganisms { sortBy = Nothing }
            , Api.organism_group_list GotGroupsList
            , Task.attempt GotTimeZone Le.Time.getZone
            ]
    )


type Msg
    = ToastMsg Le.Block.Toast.Msg
    | SetTableState Table.State
    | GotOrganisms (Result ApiError (List B.Organism))
    | AddRoleSelMsg (Select.Msg String)
    | EditRoleSelMsg (Select.Msg String)
    | AddGroupSelMsg (Select.Msg String)
    | EditGroupSelMsg (Select.Msg String)
    | AddParentSelMsg (Select.Msg String)
    | EditParentSelMsg (Select.Msg String)
    | AddOrganism
    | AddOrganismDone (Result ApiError B.Organism)
    | ToggleAutoAddGroups
    | ToggleEditAutoAddGroups
    | ToggleEditEnabled
    | EditOrganism Int
    | GotTimeZone (Result TimeZone.Error ( String, Time.Zone ))
    | SetName String
    | SetEditName String
    | GotGroupsList (Result ApiError (List B.SignalGroupFull))
    | AddGroupToOrganismDone Int String Bool (Result ApiError ())
    | RemoveGroupFromOrganismDone Int String (Result ApiError ())
    | EditOrganismSave
    | EditOrganismCancel
    | EditOrganismDone (Result ApiError B.Organism)


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

        SetTableState newTableState ->
            ( { model | tableState = newTableState }, E.none )

        GotOrganisms (Err e) ->
            Api.handleHttpError ToastMsg e model

        GotOrganisms (Ok res) ->
            let
                organismsMenuItems =
                    res |> List.map (\x -> Select.basicMenuItem { item = String.fromInt x.id, label = x.name })

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
                    model.inpParentOrganism.selectedItems |> List.head |> Maybe.andThen String.toInt

                groupsValidation =
                    let
                        groups = validateGroupsForParent model.organisms model.groups inpGroups2.selectedItems selectedParentId
                    in
                    if List.isEmpty groups then Nothing else Just groups
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
                            editOrganism.inpParentOrganism.selectedItems |> List.head |> Maybe.andThen String.toInt

                        groupsValidation =
                            let
                                groups = validateGroupsForParent model.organisms model.groups inpGroups2.selectedItems selectedParentId
                            in
                            if List.isEmpty groups then Nothing else Just groups

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
                    { inpParentOrganism | selectedItems = Le.Block.Select.multiUpdS mAction inpParentOrganism.selectedItems, selectState = iState }

                selectedParentId =
                    inpParentOrganism2.selectedItems |> List.head |> Maybe.andThen String.toInt

                groupsValidation =
                    let
                        groups = validateGroupsForParent model.organisms model.groups model.inpGroups.selectedItems selectedParentId
                    in
                    if List.isEmpty groups then Nothing else Just groups
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
                            { inpParentOrganism | selectedItems = Le.Block.Select.multiUpdS mAction inpParentOrganism.selectedItems, selectState = iState }

                        selectedParentId =
                            inpParentOrganism2.selectedItems |> List.head |> Maybe.andThen String.toInt

                        groupsValidation =
                            let
                                groups = validateGroupsForParent model.organisms model.groups editOrganism.inpGroups.selectedItems selectedParentId
                            in
                            if List.isEmpty groups then Nothing else Just groups

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
                            , parentId = model.inpParentOrganism.selectedItems |> List.head |> Maybe.andThen String.toInt
                            , groupAutoLink = Just model.autoAddGroups
                            , roles = model.inpRole.selectedItems
                            }
                    )

                Err errors ->
                    ( { model | fieldsErrors = errors }, E.none )

        AddOrganismDone (Ok organism) ->
            let
                updateSelectedItems r v =
                    { r | selectedItems = v }

                inpRole =
                    updateSelectedItems model.inpRole []

                inpParentOrganism =
                    updateSelectedItems model.inpParentOrganism []

                m2 =
                    { model
                        | inpName = ""
                        , inpRole = inpRole
                        , inpParentOrganism = inpParentOrganism
                        , autoAddGroups = False
                        , organisms = organism :: model.organisms
                        , fieldsErrors = []
                        , groupsValidation = Nothing
                    }
            in
            let
                selectedParentId =
                    model.inpParentOrganism.selectedItems |> List.head |> Maybe.andThen String.toInt

                -- Filter groups based on parent constraints
                groupsToAdd =
                    case selectedParentId of
                        Nothing ->
                            model.inpGroups.selectedItems
                        
                        Just pId ->
                            let
                                parentOrganism =
                                    model.organisms |> ListX.find (\o -> o.id == pId)
                                
                                parentGroupsSet =
                                    parentOrganism
                                        |> Maybe.map .groups
                                        |> Maybe.withDefault []
                                        |> Set.fromList
                                
                                selectedGroupsSet =
                                    Set.fromList model.inpGroups.selectedItems
                            in
                            Set.toList (Set.intersect selectedGroupsSet parentGroupsSet)
            in
            ( m2, E.sendCmd <| Cmd.batch (List.map (\x -> Api.add_group_to_organism (AddGroupToOrganismDone organism.id x False) { organismId = organism.id, groupName = x }) groupsToAdd) )

        AddOrganismDone (Err e) ->
            Api.handleHttpError ToastMsg e model

        AddGroupToOrganismDone organismId groupId edited (Ok _) ->
            if edited then
                let
                    organisms =
                        model.organisms |> ListX.updateIf (\x -> x.id == organismId) (\y -> { y | groups = groupId :: y.groups })
                in
                ( { model | organisms = organisms }, E.none )

            else
                let
                    inpGroups =
                        model.inpGroups

                    inpGroups2 =
                        { inpGroups | selectedItems = inpGroups.selectedItems |> ListX.remove groupId }

                    organisms =
                        model.organisms |> ListX.updateIf (\x -> x.id == organismId) (\y -> { y | groups = groupId :: y.groups })
                in
                ( { model | inpGroups = inpGroups2, organisms = organisms }, E.none )

        AddGroupToOrganismDone _ _ _ (Err e) ->
            Api.handleHttpError ToastMsg e model

        RemoveGroupFromOrganismDone organismId groupId (Ok _) ->
            let
                organisms =
                    model.organisms |> ListX.updateIf (\x -> x.id == organismId) (\y -> { y | groups = ListX.remove groupId y.groups })
            in
            ( { model | organisms = organisms }, E.none )

        RemoveGroupFromOrganismDone _ _ (Err e) ->
            Api.handleHttpError ToastMsg e model

        ToggleAutoAddGroups ->
            ( { model | autoAddGroups = not model.autoAddGroups }, E.none )

        ToggleEditAutoAddGroups ->
            case model.editOrganism of
                Just ( id, editOrganism ) ->
                    let
                        editOrganism2 =
                            { editOrganism | autoAddGroups = not model.autoAddGroups }
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
                                        , selectedItems = o.groups
                                        }
                                  , inpParentOrganism =
                                        { selectState = Select.initState (Select.selectIdentifier "sel-parent-edit")
                                        , items = model.organisms |> List.filter (\x -> x.id /= o.id) |> List.map (\x -> Select.basicMenuItem { item = String.fromInt x.id, label = x.name })
                                        , selectedItems = o.parentId |> Maybe.map (String.fromInt >> List.singleton) |> Maybe.withDefault []
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
            , E.sendCmd <|
                Le.Block.Toast.addError
                    ToastMsg
                    ("Error getting timezone: " ++ renderZoneError e)
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

        GotGroupsList (Err e) ->
            Api.handleHttpError ToastMsg e model

        GotGroupsList (Ok res) ->
            let
                groupsMenuItems =
                    res |> List.map (\x -> Select.basicMenuItem { item = x.masterKey, label = x.name })

                inpGroups =
                    model.inpGroups

                inpGroups2 =
                    { inpGroups | items = groupsMenuItems }
            in
            ( { model | groups = res, inpGroups = inpGroups2 }, E.none )

        EditOrganismSave ->
            case model.editOrganism of
                Just ( id, editOrganism ) ->
                    case Validate.validate validator editOrganism of
                        Ok _ ->
                            let
                                editOrganism2 =
                                    { editOrganism | fieldsErrors = [] }

                                originalSet =
                                    model.organisms
                                        |> ListX.find (\o -> o.id == id)
                                        |> Maybe.map .groups
                                        |> Maybe.withDefault []
                                        |> Set.fromList

                                selectedParentId =
                                    editOrganism.inpParentOrganism.selectedItems |> List.head |> Maybe.andThen String.toInt

                                -- Groups that should be available considering parent constraints
                                availableGroups =
                                    case selectedParentId of
                                        Nothing ->
                                            editOrganism.inpGroups.selectedItems
                                        
                                        Just pId ->
                                            let
                                                parentOrganism =
                                                    model.organisms |> ListX.find (\o -> o.id == pId)
                                                
                                                parentGroupsSet =
                                                    parentOrganism
                                                        |> Maybe.map .groups
                                                        |> Maybe.withDefault []
                                                        |> Set.fromList
                                                
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
                                        , parentId = editOrganism.inpParentOrganism.selectedItems |> List.head |> Maybe.andThen String.toInt
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

        EditOrganismDone (Ok o) ->
            ( { model | editOrganism = Nothing, organisms = model.organisms |> ListX.updateIf (\x -> x.id == o.id) (\y -> { y | name = o.name, parentId = o.parentId, roles = o.roles, groupAutoLink = o.groupAutoLink, enabled = o.enabled }) }, E.none )

        EditOrganismDone (Err e) ->
            Api.handleHttpError ToastMsg e model


validator : Validate.Validator ( FormField, String ) { a | inpName : String }
validator =
    Validate.all
        [ Validate.ifBlank .inpName ( Name, "Ім'я не може бути пустим" )
        ]


validateGroupsForParent : List B.Organism -> List B.SignalGroupFull -> List String -> Maybe Int -> List String
validateGroupsForParent allOrganisms allGroups selectedGroups parentId =
    case parentId of
        Nothing ->
            []
        
        Just pId ->
            let
                parentOrganism =
                    allOrganisms
                        |> ListX.find (\o -> o.id == pId)
                
                parentGroups =
                    parentOrganism
                        |> Maybe.map .groups
                        |> Maybe.withDefault []
                        |> Set.fromList
                
                selectedGroupsSet =
                    Set.fromList selectedGroups
                
                unavailableGroupIds =
                    Set.diff selectedGroupsSet parentGroups
                
                unavailableGroupNames =
                    unavailableGroupIds
                        |> Set.toList
                        |> List.filterMap (\groupId -> 
                            allGroups
                                |> ListX.find (\g -> g.masterKey == groupId)
                                |> Maybe.map (\g -> if String.isEmpty g.name then "Без назви (id=" ++ String.left 6 g.masterKey ++ "...)" else g.name)
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

organismsTableConfig : List B.SignalGroupFull -> List B.Organism -> Maybe Time.Zone -> Table.Config B.Organism Msg
organismsTableConfig groups allOrganisms timeZone =
    Table.config
        { toId = \o -> String.fromInt o.id
        , toMsg = SetTableState
        , columns =
            [ Table.stringColumn "Назва" .name
            , parentOrganismColumn allOrganisms
            , groupsColumn groups
            , rolesColumn
            , Table.customColumn
                { name = "Додавати групи автоматично"
                , viewData = \o -> if o.groupAutoLink then "✓" else "✗"
                , sorter = Table.increasingOrDecreasingBy (\o -> if o.groupAutoLink then "1" else "0")
                }
            , Table.customColumn
                { name = "Активна"
                , viewData = \o -> if o.enabled then "✓" else "✗"
                , sorter = Table.increasingOrDecreasingBy (\o -> if o.enabled then "1" else "0")
                }
            , Table.customColumn
                { name = "Створено"
                , viewData = \o -> Le.Time.renderDateF5FromMillis o.createdAt timeZone
                , sorter = Table.increasingOrDecreasingBy (\o -> String.fromInt o.createdAt)
                }
            , actionsColumn
            ]
        }


parentOrganismColumn : List B.Organism -> Table.Column B.Organism Msg
parentOrganismColumn allOrganisms =
    Table.customColumn
        { name = "Батьківський організм"
        , viewData = \o ->
            o.parentId
                |> Maybe.andThen (\parentId -> ListX.find (\x -> x.id == parentId) allOrganisms)
                |> Maybe.map .name
                |> Maybe.withDefault ""
        , sorter = Table.increasingOrDecreasingBy (\o ->
            o.parentId
                |> Maybe.andThen (\parentId -> ListX.find (\x -> x.id == parentId) allOrganisms)
                |> Maybe.map .name
                |> Maybe.withDefault ""
            )
        }


groupsColumn : List B.SignalGroupFull -> Table.Column B.Organism Msg
groupsColumn allGroups =
    Table.customColumn
        { name = "Групи"
        , viewData = \o ->
            o.groups
                |> List.filterMap (\groupId -> ListX.find (\x -> x.masterKey == groupId) allGroups)
                |> List.map groupName
                |> String.join ", "
        , sorter = Table.increasingOrDecreasingBy (\o ->
            o.groups
                |> List.filterMap (\groupId -> ListX.find (\x -> x.masterKey == groupId) allGroups)
                |> List.map groupName
                |> String.join ", "
            )
        }


rolesColumn : Table.Column B.Organism Msg
rolesColumn =
    Table.customColumn
        { name = "Ролі"
        , viewData = \o -> String.join ", " o.roles
        , sorter = Table.increasingOrDecreasingBy (\o -> String.join ", " o.roles)
        }


actionsColumn : Table.Column B.Organism Msg
actionsColumn =
    Table.veryCustomColumn
        { name = ""
        , viewData = \o ->
            { attributes = []
            , children =
                [ button
                    [ class "btn btn-outline-primary btn-sm me-2 py-0 px-1"
                    , type_ "button"
                    , onClick <| EditOrganism o.id
                    ]
                    [ i [ class "bi bi-pencil-square" ] []
                    ]
                ]
            }
        , sorter = Table.unsortable
        }





view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "Адмін: організми"
    , body = body dark shared user model
    }


body : Bool -> Shared.Model -> B.User -> Model -> List (Html Msg)
body dark shared user model =
    [ -- , Views.navBarAdmin dark "users"
      Views.noHeaderAndContent ToastMsg model.toasts <|
        div [ class "mt-2" ] (mainBlock dark model)
    ]


mainBlock : Bool -> Model -> List (Html Msg)
mainBlock isDark model =
    let
        addOrganismPanel : Model -> Html Msg
        addOrganismPanel m =
            let
                groupsSelectedItems =
                    m.inpGroups.selectedItems
                        |> List.filterMap (\x -> ListX.find (\y -> y.masterKey == x) model.groups)
                        |> List.map (\x -> Select.basicMenuItem { item = x.masterKey, label = x.name })
            in
            div
                [ class "d-flex justify-content-start align-items-start"
                , style "gap" "1%"
                ]
                [ div [ style "flex" "1" ]
                    [ input
                        [ class "form-control"
                        , type_ "text"
                        , placeholder "Назва"
                        , value m.inpName
                        , onInput <| SetName
                        ]
                        []
                    , viewFormErrors Name m.fieldsErrors
                    ]
                , div [ style "flex" "1" ]
                    [ div
                        [ class "d-flex justify-content-between align-items-center"
                        , style "font-size" ".8rem"
                        ]
                        [ div [ class "flex-grow-1" ]
                            [ Html.map AddParentSelMsg <|
                                Styled.toUnstyled <|
                                    Le.Block.Select.renderSelect
                                        (m.inpParentOrganism.selectedItems |> List.map (\x -> Select.basicMenuItem { item = x, label = x }))
                                        m.inpParentOrganism.selectState
                                        m.inpParentOrganism.items
                                        "батьківський організм"
                                        (Le.Block.Select.defaultOptions isDark)
                            ]
                        ]
                    ]
                , div [ style "flex" "1" ]
                    [ div
                        [ class "d-flex justify-content-between align-items-center"
                        , style "font-size" ".8rem"
                        ]
                        [ div [ class "flex-grow-1" ]
                            [ Html.map AddGroupSelMsg <|
                                Styled.toUnstyled <|
                                    Le.Block.Select.renderSelect
                                        groupsSelectedItems
                                        m.inpGroups.selectState
                                        m.inpGroups.items
                                        "групи"
                                        (Le.Block.Select.defaultOptions isDark)
                            ]
                        ]
                    , viewFormErrors Roles m.fieldsErrors
                    , case m.groupsValidation of
                        Just groups ->
                            div [ class "alert alert-warning mt-2", style "font-size" ".75rem" ]
                                [ text "⚠️ Попередження: при виборі цього батьківського організму буде втрачено доступ до груп: "
                                , strong [] [ text (String.join ", " groups) ]
                                ]
                        Nothing ->
                            text ""
                    ]
                , div [ style "flex" "1" ]
                    [ div
                        [ class "d-flex justify-content-between align-items-center"
                        , style "font-size" ".8rem"
                        ]
                        [ div [ class "flex-grow-1" ]
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
                , div [ class "form-check", style "flex" "1", style "align-self" "center" ]
                    [ input
                        [ class "form-check-input"
                        , type_ "checkbox"
                        , checked m.autoAddGroups
                        , onClick ToggleAutoAddGroups
                        , id "auto-add-groups"
                        ]
                        []
                    , label [ class "form-check-label", for "auto-add-groups" ] [ text "Автоматично додавати групи" ]
                    ]
                , div
                    [ class "text-center"
                    ]
                    [ button
                        [ class "btn btn-primary"
                        , type_ "button"
                        , onClick AddOrganism
                        ]
                        [ text "Додати" ]
                    ]
                ]

        renderEditableTr editState o =
            let
                groupsSelectedItems =
                    editState.inpGroups.selectedItems
                        |> List.filterMap (\x -> ListX.find (\y -> y.masterKey == x) model.groups)
                        |> List.map (\x -> Select.basicMenuItem { item = x.masterKey, label = x.name })
            in
            tr []
                [ td [ style "flex" "1" ]
                    [ input
                        [ class "form-control"
                        , type_ "text"
                        , placeholder "Назва"
                        , value editState.inpName
                        , onInput <| SetEditName
                        ]
                        []
                    , viewFormErrors Name editState.fieldsErrors
                    ]
                , td [ style "flex" "1" ]
                    [ div
                        [ class "d-flex justify-content-between align-items-center"
                        , style "font-size" ".8rem"
                        ]
                        [ div [ class "flex-grow-1" ]
                            [ Html.map EditParentSelMsg <|
                                Styled.toUnstyled <|
                                    Le.Block.Select.renderSelect
                                        (editState.inpParentOrganism.selectedItems |> List.map (\x -> Select.basicMenuItem { item = x, label = x }))
                                        editState.inpParentOrganism.selectState
                                        editState.inpParentOrganism.items
                                        "батьківський організм"
                                        (Le.Block.Select.defaultOptions isDark)
                            ]
                        ]
                    ]
                , td [ style "flex" "1" ]
                    [ div
                        [ class "d-flex justify-content-between align-items-center"
                        , style "font-size" ".8rem"
                        ]
                        [ div [ class "flex-grow-1" ]
                            [ Html.map EditGroupSelMsg <|
                                Styled.toUnstyled <|
                                    Le.Block.Select.renderSelect
                                        groupsSelectedItems
                                        editState.inpGroups.selectState
                                        editState.inpGroups.items
                                        "групи"
                                        (Le.Block.Select.defaultOptions isDark)
                            ]
                        ]
                    , case editState.groupsValidation of
                        Just groups ->
                            div [ class "alert alert-warning mt-2", style "font-size" ".75rem" ]
                                [ text "⚠️ Попередження: при виборі цього батьківського організму буде втрачено доступ до груп: "
                                , strong [] [ text (String.join ", " groups) ]
                                ]
                        Nothing ->
                            text ""
                    ]
                , td [ style "flex" "1" ]
                    [ div
                        [ class "d-flex justify-content-between align-items-center"
                        , style "font-size" ".8rem"
                        ]
                        [ div [ class "flex-grow-1" ]
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
                    ]
                , td [ style "text-align" "center", style "vertical-align" "middle" ]
                    [ input
                        [ class "form-check-input"
                        , type_ "checkbox"
                        , checked editState.autoAddGroups
                        , onClick ToggleEditAutoAddGroups
                        ]
                        []
                    ]
                , td [ style "text-align" "center", style "vertical-align" "middle" ]
                    [ input
                        [ class "form-check-input"
                        , type_ "checkbox"
                        , checked editState.enabled
                        , onClick ToggleEditEnabled
                        ]
                        []
                    ]
                , td [] [ text <| Le.Time.renderDateF5FromMillis o.createdAt model.timeZone ]
                , td []
                    [ div [ class "d-flex justify-content-start align-items-center" ]
                        [ button
                            [ class <| if Maybe.map List.isEmpty editState.groupsValidation == Just False then "btn btn-sm btn-outline-warning" else "btn btn-sm btn-outline-primary"
                            , type_ "button"
                            , onClick <| EditOrganismSave
                            ]
                            [ i [ class "bi bi-check2" ] []
                            , case editState.groupsValidation of
                                Just groups ->
                                    text <| " (втратити " ++ String.fromInt (List.length groups) ++ " груп)"
                                Nothing ->
                                    text ""
                            ]
                        , button
                            [ class "btn btn-sm btn-outline-danger ms-2"
                            , type_ "button"
                            , onClick <| EditOrganismCancel
                            ]
                            [ i [ class "bi bi-x" ] []
                            ]
                        ]
                    ]
                ]

        renderReadonlyTr timeZone o =
            tr []
                [ td [] [ text o.name ]
                , td []
                    [ o.parentId
                        |> Maybe.andThen (\parentId -> ListX.find (\x -> x.id == parentId) model.organisms)
                        |> Maybe.map (\parent -> text parent.name)
                        |> Maybe.withDefault (text "")
                    ]
                , td []
                    (o.groups
                        |> List.filterMap (\o2 -> ListX.find (\x -> x.masterKey == o2) model.groups)
                        |> List.map
                            (\group ->
                                span []
                                    [ text <| groupName group
                                    ]
                            )
                        |> List.intersperse (text ", ")
                    )
                , td [] (List.intersperse (text ", ") (List.map (\role -> span [] [ text <| role ]) o.roles))
                , td [ style "text-align" "center", style "vertical-align" "middle" ]
                    [ i [ class "bi", classList [ ( "bi-check-lg", o.groupAutoLink ), ( "bi-x-lg", not o.groupAutoLink ) ] ] []
                    ]
                , td [ style "text-align" "center", style "vertical-align" "middle" ]
                    [ i [ class "bi", classList [ ( "bi-check-lg", o.enabled ), ( "bi-x-lg", not o.enabled ) ] ] [] ]
                , td [] [ text <| Le.Time.renderDateF5FromMillis o.createdAt timeZone ]
                , td []
                    [ button
                        [ class "btn btn-outline-primary btn-sm me-2 py-0 px-1"
                        , type_ "button"
                        , onClick <| EditOrganism o.id
                        ]
                        [ i [ class "bi bi-pencil-square" ] []
                        ]
                    ]
                ]
    in
    [ div []
        [ h1 [ class "py-4" ] [ text "Організми" ]
        , div
            [ class "border mb-4 p-2"
            , style "background-color" "var(--bs-tertiary-bg)"
            ]
            [ addOrganismPanel
                model
            ]
        , div [ class "admin-table" ]
            [ Table.view 
                (organismsTableConfig model.groups model.organisms model.timeZone)
                model.tableState
                model.organisms
            ]
        ]
    ]
