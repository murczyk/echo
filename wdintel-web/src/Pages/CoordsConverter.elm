module Pages.CoordsConverter exposing (Model, Msg, page)

import Auth
import Bindings as B
import Coordinates as C
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Layouts
import Le.Block.Toast
import Le.Components exposing (googleMapsOutLink)
import List.Extra as ListX
import Page exposing (Page)
import PagePorts.HomePorts as Ports
import Route exposing (Route)
import Shared
import View exposing (View)
import Views


type alias Model =
    { formErrors : Dict String String
    , toasts : Le.Block.Toast.Model
    , toWgsContent : String
    , toWgsRes : Maybe { lat : Float, lng : Float }
    , toUskContent : String
    , toUskRes : Maybe { x : Int, y : Int }
    , toMgrsRes : List { coords : String, viewId : Int }
    }


type Msg
    = ToastMsg Le.Block.Toast.Msg
    | ToWgsChanged String
    | ToUskChanged String
    | GotUsk2000ToWgs84Res { coords : { lat : Float, lng : Float } }
    | GotWgs84ToUsk2000Res { coords : { x : Int, y : Int } }
    | GotMgrsToWgs84Res { coords : { lat : Float, lng : Float } }
    | GotWgs84ToMgrsRes { coords : String, viewId : Int }


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
        , activeName = "coords-converter"
        }


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , toasts = Le.Block.Toast.init
      , toWgsContent = ""
      , toWgsRes = Nothing
      , toUskContent = ""
      , toUskRes = Nothing
      , toMgrsRes = [ { coords = "", viewId = 1 }, { coords = "", viewId = 2 } ]
      }
    , E.sendCmd <| Cmd.none
    )


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

        ToWgsChanged val ->
            let
                cmd =
                    case C.extractCoordinates val of
                        (C.Usk2000 xy) :: _ ->
                            Ports.home_usk2000ToWgs84 { coords = xy }

                        (C.Wgs84LatLng _) :: _ ->
                            Cmd.none

                        (C.Wgs84DegMinSec _) :: _ ->
                            Cmd.none

                        (C.MGRS mgrs) :: _ ->
                            Ports.home_mgrsToWgs84 { coords = mgrs }

                        [] ->
                            Cmd.none
            in
            ( { model
                | toWgsContent = val
                , toWgsRes = Nothing
              }
            , E.sendCmd cmd
            )

        ToUskChanged val ->
            let
                m_latlng =
                    case C.extractCoordinates val of
                        (C.Wgs84LatLng latlng) :: _ ->
                            Just latlng

                        _ ->
                            Nothing
            in
            ( { model
                | toUskContent = val
                , toUskRes = Nothing
              }
            , E.sendCmd <|
                case m_latlng of
                    Nothing ->
                        Cmd.none

                    Just latlng ->
                        Cmd.batch
                            [ Ports.home_wgs84ToUsk2000 { coords = latlng }
                            , Ports.home_wgs84ToMgrs { coords = latlng, viewId = 2 }
                            ]
            )

        GotUsk2000ToWgs84Res { coords } ->
            ( { model | toWgsRes = Just coords }
            , E.sendCmd <| Ports.home_wgs84ToMgrs { coords = coords, viewId = 1 }
            )

        GotWgs84ToUsk2000Res { coords } ->
            ( { model | toUskRes = Just coords }
            , E.sendCmd <| Cmd.none
            )

        GotMgrsToWgs84Res { coords } ->
            ( { model | toWgsRes = Just coords }
            , E.sendCmd <| Cmd.none
            )

        GotWgs84ToMgrsRes res ->
            ( { model
                | toMgrsRes =
                    model.toMgrsRes
                        |> List.map
                            (\x ->
                                if x.viewId == res.viewId then
                                    { x | coords = res.coords }

                                else
                                    x
                            )
              }
            , E.sendCmd <| Cmd.none
            )



-- todo


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.batch
        [ Ports.home_usk2000ToWgs84Res GotUsk2000ToWgs84Res
        , Ports.home_wgs84ToUsk2000Res GotWgs84ToUsk2000Res
        , Ports.home_mgrsToWgs84Res GotMgrsToWgs84Res
        , Ports.home_wgs84ToMgrsRes GotWgs84ToMgrsRes
        ]


view : Shared.Model -> B.User -> Model -> View Msg
view shared user model =
    { title = "координати"
    , body =
        [ Views.headerAndContent "координати" ToastMsg model.toasts <|
            mainContentV model
        ]
    }


mainContentV : Model -> Html Msg
mainContentV model =
    div [ class "row" ]
        [ div [ class "col-sm-6 mb-2" ] <|
            [ textarea
                [ class "form-control"
                , placeholder "уск2000 -> wgs84"
                , style "height" "150px"
                , onInput <| ToWgsChanged
                , value model.toWgsContent
                ]
                []
            , small
                [ class "text-action cursor-pointer"
                , onClick <| ToWgsChanged "52-20714 65-51696"
                , attribute "tabindex" "-1"
                ]
                [ text "наприклад" ]
            ]
                ++ (case model.toWgsRes of
                        Nothing ->
                            []

                        Just coords ->
                            [ div [ class "text-center fs-3" ]
                                [ text <| C.render <| C.Wgs84LatLng coords
                                , text " "
                                , sup []
                                    [ googleMapsOutLink coords.lat coords.lng ]
                                ]
                            ]
                   )
                ++ (case model.toMgrsRes |> ListX.find (\x -> x.viewId == 1) of
                        Nothing ->
                            []

                        Just data ->
                            [ div [ class "text-center fs-3" ]
                                [ text <| C.render <| C.MGRS data.coords
                                ]
                            ]
                   )
        , div [ class "col-sm-6 mb-2" ] <|
            [ textarea
                [ class "form-control"
                , placeholder "wgs84 -> уск2000"
                , style "height" "150px"
                , onInput <| ToUskChanged
                , value model.toUskContent
                ]
                []
            , small
                [ class "text-action cursor-pointer"
                , onClick <| ToUskChanged "47.1305050, 33.7418280"
                , attribute "tabindex" "-1"
                ]
                [ text "наприклад" ]
            ]
                ++ (case model.toUskRes of
                        Nothing ->
                            []

                        Just coords ->
                            [ div [ class "text-center fs-3" ]
                                [ text <| C.render <| C.Usk2000 coords
                                ]
                            ]
                   )
                ++ (case model.toMgrsRes |> ListX.find (\x -> x.viewId == 2) of
                        Nothing ->
                            []

                        Just data ->
                            [ div [ class "text-center fs-3" ]
                                [ text <| C.render <| C.MGRS data.coords
                                ]
                            ]
                   )
        ]
