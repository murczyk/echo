module Le.Waterfall.Message exposing (ClipboardObject(..), InternalMsg, Model, Msg, TranslationDictionary, Translator, ViewParams, clipboardMessage, init, setIsDuplicate, translator, update, view)

import Api
import Bindings as B
import Components.Watermark as Watermark
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Extra as HtmlX
import Json.Encode as Encode
import Le.Auth
import Le.Block.MarkedText
import Le.Block.Unit
import Le.Callsign
import Le.Config
import Le.ErrorHandling
import Le.RerMessage
import Le.Time
import Le.Types exposing (ApiError)
import Le.Utils exposing (..)
import Le.ViewUtils exposing (tagsBlock)
import List.Extra as ListX
import Maybe.Extra as MaybeX
import Set exposing (Set)
import Time
import Time.Extra
import Url.Builder


type alias Model =
    { id : Int
    , isDuplicate : Bool

    --TODO: create custom type, it is related to isDuplocatesUnfolded directly
    , isUnfolded : Bool
    , edited : Maybe Le.RerMessage.Edited
    }


init : { id : Int } -> Model
init x =
    { id = x.id
    , isDuplicate = False
    , isUnfolded = False
    , edited = Nothing
    }


setIsDuplicate : Bool -> Model -> Model
setIsDuplicate v m =
    { m | isDuplicate = v }


type alias ViewParams =
    { isDarkMode : Bool
    , user : B.User
    , waterfallId : String
    , datasources : List ( Int, B.Datasource )
    , serverInfo : Maybe B.ServerInfo
    , networks : Dict Int B.Network
    , zone : Maybe Time.Zone
    , time : Maybe Time.Posix
    , profiles : Dict String (Maybe B.SignalProfileEntry)
    , message : ( Int, B.InboxMessage )
    , tags : List ( Int, B.Tag )
    , callsignsInfo : Dict String (List B.CallsignInfo)
    , masterUnits : Dict Int B.Unit
    , signals : List B.Signal
    , copied : Maybe ClipboardObject
    , bookmarks : Set Int
    , importants : Set Int
    , isMsgVisible : List Int
    , groupInfos : Dict String B.SignalGroupEntry
    , messageNetworkIds : List Int
    }


type ClipboardObject
    = Empty
    | Message
    | Freq


waterfallMessageDivId : String -> Int -> String
waterfallMessageDivId waterfallId messageId =
    "waterfall-" ++ waterfallId ++ "-message-" ++ String.fromInt messageId


{-| Does this message have a separate info about unit name etc. or is it all represented in the message?
-}
type DatasourceKind
    = DKSignal
    | DKApi


datasourceKind : B.InboxMessage -> List ( Int, B.Datasource ) -> DatasourceKind
datasourceKind message datasources =
    datasources
        |> findK (message.datasourceId |> def 1)
        |> mmap .kind
        |> (\x ->
                case x of
                    Just "signal" ->
                        DKSignal

                    Just "api" ->
                        DKApi

                    _ ->
                        DKSignal
           )


renderImage : String -> Html msg
renderImage image =
    div [ style "display" "inline-block" ]
        [ a
            [ href image
            , target "_blank"
            ]
            [ img
                [ src image
                , style "height" "100px"
                , style "min-height" "100px"
                , height 100
                ]
                []
            ]
        ]


clipboardMessage :
    B.InboxMessage
    ->
        { r
            | datasources : List ( Int, B.Datasource )
            , profiles : Dict String (Maybe B.SignalProfileEntry)
        }
    -> String
