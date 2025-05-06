module Pages.RerImporterCallsigns exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Layouts
import Le.Block.Toast
import Le.Types exposing (ApiError)
import List.Extra as ListX
import Page exposing (Page)
import Route exposing (Route)
import Shared
import View exposing (View)
import Views


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared req =
    Page.new
        { init = init
        , update = update
        , view = view shared.isDarkMode shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "rer"
        }


type alias Model =
    { formErrors : Dict String String
    , toasts : Le.Block.Toast.Model
    , filterInput : String
    , loadingCallsigns : Bool
    , callsigns : List B.CallsignWithFrequencies
    , selected : Maybe String
    , callsignsPerFreq : Dict String (List String)
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , toasts = Le.Block.Toast.init
      , filterInput = ""
      , loadingCallsigns = True
      , callsigns = []
      , callsignsPerFreq = Dict.empty
      , selected = Nothing
      }
    , E.sendCmd <| Api.rer_importer_callsigns GotCallsigns { filter = Nothing }
    )


type Msg
    = ToastMsg Le.Block.Toast.Msg
    | FilterInput String
    | ClearFilter
    | ClearSelected
    | GotCallsigns (Result ApiError (List B.CallsignWithFrequencies))
    | SelectCallsign String


callsignsPerFreq callsigns =
    List.foldr
        (\callsign acc ->
            List.foldr
                (\freq acc2 ->
                    Dict.update
                        freq
                        (\mv ->
                            case mv of
                                Nothing ->
                                    Just [ callsign.callsign ]

                                Just cs ->
                                    if List.member callsign.callsign cs then
                                        Just cs

                                    else
                                        Just (cs ++ [ callsign.callsign ])
                        )
                        acc2
                )
                acc
                callsign.frequencies
        )
        Dict.empty
        callsigns


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        ToastMsg imsg ->
            let
                ( im, icmds ) =
                    Le.Block.Toast.update imsg model.toasts
            in
            ( { model | toasts = im }
            , E.sendCmd <| Cmd.map ToastMsg icmds
            )

        FilterInput s ->
            ( { model
                | filterInput = s
                , selected = Nothing
              }
            , E.none
            )

        ClearFilter ->
            ( { model
                | filterInput = ""
              }
            , E.none
            )

        ClearSelected ->
            ( { model
                | selected = Nothing
              }
            , E.none
            )

        GotCallsigns (Err e) ->
            Api.handleHttpError ToastMsg e { model | loadingCallsigns = False }

        GotCallsigns (Ok callsigns) ->
            ( { model
                | callsigns = callsigns
                , callsignsPerFreq = callsignsPerFreq callsigns
                , loadingCallsigns = False
              }
            , E.sendCmd <| Cmd.none
            )

        SelectCallsign callsign ->
            ( { model | selected = Just callsign }
            , E.none
            )


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none


renderCallsign : B.CallsignWithFrequencies -> Html Msg
renderCallsign callsign =
    div
        [ class "callsign me-2"
        ]
        [ span
            [ onClick <| SelectCallsign callsign.callsign
            , attribute "role" "button"
            , class "callsign--span"
            ]
            [ text callsign.callsign ]
        ]


