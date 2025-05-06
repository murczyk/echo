module Pages.RerNetworks.Id_ exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Styled as Styled
import Json.Encode as Encode
import Layouts
import Le.Block.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Le.Block.Select
import Le.Block.Spinner
import Le.Block.Toast
import Le.NetworksUtils as EUtils
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Time
import Le.Types exposing (ApiError, GroupsActivityPerDayRsp, GroupsByDate)
import Le.Utils exposing (networkKindVHFMapping)
import Page exposing (Page)
import Route exposing (Route)
import Route.Path
import Select
import Shared
import Time
import Time.Extra
import View exposing (View)


page : Auth.User -> Shared.Model -> Route { id : String } -> Page Model Msg
page user shared route =
    Page.new
        { init = init route shared
        , update = update shared
        , subscriptions = subscriptions
        , view = view shared
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "rer"
        }



-- INIT


type Mode
    = Readonly
    | Editing B.UpdateNetworkReq


type alias Model =
    { network : RemoteData ApiError B.Network
    , callsigns : RemoteData ApiError (List B.CallsignRes)
    , mapPoints : RemoteData ApiError (List B.NetworkPoint)
    , groupsActivity : RemoteData ApiError GroupsByDate
    , freqs : RemoteData ApiError (List B.NetworkFreqsRes)
    , callsignsOpenedPopupId : Maybe String
    , formErrors : Dict String String
    , toasts : Le.Block.Toast.Model
    , networks : RemoteData ApiError (Dict Int B.Network)
    , mode : Mode
    , editKindSelect : Le.Block.Select.SelectTypeSingleNotEmpty EUtils.NetworkKind
    , editPostsSelect : Le.Block.Select.SelectType Int
    }


init : Route { id : String } -> Shared.Model -> () -> ( Model, Effect Msg )
init route shared () =
    ( { network = Loading
      , callsigns = NotAsked
      , mapPoints = NotAsked
      , groupsActivity = NotAsked
      , freqs = NotAsked
      , callsignsOpenedPopupId = Nothing
      , toasts = Le.Block.Toast.init
      , formErrors = Dict.empty
      , networks = NotAsked
      , mode = Readonly
      , editKindSelect =
            { state = Select.initState (Select.selectIdentifier "edit-network-kind-state")
            , items =
                EUtils.networkKinds
                    |> List.map
                        (\kind ->
                            Select.basicMenuItem
                                { item = kind
                                , label = EUtils.networkKindToLabel kind
                                }
                        )
            , selected = EUtils.VHF
            }
      , editPostsSelect =
            { state = Select.initState (Select.selectIdentifier "edit-network-posts-state")
            , items = []
            , selected = []
            }
      }
    , case String.toInt route.params.id of
        Just id ->
            E.getSingleNetwork NetworkReturnedByApi id

        Nothing ->
            E.none
    )



-- UPDATE


type Msg
    = ToastMsg Le.Block.Toast.Msg
    | CallsignsReturnedByApi (Result ApiError B.SingleNetworkCallsignsListRsp)
    | NetworkReturnedByApi (Result ApiError B.Network)
    | MapPointsReturnedByApi (Result ApiError B.ListNetworkPointsRsp)
    | GroupsActivityReturnedByApi (Result ApiError GroupsByDate)
    | FreqsReturnedByApi (Result ApiError B.SingleNetworkFreqsListRsp)
    | CallsignsPopupOpenedByUser String
    | CallsignsPopupClosedByUser
    | NetworksReturnedByApi (Result ApiError (List B.Network))
    | NetworkEditStartedByUser
    | NetworkEditingSavedByUser
    | NetworkEditingMsg B.UpdateNetworkReq
    | NetworkUpdatedByApi (Result ApiError B.Network)
    | NetworkPostsUpdatedByApi B.UpdateNetworkReq (Result ApiError B.Network)
    | EditNetworkKindSelMsg (Select.Msg EUtils.NetworkKind)
    | NetworkEditPostsSelMsg (Select.Msg Int)


