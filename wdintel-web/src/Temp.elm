module Temp exposing (..)

import Dict exposing (Dict)
import Http
import Json.Decode as Decode
import Le.Types exposing (ApiError)


leExpectJson : (Result ApiError a -> msg) -> Decode.Decoder a -> Http.Expect msg
leExpectJson toMsg decoder =
    Http.expectStringResponse toMsg <|
        \response ->
            case response of
                Http.BadUrl_ url ->
                    Err { httpError = Http.BadUrl url, formErrors = Dict.empty, errors = [] }

                Http.Timeout_ ->
                    Err { httpError = Http.Timeout, formErrors = Dict.empty, errors = [] }

                Http.NetworkError_ ->
                    Err { httpError = Http.NetworkError, formErrors = Dict.empty, errors = [] }

                Http.BadStatus_ metadata body ->
                    case metadata.statusCode of
                        400 ->
                            case Decode.decodeString (Decode.list (jsonPair Decode.string Decode.string)) body of
                                Err decodeErr ->
                                    Err
                                        { httpError = Http.BadStatus metadata.statusCode
                                        , errors = [ "Error while decoding a back-end response: " ++ Decode.errorToString decodeErr ]
                                        , formErrors = Dict.empty
                                        }

                                Ok vs ->
                                    Err
                                        { httpError = Http.BadStatus metadata.statusCode
                                        , errors = []
                                        , formErrors = Dict.fromList vs
                                        }

                        _ ->
                            Err { httpError = Http.BadStatus metadata.statusCode, formErrors = Dict.empty, errors = [ "Помилка сервера. Спробуйте пізніше або зверніться в підтримку." ] }

                Http.GoodStatus_ _ body ->
                    case Decode.decodeString decoder body of
                        Ok value ->
                            Ok value

                        Err err ->
                            Err { httpError = Http.BadBody (Decode.errorToString err), formErrors = Dict.empty, errors = [] }


jsonPair : Decode.Decoder a -> Decode.Decoder b -> Decode.Decoder ( a, b )
jsonPair a b =
    Decode.andThen
        (\xs ->
            case xs of
                [] ->
                    Decode.fail "Expecting a list of two elements"

                x :: y :: [] ->
                    case ( Decode.decodeValue a x, Decode.decodeValue b y ) of
                        ( Ok av, Ok bv ) ->
                            Decode.succeed ( av, bv )

                        _ ->
                            Decode.fail "Error while decoding individual pair fields"

                _ ->
                    Decode.fail "Expecting a list of two elements"
        )
        (Decode.list Decode.value)


{-| this helper function copied from <https://github.com/elm/http/blob/2.0.0/src/Http.elm#L514-L521>
-}
resolve : (body -> Result String a) -> Http.Response body -> Result ApiError a
resolve toResult response =
    case response of
        Http.BadUrl_ url ->
            Err { httpError = Http.BadUrl url, formErrors = Dict.empty, errors = [] }

        Http.Timeout_ ->
            Err { httpError = Http.Timeout, formErrors = Dict.empty, errors = [] }

        Http.NetworkError_ ->
            Err { httpError = Http.NetworkError, formErrors = Dict.empty, errors = [] }

        Http.BadStatus_ metadata _ ->
            Err
                { httpError = Http.BadStatus metadata.statusCode
                , errors = [ "Error while decoding a back-end response: " ++ "<todo: see if we can extract more from elm>" ]
                , formErrors = Dict.empty
                }

        Http.GoodStatus_ _ body ->
            case toResult body of
                Ok v ->
                    Ok v

                Err err ->
                    Err { httpError = Http.BadBody err, formErrors = Dict.empty, errors = [] }
