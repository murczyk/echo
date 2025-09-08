module Shared.Components.Watermark exposing (Watermark, new, view, withOpacity, withRotate, withFontSize, withPositioning)


import Html exposing (Html, div, text)
import Html.Attributes exposing (class, style)
import Array exposing (set)

-- Define the opaque Watermark type
type Watermark msg
    = Settings
        { text : String
        , opacity : Float
        , rotate : Float
        , fontSize : String
        , right: Int
        , top: Int
        }

-- Create a new Watermark with required properties
new : String -> Watermark msg
new text =
    Settings
        { text = text
        , opacity = 0.35
        , rotate = -45
        , fontSize = "2rem"
        , right = 5
        , top = 3
        }

-- Modifier function to set opacity
withOpacity : Float -> Watermark msg -> Watermark msg
withOpacity opacity (Settings settings) =
    Settings { settings | opacity = opacity }

-- Modifier function to set rotation
withRotate : Float -> Watermark msg -> Watermark msg
withRotate rotate (Settings settings) =
    Settings { settings | rotate = rotate }

-- Modifier function to set font size
withFontSize : String -> Watermark msg -> Watermark msg
withFontSize fontSize (Settings settings) =
    Settings { settings | fontSize = fontSize }

withPositioning: (Int, Int)-> Watermark msg -> Watermark msg
withPositioning  (top, right) (Settings settings) =
    Settings { settings | top = top, right = right }

view : Watermark msg -> Html msg
view (Settings settings) =
     div
        [ class "absolute text-watermark select-none"
        , style "top" (String.fromInt settings.top ++ "%")
        , style "right" (String.fromInt settings.right ++ "%")
        , style "opacity" (String.fromFloat settings.opacity)
        , style "transform" ("rotate(" ++ String.fromFloat settings.rotate ++ "deg)")
        , style "font-size" settings.fontSize
        , style "pointer-events" "none"
        ]
        [ text settings.text ]

