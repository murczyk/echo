port module PagePorts.SharedPorts exposing (shared_dispatchInboxChanged, shared_getLocation, shared_getLocationRes, shared_loadLastSeenChangelog, shared_loadLastSeenChangelogRes, shared_loadRerNetworkDetailsPreferredView, shared_loadRerNetworkDetailsPreferredViewRes, shared_loadThemeMode, shared_loadThemeModeRes, shared_saveLastSeenChangelog, shared_saveRerNetworkDetailsPreferredView, shared_saveThemeMode, shared_toggleDarkMode, shared_triggerResize)

import Core.Types exposing (..)


port shared_toggleDarkMode :
    ()
    -> Cmd msg


port shared_getLocation : () -> Cmd msg


port shared_getLocationRes : (LocationRes -> msg) -> Sub msg


port shared_loadScript : String -> Cmd msg


port shared_loadScriptRes : (String -> msg) -> Sub msg


port shared_triggerResize : () -> Cmd msg


port shared_dispatchInboxChanged : List Int -> Cmd msg


port shared_saveThemeMode : String -> Cmd msg


port shared_loadThemeMode : () -> Cmd msg


port shared_loadThemeModeRes : (String -> msg) -> Sub msg


port shared_saveLastSeenChangelog : String -> Cmd msg


port shared_loadLastSeenChangelog : () -> Cmd msg


port shared_loadLastSeenChangelogRes : (String -> msg) -> Sub msg


port shared_saveRerNetworkDetailsPreferredView : String -> Cmd msg


port shared_loadRerNetworkDetailsPreferredView : () -> Cmd msg


port shared_loadRerNetworkDetailsPreferredViewRes : (String -> msg) -> Sub msg
