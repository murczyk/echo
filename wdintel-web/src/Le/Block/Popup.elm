module Le.Block.Popup exposing (Placement(..), Popup(..), new, view, withCloseButton, withFakeAnchor, withPlacementBottom, withPlacementTop, withSkidding)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)


type Popup msg
    = Settings
        { body : Html msg
        , popupBody : Html msg
        , isOpen : Bool
        , onOpen : msg
        , onClose : msg
        , placement : Placement
        , skidding : String
        , withOverlay : Bool
        , withFakeAnchor : Bool
        , withCloseButton : Bool
        , disabled : Bool
        }


type Placement
    = Bottom
    | Right
    | Top


new :
    { body : Html msg
    , popupBody : Html msg
    , isOpen : Bool
    , onOpen : msg
    , onClose : msg
    , disabled : Bool
    }
    -> Popup msg
new props =
    Settings
        { body = props.body
        , popupBody = props.popupBody
        , isOpen = props.isOpen
        , onOpen = props.onOpen
        , onClose = props.onClose
        , placement = Right
        , withOverlay = True
        , withFakeAnchor = False
        , withCloseButton = False
        , disabled = props.disabled
        , skidding = "0"
        }


withPlacementBottom : Popup msg -> Popup msg
withPlacementBottom (Settings settings) =
    Settings { settings | placement = Bottom }


withPlacementTop : Popup msg -> Popup msg
withPlacementTop (Settings settings) =
    Settings { settings | placement = Top }


withFakeAnchor : Popup msg -> Popup msg
withFakeAnchor (Settings settings) =
    Settings { settings | withFakeAnchor = True }


withCloseButton : Popup msg -> Popup msg
withCloseButton (Settings settings) =
    Settings { settings | withCloseButton = True }


withSkidding : String -> Popup msg -> Popup msg
withSkidding skidding (Settings settings) =
    Settings { settings | skidding = skidding }


view : Popup msg -> Html msg
view (Settings settings) =
    let
        bodyWithClickHandler =
            div
                ((if not settings.disabled then
                    [ onClick settings.onOpen ]

                  else
                    []
                 )
                    ++ (if settings.isOpen then
                            [ style "position" "relative", style "z-index" "30" ]

                        else
                            []
                       )
                )
                [ settings.body ]
    in
    div [ class "d-flex" ]
        [ if settings.withFakeAnchor then
            bodyWithClickHandler

          else
            text ""
        , div [ style "position" "relative", style "z-index" "30" ]
            [ node
                "sl-popup"
                ([ attribute "strategy" "fixed"
                 , attribute "distance" "10"
                 , attribute "flip" ""
                 , attribute "shift" ""
                 , attribute "shift-padding" "10"
                 , attribute "skidding" settings.skidding
                 ]
                    ++ (if settings.isOpen then
                            [ attribute "active" "" ]

                        else
                            []
                       )
                    ++ (if settings.placement == Right then
                            [ attribute "placement" "right" ]

                        else if settings.placement == Bottom then
                            [ attribute "placement" "bottom" ]

                        else
                            []
                       )
                )
                [ div [ attribute "slot" "anchor" ]
                    [ if not settings.withFakeAnchor then
                        bodyWithClickHandler

                      else
                        text ""
                    ]
                , div
                    [ class "popup-body" ]
                    (settings.popupBody
                        :: (if settings.withCloseButton then
                                [ button
                                    [ class "btn-close"
                                    , style "font-size" "18px"
                                    , type_ "button"
                                    , attribute "data-bs-dismiss" "popup"
                                    , attribute "ariaLabel" "Close"
                                    , onClick settings.onClose
                                    ]
                                    []
                                ]

                            else
                                [ text "" ]
                           )
                    )
                ]
            ]
        , if settings.isOpen && settings.withOverlay then
            div [ class "popup-overlay", style "z-index" "20", onClick settings.onClose ] []

          else
            text ""
        ]
