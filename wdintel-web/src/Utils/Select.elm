module Utils.Select exposing (SelectType, SelectTypeSingle, SelectTypeSingleNotEmpty, defaultOptions, multiUpdI, multiUpdIfModified, multiUpdMenuOpen, multiUpdS, renderSelect, renderSelectSingle, renderSelectVirtual, singleUpd, singleUpdWithDefault, updateSelectItems, updateSelectSelected, updateSelectState)

import Css
import Html.Styled as Styled
import Select
import Select.Styles


type alias SelectType item =
    { state : Select.State
    , items : List (Select.MenuItem item)
    , selected : List item
    }


type alias SelectTypeSingle item =
    { state : Select.State
    , items : List (Select.MenuItem item)
    , selected : Maybe item
    }


type alias SelectTypeSingleNotEmpty item =
    { state : Select.State
    , items : List (Select.MenuItem item)
    , selected : item
    }


updateSelectState : (Select.State -> Select.State) -> SelectType item -> SelectType item
updateSelectState updateFn select =
    { select | state = updateFn select.state }


updateSelectItems : (List (Select.MenuItem item) -> List (Select.MenuItem item)) -> SelectType item -> SelectType item
updateSelectItems updateFn select =
    { select | items = updateFn select.items }


updateSelectSelected : (List item -> List item) -> SelectType item -> SelectType item
updateSelectSelected updateFn select =
    { select | selected = updateFn select.selected }


singleUpd : Maybe (Select.Action item) -> Maybe item -> Maybe item
singleUpd mAction mValue =
    case mAction of
        Just (Select.Select i) ->
            Just i

        Just Select.Clear ->
            Nothing

        _ ->
            mValue


singleUpdWithDefault : Maybe (Select.Action item) -> item -> item
singleUpdWithDefault mAction defaultValue =
    case mAction of
        Just (Select.Select i) ->
            i

        Just Select.Clear ->
            defaultValue

        _ ->
            defaultValue


multiUpdS : Maybe (Select.Action String) -> List String -> List String
multiUpdS mAction xs =
    case mAction of
        Just (Select.Select i) ->
            xs ++ [ i ]

        Just (Select.Deselect deletedItems) ->
            List.filter
                (\i ->
                    not
                        (List.member i deletedItems)
                )
                xs

        Just Select.Clear ->
            []

        _ ->
            xs


multiUpdMenuOpen : Maybe (Select.Action comparable) -> List comparable -> Select.State -> ( List comparable, Select.State )
multiUpdMenuOpen mAction xs state =
    case mAction of
        Just (Select.Select i) ->
            ( xs ++ [ i ], state |> Select.keepMenuOpen True )

        Just (Select.Deselect deletedItems) ->
            ( List.filter (\i -> not (List.member i deletedItems)) xs, state |> Select.keepMenuOpen True )

        Just Select.Clear ->
            ( [], state )

        Just Select.Blur ->
            ( xs, state |> Select.keepMenuOpen False )

        Just (Select.MenuToggle Select.MenuClose) ->
            ( xs, state |> Select.keepMenuOpen False )

        _ ->
            ( xs, state )


multiUpdI : Maybe (Select.Action Int) -> List Int -> List Int
multiUpdI mAction xs =
    case mAction of
        Just (Select.Select i) ->
            xs ++ [ i ]

        Just (Select.Deselect deletedItems) ->
            List.filter
                (\i ->
                    not
                        (List.member i deletedItems)
                )
                xs

        Just Select.Clear ->
            []

        _ ->
            xs


multiUpdModified : Maybe (Select.Action String) -> Bool
multiUpdModified mAction =
    case mAction of
        Just (Select.Select _) ->
            True

        Just (Select.Deselect _) ->
            True

        _ ->
            False


multiUpdIfModified : Maybe (Select.Action String) -> Cmd msg -> Cmd msg
multiUpdIfModified mAction task =
    if multiUpdModified mAction then
        task

    else
        Cmd.none


