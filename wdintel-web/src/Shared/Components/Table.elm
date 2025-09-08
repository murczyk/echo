module Shared.Components.Table exposing
    ( view
    , config, stringColumn, intColumn, floatColumn
    , withColumnWidth
    , State, initialSort
    , getSortState, sortBy
    , getSortedData
    , Column, customColumn, veryCustomColumn
    , Sorter, unsortable, increasingBy, decreasingBy
    , increasingOrDecreasingBy, decreasingOrIncreasingBy
    , Config, customConfig, Customizations, HtmlDetails, Status
    , defaultCustomizations
    )

{-| This library helps you create sortable tables. The crucial feature is that it
lets you own your data separately and keep it in whatever format is best for
you. This way you are free to change your data without worrying about the table
&ldquo;getting out of sync&rdquo; with the data. Having a single source of
truth is pretty great!

I recommend checking out the [examples] to get a feel for how it works.

[examples]: https://github.com/billstclair/elm-sortable-table/tree/master/examples


# View

@docs view


# Configuration

@docs config, stringColumn, intColumn, floatColumn


# State

@docs State, initialSort
@docs getSortState, sortBy


# Sorted Data Access

@docs getSortedData


# Crazy Customization

If you are new to this library, you can probably stop reading here. After this
point are a bunch of ways to customize your table further. If it does not
provide what you need, you may just want to write a custom table yourself. It
is not that crazy.


## Custom Columns

@docs Column, customColumn, veryCustomColumn
@docs Sorter, unsortable, increasingBy, decreasingBy
@docs increasingOrDecreasingBy, decreasingOrIncreasingBy


## Custom Tables

@docs Config, customConfig, Customizations, HtmlDetails, Status
@docs defaultCustomizations

-}

-- Re-export modules for clean API
import Shared.Components.Table.Column as Column
import Shared.Components.Table.Config as Config
import Shared.Components.Table.Sorter as Sorter
import Shared.Components.Table.State as State
import Shared.Components.Table.View as View
import Html exposing (Html)


-- STATE

{-| Tracks which column to sort by.
-}
type alias State = State.State


{-| Create a table state. By providing a column name, you determine which
column should be used for sorting by default. So if you want your table of
yachts to be sorted by length by default, you might say:

    import Shared.Components.Table as Table

    Table.initialSort "Length"

-}
initialSort : String -> State
initialSort = State.initialSort


{-| Inspect the current table state. Which column is being sorted by,
and whether the sort order is reversed. This could be useful for storing
the sort state in a URL or somewhere else outside of Elm.
-}
getSortState : State -> ( String, Bool )
getSortState = State.getSortState


{-| Create a table state with a column to sort by, and whether to
reverse the order. This allows a sort to be applied URL params or
somewhere else outside of Elm.
-}
sortBy : String -> Bool -> State
sortBy = State.sortBy


-- CONFIG

{-| Configuration for your table, describing your columns.

**Note:** Your `Config` should _never_ be held in your model.
It should only appear in `view` code.

-}
type alias Config data msg = Config.Config data msg


{-| Create the `Config` for your `view` function. Everything you need to
render your columns efficiently and handle selection of columns.

Say we have a `List Person` that we want to show as a table. The table should
have a column for name and age. We would create a `Config` like this:

    import Shared.Components.Table as Table

    type Msg = NewTableState State | ...

    config : Table.Config Person Msg
    config =
      Table.config
        { toId = .name
        , toMsg = NewTableState
        , columns =
            [ Table.stringColumn "Name" .name
            , Table.intColumn "Age" .age
            ]
        }

You provide the following information in your table configuration:

  - `toId` &mdash; turn a `Person` into a unique ID. This lets us use
    [`Html.Keyed`][keyed] under the hood to make re-sorts faster.
  - `columns` &mdash; specify some columns to show.
  - `toMsg` &mdash; a way to send new table states to your app as messages.

See the [examples] to get a better feel for this!

[keyed]: http://package.elm-lang.org/packages/elm-lang/html/latest/Html-Keyed
[examples]: https://github.com/billstclair/elm-sortable-table/tree/master/examples

-}
config :
    { toId : data -> String
    , toMsg : State -> msg
    , columns : List (Column data msg)
    }
    -> Config data msg