clipboardMessage message vps =
    case datasourceKind message vps.datasources of
        DKSignal ->
            let
                mProfileName =
                    message.sender
                        |> mmap (Le.RerMessage.getProfileName vps.profiles)
                        |> mmap (\x -> x ++ ":\n")
            in
            (mProfileName |> def "") ++ message.text

        DKApi ->
            (message.date |> mmap (\x -> "Дата: " ++ x ++ ";\n") |> def "")
                ++ (message.freq |> mmap (\x -> "Частота: " ++ x ++ ";\n") |> def "")
                ++ (message.location |> mmap (\x -> "Локація: " ++ x ++ ";\n") |> def "")
                ++ (message.unit |> mmap (\x -> "Підрозділ: " ++ x ++ ";\n") |> def "")
                ++ (message.time |> mmap (\x -> "Час: " ++ x ++ ";\n") |> def "")
                ++ (message.callsigns
                        |> ListX.getAt 0
                        |> mmap (\x -> "Хто: " ++ x ++ ";\n")
                        |> def ""
                   )
                ++ (message.callsigns
                        |> ListX.getAt 1
                        |> mmap (\x -> "Кому: " ++ x ++ ";\n")
                        |> def ""
                   )
                ++ (message.callsigns
                        |> List.drop 2
                        |> emptyToNothing
                        |> mmap (String.join ", ")
                        |> mmap (\x -> "Інші: " ++ x ++ ";\n")
                        |> def ""
                   )
                ++ "Текст: "
                ++ message.text
                ++ (message.extendedForm |> mmap (\x -> "\nКоментар: " ++ x ++ ";\n") |> def "")


{-| Determines whether day is shown or not
-}
computeDateTimeRenderParts :
    B.InboxMessage
    -> ViewParams
    ->
        { time : String
        , date : Maybe String
        }
computeDateTimeRenderParts message ps =
    let
        defVal =
            { time = def "" message.time
            , date = message.date
            }
    in
    case message.date of
        Nothing ->
            defVal

        Just _ ->
            case Le.Time.parseDateParts (def "" message.date) of
                Err _ ->
                    defVal

                Ok prts ->
                    case ps.zone of
                        Nothing ->
                            defVal

                        Just zone ->
                            case ps.time of
                                Nothing ->
                                    defVal

                                Just time ->
                                    let
                                        timeS =
                                            message.timestamp
                                                |> mmap Time.millisToPosix
                                                |> mmap (Le.Time.renderTimeF4 zone)
                                                |> def (message.time |> def "")
                                    in
                                    if
                                        Le.Time.partsAreSameDay
                                            (Time.Extra.posixToParts zone time)
                                            prts
                                    then
                                        { time = timeS
                                        , date = Nothing
                                        }

                                    else
                                        { time = timeS
                                        , date = Just (Le.Time.renderPartsF1 prts)
                                        }


type InternalMsg
    = NoOp
    | Edit
    | ToggleTag Int Int
    | ExtendedFormChanged String
    | EditCancel
    | EditSave
    | UnfoldDuplicate
    | InboxSubmitDone Int (Result ApiError ())


type OutMsg
    = CopyToClipboard ClipboardObject
    | BookmarkChanged Int
    | ImportantChanged Int
    | DeleteMessage Int


type Msg
    = ForSelf InternalMsg
    | ForParent OutMsg


type alias TranslationDictionary parentMsg =
    { onInternalMessage : InternalMsg -> parentMsg
    , onCopyToClipboard : ClipboardObject -> parentMsg
    , onBookmarkChanged : Int -> parentMsg
    , onImportantChanged : Int -> parentMsg
    , onMessageDelete : Int -> parentMsg
    }


type alias Translator parentMsg =
    Msg -> parentMsg


translator : TranslationDictionary parentMsg -> Translator parentMsg
translator { onInternalMessage, onCopyToClipboard, onBookmarkChanged, onImportantChanged, onMessageDelete } msg =
    case msg of
        ForSelf internal ->
            onInternalMessage internal

        ForParent parentMsg_ ->
            case parentMsg_ of
                CopyToClipboard co ->
                    onCopyToClipboard co

                BookmarkChanged id ->
                    onBookmarkChanged id

                ImportantChanged id ->
                    onImportantChanged id

                DeleteMessage id ->
                    onMessageDelete id


