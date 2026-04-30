module Shared.Components.Toast exposing (Level(..), Model, Msg(..), Toast, ToastV2, addError, addErrorV2, addErrors, addWarning, init, overlay, update, view)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (onClick)
import Html.Extra as HtmlX
import Task
import Time
import Utils.EnumeratedList as EL exposing (EnumeratedItem, EnumeratedList)


type Msg
    = NoOp
    | CloseAll
    | AddToastGotTime { level : Level, label : String } Time.Posix
    | AddToastV2GotTime { level : Level, title : String, content : String } Time.Posix


type Level
    = Error
    | Warning
    | Success


type alias Toast =
    { level : Level
    , label : String
    , created : Time.Posix
    }


type alias ToastV2 =
    { level : Level
    , title : String
    , content : String
    , created : Time.Posix
    }


type alias Model =
    { toasts : EnumeratedList Toast
    , toastsV2 : EnumeratedList ToastV2
    }


init : Model
init =
    { toasts = EL.fromList []
    , toastsV2 = EL.fromList []
    }


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        NoOp ->
            ( model, Cmd.none )

        CloseAll ->
            ( { model | toasts = EL.fromList [], toastsV2 = EL.fromList [] }, Cmd.none )

        AddToastGotTime data t ->
            let
                new =
                    { label = data.label
                    , level = data.level
                    , created = t
                    }
            in
            ( { model | toasts = EL.fromList (EL.toList model.toasts ++ [ new ]) }, Cmd.none )

        AddToastV2GotTime data t ->
            let
                new =
                    { title = data.title
                    , content = data.content
                    , level = data.level
                    , created = t
                    }
            in
            ( { model | toastsV2 = EL.fromList (EL.toList model.toastsV2 ++ [ new ]) }, Cmd.none )


addToast :
    { toMsg : Msg -> msg
    , level : Level
    , label : String
    }
    -> Cmd msg
addToast ps =
    Cmd.map ps.toMsg (Task.perform (AddToastGotTime { level = ps.level, label = ps.label }) Time.now)


addToastV2 :
    { toMsg : Msg -> msg
    , level : Level
    , title : String
    , content : String
    }
    -> Cmd msg
addToastV2 ps =
    Cmd.map ps.toMsg (Task.perform (AddToastV2GotTime { level = ps.level, title = ps.title, content = ps.content }) Time.now)


{-| Add error toast with separate title and content (V2 API)
-}
addErrorV2 : (Msg -> msg) -> String -> String -> Cmd msg
addErrorV2 toMsg title content =
    addToastV2 { toMsg = toMsg, level = Error, title = title, content = content }


{-| Legacy function - adds error toast with single label (backward compatibility)
-}
addError : (Msg -> msg) -> String -> Cmd msg
addError toMsg label =
    addToast { toMsg = toMsg, level = Error, label = label }


{-| Legacy function - adds warning toast with single label (backward compatibility)
-}
addWarning : (Msg -> msg) -> String -> Cmd msg
addWarning toMsg label =
    addToast { toMsg = toMsg, level = Warning, label = label }


addErrors : (Msg -> msg) -> List String -> Cmd msg
addErrors toMsg xs =
    Cmd.batch (List.map (addError toMsg) xs)


viewToast :
    (Msg -> msg)
    -> Int
    -> EnumeratedItem Toast
    -> Html msg
viewToast toMsg count toastEi =
    let
        headerLabel =
            case toastEi.el.level of
                Warning ->
                    "Уважно"

                Error ->
                    "Помилка"

                Success ->
                    "Успіх"
    in
    div
        [ class "toast fade-in show"
        , classList
            [ ( "toast--warning", toastEi.el.level == Warning )
            , ( "toast--error", toastEi.el.level == Error )
            ]
        , attribute "role" "alert"
        , attribute "aria-live" "assertive"
        , attribute "aria-atomic" "true"
        , style "transform" "translateY(0)"
        , style "opacity" "1"
        , style "transition" "all 0.3s ease-in-out"
        , style "animation" "slideInFromTop 0.3s ease-out"
        , style "margin-bottom" "0"
        , style "min-width" "280px"
        , style "max-width" "400px"
        ]
        [ div [ class "toast-header" ]
            [ strong [ class "mr-auto" ] [ text headerLabel ]
            , div [ class "d-flex justify-content-center align-items-center" ]
                [ HtmlX.viewIf (count > 1) <|
                    div
                        [ class "badge rounded-pill text-bg-secondary me-1"
                        , style "font-size" ".6rem"
                        ]
                        [ text <| String.fromInt count
                        ]
                , span
                    [ attribute "aria-hidden" "true"
                    , onClick (toMsg CloseAll)
                    , class "my-2 toast-close-btn"
                    ]
                    [ i [ class "bi bi-x" ] [] ]
                ]
            ]
        , div [ class "toast-body" ]
            [ div [] [ text toastEi.el.label ]
            ]
        ]