renderSelect :
    List (Select.MenuItem a)
    -> Select.State
    -> List (Select.MenuItem a)
    -> String
    -> { isDark : Bool, loading : Bool, disabled : Bool, clearable : Bool }
    -> Styled.Html (Select.Msg a)
renderSelect selectedItems selectState menuItems placeholder options =
    let
        controlStyles =
            Select.Styles.getControlConfig Select.Styles.default
                |> Select.Styles.setControlMinHeight 25.0
                |> Select.Styles.setControlBorderColor (Css.rgb 248 249 250)
                |> Select.Styles.setControlBorderColorFocus (Css.rgb 248 249 250)
                |> Select.Styles.setControlBorderColorHover (Css.rgb 248 249 250)
                |> Select.Styles.setControlMultiTagTruncationWidth 160

        styles =
            Select.Styles.setControlStyles controlStyles Select.Styles.default
    in
    Select.view
        (Select.multi selectedItems
            |> Select.state selectState
            |> Select.menuItems menuItems
            |> Select.searchable True
            |> Select.clearable options.clearable
            |> Select.setStyles styles
            |> Select.placeholder placeholder
            |> Select.loading options.loading
            |> Select.disabled options.disabled
            |> (if options.isDark then
                    Select.setStyles dracula

                else
                    identity
               )
        )


renderSelectVirtual :
    List (Select.MenuItem String)
    -> Select.State
    -> List (Select.MenuItem String)
    -> String
    -> { isDark : Bool, loading : Bool, disabled : Bool }
    -> Styled.Html (Select.Msg String)
renderSelectVirtual selectedItems selectState menuItems placeholder options =
    let
        controlStyles =
            Select.Styles.getControlConfig Select.Styles.default
                |> Select.Styles.setControlMinHeight 25.0
                |> Select.Styles.setControlMultiTagTruncationWidth 160
                |> Select.Styles.setControlBorderColor (Css.rgb 248 249 250)
                |> Select.Styles.setControlBorderColorFocus (Css.rgb 248 249 250)
                |> Select.Styles.setControlBorderColorHover (Css.rgb 248 249 250)

        styles =
            Select.Styles.setControlStyles controlStyles Select.Styles.default
    in
    Select.viewVirtual
        (Select.multiVirtual selectedItems
            |> Select.state selectState
            |> Select.menuItemsVirtual (Select.virtualFixedMenuItems 35 menuItems)
            |> Select.searchable True
            |> Select.clearable True
            |> Select.setStyles styles
            |> Select.placeholder placeholder
            |> (if options.isDark then
                    Select.setStyles dracula

                else
                    identity
               )
            |> Select.loading options.loading
            |> Select.disabled options.disabled
        )


defaultOptions : Bool -> { isDark : Bool, loading : Bool, disabled : Bool, clearable : Bool }
defaultOptions isDark =
    { isDark = isDark, loading = False, disabled = False, clearable = True }


renderSelectSingle :
    Maybe (Select.MenuItem a)
    -> Select.State
    -> List (Select.MenuItem a)
    -> String
    -> { isDark : Bool, loading : Bool, disabled : Bool, clearable : Bool }
    -> Styled.Html (Select.Msg a)
renderSelectSingle selectedItem selectState menuItems placeholder options =
    let
        controlStyles =
            Select.Styles.getControlConfig Select.Styles.default
                |> Select.Styles.setControlMinHeight 25.0
                |> Select.Styles.setControlMultiTagTruncationWidth 160
                |> Select.Styles.setControlBorderColor (Css.rgb 248 249 250)
                |> Select.Styles.setControlBorderColorFocus (Css.rgb 248 249 250)
                |> Select.Styles.setControlBorderColorHover (Css.rgb 248 249 250)

        styles =
            Select.Styles.setControlStyles controlStyles Select.Styles.default
    in
    Select.view
        (Select.single selectedItem
            |> Select.state selectState
            |> Select.menuItems menuItems
            |> Select.searchable True
            |> Select.clearable options.clearable
            |> Select.setStyles styles
            |> Select.placeholder placeholder
            |> Select.disabled options.disabled
            |> Select.loading options.loading
            |> (if options.isDark then
                    Select.setStyles dracula

                else
                    identity
               )
        )


