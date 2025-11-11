module Pages.Admin.Users exposing (FieldError, FormField, LoginEdit, Model, Msg, page)

import Api
import Auth
import Bindings as B
import Core.Types exposing (..)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Html.Extra as HtmlX
import Html.Keyed
import Html.Styled as Styled exposing (fromUnstyled)
import Layouts
import List.Extra as ListX
import Maybe
import Page exposing (Page)
import Route exposing (Route)
import Select
import Shared
import Shared.Components.Button as Button
import Shared.Components.Checkbox as Checkbox
import Shared.Components.Sidebar as Sidebar
import Shared.Components.Table as Table
import Shared.Components.Table.Column as TableColumn
import Shared.Components.Table.Config as TableConfig
import Shared.Model exposing (isDarkMode)
import Task
import Time
import TimeZone
import Utils.Api.ErrorHandling
import Utils.Components exposing (..)
import Utils.Select
import Utils.Time
import Utils.Utils exposing (..)
import Utils.Views
import Validate
import View exposing (View)


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared _ =
    Page.new
        { init = \_ -> init
        , update = update
        , view = view user shared
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "admin"
        }


type Status
    = Active
    | Deleted
    | DeletedByAdmin
    | DeletedByInactivity
    | DeletedByOrganism
    | Unknown


statusToLabel : Status -> String
statusToLabel status =
    case status of
        Active ->
            "Активні"

        Deleted ->
            "Видалені"

        DeletedByAdmin ->
            "Видалені адміном"

        DeletedByInactivity ->
            "Видалені за неактивністю"

        DeletedByOrganism ->
            "Видалені через організм"

        Unknown ->
            "Невідомо"


type alias Model =
    { formErrors : Dict String String
    , logins : List B.Login
    , inpLogin : String
    , inpPassword : String
    , zones : List ( Int, B.SigintZone )
    , organisms : List B.Organism
    , inpZone :
        { selectState : Select.State
        , items : List (Select.MenuItem Int)
        , selectedItem : Maybe Int
        }
    , inpOrganism :
        { selectState : Select.State
        , items : List (Select.MenuItem Int)
        , selectedItem : Maybe Int
        }
    , inpRole :
        { selectState : Select.State
        , items : List (Select.MenuItem String)
        , selectedItems : List String
        }
    , fieldsErrors : List FieldError
    , editLogin : Maybe ( String, LoginEdit )
    , addDeltaLogin : Bool
    , sidebarOpen : Bool
    , filterOrganismSelect :
        { selectState : Select.State
        , items : List (Select.MenuItem Int)
        , selectedItems : List Int
        }
    , filterStatusSelect :
        { selectState : Select.State
        , items : List (Select.MenuItem Status)
        , selectedItem : Maybe Status
        }
    , filterRoleSelect :
        { selectState : Select.State
        , items : List (Select.MenuItem String)
        , selectedItems : List String
        }
    , filterLoginInput : String
    , tableState : Table.State
    }


type alias LoginEdit =
    { login : String
    , deltaLogin : Maybe String
    , inpPassword : Maybe String
    , doChangePassword : Bool
    , inpZone :
        { selectState : Select.State
        , items : List (Select.MenuItem Int)
        , selectedItem : Maybe Int
        }
    , inpOrganism :
        { selectState : Select.State
        , items : List (Select.MenuItem Int)
        , selectedItem : Maybe Int
        }
    , inpRole :
        { selectState : Select.State
        , items : List (Select.MenuItem String)
        , selectedItems : List String
        }
    , inpDeleted : Bool
    , fieldsErrors : List FieldError
    }


roles : List String
roles =
    [ "Admin", "Api", "Rer", "Bpla", "Full", "Basic", "UnitsEditor", "CallsignsEditor", "DeleteMsg", "NoAutoLogout" ]


init : ( Model, Effect Msg )
init =
    ( { formErrors = Dict.empty
      , logins = []
      , zones = []
      , organisms = []
      , inpLogin = ""
      , inpPassword = ""
      , inpZone =
            { selectState = Select.initState (Select.selectIdentifier "sel-zone-add")
            , items = []
            , selectedItem = Nothing
            }
      , inpOrganism =
            { selectState = Select.initState (Select.selectIdentifier "sel-organism-add")
            , items = []
            , selectedItem = Nothing
            }
      , inpRole =
            { selectState = Select.initState (Select.selectIdentifier "sel-role-add")
            , items = roles |> List.map (\x -> Select.basicMenuItem { item = x, label = x })
            , selectedItems = []
            }
      , fieldsErrors = []
      , editLogin = Nothing
      , addDeltaLogin = False
      , filterOrganismSelect =
            { selectState = Select.initState (Select.selectIdentifier "filter-organism")
            , items = []
            , selectedItems = []
            }
      , filterStatusSelect =
            { selectState = Select.initState (Select.selectIdentifier "filter-status")
            , items = []
            , selectedItem = Nothing
            }
      , filterRoleSelect =
            { selectState = Select.initState (Select.selectIdentifier "filter-role")
            , items = []
            , selectedItems = []
            }
      , tableState = Table.initialSort "Логін"
      , sidebarOpen = False
      , filterLoginInput = ""
      }
    , E.sendCmd <|
        Cmd.batch
            [ Api.list_logins GotLogins { sortBy = Just B.LoginCreatedAtDesc, filterByRoles = Nothing }
            , Api.sigint_zones_list GotZoneList
            , Api.list_organisms GotOrganisms { sortBy = Nothing }
            ]
    )


type Msg
    = GotLogins (Result ApiError B.ListLoginsRsp)
    | GotZoneList (Result ApiError (List ( Int, B.SigintZone )))
    | GotOrganisms (Result ApiError (List B.Organism))
    | SetLogin String
    | SetEditDeltaLogin String
    | SetPassword String
    | SetEditPassword String
    | AddLogin
    | AddLoginDelta
    | AddLoginDone (Result ApiError B.Login)
    | AddZoneSelMsg (Select.Msg Int)
    | AddOrganismSelMsg (Select.Msg Int)
    | AddRoleSelMsg (Select.Msg String)
    | EditZoneSelMsg (Select.Msg Int)
    | EditOrganismSelMsg (Select.Msg Int)
    | EditRoleSelMsg (Select.Msg String)
    | EditLogin String
    | EditLoginDone (Result ApiError B.Login)
    | EditLoginCancel
    | EditLoginSave
    | EditDeletedMsg
    | ToggleEditPassword
    | ToggleAddDeltaLogin
    | FilterOrganismSelMsg (Select.Msg Int)
    | FilterStatusSelMsg (Select.Msg Status)
    | FilterRoleSelMsg (Select.Msg String)
    | SetFilterLogin String
    | SetTableState Table.State
    | CloseEditSidebar


