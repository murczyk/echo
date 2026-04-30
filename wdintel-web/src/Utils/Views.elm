module Utils.Views exposing (headerAndContent)

import Html exposing (..)
import Html.Attributes exposing (..)
import Shared.Components.Toast


headerAndContent :
    String
    -> (Shared.Components.Toast.Msg -> msg)
    -> Shared.Components.Toast.Model
    -> Html msg
    -> Html msg
headerAndContent title toastMsg toasts content =
    Shared.Components.Toast.view toastMsg toasts <|
        div [ class "w-4/5 mx-auto px-4 pt-4" ]
            [ div [ class "flex" ]
                [ div [ class "w-full" ]
                    [ h1 [ class "py-4" ] [ text title ]
                    , content
                    ]
                ]
            ]
