module Views exposing (h1SupLbl, headerAndContent, headerAndContentLabeled, noHeaderAndContent, noHeaderAndContentNoContainer)

import Html exposing (..)
import Html.Attributes exposing (..)
import Le.Block.Toast


headerAndContent :
    String
    -> (Le.Block.Toast.Msg -> msg)
    -> Le.Block.Toast.Model
    -> Html msg
    -> Html msg
headerAndContent title toastMsg toasts content =
    Le.Block.Toast.view toastMsg toasts <|
        div [ class "w-4/5 mx-auto px-4 pt-4" ]
            [ div [ class "flex" ]
                [ div [ class "w-full" ]
                    [ h1 [ class "py-4" ] [ text title ]
                    , content
                    ]
                ]
            ]


h1SupLbl txt =
    sup
        [ style "font-size"
            (if String.length txt > 5 then
                "1rem"

             else
                "1.2rem"
            )
        , style "display" "inline-block"
        , style "transform" "translateY(-5px)"
        , style "min-width" "60px"
        ]
        [ span [ class "inline-block px-2 py-1 text-xs font-medium bg-gray-100 text-gray-800 rounded-full" ]
            [ text txt ]
        ]


headerAndContentLabeled :
    String
    -> List (Html msg)
    -> (Le.Block.Toast.Msg -> msg)
    -> Le.Block.Toast.Model
    -> Html msg
    -> Html msg
headerAndContentLabeled title lbl toastMsg toasts content =
    Le.Block.Toast.view toastMsg toasts <|
        div [ class "w-4/5 mx-auto px-4 pt-4" ]
            [ div [ class "flex" ]
                [ div [ class "w-full p-0" ]
                    [ h1 [ class "py-2" ] <|
                        text title
                            :: lbl
                    , content
                    ]
                ]
            ]


noHeaderAndContent :
    (Le.Block.Toast.Msg -> msg)
    -> Le.Block.Toast.Model
    -> Html msg
    -> Html msg
noHeaderAndContent toastMsg toasts content =
    Le.Block.Toast.view toastMsg toasts <|
        div [ class "w-5/6 mx-auto pt-4" ]
            [ content
            ]


noHeaderAndContentNoContainer :
    (Le.Block.Toast.Msg -> msg)
    -> Le.Block.Toast.Model
    -> Html msg
    -> Html msg
noHeaderAndContentNoContainer toastMsg toasts content =
    Le.Block.Toast.view toastMsg toasts <|
        content
