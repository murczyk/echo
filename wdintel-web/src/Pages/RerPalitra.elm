module Pages.RerPalitra exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Core.Auth
import Core.Types exposing (ApiError)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events  exposing (onInput, on, targetValue)
import Json.Decode as Decode
import Layouts
import Page exposing (Page)
import Platform.Sub as Sub
import Route exposing (Route)
import Shared
import Shared.Components.Badge as Badge
import Shared.Components.Button as Button
import Shared.Components.Sidebar as Sidebar
import Shared.Components.Spinner
import Shared.Components.Table as Table
import Shared.Components.Table.Sorter as Sorter
import Shared.Components.SegmentedControl as SegmentedControl
import Utils.RemoteData exposing (RemoteData(..))
import View exposing (View)
import String


type alias Model =
    { palitras : RemoteData ApiError (List B.Palitra)
    , tableState : Table.State
    , deleting : Maybe Int
    , form : Form
    , submitInFlight : Bool
    , showCreateSidebar : Bool
    , myOrganism : RemoteData ApiError (Maybe B.MyOrganism)
    }


type alias Form =
    { name : String
    , colorHex : String
    , access : AccessForm
    , fileName : String
    }

type AccessForm
    = LoginsAccess String
    | OrganismsAccess String
    | AorAccess String


normalizeAccessForm : AccessForm -> AccessForm
normalizeAccessForm access =
    case access of
        LoginsAccess _ ->
            LoginsAccess ""

        OrganismsAccess _ ->
            OrganismsAccess ""

        AorAccess _ ->
            AorAccess ""


type Msg
    = NoOp
    | PalitraListResp (Result ApiError (List B.Palitra))
    | TableStateChanged Table.State
    | DeleteRequested Int
    | DeleteResponse Int (Result ApiError ())
    | UpdateForm (Form -> Form)
    | ChangeAccess AccessForm
    | ShowCreateSidebar
    | CloseCreateSidebar
    | SubmitCreate
    | CreateResponse (Result ApiError B.Palitra)
    | MyOrganismResp (Result ApiError (Maybe B.MyOrganism))


init : () -> ( Model, Effect Msg )
init _ =
    ( { palitras = Loading
      , tableState = Table.initialSort "Назва"
      , deleting = Nothing
      , form = emptyForm
      , submitInFlight = False
      , showCreateSidebar = False
      , myOrganism = NotAsked
      }
    , E.sendCmd <| Api.palitra_list PalitraListResp
    )


emptyForm : Form
emptyForm =
    { name = ""
    , colorHex = "#00bcd4"
    , access = LoginsAccess ""
    , fileName = ""
    }


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        NoOp ->
            ( model, E.none )

        PalitraListResp (Ok list) ->
            ( { model | palitras = Success list }, E.none )

        PalitraListResp (Err err) ->
            ( { model | palitras = Failure err }, E.none )

        TableStateChanged state ->
            ( { model | tableState = state }, E.none )

        DeleteRequested palitraId ->
            ( { model | deleting = Just palitraId }
            , E.sendCmd <| Api.palitra_delete (DeleteResponse palitraId) palitraId
            )

        DeleteResponse palitraId (Ok _) ->
            case model.palitras of
                Success list ->
                    ( { model
                        | palitras = Success <| List.filter (\p -> p.id /= palitraId) list
                        , deleting = Nothing
                      }
                    , E.none
                    )

                _ ->
                    ( { model | deleting = Nothing }, E.none )

        DeleteResponse _ (Err _) ->
            ( { model | deleting = Nothing }, E.none )

        UpdateForm fn ->
            ( { model | form = fn model.form }, E.none )

        ChangeAccess access ->
            let
                form =
                    model.form

                form1 =
                    { form | access = access }
            in
            ( { model | form = form1 }, E.none )

        ShowCreateSidebar ->
            -- Завантажуємо організм користувача, якщо ще не завантажено
            if model.myOrganism == NotAsked then
                ( { model | showCreateSidebar = True, myOrganism = Loading }
                , E.sendCmd <| Api.my_organism MyOrganismResp
                )
            else
                ( { model | showCreateSidebar = True }, E.none )

        MyOrganismResp (Ok organism) ->
            ( { model | myOrganism = Success organism }, E.none )

        MyOrganismResp (Err err) ->
            ( { model | myOrganism = Failure err }, E.none )

        CloseCreateSidebar ->
            ( { model | showCreateSidebar = False, form = emptyForm }, E.none )

        SubmitCreate ->
            let
                validationError =
                    validateForm model.form
            in
            if validationError == Nothing then
                let
                    req =
                        buildCreateReq model.form
                in
                ( { model | submitInFlight = True }
                , E.sendCmd <| Api.palitra_create CreateResponse req
                )

            else
                ( model, E.none )

        CreateResponse (Ok p) ->
            let
                newList =
                    case model.palitras of
                        Success list ->
                            Success (p :: list)

                        _ ->
                            Success [ p ]
            in
            ( { model
                | palitras = newList
                , form = emptyForm
                , submitInFlight = False
                , showCreateSidebar = False
              }
            , E.none
            )

        CreateResponse (Err _) ->
            ( { model | submitInFlight = False }, E.none )


