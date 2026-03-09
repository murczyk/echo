module Pages.RerCallsignsNeo exposing (Model, Msg, page)

import Auth
import Effect as E exposing (Effect)
import Html exposing (a, button, div, i, node, span, text)
import Html.Attributes exposing (attribute, class, href, style, type_)
import Html.Events exposing (onClick)
import Layouts
import Page exposing (Page)
import PagePorts.RerCallsignsNeoPorts as Ports
import Route exposing (Route)
import Shared
import View exposing (View)


type alias Model =
    { showBetaBanner : Bool
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { showBetaBanner = True }
    , E.sendCmd <| Ports.rer_callsigns_neo_loadBetaBannerDismissed ()
    )


type Msg
    = NoOp
    | CloseBetaBanner
    | BetaBannerDismissedLoaded Bool


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

        CloseBetaBanner ->
            ( { model | showBetaBanner = False }
            , E.sendCmd <| Ports.rer_callsigns_neo_saveBetaBannerDismissed True
            )

        BetaBannerDismissedLoaded isDismissed ->
            ( { model | showBetaBanner = not isDismissed }
            , E.none
            )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Ports.rer_callsigns_neo_loadBetaBannerDismissedRes BetaBannerDismissedLoaded


view : Auth.User -> Model -> View Msg
view user model =
    let
        betaBannerNode =
            div
                [ class <|
                    if model.showBetaBanner then
                        "shrink-0"

                    else
                        "hidden"
                ]
                [ div
                    [ class "rounded-lg border border-amber-500/40 bg-amber-100 px-4 py-3 text-amber-900" ]
                    [ div [ class "flex items-start justify-between gap-4" ]
                        [ div [ class "min-w-0" ]
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
                        , button
                            [ class "shrink-0 inline-flex items-center justify-center rounded-sm p-1 text-amber-900/80 hover:text-amber-900 hover:bg-amber-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-warning-dark)]"
                            , type_ "button"
                            , onClick CloseBetaBanner
                            , attribute "aria-label" "Закрити бета-банер"
                            ]
                            [ i [ class "bi bi-x-lg text-sm" ] [] ]
                        ]
                    ]
                ]
    in
    { title = "позивні"
    , body =
        [ div [ class "app-shell-fill-height box-border min-h-0 px-6 w-full flex flex-col gap-4 overflow-visible lg:overflow-hidden" ]
            [ betaBannerNode
            , div [ class "flex-1 min-h-0 w-full" ]
                [ node "rer-callsigns-neo"
                    [ attribute "data-auth-user-roles" (String.join "," user.roles)
                    , class "block w-full h-full"
                    ]
                    []
                ]
            ]
        ]
    }
