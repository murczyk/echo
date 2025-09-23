module Pages_.Admin.Messanger.LinkFlow exposing (..)

import Bindings as B


type LinkFlow
    = LinkPhone PhoneFlow
    | LinkApi ApiFlow


type PhoneFlow
    = PhoneForm PhoneForm
    | PhoneQrCode QrData
    | PhoneSuccess B.EchoAccountF1
    | PhoneError { message : String, accountId : Int, account : B.EchoAccountF1 }


type ApiFlow
    = ApiForm ApiForm
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
    { apiUser : String
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
    { apiEndpoint = "", apiUser = "", name = "", description = "", aorId = Nothing }


initPhoneFlow : LinkFlow
initPhoneFlow =
    LinkPhone <| PhoneForm defaultPhoneForm


initApiFlow : LinkFlow
initApiFlow =
    LinkApi <| ApiForm defaultApiForm


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
        LinkPhone (PhoneForm _) ->
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
