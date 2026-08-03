module Pages.RerUnits.Id_ exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Core.Auth
import Core.Types exposing (ApiError)
import Dict
import Effect as E exposing (Effect)
import File.Download as Download
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (on, onClick)
import Json.Decode as Decode
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Route.Path
import Shared
import Shared.Components.Spinner
import Time
import Utils.Api.ErrorHandling
import Utils.Time
import View exposing (View)


page : Auth.User -> Shared.Model -> Route { id : String } -> Page Model Msg
page user shared route =
    Page.new
        { init = init user route
        , update = update
        , subscriptions = subscriptions
        , view = view user shared
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "rer-units"
        }


type Tab
    = Overview
    | Files


type alias Model =
    { unitId : Maybe Int
    , details : Maybe B.UnitDetailsRsp
    , detailsLoading : Bool
    , detailsLoadFailed : Bool
    , activeTab : Tab
    , downloadInProgress : Maybe Int
    , orbitLinkDialogOpen : Bool
    , orbitUnitUnlinking : Maybe String
    }


init : Auth.User -> Route { id : String } -> () -> ( Model, Effect Msg )
init _ route _ =
    let
        unitId =
            route.params.id
                |> String.toInt
                |> Maybe.andThen positiveInt

        initialEffects =
            case unitId of
                Just id ->
                    [ loadDetails id ]

                Nothing ->
                    []
    in
    ( { unitId = unitId
      , details = Nothing
      , detailsLoading = unitId /= Nothing
      , detailsLoadFailed = False
      , activeTab =
            if Dict.get "tab" route.query == Just "files" then
                Files

            else
                Overview
      , downloadInProgress = Nothing
      , orbitLinkDialogOpen = False
      , orbitUnitUnlinking = Nothing
      }
    , E.batch initialEffects
    )


positiveInt : Int -> Maybe Int
positiveInt value =
    if value > 0 then
        Just value

    else
        Nothing


loadDetails : Int -> Effect Msg
loadDetails unitId =
    E.sendCmd <|
        Api.sigint_unit_details DetailsReturnedByApi
            { unitId = unitId
            }


type Msg
    = DetailsReturnedByApi (Result ApiError B.UnitDetailsRsp)
    | RetryDetails
    | ChangeTab Tab
    | AttachmentsUploaded
    | DownloadAttachment B.UnitAttachment
    | AttachmentDownloaded B.UnitAttachment (Result ApiError Bytes)
    | OpenOrbitLinkDialog
    | CloseOrbitLinkDialog
    | OrbitUnitLinked
    | UnlinkOrbitUnit B.OrbitUnitDetails
    | OrbitUnitUnlinked String (Result ApiError ())


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        DetailsReturnedByApi result ->
            updateDetails result model

        RetryDetails ->
            retryDetails model

        ChangeTab tab ->
            ( { model | activeTab = tab }, E.none )

        AttachmentsUploaded ->
            reloadAttachments model

        DownloadAttachment attachment ->
            downloadAttachment attachment model

        AttachmentDownloaded attachment result ->
            attachmentDownloaded attachment result model

        OpenOrbitLinkDialog ->
            ( { model | orbitLinkDialogOpen = True }, E.none )

        CloseOrbitLinkDialog ->
            ( { model | orbitLinkDialogOpen = False }, E.none )

        OrbitUnitLinked ->
            orbitUnitLinked model

        UnlinkOrbitUnit orbitUnit ->
            unlinkOrbitUnit orbitUnit model

        OrbitUnitUnlinked orbitUnitId result ->
            orbitUnitUnlinked orbitUnitId result model


updateDetails : Result ApiError B.UnitDetailsRsp -> Model -> ( Model, Effect Msg )
updateDetails result model =
    case result of
        Err err ->
            ( { model
                | detailsLoading = False
                , detailsLoadFailed = True
              }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження підрозділу" err
            )

        Ok details ->
            ( { model
                | details = Just details
                , detailsLoading = False
                , detailsLoadFailed = False
              }
            , E.none
            )


