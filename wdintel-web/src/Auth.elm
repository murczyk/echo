module Auth exposing
    ( User
    , onPageLoad, viewCustomPage, viewLoadingPage
    )

{-|

@docs User
@docs beforeProtectedInit

-}

import Auth.Action
import Bindings
import Dict
import Route exposing (Route)
import Route.Path
import Shared
import Shared.Components.AdminRoute
import View exposing (View)


{-| Replace the "()" with your actual User type
-}
type alias User =
    Bindings.User


{-| This function will run before any `protected` pages.

Here, you can provide logic on where to redirect if a user is not signed in. Here's an example:

    case shared.user of
        Just user ->
            ElmSpa.Provide user

        Nothing ->
            ElmSpa.RedirectTo Gen.Route.SignIn

-}
onPageLoad : Shared.Model -> Route () -> Auth.Action.Action User
onPageLoad shared route =
    case shared.user of
        Just user ->
            if user.name /= "anonymous" && Shared.Components.AdminRoute.adminRouteIsBlocked route.path user then
                Auth.Action.pushRoute
                    { path = Route.Path.Home_
                    , query = Dict.empty
                    , hash = Nothing
                    }

            else
                Auth.Action.loadPageWithUser user

        Nothing ->
            Auth.Action.pushRoute
                { path = Route.Path.Login
                , query =
                    Dict.empty
                , hash = Nothing
                }


{-| Used whenever `Auth.Action.loadCustomPage` is returned.
-}
viewCustomPage : Shared.Model -> Route () -> View Never
viewCustomPage _ _ =
    View.none


viewLoadingPage : Shared.Model -> Route () -> View Never
viewLoadingPage _ _ =
    View.none