update : ViewParams -> InternalMsg -> Model -> ( Model, Effect InternalMsg, ( Int, B.InboxMessage ) )
update vps msg model =
    case msg of
        NoOp ->
            ( model, E.none, vps.message )

        Edit ->
            let
                edited =
                    vps.message |> Tuple.second |> (\x -> { original = x })
            in
            ( { model | edited = Just edited }
            , E.none
            , vps.message
            )

        UnfoldDuplicate ->
            ( { model | isUnfolded = True }
            , E.none
            , vps.message
            )

        ToggleTag msgId tagId ->
            ( model
            , E.sendCmd <|
                if Le.RerMessage.isTagSet msgId tagId [ vps.message ] then
                    Api.inbox_message_tags_rm (always NoOp) { messageId = msgId, tagId = tagId }

                else
                    Api.inbox_message_tags_add (always NoOp) { messageId = msgId, tagId = tagId }
            , case Le.RerMessage.toggleTag msgId tagId [ vps.message ] |> List.head of
                Just message_ ->
                    message_

                Nothing ->
                    vps.message
            )

        ExtendedFormChanged str ->
            let
                edited =
                    Just { original = Tuple.second vps.message }
            in
            ( { model
                | edited = edited
              }
            , E.none
            , vps.message
                |> (\( id, message ) ->
                        ( id, { message | extendedForm = Just str } )
                   )
            )

        EditCancel ->
            let
                message2 =
                    case model.edited of
                        Nothing ->
                            vps.message

                        Just edited ->
                            vps.message |> (\( id, _ ) -> ( id, edited.original ))
            in
            ( { model
                | edited = Nothing
              }
            , E.none
            , message2
            )

        EditSave ->
            let
                updatedMsg =
                    case model.edited of
                        Just _ ->
                            Just vps.message

                        _ ->
                            Nothing

                cmds =
                    case updatedMsg of
                        Nothing ->
                            E.none

                        Just v ->
                            Api.rer_importer_inbox_submit (InboxSubmitDone model.id)
                                { messages = [ v ] }
            in
            ( model
            , cmds
            , vps.message
            )

        InboxSubmitDone _ (Err e) ->
            ( model, Le.ErrorHandling.formatErrorForShowErrorWithDetails "Повідомлення не збереглося" e, vps.message )

        InboxSubmitDone _ (Ok ()) ->
            ( { model | edited = Nothing }
            , E.none
            , vps.message
            )



--VIEW


view :
    ViewParams
    -> ( Int, B.InboxMessage )
    -> Model
    -> Html Msg
view ps messageTuple model =
    div [ class "flex px-2" ]
        [ leftColumn messageTuple ps model
        , rightColumn messageTuple ps model
        ]


