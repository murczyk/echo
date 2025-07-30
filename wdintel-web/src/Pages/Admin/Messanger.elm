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
    , deleteConfirmDialog : Maybe Int
    , deleteLoading : Bool
    , messengerTypeSelect : Le.Block.Select.SelectTypeSingle String
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
    , description : String
    }


init : () -> ( Model, Effect Msg )
init () =
    ( { accounts = RD.NotAsked
      , sidebarOpen = False
      , formErrors = Dict.empty
      , tableState = Table.initialSort "Створено"
      , linkFlow = LinkFormState { messengerType = "signal", phoneNumber = "", name = "", description = "" }
      , deleteConfirmDialog = Nothing
      , deleteLoading = False
      , messengerTypeSelect =
            { state = Select.initState (Select.selectIdentifier "messenger-type-select")
            , items = messengerTypeMenuItems
            , selected = Just "signal"
            }
      }
    , E.sendCmd (Api.messenger_list_accounts GotAccounts)
    )



-- UPDATE
-- Helper function to get user-friendly status text


getStatusText : B.EchoAccountF1 -> String
getStatusText account =
    if account.isLinked then
        case account.status of
            "active" ->
                "Активний"

            "paused" ->
                "Призупинено"

            "ready" ->
                "Готовий"

            _ ->
                account.status

    else
        case account.status of
            "ready" ->
                "Очікує підключення"

            _ ->
                "Не підключено"



-- Helper function to get status color class


getStatusColorClass : B.EchoAccountF1 -> String
getStatusColorClass account =
    if account.isLinked then
        case account.status of
            "active" ->
                "text-green-600"

            "paused" ->
                "text-yellow-600"

            "ready" ->
                "text-blue-600"

            _ ->
                "text-gray-600"

    else
        "text-orange-600"



-- Helper function to normalize display name to system service name
normalizeToSystemName : String -> String
normalizeToSystemName displayName =
    let
        -- Convert to lowercase and replace spaces with hyphens
        step1 = 
            displayName
                |> String.toLower
                |> String.replace " " "-"
                |> String.replace "  " "-"
                |> String.replace "   " "-"
        
        -- Replace Ukrainian characters with Latin equivalents
        step2 =
            step1
                |> String.replace "а" "a"
                |> String.replace "б" "b"
                |> String.replace "в" "v"
                |> String.replace "г" "h"
                |> String.replace "ґ" "g"
                |> String.replace "д" "d"
                |> String.replace "е" "e"
                |> String.replace "є" "ye"
                |> String.replace "ж" "zh"
                |> String.replace "з" "z"
                |> String.replace "и" "y"
                |> String.replace "і" "i"
                |> String.replace "ї" "yi"
                |> String.replace "й" "y"
                |> String.replace "к" "k"
                |> String.replace "л" "l"
                |> String.replace "м" "m"
                |> String.replace "н" "n"
                |> String.replace "о" "o"
                |> String.replace "п" "p"
                |> String.replace "р" "r"
                |> String.replace "с" "s"
                |> String.replace "т" "t"
                |> String.replace "у" "u"
                |> String.replace "ф" "f"
                |> String.replace "х" "kh"
                |> String.replace "ц" "ts"
                |> String.replace "ч" "ch"
                |> String.replace "ш" "sh"
                |> String.replace "щ" "shch"
                |> String.replace "ь" ""
                |> String.replace "ю" "yu"
                |> String.replace "я" "ya"
        
        -- Filter only allowed characters
        step3 =
            step2
                |> String.filter (\c -> Char.isAlphaNum c || c == '-' || c == '_')
        
        -- Remove multiple consecutive hyphens
        step4 =
            step3
                |> String.replace "--" "-"
                |> String.replace "---" "-"
                |> String.replace "----" "-"
        
        -- Remove leading/trailing hyphens
        step5 =
            if String.startsWith "-" step4 then
                String.dropLeft 1 step4
            else
                step4
        
        step6 =
            if String.endsWith "-" step5 then
                String.dropRight 1 step5
            else
                step5
        
        -- Limit length and ensure minimum length
        final =
            if String.length step6 < 4 then
                if String.length step6 == 0 then
                    "account"
                else
                    step6 ++ "-" ++ String.fromInt (modBy 1000 (String.length step6 + 1))
            else if String.length step6 > 50 then
                String.left 50 step6
            else
                step6
    in
    final


