module Pages.Updates exposing (Model, Msg, page)

import Auth
import Browser.Dom
import Browser.Events
import Core.Types exposing (ApiError)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (alt, attribute, class, controls, id, src, style)
import Html.Events exposing (onClick)
import Html.Lazy as Lazy
import Http
import Json.Decode as Decode
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Shared
import Shared.Components.Spinner
import String
import Task
import Url.Builder
import Utils.Api.ErrorHandling
import Utils.Api.Temp exposing (leExpectJson)
import Utils.RemoteData exposing (RemoteData(..))
import View exposing (View)

tableOfContents : String
tableOfContents = "Зміст"

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
    { releases : RemoteData ApiError (List ReleaseMeta)
    , selectedReleaseId : Maybe String
    , releasePage : RemoteData ApiError (Maybe LoadedReleasePage)
    , activeSectionId : Maybe String
    , scrollProbeMs : Float
    }


type alias ReleaseMeta =
    { releaseId : String
    , title : String
    }


type alias ReleasePage =
    { releaseId : String
    , title : String
    , blocks : List ContentBlock
    }


type alias LoadedReleasePage =
    { page : ReleasePage
    , sections : List HeadingSection
    }


type alias HeadingSection =
    { sectionId : String
    , title : String
    }


type ContentBlock
    = HeadingBlock String
    | ParagraphBlock String
    | ImageBlock ImageData
    | VideoBlock VideoData


type alias ImageData =
    { src : String
    , alt : String
    }


type alias VideoData =
    { src : String
    }


init : () -> ( Model, Effect Msg )
init () =
    ( { releases = Loading
      , selectedReleaseId = Nothing
      , releasePage = NotAsked
      , activeSectionId = Nothing
      , scrollProbeMs = 0
      }
    , E.sendCmd <| fetchReleases
    )


type Msg
    = GotReleases (Result ApiError (List ReleaseMeta))
    | SelectRelease String
    | GotReleasePage String (Result ApiError ReleasePage)
    | ScrollTick Float
    | GotActiveSection (Result Browser.Dom.Error (Maybe String))
    | JumpToSection String
    | ScrolledToSection (Result Browser.Dom.Error ())


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        GotReleases (Ok releases) ->
            case List.head releases of
                Just firstRelease ->
                    ( { model
                        | releases = Success releases
                        , selectedReleaseId = Just firstRelease.releaseId
                        , releasePage = Loading
                      }
                    , E.sendCmd <| fetchReleasePage firstRelease.releaseId
                    )

                Nothing ->
                    ( { model | releases = Success [], releasePage = Success Nothing }
                    , E.none
                    )

        GotReleases (Err err) ->
            ( { model | releases = Failure err }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження релізів" err
            )

        SelectRelease releaseId ->
            if model.selectedReleaseId == Just releaseId then
                ( model, E.none )

            else
                ( { model
                    | selectedReleaseId = Just releaseId
                    , releasePage = Loading
                    , activeSectionId = Nothing
                    , scrollProbeMs = 0
                  }
                , E.sendCmd <| fetchReleasePage releaseId
                )

        GotReleasePage releaseId (Ok releasePage) ->
            if model.selectedReleaseId /= Just releaseId then
                ( model, E.none )

            else
                let
                    loadedReleasePage =
                        buildLoadedReleasePage releasePage

                    firstSectionId =
                        loadedReleasePage.sections
                            |> List.head
                            |> Maybe.map .sectionId
                in
                ( { model
                    | releasePage = Success (Just loadedReleasePage)
                    , activeSectionId = firstSectionId
                    , scrollProbeMs = 0
                  }
                , E.none
                )

        GotReleasePage releaseId (Err err) ->
            if model.selectedReleaseId /= Just releaseId then
                ( model, E.none )

            else
                ( { model | releasePage = Failure err }
                , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження релізу" err
                )

        ScrollTick deltaMs ->
            case model.releasePage of
                Success (Just loadedReleasePage) ->
                    if List.isEmpty loadedReleasePage.sections then
                        ( model, E.none )

                    else if model.scrollProbeMs + deltaMs < 180 then
                        ( { model | scrollProbeMs = model.scrollProbeMs + deltaMs }
                        , E.none
                        )

                    else
                        ( { model | scrollProbeMs = 0 }
                        , E.sendCmd <| detectActiveSection loadedReleasePage.sections
                        )

                _ ->
                    ( model, E.none )

        GotActiveSection (Ok maybeSectionId) ->
            case maybeSectionId of
                Just sectionId ->
                    ( { model | activeSectionId = Just sectionId }, E.none )

                Nothing ->
                    ( model, E.none )

        GotActiveSection (Err _) ->
            ( model, E.none )

        JumpToSection sectionId ->
            ( { model | activeSectionId = Just sectionId }
            , E.sendCmd <| scrollToSection sectionId
            )

        ScrolledToSection _ ->
            ( model, E.none )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Browser.Events.onAnimationFrameDelta ScrollTick


