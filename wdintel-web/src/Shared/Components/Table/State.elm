module Shared.Components.Table.State exposing
    ( State(..)
    , initialSort
    , getSortState
    , sortBy
    )

{-| This module handles table state management - tracking which column to sort by
and in what direction.

# State
@docs State, initialSort

# State Inspection
@docs getSortState, sortBy

-}


{-| Tracks which column to sort by and direction.
-}
type State
    = State String Bool


{-| Create a table state. By providing a column name, you determine which
column should be used for sorting by default. So if you want your table of
yachts to be sorted by length by default, you might say:

    import Shared.Components.Table.State as TableState

    TableState.initialSort "Length"

-}
initialSort : String -> State
initialSort header =
    State header False


{-| Inspect the current table state. Which column is being sorted by,
and whether the sort order is reversed. This could be useful for storing
the sort state in a URL or somewhere else outside of Elm.
-}
getSortState : State -> ( String, Bool )
getSortState state =
    case state of
        State column isReversed ->
            ( column, isReversed )


{-| Create a table state with a column to sort by, and whether to
reverse the order. This allows a sort to be applied from URL params or
somewhere else outside of Elm.
-}
sortBy : String -> Bool -> State
sortBy =
    State
