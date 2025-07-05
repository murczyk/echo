module Pages.Admin.Users exposing (FieldError, FormField, LoginEdit, Model, Msg, page)

import Api
import Auth
import Bindings as B
import Components.Button as Button
import Components.Checkbox as Checkbox
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Html.Extra as HtmlX
import Html.Keyed
import Html.Styled as Styled exposing (fromUnstyled)
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
import Shared
import Task
import Time
import TimeZone
import Validate
import View exposing (View)
import Views


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
    , toasts : Le.Block.Toast.Model
    , timeZone : Maybe Time.Zone
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
      , toasts = Le.Block.Toast.init
      , timeZone = Nothing
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
      }
    , E.sendCmd <|
        Cmd.batch
            [ Api.list_logins GotLogins { sortBy = Just B.LoginCreatedAtDesc }
            , Api.sigint_zones_list GotZoneList
            , Api.list_organisms GotOrganisms { sortBy = Nothing }
            , Task.attempt GotTimeZone Le.Time.getZone
            ]
    )


type Msg
    = ToastMsg Le.Block.Toast.Msg
    | GotLogins (Result ApiError B.ListLoginsRsp)
    | GotZoneList (Result ApiError (List ( Int, B.SigintZone )))
    | GotOrganisms (Result ApiError (List B.Organism))
    | GotTimeZone (Result TimeZone.Error ( String, Time.Zone ))
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
        ToastMsg imsg ->
            let
                ( im, icmds ) =
                    Le.Block.Toast.update imsg model.toasts
            in
            ( { model | toasts = im }
            , E.sendCmd <| Cmd.map ToastMsg icmds
            )

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
            Api.handleHttpError ToastMsg err model

        GotZoneList (Err e) ->
            Api.handleHttpError ToastMsg e model

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
            Api.handleHttpError ToastMsg e model

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

        GotTimeZone (Err e) ->
            ( model
            , E.sendCmd <|
                Le.Block.Toast.addError
                    ToastMsg
                    ("Error getting timezone: " ++ renderZoneError e)
            )

        GotTimeZone (Ok ( _, zone )) ->
            ( { model | timeZone = Just zone }
            , E.none
            )

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
            Api.handleHttpError ToastMsg e model

        AddZoneSelMsg selMsg ->
            let
                ( mAction, iState, iCmd ) =
                    Select.update selMsg model.inpZone.selectState

                inpZone =
                    model.inpZone

                inpZone2 =
                    { inpZone | selectedItem = Le.Block.Select.singleUpd mAction inpZone.selectedItem, selectState = iState }
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
                    { inpOrganism | selectedItem = Le.Block.Select.singleUpd mAction inpOrganism.selectedItem, selectState = iState }
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
                    { inpRole | selectedItems = Le.Block.Select.multiUpdS mAction inpRole.selectedItems, selectState = iState }
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
                            { inpZone | selectedItem = Le.Block.Select.singleUpd mAction inpZone.selectedItem, selectState = iState }

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
                            { inpOrganism | selectedItem = Le.Block.Select.singleUpd mAction inpOrganism.selectedItem, selectState = iState }

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
                            { inpRole | selectedItems = Le.Block.Select.multiUpdS mAction inpRole.selectedItems, selectState = iState }

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
            ( { model | editLogin = login }, E.none )

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
                                    , roles = Le.Utils.emptyToNothing editLogin.inpRole.selectedItems
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
            ( { model | editLogin = Nothing }, E.none )

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
                        , logins = logins
                    }
            in
            ( m2, E.none )

        EditLoginDone (Err e) ->
            Api.handleHttpError ToastMsg e model

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
                    Le.Block.Select.multiUpdI mAction model.filterOrganismSelect.selectedItems

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
                    Le.Block.Select.singleUpd mAction model.filterStatusSelect.selectedItem

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
                    Le.Block.Select.multiUpdS mAction model.filterRoleSelect.selectedItems

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


