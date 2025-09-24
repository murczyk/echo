module Pages_.Admin.Messanger.LinkFlow exposing
    ( LinkFlow
    , PhoneForm
    , ApiForm
    , QrData
    , initPhoneFlow
    , initApiFlow
    , isApi
    , resetFlow
    , handleLinkResult
    , updateQrCode
    , updatePhoneNumber
    , updateMessengerType
    , updateName
    , updateDescription
    , updateAorId
    , updateApiEndpoint
    , updateApiUser
    , updateSelectedApiUser
    , getPhoneForm
    , getApiForm
    , getQrData
    , getErrorMessage
    , getSuccessAccount
    , isInFormState
    , isInQrState
    , isInSuccessState
    , isInErrorState
    , getCurrentFlowType
    )

import Bindings as B


type LinkFlow
    = LinkPhone PhoneFlow
    | LinkApi ApiFlow


type PhoneFlow
    = PhoneFormState PhoneForm
    | PhoneQrCode QrData
    | PhoneSuccess B.EchoAccountF1
    | PhoneError { message : String, accountId : Int, account : B.EchoAccountF1 }


type ApiFlow
    = ApiFormState ApiForm
    | ApiSuccess B.EchoAccountF1
    | ApiError { message : String, accountId : Int, account : B.EchoAccountF1 }


type alias QrData =
    { accountId : Int, qrCode : String, account : B.EchoAccountF1 }


type alias PhoneForm =
    { messengerType : String
    , phoneNumber : String
    , name : String
    , description : String
    , aorId : Maybe Int
    }


type alias ApiForm =
    { selectedApiUser : Maybe String
    , apiEndpoint : String
    , name : String
    , description : String
    , aorId : Maybe Int
    }


defaultPhoneForm : PhoneForm
defaultPhoneForm =
    { messengerType = "signal", phoneNumber = "", name = "", description = "", aorId = Nothing }


defaultApiForm : ApiForm
defaultApiForm =
    { apiEndpoint = "", selectedApiUser = Nothing, name = "", description = "", aorId = Nothing }


initPhoneFlow : LinkFlow
initPhoneFlow =
    LinkPhone <| PhoneFormState defaultPhoneForm


initApiFlow : LinkFlow
initApiFlow =
    LinkApi <| ApiFormState defaultApiForm


isApi : LinkFlow -> Bool
isApi flow =
    case flow of
        LinkApi _ ->
            True

        LinkPhone _ ->
            False


resetFlow : LinkFlow -> LinkFlow
resetFlow flow =
    case flow of
        LinkPhone _ ->
            initPhoneFlow

        LinkApi _ ->
            initApiFlow


handleLinkResult : B.LinkAccountRsp -> LinkFlow -> LinkFlow
handleLinkResult linkRsp linkFlow =
    case linkFlow of
        LinkPhone (PhoneFormState _) ->
            LinkPhone <| PhoneQrCode { accountId = linkRsp.account.id, qrCode = "", account = linkRsp.account }

        LinkPhone _ ->
            LinkPhone <| PhoneSuccess linkRsp.account

        LinkApi _ ->
            LinkApi <| ApiSuccess linkRsp.account


updateQrCode : String -> LinkFlow -> LinkFlow
updateQrCode qrCode linkFlow =
    case linkFlow of
        LinkPhone (PhoneQrCode qrData) ->
            LinkPhone <| PhoneQrCode { qrData | qrCode = qrCode }

        _ ->
            linkFlow


-- API functions for form management

updatePhoneNumber : String -> LinkFlow -> LinkFlow
updatePhoneNumber phoneNumber linkFlow =
    case linkFlow of
        LinkPhone (PhoneFormState form) ->
            LinkPhone <| PhoneFormState { form | phoneNumber = phoneNumber }

        _ ->
            linkFlow


updateMessengerType : String -> LinkFlow -> LinkFlow
updateMessengerType messengerType linkFlow =
    case linkFlow of
        LinkPhone (PhoneFormState form) ->
            LinkPhone <| PhoneFormState { form | messengerType = messengerType }

        _ ->
            linkFlow