update : Shared.Model -> Msg -> Model -> ( Model, Effect Msg )
update shared msg model =
    case msg of
        ToastMsg imsg ->
            let
                ( im, icmds ) =
                    Le.Block.Toast.update imsg model.toasts
            in
            ( { model | toasts = im }
            , E.sendCmd <| Cmd.map ToastMsg icmds
            )

        CallsignsReturnedByApi (Err e) ->
            Api.handleHttpError ToastMsg e { model | callsigns = Failure e }

        CallsignsReturnedByApi (Ok res) ->
            ( { model | callsigns = Success res.callsigns }, E.none )

        NetworkReturnedByApi (Err e) ->
            Api.handleHttpError ToastMsg e { model | network = Failure e }

        NetworkReturnedByApi (Ok res) ->
            let
                kindSelect =
                    model.editKindSelect

                postsSelect =
                    model.editPostsSelect

                kindSelect2 =
                    { kindSelect | selected = EUtils.networkKindFromString res.kind }

                postsSelect2 =
                    { postsSelect | selected = res.postIds }
            in
            ( { model | network = Success res, editKindSelect = kindSelect2, editPostsSelect = postsSelect2 }
            , E.batch
                [ E.getNetworkCallsigns CallsignsReturnedByApi { networkId = res.id }
                , E.getNetworkPoints MapPointsReturnedByApi
                    { networkId = res.id
                    , sinceDateInclusiveMs = res.activeFrom
                    , tillDateNoninclusiveMs = res.activeTo
                    }
                , E.getSingleNetworkGroupsActivity GroupsActivityReturnedByApi { networkId = res.id, tillDateNoninclusiveMs = Nothing }
                , E.getSingleNetworkFreqs FreqsReturnedByApi { networkId = res.id }
                , E.getNetworksList NetworksReturnedByApi
                    { sinceDateInclusiveMs = Just res.activeFrom
                    , tillDateNoninclusiveMs = res.activeTo
                    , filterFreq = Nothing
                    , filterUnit = Nothing
                    , sortBy = Nothing
                    }

                --TODO: do not load if loaded already
                , E.loadPostsFromShared { sortBy = Nothing }
                ]
            )

        MapPointsReturnedByApi (Err e) ->
            Api.handleHttpError ToastMsg e { model | mapPoints = Failure e }

        MapPointsReturnedByApi (Ok res) ->
            ( { model | mapPoints = Success res.points }, E.none )

        GroupsActivityReturnedByApi (Err e) ->
            Api.handleHttpError ToastMsg e { model | groupsActivity = Failure e }

        GroupsActivityReturnedByApi (Ok res) ->
            ( { model | groupsActivity = Success res }, E.none )

        FreqsReturnedByApi (Err e) ->
            Api.handleHttpError ToastMsg e { model | freqs = Failure e }

        FreqsReturnedByApi (Ok res) ->
            let
                callsigns =
                    List.filterMap .callsigns res.freqs
                        |> List.concat
            in
            ( { model | freqs = Success res.freqs }, E.getCallsignsInfoShared callsigns )

        CallsignsPopupOpenedByUser freq ->
            ( { model | callsignsOpenedPopupId = Just freq }, E.none )

        CallsignsPopupClosedByUser ->
            ( { model | callsignsOpenedPopupId = Nothing }, E.none )

        NetworksReturnedByApi (Err err) ->
            ( model, E.none )

        NetworksReturnedByApi (Ok networks) ->
            ( { model
                | networks =
                    Success
                        (networks
                            |> List.map (\x -> ( x.id, x ))
                            |> Dict.fromList
                        )
              }
            , E.none
            )

        NetworkEditStartedByUser ->
            case model.network of
                Success network ->
                    ( { model
                        | mode =
                            Editing
                                { id = network.id
                                , kind = network.kind
                                , name = network.name
                                , location = network.location
                                , comment = network.comment
                                , radioStation = network.radioStation
                                , confirmation = network.confirmation
                                , purpose = network.purpose
                                , operationMode = network.operationMode
                                , operationType = network.operationType
                                , operationPeriod = network.operationPeriod
                                , signs = network.signs
                                , activeFrom = network.activeFrom
                                , activeTo = network.activeTo
                                , modulationId = network.modulationId
                                }
                      }
                    , E.none
                    )

                _ ->
                    ( model, E.none )

        NetworkEditingSavedByUser ->
            case model.mode of
                Editing edit ->
                    ( model, E.updateNetworkPosts (NetworkPostsUpdatedByApi edit) { networkId = edit.id, postIds = model.editPostsSelect.selected } )

                Readonly ->
                    ( model, E.none )

        NetworkEditingMsg updNetworkReq ->
            ( { model
                | mode =
                    case model.mode of
                        Editing _ ->
                            Editing updNetworkReq

                        Readonly ->
                            Readonly
              }
            , E.none
            )

        NetworkPostsUpdatedByApi _ (Err e) ->
            Api.handleHttpError ToastMsg e model

        NetworkPostsUpdatedByApi editState (Ok _) ->
            ( model, E.updateNetwork NetworkUpdatedByApi editState )

        NetworkUpdatedByApi (Err e) ->
            Api.handleHttpError ToastMsg e model

        NetworkUpdatedByApi (Ok network) ->
            ( { model | network = Success network, mode = Readonly }, E.none )

        EditNetworkKindSelMsg imsg ->
            case model.mode of
                Editing updNetworkReq ->
                    let
                        ( mAct, imodel, icmd ) =
                            Select.update imsg model.editKindSelect.state

                        updatedNetworkKind =
                            Le.Block.Select.singleUpdWithDefault mAct model.editKindSelect.selected

                        kindSelect =
                            model.editKindSelect

                        kindSelect2 =
                            { kindSelect
                                | state = imodel
                                , selected = updatedNetworkKind
                            }
                    in
                    ( { model
                        | editKindSelect = kindSelect2
                        , mode = Editing { updNetworkReq | kind = EUtils.networkKindToString updatedNetworkKind }
                      }
                    , E.sendCmd <|
                        Cmd.map
                            EditNetworkKindSelMsg
                            icmd
                    )

                _ ->
                    ( model
                    , E.none
                    )

        NetworkEditPostsSelMsg imsg ->
            case model.mode of
                Editing editNetworkState ->
                    let
                        ( mAct, imodel, icmd ) =
                            Select.update imsg model.editPostsSelect.state

                        updatedNetworkPosts =
                            Le.Block.Select.multiUpdI mAct model.editPostsSelect.selected

                        postsSelect =
                            model.editPostsSelect

                        --TODO: remove this hack
                        items =
                            case ( postsSelect.items, shared.posts ) of
                                ( [], Success posts ) ->
                                    if List.length (Dict.toList posts) > 0 then
                                        List.map (\post -> Select.basicMenuItem { item = post.id, label = post.name }) (Dict.values posts)

                                    else
                                        postsSelect.items

                                _ ->
                                    postsSelect.items

                        postsSelect2 =
                            { postsSelect
                                | state = imodel
                                , selected = updatedNetworkPosts
                                , items = items
                            }

                        network =
                            model.network

                        n2 =
                            case network of
                                Success n ->
                                    Success { n | postIds = updatedNetworkPosts }

                                _ ->
                                    network
                    in
                    ( { model
                        | editPostsSelect = postsSelect2
                        , mode = Editing editNetworkState
                        , network = n2
                      }
                    , E.sendCmd <|
                        Cmd.map
                            NetworkEditPostsSelMsg
                            icmd
                    )

                _ ->
                    ( model, E.none )



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none