retryDetails : Model -> ( Model, Effect Msg )
retryDetails model =
    case model.unitId of
        Nothing ->
            ( model, E.none )

        Just unitId ->
            ( { model
                | detailsLoading = True
                , detailsLoadFailed = False
              }
            , loadDetails unitId
            )


reloadAttachments : Model -> ( Model, Effect Msg )
reloadAttachments model =
    case model.unitId of
        Nothing ->
            ( model, E.none )

        Just unitId ->
            ( model, loadDetails unitId )


downloadAttachment : B.UnitAttachment -> Model -> ( Model, Effect Msg )
downloadAttachment attachment model =
    if model.downloadInProgress /= Nothing then
        ( model, E.none )

    else
        ( { model | downloadInProgress = Just attachment.id }
        , E.sendCmd <|
            Api.sigint_unit_attachment_download
                (AttachmentDownloaded attachment)
                { attachmentId = attachment.id
                }
        )


attachmentDownloaded : B.UnitAttachment -> Result ApiError Bytes -> Model -> ( Model, Effect Msg )
attachmentDownloaded attachment result model =
    case result of
        Err err ->
            ( { model | downloadInProgress = Nothing }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження файлу" err
            )

        Ok bytes ->
            ( { model | downloadInProgress = Nothing }
            , E.sendCmd <|
                Download.bytes
                    (downloadFileName attachment)
                    (downloadContentType attachment)
                    bytes
            )


downloadFileName : B.UnitAttachment -> String
downloadFileName attachment =
    if String.isEmpty (String.trim attachment.fileName) then
        "attachment-" ++ String.fromInt attachment.id

    else
        attachment.fileName


downloadContentType : B.UnitAttachment -> String
downloadContentType attachment =
    if String.isEmpty (String.trim attachment.contentType) then
        "application/octet-stream"

    else
        attachment.contentType


orbitUnitLinked : Model -> ( Model, Effect Msg )
orbitUnitLinked model =
    case model.unitId of
        Nothing ->
            ( { model | orbitLinkDialogOpen = False }, E.none )

        Just unitId ->
            ( { model
                | orbitLinkDialogOpen = False
                , detailsLoading = True
              }
            , loadDetails unitId
            )


unlinkOrbitUnit : B.OrbitUnitDetails -> Model -> ( Model, Effect Msg )
unlinkOrbitUnit orbitUnit model =
    case model.unitId of
        Nothing ->
            ( model, E.none )

        Just unitId ->
            ( { model | orbitUnitUnlinking = Just orbitUnit.unitId }
            , E.sendCmd <|
                Api.sigint_unit_orbit_unlink
                    (OrbitUnitUnlinked orbitUnit.unitId)
                    { sigintUnitId = unitId
                    , orbitUnitId = orbitUnit.unitId
                    }
            )


orbitUnitUnlinked : String -> Result ApiError () -> Model -> ( Model, Effect Msg )
orbitUnitUnlinked _ result model =
    case result of
        Err err ->
            ( { model | orbitUnitUnlinking = Nothing }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення прив’язки Orbit" err
            )

        Ok () ->
            case model.unitId of
                Nothing ->
                    ( { model | orbitUnitUnlinking = Nothing }, E.none )

                Just unitId ->
                    ( { model
                        | orbitUnitUnlinking = Nothing
                        , detailsLoading = True
                      }
                    , loadDetails unitId
                    )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


view : Auth.User -> Shared.Model -> Model -> View Msg
view user shared model =
    { title = "Підрозділ противника"
    , body =
        [ div [ class "page-rer-unit-details w-5/6 mx-auto py-4" ]
            [ case ( model.unitId, model.details ) of
                ( Nothing, _ ) ->
                    invalidUnitView

                ( Just _, Just details ) ->
                    detailsView user shared model details

                ( Just _, Nothing ) ->
                    if model.detailsLoading then
                        loadingView

                    else
                        detailsErrorView model.detailsLoadFailed
            ]
        ]
    }


