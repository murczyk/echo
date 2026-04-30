module Utils.RemoteData exposing (RemoteData(..), isLoading, markOutdated, toMaybe, withDefault, withDefault2)


type RemoteData err data
    = NotAsked
    | Loading
    | Failure err
    | Success data
    | NeedsReload data


withDefault : a -> RemoteData e a -> a
withDefault default data =
    case data of
        Success x ->
            x

        _ ->
            default


withDefault2 : a -> RemoteData e a -> a
withDefault2 default data =
    case data of
        Success x ->
            x

        NeedsReload x ->
            x

        _ ->
            default


toMaybe : RemoteData e a -> Maybe a
toMaybe data =
    case data of
        Success x ->
            Just x

        NeedsReload x ->
            Just x

        _ ->
            Nothing


isLoading : RemoteData e a -> Bool
isLoading data =
    case data of
        Loading ->
            True

        _ ->
            False


markOutdated : RemoteData e a -> RemoteData e a
markOutdated data =
    case data of
        Success xs ->
            NeedsReload xs

        _ ->
            data