view : Auth.User -> Shared.Model -> Model -> View Msg
view user _ model =
    { title = "палітри"
    , body =
        [ div
            [ classList [ ( "overflow-hidden", model.showCreateSidebar ) ]
            , class "w-5/6 mx-auto"
            ]
            [ Sidebar.view model.showCreateSidebar CloseCreateSidebar (createPalitraSidebarContent user model)
            , case model.palitras of
                Loading ->
                    div [ class "p-4" ] [ Shared.Components.Spinner.loadingSpinner2Sm ]

                Failure _ ->
                    div [ class "p-4 text-red-600" ] [ text "Не вдалося завантажити палітри" ]

                Success pal ->
                    div []
                        [ div []
                            [ h1 [ class "py-4 text-2xl font-bold text-foreground" ] [ text "Палітри" ]
                            , div [ class "mb-4 flex justify-end" ]
                                [ Button.new { label = "Додати палітру", onClick = ShowCreateSidebar }
                                    |> Button.view
                                ]
                            , div [ class "table-responsive-modern" ] [ renderTable user model pal ]
                            ]
                        ]

                NeedsReload _ ->
                    text ""

                NotAsked ->
                    text ""
            ]
        ]
    }


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared _ =
    Page.new
        { init = init
        , update = update
        , view = view user shared
        , subscriptions = \_ -> Sub.none
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "etalonka"
        }


