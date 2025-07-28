module Pages.Admin.Messanger exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Components.Button as Button
import Components.ModalDialog as ModalDialog
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
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Types exposing (..)
import Le.Utils exposing (..)
import Page exposing (Page)
import Route exposing (Route)
import Select
import Shared
import Time
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



-- INIT


type alias Model =
    { accounts : RemoteData ApiError (List B.EchoAccountF1)
    , sidebarOpen : Bool
    , formErrors : Dict String String
    , tableState : Table.State
    , linkFlow : LinkFlow
    , unlinkConfirmDialog : Maybe Int
    , unlinkLoading : Bool
    }


type LinkFlow
    = LinkFormState LinkForm
    | LinkQrCode { accountId : Int, qrCode : String, account : B.EchoAccountF1 }
    | LinkSuccess B.EchoAccountF1
    | LinkError { message : String, accountId : Int, account : B.EchoAccountF1 }


type alias LinkForm =
    { messengerType : String
    , phoneNumber : String
    , name : String
    }


init : () -> ( Model, Effect Msg )
init () =
    ( { accounts = RD.NotAsked
      , sidebarOpen = False
      , formErrors = Dict.empty
      , tableState = Table.initialSort "Створено"
      , linkFlow = LinkFormState { messengerType = "signal", phoneNumber = "", name = "" }
      , unlinkConfirmDialog = Nothing
      , unlinkLoading = False
      }
    , E.sendCmd (Api.messenger_list_accounts GotAccounts)
    )



-- UPDATE


