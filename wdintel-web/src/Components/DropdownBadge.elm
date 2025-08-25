module Components.DropdownBadge exposing 
    ( Config
    , DropdownAction
    , config
    , view
    )

import Html exposing (Html, button, div, i, span, text)
import Html.Attributes exposing (class, title)
import Html.Events exposing (onClick, stopPropagationOn)
import Json.Decode as Decode


-- TYPES


type alias DropdownAction msg =
    { icon : String
    , label : String
    , onClick : msg
    , color : String
    }


type alias Config msg =
    { text : String
    , isOpen : Bool
    , onToggle : msg
    , onClose : msg
    , actions : List (DropdownAction msg)
    , badgeClass : String
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
    }


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
            viewDropdown cfg.actions cfg.onClose
          else
            text ""
        ]


viewDropdown : List (DropdownAction msg) -> msg -> Html msg
viewDropdown actions onClose =
    div
        [ class "absolute top-full left-0 mt-1 bg-[var(--color-card)] border border-[var(--color-border-muted)] rounded shadow-lg z-50 min-w-[160px]"
        ]
        (List.map viewAction actions)


viewAction : DropdownAction msg -> Html msg
viewAction action =
    button
        [ class ("w-full px-3 py-2 text-left hover:bg-[var(--color-bg-muted)] text-sm flex items-center gap-2 " ++ action.color)
        , onClick action.onClick
        ]
        [ i [ class ("bi " ++ action.icon) ] []
        , text action.label
        ]
