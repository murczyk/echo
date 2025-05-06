module Shared.Msg exposing (Msg(..))

import Bindings as B
import Le.Types exposing (ApiError, LocationRes)
import Time exposing (Posix)


type Msg
    = SignIn B.User
    | SignOut
    | SignOutDone (Result ApiError ())
    | GotUser (Result ApiError B.User)
    | GotServerInfo (Result ApiError B.ServerInfo)
    | ToggleDarkMode
    | GotLocation LocationRes
    | MasterUnitsLoadedByApi (Result ApiError B.ListUnitsRsp)
    | CallsignsInfoReturnedByApi (Result ApiError (List B.CallsignInfoRes))
    | CallsignsInfoAskedByPage (List String)
