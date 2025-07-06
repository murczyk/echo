module Shared exposing
    ( Flags
    , Model
    , Msg
    , decoder
    , init
    , subscriptions
    , update
    )

import Api
import Dict
import Effect as E exposing (Effect)
import Http
import Json.Decode
import Le.Block.Toast
import Le.RemoteData as RD exposing (RemoteData(..))
import PagePorts.SharedPorts as Ports
import Process
import Route exposing (Route)
import Route.Path
import Shared.Model
import Shared.Msg exposing (Msg(..))
import Task
import TimeZone
import Url


type alias Flags =
    { isDark : Bool
    , now : Int
    }


decoder : Json.Decode.Decoder Flags
decoder =
    Json.Decode.map2 Flags
        (Json.Decode.field "isDark" Json.Decode.bool)
        (Json.Decode.field "now" Json.Decode.int)


type alias Model =
    Shared.Model.Model


init : Result Json.Decode.Error Flags -> Route () -> ( Model, Effect Msg )
init flagsResult route =
    let
        flags =
            case flagsResult of
                Ok flags_ ->
                    flags_

                Err _ ->
                    { isDark = False
                    , now = 0
                    }
    in
    ( { user =
            Just
                { name = "anonymous"
                , roles = []
                , sigintZoneId = Nothing
                , organismId = Nothing
                , deltaLogin = Nothing
                }
      , isDarkMode = flags.isDark
      , location = Nothing
      , serverInfo = Nothing
      , masterUnits = NotAsked
      , now = flags.now
      , timeZone = TimeZone.europe__kyiv ()
      , callsignsInfo = Dict.empty
      , posts = NotAsked
      , toasts = Le.Block.Toast.init
      }
    , E.batch
        [ E.sendCmd <| Ports.shared_getLocation ()
        , E.sendCmd <| Api.server_info GotServerInfo
        , E.getUnits MasterUnitsLoadedByApi
            { sortBy = Nothing
            , afterUnitId = Nothing
            , beforeUnitId = Nothing
            }
        ]
    )


type alias Msg =
    Shared.Msg.Msg


update : Route () -> Msg -> Model -> ( Model, Effect Msg )
update req msg model =
    case msg of
        SignIn user ->
            ( { model | user = Just user }
            , E.pushRoute { path = Route.Path.Home_, query = Dict.empty, hash = Nothing }
            )

        GotUser (Err e) ->
            if e.httpError == Http.BadStatus 401 then
                if req.path == Route.Path.Login then
                    ( model, E.none )

                else
                    ( model
                    , E.replaceRoute { path = Route.Path.Login, query = Dict.fromList [ ( "redirect", Url.toString req.url ) ], hash = Nothing }
                    )

            else
                ( model, E.none )

        GotUser (Ok user) ->
            ( { model | user = Just user }
            , if req.path == Route.Path.Login then
                E.replaceRoutePath Route.Path.Home_

              else
                E.none
            )

        ToggleDarkMode ->
            ( { model | isDarkMode = not model.isDarkMode }
            , E.sendCmd <| Ports.shared_toggleDarkMode ()
            )

        TriggerResize ->
            ( model
            , E.sendCmd <| Ports.shared_triggerResize ()
            )

        SignOut ->
            ( { model | user = Nothing }
            , E.sendCmd <| Api.logout SignOutDone
            )

        SignOutDone _ ->
            ( model, E.replaceRoutePath Route.Path.Login )

        GotLocation loc ->
            ( { model | location = Just loc }
            , E.sendCmd <| Api.api_user GotUser
            )

        GotServerInfo (Err _) ->
            ( model, E.none )

        GotServerInfo (Ok v) ->
            ( { model | serverInfo = Just v }, E.none )

        MasterUnitsLoadedByApi (Err err) ->
            ( { model | masterUnits = Failure err }, E.none )

        MasterUnitsLoadedByApi (Ok rsp) ->
            ( { model
                | masterUnits =
                    rsp.units
                        |> List.map (\x -> ( x.id, x ))
                        |> Dict.fromList
                        |> Success
              }
            , E.none
            )

        CallsignsInfoReturnedByApi (Err e) ->
            ( model, E.none )

        CallsignsInfoReturnedByApi (Ok callsigns) ->
            let
                m2 =
                    List.foldl
                        (\callsign m ->
                            { m
                                | callsignsInfo =
                                    Dict.insert callsign.callsign
                                        callsign.res
                                        m.callsignsInfo
                            }
                        )
                        model
                        callsigns
            in
            ( m2, E.none )

        CallsignsInfoAskedByPage callsigns ->
            let
                callsignsWithoutLoadedInfo =
                    List.filter (\callsign -> not (Dict.member callsign model.callsignsInfo)) callsigns
            in
            ( model
            , if List.length callsignsWithoutLoadedInfo > 0 then
                E.getCallsignsInfo CallsignsInfoReturnedByApi { callsigns = callsignsWithoutLoadedInfo }

              else
                E.none
            )

        PostLoadAll payload ->
            ( model
            , E.sendCmd <| Api.get_posts PostsReturnedByApi payload
            )

        PostsReturnedByApi (Ok res) ->
            ( { model
                | posts =
                    List.map (\post -> ( post.id, post )) res
                        |> Dict.fromList
                        |> Success
              }
            , E.none
            )

        PostsReturnedByApi (Err err) ->
            ( model, E.none )

        ToastMsg toastMsg ->
            let
                ( toastModel, toastCmd ) =
                    Le.Block.Toast.update toastMsg model.toasts
            in
            ( { model | toasts = toastModel }
            , E.sendCmd <| Cmd.map ToastMsg toastCmd
            )


subscriptions : Route () -> Model -> Sub Msg
subscriptions _ _ =
    Ports.shared_getLocationRes GotLocation