view : Model -> View Msg
view model =
    { title = "Оновлення"
    , body =
        [ div [ class "box-border mx-auto max-w-[1820px] px-4 py-6" ]
            [ h1 [ class "text-2xl font-semibold mb-5" ] [ text "Оновлення" ]
            , div [ class "grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)_240px] gap-4 items-start" ]
                [ viewReleasesSidebar model
                , viewReleasePage model
                , viewOnThisPage model
                ]
            ]
        ]
    }


viewReleasesSidebar : Model -> Html Msg
viewReleasesSidebar model =
    case model.releases of
        Loading ->
            aside [ class "lg:sticky lg:top-20 self-start rounded border border-[var(--color-border)] bg-[var(--color-card)] p-3" ]
                [ div [ class "py-3 flex justify-center" ] [ Shared.Components.Spinner.loadingSpinner ] ]

        NotAsked ->
            text ""

        Failure _ ->
            text ""

        Success releases ->
            if List.isEmpty releases then
                text ""

            else
                aside [ class "lg:sticky lg:top-20 self-start h-fit rounded border border-[var(--color-border)] bg-[var(--color-card)] p-3" ]
                    [ h2 [ class "text-sm font-semibold mb-2" ] [ text "Релізи" ]
                    , div [ class "space-y-1" ] (List.map (viewReleaseItem model) releases)
                    ]

        NeedsReload releases ->
            if List.isEmpty releases then
                text ""

            else
                aside [ class "lg:sticky lg:top-20 self-start h-fit rounded border border-[var(--color-border)] bg-[var(--color-card)] p-3" ]
                    [ h2 [ class "text-sm font-semibold mb-2" ] [ text "Релізи" ]
                    , div [ class "space-y-1" ] (List.map (viewReleaseItem model) releases)
                    ]


viewReleaseItem : Model -> ReleaseMeta -> Html Msg
viewReleaseItem model releaseMeta =
    let
        isSelected =
            model.selectedReleaseId == Just releaseMeta.releaseId

        baseClasses =
            "w-full text-left text-sm rounded px-2 py-1.5"

        selectedClasses =
            if isSelected then
                " bg-[var(--color-bg)] font-semibold"

            else
                " hover:bg-[var(--color-bg)]"
    in
    button
        [ class (baseClasses ++ selectedClasses)
        , onClick (SelectRelease releaseMeta.releaseId)
        ]
        [ text releaseMeta.title ]


viewReleasePage : Model -> Html Msg
viewReleasePage model =
    case model.releasePage of
        Loading ->
            div [ class "py-8 flex justify-center" ] [ Shared.Components.Spinner.loadingSpinner ]

        NotAsked ->
            text ""

        Failure _ ->
            div [ class "text-sm text-[var(--color-text-muted)]" ] [ text "Не вдалося завантажити реліз" ]

        Success Nothing ->
            div [ class "text-sm text-[var(--color-text-muted)]" ] [ text "Оберіть реліз" ]

        Success (Just loadedReleasePage) ->
            section [ class "rounded border border-[var(--color-border)] bg-[var(--color-card)] p-5" ]
                [ h2 [ class "text-2xl font-semibold" ] [ text (releasePageHeader loadedReleasePage.page) ]
                , div [ class "mt-5 space-y-4" ]
                    (viewTopAnchorIfNeeded loadedReleasePage
                        ++ (loadedReleasePage.page.blocks
                                |> List.indexedMap (viewBlock model.activeSectionId)
                           )
                    )
                ]

        NeedsReload maybeReleasePage ->
            case maybeReleasePage of
                Just loadedReleasePage ->
                    section [ class "rounded border border-[var(--color-border)] bg-[var(--color-card)] p-5" ]
                        [ h2 [ class "text-2xl font-semibold" ] [ text (releasePageHeader loadedReleasePage.page) ]
                        , div [ class "mt-5 space-y-4" ]
                            (viewTopAnchorIfNeeded loadedReleasePage
                                ++ (loadedReleasePage.page.blocks
                                        |> List.indexedMap (viewBlock model.activeSectionId)
                                   )
                            )
                        ]

                Nothing ->
                    div [ class "text-sm text-[var(--color-text-muted)]" ] [ text "Оберіть реліз" ]


