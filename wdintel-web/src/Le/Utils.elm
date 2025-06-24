module Le.Utils exposing (andThen, capitalize, decodePair, def, emptySToNothing, emptyToNothing, enumerate, extractMRecordField, findAllAdjacentFreqs, findK, flip, for_, getLabelOrDefault, ifOrEmpty, insertShowMapToQuery, jumpToBottom, mapFst, mapSnd, mmap, msgToHtml, networkKindVHFMapping, onKeyDown, renderZoneError, resToList, textBeforeComma, trueToOne, twoSign, unique, updateV, zeroToNothing)

import Browser.Dom
import Dict
import Html exposing (Attribute, Html)
import Html.Events exposing (..)
import Json.Decode as Decode exposing (Decoder)
import List.Extra as ListX
import Route exposing (Route)
import Task
import TimeZone


decodePair : Decoder a -> Decoder b -> Decoder ( a, b )
decodePair da db =
    Decode.index 0 da
        |> Decode.andThen
            (\aVal ->
                Decode.index 1 db
                    |> Decode.map (\bVal -> ( aVal, bVal ))
            )


mapFst : (a1 -> a2) -> ( a1, b ) -> ( a2, b )
mapFst f v =
    let
        ( v1, v2 ) =
            v
    in
    ( f v1, v2 )


mapSnd : (b1 -> b2) -> ( a, b1 ) -> ( a, b2 )
mapSnd f v =
    let
        ( v1, v2 ) =
            v
    in
    ( v1, f v2 )


twoSign : Int -> String
twoSign x =
    if x < 10 then
        "0" ++ String.fromInt x

    else
        String.fromInt x


enumerate : List a -> List ( Int, a )
enumerate xss =
    let
        go i xs =
            case xs of
                [] ->
                    []

                x :: xs_tl ->
                    ( i, x ) :: go (i + 1) xs_tl
    in
    go 0 xss


findK : k -> List ( k, v ) -> Maybe v
findK k1 xss =
    case xss of
        [] ->
            Nothing

        ( k, v ) :: xs ->
            if k == k1 then
                Just v

            else
                findK k1 xs


updateV : k -> (v -> v) -> List ( k, v ) -> List ( k, v )
updateV k1 f xs =
    ListX.updateIf
        (\( k, _ ) -> k == k1)
        (\( k, x ) -> ( k, f x ))
        xs


emptyToNothing : List a -> Maybe (List a)
emptyToNothing xs =
    case xs of
        [] ->
            Nothing

        _ ->
            Just xs


zeroToNothing : Int -> Maybe Int
zeroToNothing x =
    if x == 0 then
        Nothing

    else
        Just x


emptySToNothing : String -> Maybe String
emptySToNothing x =
    if x == "" then
        Nothing

    else
        Just x


ifOrEmpty if_ then_ =
    if if_ then
        then_

    else
        []


onKeyDown : (Int -> msg) -> Attribute msg
onKeyDown tagger =
    on "keydown" (Decode.map tagger keyCode)


jumpToBottom : String -> msg -> Cmd msg
jumpToBottom id noOp =
    Browser.Dom.getViewportOf id
        |> Task.andThen (\info -> Browser.Dom.setViewportOf id 0 info.scene.height)
        |> Task.attempt (\_ -> noOp)


{-| turns "line1\\nline2" into "line1<br>\\nline2"
-}
msgToHtml : String -> List (Html msg)
msgToHtml msg =
    let
        lines =
            String.lines msg

        renderLine l =
            [ Html.text l, Html.br [] [] ]
    in
    List.concatMap renderLine lines


unique : List a -> List a
unique list =
    List.foldl
        (\a uniques ->
            if List.member a uniques then
                uniques

            else
                uniques ++ [ a ]
        )
        []
        list


resToList x =
    case x of
        Err _ ->
            []

        Ok v ->
            [ v ]


def =
    Maybe.withDefault


mmap =
    Maybe.map


andThen =
    Maybe.andThen


flip : (a -> b -> c) -> (b -> a -> c)
flip f_ab b a =
    f_ab a b


{-| Used with nominatim results
-}
textBeforeComma : String -> String
textBeforeComma s =
    case String.split "," s of
        x :: _ ->
            x

        _ ->
            s


renderZoneError : TimeZone.Error -> String
renderZoneError err =
    case err of
        TimeZone.NoZoneName ->
            "TimeZone error: No zone name"

        TimeZone.NoDataForZoneName s ->
            "TimeZone error: No data for zone name: " ++ s


trueToOne : Bool -> Int
trueToOne b =
    if b then
        1

    else
        0


for_ : List a -> (a -> b) -> List b
for_ =
    flip List.map


extractMRecordField : (record -> a) -> a -> Maybe record -> a
extractMRecordField accessor default mRecord =
    mRecord |> Maybe.map accessor |> Maybe.withDefault default


getLabelOrDefault : String -> String
getLabelOrDefault label =
    if String.isEmpty label then
        "<Незазначений>"

    else
        label


insertShowMapToQuery : Route () -> String
insertShowMapToQuery r =
    let
        query =
            r.query

        updatedQuery =
            Dict.insert "showMap" "true" query
    in
    Route.toString { r | query = updatedQuery }


isInRange : String -> String -> Float -> Bool
isInRange selectedS freqS range =
    case ( String.toFloat selectedS, String.toFloat freqS ) of
        ( Just selected, Just freq ) ->
            freq >= (selected - range) && freq <= (selected + range)

        _ ->
            False


findAllAdjacentFreqs : List String -> List String -> Float -> List String
findAllAdjacentFreqs allFrequencies selectedFrequencies range =
    allFrequencies
        |> List.filter
            (\freq ->
                not (List.member freq selectedFrequencies)
                    && List.any (\selected -> isInRange selected freq range) selectedFrequencies
            )


networkKindVHFMapping kind =
    case kind of
        "VHF" ->
            "УКХ"

        other ->
            other


capitalize : String -> String
capitalize str =
    case String.uncons str of
        Nothing ->
            str

        Just ( firstChar, rest ) ->
            String.cons (Char.toUpper firstChar) rest
