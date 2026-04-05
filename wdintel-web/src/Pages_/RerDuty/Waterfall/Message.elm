module Pages_.RerDuty.Waterfall.Message exposing (ClipboardObject(..), InternalMsg, Model, Msg, TranslationDictionary, Translator, ViewParams, clipboardMessage, init, setIsDuplicate, translator, update, view)

import Api
import Bindings as B exposing (MessageMediaInfo)
import Browser.Dom
import Config
import Core.Auth
import Core.Callsigns.HintStrategy
import Core.Types exposing (ApiError)
import Core.Unit
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Extra as HtmlX
import Json.Encode as Encode
import List.Extra as ListX
import Maybe exposing (withDefault)
import Maybe.Extra as MaybeX
import Pages_.RerAnalysis.Utils
import Shared.Components.Popup as Popup
import Shared.Components.RerMessage
import Shared.Components.Watermark as Watermark
import Shared.MarkedText
import String
import Task
import Time
import Time.Extra
import Url.Builder
import Utils.Api.ErrorHandling
import Utils.Time
import Utils.Utils exposing (..)
import Utils.ViewUtils exposing (tagsBlock)


type alias Model =
    { id : Int
    , isDuplicate : Bool

    --TODO: create custom type, it is related to isDuplocatesUnfolded directly
    , isUnfolded : Bool
    , edited : Maybe { original : B.InboxMessage, current : B.InboxMessage }
    , isEditPopupOpen : Bool
    , botTagAction : Maybe { messageId : Int, tagId : Int }
    }


