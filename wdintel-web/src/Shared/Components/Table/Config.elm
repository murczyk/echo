module Shared.Components.Table.Config exposing
    ( Config(..), customConfig
    , Customizations, defaultCustomizations
    , Status(..)
    )

{-| This module handles table configuration and customizations.


# Configuration

@docs Config, customConfig


# Customizations

@docs Customizations, defaultCustomizations


# Status

@docs Status

-}

import Char
import Html exposing (Attribute, Html)
import Html.Attributes
import Shared.Components.Table.Column as Column exposing (Column, ColumnData, HtmlDetails)
import Shared.Components.Table.State exposing (State)


{-| Configuration for your table, describing your columns.

**Note:** Your `Config` should _never_ be held in your model.
It should only appear in `view` code.

-}
type Config data msg
    = Config
        { toId : data -> String
        , toMsg : State -> msg
        , columns : List (ColumnData data msg)
        , customizations : Customizations data msg
        }


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
type alias Customizations data msg =
    { tableAttrs : List (Attribute msg)
    , caption : Maybe (HtmlDetails msg)
    , thead : List ( String, Status, Attribute msg ) -> HtmlDetails msg
    , tfoot : Maybe (HtmlDetails msg)
    , tbodyAttrs : List (Attribute msg)
    , rowAttrs : data -> List (Attribute msg)
    }


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
type Status
    = Unsortable
    | Sortable Bool
    | Reversible (Maybe Bool)


{-| Just like `config` but you can specify a bunch of table customizations.
-}
customConfig :
    { toId : data -> String
    , toMsg : State -> msg
    , columns : List (Column data msg)
    , customizations : Customizations data msg
    }
    -> Config data msg
customConfig { toId, toMsg, columns, customizations } =
    Config
        { toId = toId
        , toMsg = toMsg
        , columns = List.map Column.unwrapColumn columns
        , customizations = customizations
        }


{-| The customizations used in `config` by default.
-}
defaultCustomizations : Customizations data msg
defaultCustomizations =
    { tableAttrs = []
    , caption = Nothing
    , thead = simpleThead
    , tfoot = Nothing
    , tbodyAttrs = []
    , rowAttrs = simpleRowAttrs
    }


{-| Simple default thead implementation.
-}
simpleThead : List ( String, Status, Attribute msg ) -> HtmlDetails msg
simpleThead headers =
    HtmlDetails [] (List.map simpleTheadHelp headers)


{-| Helper for simple thead.
-}
simpleTheadHelp : ( String, Status, Attribute msg ) -> Html msg
simpleTheadHelp ( name, status, click ) =
    let
        content =
            case status of
                Unsortable ->
                    [ Html.text name ]

                Sortable selected ->
                    [ Html.text name
                    , if selected then
                        darkGrey "↓"

                      else
                        lightGrey "↓"
                    ]

                Reversible Nothing ->
                    [ Html.text name
                    , lightGrey "↕"
                    ]

                Reversible (Just isReversed) ->
                    [ Html.text name
                    , darkGrey
                        (if isReversed then
                            "↑"

                         else
                            "↓"
                        )
                    ]
    in
    Html.th [ click ] content


{-| Non-breaking space character.
-}
nbsp : String
nbsp =
    String.fromChar (Char.fromCode 0xA0)


{-| Dark grey styling for sort indicators.
-}
darkGrey : String -> Html msg
darkGrey symbol =
    Html.span [ Html.Attributes.style "color" "#555" ] [ Html.text (nbsp ++ symbol) ]


{-| Light grey styling for sort indicators.
-}
lightGrey : String -> Html msg
lightGrey symbol =
    Html.span [ Html.Attributes.style "color" "#ccc" ] [ Html.text (nbsp ++ symbol) ]


{-| Simple default row attributes.
-}
simpleRowAttrs : data -> List (Attribute msg)
simpleRowAttrs _ =
    []
