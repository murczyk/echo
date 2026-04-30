module Shared.Components.Table.Column exposing
    ( Column, ColumnData, HtmlDetails
    , stringColumn, intColumn
    , customColumn, veryCustomColumn
    , unwrapColumn
    , withColumnWidth
    )

{-| This module handles column definitions for tables.


# Column Types

@docs Column, ColumnData, HtmlDetails


# Basic Columns

@docs stringColumn, intColumn


# Custom Columns

@docs customColumn, veryCustomColumn


# Helpers

@docs unwrapColumn

-}

import Html exposing (Attribute, Html)
import Shared.Components.Table.Sorter as Sorter exposing (Sorter)


{-| Sometimes you must use a `<td>` tag, but the attributes and children are up
to you. This type lets you specify all the details of an HTML node except the
tag name.
-}
type alias HtmlDetails msg =
    { attributes : List (Attribute msg)
    , children : List (Html msg)
    }


{-| Describes how to turn `data` into a column in your table.
-}
type Column data msg
    = Column (ColumnData data msg)


{-| Internal column data structure.
-}
type alias ColumnData data msg =
    { name : String
    , viewData : data -> HtmlDetails msg
    , sorter : Sorter data
    , width : Maybe String
    }


{-| Extract the column data from a Column type.
-}
unwrapColumn : Column data msg -> ColumnData data msg
unwrapColumn (Column columnData) =
    columnData


{-| Create a column that displays strings and can be sorted alphabetically.
-}
stringColumn : String -> (data -> String) -> Column data msg
stringColumn name toStr =
    Column
        { name = name
        , viewData = textDetails << toStr
        , sorter = Sorter.increasingOrDecreasingBy toStr
        , width = Nothing
        }


{-| Create a column that displays integers and can be sorted numerically.
-}
intColumn : String -> (data -> Int) -> Column data msg
intColumn name toInt =
    Column
        { name = name
        , viewData = textDetails << String.fromInt << toInt
        , sorter = Sorter.increasingOrDecreasingBy toInt
        , width = Nothing
        }


{-| Create simple HTML details containing just text.
-}
textDetails : String -> HtmlDetails msg
textDetails str =
    HtmlDetails [] [ Html.text str ]


{-| Perhaps the basic columns are not quite what you want. Maybe you want to
display monetary values in thousands of dollars, and `floatColumn` does not
quite cut it. You could define a custom column like this:

    import Shared.Components.Table.Column as Column
    import Shared.Components.Table.Sorter as Sorter

    dollarColumn : String -> (data -> Float) -> Column.Column data msg
    dollarColumn name toDollars =
        Column.customColumn
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

-}
customColumn :
    { name : String
    , viewData : data -> String
    , sorter : Sorter data
    }
    -> Column data msg
customColumn { name, viewData, sorter } =
    Column <|
        ColumnData name (textDetails << viewData) sorter Nothing


{-| It is _possible_ that you want something crazier than `customColumn`. In
that unlikely scenario, this function lets you have full control over the
attributes and children of each `<td>` cell in this column.

So maybe you want to a dollars column, and the dollar signs should be green.

    import Html exposing (Attribute, Html, span, text)
    import Html.Attributes exposing (style)
    import Shared.Components.Table.Column as Column
    import Shared.Components.Table.Sorter as Sorter

    dollarColumn : String -> (data -> Float) -> Column.Column data msg
    dollarColumn name toDollars =
        Column.veryCustomColumn
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
veryCustomColumn { name, viewData, sorter } =
    Column <| ColumnData name viewData sorter Nothing


{-| Add new function
-}
withColumnWidth : String -> Column data msg -> Column data msg
withColumnWidth w (Column cd) =
    Column { cd | width = Just w }