viewBlock : Maybe String -> Int -> ContentBlock -> Html Msg
viewBlock activeSectionId blockIndex block =
    Lazy.lazy3 viewContentBlock activeSectionId blockIndex block


viewContentBlock : Maybe String -> Int -> ContentBlock -> Html Msg
viewContentBlock activeSectionId blockIndex block =
    case block of
        HeadingBlock headingText ->
            let
                domId =
                    sectionDomId blockIndex

                isActive =
                    activeSectionId == Just domId

                activeClass =
                    if isActive then
                        " ring-2 ring-[var(--color-primary)]"

                    else
                        ""
            in
            section
                [ id domId
                , class ("scroll-mt-28 rounded px-2 py-1 transition " ++ activeClass)
                ]
                [ h4 [ class "text-xl font-semibold" ] [ text headingText ] ]

        ParagraphBlock paragraphText ->
            p [ class "text-sm leading-relaxed text-[var(--color-text)]" ] [ text paragraphText ]

        ImageBlock imageData ->
            img
                [ class "w-full max-w-full rounded border border-[var(--color-border)]"
                , style "width" "stretch"
                , src imageData.src
                , alt imageData.alt
                , attribute "loading" "lazy"
                ]
                []

        VideoBlock videoData ->
            video
                [ class "w-full rounded border border-[var(--color-border)] bg-black"
                , style "width" "stretch"
                , src videoData.src
                , controls True
                , attribute "preload" "metadata"
                ]
                []


getAsideBlock: Model -> LoadedReleasePage -> Html Msg
getAsideBlock model releasePage =
    aside [ class "lg:sticky lg:top-20 self-start h-fit rounded border border-[var(--color-border)] bg-[var(--color-card)] p-3" ]
          [ h2 [ class "text-sm font-semibold mb-2" ] [ text tableOfContents ]
          , div [ class "space-y-1" ] (List.map (viewOnThisPageItem model.activeSectionId) releasePage.sections)
          ]

emptyText : Html Msg
emptyText =
    text ""

viewOnThisPage : Model -> Html Msg
viewOnThisPage model =
    case model.releasePage of
        Success (Just releasePage) ->
            if List.isEmpty releasePage.sections then
                emptyText

            else
                getAsideBlock model releasePage

        NeedsReload (Just releasePage) ->
            if List.isEmpty releasePage.sections then
                emptyText

            else
                getAsideBlock model releasePage

        _ ->
            emptyText


viewOnThisPageItem : Maybe String -> HeadingSection -> Html Msg
viewOnThisPageItem activeSectionId headingSection =
    let
        isActive =
            activeSectionId == Just headingSection.sectionId

        activeClass =
            if isActive then
                " bg-[var(--color-bg)] font-semibold"

            else
                " hover:bg-[var(--color-bg)]"
    in
    button
        [ class ("w-full text-left text-xs leading-snug rounded px-2 py-1.5 hover:underline" ++ activeClass)
        , onClick (JumpToSection headingSection.sectionId)
        ]
        [ text headingSection.title ]


viewTopAnchorIfNeeded : LoadedReleasePage -> List (Html Msg)
viewTopAnchorIfNeeded loadedReleasePage =
    case loadedReleasePage.sections of
        [ onlySection ] ->
            if onlySection.sectionId == fallbackSectionId then
                [ div [ id fallbackSectionId, class "scroll-mt-28" ] [] ]

            else
                []

        _ ->
            []


sectionDomId : Int -> String
sectionDomId blockIndex =
    "release-section-" ++ String.fromInt blockIndex


releasePageHeader : ReleasePage -> String
releasePageHeader releasePage =
    releasePage.title