renderTable : Auth.User -> Model -> List B.Palitra -> Html Msg
renderTable user model palitras =
    let
        canDelete palitra =
            Core.Auth.hasRole "Admin" user
                || Core.Auth.hasRole "UnitsEditor" user
                || Core.Auth.hasRole "CallsignsEditor" user
                || (Maybe.withDefault "" palitra.author == user.name)

        defaultCustomizations =
            Table.defaultCustomizations

        customizations =
            { defaultCustomizations
                | tableAttrs = [ class "base-table" ]
            }

        tableConfig : Table.Config B.Palitra Msg
        tableConfig =
            Table.customConfig
                { toId = .id >> String.fromInt
                , toMsg = TableStateChanged
                , customizations = customizations
                , columns =
                    [ Table.stringColumn "Назва" .name
                    , Table.veryCustomColumn
                        { name = "Колір"
                        , viewData =
                            \p ->
                                { attributes = [ class "col-narrow" ]
                                , children =
                                    [ span
                                        [ class "inline-block w-6 h-6 rounded"
                                        , style "background" p.colorHex
                                        , style "display" "inline-block"
                                        ]
                                        []
                                    ]
                                }
                        , sorter = Sorter.increasingOrDecreasingBy .colorHex
                        }
                    , Table.stringColumn "Файл" (\p -> Maybe.withDefault "—" p.sourceFileName)
                    , Table.stringColumn "Автор" (\p -> Maybe.withDefault "—" p.author)
                    , Table.stringColumn "Доступ" renderAccess
                    , Table.veryCustomColumn
                        { name = "Дія"
                        , viewData =
                            \p ->
                                let
                                    isDeleting =
                                        model.deleting == Just p.id
                                in
                                { attributes = [ class "col-narrow flex gap-2 items-center" ]
                                , children =
                                    if canDelete p then
                                        [ Button.view
                                            (Button.new
                                                { label = "Видалити"
                                                , onClick =
                                                    if isDeleting then
                                                        NoOp

                                                    else
                                                        DeleteRequested p.id
                                                }
                                                |> Button.withStyleDanger
                                                |> Button.withDisabled isDeleting
                                            )
                                        , if isDeleting then
                                            Shared.Components.Spinner.loadingSpinner2Sm

                                          else
                                            text ""
                                        ]

                                    else
                                        [ text "" ]
                                }
                        , sorter = Sorter.unsortable
                        }
                    ]
                }
    in
    Table.view tableConfig model.tableState palitras


renderAccess : B.Palitra -> String
renderAccess p =
    if not (List.isEmpty p.accessLogins) then
        "за логінами"

    else if not (List.isEmpty p.accessOrganismIds) then
        "за підрозділами"

    else if not (List.isEmpty p.accessAorId) then
        "за смугами"

    else
        "без доступу"


-- Визначає, чи користувач має привілейовані ролі (UnitsEditor/CallsignsEditor/Admin)
hasPrivilegedRole : Auth.User -> Bool
hasPrivilegedRole user =
    Core.Auth.hasRole "Admin" user
        || Core.Auth.hasRole "UnitsEditor" user
        || Core.Auth.hasRole "CallsignsEditor" user


-- Визначає, чи користувач є Rer
isRer : Auth.User -> Bool
isRer user =
    Core.Auth.hasRole "Rer" user


-- Визначає доступні типи доступу для користувача
getAvailableAccessTypes : Auth.User -> List AccessForm
getAvailableAccessTypes user =
    let
        privileged =
            hasPrivilegedRole user
    in
    List.filterMap identity
        [ Just (LoginsAccess "")
        , Just (OrganismsAccess "")
        , if privileged then
            Just (AorAccess "")

          else
            Nothing
        ]


-- Визначає, чи опція доступу обмежена для користувача
isAccessRestricted : Auth.User -> AccessForm -> Bool
isAccessRestricted user access =
    let
        privileged =
            hasPrivilegedRole user

        rer =
            isRer user
    in
    case access of
        LoginsAccess _ ->
            not privileged && rer

        OrganismsAccess _ ->
            not privileged && rer

        AorAccess _ ->
            not privileged


-- Отримує підказку для типу доступу
getAccessHint : Auth.User -> AccessForm -> Maybe String
getAccessHint user access =
    if isAccessRestricted user access then
        case access of
            LoginsAccess _ ->
                Just "Тільки ваш логін"

            OrganismsAccess _ ->
                Just "Тільки ваші підрозділи"

            _ ->
                Nothing

    else
        Nothing


-- Валідація форми перед відправкою
validateForm : Form -> Maybe String
validateForm form =
    if String.isEmpty form.name then
        Just "Назва палітри обов'язкова"

    else
        Nothing


