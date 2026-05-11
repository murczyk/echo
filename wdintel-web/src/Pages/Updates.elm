module Pages.Updates exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Browser.Dom
import Core.Types exposing (ApiError)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (alt, class, controls, id, property, src, style)
import Html.Events exposing (onClick)
import Json.Encode as Encode
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Set exposing (Set)
import Shared
import Shared.Components.Spinner
import Task
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
    , expandedDates : Set String
    , expandedItems : Set String
    , itemDetails : Dict String (RemoteData ApiError (Maybe B.ChangelogItemDetails))
    }


init : () -> ( Model, Effect Msg )
init () =
    ( { sections = Loading
      , expandedDates = Set.empty
      , expandedItems = Set.empty
      , itemDetails = Dict.empty
      }
    , E.sendCmd <| Api.changelog GotChangelog
    )


type Msg
    = GotChangelog (Result ApiError (List B.ChangelogSection))
    | ToggleDate String
    | ToggleEntry B.ChangelogEntry
    | GotChangelogDetails String (Result ApiError (Maybe B.ChangelogItemDetails))
    | JumpToEntry String B.ChangelogEntry
    | ScrolledToEntry (Result Browser.Dom.Error ())


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        GotChangelog (Ok sections) ->
            let
                expandedDates =
                    case List.head sections of
                        Just firstSection ->
                            Set.singleton firstSection.date

                        Nothing ->
                            Set.empty
            in
            ( { model | sections = Success sections, expandedDates = expandedDates }, E.none )

        GotChangelog (Err err) ->
            ( { model | sections = Failure err }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження оновлень" err
            )

        ToggleDate date ->
            ( { model | expandedDates = toggleInSet date model.expandedDates }
            , E.none
            )

        ToggleEntry changelogEntry ->
            toggleEntryWithDetails changelogEntry model

        GotChangelogDetails entryId (Ok details) ->
            ( { model | itemDetails = Dict.insert entryId (Success details) model.itemDetails }
            , E.none
            )

        GotChangelogDetails entryId (Err err) ->
            ( { model | itemDetails = Dict.insert entryId (Failure err) model.itemDetails }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження деталей оновлення" err
            )

        JumpToEntry date changelogEntry ->
            let
                ( expandedModel, detailsEffect ) =
                    expandEntryWithDetails changelogEntry { model | expandedDates = Set.insert date model.expandedDates }
            in
            ( expandedModel
            , E.batch
                [ detailsEffect
                , E.sendCmd <| scrollToEntry changelogEntry.entryId
                ]
            )

        ScrolledToEntry _ ->
            ( model, E.none )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


view : Model -> View Msg
view model =
    { title = "Оновлення"
    , body =
        [ div [ class "box-border container mx-auto px-4 py-6" ]
            [ h1 [ class "text-2xl font-semibold mb-5" ] [ text "Оновлення" ]
            , div [ class "grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4" ]
                [ viewSidebar model
                , viewSections model
                ]
            ]
        ]
    }


viewSidebar : Model -> Html Msg
viewSidebar model =
    case model.sections of
        Loading ->
            text ""

        NotAsked ->
            text ""

        Failure _ ->
            text ""

        Success sections ->
            if List.isEmpty sections then
                text ""

            else
                aside [ class "hidden lg:block lg:sticky lg:top-4 self-start h-fit rounded border border-[var(--color-border)] bg-[var(--color-card)] p-3 max-h-[calc(100vh-1rem)] overflow-auto" ]
                    [ h2 [ class "text-sm font-semibold mb-2" ] [ text "Зміст" ]
                    , div [ class "space-y-3 pl-2" ] (List.map (viewSidebarSection model) sections)
                    ]

        NeedsReload sections ->
            if List.isEmpty sections then
                text ""

            else
                aside [ class "hidden lg:block lg:sticky lg:top-4 self-start h-fit rounded border border-[var(--color-border)] bg-[var(--color-card)] p-3 max-h-[calc(100vh-1rem)] overflow-auto" ]
                    [ h2 [ class "text-sm font-semibold mb-2" ] [ text "Зміст" ]
                    , div [ class "space-y-3 pl-2" ] (List.map (viewSidebarSection model) sections)
                    ]


viewSections : Model -> Html Msg
viewSections model =
    case model.sections of
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
                div [ class "space-y-4" ] (List.map (viewSection model) sections)

        NeedsReload sections ->
            if List.isEmpty sections then
                div [ class "text-sm text-[var(--color-text-muted)]" ] [ text "Поки що немає оновлень" ]

            else
                div [ class "space-y-4" ] (List.map (viewSection model) sections)


viewSidebarSection : Model -> B.ChangelogSection -> Html Msg
viewSidebarSection model changelogSection =
    let
        isExpanded =
            Set.member changelogSection.date model.expandedDates
    in
    div [ class "space-y-1" ]
        [ button
            [ class "w-full text-left text-xs font-semibold flex items-center justify-between gap-2"
            , onClick (ToggleDate changelogSection.date)
            ]
            [ text changelogSection.date
            , span [ class "text-[var(--color-text-muted)]" ]
                [ text (if isExpanded then "▾" else "▸") ]
            ]
        , if isExpanded then
            ul [ class "space-y-1 pl-6", style "list-style-type" "disc" ]
                (List.map
                    (\changelogEntry ->
                        li [ class "marker:text-[var(--color-text-muted)]" ]
                            [ button
                                [ class "block w-full text-left text-xs leading-snug hover:underline"
                                , onClick (JumpToEntry changelogSection.date changelogEntry)
                                ]
                                [ text (displayTitle changelogEntry.title) ]
                            ]
                    )
                    changelogSection.items
                )

          else
            text ""
        ]


