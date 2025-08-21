module Pages.Importer exposing
import Shared.Model exposing (isDarkMode)
    ( FileWithUuid
    , Model
    , Msg
    , Row
    , SelectedCoord
    , exampleContent
    , operatyvkaExamples
    , page
    )

import Api
import Auth
import Base64.Decode
import Bindings as B
import Bytes exposing (Bytes)
import Coordinates exposing (Coordinates)
import DateFormat
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import EnumeratedList as EL exposing (EnumeratedItem, EnumeratedList)
import File exposing (File)
import File.Download as Download
import File.Select
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Html.Styled as Styled
import Layouts
import Le.Block.Select
import Le.Block.Spinner
import Le.Components exposing (fieldError, isInvalidCls)
import Le.ErrorHandling
import Le.Types exposing (ApiError)
import Le.Utils exposing (..)
import List.Extra as ListX
import Maybe.Extra as MaybeX
import Page exposing (Page)
import PagePorts.ImporterPorts as Ports
import Random
import Route exposing (Route)
import Select
import Shared
import Shared.Model exposing (isDarkMode)
import Task
import Time exposing (Posix)
import Uuid.Barebones
import View exposing (View)
import Views


type alias FileWithUuid =
    { uuid : String

    -- Nothing is used for progress when pasting from clipboard
    , mFile : Maybe File
    }


type alias Row =
    { content : String
    , coordinates : EnumeratedList Coordinates
    , coordinatesWgs84 : Dict Int { lat : Float, lng : Float }
    , selected : SelectedCoord
    , manualCoordTxt : String
    , title : String
    , icon : String
    , proposedIcons : List String
    , proposedTitles : List String
    , filesToUpload : List FileWithUuid
    , imageUrls : List String
    , selState : Select.State
    , selMenu : List (Select.MenuItem String)
    }


type SelectedCoord
    = SelectedCoordIndex (List Int)
    | SelectedCoordManual
    | SelectedCoordNone


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared req =
    Page.new
        { init = init
        , update = update
        , view = view (isDarkMode shared.themeMode) shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "bpla"
        }



-- INIT


type alias Model =
    { formErrors : Dict String String
    , rows : EnumeratedList Row
    , downloadKmzInProgress : Bool
    , downloadGeojsonInProgress : Bool
    , downloadFileName : String
    , pdfToProcess : Maybe File
    , counter : Int
    }


iconMenu : List (Select.MenuItem String)
iconMenu =
    knownIcons
        |> List.map
            (\x ->
                Select.basicMenuItem
                    { item = x.icon
                    , label = x.titleMain
                    }
            )


emptyRow : Int -> Row
emptyRow rowId =
    { content = ""
    , coordinates = EL.empty
    , coordinatesWgs84 = Dict.empty
    , selected = SelectedCoordNone
    , manualCoordTxt = ""
    , title = ""
    , icon = "00_Загально.png"
    , proposedIcons = []
    , proposedTitles = []
    , filesToUpload = []
    , imageUrls = []
    , selState = Select.initState (Select.selectIdentifier ("sel-row-" ++ String.fromInt rowId))
    , selMenu = iconMenu
    }


init : () -> ( Model, Effect Msg )
init _ =
    let
        rows : EnumeratedList Row
        rows =
            EL.fromList [ emptyRow 0 ]
    in
    ( { formErrors = Dict.empty
      , rows = rows
      , downloadKmzInProgress = False
      , downloadGeojsonInProgress = False
      , downloadFileName = "operatyvka-<DATETIME>"
      , pdfToProcess = Nothing
      , counter = 1
      }
    , E.none
    )



-- UPDATE


type Msg
    = TextareaChanged Int String
    | SelectCoordIndex Int Int
    | SelectCoordManual Int
    | GotUsk2000ToWgs84Res
        { rowId : Int
        , coordId : Int
        , coords : { lat : Float, lng : Float }
        }
    | GotMgrsToWgs84Res
        { rowId : Int
        , coordId : Int
        , coords : { lat : Float, lng : Float }
        }
    | TitleChanged Int String
    | SelectIcon Int String
      -- | SelectIconJson Int JD.Value
    | DeleteRow Int
    | AddRow
    | DownloadKmz
    | DownloadKmzDone (Result ApiError Bytes)
    | DownloadKmzDoneTimeDone Bytes Posix
    | DownloadGeojson
    | DownloadGeojsonDone (Result ApiError Bytes)
    | DownloadGeojsonDoneTimeDone Bytes Posix
    | GotProposedIcons { rowId : Int, icons : List String }
    | DownloadFilenameChanged String
    | UploadImages Int
    | UploadImagesSelected Int File (List File)
    | GotFileUuid Int File String
    | UploadImageDone Int (Result ApiError B.UploadScreenshotRes)
    | UploadPdfClicked
    | UploadPdfSelected File
    | UploadPdfDone (Result ApiError B.UploadPdfRes)
    | PasteImageFromClipboard Int
    | PasteImageFromClipboardRes { rowId : Int, contentsBase64 : String }
    | DeleteImage Int String
    | SelIconMsg Int (Select.Msg String)
    | ApplyIconDownwards Int
    | SelectAll Int


selectFirstIfPossible : List Coordinates -> SelectedCoord
selectFirstIfPossible xs =
    case xs of
        [] ->
            SelectedCoordNone

        _ ->
            SelectedCoordIndex [ 0 ]


buildRowInfo : ( Int, Row ) -> List B.RowInfo
buildRowInfo ( i, r ) =
    case r.selected of
        SelectedCoordNone ->
            []

        SelectedCoordManual ->
            case Coordinates.extractCoordinates r.manualCoordTxt of
                (Coordinates.Wgs84LatLng { lat, lng }) :: _ ->
                    [ { content = r.content
                      , imageUrls = r.imageUrls
                      , lat = Coordinates.renderWgsFloat lat
                      , lng = Coordinates.renderWgsFloat lng
                      , title = r.title
                      , icon = r.icon
                      }
                    ]

                _ ->
                    []

        SelectedCoordIndex coordIds ->
            coordIds
                |> List.map
                    (\coordId ->
                        ListX.getAt coordId (EL.toList r.coordinates)
                            |> Maybe.map (\x -> ( coordId, x ))
                    )
                |> MaybeX.values
                |> List.map
                    (\( coordId, coords ) ->
                        case renderCoordinatesToLatLng coordId coords r.coordinatesWgs84 of
                            Just latlng ->
                                Just
                                    { content = r.content
                                    , imageUrls = r.imageUrls
                                    , lat = latlng.lat
                                    , lng = latlng.lng
                                    , title = r.title
                                    , icon = r.icon
                                    }

                            Nothing ->
                                Nothing
                    )
                |> MaybeX.values