createPalitraSidebarContent : Auth.User -> Model -> List (Html Msg)
createPalitraSidebarContent user model =
    let
        availableAccessTypes =
            getAvailableAccessTypes user

        ( accessFields, accessHint ) =
            case model.form.access of
                LoginsAccess logins ->
                    let
                        loginRestricted =
                            isAccessRestricted user (LoginsAccess "")

                        currentLogins =
                            if loginRestricted && String.isEmpty logins then
                                user.name

                            else
                                logins

                        loginField =
                            if loginRestricted then
                                div
                                    [ class "w-full px-3 py-2 border border-dashed border-border rounded-md bg-muted/40 text-foreground flex items-center justify-between" ]
                                    [ span [] [ text user.name ]
                                    , span [ class "text-xs text-muted-foreground" ] [ text "Автоматично" ]
                                    ]

                            else
                                input
                                    [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                                    , type_ "text"
                                    , placeholder "Логіни через кому"
                                    , value currentLogins
                                    , onInput (\v -> UpdateForm (\f -> { f | access = LoginsAccess v }))
                                    ]
                                    []

                        loginNote =
                            if loginRestricted then
                                div [ class "text-xs text-muted-foreground" ] [ text "Роль Rer може надати доступ лише власному логіну" ]

                            else
                                text ""
                    in
                    ( [ div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ]
                                [ text
                                    (if loginRestricted then
                                        "Ваш логін"

                                     else
                                        "Логіни (через кому)"
                                    )
                                ]
                            , loginField
                            , loginNote
                            ]
                      ]
                    , getAccessHint user (LoginsAccess "")
                    )

                OrganismsAccess ids ->
                    let
                        organismRestricted =
                            isAccessRestricted user (OrganismsAccess "")

                        isEditor =
                            Core.Auth.hasRole "UnitsEditor" user || Core.Auth.hasRole "CallsignsEditor" user

                        restrictionHint =
                            if isEditor then
                                "Редактор може надати доступ лише власному підрозділу"
                            else
                                "Роль Rer може надати доступ лише власному підрозділу"

                        organismField =
                            if organismRestricted then
                                case model.myOrganism of
                                    Success (Just organism) ->
                                        div [ class "flex flex-col gap-2" ]
                                            [ div [ class "text-xs text-muted-foreground uppercase" ] [ text "Ваш підрозділ" ]
                                            , Badge.view organism.name
                                            , div [ class "text-xs text-muted-foreground" ] [ text restrictionHint ]
                                            ]

                                    Success Nothing ->
                                        div [ class "text-xs text-red-500" ]
                                            [ text "Вашому логіну не призначено підрозділ. Зверніться до адміністратора." ]

                                    Loading ->
                                        div [ class "flex flex-col gap-2" ]
                                            [ div [ class "text-xs text-muted-foreground uppercase" ] [ text "Ваш підрозділ" ]
                                            , Shared.Components.Spinner.loadingSpinner2Sm
                                            ]

                                    _ ->
                                        div [ class "text-xs text-muted-foreground" ]
                                            [ text "Завантаження..." ]

                            else
                                input
                                    [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                                    , type_ "text"
                                    , placeholder "ID підрозділів через кому"
                                    , value ids
                                    , onInput (\v -> UpdateForm (\f -> { f | access = OrganismsAccess v }))
                                    ]
                                    []
                    in
                    ( [ div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Підрозділи" ]
                            , organismField
                            ]
                      ]
                    , getAccessHint user (OrganismsAccess "")
                    )

                AorAccess ids ->
                    ( [ div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "AOR IDs (через кому)" ]
                            , input
                                [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                                , type_ "text"
                                , placeholder "ID смуг через кому"
                                , value ids
                                , onInput (\v -> UpdateForm (\f -> { f | access = AorAccess v }))
                                ]
                                []
                            ]
                      ]
                    , getAccessHint user (AorAccess "")
                    )

        accessOptions =
            List.filterMap
                (\accessType ->
                    let
                        normalized =
                            normalizeAccessForm accessType
                    in
                    case normalized of
                        LoginsAccess _ ->
                            Just { value = normalized, label = "Логіни" }

                        OrganismsAccess _ ->
                            Just { value = normalized, label = "Підрозділи" }

                        AorAccess _ ->
                            Just { value = normalized, label = "Смуги" }
                )
                availableAccessTypes
        accessSegmentOnChange accessForm =
            case accessForm of
                LoginsAccess _ ->
                    let
                        restrictedLogin =
                            isAccessRestricted user (LoginsAccess "")
                    in
                    if restrictedLogin then
                        ChangeAccess (LoginsAccess user.name)

                    else
                        ChangeAccess accessForm

                OrganismsAccess _ ->
                    let
                        restrictedOrganism =
                            isAccessRestricted user (OrganismsAccess "")

                        userOrganismValue =
                            user.organismId |> Maybe.map String.fromInt
                    in
                    if restrictedOrganism then
                        case userOrganismValue of
                            Just value ->
                                ChangeAccess (OrganismsAccess value)

                            Nothing ->
                                ChangeAccess accessForm

                    else
                        ChangeAccess accessForm

                _ ->
                    ChangeAccess accessForm
    in
    [ div [ class "flex flex-col h-full" ]
        [ div [ class "p-6 border-b border-border" ]
            [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Створити палітру" ]
            ]
        , div [ class "flex-1 overflow-y-auto p-6" ]
            [ div [ class "space-y-6" ]
                [ div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Назва *" ]
                    , input
                        [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                        , type_ "text"
                        , placeholder "Назва палітри"
                        , value model.form.name
                        , onInput (\v -> UpdateForm (\f -> { f | name = v }))
                        ]
                        []
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Колір" ]
                    , input
                        [ type_ "color"
                        , class "w-16 h-10 border border-border rounded-md"
                        , value model.form.colorHex
                        , on "change" (Decode.map (\v -> UpdateForm (\f -> { f | colorHex = v })) targetValue)
                        ]
                        []
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Назва файлу (опціонально)" ]
                    , input
                        [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                        , type_ "text"
                        , placeholder "Назва файлу"
                        , value model.form.fileName
                        , onInput (\v -> UpdateForm (\f -> { f | fileName = v }))
                        ]
                        []
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Доступ" ]
                    , div [ class "flex flex-wrap gap-2" ]
                        [ SegmentedControl.new
                            (normalizeAccessForm model.form.access)
                            accessSegmentOnChange
                            accessOptions
                            |> SegmentedControl.view
                        ]
                    , case accessHint of
                        Just hint ->
                            div [ class "text-xs text-muted-foreground mt-1" ] [ text hint ]

                        Nothing ->
                            text ""
                    , div [] accessFields
                    ]
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseCreateSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , Button.new
                    { label = "Створити"
                    , onClick =
                        if model.submitInFlight then
                            NoOp

                        else
                            SubmitCreate
                    }
                    |> Button.withDisabled model.submitInFlight
                    |> Button.view
                ]
            ]
        ]
    ]




buildCreateReq : Form -> B.CreatePalitraReq
buildCreateReq form =
    { name = form.name
    , colorHex = form.colorHex
    , access = accessToBinding form.access
    , sourceFileName =
        if String.isEmpty form.fileName then
            Nothing

        else
            Just form.fileName
    , lastUploadedAtTs = Nothing
    }


accessToBinding : AccessForm -> B.PalitraAccess
accessToBinding accessForm =
    case accessForm of
        LoginsAccess logins ->
            let
                items =
                    logins
                        |> String.split ","
                        |> List.map String.trim
                        |> List.filter (\s -> s /= "")
            in
            B.ByLogins { logins = items }

        OrganismsAccess ids ->
            let
                items =
                    ids
                        |> String.split ","
                        |> List.filter (\s -> s /= "")
                        |> List.filterMap String.toInt
            in
            B.ByOrganisms { organismIds = items }

        AorAccess ids ->
            let
                items =
                    ids
                        |> String.split ","
                        |> List.filter (\s -> s /= "")
                        |> List.filterMap String.toInt
            in
            B.ByAor { aorIds = items }
