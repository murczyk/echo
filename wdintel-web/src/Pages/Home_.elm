module Pages.Home_ exposing (Model, Msg, page)

import Auth
import Core.Auth
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (on)
import Json.Decode as Decode
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Shared
import View exposing (View)


type alias Model =
    { aiChatEnabled : Maybe Bool
    }


type Msg
    = AiChatAvailabilityChanged Bool


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared _ =
    Page.new
        { init = init
        , update = update
        , view = view shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "home"
        }


init : () -> ( Model, Effect Msg )
init _ =
    ( { aiChatEnabled = Nothing }, E.none )


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        AiChatAvailabilityChanged enabled ->
            ( { model | aiChatEnabled = Just enabled }, E.none )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


view : Shared.Model -> Auth.User -> Model -> View Msg
view shared user model =
    { title = "ЕХО"
    , body =
        [ div
            [ class <|
                if canShowAiChat user then
                    "app-shell-fill-height box-border min-h-0 w-full px-2 py-2 flex flex-col overflow-hidden"

                else
                    "box-border container mx-auto px-4 py-6"
            ]
            [ if not shared.userLoaded then
                viewHomeLoading

              else if canShowAiChat user then
                viewAiHome user model

              else
                viewClassicHome user model
            ]
        ]
    }


viewHomeLoading : Html Msg
viewHomeLoading =
    Html.node "home-loading-card"
        [ class "block w-full"
        , Attr.attribute "aria-label" "Завантаження головної сторінки"
        ]
        []


canShowAiChat : Auth.User -> Bool
canShowAiChat user =
    Core.Auth.hasRole "Rer" user && not (Core.Auth.hasRole "ApiAgent" user)


viewClassicHome : Auth.User -> Model -> Html Msg
viewClassicHome _ _ =
    div [ class "w-full" ]
        [ section [ class "flex flex-col lg:flex-row gap-4 min-w-0 min-h-[50vh] lg:h-[50vh]" ]
            [ a [ target "_blank", href "/docs", class "w-full lg:basis-[clamp(280px,32%,360px)] xl:basis-[420px] lg:shrink min-h-[240px] lg:min-h-0 bg-card border border-border rounded-lg p-6 flex flex-col items-center justify-center gap-3 hover:shadow-lg hover:shadow-[var(--ochre-normal)]/30 transition-all duration-300 group" ]
                [ div [ class "w-16 h-16 bg-gradient-to-br from-[var(--ochre-normal)] to-[var(--ochre-normal-hover)] rounded-full flex items-center justify-center mb-2 group-hover:scale-110 transition-transform duration-300" ]
                    [ i [ class "bi bi-book text-white text-2xl" ] []
                    ]
                , div [ class "text-center" ]
                    [ h3 [ class "text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1" ] [ text "Алгоритм роботи" ]
                    , p [ class "text-sm text-gray-700 dark:text-gray-300" ] [ text "Документація та інструкції" ]
                    ]
                , div [ class "flex items-center gap-2 text-[var(--action-color)] group-hover:text-[var(--action-hovered-color)] transition-colors duration-300" ]
                    [ span [ class "text-sm font-medium" ] [ text "Переглянути" ]
                    , i [ class "bi bi-arrow-up-right text-lg group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform duration-300" ] []
                    ]
                ]
            ]
        ]


viewAiHome : Auth.User -> Model -> Html Msg
viewAiHome user model =
    div [ class "w-full flex flex-col flex-1 min-h-0" ]
        [ Html.node "ai-agent-chat"
            [ class <|
                if model.aiChatEnabled == Just False then
                    "hidden"

                else
                    "react-fill-host flex-1"
            , on "ai-agent-availability" <|
                Decode.map AiChatAvailabilityChanged <|
                    Decode.at [ "detail", "enabled" ] Decode.bool
            ]
            []
        , case model.aiChatEnabled of
            Nothing ->
                text ""

            Just False ->
                viewClassicHome user model

            Just True ->
                text ""
        ]
