module Shared.Model exposing (Model, ThemeMode(..), isDarkMode)

import Bindings as B
import Dict exposing (Dict)
import Le.Block.Toast
import Le.EventTypes
import Le.RemoteData exposing (RemoteData)
import Le.Types exposing (ApiError, LocationRes)
import Time exposing (Zone)


type ThemeMode
    = Light
    | Dark
    | System


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
            False -- Default to light for now, will be updated in later milestones


type alias Model =
    { user : Maybe B.User
    , themeMode : ThemeMode
    , location : Maybe LocationRes
    , serverInfo : Maybe B.ServerInfo
    , masterUnits : RemoteData ApiError (Dict Int B.Unit)
    , networks : RemoteData ApiError (Dict Int B.Network)
    , now : Int
    , timeZone : Zone
    , callsignsInfo : Dict String (List B.CallsignInfo)
    , posts : RemoteData ApiError (Dict Int B.Post)
    , toasts : Le.Block.Toast.Model
    , featureNavbarFrontOnly : Bool
    , eventService : Le.EventTypes.EventState
    , pendingEvents : List B.EventMsg
    , eventSubscriptions : Le.EventTypes.EventSubscriptions
    }
