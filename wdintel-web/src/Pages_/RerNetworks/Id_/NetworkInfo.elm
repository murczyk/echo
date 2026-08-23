module Pages_.RerNetworks.Id_.NetworkInfo exposing (view)

import Auth
import Bindings as B
import Core.Auth
import Dict
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Styled as Styled
import Json.Encode as Encode
import Pages_.RerNetworks.Id_.Model exposing (Mode(..), Model)
import Pages_.RerNetworks.Id_.Msg exposing (Msg(..))
import Select
import Set
import Shared
import Shared.Components.Spinner
import Shared.Model exposing (isDarkMode)
import Time
import Utils.NetworksUtils as NetworksUtils
import Utils.RemoteData as RD exposing (RemoteData(..))
import Utils.Select
import Utils.Time


view : B.Network -> Model -> Auth.User -> Shared.Model -> List (Html Msg)
view network model user shared =
    [ div [ class "bg-w dark:bg-[#1C1C21] p-[16px]" ]
        (case ( model.mode, Core.Auth.hasRole "Admin" user || Core.Auth.hasRole "UnitsEditor" user ) of
            ( Editing eNetwork, True ) ->
                viewNetworkInfoForm eNetwork network network.freqs shared model

            _ ->
                viewNetworkInfoReadonly user network shared model
        )
    , div [ class "bg-w dark:bg-[#1C1C21] p-[16px]" ] <|
        activityBlock shared model
    , div [ class "bg-w dark:bg-[#1C1C21] p-[16px] flex flex-col" ]
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
                , class "flex-1 min-h-[180px]"
                , property "withExitButton" (Encode.bool False)
                ]
                []

          else
            div [ class "py-8 flex justify-center items-center text-[var(--color-text-muted)]" ] [ text "Пеленги відсутні" ]
        ]
    ]


networkStatusLabel : B.NetworkStatus -> String
networkStatusLabel status =
    case status of
        B.NetworkActive ->
            "Активна"

        B.NetworkInactive ->
            "Неактивна"


networkStatusFromValue : String -> B.NetworkStatus
networkStatusFromValue value =
    if value == "inactive" then
        B.NetworkInactive

    else
        B.NetworkActive


activityBlock : Shared.Model -> Model -> List (Html Msg)
activityBlock shared model =
    [ div [ class "flex flex-wrap justify-between items-center gap-2" ]
        [ h5 [] [ text "Активність мережі" ]
        , div [ class "flex items-center gap-2" ]
            [ span [ class "text-xs opacity-70" ] [ text "Днів:" ]
            , div
                [ class "inline-flex gap-1"
                , attribute "role" "radiogroup"
                , attribute "aria-label" "Період активності мережі"
                ]
                (List.map (activityPeriodPill model.groupsActivityPeriod) activityPeriods)
            ]
        ]
    , div [ class "space-y-4" ]
        [ div [ class "mb-2" ]
            [ span [ class "opacity-70 text-sm" ]
                [ text ("Графік активності мережі за " ++ String.fromInt (activityPeriodDays model.groupsActivityPeriod) ++ " днів") ]
            ]
        , div [ class "h-[200px]" ]
            [ case model.groupsActivity of
                Success data ->
                    let
                        groupsMessageCountByDayJson =
                            data |> Encode.dict identity (Encode.dict identity Encode.int)
                    in
                    Html.node "bar-chart"
                        [ property "data" <| groupsMessageCountByDayJson
                        , property "last-day" <| Encode.int shared.now
                        , property "days" <| Encode.int (activityPeriodDays model.groupsActivityPeriod)
                        , class "block"
                        ]
                        []

                _ ->
                    Shared.Components.Spinner.loadingSpinnerSm
            ]
        ]
    ]


activityPeriods : List B.NetworkGroupActivityPeriod
activityPeriods =
    [ B.Last10Days, B.Last30Days, B.Last60Days ]


activityPeriodPill : B.NetworkGroupActivityPeriod -> B.NetworkGroupActivityPeriod -> Html Msg
activityPeriodPill selectedPeriod period =
    let
        isSelected =
            selectedPeriod == period

        colors =
            if isSelected then
                [ style "background-color" "var(--action-color)"
                , style "border-color" "var(--action-color)"
                , style "color" "var(--button-text-color)"
                ]

            else
                [ style "background-color" "transparent"
                , style "border-color" "var(--border-color)"
                , style "color" "var(--text-color)"
                ]
    in
    button
        ([ type_ "button"
         , class "min-w-8 px-2 py-1 rounded-full border text-xs font-medium transition-colors"
         , attribute "role" "radio"
         , attribute "aria-checked"
            (if isSelected then
                "true"

             else
                "false"
            )
         , onClick (GroupsActivityPeriodChangedByUser period)
         ]
            ++ colors
        )
        [ text (String.fromInt (activityPeriodDays period)) ]


activityPeriodDays : B.NetworkGroupActivityPeriod -> Int
activityPeriodDays period =
    case period of
        B.Last10Days ->
            10

        B.Last30Days ->
            30

        B.Last60Days ->
            60