leftColumn ( messageId, message ) ps model =
    let
        clipboardBlock msgType isBig =
            let
                copied =
                    case ps.copied of
                        Just c ->
                            c == msgType

                        Nothing ->
                            False
            in
            div
                [ class
                    ("cursor-pointer "
                        ++ (if isBig then
                                "text-normal"

                            else
                                "text-sm"
                           )
                    )
                , title "копіювати"
                , onClick <| ForParent (CopyToClipboard msgType)
                ]
                [ i
                    [ class "bi bi-clipboard  text-action cursor-pointer leading-none"
                    , classList
                        [ ( "bi-clipboard", not copied )
                        , ( "bi-clipboard-check-fill", copied )
                        ]
                    ]
                    []
                ]

        dateTimeBlock =
            let
                --TODO add description what time it is
                a =
                    computeDateTimeRenderParts message ps
            in
            div
                [ class "flex justify-around w-full text-center mb-1"
                , style "font-size" ".75rem"
                ]
                [ span [] [ i [ class "bi bi-clock mr-1 text-icons" ] [], text a.time ]
                , flip HtmlX.viewMaybe a.date <|
                    \date -> span [] [ i [ class "bi bi-calendar mr-1 text-icons" ] [], text date ]
                ]

        actionsBlock =
            div [ class "flex justify-around mb-2" ] <|
                [ let
                    bookmarked =
                        Set.member messageId ps.bookmarks
                  in
                  div
                    [ style "font-size" "1rem"
                    , title "додати в закладки"
                    , class "me-1 cursor-pointer"
                    , onClick <| ForParent (BookmarkChanged messageId)
                    ]
                    [ i
                        [ class "bi"
                        , classList
                            [ ( "bi-bookmark text-action cursor-pointer", not bookmarked )
                            , ( "bi-bookmark-fill text-action", bookmarked )
                            ]
                        ]
                        []
                    ]
                , let
                    important =
                        Set.member messageId ps.importants
                  in
                  div
                    [ style "font-size" "1rem"
                    , title "помітити як важливе"
                    , class "me-1 cursor-pointer"
                    , onClick <| ForParent (ImportantChanged messageId)
                    ]
                    [ i
                        [ class "bi"
                        , classList
                            [ ( "bi-exclamation-triangle text-action", not important )
                            , ( "bi-exclamation-triangle-fill text-action", important )
                            ]
                        ]
                        []
                    ]
                , div
                    [ style "font-size" "1rem"
                    , style "cursor" "pointer"
                    , title "редагувати"
                    , onClick <| ForSelf Edit
                    ]
                    [ i
                        [ class "bi bi-pencil me-1 text-action"
                        ]
                        []
                    ]
                , clipboardBlock Message True
                , HtmlX.viewIf (Le.Auth.hasRole "DeleteMsg" ps.user) <|
                    div
                        [ style "font-size" "1rem"
                        , title "видалити повідомлення"
                        , class "me-1 cursor-pointer"
                        , attribute "data-bs-toggle" "modal"
                        , attribute "data-bs-target" "#deleteMessageConfirmation"
                        ]
                        [ i
                            [ class "bi bi-trash3 text-action"
                            , onClick <| ForParent (DeleteMessage messageId)
                            ]
                            []
                        ]
                , HtmlX.viewIf (Le.Config.featureEnableTornado && List.member model.id ps.isMsgVisible) <|
                    div
                        [ style "font-size" "1rem"
                        ]
                        [ i
                            [ class "bi bi-tornado text-action"
                            ]
                            []
                        ]
                ]
    in
    div
        [ class "min-w-[120px] mr-2 basis-1/4 mb-[8px]"
        ]
        [ dateTimeBlock
        , HtmlX.viewIf (not model.isDuplicate || model.isDuplicate && model.isUnfolded) actionsBlock
        , div
            [ class "bg-card rounded-sm text-sm mb-2 "
            ]
            [ flip HtmlX.viewMaybe (message.groupMasterKey |> Maybe.andThen (\groupKey -> Dict.get groupKey ps.groupInfos)) <|
                \group ->
                    div
                        [ class "flex items-center px-2 py-1 border-b-2 border-border"
                        ]
                        [ i [ class "bi bi-signal mr-1 text-icons leading-none", title "Група" ] []
                        , span [ class "text-xs" ] [ text group.name ]
                        ]
            , flip HtmlX.viewMaybe (message.sender |> Maybe.andThen (\senderKey -> Dict.get senderKey ps.profiles) |> Maybe.andThen identity) <|
                \sender ->
                    div
                        [ class "py-1 px-2 flex items-center"
                        ]
                        [ i [ class "bi bi-person-circle mr-1 text-icons leading-none", title "Відправник" ] []
                        , span [ class "text-xs" ] [ text <| Maybe.withDefault "" sender.givenName ++ " " ++ Maybe.withDefault "" sender.familyName ]
                        ]
            ]
        , flip HtmlX.viewMaybe message.freq <|
            \freq ->
                let
                    analysisHref withMap =
                        let
                            dateFromStr =
                                case ( ps.zone, ps.time ) of
                                    ( Just zone, Just time ) ->
                                        Le.Time.renderDateF4 zone (Le.Time.xDaysAgo 15 time)

                                    _ ->
                                        ""

                            dateToStr =
                                case ( ps.zone, ps.time ) of
                                    ( Just zone, Just time ) ->
                                        Le.Time.renderDateF4 zone (Le.Time.xDaysAgo -1 time)

                                    _ ->
                                        ""

                            stateS =
                                Encode.encode 0
                                    (B.rerAnalysisQueryStateEncoder
                                        { dateFromStr = dateFromStr
                                        , timeFromStr = ""
                                        , dateToStr = dateToStr
                                        , timeToStr = "00:00"
                                        , groupsSelected = []
                                        , sendersSelected = []
                                        , freqsSelected = message.freq |> mmap (\x -> [ x ]) |> def []
                                        , callsignsSelected = []
                                        , unitsSelected = []
                                        , locationsSelected = []
                                        , includePelengLocations = False
                                        , orWithExtendedForm = False
                                        , orBookmarked = False
                                        , orImportant = False
                                        , orWithCoords = False
                                        , search = ""
                                        , tags = []
                                        , unitsExactMatchOnly = True
                                        , adjacentFreqsRange = 0
                                        }
                                    )

                            query =
                                if withMap then
                                    [ Url.Builder.string "state" stateS, Url.Builder.string "showMap" "true" ]

                                else
                                    [ Url.Builder.string "state" stateS ]
                        in
                        Url.Builder.absolute [ "rer-analysis" ] query
                in
                HtmlX.viewIf (not model.isDuplicate || model.isDuplicate && model.isUnfolded) <|
                    div
                        [ class "bg-card text-sm mb-2 rounded-sm"
                        ]
                        [ div
                            [ class "flex justify-between items-center py-1 px-2 border-b-2 border-border"
                            ]
                            [ div [ class "flex items-center" ]
                                [ i [ class "bi bi-broadcast mr-1 text-icons leading-none", title "Частота" ] []
                                , span [ class "font-semibold text-xs" ] [ text freq ]
                                ]
                            , clipboardBlock Freq False
                            ]
                        , div
                            [ class "flex justify-between items-center py-1 px-2 border-b-2 border-border"
                            ]
                            [ div [ class "flex items-center" ]
                                [ i [ class "bi bi-bar-chart-line mr-1 text-icons leading-none", title "Аналіз" ] []
                                , span [] [ text "Аналіз" ]
                                ]
                            , a [ href <| analysisHref False, target "_blank" ] [ i [ class "bi bi-box-arrow-up-right cursor-pointer text-action text-sm", title "Відкрити частоту повідомлення в Аналізі" ] [] ]
                            ]
                        , div
                            [ class "flex justify-between items-center py-1 px-2"
                            ]
                            [ span [ class "ml-4" ] [ text "Карта" ]
                            , div [ class "flex items-center" ]
                                [ i [ class "bi bi-map text-sm mr-2 text-text-disabled leading-none", title "Відкрити частоту повідомлення на карті" ] []
                                , a [ href <| analysisHref True, target "_blank" ] [ i [ class "bi bi-box-arrow-up-right cursor-pointer text-action text-sm leading-none", title "Відкрити частоту повідомлення на карті в аналізі" ] [] ]
                                ]
                            ]
                        ]
        , case model.edited of
            Just _ ->
                let
                    extendedFormBlock =
                        let
                            idPrefix =
                                "rer-inbox-msg-"

                            idExtendedFormTextarea =
                                idPrefix ++ String.fromInt model.id
                        in
                        [ div []
                            [ textarea
                                [ class "form-control pt-2 rounded-0 m-1"
                                , style "font-size" ".9rem"
                                , placeholder ""
                                , id <| idExtendedFormTextarea
                                , onInput (ForSelf << ExtendedFormChanged)
                                , value <| Maybe.withDefault "" message.extendedForm
                                , style "height" "80px"
                                , style "width" "120px"
                                , spellcheck False
                                ]
                                []
                            , div []
                                [ div [ class "mt-2 flex justify-center" ]
                                    [ button
                                        [ type_ "button"
                                        , class "btn btn-outline-primaly btn-sm text-nowrap me-1"
                                        , onClick <| ForSelf EditCancel
                                        , style "font-size" ".75rem"
                                        ]
                                        [ i [ class "bi bi-x-square" ] []
                                        ]
                                    , button
                                        [ type_ "button"
                                        , class "btn btn-outline btn-primary btn-sm text-nowrap"
                                        , style "font-size" ".75rem"
                                        , onClick <| ForSelf EditSave
                                        ]
                                        [ i [ class "bi bi-check-square" ] []
                                        ]
                                    ]
                                ]
                            ]
                        ]
                in
                div
                    [ class "flex justify-center"
                    , style "color" "var(--bs-secondary-color)"
                    ]
                    extendedFormBlock

            Nothing ->
                flip HtmlX.viewMaybe message.extendedForm <|
                    \extendedForm ->
                        div
                            [ class "text-center"
                            , style "font-size" ".9rem"
                            ]
                            [ i [ class "bi bi-sticky" ] []
                            , text " "
                            , text extendedForm
                            ]
        ]