mainBlock : Model -> List (Html Msg)
mainBlock model =
    let
        filter callsigns =
            List.filter filterF
                callsigns

        filterF callsign =
            (model.filterInput == "")
                || String.startsWith (String.toLower model.filterInput) (String.toLower callsign.callsign)

        filterButton lbl =
            span
                [ class "text-action p-1 cursor-pointer"
                , onClick <| FilterInput lbl
                , style "user-select" "none"
                ]
                [ text lbl ]

        alphabetBlock =
            div [ class "text-center mb-4" ]
                [ filterButton "0"
                , filterButton "1"
                , filterButton "2"
                , filterButton "3"
                , filterButton "4"
                , filterButton "5"
                , filterButton "6"
                , filterButton "7"
                , filterButton "8"
                , filterButton "9"
                , filterButton "А"
                , filterButton "Б"
                , filterButton "В"
                , filterButton "Г"
                , filterButton "Д"
                , filterButton "Е"
                , filterButton "Ё"
                , filterButton "Ж"
                , filterButton "З"
                , filterButton "И"
                , filterButton "Й"
                , filterButton "К"
                , filterButton "Л"
                , filterButton "М"
                , filterButton "Н"
                , filterButton "О"
                , filterButton "П"
                , filterButton "Р"
                , filterButton "С"
                , filterButton "Т"
                , filterButton "У"
                , filterButton "Ф"
                , filterButton "Х"
                , filterButton "Ц"
                , filterButton "Ч"
                , filterButton "Ш"
                , filterButton "Щ"
                , filterButton "Э"
                , filterButton "Ю"
                , filterButton "Я"
                ]

        renderCallsignColumn callsigns =
            div [] <|
                List.map renderCallsign callsigns

        selectedBlock : String -> Html Msg
        selectedBlock selected =
            let
                frequencies =
                    ListX.find (\x -> x.callsign == selected) model.callsigns
                        |> Maybe.map .frequencies
                        |> Maybe.withDefault []
            in
            div
                [ class "shadow-lg p-3 mb-5 bg-body rounded text-center"

                -- , style "max-width" "60rem"
                , style "margin" "auto"
                ]
            <|
                [ h3 []
                    [ text selected
                    , text " "
                    , i
                        [ class "bi bi-x"
                        , attribute "role" "button"
                        , onClick ClearSelected
                        ]
                        []
                    ]
                , div [ class "d-flex justify-content-center" ] <|
                    List.map frequencyColumn frequencies
                ]

        frequencyColumn freq =
            let
                freqCallsigns =
                    List.sort
                        (Dict.get freq model.callsignsPerFreq
                            |> Maybe.withDefault []
                        )
            in
            div [ class "me-3" ] <|
                (div [] <|
                    [ span [ class "fs-3 text-primary" ]
                        [ text freq ]
                    ]
                )
                    :: List.map
                        freqColumnCallsign
                        freqCallsigns

        freqColumnCallsign x =
            div
                [ onClick <| SelectCallsign x
                , attribute "role" "button"
                ]
                [ text x ]
    in
    [ div [ class "d-flex justify-content-center mb-2 mt-4" ]
        [ input
            [ type_ "text"
            , class "form-control me-2"
            , classList [ ( "text-uppercase", model.filterInput /= "" ) ]
            , value model.filterInput
            , placeholder "Почніть набирати для фільтрування..."
            , style "width" "30rem"
            , onInput FilterInput
            ]
            []
        , button
            [ class "btn btn-sm btn-outline-danger"
            , onClick ClearFilter
            ]
            [ i
                [ class "bi bi-trash3"
                , attribute "role" "button"
                ]
                []
            ]
        ]
    , alphabetBlock
    , case model.selected of
        Nothing ->
            div
                [ class "d-flex justify-content-center fade-in"
                , style "max-height" "20rem"
                , style "margin" "0 auto"
                , style "overflow-y" "auto"
                ]
            <|
                if model.loadingCallsigns then
                    let
                        spinner =
                            div
                                [ class "spinner-border"
                                , attribute "role" "status"
                                ]
                                [ span [ class "visually-hidden" ] [ text "Loading..." ] ]
                    in
                    [ div [ class "text-center" ] [ spinner ] ]

                else
                    let
                        filteredCallsigns =
                            filter model.callsigns

                        numColumns =
                            8

                        callsignsPerColumn =
                            (List.length filteredCallsigns // numColumns) + 1

                        columns =
                            ListX.groupsOf callsignsPerColumn filteredCallsigns
                    in
                    List.map renderCallsignColumn columns

        Just selected ->
            selectedBlock selected
    ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "позивні"
    , body =
        [ -- , Views.navBarRer dark mServerInfo "callsigns" (SharedMsg Shared.NeedReload)
          Views.noHeaderAndContent ToastMsg model.toasts <|
            div [ class "page-rer-importer-callsigns" ] <|
                mainBlock model
        ]
    }
