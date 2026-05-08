module Pages.Updates exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Core.Types exposing (ApiError)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (class)
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Shared
import Shared.Components.Spinner
import Utils.Api.ErrorHandling
import Utils.RemoteData exposing (RemoteData(..))
import View exposing (View)


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
        , activeName = "updates"
        }


type alias Model =
    { sections : RemoteData ApiError (List B.ChangelogSection)
    }


init : () -> ( Model, Effect Msg )
init () =
    ( { sections = Loading }
    , E.sendCmd <| Api.changelog GotChangelog
    )


type Msg
    = GotChangelog (Result ApiError (List B.ChangelogSection))


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        GotChangelog (Ok sections) ->
            ( { model | sections = Success sections }, E.none )

        GotChangelog (Err err) ->
            ( { model | sections = Failure err }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження оновлень" err
            )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


view : Model -> View Msg
view model =
    { title = "Оновлення"
    , body =
        [ div [ class "box-border container mx-auto px-4 py-6" ]
            [ h1 [ class "text-2xl font-semibold mb-5" ] [ text "Оновлення" ]
            , viewSections model.sections
            ]
        ]
    }


viewSections : RemoteData ApiError (List B.ChangelogSection) -> Html Msg
viewSections sectionsRd =
    case sectionsRd of
        Loading ->
            div [ class "py-8 flex justify-center" ] [ Shared.Components.Spinner.loadingSpinner ]

        NotAsked ->
            text ""

        Failure _ ->
            div [ class "text-sm text-[var(--color-text-muted)]" ] [ text "Не вдалося завантажити оновлення" ]

        Success sections ->
            if List.isEmpty sections then
                div [ class "text-sm text-[var(--color-text-muted)]" ] [ text "Поки що немає оновлень" ]

            else
                div [ class "space-y-6" ] (List.map viewSection sections)

        NeedsReload sections ->
            if List.isEmpty sections then
                div [ class "text-sm text-[var(--color-text-muted)]" ] [ text "Поки що немає оновлень" ]

            else
                div [ class "space-y-6" ] (List.map viewSection sections)


viewSection : B.ChangelogSection -> Html Msg
viewSection changelogSection =
    section [ class "rounded border border-[var(--color-border)] bg-[var(--color-card)] p-4" ]
        [ h2 [ class "text-lg font-semibold mb-2" ] [ text changelogSection.date ]
        , ul [ class "list-disc ml-5 space-y-1" ]
            (List.map (\item -> li [ class "leading-snug" ] [ text item ]) changelogSection.items)
        ]