config = Config.config


{-| Just like `config` but you can specify a bunch of table customizations.
-}
customConfig :
    { toId : data -> String
    , toMsg : State -> msg
    , columns : List (Column data msg)
    , customizations : Customizations data msg
    }
    -> Config data msg
customConfig = Config.customConfig


{-| There are quite a lot of ways to customize the `<table>` tag. You can add
a `<caption>` which can be styled via CSS. You can do crazy stuff with
`<thead>` to group columns in weird ways. You can have a `<tfoot>` tag for
summaries of various columns. And maybe you want to put attributes on `<tbody>`
or on particular rows in the body. All these customizations are available to you.

**Note:** The level of craziness possible in `<thead>` and `<tfoot>` are so
high that I could not see how to provide the full functionality _and_ make it
impossible to do bad stuff. So just be aware of that, and share any stories
you have. Stories make it possible to design better!

-}
type alias Customizations data msg = Config.Customizations data msg


{-| Sometimes you must use a `<td>` tag, but the attributes and children are up
to you. This type lets you specify all the details of an HTML node except the
tag name.
-}
type alias HtmlDetails msg = Column.HtmlDetails msg


{-| The customizations used in `config` by default.
-}
defaultCustomizations : Customizations data msg
defaultCustomizations = Config.defaultCustomizations


{-| The status of a particular column, for use in the `thead` field of your
`Customizations`.

  - If the column is unsortable, the status will always be `Unsortable`.
  - If the column can be sorted in one direction, the status will be `Sortable`.
    The associated boolean represents whether this column is selected. So it is
    `True` if the table is currently sorted by this column, and `False` otherwise.
  - If the column can be sorted in either direction, the status will be `Reversible`.
    The associated maybe tells you whether this column is selected. It is
    `Just isReversed` if the table is currently sorted by this column, and
    `Nothing` otherwise. The `isReversed` boolean lets you know which way it
    is sorted.

This information lets you do custom header decorations for each scenario.

-}
type alias Status = Config.Status


-- COLUMNS

{-| Describes how to turn `data` into a column in your table.
-}
type alias Column data msg = Column.Column data msg


{-| -}
stringColumn : String -> (data -> String) -> Column data msg
stringColumn = Column.stringColumn


{-| -}
intColumn : String -> (data -> Int) -> Column data msg
intColumn = Column.intColumn


{-| -}
floatColumn : String -> (data -> Float) -> Column data msg
floatColumn = Column.floatColumn


{-| Perhaps the basic columns are not quite what you want. Maybe you want to
display monetary values in thousands of dollars, and `floatColumn` does not
quite cut it. You could define a custom column like this:

    import Shared.Components.Table as Table
    import Shared.Components.Table.Sorter as Sorter

    dollarColumn : String -> (data -> Float) -> Table.Column data msg
    dollarColumn name toDollars =
        Table.customColumn
            { name = name
            , viewData = \data -> viewDollars (toDollars data)
            , sorter = Sorter.decreasingBy toDollars
            }

    viewDollars : Float -> String
    viewDollars dollars =
        "$" ++ String.fromInt (round (dollars / 1000)) ++ "k"

The `viewData` field means we will displays the number `12345.67` as `$12k`.

The `sorter` field specifies how the column can be sorted. In `dollarColumn` we
are saying that it can _only_ be shown from highest-to-lowest monetary value.
More about sorters soon!

-}
customColumn :
    { name : String
    , viewData : data -> String
    , sorter : Sorter data
    }
    -> Column data msg
customColumn = Column.customColumn


