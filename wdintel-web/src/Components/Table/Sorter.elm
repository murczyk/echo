module Components.Table.Sorter exposing
    ( Sorter(..)
    , unsortable
    , increasingBy
    , decreasingBy
    , increasingOrDecreasingBy
    , decreasingOrIncreasingBy
    , applySorter
    , findSorter
    )

{-| This module handles sorting logic for table columns.

# Sorter Types
@docs Sorter, unsortable, increasingBy, decreasingBy
@docs increasingOrDecreasingBy, decreasingOrIncreasingBy

# Internal Sorting Functions
@docs applySorter, findSorter

-}


{-| Specifies a particular way of sorting data.
-}
type Sorter data
    = None
    | Increasing (List data -> List data)
    | Decreasing (List data -> List data)
    | IncOrDec (List data -> List data)
    | DecOrInc (List data -> List data)


{-| A sorter for columns that are unsortable. Maybe you have a column in your
table for delete buttons that delete the row. It would not make any sense to
sort based on that column.
-}
unsortable : Sorter data
unsortable =
    None


{-| Create a sorter that can only display the data in increasing order. If we
want a table of people, sorted alphabetically by name, we would say this:

    sorter : Sorter { a | name : comparable }
    sorter =
        increasingBy .name

-}
increasingBy : (data -> comparable) -> Sorter data
increasingBy toComparable =
    Increasing (List.sortBy toComparable)


{-| Create a sorter that can only display the data in decreasing order. If we
want a table of countries, sorted by population from highest to lowest, we
would say this:

    sorter : Sorter { a | population : comparable }
    sorter =
        decreasingBy .population

-}
decreasingBy : (data -> comparable) -> Sorter data
decreasingBy toComparable =
    Decreasing (List.sortBy toComparable)


{-| Sometimes you want to be able to sort data in increasing _or_ decreasing
order. Maybe you have a bunch of data about orange juice, and you want to know
both which has the most sugar, and which has the least sugar. Both interesting!
This function lets you see both, starting with decreasing order.

    sorter : Sorter { a | sugar : comparable }
    sorter =
        decreasingOrIncreasingBy .sugar

-}
decreasingOrIncreasingBy : (data -> comparable) -> Sorter data
decreasingOrIncreasingBy toComparable =
    DecOrInc (List.sortBy toComparable)


{-| Sometimes you want to be able to sort data in increasing _or_ decreasing
order. Maybe you have race times for the 100 meter sprint. This function lets
sort by best time by default, but also see the other order.

    sorter : Sorter { a | time : comparable }
    sorter =
        increasingOrDecreasingBy .time

-}
increasingOrDecreasingBy : (data -> comparable) -> Sorter data
increasingOrDecreasingBy toComparable =
    IncOrDec (List.sortBy toComparable)


{-| Apply a sorter to a list of data based on whether it should be reversed.
-}
applySorter : Bool -> Sorter data -> List data -> List data
applySorter isReversed sorter data =
    case sorter of
        None ->
            data

        Increasing srt ->
            srt data

        Decreasing srt ->
            List.reverse (srt data)

        IncOrDec srt ->
            if isReversed then
                List.reverse (srt data)

            else
                srt data

        DecOrInc srt ->
            if isReversed then
                srt data

            else
                List.reverse (srt data)


{-| Find a sorter for a given column name from a list of column data.
-}
findSorter : String -> List { a | name : String, sorter : Sorter data } -> Maybe (Sorter data)
findSorter selectedColumn columnData =
    case columnData of
        [] ->
            Nothing

        { name, sorter } :: remainingColumnData ->
            if name == selectedColumn then
                Just sorter

            else
                findSorter selectedColumn remainingColumnData 