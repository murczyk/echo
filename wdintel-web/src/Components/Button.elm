module Components.Button exposing (new, view, withDisabled, withIcon, withOutlined, withStyleSecondary)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (onClick)


type Button msg
    = Settings
        { label : String
        , onClick : msg
        , style : Style
        , iconLeft : List (Html msg)
        , isDisabled : Bool
        , isOutlined : Bool
        }


new : { label : String, onClick : msg } -> Button msg
new props =
    Settings
        { label = props.label
        , onClick = props.onClick
        , style = Primary
        , iconLeft = []
        , isDisabled = False
        , isOutlined = False
        }


type Style
    = Primary
    | Secondary


withStyleSecondary : Button msg -> Button msg
withStyleSecondary (Settings settings) =
    Settings { settings | style = Secondary }


withDisabled : Bool -> Button msg -> Button msg
withDisabled isDisabled (Settings settings) =
    Settings { settings | isDisabled = isDisabled }


withOutlined : Bool -> Button msg -> Button msg
withOutlined isOutlined (Settings settings) =
    Settings { settings | isOutlined = isOutlined }


withIcon : List (Html msg) -> Button msg -> Button msg
withIcon iconBlock (Settings settings) =
    Settings { settings | iconLeft = iconBlock }


view : Button msg -> Html msg
view (Settings settings) =
    button
        [ onClick settings.onClick
        , class "border-1 rounded-[6px]! leading-[120%]! font-medium px-[16px] py-[8px] flex gap-[4px] items-center cursor-pointer disabled:bg-[var(--neutral-400)] disabled:cursor-default disabled:border-[var(--neutral-400)]"
        , classList
            [ ( "bg-w dark:bg-background border-action text-action ", settings.style == Primary && settings.isOutlined == True )
            , ( "bg-action border-action text-button-text", settings.style == Primary && settings.isOutlined == False )
            , ( "bg-transparent", settings.style == Secondary )
            ]
        , disabled settings.isDisabled
        ]
        [ div [] settings.iconLeft
        , text settings.label
        ]
