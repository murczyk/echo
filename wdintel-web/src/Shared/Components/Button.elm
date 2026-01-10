module Shared.Components.Button exposing (new, view, withClasses, withDisabled, withIcon, withPrimary, withSecondary, withStyleSecondary, withStyleDanger)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (onClick)


-- VARIANT SYSTEM (internal)

type Variant
    = Primary
    | Secondary
    | Danger


type State
    = Active
    | Disabled


type Button msg
    = Settings
        { label : String
        , onClick : msg
        , variant : Variant
        , iconLeft : List (Html msg)
        , state : State
        , extraClasses : String
        }


-- CONSTRUCTORS

new : { label : String, onClick : msg } -> Button msg
new props =
    Settings
        { label = props.label
        , onClick = props.onClick
        , variant = Primary
        , iconLeft = []
        , state = Active
        , extraClasses = ""
        }


-- MODIFIERS

withPrimary : Button msg -> Button msg
withPrimary (Settings settings) =
    Settings { settings | variant = Primary }


withSecondary : Button msg -> Button msg
withSecondary (Settings settings) =
    Settings { settings | variant = Secondary }


withDisabled : Bool -> Button msg -> Button msg
withDisabled isDisabled (Settings settings) =
    let
        newState = if isDisabled then Disabled else Active
    in
    Settings { settings | state = newState }


withIcon : List (Html msg) -> Button msg -> Button msg
withIcon iconBlock (Settings settings) =
    Settings { settings | iconLeft = iconBlock }


withClasses : String -> Button msg -> Button msg
withClasses classes (Settings settings) =
    Settings { settings | extraClasses = classes }


-- Legacy support for existing API
withStyleSecondary : Button msg -> Button msg
withStyleSecondary (Settings settings) =
    Settings { settings | variant = Secondary }


withStyleDanger : Button msg -> Button msg
withStyleDanger (Settings settings) =
    Settings { settings | variant = Danger }


-- STYLING

variantClasses : Variant -> State -> String
variantClasses variant state =
    case (variant, state) of
        -- Primary
        (Primary, Active) ->
            "bg-[var(--color-primary)] text-[var(--color-button-text)] hover:bg-[var(--color-primary-hover)] focus:bg-[var(--color-primary-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:ring-offset-2 active:bg-[var(--color-primary-active)]"

        (Primary, Disabled) ->
            "bg-gray-300 text-gray-500 cursor-not-allowed opacity-60"

        -- Secondary
        (Secondary, Active) ->
            "bg-[var(--color-card)] text-[var(--color-action)] border border-[var(--color-action)] hover:bg-[var(--color-bg-muted)] focus:bg-[var(--color-bg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-action)] focus:ring-offset-2 active:bg-[var(--color-bg-muted)]"

        (Secondary, Disabled) ->
            "bg-[var(--color-bg-muted)] text-[var(--color-text-muted)] border border-[var(--color-border-muted)] cursor-not-allowed opacity-60"

        -- Danger
        (Danger, Active) ->
            "bg-[var(--color-error)] text-white hover:bg-[var(--color-error-hover)] focus:bg-[var(--color-error-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-error)] focus:ring-offset-2 active:bg-[var(--color-error-active)]"

        (Danger, Disabled) ->
            "bg-gray-300 text-gray-500 cursor-not-allowed opacity-60"


baseClasses : String
baseClasses =
    "px-4 py-2 rounded font-medium text-xs  flex gap-[4px] items-center justify-center transition-colors duration-200"


-- VIEW

view : Button msg -> Html msg
view (Settings settings) =
    let
        isDisabled = settings.state == Disabled

        allClasses =
            baseClasses ++ " " ++ variantClasses settings.variant settings.state ++ " " ++ settings.extraClasses
    in
    button
        [ onClick settings.onClick
        , class allClasses
        , disabled isDisabled
        ]
        [ div [] settings.iconLeft
        , text settings.label
        ]
