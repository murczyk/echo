module Components.Button exposing (new, view, withDisabled, withIcon, withPrimary, withSecondary, withStyleSecondary)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (onClick)


-- VARIANT SYSTEM (internal)

type Variant
    = Primary
    | Secondary


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


-- Legacy support for existing API
withStyleSecondary : Button msg -> Button msg
withStyleSecondary (Settings settings) =
    Settings { settings | variant = Secondary }


-- STYLING

variantClasses : Variant -> State -> String
variantClasses variant state =
    case (variant, state) of
        -- Primary
        (Primary, Active) ->
            "bg-[#2c6c91] text-white hover:bg-[#245a7a] focus:bg-[#245a7a] focus:outline-none focus:ring-2 focus:ring-[#2c6c91] focus:ring-offset-2 active:bg-[#1e4c66]"
        
        (Primary, Disabled) ->
            "bg-gray-300 text-gray-500 cursor-not-allowed opacity-60"
        
        -- Secondary
        (Secondary, Active) ->
            "bg-white text-[#2c6c91] border border-[#2c6c91] hover:bg-[#f8fafc] focus:bg-[#f8fafc] focus:outline-none focus:ring-2 focus:ring-[#2c6c91] focus:ring-offset-2 active:bg-[#f1f5f9]"
        
        (Secondary, Disabled) ->
            "bg-gray-50 text-gray-400 border border-gray-300 cursor-not-allowed opacity-60"


baseClasses : String
baseClasses =
    "px-4 py-2 rounded font-medium text-xs  flex gap-[4px] items-center justify-center transition-colors duration-200"


-- VIEW

view : Button msg -> Html msg
view (Settings settings) =
    let
        isDisabled = settings.state == Disabled
        
        allClasses = 
            baseClasses ++ " " ++ variantClasses settings.variant settings.state
    in
    button
        [ onClick settings.onClick
        , class allClasses
        , disabled isDisabled
        ]
        [ div [] settings.iconLeft
        , text settings.label
        ]
