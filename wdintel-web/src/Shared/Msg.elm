module Shared.Msg exposing (Msg(..))

import Bindings as B
import Le.Block.Toast
import Le.Types exposing (ApiError, LocationRes)
import Route.Path
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
    | NetworksLoadedByApi (Result ApiError (List B.Network))
    | CallsignsInfoReturnedByApi (Result ApiError (List B.CallsignInfoRes))
    | CallsignsInfoAskedByPage (List String)
    | PostLoadAll B.ListPostsReq
    | PostsReturnedByApi (Result ApiError (List B.Post))
    | TriggerResize
    | ToastMsg Le.Block.Toast.Msg
    | ShowToast String
    | ShowToastWithDetails String String
    | EventServiceStartPolling
    | EventServiceStopPolling
    | EventServicePollEvents
    | EventServiceEventsReceived (Result ApiError B.LongPollRsp)
    | EventServiceRetryPolling
    | EventServiceResetRetryCount
    | EventReceived B.EventMsg -- Event received from backend
    | SubscribeToEvents Route.Path.Path (List B.EventType) -- Page subscribes to event types
    | UnsubscribeFromEvents Route.Path.Path -- Page unsubscribes from all events