viewSection : Model -> B.ChangelogSection -> Html Msg
viewSection model changelogSection =
    let
        isExpanded =
            Set.member changelogSection.date model.expandedDates
    in
    section [ class "rounded border border-[var(--color-border)] bg-[var(--color-card)] p-4" ]
        [ button
            [ class "w-full text-left flex items-center justify-between gap-2"
            , onClick (ToggleDate changelogSection.date)
            ]
            [ h2 [ class "text-lg font-semibold" ] [ text changelogSection.date ]
            , span [ class "text-[var(--color-text-muted)]" ]
                [ text (if isExpanded then "▾" else "▸") ]
            ]
        , if isExpanded then
            ul [ class "space-y-3 mt-3" ]
                (List.map (viewEntry model) changelogSection.items)

          else
            text ""
        ]


viewEntry : Model -> B.ChangelogEntry -> Html Msg
viewEntry model changelogEntry =
    let
        isExpanded =
            Set.member changelogEntry.entryId model.expandedItems

        detailsRd =
            Dict.get changelogEntry.entryId model.itemDetails
                |> Maybe.withDefault NotAsked
    in
    li [ class "border border-[var(--color-border)] rounded p-3", id changelogEntry.entryId ]
        [ div [ class "flex items-start justify-between gap-3" ]
            [ button
                [ class "w-full text-left text-sm leading-snug flex items-start justify-between gap-3"
                , onClick (ToggleEntry changelogEntry)
                ]
                [ span [] [ text (displayTitle changelogEntry.title) ]
                , span [ class "text-[var(--color-text-muted)]" ]
                    [ text (if isExpanded then "▾" else "▸") ]
                ]
            ]
        , if isExpanded then
            viewEntryDetails detailsRd

          else
            text ""
        ]


viewEntryDetails : RemoteData ApiError (Maybe B.ChangelogItemDetails) -> Html Msg
viewEntryDetails detailsRd =
    case detailsRd of
        Loading ->
            div [ class "pt-3 flex justify-center" ] [ Shared.Components.Spinner.loadingSpinner ]

        NotAsked ->
            text ""

        Failure _ ->
            text ""

        Success Nothing ->
            text ""

        Success (Just details) ->
            if String.trim details.contentHtml /= "" then
                div [ class "pt-3" ]
                    [ node "div"
                        [ class "changelog-details-content"
                        , property "innerHTML" (Encode.string details.contentHtml)
                        ]
                        []
                    ]

            else if String.trim details.description == "" && List.isEmpty details.media then
                text ""

            else
                div [ class "pt-3 space-y-3" ]
                    [ if String.trim details.description == "" then
                        text ""

                      else
                        pre [ class "whitespace-pre-wrap text-sm leading-snug bg-[var(--color-bg)] rounded p-3" ] [ text details.description ]
                    , div [ class "space-y-3" ] (List.map viewMedia details.media)
                    ]

        NeedsReload _ ->
            text ""


viewMedia : B.ChangelogMedia -> Html Msg
viewMedia media =
    case media.kind of
        "video" ->
            video [ controls True, src media.url, class "w-full rounded border border-[var(--color-border)]" ] []

        _ ->
            img [ src media.url, alt media.alt, class "w-full rounded border border-[var(--color-border)]" ] []


toggleInSet : comparable -> Set comparable -> Set comparable
toggleInSet value setValue =
    if Set.member value setValue then
        Set.remove value setValue

    else
        Set.insert value setValue


toggleEntryWithDetails : B.ChangelogEntry -> Model -> ( Model, Effect Msg )
toggleEntryWithDetails changelogEntry model =
    let
        isExpanded =
            Set.member changelogEntry.entryId model.expandedItems

        expandedItems =
            toggleInSet changelogEntry.entryId model.expandedItems

        shouldLoadDetails =
            (not isExpanded)
                && Dict.get changelogEntry.entryId model.itemDetails == Nothing
    in
    if shouldLoadDetails then
        ( { model
            | expandedItems = expandedItems
            , itemDetails = Dict.insert changelogEntry.entryId Loading model.itemDetails
          }
        , E.sendCmd <|
            Api.changelog_details_by_key
                (GotChangelogDetails changelogEntry.entryId)
                changelogEntry.entryId
        )

    else
        ( { model | expandedItems = expandedItems }, E.none )


expandEntryWithDetails : B.ChangelogEntry -> Model -> ( Model, Effect Msg )
expandEntryWithDetails changelogEntry model =
    if Set.member changelogEntry.entryId model.expandedItems then
        ( model, E.none )

    else
        let
            shouldLoadDetails =
                Dict.get changelogEntry.entryId model.itemDetails == Nothing

            expandedModel =
                { model | expandedItems = Set.insert changelogEntry.entryId model.expandedItems }
        in
        if shouldLoadDetails then
            ( { expandedModel | itemDetails = Dict.insert changelogEntry.entryId Loading expandedModel.itemDetails }
            , E.sendCmd <|
                Api.changelog_details_by_key
                    (GotChangelogDetails changelogEntry.entryId)
                    changelogEntry.entryId
            )

        else
            ( expandedModel, E.none )


displayTitle : String -> String
displayTitle rawTitle =
    let
        trimmed =
            String.trim rawTitle
    in
    if String.startsWith "✅" trimmed then
        String.trim (String.dropLeft 1 trimmed)

    else if String.startsWith "🐞" trimmed then
        String.trim (String.dropLeft 1 trimmed)

    else
        trimmed


scrollToEntry : String -> Cmd Msg
scrollToEntry entryId =
    Browser.Dom.getElement entryId
        |> Task.andThen
            (\entryElement ->
                Browser.Dom.setViewport 0 (entryElement.element.y - 120)
            )
        |> Task.attempt ScrolledToEntry
