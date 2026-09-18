module Le.Waterfall.MessagesTests exposing (..)

import Bindings as B
import Config exposing (waterfallMessageLimit)
import Expect
import Pages_.RerDuty.Waterfall.Messages as Messages
import Test exposing (..)



-- Define a limit for the tests


messageStub : B.InboxMessage
messageStub =
    { callsignTokens = Just []
    , callsigns = []
    , callsignsAlg2 = []
    , checked = True
    , important = False
    , bookmarked = False
    , coords = Nothing
    , coordsWithLocality = []
    , datasourceId = Just 1
    , date = Just "2024-09-19"
    , extendedForm = Nothing
    , freq = Just "461.3400"
    , groupMasterKey = Just "fsUEaAfYdDM8F1uQ+0AZwFRFXj13DaXuLLnRce4ykpA="
    , imageRecognized = []
    , images = []
    , media = []
    , messageComments = []
    , keywordTokens = Just []
    , location = Just "КАМ'ЯНКА-ДНІПРОВСЬКА"
    , noHeadersBody = Just { body = "НВ\nКОЛЬЦО 22\n— Кольцо, 22, 22, Штиль 1, Штиль 1.", end = 74, start = 0 }
    , post = Nothing
    , sender = Just "00333c5b-2068-498c-b38a-d4198985a063"
    , signalTokens = Just []
    , pointTokens = Just []
    , tags = Just []
    , text = "19.09, 11:33:43\n461.3400\nУКХ р/м йм. 1/2 мсб 1199 мсп (КАМ'ЯНКА-ДНІПРОВСЬКА)\nНВ\nКОЛЬЦО 22\n\n— Кольцо, 22, 22, Штиль 1, Штиль 1."
    , textMarked = Just [ B.CnTextC { text = "— Кольцо, 22, 22, Штиль 1, Штиль 1." } ]
    , time = Just "11:33"
    , timestamp = Just 1726734960438
    , createdAt = Nothing
    , createdAtOrder = Nothing
    , hasDateInHeader = False
    , unit = Just "УКХ р/м йм. 1/2 мсб 1199 мсп"
    , unitIds = []
    , postId = Nothing
    , networkIds = Nothing
    , inboxTags = Nothing
    , messageUuid = Nothing
    , isTimeNull = Nothing
    , messageUid = Nothing
    , metadata = []
    , parentMessages = []
    , intelligenceReports = []
    , networkName = Nothing
    , deviceName = Nothing
    }


messageStubWithUid : String -> B.InboxMessage
messageStubWithUid uid =
    { messageStub | messageUid = Just uid }



-- Test cases