-- Helper function to validate display name
validateDisplayName : String -> Result String String
validateDisplayName name =
    if String.length name < 2 then
        Err "Назва акаунту має бути мінімум 2 символи"
    else if String.length name > 50 then
        Err "Назва акаунту має бути максимум 50 символів"
    else
        Ok name


-- Helper function to get messenger type label


getMessengerTypeLabel : String -> String
getMessengerTypeLabel messengerType =
    case messengerType of
        "signal" ->
            "Signal"

        "whatsapp" ->
            "WhatsApp"

        _ ->
            messengerType



-- Messenger type menu items


messengerTypeMenuItems : List (Select.MenuItem String)
messengerTypeMenuItems =
    [ Select.basicMenuItem { item = "signal", label = "Signal" }
    , Select.basicMenuItem { item = "whatsapp", label = "WhatsApp" }
    ]


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
    | SetLinkDescription String
    | SubmitLinkForm
    | GotLinkResult (Result ApiError B.LinkAccountRsp)
    | GotQrCode (Result ApiError B.QrCodeRsp)
    | CheckIsLinked
    | GotIsLinked (Result ApiError B.IsAccountLinkedRsp)
    | LinkTimeout
    | RetryQrCode
    | ConnectExistingAccount Int
    | DeleteAccount Int
    | ConfirmDelete Int
    | CancelDelete
    | GotDeleteResult (Result ApiError ()) Int
    | ToggleAccountStatus Int
    | GotToggleStatusResult (Result ApiError ()) Int
    | MessengerTypeSelectMsg (Select.Msg String)
    | RefreshQrCode


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

        GotAccounts (Ok accountsRsp) ->
            ( { model | accounts = RD.Success accountsRsp.accounts }
            , E.none
            )

        GotAccounts (Err error) ->
            ( { model | accounts = RD.Failure error }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження акаунтів месенджерів" error
            )

        OpenLinkSidebar ->
            ( { model | sidebarOpen = True }
            , E.none
            )

        CloseLinkSidebar ->
            ( { model | sidebarOpen = False, linkFlow = LinkFormState { messengerType = "signal", phoneNumber = "", name = "", description = "" } }
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
                        updatedForm =
                            { linkForm | messengerType = value }
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
                        updatedForm =
                            { linkForm | phoneNumber = value }
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
                        updatedForm =
                            { linkForm | name = value }
                    in
                    ( { model 
                        | linkFlow = LinkFormState updatedForm
                        , formErrors = Dict.remove "displayName" model.formErrors
                      }
                    , E.none
                    )

                _ ->
                    ( model, E.none )

        SetLinkDescription value ->
            case model.linkFlow of
                LinkFormState linkForm ->
                    let
                        updatedForm =
                            { linkForm | description = value }
                    in
                    ( { model | linkFlow = LinkFormState updatedForm }
                    , E.none
                    )

                _ ->
                    ( model, E.none )



        SubmitLinkForm ->
            case model.linkFlow of
                LinkFormState linkForm ->
                    case validateDisplayName linkForm.name of
                        Ok _ ->
                            let
                                systemServiceName = normalizeToSystemName linkForm.name
                                request =
                                    { messenger = linkForm.messengerType
                                    , phone = linkForm.phoneNumber
                                    , displayName = linkForm.name
                                    , systemServiceName = systemServiceName
                                    , description = if String.isEmpty linkForm.description then Nothing else Just linkForm.description
                                    }
                            in
                            ( model
                            , E.sendCmd (Api.messenger_link_account GotLinkResult request)
                            )
                        
                        Err error ->
                            ( { model | formErrors = Dict.insert "displayName" error model.formErrors }
                            , E.none
                            )

                _ ->
                    ( model, E.none )

        GotLinkResult (Ok linkRsp) ->
            let
                -- STEP 1: Add the new account to the table immediately after creation
                -- This makes the account appear in the table right away, even before QR scan
                updatedAccounts =
                    case model.accounts of
                        RD.Success accounts ->
                            -- Add the new account to the beginning of the list
                            RD.Success (linkRsp.account :: accounts)

                        _ ->
                            -- If accounts list is empty/loading, create new list with just this account
                            RD.Success [ linkRsp.account ]
            in
            ( { model
                | accounts = updatedAccounts -- Update the table with new account
                , linkFlow = LinkQrCode { accountId = linkRsp.account.id, qrCode = "", account = linkRsp.account }
              }
            , Api.messenger_get_qr_retryable GotQrCode { accountId = linkRsp.account.id }
            )

        GotLinkResult (Err error) ->
            ( { model | linkFlow = LinkFormState { messengerType = "signal", phoneNumber = "", name = "", description = "" } }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка прив'язування акаунту" error
            )

        GotQrCode (Ok qrRsp) ->
            case model.linkFlow of
                LinkQrCode qrData ->
                    ( { model | linkFlow = LinkQrCode { qrData | qrCode = qrRsp.qrCodeBase64 } }
                    , E.none
                    )

                _ ->
                    ( model, E.none )

        GotQrCode (Err error) ->
            case model.linkFlow of
                LinkQrCode qrData ->
                    ( { model | linkFlow = LinkError { message = "Помилка отримання QR коду після кількох спроб", accountId = qrData.accountId, account = qrData.account } }
                    , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка отримання QR коду" error
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

        GotIsLinked (Ok isLinkedRsp) ->
            if isLinkedRsp.isLinked then
                case model.linkFlow of
                    LinkQrCode qrData ->
                        let
                            -- STEP 2: Update only the specific account's is_linked status
                            -- This changes the status from "Очікує підключення" to "Активний" without refreshing the whole table
                            updatedAccounts =
                                case model.accounts of
                                    RD.Success accounts ->
                                        RD.Success
                                            (List.map
                                                (\account ->
                                                    if account.id == qrData.accountId then
                                                        -- Update only this specific account's isLinked field
                                                        { account | isLinked = True }

                                                    else
                                                        -- Leave all other accounts unchanged
                                                        account
                                                )
                                                accounts
                                            )

                                    _ ->
                                        -- If accounts list is not loaded, keep it as is
                                        model.accounts
                        in
                        ( { model
                            | accounts = updatedAccounts -- Update the table with new status
                            , linkFlow = LinkSuccess qrData.account
                          }
                        , E.none
                          -- No need to refresh the table!
                        )

                    _ ->
                        ( model, E.none )

            else
                ( model, E.none )

        GotIsLinked (Err _) ->
            ( model, E.none )

        LinkTimeout ->
            ( model, E.none )

        RetryQrCode ->
            case model.linkFlow of
                LinkError errorData ->
                    ( { model | linkFlow = LinkQrCode { accountId = errorData.accountId, qrCode = "", account = errorData.account } }
                    , Api.messenger_get_qr_retryable GotQrCode { accountId = errorData.accountId }
                    )

                _ ->
                    ( model, E.none )

        ConnectExistingAccount accountId ->
            case model.accounts of
                RD.Success accounts ->
                    case List.filter (\account -> account.id == accountId) accounts |> List.head of
                        Just account ->
                            ( { model
                                | sidebarOpen = True
                                , linkFlow = LinkQrCode { accountId = accountId, qrCode = "", account = account }
                              }
                            , Api.messenger_get_qr_retryable GotQrCode { accountId = accountId }
                            )

                        Nothing ->
                            ( model, E.none )

                _ ->
                    ( model, E.none )

        DeleteAccount accountId ->
            ( { model | deleteConfirmDialog = Just accountId }
            , E.none
            )

        ConfirmDelete accountId ->
            ( { model | deleteConfirmDialog = Nothing, deleteLoading = True }
            , E.sendCmd (Api.messenger_unlink_account (\result -> GotDeleteResult result accountId) { accountId = accountId })
            )

        CancelDelete ->
            ( { model | deleteConfirmDialog = Nothing }
            , E.none
            )

        GotDeleteResult (Ok _) accountId ->
            case model.accounts of
                RD.Success accounts ->
                    let
                        updatedAccounts =
                            List.filter (\account -> account.id /= accountId) accounts
                    in
                    ( { model | accounts = RD.Success updatedAccounts, deleteConfirmDialog = Nothing, deleteLoading = False }
                    , E.none
                    )

                _ ->
                    ( { model | deleteConfirmDialog = Nothing, deleteLoading = False }
                    , E.none
                    )

        GotDeleteResult (Err error) accountId ->
            ( { model | deleteConfirmDialog = Nothing, deleteLoading = False }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення акаунту" error
            )

        ToggleAccountStatus accountId ->
            case model.accounts of
                RD.Success accounts ->
                    case List.filter (\account -> account.id == accountId) accounts |> List.head of
                        Just account ->
                            let
                                -- Toggle between active and paused
                                newIsActive =
                                    account.status /= "active"
                            in
                            ( model
                            , E.sendCmd (Api.messenger_edit_account (\result -> GotToggleStatusResult result accountId) { accountId = accountId, isActive = newIsActive })
                            )

                        Nothing ->
                            ( model, E.none )

                _ ->
                    ( model, E.none )

        GotToggleStatusResult (Ok _) accountId ->
            case model.accounts of
                RD.Success accounts ->
                    let
                        -- Update the account status in the table
                        updatedAccounts =
                            RD.Success
                                (List.map
                                    (\account ->
                                        if account.id == accountId then
                                            -- Toggle the status
                                            { account
                                                | status =
                                                    if account.status == "active" then
                                                        "paused"

                                                    else
                                                        "active"
                                            }

                                        else
                                            account
                                    )
                                    accounts
                                )
                    in
                    ( { model | accounts = updatedAccounts }
                    , E.none
                    )

                _ ->
                    ( model, E.none )

        GotToggleStatusResult (Err error) accountId ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка зміни статусу акаунту" error
            )

        MessengerTypeSelectMsg selectMsg ->
            let
                ( mAction, newState, selectCmd ) =
                    Select.update selectMsg model.messengerTypeSelect.state

                updatedMessengerType =
                    Le.Block.Select.singleUpdWithDefault mAction (Maybe.withDefault "signal" model.messengerTypeSelect.selected)

                newSelect =
                    { state = newState
                    , items = model.messengerTypeSelect.items
                    , selected = Just updatedMessengerType
                    }

                -- Update the link form with the new messenger type
                updatedLinkFlow =
                    case model.linkFlow of
                        LinkFormState linkForm ->
                            LinkFormState { linkForm | messengerType = updatedMessengerType }

                        _ ->
                            model.linkFlow
            in
            ( { model
                | messengerTypeSelect = newSelect
                , linkFlow = updatedLinkFlow
              }
            , E.sendCmd <| Cmd.map MessengerTypeSelectMsg selectCmd
            )

        RefreshQrCode ->
            case model.linkFlow of
                LinkQrCode qrData ->
                    ( { model | linkFlow = LinkQrCode { qrData | qrCode = "" } }
                    , Api.messenger_get_qr_retryable GotQrCode { accountId = qrData.accountId }
                    )

                _ ->
                    ( model, E.none )



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
            linkAccountSidebarContent dark shared model
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
                        (messengerAccountsTableConfig model.deleteLoading)
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
    , case model.deleteConfirmDialog of
        Just accountId ->
            ModalDialog.modalDialog
                True
                CancelDelete
                [ class "bg-background border border-border rounded-lg p-6 max-w-md w-full mx-4" ]
                [ h3 [ class "text-lg font-semibold mb-4" ] [ text "Підтвердження видалення" ]
                , p [ class "text-muted-foreground mb-6" ] [ text "Ви впевнені, що хочете видалити цей акаунт месенджера?" ]
                , div [ class "flex gap-3 justify-end" ]
                    [ Button.new { label = "Скасувати", onClick = CancelDelete }
                        |> Button.withStyleSecondary
                        |> Button.view
                    , Button.new { label = "Видалити", onClick = ConfirmDelete accountId }
                        |> Button.view
                    ]
                ]

        Nothing ->
            text ""
    ]


