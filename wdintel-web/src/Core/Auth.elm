module Core.Auth exposing (canReadDevices, hasRole, serverModeIs)

import Bindings as B exposing (User)


{-| WARNING: need to update users/mod.rs too
-}
hasRole : String -> User -> Bool
hasRole role user =
    case role of
        "Admin" ->
            List.member "Admin" user.roles

        "Api" ->
            List.member "Api" user.roles

        "ApiAgent" ->
            List.member "ApiAgent" user.roles

        "Full" ->
            List.member "Admin" user.roles
                || List.member "Full" user.roles

        "Rer" ->
            List.member "Admin" user.roles
                || List.member "Full" user.roles
                || List.member "Rer" user.roles

        "Bpla" ->
            List.member "Admin" user.roles
                || List.member "Full" user.roles
                || List.member "Bpla" user.roles

        "Basic" ->
            List.member "Admin" user.roles
                || List.member "Full" user.roles
                || List.member "Bpla" user.roles
                || List.member "Rer" user.roles
                || List.member "Basic" user.roles

        "UnitsEditor" ->
            List.member "Admin" user.roles
                || List.member "UnitsEditor" user.roles

        "NetworkEditor" ->
            List.member "Admin" user.roles
                || List.member "NetworkEditor" user.roles

        "CallsignsEditor" ->
            List.member "Admin" user.roles
                || List.member "CallsignsEditor" user.roles

        "Cyber" ->
            List.member "Admin" user.roles
                || List.member "Cyber" user.roles

        "DeviceSource" ->
            List.member "Admin" user.roles
                || List.member "DeviceSource" user.roles
                || List.member "DeviceAnalyst" user.roles

        "DeviceAnalyst" ->
            List.member "Admin" user.roles
                || List.member "DeviceAnalyst" user.roles

        "AdvancedReports" ->
            List.member "Admin" user.roles
                || List.member "AdvancedReports" user.roles

        "Orbit" ->
            List.member "Admin" user.roles
                || List.member "Orbit" user.roles

        "DeleteMsg" ->
            List.member "Admin" user.roles
                || List.member "Full" user.roles
                || List.member "DeleteMsg" user.roles

        "NoAutoLogout" ->
            List.member "NoAutoLogout" user.roles

        _ ->
            -- impossible! unknown role
            False


canReadDevices : User -> Bool
canReadDevices user =
    hasRole "Cyber" user
        || hasRole "DeviceSource" user
        || hasRole "DeviceAnalyst" user


serverModeIs : String -> Maybe B.ServerInfo -> Bool
serverModeIs mode mServerInfo =
    case mServerInfo of
        Nothing ->
            False

        Just serverInfo ->
            (serverInfo.mode == "debug")
                || (mode == serverInfo.mode)
