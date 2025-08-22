module Pages.Settings exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Components.Button as Button
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Styled
import Layouts
import Le.Block.Select
import Le.Block.Spinner
import Le.ErrorHandling
import Le.Types exposing (..)
import Maybe.Extra as MaybeX
import Page exposing (Page)
import Route exposing (Route)
import Select
import Shared
import Shared.Model exposing (isDarkMode)
import View exposing (View)
import Views


type alias Model =
    { formErrors : Dict String String
    , zones : List ( Int, B.SigintZone )
    , zoneId : Maybe Int
    , saveInProgress : Bool
    , zoneSelectState : Select.State
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , zones = []
      , zoneId = Nothing
      , saveInProgress = False
      , zoneSelectState = Select.initState (Select.selectIdentifier "zone-select")
      }
    , E.sendCmd <|
        Cmd.batch
            [ Api.sigint_zones_list GotZoneList
            , Api.api_user GotUser
            ]
    )


type Msg
    = LogOut
    | GotZoneList (Result ApiError (List ( Int, B.SigintZone )))
    | SelectZone String
    | ZoneSelectMsg (Select.Msg Int)
    | Save
    | SaveDone (Result ApiError ())
    | GotUser (Result ApiError B.User)


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared req =
    Page.new
        { init = init
        , update = update
        , view = view shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "settings"
        }


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        LogOut ->
            ( model
            , E.logout
            )

        GotZoneList (Err e) ->
            ( model, Le.ErrorHandling.formatErrorForShowErrorWithDetails "Failed to Load Zones" e )

        GotZoneList (Ok vs) ->
            ( { model | zones = vs }, E.none )

        SelectZone str ->
            let
                m2 =
                    case String.toInt str of
                        Nothing ->
                            { model | zoneId = Nothing }

                        Just i ->
                            { model | zoneId = Just i }
            in
            ( m2, E.none )

        Save ->
            ( { model | saveInProgress = True }
            , E.sendCmd <|
                Api.settings_save SaveDone
                    { sigintZoneId = model.zoneId }
            )

        SaveDone (Err e) ->
            let
                m2 =
                    { model | saveInProgress = False }
            in
            ( m2, Le.ErrorHandling.formatErrorForShowErrorWithDetails "Save Failed" e )

        SaveDone (Ok ()) ->
            let
                m2 =
                    { model | saveInProgress = False }
            in
            ( m2, E.none )

        GotUser (Err e) ->
            ( model, Le.ErrorHandling.formatErrorForShowErrorWithDetails "Failed to Load User" e )

        GotUser (Ok user) ->
            ( { model | zoneId = user.sigintZoneId }
            , E.none
            )

        ZoneSelectMsg selectMsg ->
            let
                ( mAction, iState, iCmd ) =
                    Select.update selectMsg model.zoneSelectState

                mZoneId =
                    Le.Block.Select.singleUpd mAction model.zoneId
            in
            ( { model
                | zoneSelectState = iState
                , zoneId = mZoneId
              }
            , E.sendCmd <| Cmd.map ZoneSelectMsg iCmd
            )


view : Shared.Model -> B.User -> Model -> View Msg
view shared user model =
    let
        zoneMenuItems =
            List.map (\( zoneId, zone ) -> Select.basicMenuItem { item = zoneId, label = zone.name }) model.zones

        selectedZoneItem =
            Maybe.andThen
                (\zoneId ->
                    List.head (List.filter (\( _, zone ) -> zoneId == zoneId) model.zones)
                        |> Maybe.map (\( _, zone ) -> Select.basicMenuItem { item = zoneId, label = zone.name })
                )
                model.zoneId

        versionText =
            Maybe.map .version shared.serverInfo
                |> Maybe.withDefault "невідома версія"
    in
    { title = "налаштування"
    , body =
        [ div [ class "w-4/5 mx-auto px-4 pt-4" ]
            [ div [ class "flex" ]
                [ div [ class "w-full" ]
                    [ -- Header section
                      div [ class "mb-4" ]
                        [ div [ class "flex items-center justify-between mb-4" ]
                            [ h1 [ class "py-4 text-[var(--text-color)]" ]
                                [ text "налаштування" ]
                            , div [ class "flex items-center gap-4 text-sm" ]
                                [ a
                                    [ href "https://signal.me/#p/+380502711438"
                                    , target "_blank"
                                    , class "flex items-center gap-2 px-3 py-2 text-[var(--text-color)] hover:text-[var(--action-color)] hover:bg-[var(--color-bg-inactive)] rounded-md transition-colors"
                                    ]
                                    [ i [ class "bi bi-signal" ] []
                                    , text "підтримка"
                                    ]
                                , span
                                    [ class "flex items-center gap-2 px-3 py-2 text-[var(--text-color)] hover:text-red-600 hover:bg-red-50 rounded-md cursor-pointer transition-colors"
                                    , onClick LogOut
                                    ]
                                    [ i [ class "bi bi-box-arrow-right" ] []
                                    , text "вийти"
                                    , span [ class "text-gray-500" ] [ text ("(" ++ user.name ++ ")") ]
                                    ]
                                ]
                            ]
                        ]

                    -- Settings form
                    , div [ class "bg-[var(--card-color)] rounded-xl shadow-sm border border-[var(--border-color)] overflow-hidden" ]
                        [ -- Form header
                          div [ class "px-6 py-4 border-b border-[var(--border-color)] bg-[var(--color-bg-inactive)]" ]
                            [ h2 [ class "text-lg font-semibold text-[var(--text-color)]" ]
                                [ text "Основні налаштування" ]
                            ]

                        -- Form content
                        , div [ class "p-6 space-y-6" ]
                            [ -- Zone selection
                              div []
                                [ label
                                    [ class "block text-sm font-medium text-[var(--text-color)] mb-2" ]
                                    [ text "РЕР-напрямок" ]
                                , p [ class "text-sm text-gray-500 mb-3" ]
                                    [ text "Оберіть зону РЕР-напрямку для вашого облікового запису" ]
                                , div [ class "w-2/5" ]
                                    [ Html.map ZoneSelectMsg <|
                                        Html.Styled.toUnstyled <|
                                            Le.Block.Select.renderSelectSingle
                                                selectedZoneItem
                                                model.zoneSelectState
                                                zoneMenuItems
                                                "Оберіть зону"
                                                (Le.Block.Select.defaultOptions (isDarkMode shared.themeMode))
                                    ]
                                ]

                            -- Save button section
                            , div [ class "flex items-center justify-between pt-4 border-t border-[var(--border-color)]" ]
                                [ div [ class "text-sm text-gray-500" ]
                                    [ text ("Версія: " ++ versionText) ]
                                , div [ class "flex gap-3" ]
                                    [ if model.saveInProgress then
                                        Button.new { label = "зберегти", onClick = Save }
                                            |> Button.withIcon [ Le.Block.Spinner.loadingSpinner2Sm ]
                                            |> Button.withDisabled True
                                            |> Button.view

                                      else
                                        Button.new { label = "зберегти", onClick = Save }
                                            |> Button.withIcon [ i [ class "bi bi-save" ] [] ]
                                            |> Button.view
                                    ]
                                ]
                            ]
                        ]
                    ]
                ]
            ]
        ]
    }
