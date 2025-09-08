module Shared.Components.ModalDialog exposing (modalDialog)
import Html exposing (Html, Attribute, div, node)
import Html.Attributes exposing (class, attribute)
import Html.Events exposing (on)
import Json.Decode as D


onClose : msg -> Attribute msg
onClose message =
  on "close" (D.succeed message)

modalDialog : Bool -> msg -> List (Attribute msg) -> List (Html msg) -> Html msg
modalDialog isOpen closeMsg attributes children =
    node "modal-dialog" (if isOpen then [ attribute "open" ""] else [])
        [ node "dialog" ((onClose closeMsg) :: attributes) <|
            (div [ class "modal-filler"] []) :: children
        ]
