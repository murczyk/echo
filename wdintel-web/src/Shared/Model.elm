module Shared.Model exposing (Model, RerNetworkDetailsPreferredView(..), isDarkMode, rerNetworkDetailsPreferredViewFromString, rerNetworkDetailsPreferredViewToString, themeModeFromString, themeModeToString, ThemeMode(..))

import Bindings as B
import Core.EventTypes
import Core.Types exposing (ApiError, LocationRes)
import Dict exposing (Dict)
import Shared.Components.Toast
import Time exposing (Zone)
import Utils.RemoteData exposing (RemoteData)


type ThemeMode
    = Light
    | Dark
    | System


type RerNetworkDetailsPreferredView
    = Neo
    | Classic


{-| Helper function to convert ThemeMode to Bool for backward compatibility
-}
isDarkMode : ThemeMode -> Bool
isDarkMode themeMode =
    case themeMode of
        Light ->
            False

        Dark ->
            True

        System ->
            False



-- Default to light for now, will be updated in later milestones


{-| Helper function to convert String to ThemeMode from localStorage
-}
themeModeFromString : String -> ThemeMode
themeModeFromString str =
    case str of
        "light" ->
            Light

        "dark" ->
            Dark

        "system" ->
            System

        _ ->
            Light



-- Default fallback


{-| Helper function to convert ThemeMode to String for localStorage
-}
themeModeToString : ThemeMode -> String
themeModeToString themeMode =
    case themeMode of
        Light ->
            "light"

        Dark ->
            "dark"

        System ->
            "system"


rerNetworkDetailsPreferredViewFromString : String -> RerNetworkDetailsPreferredView
rerNetworkDetailsPreferredViewFromString str =
    case str of
        "classic" ->
            Classic

        _ ->
            Neo


rerNetworkDetailsPreferredViewToString : RerNetworkDetailsPreferredView -> String
rerNetworkDetailsPreferredViewToString preferredView =
    case preferredView of
        Classic ->
            "classic"

        Neo ->
            "neo"


type alias Model =
    { user : Maybe B.User
    , userLoaded : Bool
    , themeMode : ThemeMode
    , rerNetworkDetailsPreferredView : RerNetworkDetailsPreferredView
    , location : Maybe LocationRes
    , serverInfo : Maybe B.ServerInfo
    , changelogPreview : Maybe ChangelogPreview
    , changelogLastSeenLoaded : Bool
    , changelogLastSeen : Maybe String
    , masterUnits : RemoteData ApiError (Dict Int B.Unit)
    , networks : RemoteData ApiError (Dict Int B.Network)
    , now : Int
    , timeZone : Zone
    , callsignsInfo : Dict String (List B.CallsignInfo)
    , posts : RemoteData ApiError (Dict Int B.Post)
    , toasts : Shared.Components.Toast.Model
    , eventService : Core.EventTypes.EventState
    , pendingEvents : List B.EventMsg
    , eventSubscriptions : Core.EventTypes.EventSubscriptions
    }


type alias ChangelogPreview =
    { version : String
    , preview : List String
    , fullUrl : String
    }
