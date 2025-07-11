module Chapters.Button exposing (firstChapter)

import Components.Button as Button
import ElmBook.Chapter exposing (..)
import Html exposing (div, Html)
import Html.Attributes exposing (..)
import ElmBook.Actions exposing (logAction)


firstChapter : Chapter x
firstChapter =
    chapter "Button Component"
        |> withComponentList [
            ( "primary", primaryButtonRow logAction ),
            ( "secondary", secondaryButtonRow logAction )
        ]
            |> render content 


-- Primary Button Row - all variants together
primaryButtonRow : (String -> msg) -> Html msg
primaryButtonRow toMsg =
        div [ class "flex gap-4 items-center flex-wrap" ]
            [primaryButton { label = "Додати", disabled = False, onClick = toMsg "Primary clicked!" }
            , primaryButton { label = "Додати", disabled = True, onClick = toMsg "Primary clicked!" }
            , primaryButtonWithIcon { label = "Додати", disabled = False, onClick = toMsg "Primary Icon clicked!" }
            , primaryButtonWithIcon { label = "Додати", disabled = True, onClick = toMsg "Primary Icon clicked!" }
            ]


-- Secondary Button Row - all variants together
secondaryButtonRow : (String -> msg) -> Html msg
secondaryButtonRow toMsg =
    div [ class "flex gap-4 items-center flex-wrap" ]
        [ secondaryButton { label = "Secondary", disabled = False, onClick = toMsg "Secondary clicked!" }
        , secondaryButton { label = "Secondary", disabled = True, onClick = toMsg "Secondary clicked!" }
        , secondaryButtonWithIcon { label = "Secondary", disabled = False, onClick = toMsg "Secondary Icon clicked!" }
        , secondaryButtonWithIcon { label = "Secondary", disabled = True, onClick = toMsg "Secondary Icon clicked!" }
        ]


-- Primary Button variants
primaryButton : {label: String, disabled: Bool, onClick: msg} -> Html msg
primaryButton props =
    Button.new { label = props.label, onClick = props.onClick }
        |> Button.withDisabled props.disabled
        |> Button.view


primaryButtonWithIcon : {label: String, disabled: Bool, onClick: msg} -> Html msg
primaryButtonWithIcon props =
    Button.new { label = props.label, onClick = props.onClick }
        |> Button.withIcon [ div [ class "w-4 h-4 bg-current" ] [] ]
        |> Button.withDisabled props.disabled
        |> Button.view


-- Secondary Button variants
secondaryButton : {label: String, disabled: Bool, onClick: msg} -> Html msg
secondaryButton props =
    Button.new { label = props.label, onClick = props.onClick }
        |> Button.withSecondary
        |> Button.withDisabled props.disabled
        |> Button.view


secondaryButtonWithIcon : {label: String, disabled: Bool, onClick: msg} -> Html msg
secondaryButtonWithIcon props =
    Button.new { label = props.label, onClick = props.onClick }
        |> Button.withSecondary
        |> Button.withIcon [ div [ class "w-4 h-4 bg-current" ] [] ]
        |> Button.withDisabled props.disabled
        |> Button.view


content : String
content =
    """
# Button Component

A flexible button component with multiple styles and configurations.

## Primary Buttons
All states of primary buttons: normal, disabled, with icon, with icon disabled.

<component with-label="primary" />

## Secondary Buttons
All states of secondary buttons: normal, disabled, with icon, with icon disabled.

<component with-label="secondary" />

## API Reference

### Basic Usage
```elm
-- Primary button (default styling)
Button.new { label = "Click me", onClick = MyMsg }
    |> Button.view
```

### Available Modifiers
- `withPrimary` - Apply primary styling (optional, since it's the default)
- `withSecondary` - Apply secondary styling
- `withDisabled True/False` - Enable/disable the button
- `withIcon [Html msg]` - Add icon elements to the left of the label

### Button Variants
- **Primary** - Solid blue background with white text (default)
- **Secondary** - White background with blue border and blue text

### Button States
Each button variant supports these states:
- **Normal** - Default interactive state
- **Disabled** - Non-interactive state with reduced opacity
- **With Icon** - Includes icon on the left
- **With Icon Disabled** - Icon version in disabled state

### Design Specifications
- **Primary Normal:** Solid `#2c6c91` background with white text
- **Primary Hover:** Darker `#245a7a` background
- **Primary Active:** Darkest `#1e4c66` background  
- **Primary Disabled:** Gray background with reduced opacity
- **Secondary Normal:** White background with `#2c6c91` border and text
- **Secondary Hover:** Light `#f8fafc` background with same border
- **Secondary Active:** Slightly darker `#f1f5f9` background
- **Secondary Disabled:** Gray background and border with reduced opacity

### Examples
```elm
-- Primary button (default - no modifier needed)
Button.new { label = "Save", onClick = SaveMsg }
    |> Button.view

-- Secondary button (outlined style)
Button.new { label = "Cancel", onClick = CancelMsg }
    |> Button.withSecondary
    |> Button.view

-- Primary with icon (no withPrimary needed)
Button.new { label = "Submit", onClick = SubmitMsg }
    |> Button.withIcon [ someIcon ]
    |> Button.withDisabled True
    |> Button.view

-- Explicit primary (optional)
Button.new { label = "Explicit", onClick = ExplicitMsg }
    |> Button.withPrimary
    |> Button.view
```
"""