detectActiveSection : List HeadingSection -> Cmd Msg
detectActiveSection sections =
    Browser.Dom.getViewport
        |> Task.andThen
            (\viewport ->
                sections
                    |> List.map
                        (\sectionItem ->
                            Browser.Dom.getElement sectionItem.sectionId
                                |> Task.map
                                    (\sectionElement ->
                                        ( sectionItem.sectionId
                                        , sectionElement.element.y
                                        )
                                    )
                        )
                    |> Task.sequence
                    |> Task.map
                        (pickActiveSectionId (viewport.viewport.y + 180))
            )
        |> Task.attempt GotActiveSection


pickActiveSectionId : Float -> List ( String, Float ) -> Maybe String
pickActiveSectionId viewportAnchor sectionOffsets =
    case sectionOffsets of
        [] ->
            Nothing

        ( firstSectionId, _ ) :: _ ->
            sectionOffsets
                |> List.foldl
                    (\( sectionId, topY ) acc ->
                        if topY <= viewportAnchor then
                            Just sectionId

                        else
                            acc
                    )
                    Nothing
                |> Maybe.withDefault firstSectionId
                |> Just


scrollToSection : String -> Cmd Msg
scrollToSection sectionId =
    Browser.Dom.getElement sectionId
        |> Task.andThen
            (\sectionElement ->
                Browser.Dom.setViewport 0 (sectionElement.element.y - 120)
            )
        |> Task.attempt ScrolledToSection


fetchReleases : Cmd Msg
fetchReleases =
    Http.get
        { url = "/releases/index.json"
        , expect = leExpectJson GotReleases (Decode.list releaseMetaDecoder)
        }


fetchReleasePage : String -> Cmd Msg
fetchReleasePage releaseId =
    Http.get
        { url = Url.Builder.absolute [ "releases", releaseId, "changelog.json" ] []
        , expect = leExpectJson (GotReleasePage releaseId) releasePageDecoder
        }


buildLoadedReleasePage : ReleasePage -> LoadedReleasePage
buildLoadedReleasePage releasePage =
    { page = releasePage
    , sections =
        let
            sections =
                releasePage.blocks
                    |> List.indexedMap
                        (\blockIndex block ->
                            case block of
                                HeadingBlock headingText ->
                                    Just
                                        { sectionId = sectionDomId blockIndex
                                        , title =
                                            let
                                                trimmedTitle =
                                                    String.trim headingText
                                            in
                                            if String.isEmpty trimmedTitle then
                                                "Section " ++ String.fromInt (blockIndex + 1)

                                            else
                                                trimmedTitle
                                        }

                                _ ->
                                    Nothing
                        )
                    |> List.filterMap identity
        in
        if List.isEmpty sections then
            [ { sectionId = fallbackSectionId, title = "Опис" } ]

        else
            sections
    }


fallbackSectionId : String
fallbackSectionId =
    "release-section-top"


releaseMetaDecoder : Decode.Decoder ReleaseMeta
releaseMetaDecoder =
    Decode.map2 ReleaseMeta
        (Decode.field "release_id" Decode.string)
        (Decode.field "title" Decode.string)


releasePageDecoder : Decode.Decoder ReleasePage
releasePageDecoder =
    Decode.map3 ReleasePage
        (Decode.field "release_id" Decode.string)
        (Decode.field "title" Decode.string)
        (Decode.field "blocks" (Decode.list contentBlockDecoder))


contentBlockDecoder : Decode.Decoder ContentBlock
contentBlockDecoder =
    Decode.field "type" Decode.string
        |> Decode.andThen decodeBlockByType


decodeBlockByType : String -> Decode.Decoder ContentBlock
decodeBlockByType blockType =
    case blockType of
        "heading" ->
            Decode.map HeadingBlock (Decode.field "text" Decode.string)

        "paragraph" ->
            Decode.map ParagraphBlock (Decode.field "text" Decode.string)

        "image" ->
            Decode.map ImageBlock imageDataDecoder

        "video" ->
            Decode.map VideoBlock videoDataDecoder

        _ ->
            Decode.fail ("Unsupported content block type: " ++ blockType)


imageDataDecoder : Decode.Decoder ImageData
imageDataDecoder =
    Decode.map2 ImageData
        (Decode.field "src" Decode.string)
        (Decode.field "alt" Decode.string)


videoDataDecoder : Decode.Decoder VideoData
videoDataDecoder =
    Decode.map VideoData (Decode.field "src" Decode.string)