type FormField
    = Login
    | Password
    | Zone
    | Roles


type alias FieldError =
    ( FormField, String )


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        GotLogins (Ok res) ->
            let
                -- Calculate role counts for the new logins
                roleCounts =
                    res.users
                        |> List.concatMap .roles
                        |> List.foldl
                            (\role acc ->
                                Dict.update role
                                    (\maybeCount ->
                                        case maybeCount of
                                            Just count ->
                                                Just (count + 1)

                                            Nothing ->
                                                Just 1
                                    )
                                    acc
                            )
                            Dict.empty

                roleMenuItems =
                    List.map
                        (\role ->
                            let
                                count =
                                    Dict.get role roleCounts |> Maybe.withDefault 0
                            in
                            Select.customMenuItem
                                { item = role
                                , label = role
                                , view =
                                    fromUnstyled
                                        (Html.div []
                                            [ Html.text (role ++ " (" ++ String.fromInt count ++ ")") ]
                                        )
                                }
                        )
                        roles

                filterRoleSelect =
                    model.filterRoleSelect

                filterRoleSelect2 =
                    { filterRoleSelect | items = roleMenuItems }
            in
            ( { model | logins = res.users, filterRoleSelect = filterRoleSelect2 }, E.none )

        GotLogins (Err err) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Failed to Load Users" err )

        GotZoneList (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Failed to Load Zones" e )

        GotZoneList (Ok vs) ->
            let
                zoneMenuItems =
                    vs
                        |> List.map (\( id, item ) -> ( id, item.name ))
                        |> List.map (\( id, name ) -> Select.basicMenuItem { item = id, label = name })

                inpZone =
                    model.inpZone

                inpZone2 =
                    { inpZone | items = zoneMenuItems }
            in
            ( { model | zones = vs, inpZone = inpZone2 }, E.none )

        GotOrganisms (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Failed to Load Organisms" e )

        GotOrganisms (Ok res) ->
            let
                organismMenuItems =
                    res
                        |> List.map (\o -> ( o.id, o.name ))
                        |> List.map (\( id, name ) -> Select.basicMenuItem { item = id, label = name })

                inpOrganism =
                    model.inpOrganism

                inpOrganism2 =
                    { inpOrganism | items = organismMenuItems }

                filterOrganismSelect =
                    model.filterOrganismSelect

                filterOrganismSelect2 =
                    { filterOrganismSelect | items = organismMenuItems }
            in
            ( { model | organisms = res, inpOrganism = inpOrganism2, filterOrganismSelect = filterOrganismSelect2 }, E.none )

        SetLogin value ->
            ( { model | inpLogin = value }, E.none )

        SetEditDeltaLogin value ->
            case model.editLogin of
                Just ( id, editLogin ) ->
                    let
                        editLogin2 =
                            { editLogin | deltaLogin = Just value }
                    in
                    ( { model | editLogin = Just ( id, editLogin2 ) }, E.none )

                Nothing ->
                    ( model, E.none )

        SetPassword value ->
            ( { model | inpPassword = value }, E.none )

        SetEditPassword value ->
            case model.editLogin of
                Just ( id, editLogin ) ->
                    let
                        editLogin2 =
                            { editLogin | inpPassword = Just value }
                    in
                    ( { model | editLogin = Just ( id, editLogin2 ) }, E.none )

                Nothing ->
                    ( model, E.none )

        AddLogin ->
            case Validate.validate validatorAdd model of
                Ok _ ->
                    ( { model | fieldsErrors = [] }
                    , E.sendCmd <|
                        Api.create_login AddLoginDone
                            { login = String.trim model.inpLogin
                            , password = String.trim model.inpPassword
                            , sigintZoneId = model.inpZone.selectedItem
                            , organismId = model.inpOrganism.selectedItem
                            , roles = model.inpRole.selectedItems
                            }
                    )

                Err errors ->
                    ( { model | fieldsErrors = errors }, E.none )

        AddLoginDelta ->
            case Validate.validate validatorAddDelta model of
                Ok _ ->
                    ( { model | fieldsErrors = [] }
                    , E.sendCmd <|
                        Api.create_login_delta AddLoginDone
                            { login = String.trim model.inpLogin
                            , password = ""
                            , sigintZoneId = model.inpZone.selectedItem
                            , organismId = model.inpOrganism.selectedItem
                            , roles = model.inpRole.selectedItems
                            }
                    )

                Err errors ->
                    ( { model | fieldsErrors = errors }, E.none )

        AddLoginDone (Ok login) ->
            let
                updateSelectedItem r v =
                    { r | selectedItem = v }

                updateSelectedItems r v =
                    { r | selectedItems = v }

                inpZone =
                    updateSelectedItem model.inpZone Nothing

                inpOrganism =
                    updateSelectedItem model.inpOrganism Nothing

                inpRole =
                    updateSelectedItems model.inpRole []

                m2 =
                    { model
                        | inpLogin = ""
                        , inpPassword = ""
                        , inpZone = inpZone
                        , inpRole = inpRole
                        , inpOrganism = inpOrganism
                        , logins = login :: model.logins
                        , addDeltaLogin = False
                    }
            in
            ( m2, E.none )

        AddLoginDone (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Failed to Create User" e )

        AddZoneSelMsg selMsg ->
            let
                ( mAction, iState, iCmd ) =
                    Select.update selMsg model.inpZone.selectState

                inpZone =
                    model.inpZone

                inpZone2 =
                    { inpZone | selectedItem = Utils.Select.singleUpd mAction inpZone.selectedItem, selectState = iState }
            in
            ( { model | inpZone = inpZone2 }
            , E.batch
                [ E.sendCmd <| Cmd.map AddZoneSelMsg iCmd
                ]
            )

        AddOrganismSelMsg selMsg ->
            let
                ( mAction, iState, iCmd ) =
                    Select.update selMsg model.inpOrganism.selectState

                inpOrganism =
                    model.inpOrganism

                inpOrganism2 =
                    { inpOrganism | selectedItem = Utils.Select.singleUpd mAction inpOrganism.selectedItem, selectState = iState }
            in
            ( { model | inpOrganism = inpOrganism2 }
            , E.batch
                [ E.sendCmd <| Cmd.map AddOrganismSelMsg iCmd
                ]
            )

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

        EditZoneSelMsg selMsg ->
            case model.editLogin of
                Just ( loginId, editLogin ) ->
                    let
                        ( mAction, iState, iCmd ) =
                            Select.update selMsg editLogin.inpZone.selectState

                        inpZone =
                            editLogin.inpZone

                        inpZone2 =
                            { inpZone | selectedItem = Utils.Select.singleUpd mAction inpZone.selectedItem, selectState = iState }

                        a =
                            { editLogin | inpZone = inpZone2 }
                    in
                    ( { model | editLogin = Just ( loginId, a ) }
                    , E.batch
                        [ E.sendCmd <| Cmd.map EditZoneSelMsg iCmd
                        ]
                    )

                Nothing ->
                    ( model, E.none )

        EditOrganismSelMsg selMsg ->
            case model.editLogin of
                Just ( loginId, editLogin ) ->
                    let
                        ( mAction, iState, iCmd ) =
                            Select.update selMsg editLogin.inpOrganism.selectState

                        inpOrganism =
                            editLogin.inpOrganism

                        inpOrganism2 =
                            { inpOrganism | selectedItem = Utils.Select.singleUpd mAction inpOrganism.selectedItem, selectState = iState }

                        a =
                            { editLogin | inpOrganism = inpOrganism2 }
                    in
                    ( { model | editLogin = Just ( loginId, a ) }
                    , E.batch
                        [ E.sendCmd <| Cmd.map EditOrganismSelMsg iCmd
                        ]
                    )

                Nothing ->
                    ( model, E.none )

        EditRoleSelMsg selMsg ->
            case model.editLogin of
                Just ( loginId, editLogin ) ->
                    let
                        ( mAction, iState, iCmd ) =
                            Select.update selMsg editLogin.inpRole.selectState

                        inpRole =
                            editLogin.inpRole

                        inpRole2 =
                            { inpRole | selectedItems = Utils.Select.multiUpdS mAction inpRole.selectedItems, selectState = iState }

                        a =
                            { editLogin | inpRole = inpRole2 }
                    in
                    ( { model | editLogin = Just ( loginId, a ) }
                    , E.batch
                        [ E.sendCmd <| Cmd.map EditRoleSelMsg iCmd
                        ]
                    )

                Nothing ->
                    ( model, E.none )

        EditLogin rowId ->
            let
                login =
                    model.logins
                        |> ListX.find (\l -> l.login == rowId)
                        |> Maybe.map
                            (\l ->
                                ( l.login
                                , { login = l.login
                                  , deltaLogin = l.deltaLogin
                                  , inpPassword = Nothing
                                  , doChangePassword = False
                                  , inpZone =
                                        { selectState = Select.initState (Select.selectIdentifier "sel-zone-edit")
                                        , items = model.zones |> List.map (\( id, item ) -> Select.basicMenuItem { item = id, label = item.name })
                                        , selectedItem = l.sigintZoneId
                                        }
                                  , inpOrganism =
                                        { selectState = Select.initState (Select.selectIdentifier "sel-organism-edit")
                                        , items = model.organisms |> List.map (\o -> Select.basicMenuItem { item = o.id, label = o.name })
                                        , selectedItem = l.organismId
                                        }
                                  , inpRole =
                                        { selectState = Select.initState (Select.selectIdentifier "sel-role-edit")
                                        , items = roles |> List.map (\x -> Select.basicMenuItem { item = x, label = x })
                                        , selectedItems = l.roles
                                        }
                                  , inpDeleted = l.deleted
                                  , fieldsErrors = []
                                  }
                                )
                            )
            in
            ( { model | editLogin = login, sidebarOpen = True }, E.none )

        EditLoginSave ->
            case model.editLogin of
                Just ( id, editLogin ) ->
                    case Validate.validate validatorEdit editLogin of
                        Ok _ ->
                            let
                                editLogin2 =
                                    { editLogin | fieldsErrors = [] }

                                emptyStringToNothing mString =
                                    mString
                                        |> Maybe.andThen
                                            (\str ->
                                                if String.isEmpty str then
                                                    Nothing

                                                else
                                                    Just str
                                            )
                            in
                            ( { model | editLogin = Just ( id, editLogin2 ) }
                            , E.sendCmd <|
                                Api.update_login EditLoginDone
                                    { login = editLogin.login
                                    , password = emptyStringToNothing editLogin.inpPassword
                                    , sigintZoneId = editLogin.inpZone.selectedItem
                                    , organismId = editLogin.inpOrganism.selectedItem
                                    , roles = Utils.Utils.emptyToNothing editLogin.inpRole.selectedItems
                                    , deleted = Just editLogin.inpDeleted
                                    , deltaLogin = emptyStringToNothing editLogin.deltaLogin
                                    , deactivationReason =
                                        if editLogin.inpDeleted then
                                            Just B.Admin

                                        else
                                            Nothing
                                    }
                            )

                        Err errors ->
                            let
                                editLogin2 =
                                    { editLogin | fieldsErrors = errors }
                            in
                            ( { model | editLogin = Just ( id, editLogin2 ) }, E.none )

                Nothing ->
                    ( model, E.none )

        EditLoginCancel ->
            ( { model | editLogin = Nothing, sidebarOpen = False }, E.none )

        EditDeletedMsg ->
            case model.editLogin of
                Just ( id, editLogin ) ->
                    let
                        editLogin2 =
                            { editLogin | inpDeleted = not editLogin.inpDeleted }
                    in
                    ( { model | editLogin = Just ( id, editLogin2 ) }, E.none )

                Nothing ->
                    ( model, E.none )

        EditLoginDone (Ok login) ->
            let
                logins =
                    model.logins |> ListX.updateIf (\x -> x.login == login.login) (\_ -> login)

                m2 =
                    { model
                        | editLogin = Nothing
                        , sidebarOpen = False
                        , logins = logins
                    }
            in
            ( m2, E.none )

        EditLoginDone (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Failed to Update User" e )

        ToggleEditPassword ->
            case model.editLogin of
                Just ( id, editLogin ) ->
                    let
                        editLogin2 =
                            { editLogin | doChangePassword = not editLogin.doChangePassword }

                        editLogin3 =
                            { editLogin2
                                | inpPassword =
                                    if editLogin2.doChangePassword == False then
                                        Nothing

                                    else
                                        editLogin2.inpPassword
                            }
                    in
                    ( { model | editLogin = Just ( id, editLogin3 ) }, E.none )

                Nothing ->
                    ( model, E.none )

        ToggleAddDeltaLogin ->
            ( { model | addDeltaLogin = not model.addDeltaLogin }, E.none )

        FilterOrganismSelMsg selMsg ->
            let
                ( mAction, iState, iCmd ) =
                    Select.update selMsg model.filterOrganismSelect.selectState

                newFilterOrganism =
                    Utils.Select.multiUpdI mAction model.filterOrganismSelect.selectedItems

                filterOrganismSelect =
                    model.filterOrganismSelect

                filterOrganismSelect2 =
                    { filterOrganismSelect | selectedItems = newFilterOrganism, selectState = iState }
            in
            ( { model | filterOrganismSelect = filterOrganismSelect2 }
            , E.batch
                [ E.sendCmd <| Cmd.map FilterOrganismSelMsg iCmd
                ]
            )

        FilterStatusSelMsg selMsg ->
            let
                ( mAction, iState, iCmd ) =
                    Select.update selMsg model.filterStatusSelect.selectState

                newFilterStatus =
                    Utils.Select.singleUpd mAction model.filterStatusSelect.selectedItem

                filterStatusSelect =
                    model.filterStatusSelect

                filterStatusSelect2 =
                    { filterStatusSelect | selectedItem = newFilterStatus, selectState = iState }
            in
            ( { model | filterStatusSelect = filterStatusSelect2 }
            , E.batch
                [ E.sendCmd <| Cmd.map FilterStatusSelMsg iCmd
                ]
            )

        FilterRoleSelMsg selMsg ->
            let
                ( mAction, iState, iCmd ) =
                    Select.update selMsg model.filterRoleSelect.selectState

                newFilterRole =
                    Utils.Select.multiUpdS mAction model.filterRoleSelect.selectedItems

                filterRoleSelect =
                    model.filterRoleSelect

                filterRoleSelect2 =
                    { filterRoleSelect | selectedItems = newFilterRole, selectState = iState }
            in
            ( { model | filterRoleSelect = filterRoleSelect2 }
            , E.batch
                [ E.sendCmd <| Cmd.map FilterRoleSelMsg iCmd
                ]
            )

        SetFilterLogin value ->
            ( { model | filterLoginInput = value }, E.none )

        SetTableState newState ->
            ( { model | tableState = newState }, E.none )

        CloseEditSidebar ->
            ( { model | sidebarOpen = False, editLogin = Nothing }, E.none )


validatorAdd : Validate.Validator ( FormField, String ) Model
validatorAdd =
    Validate.all
        [ Validate.ifBlank (String.trim << .inpLogin) ( Login, "Логін не може бути пустим" )
        , Validate.ifBlank (String.trim << .inpPassword) ( Password, "Пароль не може бути пустим" )
        , Validate.ifEmptyList (.inpRole >> .selectedItems) ( Roles, "Виберіть хочаб 1 роль" )
        , Validate.ifNothing (.inpZone >> .selectedItem) ( Zone, "Виберіть зону" )
        ]


validatorEdit : Validate.Validator ( FormField, String ) LoginEdit
validatorEdit =
    Validate.all
        [ Validate.ifEmptyList (.inpRole >> .selectedItems) ( Roles, "Виберіть хочаб 1 роль" )
        , Validate.ifNothing (.inpZone >> .selectedItem) ( Zone, "Виберіть зону" )
        ]


validatorAddDelta : Validate.Validator ( FormField, String ) Model
validatorAddDelta =
    Validate.all
        [ Validate.ifBlank (String.trim << .inpLogin) ( Login, "Логін не може бути пустим" )
        , Validate.ifEmptyList (.inpRole >> .selectedItems) ( Roles, "Виберіть хочаб 1 роль" )
        , Validate.ifNothing (.inpZone >> .selectedItem) ( Zone, "Виберіть зону" )
        ]


viewFormErrors : FormField -> List FieldError -> Html msg
viewFormErrors field errors =
    errors
        |> List.filter (\( fieldError, _ ) -> fieldError == field)
        |> List.map (\( _, error ) -> p [] [ text error ])
        |> div [ class "text-red-500 text-sm" ]


viewDeletedStatus : Time.Zone -> B.Login -> Html msg
viewDeletedStatus timeZone login =
    if login.deleted then
        case login.deactivationReason of
            Just B.Admin ->
                div [ class "flex flex-col items-center" ]
                    [ i [ class "bi bi-person-x-fill text-red-500 text-xl" ] []
                    , span [ class "text-red-500 text-xs" ] [ text "Видалено адміном" ]
                    ]

            Just B.Inactive ->
                div [ class "flex flex-col items-center" ]
                    [ i [ class "bi bi-clock-history text-yellow-500 text-xl" ] []
                    , span [ class "text-yellow-500 text-xs" ] [ text "Неактивний" ]
                    , case login.lastActiveAt of
                        Just lastActive ->
                            span [ class "text-gray-500 text-xs" ]
                                [ text <| "Останній: " ++ Utils.Time.renderDateF5FromMillis lastActive timeZone ]

                        Nothing ->
                            text ""
                    ]

            Nothing ->
                case login.organismEnabled of
                    Just False ->
                        div [ class "flex flex-col items-center" ]
                            [ i [ class "bi bi-building-x text-red-500 text-xl" ] []
                            , span [ class "text-red-500 text-xs" ] [ text "Організм" ]
                            , span [ class "text-gray-500 text-xs" ] [ text "деактивовано" ]
                            ]

                    _ ->
                        div [ class "flex flex-col items-center" ]
                            [ i [ class "bi bi-question-circle text-gray-500 text-xl" ] []
                            , span [ class "text-gray-500 text-xs" ] [ text "Невідомо" ]
                            ]

    else
        -- Перевіряємо, чи не деактивовано організм
        case login.organismEnabled of
            Just False ->
                div [ class "flex flex-col items-center" ]
                    [ i [ class "bi bi-building-x text-red-500 text-xl" ] []
                    , span [ class "text-red-500 text-xs" ] [ text "Організм" ]
                    , span [ class "text-gray-500 text-xs" ] [ text "деактивовано" ]
                    ]

            _ ->
                div [ class "flex flex-col items-center" ]
                    [ i [ class "bi bi-check-circle-fill text-green-500 text-xl" ] []
                    , span [ class "text-green-500 text-xs" ] [ text "Активний" ]
                    ]


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none



-- Dynamic filter helper functions


getFilteredDataForLoginFilter : Model -> List B.Login
getFilteredDataForLoginFilter model =
    model.logins
        |> List.filter
            (\login ->
                let
                    matchesLogin =
                        if String.isEmpty model.filterLoginInput then
                            True

                        else
                            String.contains
                                (String.toLower model.filterLoginInput)
                                (String.toLower login.login)

                    matchesOrganism =
                        case model.filterOrganismSelect.selectedItems of
                            [] ->
                                True

                            organismIds ->
                                case login.organismId of
                                    Just orgId ->
                                        List.member orgId organismIds

                                    Nothing ->
                                        False

                    matchesStatus =
                        case model.filterStatusSelect.selectedItem of
                            Nothing ->
                                True

                            Just Active ->
                                not login.deleted

                            Just Deleted ->
                                login.deleted

                            Just DeletedByAdmin ->
                                login.deleted && login.deactivationReason == Just B.Admin

                            Just DeletedByInactivity ->
                                login.deleted && login.deactivationReason == Just B.Inactive

                            Just DeletedByOrganism ->
                                login.deleted && login.deactivationReason == Nothing && login.organismEnabled == Just False

                            Just Unknown ->
                                login.deleted && login.deactivationReason == Nothing && login.organismEnabled /= Just False

                    matchesRole =
                        case model.filterRoleSelect.selectedItems of
                            [] ->
                                True

                            selectedRoles ->
                                List.any (\role -> List.member role selectedRoles) login.roles
                in
                matchesLogin && matchesOrganism && matchesStatus && matchesRole
            )


getFilteredDataForOrganismFilter : Model -> List B.Login
getFilteredDataForOrganismFilter model =
    model.logins
        |> List.filter
            (\login ->
                let
                    matchesStatus =
                        case model.filterStatusSelect.selectedItem of
                            Nothing ->
                                True

                            Just Active ->
                                not login.deleted

                            Just Deleted ->
                                login.deleted

                            Just DeletedByAdmin ->
                                login.deleted && login.deactivationReason == Just B.Admin

                            Just DeletedByInactivity ->
                                login.deleted && login.deactivationReason == Just B.Inactive

                            Just DeletedByOrganism ->
                                login.deleted && login.deactivationReason == Nothing && login.organismEnabled == Just False

                            Just Unknown ->
                                login.deleted && login.deactivationReason == Nothing && login.organismEnabled /= Just False

                    matchesRole =
                        case model.filterRoleSelect.selectedItems of
                            [] ->
                                True

                            selectedRoles ->
                                List.any (\role -> List.member role selectedRoles) login.roles
                in
                matchesStatus && matchesRole
            )


getFilteredDataForStatusFilter : Model -> List B.Login
getFilteredDataForStatusFilter model =
    model.logins
        |> List.filter
            (\login ->
                let
                    matchesOrganism =
                        case model.filterOrganismSelect.selectedItems of
                            [] ->
                                True

                            organismIds ->
                                case login.organismId of
                                    Just orgId ->
                                        List.member orgId organismIds

                                    Nothing ->
                                        False

                    matchesRole =
                        case model.filterRoleSelect.selectedItems of
                            [] ->
                                True

                            selectedRoles ->
                                List.any (\role -> List.member role selectedRoles) login.roles
                in
                matchesOrganism && matchesRole
            )


getFilteredDataForRoleFilter : Model -> List B.Login
getFilteredDataForRoleFilter model =
    model.logins
        |> List.filter
            (\login ->
                let
                    matchesOrganism =
                        case model.filterOrganismSelect.selectedItems of
                            [] ->
                                True

                            organismIds ->
                                case login.organismId of
                                    Just orgId ->
                                        List.member orgId organismIds

                                    Nothing ->
                                        False

                    matchesStatus =
                        case model.filterStatusSelect.selectedItem of
                            Nothing ->
                                True

                            Just Active ->
                                not login.deleted

                            Just Deleted ->
                                login.deleted

                            Just DeletedByAdmin ->
                                login.deleted && login.deactivationReason == Just B.Admin

                            Just DeletedByInactivity ->
                                login.deleted && login.deactivationReason == Just B.Inactive

                            Just DeletedByOrganism ->
                                login.deleted && login.deactivationReason == Nothing && login.organismEnabled == Just False

                            Just Unknown ->
                                login.deleted && login.deactivationReason == Nothing && login.organismEnabled /= Just False
                in
                matchesOrganism && matchesStatus
            )


view : Auth.User -> Shared.Model -> Model -> View Msg
view user shared model =
    { title = "Користувачі"
    , body =
        [ div
            [ classList [ ( "overflow-hidden", model.sidebarOpen ) ]
            , class "w-5/6 mx-auto"
            ]
            [ Sidebar.view model.sidebarOpen
                CloseEditSidebar
                (case model.editLogin of
                    Just ( loginId, editState ) ->
                        editLoginSidebarContent shared model loginId editState

                    Nothing ->
                        []
                )
            , div [] (mainContent shared model)
            ]
        ]
    }


mainContent : Shared.Model -> Model -> List (Html Msg)
mainContent shared model =
    [ div [ class "" ]
        [ h1 [ class "text-2xl font-bold mb-6" ] [ text "Користувачі" ]
        , let
            featureDelta =
                case shared.serverInfo of
                    Just info ->
                        info.featureDelta

                    Nothing ->
                        False

            addLoginPanel : Model -> Html Msg
            addLoginPanel addState =
                let
                    organismSelectedItem =
                        addState.inpOrganism.selectedItem
                            |> Maybe.andThen (\itemId -> ListX.find (\x -> x.id == itemId) addState.organisms)
                            |> Maybe.map
                                (\item ->
                                    Select.basicMenuItem { item = item.id, label = item.name }
                                )

                    zoneSelectedItem =
                        addState.inpZone.selectedItem
                            |> Maybe.andThen (\itemId -> ListX.find (\( id, _ ) -> id == itemId) addState.zones)
                            |> Maybe.map (\( id, item ) -> Select.basicMenuItem { item = id, label = item.name })
                in
                div [ class "border mb-4 p-2", style "background-color" "var(--bs-tertiary-bg)" ]
                    [ if featureDelta then
                        div [ class "mr-2" ]
                            [ Checkbox.new { isChecked = addState.addDeltaLogin, onToggle = \_ -> ToggleAddDeltaLogin }
                                |> Checkbox.withContent [ span [] [ text "Delta логін" ] ]
                                |> Checkbox.view
                            ]

                      else
                        text ""
                    , div [ class "flex justify-start items-start gap-[1%]" ]
                        [ div [ class "flex-1" ]
                            [ input
                                [ class "border border-gray-300 rounded px-3 py-2 w-full"
                                , type_ "text"
                                , placeholder "Логін"
                                , onInput <| SetLogin
                                , value addState.inpLogin
                                ]
                                []
                            , viewFormErrors Login addState.fieldsErrors
                            ]
                        , div [ class "flex-1" ]
                            [ input
                                [ class "border border-gray-300 rounded px-3 py-2 w-full"
                                , type_ "text"
                                , placeholder "Пароль"
                                , onInput <| SetPassword
                                , value addState.inpPassword
                                , disabled addState.addDeltaLogin
                                ]
                                []
                            , viewFormErrors Password addState.fieldsErrors
                            ]
                        , div [ class "flex-1" ]
                            [ div [ class "flex justify-between items-center text-[0.8rem]" ]
                                [ div [ class "flex-grow-1" ]
                                    [ Html.map AddRoleSelMsg <|
                                        Styled.toUnstyled <|
                                            Utils.Select.renderSelect
                                                (addState.inpRole.selectedItems |> List.map (\x -> Select.basicMenuItem { item = x, label = x }))
                                                addState.inpRole.selectState
                                                addState.inpRole.items
                                                "роль"
                                                (Utils.Select.defaultOptions (isDarkMode shared.themeMode))
                                    ]
                                ]
                            , viewFormErrors Roles addState.fieldsErrors
                            ]
                        , div [ class "flex-1" ]
                            [ div [ class "flex justify-between items-center text-[0.8rem]" ]
                                [ div [ class "flex-grow-1" ]
                                    [ Html.map AddZoneSelMsg <|
                                        Styled.toUnstyled <|
                                            Utils.Select.renderSelectSingle
                                                zoneSelectedItem
                                                addState.inpZone.selectState
                                                addState.inpZone.items
                                                "зона"
                                                (Utils.Select.defaultOptions (isDarkMode shared.themeMode))
                                    ]
                                ]
                            , viewFormErrors Zone addState.fieldsErrors
                            ]
                        , div [ class "flex justify-between items-center text-[0.8rem] flex-1" ]
                            [ div [ class "flex-grow-1" ]
                                [ Html.map AddOrganismSelMsg <|
                                    Styled.toUnstyled <|
                                        Utils.Select.renderSelectSingle
                                            organismSelectedItem
                                            addState.inpOrganism.selectState
                                            addState.inpOrganism.items
                                            "організм"
                                            (Utils.Select.defaultOptions (isDarkMode shared.themeMode))
                                ]
                            ]
                        , div [ class "text-center" ]
                            [ Button.new
                                { label = "Додати"
                                , onClick =
                                    if addState.addDeltaLogin then
                                        AddLoginDelta

                                    else
                                        AddLogin
                                }
                                |> Button.view
                            ]
                        ]
                    ]

            -- Calculate role counts using filtered data
            roleCounts =
                getFilteredDataForRoleFilter model
                    |> List.concatMap .roles
                    |> List.foldl
                        (\role acc ->
                            Dict.update role
                                (\maybeCount ->
                                    case maybeCount of
                                        Just count ->
                                            Just (count + 1)

                                        Nothing ->
                                            Just 1
                                )
                                acc
                        )
                        Dict.empty

            roleMenuItems =
                List.map
                    (\role ->
                        let
                            count =
                                Dict.get role roleCounts |> Maybe.withDefault 0
                        in
                        Select.customMenuItem
                            { item = role
                            , label = role
                            , view =
                                fromUnstyled
                                    (Html.div []
                                        [ Html.text (role ++ " (" ++ String.fromInt count ++ ")") ]
                                    )
                            }
                    )
                    roles

            -- Calculate status counts using filtered data
            filteredDataForStatus =
                getFilteredDataForStatusFilter model

            activeCount =
                List.length <| List.filter (\login -> not login.deleted) filteredDataForStatus

            deletedCount =
                List.length <| List.filter (\login -> login.deleted) filteredDataForStatus

            deletedByAdminCount =
                List.length <| List.filter (\login -> login.deleted && login.deactivationReason == Just B.Admin) filteredDataForStatus

            deletedByInactivityCount =
                List.length <| List.filter (\login -> login.deleted && login.deactivationReason == Just B.Inactive) filteredDataForStatus

            deletedByOrganismCount =
                List.length <| List.filter (\login -> login.deleted && login.deactivationReason == Nothing && login.organismEnabled == Just False) filteredDataForStatus

            unknownCount =
                List.length <| List.filter (\login -> login.deleted && login.deactivationReason == Nothing && login.organismEnabled /= Just False) filteredDataForStatus

            -- Calculate organism counts using filtered data
            filteredDataForOrganism =
                getFilteredDataForOrganismFilter model

            organismCounts =
                filteredDataForOrganism
                    |> List.filterMap .organismId
                    |> List.foldl
                        (\orgId acc ->
                            Dict.update orgId
                                (\maybeCount ->
                                    case maybeCount of
                                        Just count ->
                                            Just (count + 1)

                                        Nothing ->
                                            Just 1
                                )
                                acc
                        )
                        Dict.empty

            organismMenuItems =
                List.map
                    (\org ->
                        let
                            count =
                                Dict.get org.id organismCounts |> Maybe.withDefault 0
                        in
                        Select.customMenuItem
                            { item = org.id
                            , label = org.name
                            , view =
                                fromUnstyled
                                    (Html.div []
                                        [ Html.text (org.name ++ " (" ++ String.fromInt count ++ ")") ]
                                    )
                            }
                    )
                    model.organisms

            statusMenuItems =
                [ Select.customMenuItem
                    { item = Active
                    , label = statusToLabel Active
                    , view =
                        fromUnstyled
                            (Html.div []
                                [ Html.text (statusToLabel Active ++ " (" ++ String.fromInt activeCount ++ ")") ]
                            )
                    }
                , Select.customMenuItem
                    { item = Deleted
                    , label = statusToLabel Deleted
                    , view =
                        fromUnstyled
                            (Html.div []
                                [ Html.text (statusToLabel Deleted ++ " (" ++ String.fromInt deletedCount ++ ")") ]
                            )
                    }
                , Select.customMenuItem
                    { item = DeletedByAdmin
                    , label = statusToLabel DeletedByAdmin
                    , view =
                        fromUnstyled
                            (Html.div []
                                [ Html.text (statusToLabel DeletedByAdmin ++ " (" ++ String.fromInt deletedByAdminCount ++ ")") ]
                            )
                    }
                , Select.customMenuItem
                    { item = DeletedByInactivity
                    , label = statusToLabel DeletedByInactivity
                    , view =
                        fromUnstyled
                            (Html.div []
                                [ Html.text (statusToLabel DeletedByInactivity ++ " (" ++ String.fromInt deletedByInactivityCount ++ ")") ]
                            )
                    }
                , Select.customMenuItem
                    { item = DeletedByOrganism
                    , label = statusToLabel DeletedByOrganism
                    , view =
                        fromUnstyled
                            (Html.div []
                                [ Html.text (statusToLabel DeletedByOrganism ++ " (" ++ String.fromInt deletedByOrganismCount ++ ")") ]
                            )
                    }
                , Select.customMenuItem
                    { item = Unknown
                    , label = statusToLabel Unknown
                    , view =
                        fromUnstyled
                            (Html.div []
                                [ Html.text (statusToLabel Unknown ++ " (" ++ String.fromInt unknownCount ++ ")") ]
                            )
                    }
                ]

            rows =
                getFilteredDataForLoginFilter model

            viewFilterBlock : Html Msg
            viewFilterBlock =
                div [ class "mb-4 p-4 style bg-[var(--bs-tertiary-bg)] rounded-lg border" ]
                    [ h5 [ class "mb-2" ] [ text "Фільтри" ]
                    , div [ class "flex gap-4" ]
                        [ div [ class "flex-1" ]
                            [ label [ class "block text-sm font-medium mb-1" ] [ text "Організм" ]
                            , Html.map FilterOrganismSelMsg <|
                                Styled.toUnstyled <|
                                    Utils.Select.renderSelect
                                        (model.filterOrganismSelect.selectedItems
                                            |> List.map
                                                (\orgId ->
                                                    case ListX.find (\org -> org.id == orgId) model.organisms of
                                                        Just org ->
                                                            let
                                                                count =
                                                                    Dict.get org.id organismCounts |> Maybe.withDefault 0
                                                            in
                                                            Select.customMenuItem
                                                                { item = org.id
                                                                , label = org.name
                                                                , view =
                                                                    fromUnstyled
                                                                        (Html.div []
                                                                            [ Html.text (org.name ++ " (" ++ String.fromInt count ++ ")") ]
                                                                        )
                                                                }

                                                        Nothing ->
                                                            Select.basicMenuItem { item = orgId, label = String.fromInt orgId }
                                                )
                                        )
                                        model.filterOrganismSelect.selectState
                                        organismMenuItems
                                        "Всі организми"
                                        (Utils.Select.defaultOptions (isDarkMode shared.themeMode))
                            ]
                        , div [ class "flex-1" ]
                            [ label [ class "block text-sm font-medium  mb-1" ] [ text "Статус" ]
                            , Html.map FilterStatusSelMsg <|
                                Styled.toUnstyled <|
                                    Utils.Select.renderSelectSingle
                                        (Maybe.map
                                            (\status ->
                                                Select.customMenuItem
                                                    { item = status
                                                    , label = statusToLabel status
                                                    , view =
                                                        fromUnstyled
                                                            (Html.div []
                                                                [ Html.text
                                                                    (statusToLabel status
                                                                        ++ " ("
                                                                        ++ (case status of
                                                                                Active ->
                                                                                    String.fromInt activeCount

                                                                                Deleted ->
                                                                                    String.fromInt deletedCount

                                                                                DeletedByAdmin ->
                                                                                    String.fromInt deletedByAdminCount

                                                                                DeletedByInactivity ->
                                                                                    String.fromInt deletedByInactivityCount

                                                                                DeletedByOrganism ->
                                                                                    String.fromInt deletedByOrganismCount

                                                                                Unknown ->
                                                                                    String.fromInt unknownCount
                                                                           )
                                                                        ++ ")"
                                                                    )
                                                                ]
                                                            )
                                                    }
                                            )
                                            model.filterStatusSelect.selectedItem
                                        )
                                        model.filterStatusSelect.selectState
                                        statusMenuItems
                                        "Всі статуси"
                                        (Utils.Select.defaultOptions (isDarkMode shared.themeMode))
                            ]
                        , div [ class "flex-1" ]
                            [ label [ class "block text-sm font-medium mb-1" ] [ text "Роль" ]
                            , Html.map FilterRoleSelMsg <|
                                Styled.toUnstyled <|
                                    Utils.Select.renderSelect
                                        (model.filterRoleSelect.selectedItems
                                            |> List.map
                                                (\role ->
                                                    Select.customMenuItem
                                                        { item = role
                                                        , label = role
                                                        , view =
                                                            fromUnstyled
                                                                (Html.div []
                                                                    [ Html.text
                                                                        (role
                                                                            ++ " ("
                                                                            ++ (Dict.get role roleCounts |> Maybe.withDefault 0 |> String.fromInt)
                                                                            ++ ")"
                                                                        )
                                                                    ]
                                                                )
                                                        }
                                                )
                                        )
                                        model.filterRoleSelect.selectState
                                        roleMenuItems
                                        "Всі ролі"
                                        (Utils.Select.defaultOptions (isDarkMode shared.themeMode))
                            ]
                        ]
                    , div [ class "grid grid-cols-12 gap-4 mt-4" ]
                        [ div [ class "col-span-4" ]
                            [ label [ class "block text-sm font-medium mb-1" ] [ text "Логін" ]
                            , div [ class "flex-1" ]
                                [ input
                                    [ class "form-input w-full"
                                    , type_ "text"
                                    , placeholder "Пошук за логіном..."
                                    , value model.filterLoginInput
                                    , onInput SetFilterLogin
                                    ]
                                    []
                                ]
                            ]
                        ]
                    ]
          in
          div []
            [ addLoginPanel model
            , viewFilterBlock
            , div [ class "table-responsive-modern" ]
                [ Table.view
                    (usersTableConfig shared model)
                    model.tableState
                    rows
                ]
            ]
        ]
    ]



-- SIDEBAR CONTENT


editLoginSidebarContent : Shared.Model -> Model -> String -> LoginEdit -> List (Html Msg)
editLoginSidebarContent shared model loginId editState =
    let
        featureDelta =
            case shared.serverInfo of
                Just info ->
                    info.featureDelta

                Nothing ->
                    False

        organismSelectedItem =
            editState.inpOrganism.selectedItem
                |> Maybe.andThen (\itemId -> ListX.find (\x -> x.id == itemId) model.organisms)
                |> Maybe.map (\item -> Select.basicMenuItem { item = item.id, label = item.name })

        zoneSelectedItem =
            editState.inpZone.selectedItem
                |> Maybe.andThen (\itemId -> ListX.find (\( id, _ ) -> id == itemId) model.zones)
                |> Maybe.map (\( id, item ) -> Select.basicMenuItem { item = id, label = item.name })
    in
    [ div [ class "flex flex-col h-full" ]
        [ div [ class "p-6 border-b border-border" ]
            [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Редагувати користувача" ]
            , p [ class "text-sm text-muted-foreground" ] [ text ("Логін: " ++ loginId) ]
            ]
        , div [ class "flex-1 overflow-y-auto p-6" ]
            [ div [ class "space-y-6" ]
                [ if featureDelta then
                    div [ class "space-y-2" ]
                        [ label [ class "text-sm font-medium text-foreground" ] [ text "Дельта логін" ]
                        , input
                            [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                            , type_ "text"
                            , placeholder "Дельта логін"
                            , value (Maybe.withDefault "" editState.deltaLogin)
                            , onInput SetEditDeltaLogin
                            ]
                            []
                        ]

                  else
                    text ""
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Пароль" ]
                    , div [ class "flex items-center gap-2" ]
                        [ input
                            [ class "flex-1 px-3 py-2 border border-border rounded-md bg-background text-foreground"
                            , type_ "password"
                            , placeholder
                                (if editState.doChangePassword then
                                    "Введіть новий пароль"

                                 else
                                    "••••••••••••••"
                                )
                            , value (Maybe.withDefault "" editState.inpPassword)
                            , onInput SetEditPassword
                            , disabled (not editState.doChangePassword)
                            ]
                            []
                        , if editState.doChangePassword then
                            Button.new { label = "Скасувати", onClick = ToggleEditPassword }
                                |> Button.withStyleSecondary
                                |> Button.view

                          else
                            Button.new { label = "Редагувати", onClick = ToggleEditPassword }
                                |> Button.withStyleSecondary
                                |> Button.view
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
                                    (Utils.Select.defaultOptions (isDarkMode shared.themeMode))
                        ]
                    , viewFormErrors Roles editState.fieldsErrors
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Організм" ]
                    , div [ class "w-full" ]
                        [ Html.map EditOrganismSelMsg <|
                            Styled.toUnstyled <|
                                Utils.Select.renderSelectSingle
                                    organismSelectedItem
                                    editState.inpOrganism.selectState
                                    editState.inpOrganism.items
                                    "організм"
                                    (Utils.Select.defaultOptions (isDarkMode shared.themeMode))
                        ]
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Напрямок" ]
                    , div [ class "w-full" ]
                        [ Html.map EditZoneSelMsg <|
                            Styled.toUnstyled <|
                                Utils.Select.renderSelectSingle
                                    zoneSelectedItem
                                    editState.inpZone.selectState
                                    editState.inpZone.items
                                    "зона"
                                    (Utils.Select.defaultOptions (isDarkMode shared.themeMode))
                        ]
                    , viewFormErrors Zone editState.fieldsErrors
                    ]
                , div [ class "flex items-center" ]
                    [ Checkbox.new { isChecked = editState.inpDeleted, onToggle = \_ -> EditDeletedMsg }
                        |> Checkbox.withContent [ text "Видалити користувача" ]
                        |> Checkbox.view
                    ]
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = EditLoginCancel }
                    |> Button.withStyleSecondary
                    |> Button.view
                , Button.new { label = "Зберегти", onClick = EditLoginSave }
                    |> Button.view
                ]
            ]
        ]
    ]



-- TABLE CONFIGURATION


usersTableConfig : Shared.Model -> Model -> Table.Config B.Login Msg
usersTableConfig shared model =
    let
        featureDelta =
            case shared.serverInfo of
                Just info ->
                    info.featureDelta

                Nothing ->
                    False

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

        customizations =
            { defaultCustomizations
                | tableAttrs = [ class "base-table" ]
                , thead = customThead
            }

        -- Base columns that are always present
        baseColumns =
            [ Table.stringColumn "Логін" .login |> Table.withColumnWidth "15%"
            , Table.veryCustomColumn
                { name = "Ролі"
                , viewData =
                    \login ->
                        { attributes = []
                        , children =
                            [ div [ class "flex flex-wrap gap-1" ]
                                (login.roles
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
                , sorter = Table.increasingOrDecreasingBy (\login -> String.join ", " login.roles)
                }
                |> Table.withColumnWidth "19%"
            , Table.customColumn
                { name = "Організм"
                , viewData = \login -> Maybe.withDefault "-" login.organismName
                , sorter = Table.increasingOrDecreasingBy (\login -> Maybe.withDefault "-" login.organismName)
                }
                |> Table.withColumnWidth "15%"
            , Table.customColumn
                { name = "Напрямок"
                , viewData = \login -> Maybe.withDefault "-" login.sigintZoneName
                , sorter = Table.increasingOrDecreasingBy (\login -> Maybe.withDefault "-" login.sigintZoneName)
                }
                |> Table.withColumnWidth "15%"
            , Table.customColumn
                { name = "Створено"
                , viewData = \login -> Utils.Time.renderDateF5FromMillis login.createdAt shared.timeZone
                , sorter = Table.increasingOrDecreasingBy (\login -> String.fromInt login.createdAt)
                }
                |> Table.withColumnWidth "12%"
            , Table.veryCustomColumn
                { name = "Статус"
                , viewData =
                    \login ->
                        { attributes = [ class "text-center" ]
                        , children = [ viewDeletedStatus shared.timeZone login ]
                        }
                , sorter =
                    Table.increasingOrDecreasingBy
                        (\login ->
                            String.fromInt
                                (if login.deleted then
                                    0

                                 else
                                    1
                                )
                        )
                }
                |> Table.withColumnWidth "10%"
            , Table.veryCustomColumn
                { name = ""
                , viewData =
                    \login ->
                        { attributes = [ class "col-narrow" ]
                        , children =
                            [ button
                                [ class "table-action-btn"
                                , type_ "button"
                                , onClick <| EditLogin login.login
                                ]
                                [ i [ class "bi bi-pencil-square" ] []
                                ]
                            ]
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "5%"
            ]

        -- Add delta login column if feature is enabled
        deltaColumn =
            if featureDelta then
                [ Table.stringColumn "Дельта логін" (\login -> Maybe.withDefault "" login.deltaLogin) |> Table.withColumnWidth "10%" ]

            else
                []
    in
    Table.customConfig
        { toId = .login
        , toMsg = SetTableState
        , columns = deltaColumn ++ baseColumns
        , customizations = customizations
        }
