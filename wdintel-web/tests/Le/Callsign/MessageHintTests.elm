module Le.Callsign.MessageHintTests exposing (suite)

import Bindings as B
import Core.Callsigns.MessageHint as MessageHint
import Dict
import Expect
import Test exposing (Test, describe, test)


info : Int -> String -> B.CallsignInfo
info id position =
    { id = id
    , callsign = "wolf"
    , position = position
    , comment = ""
    , unit1 = ""
    , unit2 = ""
    , unitId = Nothing
    , networkIdsReportedIn = []
    }


hint : Int -> Int -> String -> String -> B.CallsignNetworkHint
hint id networkId position formation =
    { id = id
    , networkId = networkId
    , position = position
    , formation = formation
    }


response : String -> List B.CallsignInfo -> List B.CallsignNetworkHint -> B.CallsignInfoRes
response callsign rows hints =
    { callsign = callsign, res = rows, networkHints = hints }


network : B.Network
network =
    { id = 10
    , freqs = []
    , unitIds = Nothing
    , aorIds = []
    , name = "Тестова мережа"
    , location = ""
    , radioStation = Nothing
    , createdAt = 0
    , purpose = Nothing
    , operationMode = Nothing
    , operationType = Nothing
    , operationPeriod = Nothing
    , lastActivityAt = Nothing
    , lastUpdatedAt = 0
    , lastUpdatedBy = Nothing
    , activeFrom = Nothing
    , activeTo = Nothing
    , postIds = []
    , descriptions = []
    , deleted = False
    , doNotArchive = False
    , unitMask = []
    , status = B.NetworkActive
    }


result : Maybe (List Int) -> List B.CallsignInfo -> List B.CallsignNetworkHint -> MessageHint.MessageHintResult
result networkIds rows hints =
    MessageHint.resolve networkIds (Dict.fromList [ ( 10, network ) ]) (Dict.fromList [ ( "wolf", response "wolf" rows hints ) ]) " WOLF "


headers : MessageHint.MessageHintResult -> List String
headers =
    MessageHint.tooltipSections >> List.map .header


message : Maybe (List B.ContentNode) -> List String -> Maybe (List Int) -> B.InboxMessage
message textMarked callsigns networkIds =
    { messageUuid = Nothing
    , messageUid = Nothing
    , text = "wolf"
    , media = []
    , images = []
    , imageRecognized = []
    , date = Nothing
    , time = Nothing
    , freq = Nothing
    , coords = Nothing
    , coordsWithLocality = []
    , callsigns = callsigns
    , callsignsAlg2 = []
    , checked = False
    , important = False
    , bookmarked = False
    , timestamp = Nothing
    , groupMasterKey = Nothing
    , sender = Nothing
    , extendedForm = Nothing
    , messageComments = []
    , post = Nothing
    , postId = Nothing
    , unit = Nothing
    , unitIds = []
    , callsignTokens = Nothing
    , signalTokens = Nothing
    , pointTokens = Nothing
    , noHeadersBody = Nothing
    , keywordTokens = Nothing
    , textMarked = textMarked
    , datasourceId = Nothing
    , location = Nothing
    , tags = Nothing
    , networkIds = networkIds
    , networkName = Nothing
    , deviceName = Nothing
    , inboxTags = Nothing
    , metadata = []
    , parentMessages = []
    , intelligenceReports = []
    }