updateName : String -> LinkFlow -> LinkFlow
updateName name linkFlow =
    case linkFlow of
        LinkPhone (PhoneFormState form) ->
            LinkPhone <| PhoneFormState { form | name = name }

        LinkApi (ApiFormState form) ->
            LinkApi <| ApiFormState { form | name = name }

        _ ->
            linkFlow


updateDescription : String -> LinkFlow -> LinkFlow
updateDescription description linkFlow =
    case linkFlow of
        LinkPhone (PhoneFormState form) ->
            LinkPhone <| PhoneFormState { form | description = description }

        LinkApi (ApiFormState form) ->
            LinkApi <| ApiFormState { form | description = description }

        _ ->
            linkFlow


updateAorId : Maybe Int -> LinkFlow -> LinkFlow
updateAorId aorId linkFlow =
    case linkFlow of
        LinkPhone (PhoneFormState form) ->
            LinkPhone <| PhoneFormState { form | aorId = aorId }

        LinkApi (ApiFormState form) ->
            LinkApi <| ApiFormState { form | aorId = aorId }

        _ ->
            linkFlow


updateApiEndpoint : String -> LinkFlow -> LinkFlow
updateApiEndpoint apiEndpoint linkFlow =
    case linkFlow of
        LinkApi (ApiFormState form) ->
            LinkApi <| ApiFormState { form | apiEndpoint = apiEndpoint }

        _ ->
            linkFlow


updateApiUser : String -> LinkFlow -> LinkFlow
updateApiUser apiUser linkFlow =
    case linkFlow of
        LinkApi (ApiFormState form) ->
            LinkApi <| ApiFormState { form | selectedApiUser = Just apiUser }

        _ ->
            linkFlow


updateSelectedApiUser : Maybe String -> LinkFlow -> LinkFlow
updateSelectedApiUser selectedApiUser linkFlow =
    case linkFlow of
        LinkApi (ApiFormState form) ->
            LinkApi <| ApiFormState { form | selectedApiUser = selectedApiUser }

        _ ->
            linkFlow


-- Getter functions

getPhoneForm : LinkFlow -> Maybe PhoneForm
getPhoneForm linkFlow =
    case linkFlow of
        LinkPhone (PhoneFormState form) ->
            Just form

        _ ->
            Nothing


getApiForm : LinkFlow -> Maybe ApiForm
getApiForm linkFlow =
    case linkFlow of
        LinkApi (ApiFormState form) ->
            Just form

        _ ->
            Nothing


getQrData : LinkFlow -> Maybe QrData
getQrData linkFlow =
    case linkFlow of
        LinkPhone (PhoneQrCode qrData) ->
            Just qrData

        _ ->
            Nothing


getErrorMessage : LinkFlow -> Maybe String
getErrorMessage linkFlow =
    case linkFlow of
        LinkPhone (PhoneError errorData) ->
            Just errorData.message

        LinkApi (ApiError errorData) ->
            Just errorData.message

        _ ->
            Nothing


getSuccessAccount : LinkFlow -> Maybe B.EchoAccountF1
getSuccessAccount linkFlow =
    case linkFlow of
        LinkPhone (PhoneSuccess account) ->
            Just account

        LinkApi (ApiSuccess account) ->
            Just account

        _ ->
            Nothing


-- State checking functions

isInFormState : LinkFlow -> Bool
isInFormState linkFlow =
    case linkFlow of
        LinkPhone (PhoneFormState _) ->
            True

        LinkApi (ApiFormState _) ->
            True

        _ ->
            False


isInQrState : LinkFlow -> Bool
isInQrState linkFlow =
    case linkFlow of
        LinkPhone (PhoneQrCode _) ->
            True

        _ ->
            False


isInSuccessState : LinkFlow -> Bool
isInSuccessState linkFlow =
    case linkFlow of
        LinkPhone (PhoneSuccess _) ->
            True

        LinkApi (ApiSuccess _) ->
            True

        _ ->
            False


isInErrorState : LinkFlow -> Bool
isInErrorState linkFlow =
    case linkFlow of
        LinkPhone (PhoneError _) ->
            True

        LinkApi (ApiError _) ->
            True

        _ ->
            False


-- Helper function to get current flow type as string for UI
getCurrentFlowType : LinkFlow -> String
getCurrentFlowType linkFlow =
    if isApi linkFlow then
        "api"

    else
        "phone"
