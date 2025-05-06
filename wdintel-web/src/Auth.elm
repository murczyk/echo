module Auth exposing
    ( User
    , onPageLoad, viewCustomPage
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
viewCustomPage shared route =
    View.none