renderCoordinatesToLatLng : Int -> Coordinates -> Dict Int { lat : Float, lng : Float } -> Maybe { lat : String, lng : String }
renderCoordinatesToLatLng coordId coords coordinatesWgs84 =
    case coords of
        Coordinates.Wgs84LatLng { lat, lng } ->
            Just { lat = Coordinates.renderWgsFloat lat, lng = Coordinates.renderWgsFloat lng }

        Coordinates.Wgs84DegMinSec { lat, lng } ->
            Just
                { lat = Coordinates.renderWgsFloat (Coordinates.dmsToLatLng lat)
                , lng = Coordinates.renderWgsFloat (Coordinates.dmsToLatLng lng)
                }

        _ ->
            case Dict.get coordId coordinatesWgs84 of
                Nothing ->
                    Nothing

                Just { lat, lng } ->
                    Just
                        { lat = Coordinates.renderWgsFloat lat
                        , lng = Coordinates.renderWgsFloat lng
                        }


type alias Icon =
    { icon : String
    , name : String
    , titleMain : String
    , titleExtras : List String
    }


genericIcon : Icon
genericIcon =
    { icon = "00_Загально.png", name = "Загально", titleMain = "", titleExtras = [] }


knownIcons : List Icon
knownIcons =
    [ genericIcon
    , { icon = "Арта САУ.png", name = "Арта САУ", titleMain = "САУ", titleExtras = [] }
    , { icon = "Блокпост.png", name = "Блокпост", titleMain = "Блокпост", titleExtras = [] }
    , { icon = "БПЛА.png", name = "БПЛА", titleMain = "БПЛА", titleExtras = [] }
    , { icon = "БПЛА_дружній.png"
      , name = "БПЛА_дружній.png"
      , titleMain = "БПЛА (дружній)"
      , titleExtras = [ "Точка старту" ]
      }
    , { icon = "БТР.png", name = "БТР", titleMain = "БТР", titleExtras = [] }
    , { icon = "ВАТ.png", name = "ВАТ", titleMain = "ВАТ", titleExtras = [] }
    , { icon = "Важка артилерія РОВ.png"
      , name = "Артилерія"
      , titleMain = "Артилерія"
      , titleExtras = [ "Артилерія на вогневих позиціях" ]
      }
    , { icon = "Вогнева позиція 2.png", name = "Вогнева позиція 2", titleMain = "Вогнева позиція", titleExtras = [] }
    , { icon = "Вогнева позиція.png", name = "Вогнева позиція", titleMain = "Вогнева позиція", titleExtras = [] }
    , { icon = "Гелікоптер.png", name = "Гелікоптер", titleMain = "Гелікоптер", titleExtras = [] }
    , { icon = "ІФО.png", name = "ІФО", titleMain = "ІФО", titleExtras = [ "Блокпост" ] }
    , { icon = "ІФО окоп.png", name = "ІФО окоп", titleMain = "ІФО", titleExtras = [ "Блокпост" ] }
    , { icon = "ІФО 2.png", name = "ІФО 2", titleMain = "ІФО", titleExtras = [ "Блокпост" ] }
    , { icon = "Інженерний підрозділ.png", name = "Інженерний підрозділ", titleMain = "Інженерний підрозділ", titleExtras = [] }
    , { icon = "Інша ББМ.png", name = "Інша ББМ", titleMain = "ББМ", titleExtras = [] }
    , { icon = "Логістика, БК.png", name = "Логістика, БК", titleMain = "БК", titleExtras = [] }
    , { icon = "Медичний підрозділ.png", name = "Медичний підрозділ", titleMain = "Медичний підрозділ", titleExtras = [] }
    , { icon = "Медичний_підрозділ_дружній.png"
      , name = "Медичний_підрозділ_дружній.png"
      , titleMain = "Медичний підрозділ (дружній)"
      , titleExtras = [ "Медпункт", "Стабпункт" ]
      }
    , { icon = "ОіВТ.png", name = "ОіВТ", titleMain = "ОіВТ", titleExtras = [ "Колона ОіВТ" ] }
    , { icon = "Міни.png", name = "Міни", titleMain = "Міни", titleExtras = [] }
    , { icon = "Міномет РОВ.png", name = "Міномет РОВ", titleMain = "Міномет", titleExtras = [] }
    , { icon = "Міст пантон.png", name = "Міст пантон", titleMain = "Міст", titleExtras = [ "Поромна переправа" ] }
    , { icon = "Піхота.png", name = "Піхота (о/с)", titleMain = "Піхота (о/с)", titleExtras = [] }
    , { icon = "Підрозділ звязку.png", name = "Підрозділ звязку", titleMain = "Підрозділ звʼязку", titleExtras = [] }
    , { icon = "ПММ.png", name = "ПММ", titleMain = "ПММ", titleExtras = [] }
    , { icon = "ППО.png", name = "ППО", titleMain = "ППО", titleExtras = [] }
    , { icon = "Паром.png", name = "Паром", titleMain = "Паром", titleExtras = [] }
    , { icon = "РЕБ.png", name = "РЕБ", titleMain = "РЕБ", titleExtras = [] }
    , { icon = "РЕР.png", name = "РЕР", titleMain = "РЕР", titleExtras = [] }
    , { icon = "РСЗО.png", name = "РСЗВ", titleMain = "РСЗВ", titleExtras = [] }
    , { icon = "Радар.png", name = "Радар", titleMain = "Радар", titleExtras = [] }
    , { icon = "Рембаза.png", name = "Рембаза", titleMain = "Рембаза", titleExtras = [] }
    , { icon = "Танк.png", name = "Танк", titleMain = "Танк", titleExtras = [] }
    , { icon = "Цивільна автівка.png", name = "Цивільна автівка", titleMain = "Цивільне авто", titleExtras = [] }
    , { icon = "Штаб.png", name = "Штаб", titleMain = "Штаб", titleExtras = [] }
    , { icon = "10061500002203000000.png", name = "РЛС", titleMain = "РЛС", titleExtras = [] }
    , { icon = "10061500002001000000.png", name = "Антена", titleMain = "Антена", titleExtras = [] }
    , { icon = "10061500001103000000.png", name = "АГС", titleMain = "АГС", titleExtras = [] }
    , { icon = "10061500001601000000.png", name = "ЛАТ", titleMain = "ЛАТ", titleExtras = [] }
    , { icon = "10063000001405020000.png", name = "Човен", titleMain = "Човен", titleExtras = [] }
    , { icon = "10062000001120000000.png", name = "Склад", titleMain = "Склад", titleExtras = [] }
    , { icon = "10061000001110010000.png", name = "Радіо сигнал", titleMain = "Радіо сигнал", titleExtras = [] }
    , { icon = "10061000001110040000.png", name = "Супутниковий звʼязок", titleMain = "Супутниковий звʼязок", titleExtras = [] }
    , { icon = "point-green.png", name = "Орієнтир", titleMain = "Орієнтир", titleExtras = [] }
    , { icon = "point-red.png", name = "Орієнтир", titleMain = "Орієнтир", titleExtras = [] }
    , { icon = "point-blue.png", name = "Орієнтир", titleMain = "Орієнтир", titleExtras = [] }
    , { icon = "cross-green.png", name = "Ціль", titleMain = "Ціль", titleExtras = [] }
    , { icon = "cross-red.png", name = "Ціль", titleMain = "Ціль", titleExtras = [] }
    , { icon = "cross-blue.png", name = "Ціль", titleMain = "Ціль", titleExtras = [] }
    , { icon = "interest_point_yellow.svg", name = "Орієнтир(точка інтересу)", titleMain = "Орієнтир(точка інтересу)", titleExtras = [] }
    , { icon = "interest_point_red.svg", name = "Орієнтир(точка інтересу)", titleMain = "Орієнтир(точка інтересу)", titleExtras = [] }
    ]



