module Pages_.Admin.Messenger.LinkFlow exposing
    ( ApiForm
    , FlowType
    , LinkFlow
    , PhoneForm
    , QrData
    , flowTypeToString
    , getApiForm
    , getCurrentFlowType
    , getErrorMessage
    , getPhoneForm
    , getQrData
    , getSuccessAccount
    , handleLinkResult
    , initApiFlow
    , initPhoneFlow
    , isApi
    , isApiFlowType
    , isInErrorState
    , isInFormState
    , isInQrState
    , isInSuccessState
    , isPhoneFlowType
    , markError
    , resetFlow
    , stringToFlowType
    , updateAorId
    , updateApiEndpoint
    , updateDescription
    , updateMessengerType
    , updateName
    , updatePhoneNumber
    , updateQrCode
    , updateSelectedApiUser
    )

import Bindings as B


type FlowType
    = PhoneFlow
    | ApiFlow


type LinkFlow
    = LinkPhone PhoneFlow
    | LinkApi ApiFlow


type PhoneFlow
    = PhoneFormState PhoneForm
    | PhoneQrCode QrData
    | PhoneSuccess B.EchoAccountF1
    | PhoneError String


type ApiFlow
    = ApiFormState ApiForm
    | ApiSuccess B.EchoAccountF1
    | ApiError String


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


markError : String -> LinkFlow -> LinkFlow
markError message linkFlow =
    case linkFlow of
        LinkPhone _ ->
            LinkPhone <| PhoneError message

        LinkApi _ ->
            LinkApi <| ApiError message


updateQrCode : String -> LinkFlow -> LinkFlow
updateQrCode qrCode linkFlow =
    case linkFlow of
        LinkPhone (PhoneQrCode qrData) ->
            LinkPhone <| PhoneQrCode { qrData | qrCode = qrCode }

        _ ->
            linkFlow


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


updateSelectedApiUser : Maybe String -> LinkFlow -> LinkFlow
updateSelectedApiUser selectedApiUser linkFlow =
    case linkFlow of
        LinkApi (ApiFormState form) ->
            LinkApi <| ApiFormState { form | selectedApiUser = selectedApiUser }

        _ ->
            linkFlow


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
        LinkPhone (PhoneError message) ->
            Just message

        LinkApi (ApiError message) ->
            Just message

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


getCurrentFlowType : LinkFlow -> FlowType
getCurrentFlowType linkFlow =
    if isApi linkFlow then
        ApiFlow

    else
        PhoneFlow


flowTypeToString : FlowType -> String
flowTypeToString flowType =
    case flowType of
        PhoneFlow ->
            "phone"

        ApiFlow ->
            "api"


stringToFlowType : String -> Maybe FlowType
stringToFlowType str =
    case str of
        "phone" ->
            Just PhoneFlow

        "api" ->
            Just ApiFlow

        _ ->
            Nothing


isPhoneFlowType : FlowType -> Bool
isPhoneFlowType flowType =
    case flowType of
        PhoneFlow ->
            True

        ApiFlow ->
            False


isApiFlowType : FlowType -> Bool
isApiFlowType flowType =
    case flowType of
        ApiFlow ->
            True

        PhoneFlow ->
            False
