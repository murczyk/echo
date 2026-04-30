module Core.EventService exposing
    ( EventState
    , init
    )

-- TYPES


type alias EventState =
    { isPolling : Bool
    , lastEventId : Maybe String
    , error : Maybe String
    , retryCount : Int
    , retryDelay : Int -- milliseconds
    }


-- INIT


init : EventState
init =
    { isPolling = False
    , lastEventId = Nothing
    , error = Nothing
    , retryCount = 0
    , retryDelay = 1000 -- Start with 1 second
    }



-- UPDATE
-- HTTP REQUESTS
-- HELPERS
-- VIEW (for debugging/status display)
