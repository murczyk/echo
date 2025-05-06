module EnumeratedList exposing
    ( EnumeratedItem
    , EnumeratedList(..)
    , deleteAtPos
    , drop
    , empty
    , findByPosition
    , fromList
    , isEmpty
    , length
    , map
    , mapEl
    , mapPair
    , setAtPos
    , toKvList
    , toList
    , updateAtItem
    , updateAtItemPosition
    , updateAtPos
    , updateValAtItem
    )

{-| List with enumerated elements.

Abstraction very similar to a list but enumerating items with a
numeric index, emulating an "id" per each record.

-}

import List
import List.Extra as ListX


type alias EnumeratedItem a =
    { pos : Int
    , el : a
    }


type EnumeratedList a
    = EL (List (EnumeratedItem a))


empty : EnumeratedList a
empty =
    EL []


isEmpty : EnumeratedList a -> Bool
isEmpty (EL xs) =
    case xs of
        [] ->
            True

        _ ->
            False


fromList : List a -> EnumeratedList a
fromList =
    EL << List.indexedMap (\i x -> { pos = i, el = x })


toList : EnumeratedList a -> List a
toList (EL xs) =
    List.map .el xs


toKvList : EnumeratedList a -> List ( Int, a )
toKvList (EL xs) =
    List.map (\x -> ( x.pos, x.el )) xs


map : (EnumeratedItem a -> b) -> EnumeratedList a -> EnumeratedList b
map f (EL xs) =
    fromList <|
        List.map (\item -> f item) xs


mapEl : (a -> b) -> EnumeratedList a -> EnumeratedList b
mapEl f (EL xs) =
    fromList <|
        List.map (\item -> f item.el) xs


mapPair : (( Int, a ) -> b) -> EnumeratedList a -> List b
mapPair f (EL xs) =
    List.map (\item -> f ( item.pos, item.el )) xs


findByPosition : Int -> EnumeratedList a -> Maybe (EnumeratedItem a)
findByPosition n (EL xs) =
    ListX.getAt n xs


updateAtItem :
    EnumeratedItem a
    -> (EnumeratedItem a -> Maybe a)
    -> EnumeratedList a
    -> EnumeratedList a
updateAtItem item f (EL xs) =
    let
        go i yss =
            case yss of
                [] ->
                    []

                y :: ys ->
                    if i == item.pos then
                        case f y of
                            Nothing ->
                                List.map .el ys

                            Just y2 ->
                                y2 :: List.map .el ys

                    else
                        y.el :: go (i + 1) ys
    in
    fromList (go 0 xs)


updateAtPos :
    Int
    -> (EnumeratedItem a -> Maybe a)
    -> EnumeratedList a
    -> EnumeratedList a
updateAtPos pos f (EL xs) =
    let
        go i yss =
            case yss of
                [] ->
                    []

                y :: ys ->
                    if i == pos then
                        case f y of
                            Nothing ->
                                List.map .el ys

                            Just y2 ->
                                y2 :: List.map .el ys

                    else
                        y.el :: go (i + 1) ys
    in
    fromList (go 0 xs)


setAtPos :
    Int
    -> a
    -> EnumeratedList a
    -> EnumeratedList a
setAtPos pos y2 (EL xs) =
    let
        go i yss =
            case yss of
                [] ->
                    []

                y :: ys ->
                    if i == pos then
                        y2 :: List.map .el ys

                    else
                        y.el :: go (i + 1) ys
    in
    fromList (go 0 xs)


deleteAtItem :
    EnumeratedItem a
    -> EnumeratedList a
    -> EnumeratedList a
deleteAtItem item xs =
    updateAtItem item (always Nothing) xs


deleteAtPos :
    Int
    -> EnumeratedList a
    -> EnumeratedList a
deleteAtPos pos xs =
    updateAtPos pos (always Nothing) xs


updateValAtItem :
    EnumeratedItem a
    -> (a -> Maybe a)
    -> EnumeratedList a
    -> EnumeratedList a
updateValAtItem item f xs =
    updateAtItem item
        (\v ->
            f v.el
        )
        xs


updateAtItemPosition :
    Int
    -> (EnumeratedItem a -> Maybe a)
    -> EnumeratedList a
    -> EnumeratedList a
updateAtItemPosition position f (EL xs) =
    let
        go i yss =
            case yss of
                [] ->
                    []

                y :: ys ->
                    if i == position then
                        case f y of
                            Nothing ->
                                List.map .el ys

                            Just y2 ->
                                y2 :: List.map .el ys

                    else
                        y.el :: go (i + 1) ys
    in
    fromList (go 0 xs)


length : EnumeratedList a -> Int
length =
    List.length << toList


drop : Int -> EnumeratedList a -> EnumeratedList a
drop n =
    fromList << List.drop n << toList



-- enumerate : List a -> List ( Int, a )
-- enumerate xsOrig =
--     let
--         go counter xs =
--             case xs of
--                 [] ->
--                     []
--                 x :: tail ->
--                     ( counter, x ) :: go (counter + 1) tail
--     in
--     go 0 xsOrig
