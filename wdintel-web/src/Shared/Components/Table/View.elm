module Shared.Components.Table.View exposing (view, getSortedData)

{-| This module handles HTML rendering for tables.


# View Functions

@docs view, getSortedData

-}

import Html exposing (Attribute, Html)
import Html.Attributes
import Html.Events as E
import Html.Keyed as Keyed
import Html.Lazy exposing (lazy3)
import Json.Decode as Json
import Shared.Components.Table.Column exposing (ColumnData)
import Shared.Components.Table.Config as Config exposing (Config, Status(..))
import Shared.Components.Table.Sorter as Sorter
import Shared.Components.Table.State as State exposing (State)


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
view ((Config.Config { toId, toMsg, columns, customizations }) as conf) state data =
    let
        sortedData =
            getSortedData conf state data

        theadDetails =
            customizations.thead (List.map (toHeaderInfo state toMsg) columns)

        thead =
            Html.thead theadDetails.attributes
                [ Html.tr [] theadDetails.children ]

        tbody =
            Keyed.node "tbody" customizations.tbodyAttrs <|
                List.map (viewRow toId columns customizations.rowAttrs) sortedData

        withFoot =
            case customizations.tfoot of
                Nothing ->
                    [ tbody ]

                Just { attributes, children } ->
                    [ Html.tfoot attributes children, tbody ]

        -- Generate <colgroup> with optional column widths
        colGroup =
            let
                toCol colData =
                    let
                        attrs =
                            case colData.width of
                                Nothing ->
                                    []

                                Just w ->
                                    [ Html.Attributes.style "width" w ]
                    in
                    Html.col attrs []
            in
            Html.colgroup [] (List.map toCol columns)
    in
    Html.table customizations.tableAttrs <|
        case customizations.caption of
            Nothing ->
                colGroup :: thead :: withFoot

            Just { attributes, children } ->
                colGroup :: Html.caption attributes children :: thead :: withFoot


{-| Convert column data to header information for rendering.
-}
toHeaderInfo : State -> (State -> msg) -> ColumnData data msg -> ( String, Status, Attribute msg )
toHeaderInfo (State.State sortName isReversed) toMsg { name, sorter } =
    case sorter of
        Sorter.None ->
            ( name, Unsortable, onClick sortName isReversed toMsg )

        Sorter.Increasing _ ->
            ( name, Sortable (name /= sortName), onClick name False toMsg )

        Sorter.Decreasing _ ->
            ( name, Sortable (name == sortName), onClick name False toMsg )

        Sorter.IncOrDec _ ->
            if name == sortName then
                ( name, Reversible (Just (not isReversed)), onClick name (not isReversed) toMsg )

            else
                ( name, Reversible Nothing, onClick name False toMsg )

        Sorter.DecOrInc _ ->
            if name == sortName then
                ( name, Reversible (Just isReversed), onClick name (not isReversed) toMsg )

            else
                ( name, Reversible Nothing, onClick name False toMsg )


{-| Create a click handler for column headers.
-}
onClick : String -> Bool -> (State -> msg) -> Attribute msg
onClick name isReversed toMsg =
    E.on "click" <|
        Json.succeed (toMsg <| State.State name isReversed)


{-| Render a single table row.
-}
viewRow : (data -> String) -> List (ColumnData data msg) -> (data -> List (Attribute msg)) -> data -> ( String, Html msg )
viewRow toId columns toRowAttrs data =
    ( toId data
    , lazy3 viewRowHelp columns toRowAttrs data
    )


{-| Helper function for rendering table rows.
-}
viewRowHelp : List (ColumnData data msg) -> (data -> List (Attribute msg)) -> data -> Html msg
viewRowHelp columns toRowAttrs data =
    Html.tr (toRowAttrs data) (List.map (viewCell data) columns)


{-| Render a single table cell.
-}
viewCell : data -> ColumnData data msg -> Html msg
viewCell data { viewData } =
    let
        details =
            viewData data
    in
    Html.td details.attributes details.children


{-| Sort the data based on the current state and columns.
-}
sort : State -> List (ColumnData data msg) -> List data -> List data
sort (State.State selectedColumn isReversed) columnData data =
    case Sorter.findSorter selectedColumn columnData of
        Nothing ->
            data

        Just sorter ->
            Sorter.applySorter isReversed sorter data


{-| Return the data sorted exactly as it will be displayed on the screen.
-}
getSortedData : Config data msg -> State -> List data -> List data
getSortedData (Config.Config { columns }) state data =
    sort state columns data