suite : Test
suite =
    describe "Classic message callsign hints"
        [ test "extracts marked callsigns and falls back only when none are marked" <|
            \_ ->
                Expect.equal [ "wolf" ]
                    (MessageHint.callsignsFromMessage
                        (message
                            (Just
                                [ B.CnHighlightC { text = "other", begin = 0, end = 5 }
                                , B.CnCallsignC { text = " WOLF ", begin = 6, end = 12, etalon = "wolf" }
                                ]
                            )
                            [ "fallback" ]
                            Nothing
                        )
                    )
        , test "merges normalized responses while preserving unrelated entries and replacing rows by id" <|
            \_ ->
                let
                    existing =
                        Dict.fromList
                            [ ( "alpha", response "alpha" [ info 7 "alpha" ] [] )
                            , ( "wolf", response "wolf" [ info 1 "old" ] [ hint 3 10 "" "old" ] )
                            ]

                    merged =
                        MessageHint.mergeResponses
                            [ response " WOLF " [ info 1 "new", info 2 "second" ] [ hint 3 20 "" "new", hint 4 20 "" "second" ] ]
                            existing
                in
                Expect.all
                    [ \_ -> Expect.equal (Just (response "alpha" [ info 7 "alpha" ] [])) (Dict.get "alpha" merged)
                    , \_ -> Expect.equal (Just [ 1, 2 ]) (Dict.get "wolf" merged |> Maybe.map (.res >> List.map .id))
                    , \_ -> Expect.equal (Just "new") (Dict.get "wolf" merged |> Maybe.andThen (.res >> List.head) |> Maybe.map .position)
                    , \_ -> Expect.equal (Just [ 3, 4 ]) (Dict.get "wolf" merged |> Maybe.map (.networkHints >> List.map .id))
                    , \_ -> Expect.equal (Just "new") (Dict.get "wolf" merged |> Maybe.andThen (.networkHints >> List.head) |> Maybe.map .formation)
                    , \_ -> Expect.equal (Just " WOLF ") (Dict.get "wolf" merged |> Maybe.map .callsign)
                    ]
                    ()
        , test "resolves exact network hints ahead of other-network hints" <|
            \_ ->
                MessageHint.resolve (Just [ 10 ])
                    Dict.empty
                    (Dict.fromList [ ( "wolf", response "wolf" [] [ hint 1 10 "" "", hint 2 20 "" "" ] ) ])
                    "WOLF"
                    |> .state
                    |> Expect.equal MessageHint.MessageNetwork
        , test "exact hints expose only the exact section and exclude unrelated catalog rows" <|
            \_ ->
                let
                    resolved =
                        result (Just [ 10 ]) [ info 9 "ТЮМЕНЬ" ] [ hint 1 10 "" "" ]
                in
                Expect.all
                    [ \_ -> Expect.equal MessageHint.MessageNetwork resolved.state
                    , \_ -> Expect.equal [ "Позивні підрозділів мережі:" ] (headers resolved)
                    , \_ -> Expect.equal [ "Позивний присутній у мережі «Тестова мережа». Додатковий опис відсутній." ] (MessageHint.tooltipSections resolved |> List.concatMap .items)
                    ]
                    ()
        , test "catalog-only and blank catalog rows remain visible" <|
            \_ ->
                let
                    resolved =
                        result Nothing [ info 9 "" ] []
                in
                Expect.all
                    [ \_ -> Expect.equal MessageHint.KnownElsewhere resolved.state
                    , \_ -> Expect.equal "bi-info-circle" (MessageHint.iconClass resolved)
                    , \_ -> Expect.equal [ "Позивні з каталогу:" ] (headers resolved)
                    , \_ -> Expect.equal [ "Позивний присутній у каталозі. Додатковий опис відсутній." ] (MessageHint.tooltipSections resolved |> List.concatMap .items)
                    ]
                    ()
        , test "other-network hints are separated from catalog hints" <|
            \_ ->
                let
                    other =
                        result (Just [ 10 ]) [] [ hint 1 20 "" "" ]

                    both =
                        result (Just [ 10 ]) [ info 1 "catalog" ] [ hint 2 20 "" "other" ]
                in
                Expect.all
                    [ \_ -> Expect.equal MessageHint.KnownElsewhere other.state
                    , \_ -> Expect.equal [ "Позивний присутній в інших мережах:" ] (headers other)
                    , \_ -> Expect.equal [ "Позивні з каталогу:", "Позивний присутній в інших мережах:" ] (headers both)
                    ]
                    ()
        , test "missing and empty responses are unresolved" <|
            \_ ->
                let
                    empty =
                        MessageHint.resolve (Just []) Dict.empty (Dict.fromList [ ( "wolf", response "wolf" [] [] ) ]) "wolf"

                    missing =
                        MessageHint.resolve Nothing Dict.empty Dict.empty "wolf"
                in
                Expect.all
                    [ \_ -> Expect.equal MessageHint.Unresolved empty.state
                    , \_ -> Expect.equal "" (MessageHint.iconClass empty)
                    , \_ -> Expect.equal [] (MessageHint.tooltipSections empty)
                    , \_ -> Expect.equal MessageHint.Unresolved missing.state
                    ]
                    ()
        , test "network IDs absent or empty classify hints as other-network" <|
            \_ ->
                let
                    responseWithHint =
                        response "wolf" [] [ hint 1 20 "" "" ]

                    noIds =
                        MessageHint.resolve Nothing Dict.empty (Dict.fromList [ ( "wolf", responseWithHint ) ]) "wolf"

                    emptyIds =
                        MessageHint.resolve (Just []) Dict.empty (Dict.fromList [ ( "wolf", responseWithHint ) ]) "wolf"
                in
                Expect.all
                    [ \_ -> Expect.equal [ 20 ] (noIds.otherNetworkHints |> List.map .networkId)
                    , \_ -> Expect.equal [ 20 ] (emptyIds.otherNetworkHints |> List.map .networkId)
                    ]
                    ()
        , test "extraction falls back correctly and normalizes duplicates" <|
            \_ ->
                Expect.all
                    [ \_ -> Expect.equal [ "wolf" ] (MessageHint.callsignsFromMessage (message Nothing [ " WOLF ", "wolf", "" ] Nothing))
                    , \_ -> Expect.equal [ "wolf" ] (MessageHint.callsignsFromMessage (message (Just [ B.CnHighlightC { text = "other", begin = 0, end = 5 } ]) [ " WOLF " ] Nothing))
                    , \_ -> Expect.equal [ "wolf" ] (MessageHint.callsignsFromMessage (message (Just [ B.CnCallsignC { text = " WOLF ", begin = 0, end = 6, etalon = "wolf" } ]) [ "other" ] Nothing))
                    ]
                    ()
        ]
