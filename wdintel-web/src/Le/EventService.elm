module Le.EventService exposing
    ( EventState
    , Msg(..)
    , init
    , update
    , view
    )

import Bindings as B
import Effect as E exposing (Effect)
import Html exposing (Html, div, text)
import Html.Attributes exposing (class)
import Http
import Le.Types exposing (ApiError)
import Le.Utils exposing (..)
import Process
import Task
import Temp exposing (leExpectJson)


-- TYPES


type alias EventState =
    { isPolling : Bool
    , lastEventId : Maybe String
    , error : Maybe String
    , retryCount : Int
    , retryDelay : Int -- milliseconds
    }





type Msg
    = StartPolling
    | StopPolling
    | PollEvents
    | EventsReceived (Result ApiError B.LongPollRsp)
    | RetryPolling
    | ResetRetryCount


-- INIT


init : EventState
init =
    { isPolling = False
    , lastEventId = Nothing
    , error = Nothing
    , retryCount = 0
    , retryDelay = 1000 -- Start with 1 second
    }


-- UPDATE


update : Msg -> EventState -> ( EventState, Effect Msg )
update msg state =
    case msg of
        StartPolling ->
            ( { state | isPolling = True, error = Nothing, retryCount = 0, retryDelay = 1000 }
            , pollEvents state.lastEventId
            )

        StopPolling ->
            ( { state | isPolling = False, error = Nothing }
            , E.none
            )

        PollEvents ->
            if state.isPolling then
                ( state
                , pollEvents state.lastEventId
                )

            else
                ( state, E.none )

        EventsReceived (Ok response) ->
            let
                newState =
                    { state
                        | lastEventId = response.lastEventId
                        , error = Nothing
                        , retryCount = 0
                        , retryDelay = 1000
                    }
            in
            ( newState
            , E.batch
                [ E.sendCmd <| Task.perform (\_ -> PollEvents) (Process.sleep 100.0)
                ]
            )

        EventsReceived (Err error) ->
            let
                newRetryCount =
                    state.retryCount + 1

                newRetryDelay =
                    -- Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
                    min 30000 (state.retryDelay * 2)

                shouldRetry =
                    newRetryCount <= 5 && state.isPolling

                newState =
                    { state
                        | error = Just (formatError error)
                        , retryCount = newRetryCount
                        , retryDelay = newRetryDelay
                    }
            in
            if shouldRetry then
                ( newState
                , E.sendCmd <| Task.perform (\_ -> RetryPolling) (Process.sleep (toFloat newRetryDelay))
                )

            else
                ( { newState | isPolling = False }
                , E.none
                )

        RetryPolling ->
            if state.isPolling then
                ( state
                , pollEvents state.lastEventId
                )

            else
                ( state, E.none )

        ResetRetryCount ->
            ( { state | retryCount = 0, retryDelay = 1000 }
            , E.none
            )


-- HTTP REQUESTS


pollEvents : Maybe String -> Effect Msg
pollEvents lastEventId =
    let
        request : B.LongPollReq
        request =
            { sessionId = "current" -- We'll get this from session later
            , lastEventId = lastEventId
            }
    in
    E.sendCmd <|
        Http.post
            { url = "/api/event-stream/long-poll"
            , body = Http.jsonBody (B.longPollReqEncoder request)
            , expect = leExpectJson EventsReceived B.longPollRspDecoder
            }


-- HELPERS


formatError : ApiError -> String
formatError error =
    case error.httpError of
        Http.BadStatus code ->
            "HTTP Error: " ++ String.fromInt code

        Http.BadBody message ->
            "Invalid response: " ++ message

        Http.NetworkError ->
            "Network error - please check your connection"

        Http.Timeout ->
            "Request timed out"

        Http.BadUrl url ->
            "Invalid URL: " ++ url


-- VIEW (for debugging/status display)


view : EventState -> Html Msg
view state =
    div [ class "event-service-status" ]
        [ div [ class "status-indicator" ]
            [ text <|
                if state.isPolling then
                    "🟢 Polling active"

                else
                    "🔴 Polling stopped"
            ]
        , case state.error of
            Just error ->
                div [ class "error-message" ]
                    [ text ("Error: " ++ error)
                    , text (" (Retry " ++ String.fromInt state.retryCount ++ "/5)")
                    ]

            Nothing ->
                text ""
        , div [ class "event-info" ]
            [ text ("Last Event ID: " ++ Maybe.withDefault "None" state.lastEventId)
            ]
        ] 