type Msg
    = NoOp
    | LoadAccounts
    | GotAccounts (Result ApiError B.AccountsRsp)
    | OpenLinkSidebar
    | CloseLinkSidebar
    | SetTableState Table.State
    | SetLinkMessengerType String
    | SetLinkPhoneNumber String
    | SetLinkName String
    | SubmitLinkForm
    | GotLinkResult (Result ApiError B.LinkAccountRsp)
    | GotQrCode (Result ApiError B.QrCodeRsp)
    | CheckIsLinked
    | GotIsLinked (Result ApiError B.IsAccountLinkedRsp)
    | LinkTimeout
    | RetryQrCode
    | UnlinkAccount Int
    | ConfirmUnlink Int
    | CancelUnlink
    | GotUnlinkResult (Result ApiError ()) Int


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        NoOp ->
            ( model
            , E.none
            )

        LoadAccounts ->
            ( { model | accounts = RD.Loading }
            , E.sendCmd (Api.messenger_list_accounts GotAccounts)
            )

        GotAccounts result ->
            ( { model | accounts = 
                case result of
                    Ok accountsRsp ->
                        RD.Success accountsRsp.accounts
                    Err error ->
                        RD.Failure error
              }
            , E.none
            )

        OpenLinkSidebar ->
            ( { model | sidebarOpen = True }
            , E.none
            )

        CloseLinkSidebar ->
            ( { model | sidebarOpen = False, linkFlow = LinkFormState { messengerType = "signal", phoneNumber = "", name = "" } }
            , E.none
            )

        SetTableState newTableState ->
            ( { model | tableState = newTableState }
            , E.none
            )

        SetLinkMessengerType value ->
            case model.linkFlow of
                LinkFormState linkForm ->
                    let
                        updatedForm = { linkForm | messengerType = value }
                    in
                    ( { model | linkFlow = LinkFormState updatedForm }
                    , E.none
                    )
                
                _ ->
                    ( model, E.none )

        SetLinkPhoneNumber value ->
            case model.linkFlow of
                LinkFormState linkForm ->
                    let
                        updatedForm = { linkForm | phoneNumber = value }
                    in
                    ( { model | linkFlow = LinkFormState updatedForm }
                    , E.none
                    )
                
                _ ->
                    ( model, E.none )

        SetLinkName value ->
            case model.linkFlow of
                LinkFormState linkForm ->
                    let
                        updatedForm = { linkForm | name = value }
                    in
                    ( { model | linkFlow = LinkFormState updatedForm }
                    , E.none
                    )
                
                _ ->
                    ( model, E.none )

        SubmitLinkForm ->
            case model.linkFlow of
                LinkFormState linkForm ->
                    let
                        request = 
                            { messenger = linkForm.messengerType
                            , phone = linkForm.phoneNumber
                            , displayName = linkForm.name
                            }
                    in
                    ( model
                    , E.sendCmd (Api.messenger_link_account GotLinkResult request)
                    )
                
                _ ->
                    ( model, E.none )

        GotLinkResult result ->
            case result of
                Ok linkRsp ->
                    ( { model | linkFlow = LinkQrCode { accountId = linkRsp.account.id, qrCode = "", account = linkRsp.account } }
                    , E.sendCmd (Api.messenger_get_qr GotQrCode { accountId = linkRsp.account.id })
                    )

                Err _ ->
                    ( { model | linkFlow = LinkFormState { messengerType = "signal", phoneNumber = "", name = "" } }
                    , E.none
                    )

        GotQrCode result ->
            case result of
                Ok qrRsp ->
                    case model.linkFlow of
                        LinkQrCode qrData ->
                            ( { model | linkFlow = LinkQrCode { qrData | qrCode = qrRsp.qrCodeBase64 } }
                            , E.none
                            )
                        _ ->
                            ( model, E.none )
                
                Err _ ->
                    case model.linkFlow of
                        LinkQrCode qrData ->
                            ( { model | linkFlow = LinkError { message = "Помилка отримання QR коду", accountId = qrData.accountId, account = qrData.account } }
                            , E.none
                            )
                        _ ->
                            ( model, E.none )

        CheckIsLinked ->
            case model.linkFlow of
                LinkQrCode qrData ->
                    ( model
                    , E.sendCmd (Api.messenger_is_linked GotIsLinked { accountId = qrData.accountId })
                    )
                _ ->
                    ( model, E.none )

        GotIsLinked result ->
            case result of
                Ok isLinkedRsp ->
                    if isLinkedRsp.isLinked then
                        case model.linkFlow of
                            LinkQrCode qrData ->
                                ( { model | linkFlow = LinkSuccess qrData.account }
                                , E.none
                                )
                            _ ->
                                ( model, E.none )
                    else
                        ( model, E.none )
                
                Err _ ->
                    ( model, E.none )

        LinkTimeout ->
            ( model, E.none )

        RetryQrCode ->
            case model.linkFlow of
                LinkError errorData ->
                    ( { model | linkFlow = LinkQrCode { accountId = errorData.accountId, qrCode = "", account = errorData.account } }
                    , E.sendCmd (Api.messenger_get_qr GotQrCode { accountId = errorData.accountId })
                    )
                
                _ ->
                    ( model, E.none )

        UnlinkAccount accountId ->
            ( { model | unlinkConfirmDialog = Just accountId }
            , E.none
            )

        ConfirmUnlink accountId ->
            ( { model | unlinkConfirmDialog = Nothing, unlinkLoading = True }
            , E.sendCmd (Api.messenger_unlink_account (\result -> GotUnlinkResult result accountId) { accountId = accountId })
            )

        CancelUnlink ->
            ( { model | unlinkConfirmDialog = Nothing }
            , E.none
            )

        GotUnlinkResult result accountId ->
            case result of
                Ok _ ->
                    case model.accounts of
                        RD.Success accounts ->
                            let
                                updatedAccounts = List.filter (\account -> account.id /= accountId) accounts
                            in
                            ( { model | accounts = RD.Success updatedAccounts, unlinkConfirmDialog = Nothing, unlinkLoading = False }
                            , E.none
                            )
                        _ ->
                            ( { model | unlinkConfirmDialog = Nothing, unlinkLoading = False }
                            , E.none
                            )
                
                Err _ ->
                    ( { model | unlinkConfirmDialog = Nothing, unlinkLoading = False }
                    , E.none
                    )



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions model =
    case model.linkFlow of
        LinkQrCode _ ->
            Time.every 3000 (\_ -> CheckIsLinked)
        
        _ ->
            Sub.none



-- VIEW


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "Адмін: месенджери"
    , body = body dark shared user model
    }


body : Bool -> Shared.Model -> B.User -> Model -> List (Html Msg)
body dark shared user model =
    let
        sidebarContent =
            linkAccountSidebarContent model
    in
    [ div
        [ classList [ ( "overflow-hidden", model.sidebarOpen ) ]
        , class "w-5/6 mx-auto"
        ]
        [ Sidebar.view model.sidebarOpen CloseLinkSidebar sidebarContent
        , div [] (mainBlock dark model)
        ]
    ]


