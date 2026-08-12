module Shared.Components.AdminRoute exposing (adminRouteIsBlocked)

import Bindings as B
import Core.Auth
import Route.Path
import String


adminRouteIsBlocked : Route.Path.Path -> B.User -> Bool
adminRouteIsBlocked path user =
    isAdminRoutePath path && not (adminMenuIsVisible user)


adminMenuIsVisible : B.User -> Bool
adminMenuIsVisible user =
    Core.Auth.hasRole "Admin" user


isAdminRoutePath : Route.Path.Path -> Bool
isAdminRoutePath path =
    let
        pathString =
            Route.Path.toString path
    in
    pathString == "/admin" || String.startsWith "/admin/" pathString
