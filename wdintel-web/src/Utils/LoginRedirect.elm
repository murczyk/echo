module Utils.LoginRedirect exposing (destination, loginQuery, normalize, relativeUrl)

import Char
import Dict exposing (Dict)
import Url exposing (Url)


relativeUrl : Url -> String
relativeUrl url =
    url.path
        ++ (url.query |> Maybe.map ((++) "?") |> Maybe.withDefault "")
        ++ (url.fragment |> Maybe.map ((++) "#") |> Maybe.withDefault "")


normalize : Url -> String -> Maybe String
normalize current target =
    let
        origin =
            Url.toString { current | path = "", query = Nothing, fragment = Nothing }

        parsed =
            if String.startsWith "/" target then
                Url.fromString (origin ++ target)

            else
                Url.fromString target

        safePath path =
            Url.percentDecode path
                |> Maybe.map
                    (\decoded ->
                        not (String.contains "\\" decoded)
                            && not (String.startsWith "//" decoded)
                            && not (String.any isUnsafeCharacter decoded)
                            && canonicalPath decoded /= "/login"
                    )
                |> Maybe.withDefault False
    in
    if String.startsWith "//" target || String.any isUnsafeCharacter target then
        Nothing

    else
        parsed
            |> Maybe.andThen
                (\url ->
                    if url.protocol == current.protocol && url.host == current.host && effectivePort url == effectivePort current && safePath url.path then
                        Just (relativeUrl url)

                    else
                        Nothing
                )


effectivePort : Url -> Int
effectivePort url =
    Maybe.withDefault
        (case url.protocol of
            Url.Http ->
                80

            Url.Https ->
                443
        )
        url.port_


isUnsafeCharacter : Char -> Bool
isUnsafeCharacter char =
    Char.toCode char <= 32 || Char.toCode char == 127


canonicalPath : String -> String
canonicalPath path =
    let
        step segment segments =
            case segment of
                "" ->
                    segments

                "." ->
                    segments

                ".." ->
                    List.drop 1 segments

                _ ->
                    segment :: segments
    in
    "/" ++ (String.split "/" path |> List.foldl step [] |> List.reverse |> String.join "/")


destination : Url -> Dict String String -> String
destination current query =
    Dict.get "redirect" query
        |> Maybe.andThen (normalize current)
        |> Maybe.withDefault "/"


loginQuery : Url -> Dict String String
loginQuery url =
    normalize url (relativeUrl url)
        |> Maybe.map (\target -> Dict.singleton "redirect" target)
        |> Maybe.withDefault Dict.empty
