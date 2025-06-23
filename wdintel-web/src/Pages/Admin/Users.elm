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
    , showActiveOnly : Bool
    , addDeltaLogin : Bool
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
    [ "Admin", "Api", "Rer", "Bpla", "Full", "Basic", "UnitsEditor", "CallsignsEditor", "DeleteMsg" ]


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
      , showActiveOnly = False
      , addDeltaLogin = False
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
    | ToggleActiveOnlyFilter
    | ToggleAddDeltaLogin


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
            ( { model | logins = res.users }, E.none )

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
            in
            ( { model | organisms = res, inpOrganism = inpOrganism2 }, E.none )

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

        ToggleActiveOnlyFilter ->
            ( { model | showActiveOnly = not model.showActiveOnly }, E.none )

        ToggleAddDeltaLogin ->
            ( { model | addDeltaLogin = not model.addDeltaLogin }, E.none )


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


view : Auth.User -> Shared.Model -> Model -> View Msg
view user shared model =
    { title = "Адмін: користувачі"
    , body = body user shared model
    }


body : Auth.User -> Shared.Model -> Model -> List (Html Msg)
body user shared model =
    [ Views.noHeaderAndContent ToastMsg model.toasts <|
        div [ class "flex rer-networks" ]
            [ div [ class "grow px-[32px] py-[16px] overflow-auto", style "height" "calc(-50px + 100vh)" ]
                [ h1 [ class "mb-[16px]!" ]
                    [ div [ class "flex justify-between items-center" ]
                        [ div [ class "flex items-center mr-auto" ]
                            [ span [ class "mr-2" ] [ text "Користувачі" ]
                            ]
                        ]
                    ]
                , mainBlock shared model
                ]
            ]
    ]