-- VIEW


mainInfoBlock : B.Network -> Shared.Model -> Model -> List (Html Msg)
mainInfoBlock network shared model =
    [ h5 [ class "mb-[8px]" ]
        [ text "Форма № 1.5.4/ГУР" ]
    , div
        [ class "network-list-container" ]
        [ div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%]" ] [ text "Район функціонування/розгортання:" ]
            , span [] [ text network.location ]
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium  basis-[33%]" ] [ text "Призначення:" ]
            , span [] [ text <| Maybe.withDefault "" network.purpose ]
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Склад кореспондентів:" ]
            , span [] [ RD.withDefault [] model.callsigns |> List.length |> String.fromInt |> text ]
            ]
        , div [ class "border-t-1 border-border py-[8px] flex h-[52px]! " ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Вид передачі:" ]
            , span [] [ text <| networkKindVHFMapping network.kind ]
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Режим роботи радіомережі:" ]
            , span [] [ text <| Maybe.withDefault "" network.operationMode ]
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Характер роботи:" ]
            , span [] [ text <| Maybe.withDefault "" network.operationType ]
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Період функціонування:" ]
            , span [] [ text <| Maybe.withDefault "" network.operationPeriod ]
            ]
        ]
    , div [ class "mt-[8px]" ]
        [ h5 [] [ text "Додаткове" ]
        , div [ class "grid grid-cols-12 gap-[16px]" ]
            [ div [ class "col-span-2" ]
                [ span [ class "text-[13px] font-medium" ] [ text "Активна з:" ]
                , div []
                    [ text <|
                        Le.Time.renderDateF6 shared.timeZone
                            (Time.millisToPosix network.activeFrom)
                    ]
                ]
            , div [ class "col-span-2" ]
                [ span [ class "text-[13px] font-medium" ] [ text "Активна по:" ]
                , div []
                    [ case network.activeTo of
                        Just millis ->
                            Le.Time.renderDateF6 shared.timeZone
                                (Time.millisToPosix millis)
                                |> text

                        Nothing ->
                            text ""
                    ]
                ]
            , div [ class "col-span-8" ]
                [ span [ class "text-[13px] font-medium" ] [ text "Пости:" ]
                , div [ class "" ]
                    [ case shared.posts of
                        Success posts ->
                            List.map (\postId -> Dict.get postId posts) network.postIds
                                |> List.filterMap identity
                                |> List.map .name
                                |> String.join ", "
                                |> text

                        _ ->
                            text ""
                    ]
                ]
            ]
        ]
    ]


