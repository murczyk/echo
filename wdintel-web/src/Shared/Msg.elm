module Shared.Msg exposing (Msg(..), ChangelogReleaseMeta, ChangelogReleasePage)

import Bindings as B
import Core.Types exposing (ApiError, LocationRes)
import Route.Path
import Shared.Components.Toast
import Shared.Model exposing (ThemeMode)


type alias ChangelogReleaseMeta =
    { releaseId : String
    , title : String
    }


type alias ChangelogReleasePage =
    { releaseId : String
    , headings : List String
    }


type Msg
    = SignIn B.User
    | SignOut
    | SignOutDone (Result ApiError ())
    | GotUser (Result ApiError B.User)
    | GotServerInfo (Result ApiError B.ServerInfo)
    | GotChangelogIndex (Result ApiError (List ChangelogReleaseMeta))
    | GotChangelogLatest (Result ApiError ChangelogReleasePage)
    | SetThemeMode ThemeMode
    | ThemeModeLoaded String
    | RerNetworkDetailsPreferredViewLoaded String
    | SetRerNetworkDetailsPreferredView Shared.Model.RerNetworkDetailsPreferredView
    | ToggleDarkMode
    | LastSeenChangelogLoaded String
    | SaveChangelogLastSeen String
    | GotLocation LocationRes
    | MasterUnitsLoadedByApi (Result ApiError B.ListUnitsRsp)
    | NetworksLoadedByApi (Result ApiError (List B.Network))
    | CallsignsInfoReturnedByApi (Result ApiError (List B.CallsignInfoRes))
    | CallsignsInfoAskedByPage (List String)
    | PostLoadAll B.ListPostsReq
    | PostsReturnedByApi (Result ApiError (List B.Post))
    | TriggerResize
    | ToastMsg Shared.Components.Toast.Msg
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
