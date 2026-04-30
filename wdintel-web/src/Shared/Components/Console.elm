module Shared.Components.Console exposing (Console(..), Model(..), Msg(..), findLastProgress, init, isInProgress, update, view)

{-| See <https://elm.land/concepts/components.html> for background on this pattern.
-}

import Api
import Bindings as B
import Core.Coordinates as C
import Core.Types exposing (ApiError)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Extra as HtmlX
import Process
import Regex
import Shared.Components.Toast
import Task
import Utils.Utils exposing (..)


type Console msg
    = Settings
        { model : Model
        , toMsg : Msg msg -> msg
        , finalizer : Effect msg
        }


type Model
    = Model
        { formErrors : Dict String String
        , toasts : Shared.Components.Toast.Model
        , taskId : Maybe Int
        , statusAndLogsRsp : Maybe B.BgtaskStatusAndLogsRsp
        , overallLogs : List String
        , inProgress : Bool
        }


isInProgress : Model -> Bool
isInProgress (Model model) =
    model.inProgress


init : Model
init =
    Model
        { formErrors = Dict.empty
        , toasts = Shared.Components.Toast.init
        , taskId = Nothing
        , statusAndLogsRsp = Nothing
        , overallLogs = []
        , inProgress = False
        }


type Msg msg
    = ToastMsg Shared.Components.Toast.Msg
    | TaskLaunched Int
    | StatusAndLogsDone Int (Result ApiError B.BgtaskStatusAndLogsRsp)
    | StatusAndLogsSleepDone Int Int ()


progressRegex : Regex.Regex
progressRegex =
    Maybe.withDefault Regex.never <|
        Regex.fromString """\\[(\\d+)/(\\d+)\\]"""


findLastProgress : List String -> Maybe { overall : Int, curr : Int }
findLastProgress sss0 =
    let
        go sss =
            case sss of
                [] ->
                    Nothing

                s :: ss ->
                    case Regex.find progressRegex s of
                        [ match ] ->
                            case match.submatches of
                                [ Just curr, Just overall ] ->
                                    case ( String.toInt curr, String.toInt overall ) of
                                        ( Just currI, Just overallI ) ->
                                            Just { curr = currI, overall = overallI }

                                        _ ->
                                            go ss

                                _ ->
                                    go ss

                        _ ->
                            go ss
    in
    go (List.reverse sss0)


getMError : Model -> Maybe String
getMError (Model model) =
    Maybe.andThen .finishedWithError model.statusAndLogsRsp


isError : Model -> Bool
isError model =
    case getMError model of
        Nothing ->
            False

        Just _ ->
            True


update :
    { msg : Msg msg
    , model : Model
    , toModel : Model -> model
    , toMsg : Msg msg -> msg
    , finalizer : Effect msg
    }
    -> ( model, Effect msg )
update props =
    let
        (Model model) =
            props.model

        toParentModel : ( Model, Effect msg ) -> ( model, Effect msg )
        toParentModel ( innerModel, effect ) =
            ( props.toModel innerModel
            , effect
            )
    in
    toParentModel <|
        case props.msg of
            ToastMsg imsg ->
                let
                    ( im, icmds ) =
                        Shared.Components.Toast.update imsg model.toasts
                in
                ( Model { model | toasts = im }
                , E.map props.toMsg <| E.sendCmd <| Cmd.map ToastMsg icmds
                )

            StatusAndLogsDone _ (Err e) ->
                let
                    m2 =
                        { model | inProgress = False }
                in
                mapFst Model <| mapSnd (E.map props.toMsg) <| Api.handleHttpError ToastMsg e m2

            StatusAndLogsDone taskId (Ok rsp) ->
                let
                    loglines2 =
                        model.overallLogs ++ rsp.loglines

                    m2 =
                        { model
                            | statusAndLogsRsp = Just rsp
                            , overallLogs = loglines2
                            , inProgress = rsp.running
                        }
                in
                ( Model m2
                , if rsp.running then
                    E.map props.toMsg <|
                        E.sendCmd <|
                            Task.perform
                                (StatusAndLogsSleepDone taskId (List.length model.overallLogs))
                                (Process.sleep 1000.0)

                  else
                    props.finalizer
                )

            StatusAndLogsSleepDone taskId _ () ->
                ( Model model
                , E.map props.toMsg <|
                    E.sendCmd <|
                        Api.bgtask_status_and_logs (StatusAndLogsDone taskId)
                            taskId
                            { skip =
                                List.length model.overallLogs
                            }
                )

            TaskLaunched taskId ->
                ( Model { model | taskId = Just taskId, inProgress = True, overallLogs = [] }
                , E.map props.toMsg <|
                    E.sendCmd <|
                        Api.bgtask_status_and_logs (StatusAndLogsDone taskId)
                            taskId
                            { skip = List.length model.overallLogs
                            }
                )


view : Model -> Html msg
view (Model model) =
    case List.length model.overallLogs of
        0 ->
            div [] []

        _ ->
            let
                prog =
                    if not model.inProgress then
                        { overall = 100, curr = 100 }

                    else
                        findLastProgress model.overallLogs
                            |> Maybe.withDefault
                                { overall = 100
                                , curr = 1
                                }

                progFloat =
                    100.0 * toFloat prog.curr / toFloat prog.overall
            in
            div [ class "flex mb-4 mt-4" ]
                [ div [ class "w-full" ]
                    [ div [ class "bg-gray-100 p-4 rounded" ] <|
                        [ div [ class "bg-white p-4 rounded border" ]
                            [ HtmlX.viewIf (not model.inProgress) <|
                                div
                                    [ style "font-size" "3rem"
                                    , class "p-3"
                                    ]
                                    [ i
                                        [ class "bi "

                                        -- text-success
                                        , classList
                                            [ ( "text-green-600 bi-check-circle-fill", not (isError (Model model)) )
                                            , ( "text-red-600 bi-exclamation-triangle-fill", isError (Model model) )
                                            ]
                                        ]
                                        []
                                    ]
                            , div [ class "w-full bg-gray-200 rounded-full h-2" ]
                                [ div
                                    [ class "bg-blue-600 h-2 rounded-full"
                                    , classList [ ( "animate-pulse", model.inProgress ) ]
                                    , attribute "role" "progressbar"
                                    , attribute "aria-valuenow" (String.fromInt prog.curr)
                                    , attribute "aria-valuemin" "1"
                                    , attribute "aria-valuemax" (String.fromInt prog.overall)
                                    , style "width" (C.renderWgsFloat progFloat ++ "%")
                                    ]
                                    []
                                ]
                            ]
                        , div [ class "bg-gray-50 p-4 rounded mt-4" ] <|
                            pre [ class "bg-gray-900 text-white p-3 rounded log-pre-block me-auto" ]
                                [ text <| String.join "\n" model.overallLogs
                                ]
                                :: (case getMError (Model model) of
                                        Just finishedWithError ->
                                            [ div [ class "bg-red-50 p-4 rounded mt-4" ]
                                                [ pre [ class "text-red-600" ]
                                                    [ text <| finishedWithError
                                                    ]
                                                ]
                                            ]

                                        Nothing ->
                                            []
                                   )
                        ]
                    ]
                ]