viewDeletedStatus : Maybe Time.Zone -> B.Login -> Html msg
viewDeletedStatus timeZone login =
    if login.deleted then
        case login.deactivationReason of
            Just B.Admin ->
                div [ class "flex flex-col items-center" ]
                    [ i [ class "bi bi-person-x-fill text-red-500 text-xl" ] []
                    , span [ class "text-red-500 text-xs" ] [ text "Адмін" ]
                    ]

            Just B.Inactive ->
                div [ class "flex flex-col items-center" ]
                    [ i [ class "bi bi-clock-history text-yellow-500 text-xl" ] []
                    , span [ class "text-yellow-500 text-xs" ] [ text "Неактивний" ]
                    , case login.lastActiveAt of
                        Just lastActive ->
                            span [ class "text-gray-500 text-xs" ]
                                [ text <| "Останній: " ++ Le.Time.renderDateF5FromMillis lastActive timeZone ]

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
        div [ class "flex flex-col items-center" ]
            [ i [ class "bi bi-check-circle-fill text-green-500 text-xl" ] []
            , span [ class "text-green-500 text-xs" ] [ text "Активний" ]
            ]


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none



-- Dynamic filter helper functions


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
        [ Le.Block.Toast.view ToastMsg model.toasts <|
            div [ class "w-[80%] mx-auto px-4 py-8 rer-networks" ]
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
                                                    Le.Block.Select.renderSelect
                                                        (addState.inpRole.selectedItems |> List.map (\x -> Select.basicMenuItem { item = x, label = x }))
                                                        addState.inpRole.selectState
                                                        addState.inpRole.items
                                                        "роль"
                                                        (Le.Block.Select.defaultOptions shared.isDarkMode)
                                            ]
                                        ]
                                    , viewFormErrors Roles addState.fieldsErrors
                                    ]
                                , div [ class "flex-1" ]
                                    [ div [ class "flex justify-between items-center text-[0.8rem]" ]
                                        [ div [ class "flex-grow-1" ]
                                            [ Html.map AddZoneSelMsg <|
                                                Styled.toUnstyled <|
                                                    Le.Block.Select.renderSelectSingle
                                                        zoneSelectedItem
                                                        addState.inpZone.selectState
                                                        addState.inpZone.items
                                                        "зона"
                                                        (Le.Block.Select.defaultOptions shared.isDarkMode)
                                            ]
                                        ]
                                    , viewFormErrors Zone addState.fieldsErrors
                                    ]
                                , div [ class "flex justify-between items-center text-[0.8rem] flex-1" ]
                                    [ div [ class "flex-grow-1" ]
                                        [ Html.map AddOrganismSelMsg <|
                                            Styled.toUnstyled <|
                                                Le.Block.Select.renderSelectSingle
                                                    organismSelectedItem
                                                    addState.inpOrganism.selectState
                                                    addState.inpOrganism.items
                                                    "організм"
                                                    (Le.Block.Select.defaultOptions shared.isDarkMode)
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
                                    matchesStatus && matchesOrganism && matchesRole
                                )

                    viewFilterBlock : Html Msg
                    viewFilterBlock =
                        div [ class "mb-4 p-4 style bg-[var(--bs-tertiary-bg)] rounded-lg border" ]
                            [ h5 [ class "mb-2" ] [ text "Фільтри" ]
                            , div [ class "flex gap-4" ]
                                [ div [ class "flex-1" ]
                                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Організм" ]
                                    , Html.map FilterOrganismSelMsg <|
                                        Styled.toUnstyled <|
                                            Le.Block.Select.renderSelect
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
                                                (Le.Block.Select.defaultOptions shared.isDarkMode)
                                    ]
                                , div [ class "flex-1" ]
                                    [ label [ class "block text-sm font-medium  mb-1" ] [ text "Статус" ]
                                    , Html.map FilterStatusSelMsg <|
                                        Styled.toUnstyled <|
                                            Le.Block.Select.renderSelectSingle
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
                                                (Le.Block.Select.defaultOptions shared.isDarkMode)
                                    ]
                                , div [ class "flex-1" ]
                                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Роль" ]
                                    , Html.map FilterRoleSelMsg <|
                                        Styled.toUnstyled <|
                                            Le.Block.Select.renderSelect
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
                                                (Le.Block.Select.defaultOptions shared.isDarkMode)
                                    ]
                                ]
                            ]
                  in
                  div []
                    [ addLoginPanel model
                    , viewFilterBlock
                    , table [ class "table-fixed w-full text-[0.85rem] text-center" ]
                        [ thead [ class "" ]
                            [ tr [ class "" ]
                                [ th [ scope "col", class "w-[12%]" ] [ text "Логін" ]
                                , if featureDelta then
                                    th [ scope "col", class "w-[10%]" ] [ text "Дельта логін" ]

                                  else
                                    text ""
                                , th [ scope "col", class "w-[10%]" ] [ text "Пароль" ]
                                , th [ scope "col", class "w-[19%]" ] [ text "Ролі" ]
                                , th [ scope "col", class "w-[15%]" ] [ text "Організм" ]
                                , th [ scope "col", class "w-[15%]" ] [ text "Зона" ]
                                , th [ scope "col", class "w-[12%]" ] [ text "Створено" ]
                                , th [ scope "col", class "w-[10%]" ] [ text "Статус" ]
                                , th [ scope "col", class "w-[5%]" ] [ text "" ]
                                ]
                            ]
                        , tbody [] <|
                            List.map
                                (\l ->
                                    case model.editLogin of
                                        Just ( login_, editState ) ->
                                            if login_ == l.login then
                                                viewLoginEditable shared model editState l

                                            else
                                                viewLoginReadonly shared model l

                                        Nothing ->
                                            viewLoginReadonly shared model l
                                )
                                rows
                        ]
                    ]
                ]
        ]
    }


