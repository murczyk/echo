module Le.Auth exposing (hasRole, serverModeIs)

import Bindings as B exposing (User)


{-| WARNING: need to update users/mod.rs too
-}
hasRole : String -> User -> Bool
hasRole role user =
    case role of
        "Admin" ->
            List.member "Admin" user.roles

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

        "CallsignsEditor" ->
            List.member "Admin" user.roles
                || List.member "CallsignsEditor" user.roles

        "DeleteMsg" ->
            List.member "DeleteMsg" user.roles

        _ ->
            -- impossible! unknown role
            False


serverModeIs : String -> Maybe B.ServerInfo -> Bool
serverModeIs mode mServerInfo =
    case mServerInfo of
        Nothing ->
            False

        Just serverInfo ->
            (serverInfo.mode == "debug")
                || (mode == serverInfo.mode)