invalidUnitView : Html Msg
invalidUnitView =
    div [ class "alert alert-danger" ]
        [ text "Некоректний ID підрозділу." ]


loadingView : Html Msg
loadingView =
    div [ class "flex justify-center py-12" ]
        [ Shared.Components.Spinner.loadingSpinner ]


detailsErrorView : Bool -> Html Msg
detailsErrorView loadFailed =
    div [ class "alert alert-danger d-flex align-items-center justify-content-between" ]
        [ text
            (if loadFailed then
                "Не вдалося завантажити підрозділ."

             else
                "Підрозділ не знайдено."
            )
        , button
            [ class "btn btn-outline-danger btn-sm"
            , type_ "button"
            , onClick RetryDetails
            ]
            [ text "Спробувати ще раз" ]
        ]


detailsView : Auth.User -> Shared.Model -> Model -> B.UnitDetailsRsp -> Html Msg
detailsView user shared model details =
    div [ class "flex flex-col gap-4" ]
        [ detailsHeader details
        , tabsView model.activeTab
        , case model.activeTab of
            Overview ->
                overviewTab user shared model details

            Files ->
                filesTab user shared model details.attachments
        , orbitLinkDialog model
        ]


detailsHeader : B.UnitDetailsRsp -> Html Msg
detailsHeader details =
    div
        [ class "d-flex align-items-center justify-content-between gap-3 flex-wrap" ]
        [ div [ class "d-flex align-items-center gap-3 flex-wrap" ]
            [ a
                [ class "btn btn-outline-secondary btn-sm"
                , Route.href
                    { path = Route.Path.RerUnits
                    , query = Dict.empty
                    , hash = Nothing
                    }
                ]
                [ i [ class "bi bi-arrow-left me-2" ] []
                , text "До підрозділів"
                ]
            , h1 [ class "mb-0" ] [ text details.unit.name ]
            ]
        ]


orbitLinkDialog : Model -> Html Msg
orbitLinkDialog model =
    case ( model.orbitLinkDialogOpen, model.unitId ) of
        ( True, Just unitId ) ->
            node "orbit-unit-link-dialog"
                [ attribute "data-unit-id" (String.fromInt unitId)
                , on "orbit-unit-link-close" (Decode.succeed CloseOrbitLinkDialog)
                , on "orbit-unit-linked" (Decode.succeed OrbitUnitLinked)
                ]
                []

        _ ->
            text ""


tabsView : Tab -> Html Msg
tabsView activeTab =
    let
        tabButton tab label =
            button
                [ class "px-4 py-2 text-sm font-medium border-b-2 bg-transparent"
                , classList
                    [ ( "border-primary text-primary", activeTab == tab )
                    , ( "border-transparent text-secondary", activeTab /= tab )
                    ]
                , type_ "button"
                , attribute "role" "tab"
                , attribute "aria-selected"
                    (if activeTab == tab then
                        "true"

                     else
                        "false"
                    )
                , onClick (ChangeTab tab)
                ]
                [ text label ]
    in
    nav
        [ class "d-flex border-bottom"
        , attribute "role" "tablist"
        ]
        [ tabButton Overview "Огляд"
        , tabButton Files "Файли"
        ]


overviewTab : Auth.User -> Shared.Model -> Model -> B.UnitDetailsRsp -> Html Msg
overviewTab user shared model details =
    let
        orbitCards =
            if List.isEmpty details.orbitUnits then
                if details.canLinkOrbitUnit then
                    [ emptyOrbitDataCard ]

                else
                    []

            else
                List.map
                    (orbitDataCard
                        (Core.Auth.hasRole "Admin" user)
                        shared
                        model.orbitUnitUnlinking
                    )
                    details.orbitUnits
    in
    div
        [ class "flex flex-col gap-4"
        , attribute "role" "tabpanel"
        ]
        (unitOverviewCard shared details.unit :: orbitCards)