viewLoginEditable : Shared.Model -> Model -> LoginEdit -> B.Login -> Html Msg
viewLoginEditable shared model editState login =
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
                |> Maybe.map
                    (\item ->
                        Select.basicMenuItem { item = item.id, label = item.name }
                    )

        zoneSelectedItem =
            editState.inpZone.selectedItem
                |> Maybe.andThen (\itemId -> ListX.find (\( id, _ ) -> id == itemId) model.zones)
                |> Maybe.map (\( id, item ) -> Select.basicMenuItem { item = id, label = item.name })
    in
    tr []
        [ td [ class "break-words" ] [ text login.login ]
        , if featureDelta then
            td [ class "break-words" ]
                [ input
                    [ class "border border-gray-300 rounded px-2 py-1 w-full text-xs"
                    , type_ "text"
                    , placeholder "Дельта Логін"
                    , onInput <| SetEditDeltaLogin
                    , value <| Maybe.withDefault "" editState.deltaLogin
                    ]
                    []
                ]

          else
            text ""
        , td [ class "align-middle break-words" ]
            [ if editState.doChangePassword then
                div []
                    [ div [ class "flex items-center" ]
                        [ input
                            [ class "border border-gray-300 rounded px-2 py-1 w-full text-xs"
                            , type_ "text"
                            , placeholder "Пароль"
                            , onInput <| SetEditPassword
                            , value <| Maybe.withDefault "" editState.inpPassword
                            ]
                            []
                        , i [ class "bi bi-x text-red-500 hover:text-red-600 cursor-pointer text-lg", onClick ToggleEditPassword ] []
                        ]
                    ]

              else
                i [ class "bi bi-pen text-blue-500 hover:text-blue-600 cursor-pointer text-lg", onClick ToggleEditPassword ] []
            ]
        , td [ class "break-words" ]
            [ div [ class "flex justify-between items-center min-w-[200px] text-[0.8rem]" ]
                [ div [ class "flex-grow-1" ]
                    [ Html.map EditRoleSelMsg <|
                        Styled.toUnstyled <|
                            let
                                options =
                                    Le.Block.Select.defaultOptions shared.isDarkMode

                                options2 =
                                    { options | clearable = False }
                            in
                            Le.Block.Select.renderSelect
                                (editState.inpRole.selectedItems |> List.map (\x -> Select.basicMenuItem { item = x, label = x }))
                                editState.inpRole.selectState
                                editState.inpRole.items
                                "роль"
                                options2
                    ]
                ]
            , viewFormErrors Roles editState.fieldsErrors
            ]
        , td [ class "break-words" ]
            [ div [ class "flex justify-between items-center min-w-[200px] text-[0.8rem]" ]
                [ div [ class "flex-grow-1" ]
                    [ Html.map EditOrganismSelMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelectSingle
                                organismSelectedItem
                                editState.inpOrganism.selectState
                                editState.inpOrganism.items
                                "організм"
                                (Le.Block.Select.defaultOptions shared.isDarkMode)
                    ]
                ]
            ]
        , td [ class "break-words" ]
            [ div [ class "flex justify-between items-center min-w-[200px] text-[0.8rem]" ]
                [ div [ class "flex-grow-1" ]
                    [ Html.map EditZoneSelMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelectSingle
                                zoneSelectedItem
                                editState.inpZone.selectState
                                editState.inpZone.items
                                "зона"
                                (Le.Block.Select.defaultOptions shared.isDarkMode)
                    ]
                ]
            , viewFormErrors Zone editState.fieldsErrors
            ]
        , td [ class "break-words" ] [ text <| Le.Time.renderDateF5FromMillis login.createdAt model.timeZone ]
        , td [ class "text-center align-middle" ]
            [ div [ class "mt-1 flex justify-center" ]
                [ Checkbox.new { isChecked = editState.inpDeleted, onToggle = \_ -> EditDeletedMsg }
                    |> Checkbox.withContent [ span [ class "ml-1 text-xs" ] [ text "Видалити" ] ]
                    |> Checkbox.view
                ]
            ]
        , td []
            [ div [ class "flex justify-center items-center gap-2" ]
                [ i [ class "bi bi-check2 text-green-500 hover:text-green-600 cursor-pointer text-lg", onClick EditLoginSave ] []
                , i [ class "bi bi-x text-red-500 hover:text-red-600 cursor-pointer text-lg", onClick EditLoginCancel ] []
                ]
            ]
        ]


