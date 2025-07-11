module Chapters.Button exposing (firstChapter)

import Components.Button as Button
import ElmBook.Chapter exposing (..)
import Html exposing (..)
import Html.Attributes exposing (..)
import ElmBook.Actions exposing (logAction)


firstChapter : Chapter x
firstChapter =
    let 
        buttonProps = { label = "Primary Button", disabled = False, onClick = logAction "Primary Button clicked!" }
    in
    chapter "Button Component"
        |> renderComponentList [
            ( "Primary Button", primaryButton buttonProps ),
            ( "Primary Button Disabled", primaryButton { buttonProps | disabled = True } ),
            ( "Secondary Button", secondaryButton { label = "Secondary Button", disabled = False, onClick = logAction "Secondary Button clicked!" } ),
            ( "Secondary Button Disabled", secondaryButton { label = "Secondary Button", disabled = True, onClick = logAction "Secondary Button clicked!" } ),
            ( "Outlined Button", outlinedButton { label = "Outlined Button", disabled = False, onClick = logAction "Outlined Button clicked!" } ),
            ( "Outlined Button Disabled", outlinedButton { label = "Outlined Button", disabled = True, onClick = logAction "Outlined Button clicked!" } ),
            ( "Icon Button", iconButton { label = "Icon Button", disabled = False, onClick = logAction "Icon Button clicked!" } ),
            ( "Icon Button Disabled", iconButton { label = "Icon Button", disabled = True, onClick = logAction "Icon Button clicked!" } ),
            ( "Secondary Outlined Button", secondaryOutlinedButton { label = "Secondary Outlined Button", disabled = False, onClick = logAction "Secondary Outlined Button clicked!" } ),
            ( "Secondary Outlined Button Disabled", secondaryOutlinedButton { label = "Secondary Outlined Button", disabled = True, onClick = logAction "Secondary Outlined Button clicked!" } )
        ]


-- Example buttons demonstrating different configurations
primaryButton : {label: String, disabled: Bool, onClick: msg} -> Html msg
primaryButton props  =
        Button.new { label = props.label, onClick = props.onClick }
            |> Button.withDisabled props.disabled
            |> Button.view


secondaryButton : {label: String, disabled: Bool, onClick: msg} -> Html msg
secondaryButton props =
        Button.new { label = props.label, onClick = props.onClick }
            |> Button.withStyleSecondary
            |> Button.withDisabled props.disabled
            |> Button.view


outlinedButton : {label: String, disabled: Bool, onClick: msg} -> Html msg
outlinedButton props =
        Button.new { label = props.label, onClick = props.onClick }
            |> Button.withOutlined True
            |> Button.withDisabled props.disabled
            |> Button.view


iconButton : {label: String, disabled: Bool, onClick: msg} -> Html msg
iconButton props =
        Button.new { label = props.label, onClick = props.onClick }
            |> Button.withIcon [ div [ class "w-4 h-4 bg-current" ] [] ]
            |> Button.withDisabled props.disabled
            |> Button.view


secondaryOutlinedButton : {label: String, disabled: Bool, onClick: msg} -> Html msg
secondaryOutlinedButton props =
        Button.new { label = props.label, onClick = props.onClick }
            |> Button.withStyleSecondary
            |> Button.withOutlined True
            |> Button.withDisabled props.disabled
            |> Button.view


content : String
content =
    """
# Button Component

A flexible button component with multiple styles and configurations.

## Primary Button
The default button style with filled background.

<component />

## Secondary Button
Alternative styling for secondary actions.

<component />

## Outlined Button
Button with transparent background and border.

<component />

## Disabled Button
Non-interactive button state.

<component />

## Button with Icon
Button that includes an icon alongside the label.

<component />

## Secondary Outlined Button
Combination of secondary style with outlined appearance.

<component />

## API Reference

### Basic Usage
```elm
Button.new { label = "Click me", onClick = MyMsg }
    |> Button.view
```

### Available Modifiers
- `withStyleSecondary` - Apply secondary styling
- `withOutlined True/False` - Toggle outlined appearance
- `withDisabled True/False` - Enable/disable the button
- `withIcon [Html msg]` - Add icon elements to the left of the label

### Examples
```elm
-- Primary button (default)
Button.new { label = "Save", onClick = SaveMsg }
    |> Button.view

-- Secondary outlined button
Button.new { label = "Cancel", onClick = CancelMsg }
    |> Button.withStyleSecondary
    |> Button.withOutlined True
    |> Button.view

-- Disabled button
Button.new { label = "Submit", onClick = SubmitMsg }
    |> Button.withDisabled model.isProcessing
    |> Button.view
```
"""