emptyOrbitDataCard : Html Msg
emptyOrbitDataCard =
    div [ class "border rounded p-4 bg-card" ]
        [ h2 [ class "h4 mb-4" ] [ text "Дані із Orbit" ]
        , p [] [ text "Відсутні дані із системи Orbit." ]
        , p [ class "mb-0" ]
            [ button
                [ class "btn btn-outline-primary d-inline-flex align-items-center gap-2"
                , type_ "button"
                , onClick OpenOrbitLinkDialog
                ]
                [ img
                    [ src "/img/delta-icon.webp"
                    , alt ""
                    , style "height" "22px"
                    , style "width" "22px"
                    ]
                    []
                , text "Прив'язати Orbit підрозділ"
                ]
            ]
        ]


unitOverviewCard : Shared.Model -> B.Unit -> Html Msg
unitOverviewCard shared unit =
    div
        [ class "border rounded p-4 bg-card" ]
        [ div [ class "row g-4" ]
            [ overviewField "Рота, взвод" unit.company
            , overviewField "Батальйон" unit.battalion
            , overviewField "Полк/Бригада" unit.regiment
            , overviewField "Дивізія" unit.division
            , overviewField "Корпус/Армія" unit.army
            , overviewField
                "Статус"
                (if unit.active then
                    "Активний"

                 else
                    "Неактивний"
                )
            , overviewField
                "Дата внесення"
                (Utils.Time.renderDateTimeF1 shared.timeZone
                    (Time.millisToPosix unit.createdAt)
                )
            , div [ class "col-12" ]
                [ div [ class "text-secondary text-sm mb-1" ] [ text "Коментар" ]
                , div
                    [ class "border rounded p-3"
                    , style "min-height" "96px"
                    , style "white-space" "pre-wrap"
                    , style "overflow-wrap" "anywhere"
                    ]
                    [ text (textOrDash unit.comment) ]
                ]
            ]
        ]


orbitDataCard : Bool -> Shared.Model -> Maybe String -> B.OrbitUnitDetails -> Html Msg
orbitDataCard canManageOrbitData shared orbitUnitUnlinking orbitUnit =
    div [ class "border rounded p-4 bg-card" ]
        [ div [ class "d-flex align-items-center justify-content-between gap-3 mb-4" ]
            [ h2 [ class "h4 mb-0" ] [ text "Дані із Orbit" ]
            , if canManageOrbitData then
                orbitDataActions orbitUnitUnlinking orbitUnit

              else
                text ""
            ]
        , orbitUnitDetails shared orbitUnit
        ]


orbitDataActions : Maybe String -> B.OrbitUnitDetails -> Html Msg
orbitDataActions orbitUnitUnlinking orbitUnit =
    let
        isUnlinking =
            orbitUnitUnlinking == Just orbitUnit.unitId

        actionLabel =
            if isUnlinking then
                "Відв’язування Orbit підрозділу"

            else
                "Дії з даними Orbit"
    in
    div [ class "dropdown" ]
        [ button
            [ class "btn btn-sm btn-link text-secondary"
            , type_ "button"
            , disabled (orbitUnitUnlinking /= Nothing)
            , attribute "data-bs-toggle" "dropdown"
            , attribute "aria-expanded" "false"
            , attribute "aria-label" actionLabel
            , attribute "aria-busy"
                (if isUnlinking then
                    "true"

                 else
                    "false"
                )
            ]
            [ if isUnlinking then
                span [ class "spinner-border spinner-border-sm" ] []

              else
                i [ class "bi bi-three-dots-vertical" ] []
            ]
        , ul [ class "dropdown-menu dropdown-menu-end" ]
            [ li []
                [ button
                    [ class "dropdown-item text-danger d-flex align-items-center gap-2"
                    , type_ "button"
                    , disabled (orbitUnitUnlinking /= Nothing)
                    , onClick (UnlinkOrbitUnit orbitUnit)
                    ]
                    [ i [ class "bi bi-link-45deg" ] []
                    , text
                        (if isUnlinking then
                            "Відв’язування…"

                         else
                            "Відв'язати Orbit підрозділ"
                        )
                    ]
                ]
            ]
        ]


