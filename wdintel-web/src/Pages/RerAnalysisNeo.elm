module Pages.RerAnalysisNeo exposing (Model, Msg, page)

import Auth
import Effect as E exposing (Effect)
import Html exposing (a, button, div, i, node, span, text)
import Html.Attributes exposing (attribute, class, href, style, type_)
import Html.Events exposing (onClick)
import Layouts
import Page exposing (Page)
import PagePorts.RerAnalysisNeoPorts as Ports
import Route exposing (Route)
import Shared
import View exposing (View)


type alias Model =
    { showBetaBanner : Maybe Bool
    }


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
        , view = view
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "rer-analysis-neo"
        }


init : () -> ( Model, Effect Msg )
init () =
    ( { showBetaBanner = Nothing }
    , E.sendCmd <| Ports.rer_analysis_neo_loadBetaBannerDismissed ()
    )


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        NoOp ->
            ( model, E.none )

        CloseBetaBanner ->
            ( { model | showBetaBanner = Just False }
            , E.sendCmd <| Ports.rer_analysis_neo_saveBetaBannerDismissed True
            )

        BetaBannerDismissedLoaded isDismissed ->
            ( { model | showBetaBanner = Just (not isDismissed) }
            , E.none
            )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Ports.rer_analysis_neo_loadBetaBannerDismissedRes BetaBannerDismissedLoaded


view : Model -> View Msg
view model =
    let
        betaBannerNode =
            div
                [ class <|
                    if model.showBetaBanner == Just True then
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
                                , href "/rer-analysis"
                                , style "color" "var(--color-warning-dark) !important"
                                , style "text-decoration-color" "var(--color-warning-dark) !important"
                                ]
                                [ span [] [ text "Перейти на стару сторінку аналізу" ]
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
    { title = "РЕР-аналіз"
    , body =
        [ div [ class "app-shell-fill-height box-border min-h-0 px-6 py-4 w-full flex flex-col gap-6 overflow-visible lg:overflow-hidden" ]
            [ betaBannerNode
            , div [ class "flex-1 min-h-0 w-full" ]
                [ node "rer-analysis-neo"
                    [ class "block w-full h-full" ]
                    []
                ]
            ]
        ]
    }
