module Le.Block.Toast exposing (Level(..), Model, Msg(..), Toast, addError, addErrors, addWarning, init, overlay, update, view)

import EnumeratedList as EL exposing (EnumeratedItem, EnumeratedList)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (onClick)
import Html.Extra as HtmlX
import Task
import Time


type Msg
    = NoOp
    | CloseAll
    | AddToastGotTime { level : Level, label : String } Time.Posix


type Level
    = Error
    | Warning
    | Success


type alias Toast =
    { level : Level
    , label : String
    , created : Time.Posix
    }


type alias Model =
    { toasts : EnumeratedList Toast
    }


init : Model
init =
    { toasts = EL.fromList [] }


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        NoOp ->
            ( model, Cmd.none )

        CloseAll ->
            ( { model | toasts = EL.fromList [] }, Cmd.none )

        AddToastGotTime data t ->
            let
                new =
                    { label = data.label
                    , level = data.level
                    , created = t
                    }
            in
            ( { model | toasts = EL.fromList (EL.toList model.toasts ++ [ new ]) }, Cmd.none )


addToast :
    { toMsg : Msg -> msg
    , level : Level
    , label : String
    }
    -> Cmd msg
addToast ps =
    Cmd.map ps.toMsg (Task.perform (AddToastGotTime { level = ps.level, label = ps.label }) Time.now)


addError : (Msg -> msg) -> String -> Cmd msg
addError toMsg s =
    addToast { toMsg = toMsg, level = Error, label = s }


addWarning : (Msg -> msg) -> String -> Cmd msg
addWarning toMsg s =
    addToast { toMsg = toMsg, level = Warning, label = s }


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
        [ class "toast fade-in show mb-4"
        , classList
            [ ( "toast--warning", toastEi.el.level == Warning )
            , ( "toast--error", toastEi.el.level == Error )
            ]
        , attribute "role" "alert"
        , attribute "aria-live" "assertive"
        , attribute "aria-atomic" "true"
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

                    -- , onClick (toMsg (ClosePressed toastEi))
                    , onClick (toMsg CloseAll)
                    , class "my-2 toast-close-btn"
                    ]
                    [ i [ class "bi bi-x" ] [] ]
                ]
            ]
        , div [ class "toast-body" ]
            [ div [] [ text toastEi.el.label ]

            -- , div []
            --     [ small []
            --         [ let
            --             createdAt =
            --                 if Time.posixToMillis toastEi.el.created >= Time.posixToMillis t then
            --                     Time.millisToPosix (Time.posixToMillis toastEi.el.created - 5000)
            --                 else
            --                     toastEi.el.created
            --           in
            --           text <|
            --             Time.Distance.inWords createdAt t
            --         ]
            --     ]
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

        count =
            EL.length model.toasts
    in
    div [ class "toasts" ]
        [ div [ class "toasts__wrap" ]
            (EL.toList (EL.map (viewToast toMsg count) toasts2))
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


{-| Existing codebase still refers to `Le.Block.Toast.view` with the old
wrapper signature. We keep an alias so nothing breaks, but encourage moving
to `overlay` and eventually removing this.
-}
view : (Msg -> msg) -> Model -> Html msg -> Html msg
view =
    viewLegacy