orbitUnitDetails : Shared.Model -> B.OrbitUnitDetails -> Html Msg
orbitUnitDetails shared orbitUnit =
    div []
        [ div [ class "d-flex align-items-center justify-content-between gap-3 mb-4 flex-wrap" ]
            [ h3 [ class "h5 mb-0" ]
                [ text (orbitUnitTitle orbitUnit) ]
            , a
                [ class "btn btn-outline-primary d-inline-flex align-items-center"
                , href
                    ("https://delta.mil.gov.ua/orbit/units/"
                        ++ orbitUnit.unitId
                        ++ "/organizational-structure"
                    )
                , target "_blank"
                , rel "noopener noreferrer"
                , style "font-size" "1rem"
                , style "padding" "0.5rem 1rem"
                ]
                [ img
                    [ src "/img/delta-icon.webp"
                    , class "me-2 inline-block"
                    , style "height" "36px"
                    ]
                    []
                , text "Відкрити в Orbit"
                ]
            ]
        , div [ class "row g-4" ]
            [ overviewField "ID підрозділу" orbitUnit.unitId
            , overviewMaybeField "Оригінальна назва" orbitUnit.unitNameOriginal
            , overviewMaybeField "Повна назва" orbitUnit.generativeUnitNameFull
            , overviewMaybeField
                "Підпорядкування"
                (Maybe.map orbitParentPath orbitUnit.operationalUnitNameFull)
            , overviewMaybeField "Номер підрозділу" orbitUnit.unitNumber
            , overviewMaybeListField "Альтернативні назви" orbitUnit.unitAlternateNames
            , overviewMaybeListField "Альтернативні номери" orbitUnit.unitAlternateNumbers
            , overviewField "Ешелон" (orbitDictionaryValue orbitUnit.unitEchelon)
            , overviewField "Тип бойового підрозділу" (orbitDictionaryValue orbitUnit.combatUnitType)
            , overviewField
                "Угруповання військ"
                (orbitUnit.groupingOfForces
                    |> List.map orbitDictionaryDetails
                    |> String.join "\n"
                )
            , overviewField
                "Дата створення"
                (Utils.Time.renderDateTimeF1 shared.timeZone
                    (Time.millisToPosix orbitUnit.createdAt)
                )
            , overviewField
                "Дата оновлення"
                (Utils.Time.renderDateTimeF1 shared.timeZone
                    (Time.millisToPosix orbitUnit.updatedAt)
                )
            ]
        ]


orbitUnitTitle : B.OrbitUnitDetails -> String
orbitUnitTitle orbitUnit =
    case orbitUnit.unitName of
        Just name ->
            name

        Nothing ->
            Maybe.withDefault orbitUnit.unitId orbitUnit.unitNameShort


overviewMaybeField : String -> Maybe String -> Html Msg
overviewMaybeField labelText value =
    overviewField labelText (Maybe.withDefault "" value)


overviewMaybeListField : String -> Maybe (List String) -> Html Msg
overviewMaybeListField labelText values =
    overviewField labelText
        (values
            |> Maybe.withDefault []
            |> String.join "\n"
        )


orbitDictionaryValue : Maybe B.OrbitDictionaryValue -> String
orbitDictionaryValue value =
    value
        |> Maybe.map .name
        |> Maybe.withDefault ""


orbitParentPath : String -> String
orbitParentPath value =
    value
        |> String.split " / "
        |> List.drop 1
        |> String.join " / "


orbitDictionaryDetails : B.OrbitDictionaryValue -> String
orbitDictionaryDetails value =
    value.name ++ " (" ++ value.key ++ "; " ++ value.id ++ ")"


overviewField : String -> String -> Html Msg
overviewField labelText value =
    div [ class "col-md-6" ]
        [ div [ class "text-secondary text-sm mb-1" ] [ text labelText ]
        , div
            [ class "fw-semibold"
            , style "white-space" "pre-wrap"
            , style "overflow-wrap" "anywhere"
            ]
            [ text (textOrDash value) ]
        ]