createActivityStr : Maybe Int -> Maybe Int -> Time.Zone -> String
createActivityStr mActiveFrom mActiveTo timeZone =
    let
        fromStr =
            case mActiveFrom of
                Just activeFrom ->
                    Utils.Time.renderDateF6 timeZone (Time.millisToPosix activeFrom)

                Nothing ->
                    "Помилка"

        toStr =
            case mActiveTo of
                Just millis ->
                    Utils.Time.renderDateF6 timeZone (Time.millisToPosix millis)

                Nothing ->
                    "Досі"
    in
    fromStr ++ " - " ++ toStr


viewNetworkInfoReadonly : Auth.User -> B.Network -> Shared.Model -> Model -> List (Html Msg)
viewNetworkInfoReadonly user network shared model =
    [ div [ class "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 items-start" ]
        [ div [ class "min-w-0 space-y-1.5" ]
            [ if Core.Auth.hasRole "UnitsEditor" user then
                infoRow shared "Смуги" (aorNames network model.aorList)

              else
                infoRow shared "Назва" (text network.name)
            , if Core.Auth.hasRole "UnitsEditor" user then
                infoRow shared "Назва" (text network.name)

              else
                text ""
            , infoRow shared "Підрозділи" (unitNames shared network.unitIds)
            , infoRow shared "Район функціонування/розгортання" (text network.location)
            , infoRow shared "Призначення" (text <| Maybe.withDefault "" network.purpose)
            , infoRow shared "Склад кореспондентів" (text <| String.fromInt (List.length (RD.withDefault [] model.callsigns)))
            , infoRow shared "Вид передачі" (text <| freqKinds network.freqs)
            , infoRow shared "Режим роботи радіомережі" (text <| Maybe.withDefault "" network.operationMode)
            , infoRow shared "Характер роботи" (text <| Maybe.withDefault "" network.operationType)
            , infoRow shared "Період функціонування" (text <| Maybe.withDefault "" network.operationPeriod)
            , infoRow shared "Активність" (text <| createActivityStr network.activeFrom network.activeTo shared.timeZone)
            , infoRow shared "Пости" (postNames shared network.postIds)
            , infoRow shared "Радіостанція" (text <| Maybe.withDefault "" network.radioStation)
            , infoRow shared "Статус" (text (networkStatusLabel network.status))
            ]
        , if Core.Auth.hasRole "Admin" user || Core.Auth.hasRole "UnitsEditor" user then
            button
                [ class "shrink-0 p-1 rounded-md transition-colors duration-200 text-action hover:bg-[var(--color-bg-muted)]"
                , onClick NetworkEditStartedByUser
                , title "Редагувати"
                ]
                [ i [ class "bi bi-pencil-square text-[20px]" ] [] ]

          else
            text ""
        ]
    ]


infoRow : Shared.Model -> String -> Html Msg -> Html Msg
infoRow _ label value =
    div [ class "grid grid-cols-[180px_minmax(0,1fr)] gap-x-4 gap-y-0 items-start py-0.5" ]
        [ span [ class "text-[13px] font-medium leading-5 py-0.5" ] [ text (label ++ ":") ]
        , div [ class "min-h-[20px] flex items-start leading-5 py-0.5" ] [ value ]
        ]


aorNames : B.Network -> RD.RemoteData err (List { a | id : Int, name : String }) -> Html Msg
aorNames network aorList =
    case aorList of
        Success aors ->
            network.aorIds
                |> List.filterMap (\aid -> aors |> List.filter (\a -> a.id == aid) |> List.head |> Maybe.map .name)
                |> String.join ", "
                |> text

        _ ->
            text ""


unitNames : Shared.Model -> Maybe (List Int) -> Html Msg
unitNames shared maybeUnitIds =
    case maybeUnitIds of
        Just unitIds ->
            List.map
                (\unitId ->
                    Dict.get unitId (RD.withDefault Dict.empty shared.masterUnits)
                        |> Maybe.map .name
                        |> Maybe.withDefault (String.fromInt unitId)
                )
                unitIds
                |> String.join ", "
                |> text

        Nothing ->
            text ""


freqKinds : List B.NetworkFreq -> String
freqKinds freqs =
    List.map .modulation freqs
        |> List.map NetworksUtils.networkStringToLabel
        |> Set.fromList
        |> Set.toList
        |> String.join ", "


postNames : Shared.Model -> List Int -> Html Msg
postNames shared postIds =
    case shared.posts of
        Success posts ->
            List.filterMap (\postId -> Dict.get postId posts) postIds
                |> List.map .name
                |> String.join ", "
                |> text

        _ ->
            text ""