init : { id : Int } -> Model
init x =
    { id = x.id
    , isDuplicate = False
    , isUnfolded = False
    , edited = Nothing
    , isEditPopupOpen = False
    , botTagAction = Nothing
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
    , zone : Time.Zone
    , time : Maybe Time.Posix
    , profiles : Dict String (Maybe B.SignalProfileEntry)
    , message : ( Int, B.InboxMessage )
    , tags : List ( Int, B.Tag )
    , callsignsInfo : Dict String (List B.CallsignInfo)
    , masterUnits : Dict Int B.Unit
    , signals : List B.Signal
    , copied : Maybe ClipboardObject
    , isMsgVisible : List Int
    , groupInfos : Dict String B.SignalGroupEntry
    , messageNetworkIds : List Int
    , onlyMyUnitTagsEnabled : Bool
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


renderAttachment : MessageMediaInfo -> Html msg
renderAttachment attachment =
    let
        displayFileName =
            withDefault "<файл без назви>" attachment.fileName
    in
    a
        [ class "btn btn-outline-secondary btn-sm mb-2"
        , href attachment.href
        , download displayFileName
        , target "_blank"
        ]
        [ i [ class "bi bi-download me-2" ] []
        , text displayFileName
        ]


renderMedia : MessageMediaInfo -> Maybe (Html msg)
renderMedia attachment =
    let
        isImage =
            String.startsWith "image/" attachment.contentType

        isMp3 =
            String.contains "mpeg" attachment.contentType
                || String.contains "mp3" attachment.contentType
                || (attachment.fileName
                        |> Maybe.map String.toLower
                        |> Maybe.map (String.endsWith ".mp3")
                        |> withDefault False
                   )
    in
    if isImage then
        Just <| renderImage attachment.href

    else if isMp3 then
        Just <| renderAttachment attachment

    else if Config.featureHideDocuments then
        Nothing

    else
        Just <| renderAttachment attachment


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
                        |> mmap (Shared.Components.RerMessage.getProfileName vps.profiles)
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
            case Utils.Time.parseDateParts (def "" message.date) of
                Err _ ->
                    defVal

                Ok prts ->
                    case ps.time of
                        Nothing ->
                            defVal

                        Just time ->
                            let
                                timeS =
                                    message.timestamp
                                        |> mmap Time.millisToPosix
                                        |> mmap (Utils.Time.renderTimeF4 ps.zone)
                                        |> def (message.time |> def "")
                            in
                            if
                                Utils.Time.partsAreSameDay
                                    (Time.Extra.posixToParts ps.zone time)
                                    prts
                            then
                                { time = timeS
                                , date = Nothing
                                }

                            else
                                { time = timeS
                                , date = Just (Utils.Time.renderPartsF1 prts)
                                }


type InternalMsg
    = NoOp
    | Edit
    | EditPopupOpen
    | EditPopupClose
    | FocusTextarea (Result Browser.Dom.Error ())
    | ToggleTag Int Int
    | MarkBotTagWrong Int Int
    | MarkBotTagWrongDone Int Int (Result ApiError ())
    | CancelBotTagAction
    | ExtendedFormChanged String
    | EditCancel
    | EditSave
    | UnfoldDuplicate
    | CommentSaveDone Int (Result ApiError ())


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


inboxTagsFor : B.InboxMessage -> List B.InboxMessageTag
inboxTagsFor message =
    message.inboxTags |> Maybe.withDefault []


buildAnalysisMapUrlWithSearch : ViewParams -> B.InboxMessage -> List String -> String
buildAnalysisMapUrlWithSearch ps message etalons =
    let
        searchStr =
            etalons
                |> ListX.unique
                |> List.filter (\s -> String.trim s /= "")
                |> String.join ","
    in
    if String.trim searchStr == "" then
        Url.Builder.absolute [ "rer-analysis" ] [ Url.Builder.string "showMap" "true" ]

    else
        let
            dateFromStr =
                case ps.time of
                    Just time ->
                        Utils.Time.renderDateF4 ps.zone (Utils.Time.xDaysAgo 15 time)

                    _ ->
                        ""

            dateToStr =
                case ps.time of
                    Just time ->
                        Utils.Time.renderDateF4 ps.zone (Utils.Time.xDaysAgo -1 time)

                    _ ->
                        ""

            stateStr =
                Encode.encode 0
                    (B.rerAnalysisQueryStateEncoder
                        { dateFromStr = dateFromStr
                        , timeFromStr = ""
                        , dateToStr = dateToStr
                        , timeToStr = "00:00"
                        , aorsSelected = []
                        , groupsSelected = []
                        , sendersSelected = []
                        , freqsSelected = message.freq |> mmap (\x -> [ x ]) |> def []
                        , callsignsSelected = []
                        , unitsSelected = []
                        , locationsSelected = []
                        , postsSelected = []
                        , networksSelected = []
                        , withoutNetwork = False
                        , includePelengLocations = False
                        , orWithExtendedForm = False
                        , orBookmarked = False
                        , orImportant = False
                        , orWithCoords = False
                        , search = searchStr
                        , metadataCc = []
                        , metadataSender = []
                        , metadataReceiver = []
                        , metadataHash = []
                        , onlyWithMetadata = False
                        , withoutMetadata = False
                        , tags = []
                        , unitsExactMatchOnly = Nothing
                        , adjacentFreqsRange = 0
                        , withoutModelTags = False
                        , filterTagsOption = Nothing
                        , reportTagsOnlyThisUnit = Nothing
                        }
                    )
        in
        Url.Builder.absolute [ "rer-analysis" ]
            [ Url.Builder.string "state" stateStr
            , Url.Builder.string "showMap" "true"
            ]


hasUserTag : Int -> String -> B.InboxMessage -> Bool
hasUserTag tagId login message =
    inboxTagsFor message
        |> List.any
            (\t ->
                t.tagId
                    == tagId
                    && t.login
                    == Just login
                    && MaybeX.isNothing t.model
            )


hasBotTag : Int -> B.InboxMessage -> Bool
hasBotTag tagId message =
    inboxTagsFor message
        |> List.any (\t -> t.tagId == tagId && MaybeX.isJust t.model)


removeBotTags : Int -> B.InboxMessage -> B.InboxMessage
removeBotTags tagId message =
    let
        filtered =
            inboxTagsFor message
                |> List.filter (\tag -> not (tag.tagId == tagId && MaybeX.isJust tag.model))

        tagsCombined =
            let
                botlessIds =
                    filtered |> List.map .tagId |> ListX.unique
            in
            botlessIds
                ++ (message.tags |> def [] |> List.filter (\id -> not (List.member id botlessIds)))
    in
    { message | inboxTags = Just filtered, tags = Just tagsCombined }


update : ViewParams -> InternalMsg -> Model -> ( Model, Effect InternalMsg, ( Int, B.InboxMessage ) )
update vps msg model =
    case msg of
        NoOp ->
            ( model, E.none, vps.message )

        Edit ->
            let
                currentMessage =
                    Tuple.second vps.message

                edited =
                    { original = currentMessage, current = currentMessage }

                textareaId =
                    "edit-comment-textarea-" ++ String.fromInt (Tuple.first vps.message)

                focusCmd =
                    Task.attempt FocusTextarea (Browser.Dom.focus textareaId)
            in
            ( { model | edited = Just edited, isEditPopupOpen = True }
            , E.sendCmd focusCmd
            , vps.message
            )

        EditPopupOpen ->
            let
                currentMessage =
                    Tuple.second vps.message

                edited =
                    { original = currentMessage, current = currentMessage }

                textareaId =
                    "edit-comment-textarea-" ++ String.fromInt (Tuple.first vps.message)

                focusCmd =
                    Task.attempt FocusTextarea (Browser.Dom.focus textareaId)
            in
            ( { model | edited = Just edited, isEditPopupOpen = True }
            , E.sendCmd focusCmd
            , vps.message
            )

        EditPopupClose ->
            ( { model | isEditPopupOpen = False }
            , E.none
            , vps.message
            )

        FocusTextarea _ ->
            ( model, E.none, vps.message )

        UnfoldDuplicate ->
            ( { model | isUnfolded = True }
            , E.none
            , vps.message
            )

        ToggleTag msgId tagId ->
            let
                userHasTag =
                    hasUserTag tagId vps.user.name (Tuple.second vps.message)

                botPanel =
                    if userHasTag && hasBotTag tagId (Tuple.second vps.message) then
                        Just { messageId = msgId, tagId = tagId }

                    else
                        Nothing

                updatedMessage =
                    Shared.Components.RerMessage.toggleTag msgId tagId (Just vps.user.name) vps.user.organismId [ vps.message ]
                        |> List.head
                        |> Maybe.withDefault vps.message
            in
            ( { model | botTagAction = botPanel }
            , E.sendCmd <|
                if userHasTag then
                    Api.inbox_message_tags_rm (always NoOp) { messageId = msgId, tagId = tagId }

                else
                    Api.inbox_message_tags_add (always NoOp) { messageId = msgId, tagId = tagId }
            , updatedMessage
            )

        MarkBotTagWrong msgId tagId ->
            ( model
            , E.sendCmd <|
                Api.inbox_message_tags_model_error
                    (MarkBotTagWrongDone msgId tagId)
                    { messageId = msgId, tagId = tagId }
            , vps.message
            )

        MarkBotTagWrongDone _ tagId (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося оновити тег бота" e
            , vps.message
            )

        MarkBotTagWrongDone _ tagId (Ok _) ->
            let
                updatedMessage =
                    removeBotTags tagId (Tuple.second vps.message)
            in
            ( { model | botTagAction = Nothing }
            , E.none
            , ( Tuple.first vps.message, updatedMessage )
            )

        CancelBotTagAction ->
            ( { model | botTagAction = Nothing }, E.none, vps.message )

        ExtendedFormChanged str ->
            let
                edited =
                    case model.edited of
                        Just existing ->
                            let
                                current =
                                    existing.current

                                updatedCurrent =
                                    { current | extendedForm = Just str }
                            in
                            Just { existing | current = updatedCurrent }

                        Nothing ->
                            let
                                currentMessage =
                                    Tuple.second vps.message

                                updatedMessage =
                                    { currentMessage | extendedForm = Just str }
                            in
                            Just { original = currentMessage, current = updatedMessage }
            in
            ( { model | edited = edited }
            , E.none
            , case edited of
                Just e ->
                    ( Tuple.first vps.message, e.current )

                Nothing ->
                    vps.message
            )

        EditCancel ->
            let
                message2 =
                    case model.edited of
                        Nothing ->
                            vps.message

                        Just edited ->
                            ( Tuple.first vps.message, edited.original )
            in
            ( { model
                | edited = Nothing
                , isEditPopupOpen = False
              }
            , E.none
            , message2
            )

        EditSave ->
            let
                ( updatedMsg, messageToReturn ) =
                    case model.edited of
                        Just edited ->
                            ( Just ( Tuple.first vps.message, edited.current )
                            , ( Tuple.first vps.message, edited.current )
                            )

                        Nothing ->
                            ( Nothing, vps.message )

                cmds =
                    case updatedMsg of
                        Nothing ->
                            E.none

                        Just ( msgId, messageVal ) ->
                            let
                                commentCleaned =
                                    messageVal.extendedForm
                                        |> Maybe.map String.trim
                                        |> Maybe.andThen
                                            (\v ->
                                                if v == "" then
                                                    Nothing

                                                else
                                                    Just v
                                            )
                            in
                            Api.rer_importer_comment_save (CommentSaveDone model.id)
                                { messageId = msgId, comment = commentCleaned }
                                |> E.sendCmd
            in
            ( { model | isEditPopupOpen = False }
            , cmds
            , messageToReturn
            )

        CommentSaveDone _ (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Повідомлення не збереглося" e, vps.message )

        CommentSaveDone _ (Ok ()) ->
            ( { model | edited = Nothing, isEditPopupOpen = False }
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
                        message.bookmarked
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
                        message.important
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
                , Popup.new
                    { body =
                        i
                            [ class "bi bi-pencil me-1 text-action"
                            , style "font-size" "1rem"
                            , style "cursor" "pointer"
                            , title "редагувати"
                            ]
                            []
                    , popupBody =
                        div [ class "p-2", style "min-width" "300px" ]
                            [ textarea
                                [ class "form-control mb-2"
                                , style "height" "120px"
                                , style "width" "100%"
                                , placeholder "Введіть коментар..."
                                , id ("edit-comment-textarea-" ++ String.fromInt messageId)
                                , onInput (ForSelf << ExtendedFormChanged)
                                , value <|
                                    case model.edited of
                                        Just edited ->
                                            Maybe.withDefault "" edited.current.extendedForm

                                        Nothing ->
                                            Maybe.withDefault "" message.extendedForm
                                , spellcheck False
                                ]
                                []
                            , div [ class "d-flex justify-content-end gap-2" ]
                                [ button
                                    [ type_ "button"
                                    , class "btn btn-outline-secondary btn-sm"
                                    , onClick <| ForSelf EditCancel
                                    ]
                                    [ text "Відміна" ]
                                , button
                                    [ type_ "button"
                                    , class "btn btn-primary btn-sm"
                                    , onClick <| ForSelf EditSave
                                    ]
                                    [ text "Зберегти" ]
                                ]
                            ]
                    , isOpen = model.isEditPopupOpen
                    , onOpen = ForSelf EditPopupOpen
                    , onClose = ForSelf EditPopupClose
                    , disabled = False
                    }
                    |> Popup.withPlacementBottom
                    |> Popup.view
                , clipboardBlock Message True
                , HtmlX.viewIf (Core.Auth.hasRole "DeleteMsg" ps.user) <|
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
                , HtmlX.viewIf (Config.featureEnableTornado && List.member model.id ps.isMsgVisible) <|
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
                                case ps.time of
                                    Just time ->
                                        Utils.Time.renderDateF4 ps.zone (Utils.Time.xDaysAgo 15 time)

                                    _ ->
                                        ""

                            dateToStr =
                                case ps.time of
                                    Just time ->
                                        Utils.Time.renderDateF4 ps.zone (Utils.Time.xDaysAgo -1 time)

                                    _ ->
                                        ""

                            stateS =
                                Encode.encode 0
                                    (B.rerAnalysisQueryStateEncoder
                                        { dateFromStr = dateFromStr
                                        , timeFromStr = ""
                                        , dateToStr = dateToStr
                                        , timeToStr = "00:00"
                                        , aorsSelected = []
                                        , groupsSelected = []
                                        , sendersSelected = []
                                        , freqsSelected = message.freq |> mmap (\x -> [ x ]) |> def []
                                        , callsignsSelected = []
                                        , unitsSelected = []
                                        , locationsSelected = []
                                        , postsSelected = []
                                        , networksSelected = []
                                        , withoutNetwork = False
                                        , includePelengLocations = False
                                        , orWithExtendedForm = False
                                        , orBookmarked = False
                                        , orImportant = False
                                        , orWithCoords = False
                                        , search = ""
                                        , metadataCc = []
                                        , metadataSender = []
                                        , metadataReceiver = []
                                        , metadataHash = []
                                        , onlyWithMetadata = False
                                        , withoutMetadata = False
                                        , tags = []
                                        , unitsExactMatchOnly = Nothing
                                        , adjacentFreqsRange = 0
                                        , withoutModelTags = False
                                        , filterTagsOption = Nothing
                                        , reportTagsOnlyThisUnit = Nothing
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
        , flip HtmlX.viewMaybe message.extendedForm <|
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
    let
        uniqueMessageNetworkIds =
            ListX.unique ps.messageNetworkIds

        metadataLinks =
            Pages_.RerAnalysis.Utils.buildMetadataLinks ps.zone message

        pointTokenClickUrl =
            if Pages_.RerAnalysis.Utils.messageHasPalitraTag ps.tags message then
                Just (\_ -> buildAnalysisMapUrlWithSearch ps message (Pages_.RerAnalysis.Utils.getPointEtalonsFromMessage message))

            else
                Nothing
    in
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
                                                        let
                                                            networkText =
                                                                Core.Unit.createMasterUnitText ps.masterUnits network

                                                            networkUrl =
                                                                "/rer-networks/" ++ String.fromInt networkId

                                                            noUnitsBadge =
                                                                case network.unitIds of
                                                                    Nothing ->
                                                                        span [ class "ml-2 badge badge-no-unit-sm" ] [ text "в дорозвідці" ]

                                                                    Just ids ->
                                                                        if List.isEmpty ids then
                                                                            span [ class "ml-2 badge badge-no-unit-sm" ] [ text "в дорозвідці" ]

                                                                        else
                                                                            text ""
                                                        in
                                                        div [ class "flex items-center gap-1 font-medium group" ]
                                                            [ span []
                                                                [ text networkText
                                                                , noUnitsBadge
                                                                ]
                                                            , a
                                                                [ href networkUrl
                                                                , target "_blank"
                                                                , class "opacity-30 group-hover:opacity-100 transition-opacity duration-200 cursor-pointer"
                                                                , title "Відкрити мережу в новій вкладці"
                                                                ]
                                                                [ i [ class "bi bi-box-arrow-up-right text-sm" ] [] ]
                                                            ]

                                                    _ ->
                                                        div
                                                            [ title <| "ID мережі " ++ String.fromInt networkId ]
                                                            [ text "Невідома мережа" ]
                                            )
                                            uniqueMessageNetworkIds

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
                                                [ text <|
                                                    Utils.Time.renderDistanceF1
                                                        ps.zone
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
                                    , HtmlX.viewIf Config.featureShowCallsignsMetadata <|
                                        div [ class "mb-1" ]
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
                        List.filterMap renderMedia message.media
                    )
                        :: metaFields
                        ++ [ Watermark.new ps.user.name |> Watermark.withPositioning ( 60, 80 ) |> Watermark.withFontSize "1.8rem" |> Watermark.view
                           , Watermark.new ps.user.name |> Watermark.withPositioning ( 15, 15 ) |> Watermark.withFontSize "1.8rem" |> Watermark.view
                           ]
                        ++ (case message.textMarked of
                                Just textMarked ->
                                    let
                                        -- Створюємо контекст для HintStrategy
                                        context =
                                            { networks = ps.networks
                                            , masterUnits = ps.masterUnits
                                            , callsignsInfo = ps.callsignsInfo
                                            }

                                        -- Створюємо message для HintStrategy
                                        messageForHints =
                                            { freq = message.freq
                                            , networkIds =
                                                if List.isEmpty ps.messageNetworkIds then
                                                    Nothing
                                                    -- Немає мережі → MessageContext не показує каталог

                                                else
                                                    Just uniqueMessageNetworkIds

                                            -- Є мережа → показуємо тільки мережеві підказки
                                            }

                                        callsignsForHints =
                                            let
                                                callsignsFromMarkedText =
                                                    textMarked
                                                        |> List.filterMap
                                                            (\contentNode ->
                                                                case contentNode of
                                                                    B.CnCallsignC callsignContent ->
                                                                        Just callsignContent.text

                                                                    _ ->
                                                                        Nothing
                                                            )
                                            in
                                            if List.isEmpty callsignsFromMarkedText then
                                                message.callsigns

                                            else
                                                callsignsFromMarkedText

                                        hintResultsDict =
                                            callsignsForHints
                                                |> List.foldl
                                                    (\callsign dict ->
                                                        let
                                                            -- Використовуємо нову HintStrategy з MessageContext
                                                            hintResult =
                                                                Core.Callsigns.HintStrategy.getCallsignHints
                                                                    Core.Callsigns.HintStrategy.MessageContext
                                                                    messageForHints
                                                                    context
                                                                    callsign
                                                        in
                                                        Dict.insert (String.toLower callsign) hintResult dict
                                                    )
                                                    Dict.empty
                                    in
                                    Shared.MarkedText.new textMarked
                                        |> Shared.MarkedText.viewWithHintResults hintResultsDict (Just ps.signals) (Dict.values ps.networks) message.freq message.text pointTokenClickUrl metadataLinks

                                Nothing ->
                                    Shared.MarkedText.fromPlainText message.text
                                        |> Shared.MarkedText.viewWithHintResults Dict.empty (Just ps.signals) (Dict.values ps.networks) message.freq message.text pointTokenClickUrl metadataLinks
                           )
                        ++ [ div
                                [ class "flex flex-col items-start gap-2 mt-2"
                                , style "color" "var(--bs-secondary-color)"
                                ]
                             <|
                                if not model.isDuplicate || model.isUnfolded then
                                    let
                                        ( tagIdsForRender, inboxTagsForRender, tagsForRender ) =
                                            if ps.onlyMyUnitTagsEnabled then
                                                case ( ps.user.organismId, message.inboxTags ) of
                                                    ( Just organismId, Just inboxTags ) ->
                                                        let
                                                            onlyMyUnitInboxTags =
                                                                inboxTags
                                                                    |> List.filter
                                                                        (\tag ->
                                                                            tag.organismId
                                                                                == Just organismId
                                                                                && MaybeX.isNothing tag.model
                                                                        )

                                                            onlyMyUnitTagIds =
                                                                onlyMyUnitInboxTags
                                                                    |> List.map .tagId
                                                                    |> ListX.unique
                                                        in
                                                        ( Just onlyMyUnitTagIds
                                                        , Just onlyMyUnitInboxTags
                                                        , ps.tags
                                                        )

                                                    _ ->
                                                        ( message.tags, message.inboxTags, ps.tags )

                                            else
                                                ( message.tags, message.inboxTags, ps.tags )
                                    in
                                    [ tagsBlock
                                        tagIdsForRender
                                        inboxTagsForRender
                                        (ForSelf << ToggleTag model.id)
                                        tagsForRender
                                    , case model.botTagAction of
                                        Just action ->
                                            if action.messageId == model.id then
                                                div
                                                    [ class "flex gap-2 items-center text-xs bg-[var(--color-card)] border border-[var(--color-border)] rounded px-3 py-2 shadow-sm" ]
                                                    [ button
                                                        [ type_ "button"
                                                        , class "btn btn-primary btn-sm"
                                                        , onClick <| ForSelf <| MarkBotTagWrong action.messageId action.tagId
                                                        ]
                                                        [ text "бот помилився" ]
                                                    , button
                                                        [ type_ "button"
                                                        , class "btn btn-outline-secondary btn-sm"
                                                        , onClick <| ForSelf CancelBotTagAction
                                                        ]
                                                        [ text "закрити" ]
                                                    ]

                                            else
                                                text ""

                                        Nothing ->
                                            text ""
                                    ]

                                else
                                    []
                           ]
                ]
               )