mainBlock : Bool -> Model -> List (Html Msg)
mainBlock isDark model =
    [ div []
        [ h1 [ class "py-4 text-2xl font-bold text-foreground" ] [ text "Месенджери" ]
        , div
            [ class "border border-border rounded-lg mb-4 p-4 bg-[var(--bs-tertiary-bg)]"
            ]
            [ div [ class "flex justify-between items-center" ]
                [ div [ class "text-sm text-muted-foreground" ] 
                    [ text "Управління прив'язаними акаунтами месенджерів" ]
                , Button.new { label = "Прив'язати новий", onClick = OpenLinkSidebar }
                    |> Button.view
                ]
            ]
        , case model.accounts of
            RD.Loading ->
                div [ class "text-center py-8" ]
                    [ text "Завантаження..." ]

            RD.Failure error ->
                div [ class "text-center py-8 text-red-600" ]
                    [ text "Помилка завантаження" ]

            RD.Success accounts ->
                div [ class "table-responsive-modern" ]
                    [ Table.view
                        (messengerAccountsTableConfig model.unlinkLoading)
                        model.tableState
                        accounts
                    ]

            RD.NotAsked ->
                div [ class "text-center py-8" ]
                    [ text "Завантаження..." ]

            RD.NeedsReload _ ->
                div [ class "text-center py-8" ]
                    [ text "Потрібно перезавантажити" ]
        ]
    , case model.unlinkConfirmDialog of
        Just accountId ->
            ModalDialog.modalDialog 
                True 
                CancelUnlink 
                [ class "bg-background border border-border rounded-lg p-6 max-w-md w-full mx-4" ]
                [ h3 [ class "text-lg font-semibold mb-4" ] [ text "Підтвердження" ]
                , p [ class "text-muted-foreground mb-6" ] [ text "Ви впевнені, що хочете відв'язати цей акаунт месенджера?" ]
                , div [ class "flex gap-3 justify-end" ]
                    [ Button.new { label = "Скасувати", onClick = CancelUnlink }
                        |> Button.withStyleSecondary
                        |> Button.view
                    , Button.new { label = "Відв'язати", onClick = ConfirmUnlink accountId }
                        |> Button.view
                    ]
                ]
        
        Nothing ->
            text ""
    ]