viewNetworkInfoForm : B.UpdateNetworkReq -> B.Network -> List B.NetworkFreq -> Shared.Model -> Model -> List (Html Msg)
viewNetworkInfoForm updNetworkReq network networkFreqs shared model =
    [ div [ class "mb-[8px] flex justify-end items-center" ]
        [ -- Без заголовка для економії місця
          div [ class "flex gap-[8px]" ]
            [ i [ class "bi bi-x-square text-action cursor-pointer text-[20px]", onClick NetworkEditingCanceledByUser, title "Скасувати" ] []
            , i [ class "bi bi-check-square text-action cursor-pointer text-[20px]", onClick NetworkEditingSavedByUser, title "Зберегти" ] []
            ]
        ]
    , div [ class "space-y-3" ]
        [ div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Смуги:" ]
            , div [ class "col-span-2" ]
                [ let
                    selectedItems =
                        List.map
                            (\aorId ->
                                let
                                    label =
                                        case model.aorList of
                                            Success aors ->
                                                aors
                                                    |> List.filter (\a -> a.id == aorId)
                                                    |> List.head
                                                    |> Maybe.map .name
                                                    |> Maybe.withDefault ""

                                            _ ->
                                                ""
                                in
                                Select.basicMenuItem { item = aorId, label = label }
                            )
                            model.editAorSelect.selected

                    defaultOptions =
                        Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                  in
                  Html.map NetworkEditAorSelMsg <|
                    Styled.toUnstyled <|
                        Utils.Select.renderSelect
                            selectedItems
                            model.editAorSelect.state
                            model.editAorSelect.items
                            "виберіть смуги"
                            { defaultOptions | trunc = Utils.Select.Shortest }
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Назва:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value updNetworkReq.name
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | name = v })
                    , class "form-input w-full"
                    , placeholder "введіть назву"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Підрозділи:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ div [ class "w-full" ]
                    [ let
                        selectedItems =
                            List.map
                                (\unitId ->
                                    Select.basicMenuItem
                                        { item = unitId
                                        , label =
                                            RD.withDefault Dict.empty shared.masterUnits
                                                |> Dict.get unitId
                                                |> Maybe.map .name
                                                |> Maybe.withDefault ""
                                        }
                                )
                                model.editUnitsSelect.selected

                        defaultOptions =
                            Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map NetworkEditUnitsSelMsg <|
                        Styled.toUnstyled <|
                            Utils.Select.renderSelect
                                selectedItems
                                model.editUnitsSelect.state
                                model.editUnitsSelect.items
                                "почніть вводити назву підрозділу"
                                { defaultOptions | trunc = Utils.Select.Short }
                    ]
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Район функціонування/розгортання:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value updNetworkReq.location
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | location = v })
                    , class "form-input w-full"
                    , placeholder "введіть район функціонування/розгортання"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Призначення:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value <| Maybe.withDefault "" updNetworkReq.purpose
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | purpose = Just v })
                    , class "form-input w-full"
                    , placeholder "введіть призначення"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Склад кореспондентів:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ RD.withDefault [] model.callsigns |> List.length |> String.fromInt |> text ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Вид передачі:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ List.map (\freqObj -> freqObj.modulation) networkFreqs
                    |> List.map NetworksUtils.networkStringToLabel
                    |> Set.fromList
                    |> Set.toList
                    |> String.join ", "
                    |> text
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Режим роботи радіомережі:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value <| Maybe.withDefault "" updNetworkReq.operationMode
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | operationMode = Just v })
                    , class "form-input w-full"
                    , placeholder "введіть режим роботи радіомережі"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Характер роботи:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value <| Maybe.withDefault "" updNetworkReq.operationType
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | operationType = Just v })
                    , class "form-input w-full"
                    , placeholder "введіть характер роботи"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Період функціонування:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value <| Maybe.withDefault "" updNetworkReq.operationPeriod
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | operationPeriod = Just v })
                    , class "form-input w-full"
                    , placeholder "введіть період функціонування"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center mt-[24px]" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Активність:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text <| createActivityStr network.activeFrom network.activeTo shared.timeZone ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Пости:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ div [ class "w-full" ]
                    [ let
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
                            Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map NetworkEditPostsSelMsg <|
                        Styled.toUnstyled <|
                            Utils.Select.renderSelect
                                selectedItems
                                model.editPostsSelect.state
                                model.editPostsSelect.items
                                "виберіть пости"
                                defaultOptions
                    ]
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Радіостанція:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value (Maybe.withDefault "" updNetworkReq.radioStation)
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | radioStation = Just v })
                    , class "form-input w-full"
                    , placeholder "введіть радіостанцію"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Статус:" ]
            , div [ class "col-span-2" ]
                [ select
                    [ class "form-input w-full"
                    , onInput <| \value -> NetworkEditingMsg { updNetworkReq | status = networkStatusFromValue value }
                    ]
                    [ option [ value "active", selected (updNetworkReq.status == B.NetworkActive) ] [ text "Активна" ]
                    , option [ value "inactive", selected (updNetworkReq.status == B.NetworkInactive) ] [ text "Неактивна" ]
                    ]
                ]
            ]
        ]

    -- Прибираємо другий заголовок, залишаємо тільки поля
    ]
