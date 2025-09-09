module Core.Types exposing (ApiError, GroupsActivityPerDayRsp, GroupsByDate, LocationRes, ModelWithErrorFields)

import Shared.Components.Toast
import Dict exposing (Dict)
import Http
import Time exposing (Posix)


type alias LocationRes =
    { host : String
    , hostname : String
    , href : String
    , origin : String
    , pathname : String
    , port_ : String
    , protocol : String
    , search : String
    , hash : String
    }



-- API


type alias ApiError =
    { httpError : Http.Error
    , formErrors : Dict String String
    , errors : List String
    }


type alias ModelWithErrorFields model =
    { model
        | formErrors : Dict String String
        , toasts : Shared.Components.Toast.Model
    }


type alias GroupsMessageCount =
    Dict String Int


type alias GroupsByDate =
    Dict String GroupsMessageCount


type alias GroupsActivityPerDayRsp =
    Dict String GroupsByDate
