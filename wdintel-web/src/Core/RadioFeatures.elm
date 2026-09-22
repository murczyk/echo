module Core.RadioFeatures exposing (analysisFilters, inboxFilters)


type alias RadioFilters a =
    { a
        | selectedFreqs : Maybe (List String)
        , selectedPosts : Maybe (List String)
        , includePelengLocations : Maybe Bool
        , metadataCc : Maybe (List String)
        , metadataSender : Maybe (List String)
        , metadataReceiver : Maybe (List String)
        , metadataHash : Maybe (List String)
        , onlyWithMetadata : Maybe Bool
        , withoutMetadata : Maybe Bool
    }


analysisFilters : Bool -> RadioFilters a -> RadioFilters a
analysisFilters allowed request =
    if allowed then
        request

    else
        { request
            | selectedFreqs = Nothing
            , selectedPosts = Nothing
            , includePelengLocations = Just False
            , metadataCc = Nothing
            , metadataSender = Nothing
            , metadataReceiver = Nothing
            , metadataHash = Nothing
            , onlyWithMetadata = Just False
            , withoutMetadata = Just False
        }


inboxFilters : Bool -> RadioFilters { a | deniedFreqs : Maybe (List String), deniedPosts : Maybe (List String) } -> RadioFilters { a | deniedFreqs : Maybe (List String), deniedPosts : Maybe (List String) }
inboxFilters allowed request =
    if allowed then
        request

    else
        let
            normalized =
                analysisFilters allowed request
        in
        { normalized | deniedFreqs = Nothing, deniedPosts = Nothing }
