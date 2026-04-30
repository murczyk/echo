module Utils.Api.RetryableHttp exposing
    ( defaultRetryConfig
    , retryablePost
    )

import Core.Types exposing (ApiError)
import Dict
import Effect as E exposing (Effect)
import Http
import Json.Decode as D
import Task exposing (Task)
import Utils.Api.Retry exposing (Policy, exponentialBackoff, maxDuration, maxRetries, with)


type alias RetryConfig =
    { maxRetries : Int
    , maxDurationMs : Int
    , initialIntervalMs : Float
    , maxIntervalMs : Float
    }


defaultRetryConfig : RetryConfig
defaultRetryConfig =
    { maxRetries = 3
    , maxDurationMs = 30000
    , initialIntervalMs = 2000
    , maxIntervalMs = 10000
    }


toRetryPolicies : RetryConfig -> List (Policy ApiError)
toRetryPolicies config =
    [ maxRetries config.maxRetries
    , maxDuration config.maxDurationMs
    , exponentialBackoff
        { interval = config.initialIntervalMs
        , maxInterval = config.maxIntervalMs
        }
    ]


retryablePost :
    RetryConfig
    -> (Result ApiError a -> msg)
    -> { url : String, body : Http.Body, decoder : D.Decoder a }
    -> Effect msg
retryablePost config toMsg request =
    let
        httpTask : Task ApiError a
        httpTask =
            Http.task
                { method = "POST"
                , headers = []
                , url = request.url
                , body = request.body
                , resolver = Http.stringResolver (resolveJson request.decoder)
                , timeout = Nothing
                }
                |> with (toRetryPolicies config)
    in
    E.sendCmd (Task.attempt toMsg httpTask)


resolveJson : D.Decoder a -> Http.Response String -> Result ApiError a
resolveJson decoder response =
    case response of
        Http.BadUrl_ url ->
            Err { httpError = Http.BadUrl url, formErrors = Dict.empty, errors = [] }

        Http.Timeout_ ->
            Err { httpError = Http.Timeout, formErrors = Dict.empty, errors = [] }

        Http.NetworkError_ ->
            Err { httpError = Http.NetworkError, formErrors = Dict.empty, errors = [] }

        Http.BadStatus_ metadata _ ->
            Err { httpError = Http.BadStatus metadata.statusCode, formErrors = Dict.empty, errors = [] }

        Http.GoodStatus_ _ body ->
            case D.decodeString decoder body of
                Ok value ->
                    Ok value

                Err err ->
                    Err { httpError = Http.BadBody (D.errorToString err), formErrors = Dict.empty, errors = [] }