mainInfoEditBlock : B.UpdateNetworkReq -> Shared.Model -> Model -> List (Html Msg)
mainInfoEditBlock updNetworkReq shared model =
    [ h5 [ class "mb-[8px]" ]
        [ text "Форма № 1.5.4/ГУР" ]
    , div
        [ class "network-list-container" ]
        [ div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%]" ] [ text "Район функціонування/розгортання:" ]
            , input
                [ value <| updNetworkReq.location
                , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | location = v })
                , class "form__field"
                , placeholder "введіть район функціонування/розгортання"
                ]
                []
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium  basis-[33%]" ] [ text "Призначення:" ]
            , input
                [ value <| Maybe.withDefault "" updNetworkReq.purpose
                , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | purpose = Just v })
                , class "form__field"
                , placeholder "введіть призначення"
                ]
                []
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Склад кореспондентів:" ]
            , span [] [ RD.withDefault [] model.callsigns |> List.length |> String.fromInt |> text ]
            ]
        , div [ class "border-t-1 border-border py-[8px] flex h-[52px]! " ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Вид передачі:" ]
            , let
                selectedItem =
                    (\item ->
                        Select.basicMenuItem
                            { item = item
                            , label =
                                EUtils.networkKindToLabel item
                            }
                    )
                        model.editKindSelect.selected

                defaultOptions =
                    Le.Block.Select.defaultOptions shared.isDarkMode

                do2 =
                    { defaultOptions | clearable = False }
              in
              Html.map EditNetworkKindSelMsg <|
                Styled.toUnstyled <|
                    Le.Block.Select.renderSelectSingle
                        (Just selectedItem)
                        model.editKindSelect.state
                        model.editKindSelect.items
                        "жоден"
                        do2
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Режим роботи радіомережі:" ]
            , input
                [ value <| Maybe.withDefault "" updNetworkReq.operationMode
                , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | operationMode = Just v })
                , class "form__field"
                , placeholder "введіть режим роботи радіомережі"
                ]
                []
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Характер роботи:" ]
            , input
                [ value <| Maybe.withDefault "" updNetworkReq.operationType
                , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | operationType = Just v })
                , class "form__field"
                , placeholder "введіть хараткет роботи"
                ]
                []
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Період функціонування:" ]
            , input
                [ value <| Maybe.withDefault "" updNetworkReq.operationPeriod
                , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | operationPeriod = Just v })
                , class "form__field"
                , placeholder "введіть період функціонування"
                ]
                []
            ]
        ]
    , div [ class "mt-[8px]" ]
        [ h5 [] [ text "Додаткове" ]
        , div [ class "grid grid-cols-12 gap-[16px]" ]
            [ div [ class "col-span-2" ]
                [ span [ class "text-[13px] font-medium" ] [ text "Активна з:" ]
                , input
                    [ type_ "date"
                    , class "form-control"
                    , Time.millisToPosix updNetworkReq.activeFrom
                        |> Le.Time.renderDateF4 shared.timeZone
                        |> value
                    , onInput <|
                        NetworkEditingMsg
                            << (\v ->
                                    { updNetworkReq
                                        | activeFrom =
                                            case Le.Time.parseDateParts v of
                                                Err _ ->
                                                    updNetworkReq.activeFrom

                                                Ok parts ->
                                                    Time.Extra.partsToPosix shared.timeZone parts
                                                        |> Time.posixToMillis
                                    }
                               )
                    ]
                    []
                ]
            , div [ class "col-span-2" ]
                [ span [ class "text-[13px] font-medium" ] [ text "Активна по:" ]
                , input
                    [ type_ "date"
                    , class "form-control"
                    , case updNetworkReq.activeTo of
                        Just millis ->
                            value <| Le.Time.renderDateF4 shared.timeZone <| Time.millisToPosix millis

                        Nothing ->
                            value ""
                    , onInput <|
                        NetworkEditingMsg
                            << (\v ->
                                    { updNetworkReq
                                        | activeTo =
                                            case Le.Time.parseDateParts v of
                                                Err _ ->
                                                    updNetworkReq.activeTo

                                                Ok parts ->
                                                    Time.Extra.partsToPosix shared.timeZone parts
                                                        |> Time.posixToMillis
                                                        |> Just
                                    }
                               )
                    ]
                    []
                ]
            , div [ class "col-span-8" ]
                [ label [ class "text-[13px] font-medium" ] [ text "Пости:" ]
                , let
                    selectedItems =
                        List.map
                            (\postId ->
                                Select.basicMenuItem
                                    { item = postId
                                    , label =
                                        RD.withDefault Dict.empty shared.posts
                                            |> Dict.get postId
                                            |> Maybe.map .name
                                            |> Maybe.withDefault ""
                                    }
                            )
                            model.editPostsSelect.selected

                    defaultOptions =
                        Le.Block.Select.defaultOptions shared.isDarkMode

                    do2 =
                        { defaultOptions | clearable = False }
                  in
                  Html.map NetworkEditPostsSelMsg <|
                    Styled.toUnstyled <|
                        Le.Block.Select.renderSelect
                            selectedItems
                            model.editPostsSelect.state
                            model.editPostsSelect.items
                            "жоден"
                            do2
                ]
            ]
        ]
    ]


