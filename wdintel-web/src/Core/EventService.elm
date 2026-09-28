module Core.EventService exposing
    ( EventState
    , init
    )

import Core.EventTypes



-- TYPES


type alias EventState =
    Core.EventTypes.EventState


-- INIT


init : EventState
init =
    { isPolling = False
    , lastEventId = Nothing
    , error = Nothing
    , connectionInterrupted = False
    , persistentErrorReported = False
    , retryCount = 0
    , retryDelay = 1000 -- Start with 1 second
    }



-- UPDATE
-- HTTP REQUESTS
-- HELPERS
-- VIEW (for debugging/status display)