mainBlock : Shared.Model -> Model -> Html Msg
mainBlock shared model =
    let
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
                    model.inpOrganism.selectedItem
                        |> Maybe.andThen (\itemId -> ListX.find (\x -> x.id == itemId) model.organisms)
                        |> Maybe.map
                            (\item ->
                                Select.basicMenuItem { item = item.id, label = item.name }
                            )

                zoneSelectedItem =
                    model.inpZone.selectedItem
                        |> Maybe.andThen (\itemId -> ListX.find (\( id, _ ) -> id == itemId) model.zones)
                        |> Maybe.map (\( id, item ) -> Select.basicMenuItem { item = id, label = item.name })
            in
            div [ class "border mb-4 p-2", style "background-color" "var(--bs-tertiary-bg)" ]
                [ if featureDelta then
                    div [ class "mr-2" ]
                        [ Checkbox.new { isChecked = model.addDeltaLogin, onToggle = (\_ -> ToggleAddDeltaLogin) }
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
                        , viewFormErrors Login model.fieldsErrors
                        ]
                    , div [ class "flex-1" ]
                        [ input
                            [ class "border border-gray-300 rounded px-3 py-2 w-full"
                            , type_ "text"
                            , placeholder "Пароль"
                            , onInput <| SetPassword
                            , value addState.inpPassword
                            , disabled model.addDeltaLogin
                            ]
                            []
                        , viewFormErrors Password model.fieldsErrors
                        ]
                    , div [ class "flex-1" ]
                        [ div [ class "flex justify-between items-center text-[0.8rem]" ]
                            [ div [ class "flex-grow-1" ]
                                [ Html.map AddRoleSelMsg <|
                                    Styled.toUnstyled <|
                                        Le.Block.Select.renderSelect
                                            (model.inpRole.selectedItems |> List.map (\x -> Select.basicMenuItem { item = x, label = x }))
                                            model.inpRole.selectState
                                            model.inpRole.items
                                            "роль"
                                            (Le.Block.Select.defaultOptions shared.isDarkMode)
                                ]
                            ]
                        , viewFormErrors Roles model.fieldsErrors
                        ]
                    , div [ class "flex-1" ]
                        [ div [ class "flex justify-between items-center text-[0.8rem]" ]
                            [ div [ class "flex-grow-1" ]
                                [ Html.map AddZoneSelMsg <|
                                    Styled.toUnstyled <|
                                        Le.Block.Select.renderSelectSingle
                                            zoneSelectedItem
                                            model.inpZone.selectState
                                            model.inpZone.items
                                            "зона"
                                            (Le.Block.Select.defaultOptions shared.isDarkMode)
                                ]
                            ]
                        , viewFormErrors Zone model.fieldsErrors
                        ]
                    , div [ class "flex justify-between items-center text-[0.8rem] flex-1" ]
                        [ div [ class "flex-grow-1" ]
                            [ Html.map AddOrganismSelMsg <|
                                Styled.toUnstyled <|
                                    Le.Block.Select.renderSelectSingle
                                        organismSelectedItem
                                        model.inpOrganism.selectState
                                        model.inpOrganism.items
                                        "організм"
                                        (Le.Block.Select.defaultOptions shared.isDarkMode)
                            ]
                        ]
                    , div [ class "text-center" ]
                        [ Button.new { label = "Додати", onClick = (if model.addDeltaLogin then AddLoginDelta else AddLogin) } |> Button.view ]
                    ]
                ]

        viewLoginEditable : LoginEdit -> B.Login -> Html Msg
        viewLoginEditable editState login =
            let
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
                [ td [] [ text login.login ]
                , if featureDelta then
                    td []
                        [ input
                            [ class "border border-gray-300 rounded px-3 py-2 w-full"
                            , type_ "text"
                            , placeholder "Дельта Логін"
                            , onInput <| SetEditDeltaLogin
                            , value <| Maybe.withDefault "" editState.deltaLogin
                            ]
                            []
                        ]

                  else
                    text ""
                , td [ class "align-middle" ]
                    [ if editState.doChangePassword then
                        div []
                            [ div [ class "flex items-center" ]
                                [ input
                                    [ class "border border-gray-300 rounded px-3 py-2 w-full"
                                    , type_ "text"
                                    , placeholder "Пароль"
                                    , onInput <| SetEditPassword
                                    , value <| Maybe.withDefault "" editState.inpPassword
                                    ]
                                    []
                                , Button.new { label = "", onClick = ToggleEditPassword }
                                    |> Button.withIcon [ i [ class "bi bi-x" ] [] ]
                                    |> Button.withStyleSecondary
                                    |> Button.view
                                ]
                            ]
                      else
                        i [ class "bi bi-pen cursor-pointer", onClick ToggleEditPassword ] []
                    ]
                , td []
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
                , td [ class "flex justify-between items-center min-w-[200px] text-[0.8rem]" ]
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
                , td []
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
                , td [] [ text <| Le.Time.renderDateF5FromMillis login.createdAt model.timeZone ]
                , td [ class "text-center align-middle" ] 
                    [ div [ class "flex flex-col items-center" ]
                        [ viewDeletedStatus model.timeZone login
                        , div [ class "mt-1" ]
                            [ Checkbox.new { isChecked = editState.inpDeleted, onToggle = (\_ -> EditDeletedMsg) }
                                |> Checkbox.withContent [ span [ class "ml-1 text-xs" ] [ text "Видалити" ] ]
                                |> Checkbox.view
                            ]
                        ]
                    ]
                , td []
                    [ div [ class "flex justify-start items-center" ]
                        [ Button.new { label = "", onClick = EditLoginSave }
                            |> Button.withIcon [ i [ class "bi bi-check2" ] [] ]
                            |> Button.view
                        , Button.new { label = "", onClick = EditLoginCancel }
                            |> Button.withIcon [ i [ class "bi bi-x" ] [] ]
                            |> Button.withStyleSecondary
                            |> Button.view
                        ]
                    ]
                ]

        viewLoginReadonly : Maybe Time.Zone -> B.Login -> Html Msg
        viewLoginReadonly timeZone login =
            tr []
                [ td [] [ span [] [ text login.login ] ]
                , if featureDelta then
                    td [] [ span [] [ text <| Maybe.withDefault "" login.deltaLogin ] ]

                  else
                    text ""
                , td [] [ text "********" ]
                , td [] (List.map (\role -> span [] [ text <| role ++ "  " ]) login.roles)
                , td []
                    [ span [] [ text <| Maybe.withDefault "-" login.organismName ]
                    ]
                , td [] [ text <| Maybe.withDefault "-" login.sigintZoneName ]
                , td [] [ text <| Le.Time.renderDateF5FromMillis login.createdAt timeZone ]
                , td [ class "text-center align-middle" ]
                    [ viewDeletedStatus timeZone login ]
                , td []
                    [ Button.new { label = "", onClick = EditLogin login.login }
                        |> Button.withIcon [ i [ class "bi bi-pencil-square" ] [] ]
                        |> Button.withOutlined True
                        |> Button.view
                    ]
                ]

        rows =
            if model.showActiveOnly then
                model.logins |> List.filter (\login -> Maybe.withDefault False login.organismEnabled && not login.deleted)

            else
                model.logins
    in
    div []
        [ addLoginPanel model
        , div [ class "mb-1 float-right" ]
            [ Checkbox.new { isChecked = model.showActiveOnly, onToggle = (\_ -> ToggleActiveOnlyFilter) }
                |> Checkbox.withContent [ span [] [ text "лише активні" ] ]
                |> Checkbox.view
            ]
        , table [ class "table-fixed w-full text-[0.85rem] text-center" ]
            [ thead [ class "" ]
                [ tr [ class "" ]
                    [ th [ scope "col", class "w-[15%]" ] [ text "Логін" ]
                    , if featureDelta then
                        th [ scope "col", class "w-[12%]" ] [ text "Дельта логін" ]
                      else
                        text ""
                    , th [ scope "col", class "w-[10%]" ] [ text "Пароль" ]
                    , th [ scope "col", class "w-[15%]" ] [ text "Ролі" ]
                    , th [ scope "col", class "w-[12%]" ] [ text "Організм" ]
                    , th [ scope "col", class "w-[12%]" ] [ text "Зона" ]
                    , th [ scope "col", class "w-[12%]" ] [ text "Створено" ]
                    , th [ scope "col", class "w-[12%]" ] [ text "Статус" ]
                    , th [ scope "col", class "w-[12%]" ] [ text "" ]
                    ]
                ]
            , tbody [] <|
                List.map
                    (\l ->
                        case model.editLogin of
                            Just ( login_, editState ) ->
                                if login_ == l.login then
                                    viewLoginEditable editState l

                                else
                                    viewLoginReadonly model.timeZone l

                            Nothing ->
                                viewLoginReadonly model.timeZone l
                    )
                    rows
            ]
        ]