dracula : Select.Styles.Config
dracula =
    Select.Styles.default
        |> Select.Styles.setControlStyles draculaControl
        |> Select.Styles.setMenuStyles draculaMenu
        |> Select.Styles.setMenuItemStyles draculaMenuItem


draculaControl : Select.Styles.ControlConfig
draculaControl =
    Select.Styles.getControlConfig Select.Styles.default
        -- |> Select.Styles.setControlBorderColor (Css.hex "#ff79c6")
        -- |> Select.Styles.setControlBorderColorHover (Css.hex "#ff79c6")
        -- |> Select.Styles.setControlBorderColorFocus (Css.hex "#ff79c6")
        |> Select.Styles.setControlSeparatorColor (Css.hex "#898BA9")
        -- |> Select.Styles.setControlDropdownIndicatorColor (Css.hex "#ff79c6")
        |> Select.Styles.setControlDropdownIndicatorColorHover (Css.hex "#dedede")
        -- |> Select.Styles.setControlClearIndicatorColor (Css.hex "#ff79c6")
        |> Select.Styles.setControlClearIndicatorColorHover (Css.hex "#dedede")
        |> Select.Styles.setControlBackgroundColor (Css.hex "#282a36")
        |> Select.Styles.setControlBackgroundColorHover (Css.hex "#282a36")
        |> Select.Styles.setControlColor (Css.hex "#dedede")
        -- |> Select.Styles.setControlColor (Css.hex "#ff79c6")
        |> Select.Styles.setControlSelectedColor (Css.hex "#fff")
        |> Select.Styles.setControlLoadingIndicatorColor (Css.hex "#ff79c6")
        |> Select.Styles.setControlMinHeight 25.0
        |> Select.Styles.setControlMultiTagTruncationWidth 160


draculaMenu : Select.Styles.MenuConfig
draculaMenu =
    Select.Styles.getMenuConfig Select.Styles.default
        |> Select.Styles.setMenuBoxShadowColor (Css.rgba 255 165 44 0.2)
        |> Select.Styles.setMenuBackgroundColor (Css.hex "#282a36")
        |> Select.Styles.setMenuControlBorderColor (Css.hex "#ff79c6")
        |> Select.Styles.setMenuControlBorderColorHover (Css.hex "#ff79c6")
        |> Select.Styles.setMenuControlBorderColorFocus (Css.hex "#ff79c6")
        |> Select.Styles.setMenuControlBackgroundColorHover (Css.hex "#282a36")
        |> Select.Styles.setMenuControlBackgroundColor (Css.hex "#282a36")
        -- |> Select.Styles.setMenuControlClearIndicatorColor (Css.hex "#ff79c6")
        -- |> Select.Styles.setMenuControlClearIndicatorColorHover (Css.hex "#e66db2")
        |> Select.Styles.setMenuControlColor (Css.hex "#fff")
        |> Select.Styles.setMenuControlLoadingIndicatorColor (Css.hex "#ff79c6")
        |> Select.Styles.setMenuControlSearchIndicatorColor (Css.hex "#ff79c6")


draculaMenuItem : Select.Styles.MenuItemConfig
draculaMenuItem =
    Select.Styles.getMenuItemConfig Select.Styles.default
        |> Select.Styles.setMenuItemBackgroundColorHover (Css.hex "#44475a")
        |> Select.Styles.setMenuItemBackgroundColorSelected (Css.hex "#6F839D")
        |> Select.Styles.setMenuItemBackgroundColorMouseDown (Css.hex "#44475a")
        |> Select.Styles.setMenuItemColor (Css.hex "#aeaea9")
        |> Select.Styles.setMenuItemColorHover (Css.hex "#fff")
        |> Select.Styles.setMenuItemColorSelected (Css.hex "#fff")