contentBlock : Shared.Model -> B.Network -> Model -> List (Html Msg)
contentBlock shared network model =
    [ div [ class "flex justify-between items-center" ]
        [ h2 []
            [ EUtils.renderNetworkNameWithoutType network (RD.withDefault Dict.empty shared.masterUnits)
            ]
        , case model.mode of
            Readonly ->
                i [ class "bi bi-pencil-square text-action cursor-pointer text-[20px]", onClick NetworkEditStartedByUser ] []

            Editing _ ->
                i [ class "bi bi-check-square text-action cursor-pointer text-[20px]", onClick NetworkEditingSavedByUser ] []
        ]
    , div [ class "grid grid-cols-12 gap-[30px]" ]
        [ div [ class "col-span-8 grid  gap-[30px]", style "grid-template-rows" "460px 320px" ]
            [ div [ class "col-span-8 bg-w dark:bg-[#1C1C21] p-[16px]" ]
                (case model.mode of
                    Readonly ->
                        mainInfoBlock network shared model

                    Editing eNetwork ->
                        mainInfoEditBlock eNetwork shared model
                )
            , div [ class "row-start-2 bg-w dark:bg-[#1C1C21] col-start-1 col-end-9 p-[16px] flex flex-col" ]
                [ h4 [ class "" ] [ text "Частоти" ]
                , case model.freqs of
                    Success freqs ->
                        div [ class "overflow-y-auto grow-1" ]
                            [ table [ class "table-fixed w-full" ]
                                [ thead [ class "text-[13px]/[110%] font-medium" ]
                                    [ tr [ class "" ]
                                        [ th [] [ text "Частота" ]
                                        , th [] [ text "Модуляція" ]
                                        , th [] [ text "Кількість перехоплень" ]
                                        , th [] [ text "Позивні" ]
                                        , th [] [ text "Останній раз в етері" ]
                                        , th [] [ text "Дата прив'язки" ]
                                        ]
                                    ]
                                , tbody []
                                    (List.map
                                        (\freq ->
                                            tr [ class "" ]
                                                [ td [] [ text freq.freq ]
                                                , td [] [ text <| Maybe.withDefault "" freq.modulation ]
                                                , td [] [ text <| String.fromInt freq.messageCount ]
                                                , case freq.callsigns of
                                                    Just callsigns ->
                                                        let
                                                            isOpen =
                                                                case model.callsignsOpenedPopupId of
                                                                    Just openCallsignsPopup ->
                                                                        openCallsignsPopup == freq.freq

                                                                    Nothing ->
                                                                        False
                                                        in
                                                        CallsignsPopup.view
                                                            { isOpened = isOpen
                                                            , onClose = CallsignsPopupClosedByUser
                                                            , onOpen = CallsignsPopupOpenedByUser freq.freq
                                                            , callsigns = callsigns
                                                            , callsignsInfo = shared.callsignsInfo
                                                            , masterUnits = RD.withDefault Dict.empty shared.masterUnits
                                                            }
                                                            (FreqsPage
                                                                freq.freq
                                                                (RD.withDefault Dict.empty model.networks)
                                                            )

                                                    _ ->
                                                        text ""
                                                , td []
                                                    [ case freq.lastDatetime of
                                                        Just lastDatetime ->
                                                            text <|
                                                                Le.Time.renderDateF6 shared.timeZone
                                                                    (Time.millisToPosix lastDatetime)

                                                        Nothing ->
                                                            text ""
                                                    ]
                                                , td []
                                                    [ text <|
                                                        Le.Time.renderDateF6 shared.timeZone
                                                            (Time.millisToPosix freq.createdAt)
                                                    ]
                                                ]
                                        )
                                        freqs
                                    )
                                ]
                            ]

                    _ ->
                        Le.Block.Spinner.loadingSpinnerSm
                ]
            ]
        , div [ class "col-span-4 bg-w dark:bg-[#1C1C21] p-[16px]" ]
            [ div [ class "mb-[16px]" ]
                [ h5 [ class "border-b-1 border-border py-[8px]" ] [ text "Обґрунтування прив’язки" ]
                , div [ class "py-[4px] min-h-[200px]" ]
                    [ case model.mode of
                        Readonly ->
                            text <| Maybe.withDefault "" network.confirmation

                        Editing updNetworkReq ->
                            textarea
                                [ value <| Maybe.withDefault "" updNetworkReq.confirmation
                                , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | confirmation = Just v })
                                , class "form__field"
                                , placeholder "введіть обґрунтування прив'язки"
                                ]
                                []
                    ]
                ]
            , div []
                [ h5 [ class "border-b-1 border-border py-[8px]" ] [ text "Розвідувальні ознаки" ]
                , div [ class "py-[4px] min-h-[200px]" ]
                    [ case model.mode of
                        Readonly ->
                            text <| Maybe.withDefault "" network.signs

                        Editing updNetworkReq ->
                            textarea
                                [ value <| Maybe.withDefault "" updNetworkReq.signs
                                , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | signs = Just v })
                                , class "form__field"
                                , placeholder "введіть розвідувальні ознаки"
                                ]
                                []
                    ]
                ]
            ]
        ]
    , div [ class "bg-w dark:bg-[#1C1C21] w-full h-[500px] mt-[30px] p-[16px] flex flex-col" ]
        [ h4 [ class "" ] [ text "Позивні" ]
        , case model.callsigns of
            Success callsigns ->
                div [ class "overflow-y-auto  grow-1" ]
                    [ let
                        renderCallsignMainRow :
                            { callsign : String
                            , knownCallsigns : List B.KnownCallsignShortRes
                            , messageCount : Int
                            , lastDatetime : Maybe Int
                            , freqs : Maybe (List String)
                            , networkNames : Maybe (List String)
                            , isOld : Bool
                            }
                            -> List (Html Msg)
                        renderCallsignMainRow callsign =
                            let
                                rowCount =
                                    List.length callsign.knownCallsigns
                            in
                            case callsign.knownCallsigns of
                                x :: xs ->
                                    tr [ class "" ]
                                        [ td [ rowspan rowCount ] [ text <| String.toUpper callsign.callsign ]
                                        , td [ rowspan rowCount ] [ text <| String.fromInt callsign.messageCount ]
                                        , td [ rowspan rowCount ]
                                            [ case callsign.lastDatetime of
                                                Just lastDatetime ->
                                                    text <|
                                                        Le.Time.renderDateF6 shared.timeZone
                                                            (Time.millisToPosix lastDatetime)

                                                Nothing ->
                                                    text ""
                                            ]
                                        , td [] [ text x.position ]
                                        , td [] [ text x.unitName ]
                                        , td [] [ text x.comment ]
                                        , td [] [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix x.createdAt) ]
                                        , td [] [ text <| x.sourceName ]
                                        ]
                                        :: List.map
                                            (\knownCallsign ->
                                                tr []
                                                    [ td [] [ text knownCallsign.position ]
                                                    , td [] [ text knownCallsign.unitName ]
                                                    , td [] [ text knownCallsign.comment ]
                                                    , td [] [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix x.createdAt) ]
                                                    , td [] [ text <| knownCallsign.sourceName ]
                                                    ]
                                            )
                                            xs

                                [] ->
                                    [ text "" ]

                        ( callsignsWithUnits, callsignsUnknown ) =
                            callsigns
                                |> List.partition
                                    (\callsign ->
                                        case callsign.knownCallsigns of
                                            Just _ ->
                                                True

                                            Nothing ->
                                                False
                                    )

                        callsignsWithUnits2 =
                            List.map
                                (\callsign ->
                                    { knownCallsigns = Maybe.withDefault [] callsign.knownCallsigns
                                    , callsign = callsign.callsign
                                    , messageCount = callsign.messageCount
                                    , lastDatetime = callsign.lastDatetime
                                    , freqs = callsign.freqs
                                    , networkNames = callsign.networkNames
                                    , isOld = callsign.isOld
                                    }
                                )
                                callsignsWithUnits
                      in
                      table [ class "table-fixed w-full" ]
                        [ thead [ class "text-[13px]/[110%] font-medium sticky bg-w dark:bg-[#1C1C21]", style "inset-block-start" "0" ]
                            [ tr [ class "" ]
                                [ th [ class "w-[10%]" ] [ text "Позивний" ]
                                , th [ class "w-[7%]" ] [ text "Кількість перехоплень з позивним" ]
                                , th [ class "w-[10%]" ] [ text "Останній раз в етері" ]
                                , th [ class "w-[22%]" ] [ text "Посада" ]
                                , th [ class "w-[14%]" ] [ text "Підрозділ" ]
                                , th [ class "w-[19%]" ] [ text "Коментар" ]
                                , th [ class "w-[10%]" ] [ text "Дата прив'язки" ]
                                , th [ class "w-[8%]" ] [ text "Джерело" ]
                                ]
                            ]
                        , tbody []
                            (List.concatMap
                                (\callsign ->
                                    renderCallsignMainRow callsign
                                )
                                callsignsWithUnits2
                            )
                        , tfoot []
                            [ tr []
                                [ td [ colspan 8 ]
                                    [ span [ class "font-medium" ] [ text "Приналежність встановлюється: " ]
                                    , div [ class "flex flex-wrap gap-[4px]" ] (List.map (\c -> span [] [ text <| String.toUpper c.callsign ]) callsignsUnknown)
                                    ]
                                ]
                            ]
                        ]
                    ]

            _ ->
                Le.Block.Spinner.loadingSpinnerSm
        ]
    , section [ class "grid grid-cols-12 gap-[30px] h-[300px] mt-[30px]" ]
        [ div [ class "col-span-6 bg-w dark:bg-[#1C1C21] p-[16px] flex flex-col" ]
            [ h4 [] [ text "Пеленги" ]
            , let
                mapPoints =
                    case model.mapPoints of
                        Success points ->
                            points

                        _ ->
                            []
              in
              if List.length mapPoints > 0 then
                Html.node "small-map"
                    [ property "points" (Encode.list B.networkPointEncoder mapPoints)
                    , class "grow-1"
                    , property "withExitButton" (Encode.bool False)
                    ]
                    []

              else
                div [ class "grow-1 flex justify-center items-center" ] [ text "Пеленги відсутні" ]
            ]
        , div [ class "col-span-4 bg-w dark:bg-[#1C1C21] p-[16px] flex flex-col" ]
            [ h4 [] [ text "Активність мережі" ]
            , section [ class "grow-1" ]
                [ case model.groupsActivity of
                    Success data ->
                        let
                            groupsMessageCountByDayJson =
                                data |> Encode.dict identity (Encode.dict identity Encode.int)
                        in
                        Html.node "bar-chart"
                            [ property "data" <| groupsMessageCountByDayJson
                            , property "last-day" <| Encode.int shared.now
                            , class "block"
                            ]
                            []

                    _ ->
                        Le.Block.Spinner.loadingSpinnerSm
                ]
            ]
        , let
            updatedAtString =
                Le.Time.renderDateF6 shared.timeZone
                    (Time.millisToPosix network.lastUpdatedAt)

            updatedByString =
                Maybe.withDefault "невідомий" network.lastUpdatedBy

            createdAtString =
                Le.Time.renderDateF6 shared.timeZone
                    (Time.millisToPosix network.createdAt)
          in
          div [ class "col-span-2 bg-w dark:bg-[#1C1C21] p-[16px]" ]
            [ section []
                [ div [ style "padding-left" "4px", title ("Прив'язку створено " ++ createdAtString) ]
                    [ i [ class "bi bi-calendar-date" ]
                        []
                    , text <|
                        " "
                            ++ createdAtString
                    ]
                , div [ style "padding-left" "4px", title ("Востаннє прив'язка редагована " ++ updatedAtString ++ " користувачем " ++ updatedByString) ]
                    [ i [ class "bi bi-pencil-square" ] []
                    , text (" " ++ updatedAtString ++ " (" ++ updatedByString ++ ")")
                    ]
                ]
            ]
        ]
    ]


view : Shared.Model -> Model -> View Msg
view shared model =
    { title = "Мережа"
    , body =
        [ div []
            [ Le.Block.Toast.view ToastMsg model.toasts <|
                div [ class "bg-[#F5F7F9] dark:bg-[#0E0E11] rer-network min-h-sceen" ]
                    [ div [ class "w-[75vw] mx-auto py-[16px]" ]
                        (case model.network of
                            Success network ->
                                contentBlock shared network model

                            _ ->
                                [ div [ class "h-full" ] [ Le.Block.Spinner.loadingSpinner ] ]
                        )
                    ]
            ]
        ]
    }