{- | see if title is present in icon defaults -}


isTitleStandard : String -> Bool
isTitleStandard title =
    let
        go xss =
            case xss of
                [] ->
                    False

                x :: xs ->
                    if x.titleMain == title then
                        True

                    else if List.member title x.titleExtras then
                        True

                    else
                        go xs
    in
    go knownIcons


{-| icons come in as filenames which can be absent in our database, or
renamed. this function will need to develop over time to cover missing
icon filenames ideally
-}
renameIcons : List String -> List String
renameIcons icons =
    let
        knownRenames =
            Dict.fromList
                [ ( "Fort_MGRS-Mapper.png", "ІФО.png" )
                , ( "Underground-Facility_MGRS-Mapper.png", "ІФО 2.png" )
                , ( "icon-1_2.png", "Арта САУ.png" )
                , ( "icon-2_2.png", "00_Загально.png" )
                , ( "icon-4_2.png", "Цивільна автівка.png" )
                , ( "icon-5_2.png", "Радар.png" )
                , ( "Інша ББМ_0.png", "Інша ББМ.png" )
                , ( "Інша ББМ_3.png", "Інша ББМ.png" )
                , ( "Інша ББМ_4.png", "Інша ББМ.png" )
                , ( "Особовий склад, піхота.png", "Піхота.png" )
                , ( "Особовий склад, піхота_0.png", "Піхота.png" )
                , ( "Особовий склад, піхота_1.png", "Піхота.png" )
                , ( "Особовий склад, піхота_3.png", "Піхота.png" )
                , ( "вогнева позиція (2).png", "Вогнева позиція 2.png" )
                , ( "мост_пантон.png", "Міст пантон.png" )
                , ( "міни.png", "Міни.png" )
                , ( "окопи.png", "ІФО окоп.png" )
                , ( "підрозділ звязку.png", "Підрозділ звязку.png" )
                , ( "Механізовані, ОіВТ.png", "ОіВТ.png" )
                ]

        rename icon =
            case Dict.get icon knownRenames of
                Nothing ->
                    if List.member icon (List.map .icon knownIcons) then
                        icon

                    else
                        "00_Загально.png"

                Just icon2 ->
                    icon2
    in
    ListX.unique (List.map rename icons)


