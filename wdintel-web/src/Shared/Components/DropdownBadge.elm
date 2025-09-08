module Shared.Components.DropdownBadge exposing
    ( Config
    , DropdownAction(..)
    , DropdownDirection(..)
    , config
    , withAutoDirection
    , view
    )

import Html exposing (Html, a, button, div, i, span, text)
import Html.Attributes exposing (class, href, target, title)
import Html.Events exposing (onClick, stopPropagationOn)
import Json.Decode as Decode


-- TYPES


type DropdownAction msg
    = ExternalLink
        { icon : String
        , label : String
        , url : String
        }
    | InternalAction
        { icon : String
        , label : String
        , action : msg
        }


type DropdownDirection
    = Up
    | Down

type alias Config msg =
    { text : String
    , isOpen : Bool
    , onToggle : msg
    , onClose : msg
    , actions : List (DropdownAction msg)
    , badgeClass : String
    , forceDirection : Maybe DropdownDirection
    }


-- CONFIG


config : String -> Bool -> msg -> msg -> List (DropdownAction msg) -> Config msg
config text_ isOpen onToggle onClose actions =
    { text = text_
    , isOpen = isOpen
    , onToggle = onToggle
    , onClose = onClose
    , actions = actions
    , badgeClass = "px-2 py-1 bg-[var(--color-primary-light)] hover:bg-[var(--color-primary-light-hover)] hover:shadow-md text-[var(--color-primary-dark)] rounded cursor-pointer transition-all duration-200 flex items-center gap-1"
    , forceDirection = Nothing
    }

withAutoDirection : DropdownDirection -> Config msg -> Config msg
withAutoDirection direction cfg =
    { cfg | forceDirection = Just direction }


-- VIEW


view : Config msg -> Html msg
view cfg =
    div
        [ class "relative inline-block"
        , stopPropagationOn "click" (Decode.succeed ( cfg.onToggle, True ))
        ]
        [ button
            [ class cfg.badgeClass
            , title "Клікніть для дій"
            ]
            [ text cfg.text
            , span [ class "opacity-70" ] [ text "⋮" ]
            ]
        , if cfg.isOpen then
            viewDropdown cfg.actions cfg.onClose cfg.forceDirection
          else
            text ""
        ]


viewDropdown : List (DropdownAction msg) -> msg -> Maybe DropdownDirection -> Html msg
viewDropdown actions onClose direction =
    let
        (positionClass, marginClass) =
            case direction of
                Just Up ->
                    ( "bottom-full left-0 mb-1", "mb-1" )

                Just Down ->
                    ( "top-full left-0 mt-1", "mt-1" )

                Nothing ->
                    ( "top-full left-0 mt-1", "mt-1" )
    in
    div
        [ class ("absolute " ++ positionClass ++ " bg-[var(--color-card)] border border-[var(--color-border-muted)] rounded shadow-lg z-50 min-w-[160px]")
        ]
        (List.map viewAction actions)


viewAction : DropdownAction msg -> Html msg
viewAction dropdownAction =
    case dropdownAction of
        ExternalLink { icon, label, url } ->
            a
                [ class "w-full px-3 py-2 text-left hover:bg-[var(--color-bg-muted)] text-sm flex items-center gap-2 text-[var(--color-text)] no-underline"
                , href url
                , target "_blank"
                ]
                [ i [ class ("bi " ++ icon) ] []
                , text label
                ]

        InternalAction { icon, label, action } ->
            button
                [ class "w-full px-3 py-2 text-left hover:bg-[var(--color-bg-muted)] text-sm flex items-center gap-2 text-[var(--color-text)]"
                , onClick action
                ]
                [ i [ class ("bi " ++ icon) ] []
                , text label
                ]
