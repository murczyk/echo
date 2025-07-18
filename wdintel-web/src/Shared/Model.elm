module Shared.Model exposing (Model)

import Bindings as B
import Dict exposing (Dict)
import Le.Block.Toast
import Le.EventTypes
import Le.RemoteData exposing (RemoteData)
import Le.Types exposing (ApiError, LocationRes)
import Time exposing (Zone)


type alias Model =
    { user : Maybe B.User
    , isDarkMode : Bool
    , location : Maybe LocationRes
    , serverInfo : Maybe B.ServerInfo
    , masterUnits : RemoteData ApiError (Dict Int B.Unit)
    , now : Int
    , timeZone : Zone
    , callsignsInfo : Dict String (List B.CallsignInfo)
    , posts : RemoteData ApiError (Dict Int B.Post)
    , toasts : Le.Block.Toast.Model
    , featureNavbarFrontOnly : Bool
    , eventState : Le.EventTypes.EventState
    , pendingEvents : List B.EventMsg
    , eventSubscriptions : Le.EventTypes.EventSubscriptions
    }