replaceMacros : Posix -> String -> String
replaceMacros now input =
    input
        |> String.replace "<DATE>" (DateFormat.format "yyyy-MM-dd" Time.utc now)
        |> String.replace "<DATETIME>" (DateFormat.format "yyyy-MM-dd-HH-mm" Time.utc now)


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        TextareaChanged rowId content ->
            let
                m_row =
                    EL.findByPosition rowId model.rows |> Maybe.map .el

                coordinates =
                    Coordinates.extractCoordinates content

                coordinatesEL =
                    EL.fromList <| coordinates

                row2 : Row
                row2 =
                    { content = content
                    , coordinates = EL.fromList coordinates
                    , coordinatesWgs84 = Dict.empty
                    , selected = selectFirstIfPossible coordinates
                    , manualCoordTxt = m_row |> Maybe.map .manualCoordTxt |> Maybe.withDefault ""
                    , title = m_row |> Maybe.map .title |> Maybe.withDefault ""
                    , icon = "00_Загально.png"
                    , proposedIcons = []
                    , proposedTitles = []
                    , filesToUpload = m_row |> Maybe.map .filesToUpload |> Maybe.withDefault []
                    , imageUrls = m_row |> Maybe.map .imageUrls |> Maybe.withDefault []
                    , selState = m_row |> Maybe.map .selState |> Maybe.withDefault (Select.initState (Select.selectIdentifier ("sel-row-" ++ String.fromInt rowId)))
                    , selMenu = m_row |> Maybe.map .selMenu |> Maybe.withDefault iconMenu
                    }
            in
            ( { model | rows = EL.setAtPos rowId row2 model.rows }
            , E.sendCmd <|
                Cmd.batch <|
                    (EL.toList <|
                        EL.map
                            (\c ->
                                case c.el of
                                    Coordinates.Usk2000 xy ->
                                        Ports.importer_usk2000ToWgs84
                                            { rowId = rowId
                                            , coordId = c.pos
                                            , coords = xy
                                            }

                                    Coordinates.Wgs84LatLng _ ->
                                        Cmd.none

                                    Coordinates.Wgs84DegMinSec _ ->
                                        Cmd.none

                                    Coordinates.MGRS mgrs ->
                                        Ports.importer_mgrsToWgs84
                                            { rowId = rowId
                                            , coordId = c.pos
                                            , coords = mgrs
                                            }
                            )
                            coordinatesEL
                    )
                        ++ [ Ports.importer_proposeIcons { rowId = rowId, text = content }
                           ]
            )

        -- toggles
        SelectCoordIndex rowId index ->
            case EL.findByPosition rowId model.rows of
                Nothing ->
                    ( model
                    , E.sendCmd <| Cmd.none
                    )

                Just row_i ->
                    let
                        row =
                            row_i.el

                        selected2 =
                            case row.selected of
                                SelectedCoordIndex selected ->
                                    if List.member index selected then
                                        List.filter (\x -> x /= index) selected

                                    else
                                        selected ++ [ index ]

                                _ ->
                                    [ index ]

                        row2 =
                            { row | selected = SelectedCoordIndex selected2 }
                    in
                    ( { model | rows = EL.setAtPos rowId row2 model.rows }
                    , E.sendCmd <| Cmd.none
                    )

        SelectCoordManual rowId ->
            case EL.findByPosition rowId model.rows of
                Nothing ->
                    ( model
                    , E.sendCmd <| Cmd.none
                    )

                Just row_i ->
                    let
                        row =
                            row_i.el

                        row2 =
                            { row | selected = SelectedCoordManual }
                    in
                    ( { model | rows = EL.setAtPos rowId row2 model.rows }
                    , E.sendCmd <| Cmd.none
                    )

        GotUsk2000ToWgs84Res { rowId, coordId, coords } ->
            case EL.findByPosition rowId model.rows of
                Nothing ->
                    ( model, E.sendCmd <| Cmd.none )

                Just row_i ->
                    let
                        row =
                            row_i.el

                        row2 =
                            case EL.findByPosition coordId row.coordinates of
                                Nothing ->
                                    row

                                Just _ ->
                                    { row
                                        | coordinatesWgs84 =
                                            Dict.insert coordId coords row.coordinatesWgs84
                                    }
                    in
                    ( { model | rows = EL.setAtPos row_i.pos row2 model.rows }
                    , E.sendCmd <| Cmd.none
                    )

        GotMgrsToWgs84Res { rowId, coordId, coords } ->
            case EL.findByPosition rowId model.rows of
                Nothing ->
                    ( model, E.sendCmd <| Cmd.none )

                Just row_i ->
                    let
                        row =
                            row_i.el

                        row2 =
                            case EL.findByPosition coordId row.coordinates of
                                Nothing ->
                                    row

                                Just _ ->
                                    { row
                                        | coordinatesWgs84 =
                                            Dict.insert coordId coords row.coordinatesWgs84
                                    }
                    in
                    ( { model | rows = EL.setAtPos row_i.pos row2 model.rows }
                    , E.sendCmd <| Cmd.none
                    )

        TitleChanged rowId title ->
            case EL.findByPosition rowId model.rows of
                Nothing ->
                    ( model, E.sendCmd <| Cmd.none )

                Just row_i ->
                    let
                        row =
                            row_i.el

                        row2 =
                            { row | title = title }
                    in
                    ( { model | rows = EL.setAtPos row_i.pos row2 model.rows }
                    , E.sendCmd <| Cmd.none
                    )

        SelectIcon rowId icon ->
            case EL.findByPosition rowId model.rows of
                Nothing ->
                    ( model, E.sendCmd <| Cmd.none )

                Just row_i ->
                    let
                        row =
                            row_i.el

                        ( title, extras ) =
                            case ListX.find (\x -> x.icon == icon) knownIcons of
                                Nothing ->
                                    ( row.title, [] )

                                Just i ->
                                    let
                                        titleIsStandard =
                                            isTitleStandard row.title
                                    in
                                    ( if titleIsStandard then
                                        i.titleMain

                                      else
                                        row.title
                                    , i.titleExtras
                                    )

                        row2 =
                            { row
                                | icon = icon
                                , title = title
                                , proposedTitles = title :: extras
                            }
                    in
                    ( { model | rows = EL.setAtPos row_i.pos row2 model.rows }
                    , E.none
                    )

        DeleteRow rowId ->
            let
                rows2 =
                    EL.deleteAtPos rowId model.rows
            in
            ( { model | rows = rows2 }
            , E.none
            )

        AddRow ->
            let
                rows2 =
                    EL.fromList (EL.toList model.rows ++ [ emptyRow (model.counter + 1) ])
            in
            ( { model | rows = rows2, counter = model.counter + 1 }
            , E.none
            )

        DownloadKmz ->
            let
                rows : List B.RowInfo
                rows =
                    EL.mapPair buildRowInfo model.rows
                        |> List.concat

                req : B.DownloadKmzReq
                req =
                    { rows = rows
                    , folderName = model.downloadFileName
                    }
            in
            ( { model | downloadKmzInProgress = True }
            , E.sendCmd <| Api.importer_download_kmz DownloadKmzDone req
            )

        DownloadKmzDone (Err e) ->
            ( { model | downloadKmzInProgress = False }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження KMZ" e
            )

        DownloadKmzDone (Ok bs) ->
            ( { model | downloadKmzInProgress = False }
            , E.sendCmd <| Task.perform (DownloadKmzDoneTimeDone bs) Time.now
            )

        DownloadKmzDoneTimeDone bs now ->
            ( model
            , E.sendCmd <|
                Download.bytes
                    (replaceMacros now model.downloadFileName ++ ".kmz")
                    "application/vnd.google-earth.kmz"
                    bs
            )

        DownloadGeojson ->
            let
                rows : List B.RowInfo
                rows =
                    EL.mapPair buildRowInfo model.rows
                        |> List.concat

                req : B.DownloadKmzReq
                req =
                    { rows = rows
                    , folderName = model.downloadFileName
                    }
            in
            ( { model | downloadGeojsonInProgress = True }
            , E.sendCmd <| Api.importer_download_geojson DownloadGeojsonDone req
            )

        DownloadGeojsonDone (Err e) ->
            ( { model | downloadGeojsonInProgress = False }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження GeoJSON" e
            )

        DownloadGeojsonDone (Ok bs) ->
            ( { model | downloadGeojsonInProgress = False }
            , E.sendCmd <| Task.perform (DownloadGeojsonDoneTimeDone bs) Time.now
            )

        DownloadGeojsonDoneTimeDone bs now ->
            ( model
            , E.sendCmd <|
                Download.bytes
                    (replaceMacros now (model.downloadFileName ++ ".geojson"))
                    "application/json"
                    bs
            )

        GotProposedIcons { rowId, icons } ->
            case EL.findByPosition rowId model.rows of
                Nothing ->
                    ( model, E.sendCmd <| Cmd.none )

                Just row_i ->
                    let
                        row =
                            row_i.el

                        icons2 =
                            renameIcons icons

                        row2 =
                            { row | proposedIcons = icons2 }

                        m2 =
                            { model | rows = EL.setAtPos row_i.pos row2 model.rows }
                    in
                    case ListX.getAt 0 icons2 of
                        Nothing ->
                            ( m2, E.sendCmd <| Cmd.none )

                        Just firstIcon ->
                            update (SelectIcon rowId firstIcon) m2

        DownloadFilenameChanged s ->
            ( { model | downloadFileName = s }, E.sendCmd <| Cmd.none )

        UploadImages rowId ->
            ( model
            , E.sendCmd <|
                File.Select.files
                    [ "image/png", "image/jpg" ]
                    (UploadImagesSelected rowId)
            )

        UploadImagesSelected rowId file1 fileRest ->
            ( model
            , E.sendCmd <|
                Cmd.batch <|
                    List.map
                        (\file ->
                            Random.generate
                                (GotFileUuid rowId file)
                                Uuid.Barebones.uuidStringGenerator
                        )
                        (file1 :: fileRest)
            )

        GotFileUuid rowId file uuid ->
            case EL.findByPosition rowId model.rows of
                Nothing ->
                    ( model, E.sendCmd <| Cmd.none )

                Just row_i ->
                    let
                        row =
                            row_i.el

                        filesToUpload2 =
                            row.filesToUpload ++ [ { mFile = Just file, uuid = uuid } ]

                        row2 =
                            { row | filesToUpload = filesToUpload2 }

                        m2 =
                            { model | rows = EL.setAtPos row_i.pos row2 model.rows }
                    in
                    ( m2
                    , E.sendCmd <| Api.upload_screenshot file (UploadImageDone rowId)
                    )

        UploadImageDone rowId (Err e) ->
            let
                m3 =
                    case EL.findByPosition rowId model.rows of
                        Nothing ->
                            model

                        Just row_i ->
                            let
                                row =
                                    row_i.el

                                row2 =
                                    { row | filesToUpload = List.drop 1 row.filesToUpload }
                            in
                            { model | rows = EL.setAtPos rowId row2 model.rows }
            in
            ( m3
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження зображень" e
            )

        UploadImageDone rowId (Ok res) ->
            case EL.findByPosition rowId model.rows of
                Nothing ->
                    ( model, E.sendCmd <| Cmd.none )

                Just row_i ->
                    let
                        row =
                            row_i.el

                        imageUrls =
                            row.imageUrls ++ [ res.imageUrl ]

                        row2 =
                            { row
                                | imageUrls = imageUrls
                                , filesToUpload = List.drop 1 row.filesToUpload
                            }

                        m2 =
                            { model | rows = EL.setAtPos row_i.pos row2 model.rows }
                    in
                    ( m2
                    , E.sendCmd <| Cmd.none
                    )

        UploadPdfClicked ->
            ( model
            , E.sendCmd <|
                File.Select.file
                    [ "application/pdf" ]
                    UploadPdfSelected
            )

        UploadPdfSelected file ->
            ( { model | pdfToProcess = Just file }
            , E.sendCmd <| Api.upload_pdf file UploadPdfDone
            )

        UploadPdfDone (Err e) ->
            ( { model | pdfToProcess = Nothing }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження PDF" e
            )

        UploadPdfDone (Ok res) ->
            let
                newRows : List Row
                newRows =
                    MaybeX.values <|
                        List.indexedMap
                            (\i x ->
                                case ( String.toFloat x.lat, String.toFloat x.lng ) of
                                    ( Just lat, Just lng ) ->
                                        let
                                            empty =
                                                emptyRow i
                                        in
                                        Just
                                            { empty
                                                | content = x.content
                                                , imageUrls = x.imageUrls
                                                , coordinates = EL.fromList [ Coordinates.Wgs84LatLng { lat = lat, lng = lng } ]
                                                , title = x.title
                                                , icon = x.icon
                                                , selected = SelectedCoordIndex [ 0 ]
                                            }

                                    _ ->
                                        Nothing
                            )
                            res.rows
            in
            ( { model
                | pdfToProcess = Nothing
                , rows = EL.fromList (newRows ++ EL.toList model.rows)
              }
            , E.none
            )

        PasteImageFromClipboard rowId ->
            ( model
            , E.sendCmd <| Ports.importer_pasteImage { rowId = rowId }
            )

        PasteImageFromClipboardRes { rowId, contentsBase64 } ->
            case EL.findByPosition rowId model.rows of
                Nothing ->
                    ( model
                    , E.sendCmd <| Cmd.none
                    )

                Just row_i ->
                    case Base64.Decode.decode Base64.Decode.bytes contentsBase64 of
                        Err _ ->
                            ( model
                            , E.sendCmd <| Cmd.none
                            )

                        Ok bytes ->
                            let
                                row =
                                    row_i.el

                                emp =
                                    { uuid = "clipboard", mFile = Nothing }

                                filesToUpload2 =
                                    row.filesToUpload ++ [ emp ]

                                row2 =
                                    { row | filesToUpload = filesToUpload2 }
                            in
                            ( { model | rows = EL.setAtPos row_i.pos row2 model.rows }
                            , E.sendCmd <|
                                Api.upload_screenshot_bytes
                                    bytes
                                    (UploadImageDone rowId)
                            )

        DeleteImage rowId url ->
            case EL.findByPosition rowId model.rows of
                Nothing ->
                    ( model, E.sendCmd <| Cmd.none )

                Just row_i ->
                    let
                        row =
                            row_i.el

                        imageUrls2 =
                            List.filter (\x -> x /= url) row.imageUrls

                        row2 =
                            { row | imageUrls = imageUrls2 }
                    in
                    ( { model | rows = EL.setAtPos row_i.pos row2 model.rows }
                    , E.sendCmd <| Cmd.none
                    )

        SelIconMsg rowId imsg ->
            case EL.findByPosition rowId model.rows of
                Nothing ->
                    ( model
                    , E.sendCmd <| Cmd.none
                    )

                Just row_i ->
                    let
                        row =
                            row_i.el

                        ( mAction, imodel2, icmd ) =
                            Select.update imsg row.selState

                        row2 =
                            { row
                                | selState = imodel2
                                , icon =
                                    case mAction of
                                        Just (Select.Select x) ->
                                            x

                                        _ ->
                                            row.icon
                            }

                        m2 =
                            { model | rows = EL.setAtPos row_i.pos row2 model.rows }

                        ( m3, eff3 ) =
                            update (SelectIcon rowId row2.icon) m2
                    in
                    ( m3
                    , E.batch
                        [ E.sendCmd <|
                            Cmd.map (SelIconMsg rowId) icmd
                        , eff3
                        ]
                    )

        ApplyIconDownwards rowId ->
            let
                mfin =
                    case EL.findByPosition rowId model.rows of
                        Nothing ->
                            model

                        Just row_i ->
                            let
                                row =
                                    row_i.el

                                rows2 : EnumeratedList Row
                                rows2 =
                                    model.rows
                                        |> EL.map
                                            (\row_j ->
                                                if row_j.pos > row_i.pos then
                                                    let
                                                        el =
                                                            row_j.el
                                                    in
                                                    { el | icon = row.icon }

                                                else
                                                    row_j.el
                                            )
                            in
                            { model | rows = rows2 }
            in
            ( mfin, E.none )

        SelectAll rowId ->
            let
                mFin =
                    case EL.findByPosition rowId model.rows of
                        Nothing ->
                            model

                        Just row_i ->
                            let
                                row =
                                    row_i.el

                                row2 =
                                    { row
                                        | selected =
                                            SelectedCoordIndex
                                                (EL.map .pos row.coordinates |> EL.toList)
                                    }
                            in
                            { model | rows = EL.setAtPos rowId row2 model.rows }
            in
            ( mFin, E.none )



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.batch
        [ Ports.importer_usk2000ToWgs84Res GotUsk2000ToWgs84Res
        , Ports.importer_proposeIconsRes GotProposedIcons
        , Ports.importer_pasteImageRes PasteImageFromClipboardRes
        , Ports.importer_mgrsToWgs84Res GotMgrsToWgs84Res
        ]



