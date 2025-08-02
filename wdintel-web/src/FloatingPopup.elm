module FloatingPopup exposing 
    ( FloatingPopup
    , Placement(..)
    , new
    , view
    , withPlacement
    , withOverlay
    , withoutOverlay
    )

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Json.Decode as Decode


-- TYPES


type FloatingPopup msg
    = Settings
        { anchorContent : Html msg
        , popupContent : Html msg
        , isOpen : Bool
        , onOpen : msg
        , onClose : msg
        , placement : Placement
        , withOverlay : Bool
        }


type Placement
    = Top
    | Bottom
    | Left
    | Right


-- CONSTRUCTOR


new :
    { anchorContent : Html msg
    , popupContent : Html msg
    , isOpen : Bool
    , onOpen : msg
    , onClose : msg
    }
    -> FloatingPopup msg
new props =
    Settings
        { anchorContent = props.anchorContent
        , popupContent = props.popupContent
        , isOpen = props.isOpen
        , onOpen = props.onOpen
        , onClose = props.onClose
        , placement = Bottom
        , withOverlay = True
        }


-- BUILDER METHODS


withPlacement : Placement -> FloatingPopup msg -> FloatingPopup msg
withPlacement placement (Settings settings) =
    Settings { settings | placement = placement }


withOverlay : FloatingPopup msg -> FloatingPopup msg
withOverlay (Settings settings) =
    Settings { settings | withOverlay = True }


withoutOverlay : FloatingPopup msg -> FloatingPopup msg
withoutOverlay (Settings settings) =
    Settings { settings | withOverlay = False }


-- VIEW


view : FloatingPopup msg -> Html msg
view (Settings settings) =
    node "floating-popup"
        (buildAttributes settings)
        [ div [ attribute "slot" "anchor" ]
            [ div [ onClick settings.onOpen ]
                [ settings.anchorContent ]
            ]
        , div [ attribute "slot" "content", class "floating-popup-content" ]
            [ settings.popupContent ]
        ]


-- HELPERS


buildAttributes : { anchorContent : Html msg, popupContent : Html msg, isOpen : Bool, onOpen : msg, onClose : msg, placement : Placement, withOverlay : Bool } -> List (Attribute msg)
buildAttributes settings =
    [ attribute "placement" (placementToString settings.placement)
    , onCustomEvent "popup-close" settings.onClose
    , onCustomEvent "popup-open" settings.onOpen
    ]
        ++ (if settings.isOpen then
                [ attribute "open" "" ]
            else
                []
           )
        ++ (if settings.withOverlay then
                [ attribute "overlay" "" ]
            else
                []
           )


placementToString : Placement -> String
placementToString placement =
    case placement of
        Top ->
            "top"

        Bottom ->
            "bottom"

        Left ->
            "left"

        Right ->
            "right"


onCustomEvent : String -> msg -> Attribute msg
onCustomEvent eventName msg =
    on eventName (Decode.succeed msg)