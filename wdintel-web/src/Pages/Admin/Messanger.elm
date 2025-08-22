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
import Shared.Model exposing (isDarkMode)
import Time
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
    , aorList : RemoteData ApiError (List B.AreaOfResponsibility)
    , aorSelect : Le.Block.Select.SelectTypeSingle Int
    , editForm : Maybe EditForm
    , showEditSidebar : Bool
    , editLoading : Bool
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
    , aorId : Maybe Int
    }


type alias EditForm =
    { id : Int
    , displayName : String
    , description : String
    , aorId : Maybe Int
    }


init : () -> ( Model, Effect Msg )
init () =
    ( { accounts = RD.NotAsked
      , sidebarOpen = False
      , formErrors = Dict.empty
      , tableState = Table.initialSort "Створено"
      , linkFlow = LinkFormState { messengerType = "signal", phoneNumber = "", name = "", description = "", aorId = Nothing }
      , deleteConfirmDialog = Nothing
      , deleteLoading = False
      , messengerTypeSelect =
            { state = Select.initState (Select.selectIdentifier "messenger-type-select")
            , items = messengerTypeMenuItems
            , selected = Just "signal"
            }
      , aorList = RD.NotAsked
      , aorSelect =
            { state = Select.initState (Select.selectIdentifier "aor-select")
            , items = []
            , selected = Nothing
            }
      , editForm = Nothing
      , showEditSidebar = False
      , editLoading = False
      }
    , E.batch
        [ E.sendCmd (Api.messenger_list_accounts GotAccounts)
        , E.sendCmd (Api.aor_list GotAorList { sortBy = Nothing })
        ]
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
                if account.isImported then
                    "Імпортовано"

                else
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
        case account.status of
            "ready" ->
                if account.isImported then
                    "text-purple-600"

                else
                    "text-orange-600"

            _ ->
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



-- Helper function to validate AOR ID


validateAorId : Maybe Int -> Result String Int
validateAorId maybeAorId =
    case maybeAorId of
        Just aorId ->
            Ok aorId

        Nothing ->
            Err "Потрібно вибрати смугу відповідальності"



-- Helper function to validate edit form


validateEditForm : EditForm -> Result (Dict String String) EditForm
validateEditForm editForm =
    let
        errors =
            Dict.empty
                |> validateDisplayNameField editForm.displayName
                |> validateAorIdField editForm.aorId
    in
    if Dict.isEmpty errors then
        Ok editForm

    else
        Err errors


validateDisplayNameField : String -> Dict String String -> Dict String String
validateDisplayNameField name errors =
    case validateDisplayName name of
        Ok _ ->
            errors

        Err error ->
            Dict.insert "displayName" error errors


validateAorIdField : Maybe Int -> Dict String String -> Dict String String
validateAorIdField maybeAorId errors =
    case validateAorId maybeAorId of
        Ok _ ->
            errors

        Err error ->
            Dict.insert "aorId" error errors



-- Helper function to find account by ID


findAccountById : Int -> List B.EchoAccountF1 -> Maybe B.EchoAccountF1
findAccountById accountId accounts =
    List.filter (\account -> account.id == accountId) accounts |> List.head



-- Helper function to build edit request


buildEditRequest : EditForm -> B.EchoAccountF1 -> { accountId : Int, aorId : Maybe Int, isActive : Bool, displayName : String, description : Maybe String }
buildEditRequest editForm account =
    let
        currentIsActive =
            account.status == "active"
    in
    { accountId = editForm.id
    , aorId = editForm.aorId
    , isActive = currentIsActive
    , displayName = editForm.displayName
    , description =
        if String.isEmpty editForm.description then
            Nothing

        else
            Just editForm.description
    }



-- Helper function to submit edit form


submitEditForm : Model -> EditForm -> ( Model, Effect Msg )
submitEditForm model editForm =
    case model.accounts of
        RD.Success accounts ->
            case findAccountById editForm.id accounts of
                Just account ->
                    let
                        request =
                            buildEditRequest editForm account
                    in
                    ( { model | editLoading = True }
                    , E.sendCmd (Api.messenger_edit_account (\result -> EditAccountResponse result editForm.id) request)
                    )

                Nothing ->
                    ( model, E.none )

        _ ->
            ( model, E.none )



-- Helper function to normalize description


normalizeDescription : String -> Maybe String
normalizeDescription description =
    if String.isEmpty description then
        Nothing

    else
        Just description



-- Helper function to find AOR by ID


findAorById : Maybe Int -> RemoteData ApiError (List B.AreaOfResponsibility) -> Maybe B.AreaOfResponsibility
findAorById maybeAorId aorList =
    case maybeAorId of
        Just aorId ->
            case aorList of
                RD.Success aors ->
                    List.filter (\aor -> aor.id == aorId) aors |> List.head

                _ ->
                    Nothing

        Nothing ->
            Nothing



-- Helper function to update account in list


updateAccountInList : Int -> EditForm -> RemoteData ApiError (List B.AreaOfResponsibility) -> B.EchoAccountF1 -> B.EchoAccountF1
updateAccountInList accountId editForm aorList account =
    if account.id == accountId then
        { account
            | displayName = editForm.displayName
            , description = normalizeDescription editForm.description
            , areaOfResponsibility = findAorById editForm.aorId aorList
        }

    else
        account



-- Helper function to update accounts list


updateAccountsList : Int -> EditForm -> Model -> RemoteData ApiError (List B.EchoAccountF1)
updateAccountsList accountId editForm model =
    case model.accounts of
        RD.Success accounts ->
            let
                updatedAccounts =
                    List.map (updateAccountInList accountId editForm model.aorList) accounts
            in
            RD.Success updatedAccounts

        _ ->
            model.accounts



-- Helper function to clear edit form


clearEditForm : Model -> Model
clearEditForm model =
    { model
        | showEditSidebar = False
        , editForm = Nothing
        , editLoading = False
        , formErrors = Dict.empty
    }



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
    | GotAorList (Result ApiError (List B.AreaOfResponsibility))
    | OpenLinkSidebar
    | CloseLinkSidebar
    | ShowEditSidebar Int
    | CloseEditSidebar
    | SetTableState Table.State
    | SetLinkMessengerType String
    | SetLinkPhoneNumber String
    | SetLinkName String
    | SetLinkDescription String
    | UpdateEditDisplayName String
    | UpdateEditDescription String
    | SubmitLinkForm
    | SubmitEditForm
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
    | EditAccountResponse (Result ApiError ()) Int
    | EditAorSelectMsg (Select.Msg Int)
    | MessengerTypeSelectMsg (Select.Msg String)
    | AorSelectMsg (Select.Msg Int)
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

        GotAorList (Ok aorList) ->
            let
                aorItems =
                    List.map (\aor -> Select.basicMenuItem { item = aor.id, label = aor.name }) aorList

                currentAorSelect =
                    model.aorSelect

                updatedAorSelect =
                    { currentAorSelect | items = aorItems }
            in
            ( { model
                | aorList = RD.Success aorList
                , aorSelect = updatedAorSelect
              }
            , E.none
            )

        GotAorList (Err error) ->
            ( { model | aorList = RD.Failure error }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження смуг відповідальності" error
            )

        OpenLinkSidebar ->
            ( { model | sidebarOpen = True }
            , E.none
            )

        CloseLinkSidebar ->
            ( { model | sidebarOpen = False, linkFlow = LinkFormState { messengerType = "signal", phoneNumber = "", name = "", description = "", aorId = Nothing } }
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
                            case validateAorId linkForm.aorId of
                                Ok validatedAorId ->
                                    let
                                        systemServiceName =
                                            normalizeToSystemName linkForm.name

                                        request =
                                            { messenger = linkForm.messengerType
                                            , phone = linkForm.phoneNumber
                                            , displayName = linkForm.name
                                            , systemServiceName = systemServiceName
                                            , description =
                                                if String.isEmpty linkForm.description then
                                                    Nothing

                                                else
                                                    Just linkForm.description
                                            , aorId = validatedAorId
                                            }
                                    in
                                    ( model
                                    , E.sendCmd (Api.messenger_link_account GotLinkResult request)
                                    )

                                Err error ->
                                    ( { model | formErrors = Dict.insert "aorId" error model.formErrors }
                                    , E.none
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
            ( { model | linkFlow = LinkFormState { messengerType = "signal", phoneNumber = "", name = "", description = "", aorId = Nothing } }
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
                            , E.sendCmd
                                (Api.messenger_edit_account (\result -> GotToggleStatusResult result accountId)
                                    { accountId = accountId
                                    , aorId = Maybe.map .id account.areaOfResponsibility
                                    , isActive = newIsActive
                                    , displayName = account.displayName
                                    , description = account.description
                                    }
                                )
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

        AorSelectMsg selectMsg ->
            let
                ( mAction, newState, selectCmd ) =
                    Select.update selectMsg model.aorSelect.state

                updatedAorId =
                    Le.Block.Select.singleUpd mAction model.aorSelect.selected

                newSelect =
                    { state = newState
                    , items = model.aorSelect.items
                    , selected = updatedAorId
                    }

                -- Update the link form with the new AOR ID
                updatedLinkFlow =
                    case model.linkFlow of
                        LinkFormState linkForm ->
                            LinkFormState { linkForm | aorId = updatedAorId }

                        _ ->
                            model.linkFlow
            in
            ( { model
                | aorSelect = newSelect
                , linkFlow = updatedLinkFlow
                , formErrors = Dict.remove "aorId" model.formErrors
              }
            , E.sendCmd <| Cmd.map AorSelectMsg selectCmd
            )

        RefreshQrCode ->
            case model.linkFlow of
                LinkQrCode qrData ->
                    ( { model | linkFlow = LinkQrCode { qrData | qrCode = "" } }
                    , Api.messenger_get_qr_retryable GotQrCode { accountId = qrData.accountId }
                    )

                _ ->
                    ( model, E.none )

        ShowEditSidebar accountId ->
            case model.accounts of
                RD.Success accounts ->
                    case List.filter (\account -> account.id == accountId) accounts |> List.head of
                        Just account ->
                            let
                                editForm =
                                    { id = account.id
                                    , displayName = account.displayName
                                    , description = Maybe.withDefault "" account.description
                                    , aorId = Maybe.map .id account.areaOfResponsibility
                                    }
                            in
                            ( { model
                                | showEditSidebar = True
                                , editForm = Just editForm
                                , formErrors = Dict.empty
                              }
                            , E.none
                            )

                        Nothing ->
                            ( model, E.none )

                _ ->
                    ( model, E.none )

        CloseEditSidebar ->
            ( { model
                | showEditSidebar = False
                , editForm = Nothing
                , formErrors = Dict.empty
              }
            , E.none
            )

        UpdateEditDisplayName value ->
            case model.editForm of
                Just editForm ->
                    ( { model
                        | editForm = Just { editForm | displayName = value }
                        , formErrors = Dict.remove "displayName" model.formErrors
                      }
                    , E.none
                    )

                Nothing ->
                    ( model, E.none )

        UpdateEditDescription value ->
            case model.editForm of
                Just editForm ->
                    ( { model | editForm = Just { editForm | description = value } }
                    , E.none
                    )

                Nothing ->
                    ( model, E.none )

        SubmitEditForm ->
            case model.editForm of
                Just editForm ->
                    case validateEditForm editForm of
                        Ok validForm ->
                            submitEditForm model validForm

                        Err errors ->
                            ( { model | formErrors = errors }
                            , E.none
                            )

                Nothing ->
                    ( model, E.none )

        EditAccountResponse (Ok _) accountId ->
            case model.editForm of
                Just editForm ->
                    let
                        updatedAccounts =
                            updateAccountsList accountId editForm model
                    in
                    ( { model | accounts = updatedAccounts }
                        |> clearEditForm
                    , E.none
                    )

                Nothing ->
                    ( clearEditForm model, E.none )

        EditAccountResponse (Err error) accountId ->
            ( { model | editLoading = False }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка редагування акаунту" error
            )

        EditAorSelectMsg selectMsg ->
            case model.editForm of
                Just editForm ->
                    let
                        ( mAction, newState, selectCmd ) =
                            Select.update selectMsg model.aorSelect.state

                        updatedAorId =
                            Le.Block.Select.singleUpd mAction model.aorSelect.selected

                        newSelect =
                            { state = newState
                            , items = model.aorSelect.items
                            , selected = updatedAorId
                            }

                        updatedEditForm =
                            { editForm | aorId = updatedAorId }
                    in
                    ( { model
                        | aorSelect = newSelect
                        , editForm = Just updatedEditForm
                        , formErrors = Dict.remove "aorId" model.formErrors
                      }
                    , E.sendCmd <| Cmd.map EditAorSelectMsg selectCmd
                    )

                Nothing ->
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
        linkSidebarContent =
            linkAccountSidebarContent dark shared model

        editSidebarContent =
            editAccountSidebarContent dark shared model
    in
    [ div
        [ classList [ ( "overflow-hidden", model.sidebarOpen || model.showEditSidebar ) ]
        , class "w-5/6 mx-auto"
        ]
        [ Sidebar.view model.sidebarOpen CloseLinkSidebar linkSidebarContent
        , Sidebar.view model.showEditSidebar CloseEditSidebar editSidebarContent
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
                        (messengerAccountsTableConfig model.deleteLoading model.aorList)
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
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Смуга відповідальності" ]
                            , Html.map AorSelectMsg <|
                                Styled.toUnstyled <|
                                    Le.Block.Select.renderSelectSingle
                                        (Maybe.andThen
                                            (\aorId ->
                                                List.filter (\aor -> aor.id == aorId) (RD.withDefault [] model.aorList)
                                                    |> List.head
                                                    |> Maybe.map (\aor -> Select.basicMenuItem { item = aor.id, label = aor.name })
                                            )
                                            linkForm.aorId
                                        )
                                        model.aorSelect.state
                                        model.aorSelect.items
                                        "Оберіть смугу відповідальності"
                                        (Le.Block.Select.defaultOptions isDark)
                            , case Dict.get "aorId" model.formErrors of
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


editAccountSidebarContent : Bool -> Shared.Model -> Model -> List (Html Msg)
editAccountSidebarContent isDark shared model =
    case model.editForm of
        Just editForm ->
            [ div [ class "flex flex-col h-full" ]
                [ div [ class "p-6 border-b border-border" ]
                    [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Редагувати акаунт" ]
                    , p [ class "text-sm text-muted-foreground" ] [ text "Змініть дані акаунту месенджера" ]
                    ]
                , div [ class "flex-1 overflow-y-auto p-6" ]
                    [ div [ class "space-y-6" ]
                        [ div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Назва акаунту" ]
                            , input
                                [ type_ "text"
                                , class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                                , placeholder "Введіть назву акаунту"
                                , value editForm.displayName
                                , onInput UpdateEditDisplayName
                                ]
                                []
                            , case Dict.get "displayName" model.formErrors of
                                Just error ->
                                    p [ class "text-xs text-red-600" ] [ text error ]

                                Nothing ->
                                    text ""
                            ]
                        , div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Опис" ]
                            , textarea
                                [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                                , rows 3
                                , placeholder "Введіть опис (необов'язково)"
                                , value editForm.description
                                , onInput UpdateEditDescription
                                ]
                                []
                            ]
                        , div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Смуга відповідальності" ]
                            , Html.map EditAorSelectMsg <|
                                Styled.toUnstyled <|
                                    Le.Block.Select.renderSelectSingle
                                        (Maybe.andThen
                                            (\aorId ->
                                                List.filter (\aor -> aor.id == aorId) (RD.withDefault [] model.aorList)
                                                    |> List.head
                                                    |> Maybe.map (\aor -> Select.basicMenuItem { item = aor.id, label = aor.name })
                                            )
                                            editForm.aorId
                                        )
                                        model.aorSelect.state
                                        model.aorSelect.items
                                        "Оберіть смугу відповідальності"
                                        (Le.Block.Select.defaultOptions isDark)
                            , case Dict.get "aorId" model.formErrors of
                                Just error ->
                                    p [ class "text-xs text-red-600" ] [ text error ]

                                Nothing ->
                                    text ""
                            ]
                        ]
                    ]
                , div [ class "p-6 border-t border-border" ]
                    [ div [ class "flex gap-3" ]
                        [ Button.new { label = "Скасувати", onClick = CloseEditSidebar }
                            |> Button.withStyleSecondary
                            |> Button.view
                        , Button.new { label = "Зберегти", onClick = SubmitEditForm }
                            |> Button.withDisabled model.editLoading
                            |> Button.view
                        ]
                    ]
                ]
            ]

        Nothing ->
            []


messengerAccountsTableConfig : Bool -> RemoteData ApiError (List B.AreaOfResponsibility) -> Table.Config B.EchoAccountF1 Msg
messengerAccountsTableConfig isLoading aorList =
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
            [ Table.veryCustomColumn
                { name = "Назва акаунту"
                , viewData =
                    \account ->
                        TableColumn.HtmlDetails []
                            [ text account.displayName ]
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "14%"
            , Table.veryCustomColumn
                { name = "Системний сервіс"
                , viewData =
                    \account ->
                        TableColumn.HtmlDetails []
                            [ text (Maybe.withDefault "—" account.systemServiceName) ]
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "12%"
            , Table.veryCustomColumn
                { name = "Номер"
                , viewData =
                    \account ->
                        TableColumn.HtmlDetails []
                            [ text account.phoneNumber ]
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "12%"
            , Table.veryCustomColumn
                { name = "Месенджер"
                , viewData =
                    \account ->
                        TableColumn.HtmlDetails [ class "col-narrow" ]
                            [ case account.messenger of
                                "signal" ->
                                    i [ class "bi bi-signal text-blue-500", title "Signal" ] []

                                "whatsapp" ->
                                    i [ class "bi bi-whatsapp text-green-500", title "WhatsApp" ] []

                                _ ->
                                    i [ class "bi bi-chat-fill text-gray-500", title account.messenger ] []
                            ]
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "6%"
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
                |> Table.withColumnWidth "17%"
            , Table.veryCustomColumn
                { name = "Смуга відповідальності"
                , viewData =
                    \account ->
                        TableColumn.HtmlDetails []
                            [ text (Maybe.map .name account.areaOfResponsibility |> Maybe.withDefault "—") ]
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "15%"
            , Table.veryCustomColumn
                { name = "Статус"
                , viewData =
                    \account ->
                        TableColumn.HtmlDetails []
                            [ span [ class (getStatusColorClass account) ] [ text (getStatusText account) ]
                            ]
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "14%"
            , Table.veryCustomColumn
                { name = ""
                , viewData =
                    \account ->
                        TableColumn.HtmlDetails [ class "col-narrow" ]
                            [ if isLoading then
                                div [ class "px-2 py-1 text-sm text-muted-foreground" ] [ text "..." ]

                              else if account.isLinked then
                                div [ class "flex gap-1" ]
                                    [ button
                                        [ class "table-action-btn"
                                        , type_ "button"
                                        , title "Редагувати"
                                        , onClick <| ShowEditSidebar account.id
                                        ]
                                        [ i [ class "bi bi-pencil" ] [] ]
                                    , if account.status == "active" then
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
                                        , title "Редагувати"
                                        , onClick <| ShowEditSidebar account.id
                                        ]
                                        [ i [ class "bi bi-pencil" ] [] ]
                                    , button
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
                |> Table.withColumnWidth "10%"
            ]
        , customizations = customizations
        }