-- VIEW


renderImpRow : Bool -> Dict String String -> EnumeratedItem Row -> Html Msg
renderImpRow isDark formErrors row_i =
    let
        rowId =
            row_i.pos

        row =
            row_i.el

        idPrefix =
            "render-imp-"

        idPrefixed =
            idPrefix ++ String.fromInt rowId

        renderCoordinate : SelectedCoord -> EnumeratedItem Coordinates -> Html Msg
        renderCoordinate selected x =
            let
                isSelected =
                    case selected of
                        SelectedCoordIndex ixs ->
                            List.member x.pos ixs

                        _ ->
                            False
            in
            div []
                [ Html.form [ class "form-check coord" ]
                    [ input
                        [ class "form-check-input"
                        , type_ "checkbox"
                        , name <| "radio-rowid-" ++ String.fromInt rowId
                        , id <| "radio-rowid-" ++ String.fromInt rowId ++ "-coord-" ++ String.fromInt x.pos
                        , onClick <| SelectCoordIndex rowId x.pos
                        , attribute "tabindex" "-1"
                        , Attr.checked isSelected
                        ]
                        []
                    , label
                        [ class "form-check-label text-nowrap"
                        , for <| "radio-rowid-" ++ String.fromInt rowId ++ "-coord-" ++ String.fromInt x.pos
                        ]
                        [ span [ class "badge text-bg-secondary me-1" ]
                            [ text <| String.fromInt (x.pos + 1)
                            ]
                        , text <| Coordinates.render x.el
                        ]
                    ]
                ]

        manualCoordInputBlock : SelectedCoord -> Html Msg
        manualCoordInputBlock selected =
            let
                isSelected =
                    case selected of
                        SelectedCoordManual ->
                            True

                        _ ->
                            False

                coordFieldErrorId =
                    "coord-manual--" ++ String.fromInt rowId
            in
            div
                [ class "font-monospace coord"
                ]
                [ input
                    ([ class "form-check-input me-1"
                     , type_ "radio"
                     , name <| "radio-rowid-" ++ String.fromInt rowId
                     , id <| "radio-rowid-" ++ String.fromInt rowId ++ "-coord-manual"
                     , onClick <| SelectCoordManual rowId
                     , attribute "tabindex" "-1"
                     , Attr.checked isSelected
                     ]
                        ++ (if isSelected then
                                [ isInvalidCls coordFieldErrorId formErrors ]

                            else
                                []
                           )
                    )
                    []
                , label
                    [ class "form-check-label"
                    , for <| "radio-rowid-" ++ String.fromInt rowId ++ "-coord-manual"
                    ]
                  <|
                    input
                        ([ class "form-control-sm manual-coord-input-block-inp font-monospace text-center p-0"
                         , classList
                            [ ( "border-primary border-5 text-primary fw-bold", isSelected )
                            ]
                         , style "width" "140px"
                         , type_ "text"
                         , attribute "tabindex" "-1"
                         , placeholder "ручний ввід"
                         , onClick <| SelectCoordManual rowId
                         ]
                            ++ (if isSelected then
                                    [ isInvalidCls coordFieldErrorId formErrors ]

                                else
                                    []
                               )
                        )
                        []
                        :: (if isSelected then
                                fieldError coordFieldErrorId formErrors

                            else
                                []
                           )
                ]

        renderProposedTitle title =
            div []
                [ span
                    [ class "text-action cursor-pointer proposed-title"
                    , onClick <| TitleChanged rowId title
                    ]
                    [ text title
                    ]
                ]

        renderElmSelect =
            let
                icon : Icon
                icon =
                    ListX.find (\x -> x.icon == row.icon) knownIcons
                        |> def genericIcon

                selItem : Maybe (Select.MenuItem String)
                selItem =
                    Just
                        (Select.basicMenuItem
                            { item = row.icon
                            , label = icon.name
                            }
                        )
            in
            div [ class "d-flex justify-content-center align-items-center" ]
                [ img
                    [ src <| "/img/google_earth_icons/" ++ icon.icon
                    , height 20
                    , class "pe-1"
                    ]
                    []
                , div [ class "flex-fill", style "font-size" ".8rem" ]
                    [ Html.map (SelIconMsg rowId)
                        (Styled.toUnstyled <|
                            Le.Block.Select.renderSelectSingle
                                selItem
                                row.selState
                                row.selMenu
                                "Не обрано"
                                (Le.Block.Select.defaultOptions isDark)
                        )
                    ]
                , div
                    [ class "ms-2 me-2 pointer"
                    , attribute "role" "button"
                    , attribute "data-bs-toggle" "dropdown"
                    , attribute "aria-expanded" "false"
                    ]
                    [ i [ class "bi bi-three-dots" ] [] ]
                , ul
                    [ class "dropdown-menu pt-1 pb-1"
                    , style "border-radius" "none"
                    ]
                    [ li [ style "font-size" ".8rem" ]
                        [ span
                            [ class "dropdown-item pointer"
                            , onClick <| ApplyIconDownwards row_i.pos
                            ]
                            [ text "Застосувати до всіх вниз"
                            ]
                        ]
                    ]
                ]

        renderProposedIcon icon =
            img
                [ height 20
                , class "icon-proposed m-1"
                , src <| "/img/google_earth_icons/" ++ icon
                , onClick <| SelectIcon rowId icon
                ]
                []

        rowExampleContent =
            case ListX.getAt rowId operatyvkaExamples of
                Nothing ->
                    exampleContent

                Just v ->
                    v

        renderRowImage url =
            div [ class "d-inline-block" ]
                [ div [ class "d-flex" ]
                    [ a
                        [ href url
                        , target "_blank"
                        ]
                        [ img
                            [ class "pe-2 mb-2"
                            , style "height" "50px"
                            , src url
                            ]
                            []
                        ]
                    , div []
                        [ button
                            [ type_ "button"
                            , class "btn btn-sm btn-outline-danger delete-image me-4"
                            , onClick <| DeleteImage rowId url
                            ]
                            [ i [ class "bi bi-trash" ] [] ]
                        ]
                    ]
                ]

        renderFilesToUpload _ =
            div [ class "pe-4 my-4 d-inline-block" ] [ Le.Block.Spinner.loadingSpinnerSm ]
    in
    div [ class "row mb-4 d-flex justify-content-start align-items-start" ]
        [ div [ style "width" "500px" ]
            [ div [ class "form-floating" ] <|
                textarea
                    [ class "form-control operatyvka-txtarea pt-2"
                    , placeholder "Вставте текст оперативки"
                    , id <| idPrefixed
                    , style "height" "140px"
                    , onInput (TextareaChanged rowId)
                    , value row.content
                    ]
                    []
                    :: (if row.content == "" then
                            [ label [ for idPrefixed ] [ text "оперативка" ] ]

                        else
                            []
                       )
                    ++ [ small
                            [ class "text-action cursor-pointer"
                            , onClick <| TextareaChanged rowId rowExampleContent
                            , attribute "tabindex" "-1"
                            ]
                            [ text "наприклад" ]
                       ]
            , div [ class "d-float align-middle my-2" ] <|
                List.map renderRowImage row.imageUrls
                    ++ List.map renderFilesToUpload row.filesToUpload
                    ++ [ button
                            [ class "btn btn-sm btn-outline-secondary me-2"
                            , type_ "button"
                            , onClick <| UploadImages rowId
                            ]
                            [ i [ class "bi bi-images" ] []
                            , text " додати знімки"
                            ]
                       , button
                            [ class "btn btn-sm btn-outline-secondary"
                            , type_ "button"
                            , onClick <| PasteImageFromClipboard rowId
                            ]
                            [ i [ class "bi bi-clipboard-check-fill" ] []
                            , text " вставити з буферу"
                            ]
                       ]
            ]
        , div
            [ class "justify-content-center p-2 pt-0"
            , style "width" "190px"
            ]
          <|
            -- [ ul [ class "list-unstyled" ] <|
            [ div [] <|
                EL.toList
                    (EL.map
                        (renderCoordinate row.selected)
                        row.coordinates
                    )
                    ++ (if EL.length row.coordinates > 1 then
                            [ div
                                [ class "font-monospace coord mb-2 text-center"
                                ]
                                [ span
                                    [ class "text-action cursor-pointer"
                                    , onClick <| SelectAll rowId
                                    ]
                                    [ text "всі" ]
                                ]
                            ]

                        else
                            []
                       )
                    ++ (if EL.isEmpty row.coordinates then
                            []

                        else
                            [ manualCoordInputBlock row.selected ]
                       )
            ]
        , div
            [ class "text-center justify-content-center p-2 pt-0"
            , style "width" "270px"
            ]
          <|
            if EL.isEmpty row.coordinates then
                []

            else
                let
                    renderProposedIcons =
                        div [ class "mt-2" ] <|
                            List.map renderProposedIcon row.proposedIcons
                in
                [ renderElmSelect
                , renderProposedIcons
                ]
        , div
            [ class "text-center justify-content-center p-2 pt-0"
            , style "width" "210px"
            ]
          <|
            if EL.isEmpty row.coordinates then
                []

            else
                input
                    [ class "form-control-sm title-block-inp text-center w-100"
                    , type_ "text"
                    , placeholder "заголовок"
                    , value row.title
                    , onInput <| TitleChanged rowId
                    ]
                    []
                    :: List.map renderProposedTitle row.proposedTitles
        , div
            [ class "text-center justify-content-center mb-4"
            , style "width" "80px"
            ]
          <|
            [ button
                [ type_ "button"
                , class "btn btn-outline-danger"
                , onClick <| DeleteRow rowId
                ]
                [ i [ class "bi bi-trash" ] [] ]
            ]
        ]


pdfUploadProgressDivs : Model -> List (Html Msg)
pdfUploadProgressDivs model =
    case model.pdfToProcess of
        Nothing ->
            []

        Just _ ->
            let
                checkmark =
                    i [ class "bi bi-check-circle-fill me-1 text-success" ] []
            in
            [ div [ class "row mb-4" ]
                [ div [ class "col-sm-3" ] []
                , div [ class "col-sm-6" ]
                    [ div [ class "bd-example-snippet bd-code-snippet" ]
                        [ div [ class "bd-example" ]
                            [ div [ class "progress" ]
                                [ div
                                    [ class "progress-bar progress-bar-striped progress-bar-animated"
                                    , attribute "role" "progressbar"
                                    , attribute "aria-valuenow" "75"
                                    , attribute "aria-valuemin" "0"
                                    , attribute "aria-valuemax" "100"
                                    , style "width" "75%"
                                    ]
                                    []
                                ]
                            ]
                        , div [ class "highlight" ]
                            [ ol []
                                [ li [] [ checkmark, text "завантажую файл на сервер" ]
                                , li [] [ checkmark, text "перетворюю на текст" ]
                                , li [] [ checkmark, text "виймаю точки" ]
                                , li [] [ strong [] [ text "вирізаю картинки" ] ]
                                , li [] [ text "готово" ]
                                ]
                            ]
                        ]
                    ]
                , div [ class "col-sm-3" ] []
                ]
            ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    let
        spinner =
            div
                [ class "spinner-border spinner-border-sm"
                , attribute "role" "status"
                ]
                [ span [ class "visually-hidden" ] [ text "Loading..." ] ]
    in
    { title = "імпортер"
    , body =
        [ -- , Views.navBarBpla dark mServerInfo user "importer"
          div [ class "w-5/6 mx-auto mt-4" ] <|
            p [ class "text-muted mb-4" ]
                [ text "окрім ручного вводу, ви також можете "
                , span
                    [ class "text-action cursor-pointer"
                    , onClick UploadPdfClicked
                    ]
                    [ text "підвантажити pdf-рапорт з програми \"Термінал\"" ]
                ]
                :: pdfUploadProgressDivs model
                ++ EL.toList (EL.map (renderImpRow dark model.formErrors) model.rows)
                ++ [ div [ class "d-inline-flex flex-wrap" ]
                        [ button
                            [ type_ "button"
                            , class "btn btn-secondary me-2 text-nowrap mb-2"
                            , onClick <| AddRow
                            ]
                            [ i [ class "bi bi-plus-circle" ] []
                            , text " ще"
                            ]
                        , input
                            [ class "form-control d-inline-block me-2 mb-2 filename-inp"
                            , type_ "text"
                            , onInput <| DownloadFilenameChanged
                            , value <| model.downloadFileName
                            ]
                            []
                        , button
                            [ type_ "button"
                            , class "btn btn-primary me-2 text-nowrap mb-2"
                            , onClick <| DownloadKmz
                            ]
                          <|
                            [ if not model.downloadKmzInProgress then
                                i [ class "bi bi-cloud-arrow-down" ] []

                              else
                                spinner
                            , text " скачати kmz"
                            ]
                        , button
                            [ type_ "button"
                            , class "btn btn-primary me-2 text-nowrap mb-2"
                            , onClick <| DownloadGeojson
                            ]
                          <|
                            [ if not model.downloadGeojsonInProgress then
                                i [ class "bi bi-cloud-arrow-down" ] []

                              else
                                spinner
                            , text " скачати geojson"
                            ]
                        ]
                   ]
        ]
    }



-- archive
-- symbols:
-- i [ class "bi bi-bullseye" ] [] ] small [] [ text " координати" ]
-- i [ class "bi bi-megaphone" ] [] [ text " заголовок" ]
-- small [] [ i [ class "bi bi-image" ] [] ] ] small [] [ text "іконка" ]


