module Shared.Components.AuthorLabel exposing (view, sender)

import Html exposing (Html, node)
import Html.Attributes exposing (attribute)


view : String -> Html msg
view login =
    node "echo-author-label" [ attribute "login" login ] []


sender : String -> String -> Html msg
sender accountId fallback =
    node "echo-author-label"
        [ attribute "account-id" accountId, attribute "fallback" fallback ]
        []
