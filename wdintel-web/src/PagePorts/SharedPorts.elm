port module PagePorts.SharedPorts exposing (shared_getLocation, shared_getLocationRes, shared_loadThemeMode, shared_loadThemeModeRes, shared_saveThemeMode, shared_toggleDarkMode, shared_triggerResize)

import Core.Types exposing (..)


port shared_toggleDarkMode :
    ()
    -> Cmd msg


port shared_getLocation : () -> Cmd msg


port shared_getLocationRes : (LocationRes -> msg) -> Sub msg


port shared_loadScript : String -> Cmd msg


port shared_loadScriptRes : (String -> msg) -> Sub msg


port shared_triggerResize : () -> Cmd msg


port shared_saveThemeMode : String -> Cmd msg


port shared_loadThemeMode : () -> Cmd msg


port shared_loadThemeModeRes : (String -> msg) -> Sub msg