rightColumn : ( Int, B.InboxMessage ) -> ViewParams -> Model -> Html Msg
rightColumn ( messageId, message ) ps model =
    div
        [ class "mb-2 rounded-3 px-2 pt-2 pb-2 basis-3/4 flex-1 message-div bg-card relative"
        , style "z-index" "200"
        , style "overflow-wrap" "break-word"
        , style "word-break" "break-word"
        , id <| waterfallMessageDivId ps.waterfallId model.id
        , attribute "data-waterfall-id" ps.waterfallId
        , attribute "data-message-id" (String.fromInt model.id)
        ]
    <|
        (if model.isDuplicate then
            [ span
                [ class "duplicate opacity-75"
                ]
                [ text "дублікат" ]
            ]

         else
            []
        )
            ++ (let
                    duplicateProps =
                        if model.isDuplicate then
                            if model.isUnfolded then
                                []

                            else
                                [ style "height" "25px"
                                , style "overflow" "hidden"
                                , style "cursor" "pointer"
                                , onClick <| ForSelf UnfoldDuplicate
                                ]

                        else
                            []

                    otherCallsignsBlock =
                        message.callsigns
                            |> List.drop 2
                            |> emptyToNothing
                            |> mmap (String.join ", ")
                            |> mmap
                                (\x ->
                                    [ span [ class "me-1" ] [ text "Інші: " ]
                                    , span [ class "fw-semibold" ]
                                        [ text <| x
                                        ]
                                    ]
                                )
                            |> def []

                    networkBlock =
                        let
                            isStrict =
                                ps.serverInfo
                                    |> Maybe.map .featureStrictNetworks
                                    |> Maybe.withDefault False
                        in
                        case message.freq of
                            Nothing ->
                                text " "

                            Just _ ->
                                if List.isEmpty ps.messageNetworkIds then
                                    if isStrict then
                                        text "Не встановлена"

                                    else
                                        text <| " " ++ (message.unit |> def "Не встановлена")

                                else
                                    div [] <|
                                        List.map
                                            (\networkId ->
                                                case Dict.get networkId ps.networks of
                                                    Just network ->
                                                        Le.Block.Unit.boldMasterUnit ps.masterUnits network

                                                    _ ->
                                                        text "Невідома мережа"
                                            )
                                            ps.messageNetworkIds

                    metaFields =
                        let
                            freqAndLocBlock =
                                div [ class "flex justify-start items-start flex-wrap" ]
                                    [ div
                                        [ class "me-2 fw-semibold inline-flex", style "gap" "4px" ]
                                        [ i [ class "bi bi-people text-icons", title "Еталонна прив'язка" ]
                                            []
                                        , networkBlock
                                        ]
                                    , div
                                        [ class "me-2 fw-semibold"
                                        , style "overflow-wrap" "break-word"
                                        , style "word-break" "break-word"
                                        , style "min-width" "0"

                                        -- , class "text-nowrap"
                                        ]
                                        [ i [ class "bi bi-geo text-icons", title "Локація" ] []
                                        , text (" " ++ (message.location |> def "Не встановлена"))
                                        ]
                                    ]

                            datasource_kind =
                                datasourceKind message ps.datasources

                            timeDistBlock =
                                case ps.time of
                                    Nothing ->
                                        []

                                    Just now ->
                                        case message.timestamp of
                                            Nothing ->
                                                []

                                            Just event ->
                                                case ps.zone of
                                                    Nothing ->
                                                        []

                                                    Just zone ->
                                                        [ text <|
                                                            Le.Time.renderDistanceF1
                                                                zone
                                                                (Time.millisToPosix event)
                                                                now
                                                        ]
                        in
                        [ div
                            [ style "font-size" ".8rem"
                            , class "text-end"
                            , style "float" "right"
                            , style "color" "var(--bs-secondary-color)"
                            ]
                            [ div [] timeDistBlock
                            ]
                        , div
                            [ class "d-flex"
                            , style "font-size" ".9rem"
                            ]
                            [ HtmlX.viewIf (MaybeX.isJust message.freq) <|
                                div []
                                    [ freqAndLocBlock
                                    , div [ class "mb-1" ]
                                        [ div
                                            [ class "flex justify-start"
                                            , style "font-size" ".9rem"
                                            , style "overflow-wrap" "break-word"
                                            , style "word-break" "break-word"
                                            , style "min-width" "0"
                                            ]
                                          <|
                                            [ span [ class "me-1" ] [ text "Хто: " ]
                                            , span [ class "text-uppercase fw-semibold me-2" ]
                                                [ text <|
                                                    (message.callsigns
                                                        |> ListX.getAt 0
                                                        |> def "НВ"
                                                    )
                                                ]
                                            , span [ class "me-1" ] [ text "Кому: " ]
                                            , span [ class "text-uppercase fw-semibold me-2" ]
                                                [ text <|
                                                    (message.callsigns
                                                        |> ListX.getAt 1
                                                        |> def "НВ"
                                                    )
                                                ]
                                            ]
                                                ++ otherCallsignsBlock
                                        ]
                                    ]
                            ]
                        ]
                in
                [ div
                    ([ classList [ ( "opacity-25", model.isDuplicate && not model.isUnfolded ) ]
                     , class "relative"
                     ]
                        ++ duplicateProps
                    )
                  <|
                    (div [] <|
                        List.map renderImage message.images
                    )
                        :: metaFields
                        ++ [ Watermark.new ps.user.name |> Watermark.withPositioning ( 60, 80 ) |> Watermark.withFontSize "1.8rem" |> Watermark.view
                           , Watermark.new ps.user.name |> Watermark.withPositioning ( 15, 15 ) |> Watermark.withFontSize "1.8rem" |> Watermark.view
                           ]
                        ++ (case message.textMarked of
                                Just textMarked ->
                                    let
                                        networksWithMessageFreq =
                                            Le.Callsign.filterNetworksByFreq ps.networks message.freq

                                        networksUnitIds =
                                            Le.Callsign.getAllUnitsIdsForNetworks networksWithMessageFreq

                                        networkUnits =
                                            Le.Callsign.getUnitsInfoByIds networksUnitIds ps.masterUnits

                                        --TODO: remove partial to parent module and leave eonly adding callsign
                                        prioritizeCallsignsPartial callsign =
                                            Le.Callsign.prioritizeCallsigns ps.masterUnits networkUnits ps.callsignsInfo callsign

                                        prioritizedCallsignsDict =
                                            message.callsigns
                                                |> List.foldl
                                                    (\callsign dict ->
                                                        let
                                                            prio =
                                                                prioritizeCallsignsPartial callsign
                                                        in
                                                        Dict.insert callsign ( prio, [] ) dict
                                                    )
                                                    Dict.empty
                                    in
                                    Le.Block.MarkedText.new textMarked
                                        |> Le.Block.MarkedText.view prioritizedCallsignsDict (Just ps.signals) (Dict.values ps.networks) message.freq

                                Nothing ->
                                    msgToHtml message.text
                           )
                        ++ [ div
                                [ class "flex justify-start mt-2"
                                , style "color" "var(--bs-secondary-color)"
                                ]
                                (if not model.isDuplicate || model.isUnfolded then
                                    [ tagsBlock
                                        message.tags
                                        (ForSelf << ToggleTag model.id)
                                        ps.tags
                                    ]

                                 else
                                    []
                                )
                           ]
                ]
               )