viewLoginReadonly : Shared.Model -> Model -> B.Login -> Html Msg
viewLoginReadonly shared model login =
    let
        featureDelta =
            case shared.serverInfo of
                Just info ->
                    info.featureDelta

                Nothing ->
                    False
    in
    tr []
        [ td [ class "break-words" ] [ text login.login ]
        , if featureDelta then
            td [ class "break-words" ] [ span [] [ text <| Maybe.withDefault "" login.deltaLogin ] ]

          else
            text ""
        , td [ class "align-middle break-words" ] [ text "********" ]
        , td [ class "break-words" ] (List.map (\role -> span [] [ text <| role ++ "  " ]) login.roles)
        , td [ class "break-words" ]
            [ span [] [ text <| Maybe.withDefault "-" login.organismName ]
            ]
        , td [ class "break-words" ] [ text <| Maybe.withDefault "-" login.sigintZoneName ]
        , td [ class "break-words" ] [ text <| Le.Time.renderDateF5FromMillis login.createdAt model.timeZone ]
        , td [ class "text-center align-middle" ]
            [ viewDeletedStatus model.timeZone login ]
        , td []
            [ i [ class "bi bi-pencil-square text-action hover:text-blue-600 cursor-pointer text-lg", onClick <| EditLogin login.login ] []
            ]
        ]
