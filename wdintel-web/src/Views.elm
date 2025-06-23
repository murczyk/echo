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
        div [ class "container-xxl bd-gutter pt-md-1 main-container" ]
            [ div [ class "row" ]
                [ div [ class "col-12" ]
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
        [ span [ class "badge rounded-pill text-bg-light" ]
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
        div [ class "container-xxl bd-gutter pt-md-1 main-container" ]
            [ div [ class "row" ]
                [ div [ class "col-12 p-0" ]
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
        div [ class "w-4/5 mx-auto pt-4" ]
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
