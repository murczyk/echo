module Utils.Api.ErrorHandling exposing (ErrorDetails, formatErrorForShowError, formatErrorForShowErrorWithDetails, formatErrorForShowTransientErrorWithDetails, isTemporaryConnectionError)

import Core.Types
import Effect as E
import Http
import Shared.Msg
import Utils.Api.Temp exposing (responseDecodeErrorPrefix)


isTemporaryConnectionError : Core.Types.ApiError -> Bool
isTemporaryConnectionError error =
    case error.httpError of
        Http.NetworkError ->
            True

        Http.Timeout ->
            True

        Http.BadStatus code ->
            code >= 500 && code < 600

        _ ->
            False


{-| Error details structure for comprehensive error handling

    Usage examples:

    -- Simple error with custom title
    let
        errorDetails = Le.ErrorHandling.formatErrorWithCustomTitle "Повідомлення не збереглося" error
    in
    E.showError (errorDetails.title ++ ": " ++ errorDetails.content)

    -- Default error handling (uses error type as title)
    let
        errorDetails = Le.ErrorHandling.formatErrorWithDefaultTitle error
    in
    E.showError (errorDetails.title ++ ": " ++ errorDetails.content)

    -- For toast notifications with separate title and content
    let
        errorDetails = Le.ErrorHandling.formatErrorWithCustomTitle "Помилка збереження" error
    in
    E.sendCmd (Shared.Components.Toast.addError ToastMsg (errorDetails.title ++ "\n" ++ errorDetails.content))

-}
type alias ErrorDetails =
    { title : String
    , content : String
    , statusCode : String
    }


{-| Maps Http.Error types to user-friendly Ukrainian messages

    Examples:
    - Http.BadUrl "invalid-url" → "Невірна URL адреса"
    - Http.Timeout → "Час очікування вичерпано"
    - Http.NetworkError → "Помилка мережі"
    - Http.BadStatus 500 → "Помилка сервера"
    - Http.BadBody "JSON decode error" → "Помилка обробки відповіді"

-}
getErrorTypeMessage : Http.Error -> String
getErrorTypeMessage httpError =
    case httpError of
        Http.BadUrl _ ->
            "Невірна URL адреса"

        Http.Timeout ->
            "Час очікування вичерпано"

        Http.NetworkError ->
            "Помилка мережі"

        Http.BadStatus _ ->
            "Помилка сервера"

        Http.BadBody _ ->
            "Помилка обробки відповіді"


{-| Extracts additional error details for different error types

    Examples:
    - Http.BadUrl "https://invalid.com" → "URL: https://invalid.com"
    - Http.Timeout → "Сервер не відповідає протягом встановленого часу"
    - Http.NetworkError → "Перевірте підключення до мережі"
    - Http.BadStatus 404 → "Код статусу: 404"
    - Http.BadBody "Expected String but got Number" → "Деталі: Expected String but got Number"

-}
getErrorDetails : Http.Error -> String
getErrorDetails httpError =
    case httpError of
        Http.BadUrl url ->
            "URL: " ++ url

        Http.Timeout ->
            "Сервер не відповідає протягом встановленого часу"

        Http.NetworkError ->
            "Перевірте підключення до мережі"

        Http.BadStatus code ->
            "Код статусу: " ++ String.fromInt code

        Http.BadBody message ->
            "Деталі: " ++ badBodyDetails message


badBodyDetails : String -> String
badBodyDetails message =
    responseDecodeErrorDetails message
        |> Maybe.withDefault message


responseDecodeErrorDetails : String -> Maybe String
responseDecodeErrorDetails message =
    if String.startsWith responseDecodeErrorPrefix message then
        Just (String.dropLeft (String.length responseDecodeErrorPrefix) message)

    else
        Nothing


{-| Extracts HTTP status code from ApiError as a string. Returns "0" for non-HTTP errors.
-}
getHttpStatusString : Core.Types.ApiError -> String
getHttpStatusString error =
    case error.httpError of
        Http.BadStatus code ->
            String.fromInt code

        _ ->
            "0"


{-| Creates comprehensive error details with custom title and default error info as content
-}
formatErrorWithCustomTitle : String -> Core.Types.ApiError -> ErrorDetails
formatErrorWithCustomTitle customTitle error =
    let
        errorType =
            getErrorTypeMessage error.httpError

        errorDetails =
            getErrorDetails error.httpError

        statusCode =
            getHttpStatusString error

        content =
            if statusCode /= "0" then
                errorType ++ " (" ++ statusCode ++ "). " ++ errorDetails

            else
                errorType ++ ". " ++ errorDetails
    in
    { title = customTitle
    , content = content
    , statusCode = statusCode
    }


{-| Formats error with custom title for use with E.showError
Returns a formatted string like "Повідомлення не збереглося: Помилка сервера (500). Код статусу: 500"
-}
formatErrorForShowError : String -> Core.Types.ApiError -> String
formatErrorForShowError customTitle error =
    let
        errorDetails =
            formatErrorWithCustomTitle customTitle error
    in
    errorDetails.title ++ ": " ++ errorDetails.content


{-| Creates an Effect that shows error toast with separate title and content using E.showErrorWithDetails
-}
formatErrorForShowErrorWithDetails : String -> Core.Types.ApiError -> E.Effect msg
formatErrorForShowErrorWithDetails =
    formatErrorWith E.showErrorWithDetails


{-| Like `formatErrorForShowErrorWithDetails`, but the toast closes itself after a while.
For errors of background updates (event stream, inbox polling) that recur on every network blip.
Response decode errors stay until closed.
-}
formatErrorForShowTransientErrorWithDetails : String -> Core.Types.ApiError -> E.Effect msg
formatErrorForShowTransientErrorWithDetails =
    formatErrorWith E.showTransientErrorWithDetails


formatErrorWith : (String -> String -> E.Effect msg) -> String -> Core.Types.ApiError -> E.Effect msg
formatErrorWith showDetails customTitle error =
    case error.httpError of
        Http.BadStatus 401 ->
            -- For 401 errors, trigger logout instead of showing error
            E.logout

        Http.BadBody message ->
            case responseDecodeErrorDetails message of
                Just details ->
                    E.sendSharedMsg (Shared.Msg.ShowLoggedResponseDecodeError { title = customTitle, message = details })

                Nothing ->
                    showFormattedErrorWithDetails showDetails customTitle error

        _ ->
            showFormattedErrorWithDetails showDetails customTitle error


showFormattedErrorWithDetails : (String -> String -> E.Effect msg) -> String -> Core.Types.ApiError -> E.Effect msg
showFormattedErrorWithDetails showDetails customTitle error =
    let
        errorDetails =
            formatErrorWithCustomTitle customTitle error
    in
    showDetails errorDetails.title errorDetails.content