viewToastV2 :
    (Msg -> msg)
    -> Int
    -> EnumeratedItem ToastV2
    -> Html msg
viewToastV2 toMsg count toastEi =
    div
        [ class "toast fade-in show"
        , classList
            [ ( "toast--warning", toastEi.el.level == Warning )
            , ( "toast--error", toastEi.el.level == Error )
            ]
        , attribute "role" "alert"
        , attribute "aria-live" "assertive"
        , attribute "aria-atomic" "true"
        , style "transform" "translateY(0)"
        , style "opacity" "1"
        , style "transition" "all 0.3s ease-in-out"
        , style "animation" "slideInFromTop 0.3s ease-out"
        , style "margin-bottom" "0"
        , style "min-width" "280px"
        , style "max-width" "400px"
        ]
        [ div [ class "toast-header" ]
            [ strong [ class "mr-auto" ] [ text toastEi.el.title ]
            , div [ class "d-flex justify-content-center align-items-center" ]
                [ HtmlX.viewIf (count > 1) <|
                    div
                        [ class "badge rounded-pill text-bg-secondary me-1"
                        , style "font-size" ".6rem"
                        ]
                        [ text <| String.fromInt count
                        ]
                , span
                    [ attribute "aria-hidden" "true"
                    , onClick (toMsg CloseAll)
                    , class "my-2 toast-close-btn"
                    ]
                    [ i [ class "bi bi-x" ] [] ]
                ]
            ]
        , div [ class "toast-body" ]
            [ div [] [ text toastEi.el.content ]
            ]
        ]


{-| New overlay-only view. Returns HTML with toast notifications positioned absolutely/fixed.
Use this from pages/layouts **in addition** to your main content. Does not wrap or influence layout size.
-}
overlay : (Msg -> msg) -> Model -> Html msg
overlay toMsg model =
    let
        toasts2 =
            EL.drop (EL.length model.toasts - 1) model.toasts

        toastsV2_2 =
            EL.drop (EL.length model.toastsV2 - 1) model.toastsV2

        count =
            EL.length model.toasts + EL.length model.toastsV2
    in
    div []
        [ node "style"
            []
            [ text """
                @keyframes slideInFromTop {
                    from {
                        transform: translateY(-100%);
                        opacity: 0;
                    }
                    to {
                        transform: translateY(0);
                        opacity: 1;
                    }
                }

                @keyframes slideOutToTop {
                    from {
                        transform: translateY(0);
                        opacity: 1;
                    }
                    to {
                        transform: translateY(-100%);
                        opacity: 0;
                    }
                }
            """ ]
        , div
            [ class "toasts"
            , style "position" "fixed"
            , style "top" "60px"
            , style "right" "20px"
            , style "z-index" "1000"
            , style "pointer-events" "none"
            ]
            [ div
                [ class "toasts__wrap"
                , style "pointer-events" "auto"
                , style "display" "flex"
                , style "flex-direction" "column"
                , style "gap" "8px"
                ]
                (List.concat
                    [ EL.toList (EL.map (viewToast toMsg count) toasts2)
                    , EL.toList (EL.map (viewToastV2 toMsg count) toastsV2_2)
                    ]
                )
            ]
        ]


{-| Legacy wrapper that embeds `overlay` plus given `inner` content into `div.h-full`.
Deprecated: prefer using `overlay` directly.
-}
viewLegacy : (Msg -> msg) -> Model -> Html msg -> Html msg
viewLegacy toMsg model inner =
    div [ class "h-full" ]
        [ overlay toMsg model
        , inner
        ]



-- BACKWARD COMPATIBILITY ---------------------------------------------------


{-| Existing codebase still refers to `Shared.Components.Toast.view` with the old
wrapper signature. We keep an alias so nothing breaks, but encourage moving
to `overlay` and eventually removing this.
-}
view : (Msg -> msg) -> Model -> Html msg -> Html msg
view =
    viewLegacy