linkAccountSidebarContent : Bool -> Shared.Model -> Model -> List (Html Msg)
linkAccountSidebarContent isDark shared model =
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
                            , Html.map MessengerTypeSelectMsg <|
                                Styled.toUnstyled <|
                                    Le.Block.Select.renderSelectSingle
                                        (Just (Select.basicMenuItem { item = linkForm.messengerType, label = getMessengerTypeLabel linkForm.messengerType }))
                                        model.messengerTypeSelect.state
                                        messengerTypeMenuItems
                                        "Виберіть тип месенджера"
                                        (Le.Block.Select.defaultOptions isDark)
                            ]
                        , div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Номер телефону" ]
                            , input
                                [ class "form-input w-full"
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
                                [ class "form-input w-full"
                                , type_ "text"
                                , placeholder "Мій Signal акаунт"
                                , value linkForm.name
                                , onInput SetLinkName
                                ]
                                []
                            , case Dict.get "displayName" model.formErrors of
                                Just error ->
                                    p [ class "text-xs text-red-600" ] [ text error ]
                                
                                Nothing ->
                                    text ""
                            ]
                        , div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Опис (необов'язково)" ]
                            , textarea
                                [ class "form-textarea w-full"
                                , rows 3
                                , placeholder "Короткий опис акаунту..."
                                , value linkForm.description
                                , onInput SetLinkDescription
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
                                [ img [ src qrData.qrCode, class "mx-auto max-w-xs" ] []
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
                        , Button.new { label = "Оновити QR код", onClick = RefreshQrCode }
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
    in
    Table.customConfig
        { toId = \account -> String.fromInt account.id
        , toMsg = SetTableState
        , columns =
            [ Table.stringColumn "Назва акаунту" .displayName |> Table.withColumnWidth "18%"
             ,Table.stringColumn "Системний сервіс" .systemServiceName |> Table.withColumnWidth "15%"
            , Table.stringColumn "Номер" .phoneNumber |> Table.withColumnWidth "15%"
            , Table.stringColumn "Месенджер" .messenger |> Table.withColumnWidth "10%"
            , Table.veryCustomColumn
                { name = "Опис"
                , viewData =
                    \account ->
                        TableColumn.HtmlDetails []
                            [ case account.description of
                                Just desc ->
                                    if String.length desc > 50 then
                                        span [ title desc ] [ text (String.left 50 desc ++ "...") ]
                                    else
                                        span [] [ text desc ]
                                
                                Nothing ->
                                    span [ class "text-muted-foreground" ] [ text "—" ]
                            ]
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "20%"
            , Table.veryCustomColumn
                { name = "Статус"
                , viewData =
                    \account ->
                        TableColumn.HtmlDetails []
                            [ span [ class (getStatusColorClass account) ] [ text (getStatusText account) ]
                            ]
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "10%"
            , Table.veryCustomColumn
                { name = ""
                , viewData =
                    \account ->
                        TableColumn.HtmlDetails [ class "col-narrow" ]
                            [ if isLoading then
                                div [ class "px-2 py-1 text-sm text-muted-foreground" ] [ text "..." ]

                              else if account.isLinked then
                                div [ class "flex gap-1" ]
                                    [ if account.status == "active" then
                                        button
                                            [ class "table-action-btn"
                                            , type_ "button"
                                            , title "Призупинити"
                                            , onClick <| ToggleAccountStatus account.id
                                            ]
                                            [ i [ class "bi bi-pause-circle" ] [] ]

                                      else
                                        button
                                            [ class "table-action-btn"
                                            , type_ "button"
                                            , title "Активувати"
                                            , onClick <| ToggleAccountStatus account.id
                                            ]
                                            [ i [ class "bi bi-play-circle" ] [] ]
                                    , button
                                        [ class "icon-btn icon-btn-danger"
                                        , type_ "button"
                                        , title "Видалити"
                                        , onClick <| DeleteAccount account.id
                                        ]
                                        [ i [ class "bi bi-trash" ] [] ]
                                    ]

                              else
                                div [ class "flex gap-1" ]
                                    [ button
                                        [ class "table-action-btn"
                                        , type_ "button"
                                        , title "Підключити"
                                        , onClick <| ConnectExistingAccount account.id
                                        ]
                                        [ i [ class "bi bi-link-45deg" ] [] ]
                                    , button
                                        [ class "icon-btn icon-btn-danger"
                                        , type_ "button"
                                        , title "Видалити"
                                        , onClick <| DeleteAccount account.id
                                        ]
                                        [ i [ class "bi bi-trash" ] [] ]
                                    ]
                            ]
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "8%"
            ]
        , customizations = customizations
        }
