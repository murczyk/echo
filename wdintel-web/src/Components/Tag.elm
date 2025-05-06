module Components.Tag exposing (new, view, withActive, withBadge)

import Components.Badge as Badge
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)


type Config msg
    = Config
        { isActive : Bool
        , onToggle : msg
        , isDisabled : Bool
        , withBadge : Maybe String
        }


new : { isActive : Bool, onToggle : msg } -> Config msg
new options =
    Config
        { isActive = options.isActive
        , isDisabled = False
        , onToggle = options.onToggle
        , withBadge = Nothing
        }


withActive : Bool -> Config msg -> Config msg
withActive isActive (Config config) =
    Config { config | isActive = isActive }


withBadge : String -> Config msg -> Config msg
withBadge badgeValue (Config config) =
    Config { config | withBadge = Just badgeValue }


view : String -> Config msg -> Html msg
view label (Config config) =
    div
        [ class " border-1 border-border rounded-sm text-text py-1 px-2 pointer relative"
        , classList
            [ ( "bg-tag-selected border-1 border-border-selected", config.isActive )
            , ( "hover-unmuted bg-tag", not config.isActive )
            ]
        , onClick <| config.onToggle
        ]
        [ String.uncons label
            |> Maybe.map (\( head, tail ) -> String.cons (Char.toUpper head) tail)
            |> Maybe.withDefault ""
            |> text
        , case config.withBadge of
            Just v ->
                span [ class "absolute top-0 transform  -translate-y-1/2 z-1" ] [ Badge.view v ]

            Nothing ->
                text ""
        ]
