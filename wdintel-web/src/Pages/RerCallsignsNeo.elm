module Pages.RerCallsignsNeo exposing (Model, Msg, page)

import Auth
import Effect as E exposing (Effect)
import Html exposing (a, div, i, node, span, text)
import Html.Attributes exposing (attribute, class, href, style)
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Shared
import View exposing (View)


type alias Model =
    {}


init : () -> ( Model, Effect Msg )
init _ =
    ( {}
    , E.none
    )


type Msg
    = NoOp


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user _ _ =
    Page.new
        { init = init
        , update = update
        , subscriptions = subscriptions
        , view = view user
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "callsigns-neo"
        }


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        NoOp ->
            ( model, E.none )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


view : Auth.User -> Model -> View Msg
view user _ =
    { title = "позивні"
    , body =
        [ div [ class "app-shell-fill-height box-border min-h-0 pt-6 px-6 w-full overflow-visible lg:overflow-hidden" ]
            [ div
                [ class "mb-4 rounded-lg border border-amber-500/40 bg-amber-100 px-4 py-3 text-amber-900" ]
                [ span [ class "font-semibold" ] [ text "Бета-версія: " ]
                , text "ця сторінка перебуває у тестовому режимі. "
                , a
                    [ class "inline-flex items-center gap-1 font-semibold underline decoration-2 underline-offset-2 text-[var(--color-warning-dark)] hover:text-[var(--color-warning-darker)] hover:decoration-[var(--color-warning-darker)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-warning-dark)] focus-visible:ring-offset-1 focus-visible:ring-offset-amber-100 rounded-sm"
                    , href "/rer-callsigns"
                    , style "color" "var(--color-warning-dark) !important"
                    , style "text-decoration-color" "var(--color-warning-dark) !important"
                    ]
                    [ span [] [ text "Перейти на стару сторінку позивних" ]
                    , i [ class "bi bi-box-arrow-up-right text-xs" ] []
                    ]
                ]
            , node "rer-callsigns-neo"
                [ attribute "data-auth-user-roles" (String.join "," user.roles) ]
                []
            ]
        ]
    }