filesTab : Auth.User -> Shared.Model -> Model -> List B.UnitAttachment -> Html Msg
filesTab user shared model attachments =
    let
        isAdmin =
            Core.Auth.hasRole "Admin" user
    in
    div
        [ class "flex flex-col gap-4"
        , attribute "role" "tabpanel"
        ]
        [ if isAdmin then
            adminFiles model

          else
            attachmentsTable shared model attachments
        ]


adminFiles : Model -> Html Msg
adminFiles model =
    case model.unitId of
        Nothing ->
            text ""

        Just unitId ->
            node "unit-attachment-upload"
                [ attribute "data-unit-id" (String.fromInt unitId)
                , on "unit-attachments-uploaded" (Decode.succeed AttachmentsUploaded)
                ]
                []


attachmentsTable : Shared.Model -> Model -> List B.UnitAttachment -> Html Msg
attachmentsTable shared model attachments =
    if List.isEmpty attachments then
        div [ class "border rounded p-5 text-center text-secondary" ]
            [ text "Файлів немає." ]

    else
        div [ class "table-responsive" ]
            [ table [ class "table table-bordered align-middle mb-0" ]
                [ thead []
                    [ tr []
                        [ th [ scope "col" ] [ text "Файл" ]
                        , th [ scope "col" ] [ text "Короткий опис" ]
                        , th [ scope "col" ] [ text "Повний опис" ]
                        , th [ scope "col", class "text-nowrap" ] [ text "Дата внесення" ]
                        ]
                    ]
                , tbody []
                    (List.map (attachmentRow shared model) attachments)
                ]
            ]


attachmentRow : Shared.Model -> Model -> B.UnitAttachment -> Html Msg
attachmentRow shared model attachment =
    let
        isDownloading =
            model.downloadInProgress == Just attachment.id

        anyDownloadInProgress =
            model.downloadInProgress /= Nothing

    in
    tr [ style "height" "96px" ]
        [ td tallCellAttributes
            [ button
                [ class "btn btn-link p-0 text-start d-inline-flex align-items-center gap-2"
                , type_ "button"
                , Attr.disabled anyDownloadInProgress
                , onClick (DownloadAttachment attachment)
                ]
                [ if isDownloading then
                    span
                        [ class "spinner-border spinner-border-sm"
                        , attribute "role" "status"
                        ]
                        []

                  else
                    i [ class "bi bi-download" ] []
                , span [ class "text-break" ] [ text (downloadFileName attachment) ]
                ]
            , div [ class "small text-secondary mt-2" ]
                [ text (formatFileSize attachment.sizeBytes) ]
            ]
        , descriptionCell attachment.shortDescription
        , descriptionCell attachment.fullDescription
        , td tallCellAttributes
            [ text <|
                Utils.Time.renderDateTimeF1 shared.timeZone
                    (Time.millisToPosix attachment.createdAt)
            ]
        ]


tallCellAttributes : List (Html.Attribute msg)
tallCellAttributes =
    [ class "align-top"
    , style "height" "96px"
    , style "min-height" "96px"
    , style "vertical-align" "top"
    ]


descriptionCell : String -> Html msg
descriptionCell value =
    td tallCellAttributes
        [ div
            [ style "white-space" "pre-wrap"
            , style "overflow-wrap" "anywhere"
            , style "word-break" "break-word"
            ]
            [ text (textOrDash value) ]
        ]


textOrDash : String -> String
textOrDash value =
    if String.isEmpty (String.trim value) then
        "—"

    else
        value


formatFileSize : Int -> String
formatFileSize sizeBytes =
    if sizeBytes >= 1024 * 1024 then
        String.fromInt (sizeBytes // (1024 * 1024)) ++ " МБ"

    else if sizeBytes >= 1024 then
        String.fromInt (sizeBytes // 1024) ++ " КБ"

    else
        String.fromInt sizeBytes ++ " Б"