exampleContent =
    """19.00 Качкарівка
*В район (47.1305050, 33.7418280) сьогодні зайшла ОВТ ров. Склад та кількість не встановлено.
*в районі (52-20714 65-51696) знаходиться машина з антенами. Тип не встановлено."""


operatyvkaExamples =
    [ exampleContent
    , """№ 68839
село Милове, Бериславський район, Херсонська область, Україна
ОВТ (ОіВТ): 50
Особовий склад: 200
WGS84: 47.07227275466425, 33.61823252372279
SK42: 52-15579, 65-47075
MGRS: 36TWT4693813381
https://api.griselda.kyiv.ua/s/WTkUSqv8
Джерело: Світло
2022-10-11 17:15:00
-------
Станом на 11.10.2022 17:15 Милове, Херсонська область ОС (200 осіб) + ВТ (50 од. легка броня, колісна та ін.)
-------
"""
    , """№ 69093
село Милове, Бериславський район, Херсонська область, Україна
РСЗВ БМ-21 Град: 4
Танк: 9
ОВТ (ОіВТ): 7
Особовий склад: 300
WGS84: 47.068996067976, 33.63917305156
SK42: 52-15227, 65-48669
MGRS: 36TWT4853113030
https://api.griselda.kyiv.ua/s/xHIDCEri
Джерело: Світло
2022-10-12 21:59:00
-------
скупч.ОіВТ нп Милове, Херсонська обл.
300 од. ОС, скупч. ОіВТ
танки 9 од., БМ-21 "Град" - 4 од.
БМП/БТР - 7 од.

WGS-84: Ш=47.06899606851839, Д=33.63917305061088
MGRS: 36TWT 48531 13030
СК-42: X=5215227.19, Y=6548668.84
ширина 211 м., глибина 129 м.
отримано через Борода_інфо
-------"""
    , """21.25 Шляхове
*наметове містечко – (46.8785549, 33.4183013) - більше 100 осіб о/с ров.
*ОВТ ров, більше 20од, склад не встановлено – (46.8780489, 33.4189665)."""
    ]