linkAccountSidebarContent : Model -> List (Html Msg)
linkAccountSidebarContent model =
    case model.linkFlow of
        LinkFormState linkForm ->
            [ div [ class "flex flex-col h-full" ]
                [ div [ class "p-6 border-b border-border" ]
                    [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Прив'язати новий акаунт" ]
                    , p [ class "text-sm text-muted-foreground" ] [ text "Введіть дані для прив'язування акаунту месенджера" ]
                    ]
                , div [ class "flex-1 overflow-y-auto p-6" ]
                    [ div [ class "space-y-6" ]
                        [ div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Тип месенджера" ]
                            , select
                                [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                                , value linkForm.messengerType
                                , onInput SetLinkMessengerType
                                ]
                                [ option [ value "signal" ] [ text "Signal" ]
                                , option [ value "whatsapp" ] [ text "WhatsApp" ]
                                ]
                            ]
                        , div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Номер телефону" ]
                            , input
                                [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                                , type_ "tel"
                                , placeholder "+380XXXXXXXXX"
                                , value linkForm.phoneNumber
                                , onInput SetLinkPhoneNumber
                                ]
                                []
                            ]
                        , div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Назва акаунту" ]
                            , input
                                [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                                , type_ "text"
                                , placeholder "Мій Signal акаунт"
                                , value linkForm.name
                                , onInput SetLinkName
                                ]
                                []
                            ]
                        ]
                    ]
                , div [ class "p-6 border-t border-border" ]
                    [ div [ class "flex gap-3" ]
                        [ Button.new { label = "Скасувати", onClick = CloseLinkSidebar }
                            |> Button.withStyleSecondary
                            |> Button.view
                        , Button.new { label = "Прив'язати", onClick = SubmitLinkForm }
                            |> Button.view
                        ]
                    ]
                ]
            ]

        LinkQrCode qrData ->
            [ div [ class "flex flex-col h-full" ]
                [ div [ class "p-6 border-b border-border" ]
                    [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Прив'язати новий акаунт" ]
                    , p [ class "text-sm text-muted-foreground" ] 
                        [ text (qrData.account.messenger ++ ": " ++ qrData.account.phoneNumber) ]
                    ]
                , div [ class "flex-1 overflow-y-auto p-6" ]
                    [ div [ class "space-y-6 text-center" ]
                        [ if qrData.qrCode /= "" then
                            div [ class "space-y-4" ]
                                [ img [ src ("data:image/png;base64," ++ qrData.qrCode), class "mx-auto max-w-xs" ] []
                                , p [ class "text-sm text-muted-foreground" ] 
                                    [ text "Відскануйте QR код вашим месенджером" ]
                                ]
                          else
                            div [ class "py-8" ]
                                [ text "Завантаження QR коду..." ]
                        , div [ class "flex items-center justify-center space-x-2" ]
                            [ div [ class "w-2 h-2 bg-blue-500 rounded-full animate-pulse" ] []
                            , span [ class "text-sm text-muted-foreground" ] [ text "Очікування підключення..." ]
                            ]
                        ]
                    ]
                , div [ class "p-6 border-t border-border" ]
                    [ div [ class "flex gap-3" ]
                        [ Button.new { label = "Скасувати", onClick = CloseLinkSidebar }
                            |> Button.withStyleSecondary
                            |> Button.view
                        ]
                    ]
                ]
            ]

        LinkSuccess account ->
            [ div [ class "flex flex-col h-full" ]
                [ div [ class "p-6 border-b border-border" ]
                    [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Прив'язати новий акаунт" ]
                    , p [ class "text-sm text-muted-foreground" ] [ text "Акаунт успішно прив'язано!" ]
                    ]
                , div [ class "flex-1 overflow-y-auto p-6" ]
                    [ div [ class "space-y-6 text-center" ]
                        [ div [ class "text-green-600 text-6xl" ] [ text "✅" ]
                        , div [ class "space-y-2" ]
                            [ h3 [ class "text-lg font-medium" ] [ text "Акаунт підключено!" ]
                            , p [ class "text-sm text-muted-foreground" ] 
                                [ text (account.messenger ++ ": " ++ account.phoneNumber) ]
                            ]
                        ]
                    ]
                , div [ class "p-6 border-t border-border" ]
                    [ div [ class "flex gap-3" ]
                        [ Button.new { label = "Закрити", onClick = CloseLinkSidebar }
                            |> Button.view
                        ]
                    ]
                ]
            ]

        LinkError errorData ->
            [ div [ class "flex flex-col h-full" ]
                [ div [ class "p-6 border-b border-border" ]
                    [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Прив'язати новий акаунт" ]
                    , p [ class "text-sm text-muted-foreground" ] [ text "Сталася помилка" ]
                    ]
                , div [ class "flex-1 overflow-y-auto p-6" ]
                    [ div [ class "space-y-6 text-center" ]
                        [ div [ class "text-red-600 text-6xl" ] [ text "❌" ]
                        , div [ class "space-y-2" ]
                            [ h3 [ class "text-lg font-medium" ] [ text "Помилка" ]
                            , p [ class "text-sm text-muted-foreground" ] [ text errorData.message ]
                            ]
                        ]
                    ]
                , div [ class "p-6 border-t border-border" ]
                    [ div [ class "flex gap-3" ]
                        [ Button.new { label = "Скасувати", onClick = CloseLinkSidebar }
                            |> Button.withStyleSecondary
                            |> Button.view
                        , Button.new { label = "Спробувати знову", onClick = RetryQrCode }
                            |> Button.view
                        ]
                    ]
                ]
            ]


messengerAccountsTableConfig : Bool -> Table.Config B.EchoAccountF1 Msg
messengerAccountsTableConfig isLoading =
    let
        defaultCustomizations =
            Table.defaultCustomizations

        customizations =
            { defaultCustomizations
                | tableAttrs = [ class "base-table" ]
            }
    in
    Table.customConfig
        { toId = \account -> String.fromInt account.id
        , toMsg = SetTableState
        , columns =
            [ Table.stringColumn "Статус" .status |> Table.withColumnWidth "15%"
            , Table.stringColumn "Номер" .phoneNumber |> Table.withColumnWidth "20%"
            , Table.stringColumn "Месенджер" .messenger |> Table.withColumnWidth "15%"
            , Table.stringColumn "Назва" .name |> Table.withColumnWidth "20%"
                                    , Table.veryCustomColumn
                            { name = "Дії"
                            , viewData =
                                \account ->
                                    TableColumn.HtmlDetails []
                                        [ div [ class "flex gap-2" ]
                                            [ if isLoading then
                                                div [ class "px-3 py-1 text-sm text-muted-foreground" ] [ text "Завантаження..." ]
                                              else
                                                Button.new { label = "Відв'язати", onClick = UnlinkAccount account.id }
                                                    |> Button.withStyleSecondary
                                                    |> Button.view
                                            ]
                                        ]
                            , sorter = Table.unsortable
                            }
                            |> Table.withColumnWidth "30%"
            ]
        , customizations = customizations
        }
