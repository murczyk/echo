module Core.EventService exposing
    ( EventState
    , init
    , stop
    )

import Core.EventTypes



-- TYPES


type alias EventState =
    Core.EventTypes.EventState


-- INIT


init : EventState
init =
    { isPolling = False
    , requestInFlight = False
    , generation = 0
    , lastEventId = Nothing
    , error = Nothing
    , connectionInterrupted = False
    , persistentErrorReported = False
    , retryCount = 0
    , retryDelay = 1000 -- Start with 1 second
    }


stop : EventState -> EventState
stop eventService =
    if eventService.isPolling || eventService.requestInFlight then
        { init | generation = eventService.generation + 1 }

    else
        eventService



-- UPDATE
-- HTTP REQUESTS
-- HELPERS
-- VIEW (for debugging/status display)
