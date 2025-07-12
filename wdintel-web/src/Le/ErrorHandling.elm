module Le.ErrorHandling exposing (ErrorDetails, getErrorTypeMessage, getErrorDetails, getHttpStatusString, formatErrorWithCustomTitle, formatErrorForShowError)

import Http
import Le.Types

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
    E.sendCmd (Le.Block.Toast.addError ToastMsg (errorDetails.title ++ "\n" ++ errorDetails.content))
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
            "Деталі: " ++ message

{-| Extracts HTTP status code from ApiError as a string. Returns "0" for non-HTTP errors. -}
getHttpStatusString : Le.Types.ApiError -> String
getHttpStatusString error =
    case error.httpError of
        Http.BadStatus code ->
            String.fromInt code
        _ ->
            "0"

{-| Creates comprehensive error details with custom title and default error info as content -}
formatErrorWithCustomTitle : String -> Le.Types.ApiError -> ErrorDetails
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
formatErrorForShowError : String -> Le.Types.ApiError -> String
formatErrorForShowError customTitle error =
    let
        errorDetails = formatErrorWithCustomTitle customTitle error
    in
    errorDetails.title ++ ": " ++ errorDetails.content