{-| It is _possible_ that you want something crazier than `customColumn`. In
that unlikely scenario, this function lets you have full control over the
attributes and children of each `<td>` cell in this column.

So maybe you want to a dollars column, and the dollar signs should be green.

    import Html exposing (Attribute, Html, span, text)
    import Html.Attributes exposing (style)
    import Shared.Components.Table as Table
    import Shared.Components.Table.Column as Column
    import Shared.Components.Table.Sorter as Sorter

    dollarColumn : String -> (data -> Float) -> Table.Column data msg
    dollarColumn name toDollars =
        Table.veryCustomColumn
            { name = name
            , viewData = \data -> viewDollars (toDollars data)
            , sorter = Sorter.decreasingBy toDollars
            }

    viewDollars : Float -> Column.HtmlDetails msg
    viewDollars dollars =
        Column.HtmlDetails []
            [ span [ style "color" "green" ] [ text "$" ]
            , text (String.fromInt (round (dollars / 1000)) ++ "k")
            ]

-}
veryCustomColumn :
    { name : String
    , viewData : data -> HtmlDetails msg
    , sorter : Sorter data
    }
    -> Column data msg
veryCustomColumn = Column.veryCustomColumn


-- VIEW

{-| Take a list of data and turn it into a table. The `Config` argument is the
configuration for the table. It describes the columns that we want to show. The
`State` argument describes which column we are sorting by at the moment.

**Note:** The `State` and `List data` should live in your `Model`. The `Config`
for the table belongs in your `view` code. I very strongly recommend against
putting `Config` in your model. Describe any potential table configurations
statically, and look for a different library if you need something crazier than
that.

-}
view : Config data msg -> State -> List data -> Html msg
view = View.view


{-| Return the data sorted exactly as it will be displayed on the screen.
-}
getSortedData : Config data msg -> State -> List data -> List data
getSortedData = View.getSortedData


-- SORTERS

{-| Specifies a particular way of sorting data.
-}
type alias Sorter data = Sorter.Sorter data


{-| A sorter for columns that are unsortable. Maybe you have a column in your
table for delete buttons that delete the row. It would not make any sense to
sort based on that column.
-}
unsortable : Sorter data
unsortable = Sorter.unsortable


{-| Create a sorter that can only display the data in increasing order. If we
want a table of people, sorted alphabetically by name, we would say this:

    sorter : Sorter { a | name : comparable }
    sorter =
        increasingBy .name

-}
increasingBy : (data -> comparable) -> Sorter data
increasingBy = Sorter.increasingBy


{-| Create a sorter that can only display the data in decreasing order. If we
want a table of countries, sorted by population from highest to lowest, we
would say this:

    sorter : Sorter { a | population : comparable }
    sorter =
        decreasingBy .population

-}
decreasingBy : (data -> comparable) -> Sorter data
decreasingBy = Sorter.decreasingBy


{-| Sometimes you want to be able to sort data in increasing _or_ decreasing
order. Maybe you have a bunch of data about orange juice, and you want to know
both which has the most sugar, and which has the least sugar. Both interesting!
This function lets you see both, starting with decreasing order.

    sorter : Sorter { a | sugar : comparable }
    sorter =
        decreasingOrIncreasingBy .sugar

-}
decreasingOrIncreasingBy : (data -> comparable) -> Sorter data
decreasingOrIncreasingBy = Sorter.decreasingOrIncreasingBy


{-| Sometimes you want to be able to sort data in increasing _or_ decreasing
order. Maybe you have race times for the 100 meter sprint. This function lets
sort by best time by default, but also see the other order.

    sorter : Sorter { a | time : comparable }
    sorter =
        increasingOrDecreasingBy .time

-}
increasingOrDecreasingBy : (data -> comparable) -> Sorter data
increasingOrDecreasingBy = Sorter.increasingOrDecreasingBy


{-| Set a fixed width for a column (e.g. "120px" or "10%"). -}
withColumnWidth : String -> Column.Column data msg -> Column.Column data msg
withColumnWidth = Column.withColumnWidth