tests : Test
tests =
    describe "Messages"
        [ describe "Append"
            [ test "Appending messages within limit" <|
                \_ ->
                    let
                        initialMessagesList =
                            List.repeat (waterfallMessageLimit - 5) ( 0, messageStub )
                                |> List.indexedMap (\index ( _, message ) -> ( index + 1, message ))

                        initialLastId =
                            initialMessagesList |> List.reverse |> List.head |> Maybe.map Tuple.first |> Maybe.withDefault 0

                        initialMessages =
                            initialMessagesList |> Messages.fromList

                        newMessages =
                            [ ( initialLastId + 1, messageStub ), ( initialLastId + 2, messageStub ) ]

                        result =
                            Messages.appendList initialMessages newMessages

                        last =
                            Messages.toMessageList result |> List.reverse |> List.head
                    in
                    Expect.equal last (Just ( initialLastId + 2, messageStub ))
            , test "Appending skips duplicate message_uid" <|
                \_ ->
                    let
                        initialMessages =
                            Messages.fromList [ ( 1, messageStubWithUid "uid-1" ) ]

                        newMessages =
                            [ ( 2, messageStubWithUid "uid-1" )
                            , ( 3, messageStubWithUid "uid-2" )
                            ]

                        result =
                            Messages.appendList initialMessages newMessages

                        ids =
                            Messages.toMessageList result |> List.map Tuple.first
                    in
                    Expect.equal ids [ 1, 3 ]
            , test "Appending messages exceeding limit" <|
                \_ ->
                    let
                        initialMessagesList =
                            List.repeat (waterfallMessageLimit - 1) ( 0, messageStub )
                                |> List.indexedMap (\index ( _, message ) -> ( index + 1, message ))

                        initialLastId =
                            initialMessagesList |> List.reverse |> List.head |> Maybe.map Tuple.first |> Maybe.withDefault 0

                        initialMessages =
                            initialMessagesList |> Messages.fromList

                        newMessages =
                            [ ( initialLastId + 1, messageStub ), ( initialLastId + 2, messageStub ) ]

                        result =
                            Messages.appendList initialMessages newMessages

                        length =
                            Messages.toList result |> List.length

                        last =
                            Messages.toMessageList result |> List.reverse |> List.head

                        first =
                            Messages.toMessageList result |> List.head

                        expectation =
                            length
                                == waterfallMessageLimit
                                && last
                                == Just ( waterfallMessageLimit + 1, messageStub )
                                && first
                                == Just ( 2, messageStub )
                    in
                    Expect.equal expectation True

            -- Check order after truncation
            , test "Appending empty new messages" <|
                \_ ->
                    let
                        initialMessages =
                            Messages.fromList [ ( 1, messageStub ), ( 2, messageStub ) ]

                        newMessages =
                            []

                        result =
                            Messages.appendList initialMessages newMessages
                    in
                    Expect.equal result (Messages.fromList [ ( 1, messageStub ), ( 2, messageStub ) ])

            -- Should remain unchanged
            , test "Initial messages already at limit" <|
                \_ ->
                    let
                        initialMessages =
                            List.repeat waterfallMessageLimit ( 0, messageStub )
                                |> List.indexedMap (\index ( _, message ) -> ( index + 1, message ))
                                |> Messages.fromList

                        newMessage =
                            ( waterfallMessageLimit + 1, messageStub )

                        result =
                            Messages.appendList initialMessages [ newMessage ]

                        length =
                            Messages.toList result |> List.length

                        last =
                            Messages.toMessageList result |> List.reverse |> List.head

                        first =
                            Messages.toMessageList result |> List.head

                        expectation =
                            length
                                == waterfallMessageLimit
                                && last
                                == Just ( waterfallMessageLimit + 1, messageStub )
                                && first
                                == Just ( 2, messageStub )
                    in
                    Expect.equal expectation True

            -- Check order after truncation
            --TODO: improve
            , test "Appending messages that exceed limit exactly" <|
                \_ ->
                    let
                        initialMessages =
                            List.repeat (waterfallMessageLimit - 3) ( 0, messageStub )
                                |> List.indexedMap (\index ( _, message ) -> ( index, message ))
                                |> Messages.fromList

                        newMessages =
                            [ ( waterfallMessageLimit - 2, messageStub ), ( waterfallMessageLimit - 1, messageStub ), ( waterfallMessageLimit, messageStub ) ]

                        result =
                            Messages.appendList initialMessages newMessages

                        last =
                            Messages.toMessageList result |> List.reverse |> List.head
                    in
                    Expect.equal last (Just ( waterfallMessageLimit, messageStub ))

            -- Check order after truncation
            ]
        , describe "prependList"
            [ test "Prepending messages within limit" <|
                \_ ->
                    let
                        initialMessagesList =
                            List.repeat (waterfallMessageLimit - 5) ( 0, messageStub )
                                |> List.indexedMap (\index ( _, message ) -> ( index + 1, message ))

                        initialLastId =
                            initialMessagesList |> List.reverse |> List.head |> Maybe.map Tuple.first |> Maybe.withDefault 0

                        initialMessages =
                            initialMessagesList |> Messages.fromList

                        newMessages =
                            [ ( initialLastId + 1, messageStub ), ( initialLastId + 2, messageStub ) ]

                        result =
                            Messages.prependList initialMessages newMessages

                        length =
                            Messages.toList result |> List.length

                        last =
                            Messages.toMessageList result |> List.reverse |> List.head

                        first =
                            Messages.toMessageList result |> List.head

                        expectation =
                            length
                                == (waterfallMessageLimit - 3)
                                && last
                                == Just ( initialLastId, messageStub )
                                && first
                                == Just ( initialLastId + 1, messageStub )
                    in
                    Expect.equal expectation True
            , test "Prepending messages exceeding limit" <|
                \_ ->
                    let
                        initialMessagesList =
                            List.repeat (waterfallMessageLimit - 1) ( 0, messageStub )
                                |> List.indexedMap (\index ( _, message ) -> ( index + 1, message ))

                        initialLastId =
                            initialMessagesList |> List.reverse |> List.head |> Maybe.map Tuple.first |> Maybe.withDefault 0

                        initialMessages =
                            initialMessagesList |> Messages.fromList

                        newMessages =
                            [ ( initialLastId + 1, messageStub ), ( initialLastId + 2, messageStub ) ]

                        result =
                            Messages.prependList initialMessages newMessages

                        length =
                            Messages.toList result |> List.length

                        last =
                            Messages.toMessageList result |> List.reverse |> List.head

                        first =
                            Messages.toMessageList result |> List.head

                        expectation =
                            length
                                == waterfallMessageLimit
                                && last
                                == Just ( initialLastId - 1, messageStub )
                                && first
                                == Just ( initialLastId + 1, messageStub )
                    in
                    Expect.equal expectation True

            -- Check order after truncation
            , test "Prepending empty new messages" <|
                \_ ->
                    let
                        initialMessages =
                            Messages.fromList [ ( 1, messageStub ), ( 2, messageStub ) ]

                        newMessages =
                            []

                        result =
                            Messages.prependList initialMessages newMessages
                    in
                    Expect.equal result (Messages.fromList [ ( 1, messageStub ), ( 2, messageStub ) ])

            -- Should remain unchanged
            , test "Initial messages already at limit" <|
                \_ ->
                    let
                        initialMessagesList =
                            List.repeat waterfallMessageLimit ( 0, messageStub )
                                |> List.indexedMap (\index ( _, message ) -> ( index + 1, message ))

                        initialLastId =
                            initialMessagesList |> List.reverse |> List.head |> Maybe.map Tuple.first |> Maybe.withDefault 0

                        initialMessages =
                            initialMessagesList |> Messages.fromList

                        newMessages =
                            [ ( initialLastId + 1, messageStub ) ]

                        result =
                            Messages.prependList initialMessages newMessages

                        length =
                            Messages.toList result |> List.length

                        last =
                            Messages.toMessageList result |> List.reverse |> List.head

                        first =
                            Messages.toMessageList result |> List.head

                        expectation =
                            length
                                == waterfallMessageLimit
                                && last
                                == Just ( initialLastId - 1, messageStub )
                                && first
                                == Just ( initialLastId + 1, messageStub )
                    in
                    Expect.equal expectation True

            -- Check order after truncation
            , test "Prepending messages that exceed limit exactly" <|
                \_ ->
                    let
                        initialMessagesList =
                            List.repeat waterfallMessageLimit ( 0, messageStub )
                                |> List.indexedMap (\index ( _, message ) -> ( index + 1, message ))

                        initialLastId =
                            initialMessagesList |> List.reverse |> List.head |> Maybe.map Tuple.first |> Maybe.withDefault 0

                        initialMessages =
                            initialMessagesList |> Messages.fromList

                        newMessages =
                            [ ( initialLastId + 1, messageStub ), ( initialLastId + 2, messageStub ), ( initialLastId + 3, messageStub ) ]

                        result =
                            Messages.prependList initialMessages newMessages

                        length =
                            Messages.toList result |> List.length

                        last =
                            Messages.toMessageList result |> List.reverse |> List.head

                        first =
                            Messages.toMessageList result |> List.head

                        expectation =
                            length
                                == waterfallMessageLimit
                                && last
                                == Just ( initialLastId - 3, messageStub )
                                && first
                                == Just ( initialLastId + 1, messageStub )
                    in
                    Expect.equal expectation True

            -- Check order after truncation
            ]
        ]
