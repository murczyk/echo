module Pages.Admin.RerCsvImport exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Core.Types exposing (ApiError)
import Effect as E exposing (Effect)
import File exposing (File)
import File.Select
import Html exposing (..)
import Html.Attributes exposing (..)
import Layouts
import Page exposing (Page)
import Process
import Route exposing (Route)
import Shared
import Shared.Components.Button as Button
import Shared.Components.Console
import Shared.Components.Spinner
import Shared.Components.Toast as Toast
import Shared.Model exposing (isDarkMode)
import Task
import Utils.Api.ErrorHandling
import View exposing (View)


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared _ =
    Page.new
        { init = init
        , update = update
        , view = view (isDarkMode shared.themeMode) shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "rer-csv-import"
        }


type alias Model =
    { selectedFile : Maybe File
    , preflight : PreflightState
    , importSubmitting : Bool
    , console : Shared.Components.Console.Model
    }


type PreflightState
    = PreflightNotRun
    | PreflightRunning
    | PreflightPassed PreflightSummary
    | PreflightFailed


type alias PreflightSummary =
    { total : Int
    , valid : Int
    , referenceTimestampMs : Int
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { selectedFile = Nothing
      , preflight = PreflightNotRun
      , importSubmitting = False
      , console = Shared.Components.Console.init
      }
    , E.none
    )


type Msg
    = ChooseFile
    | FileSelected File
    | PreflightData
    | PreflightDone (Result ApiError ( Bytes, B.RerCsvPreflightMetadata ))
    | ImportData
    | ImportDone (Result ApiError Int)
    | ConsoleMsg (Shared.Components.Console.Msg Msg)
    | SharedToastMsg Toast.Msg


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        ChooseFile ->
            ( model
            , E.sendCmd <|
                File.Select.file
                    []
                    FileSelected
            )

        FileSelected file ->
            ( { model
                | selectedFile = Just file
                , preflight = PreflightNotRun
              }
            , E.none
            )

        PreflightData ->
            if isBusy model then
                ( model, E.none )

            else
                case model.selectedFile of
                    Nothing ->
                        ( model, E.none )

                    Just file ->
                        ( { model | preflight = PreflightRunning }
                        , E.sendCmd <| Api.rer_csv_preflight PreflightDone file
                        )

        PreflightDone (Err error) ->
            ( { model | preflight = PreflightFailed }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка перевірки CSV" error
            )

        PreflightDone (Ok ( bytes, result )) ->
            let
                skipped =
                    result.total - result.valid

                summary =
                    { total = result.total
                    , valid = result.valid
                    , referenceTimestampMs = result.referenceTimestampMs
                    }

                effects =
                    if skipped > 0 then
                        [ E.downloadFile
                            (model.selectedFile
                                |> Maybe.map skippedMessagesFilename
                                |> Maybe.withDefault "skipped-messages.csv"
                            )
                            "text/csv;charset=utf-8"
                            bytes
                        , E.sendCmd <|
                            Toast.addWarning SharedToastMsg
                                (String.fromInt skipped
                                    ++ " повідомлень із "
                                    ++ String.fromInt result.total
                                    ++ " буде пропущено. Без коректної мітки часу: "
                                    ++ String.fromInt result.missingTimestamp
                                    ++ "; недопустимий розмір: "
                                    ++ String.fromInt result.invalidMessageSize
                                    ++ ". Усі пропущені приклади завантажено."
                                )
                        ]

                    else
                        []
            in
            ( { model | preflight = PreflightPassed summary }
            , E.batch effects
            )

        ImportData ->
            if isBusy model then
                ( model, E.none )

            else
                case ( model.selectedFile, model.preflight ) of
                    ( Just file, PreflightPassed summary ) ->
                        ( { model | importSubmitting = True }
                        , E.sendCmd <| Api.rer_csv_import True summary.referenceTimestampMs ImportDone file
                        )

                    _ ->
                        ( model, E.none )

        ImportDone (Err error) ->
            ( { model | importSubmitting = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка імпорту CSV" error
            )

        ImportDone (Ok taskId) ->
            ( model
            , E.sendCmd <| Task.perform (always (ConsoleMsg (Shared.Components.Console.TaskLaunched taskId))) (Process.sleep 0)
            )

        ConsoleMsg imsg ->
            Shared.Components.Console.update
                { msg = imsg
                , model = model.console
                , toModel =
                    \console ->
                        { model
                            | importSubmitting = False
                            , console = console
                        }
                , toMsg = ConsoleMsg
                , finalizer = E.none
                }

        SharedToastMsg toastMsg ->
            ( model, E.sendToastMsg toastMsg )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


skippedMessagesFilename : File -> String
skippedMessagesFilename file =
    let
        filename =
            File.name file

        stem =
            if String.endsWith ".csv" (String.toLower filename) then
                String.dropRight 4 filename

            else
                filename
    in
    stem ++ "-skipped-messages.csv"


isBusy : Model -> Bool
isBusy model =
    model.importSubmitting
        || isPreflightRunning model.preflight
        || Shared.Components.Console.isInProgress model.console


isPreflightRunning : PreflightState -> Bool
isPreflightRunning preflight =
    case preflight of
        PreflightRunning ->
            True

        _ ->
            False


preflightStatus : PreflightState -> Html Msg
preflightStatus preflight =
    case preflight of
        PreflightNotRun ->
            p [ class "text-muted" ]
                [ text "Після вибору файлу виконайте перевірку даних." ]

        PreflightRunning ->
            p [ class "flex items-center gap-2" ]
                [ Shared.Components.Spinner.loadingSpinnerSm
                , text "Перевіряємо повідомлення…"
                ]

        PreflightPassed result ->
            p [ class "text-success" ]
                [ text <|
                    "Перевірку завершено: до імпорту готово "
                        ++ String.fromInt result.valid
                        ++ " із "
                        ++ String.fromInt result.total
                        ++ " повідомлень."
                ]

        PreflightFailed ->
            p [ class "text-danger" ]
                [ text "Перевірка не завершилась. Виправте помилку та повторіть." ]


importControls : Model -> Html Msg
importControls model =
    let
        busy =
            isBusy model

        hasFile =
            Maybe.withDefault False (Maybe.map (always True) model.selectedFile)

        preflightPassed =
            case model.preflight of
                PreflightPassed _ ->
                    True

                _ ->
                    False
    in
    div [ class "mt-4 flex flex-wrap justify-center items-center gap-3" ]
        [ Button.new
            { label =
                if hasFile then
                    "Змінити CSV"

                else
                    "Вибрати CSV"
            , onClick = ChooseFile
            }
            |> Button.withIcon
                [ i [ class "bi bi-file-earmark-text" ] [] ]
            |> Button.withSecondary
            |> Button.withDisabled busy
            |> Button.view
        , Button.new { label = "Перевірити дані", onClick = PreflightData }
            |> Button.withIcon
                [ if isPreflightRunning model.preflight then
                    Shared.Components.Spinner.loadingSpinnerSm

                  else
                    i [ class "bi bi-check2-circle" ] []
                ]
            |> Button.withDisabled (not hasFile || busy)
            |> Button.view
        , Button.new { label = "Імпортувати", onClick = ImportData }
            |> Button.withIcon
                [ if model.importSubmitting || Shared.Components.Console.isInProgress model.console then
                    Shared.Components.Spinner.loadingSpinnerSm

                  else
                    i [ class "bi bi-upload" ] []
                ]
            |> Button.withDisabled (not preflightPassed || busy)
            |> Button.view
        ]


selectedFileStatus : Model -> Html Msg
selectedFileStatus model =
    div [ class "mt-3 text-center" ]
        [ case model.selectedFile of
            Nothing ->
                text "Файл не вибрано."

            Just file ->
                span []
                    [ text "Вибрано: "
                    , strong [] [ text (File.name file) ]
                    ]
        , preflightStatus model.preflight
        ]


contentBlock : Model -> Html Msg
contentBlock model =
    div [ class "mt-2" ]
        [ h3 []
            [ text "Історичний імпорт перехоплень із CSV" ]
        , p []
            [ text "Файл має містити одну колонку з одним перехопленням у кожному рядку. Дата й час беруться з тексту повідомлення та записуються як час його створення. Повідомлення без коректної мітки часу або недопустимого розміру буде пропущено." ]
        , p []
            [ text "Приклади підтримуваних повідомлень:" ]
        , div [ class "flex justify-between items-center gap-2" ]
            [ pre
                [ class "bg-card p-3 basis-1/2 overflow-x-auto"
                ]
                [ text "29.02.2024_15:50 F=446.1125(МГц) П54\nУКХ р/м 70 мсп 42 мсд 58 А (СХ НОВОПРОКОПІВКА)\nЛАВИНА\nСЕРБ\nОРЕНБУРГ\nВОЛГОГРАД\n- (1) СЕРБ я ЛАВИНА дай мне ОРЕНБУРГА на связь  \n- (2) ЛАВИНА ... да сейчас!\n- (1) ОРЕНБУРГ на приёме \n- (2) ОРЕНБУРГ вызови к себе пожалуйста МАРКА ИРТЫША  и САВУ  и до САВЫ собери всех к САВЕ я сейчас буду там , еду уже с этого населённика про который я тебе говорил  , сейчас переговорим !\n\n47.4067019, 35.8642446" ]
            , div [ class "ms-4 me-4 shrink-1" ] [ p [] [ text "або:" ] ]
            , pre
                [ class "bg-card p-3 basis-1/2 overflow-x-auto"
                ]
                [ text "Дата: 2024-03-02;\nЧас: 07:09;\nЧастота: 460.3250;\nПост: П325;\nЛокація: Авдіївка - Ласточкіне;\nПідрозділ: УКХ р/м 1 мсб 5 омсбр;\nХто: КАЛУГА;\nКому: БРЕСТ;\nТекст:\n- Калуга\n- Брест\n- Это кассеты по нам работают, не надо назад, вперед не останавливайтесь.Какие нахуй соседи по вам ложат, мы стреляем по лесополосе,вперед пошли пока ничего не летеит, быстрее. У нас БКне безгранично, идем пока держым.Вы чо сука охуели, почему вперед не идёте, Быстрее пошли пока нету воздействия, пока идем по всем фронтам, что один раз прилитело и вы обосрались, сейчас вон по 455 ебашут нахуй потому что там пацаны тоже идут. Пошли быстрее\n- СТарший я Брест я не понял в чем дело, мы только ебашим, прикрываем. Идем ребятки. Не по вам давайте быстрее и закрепляйтесь. Заходите закрепляйтесь молодци ребята, Ребята вы где уже в нашей полосе? Всё вы уже в блиндаже?сейчас подойду;\n\n48.1434076, 37.7146826"
                ]
            ]
        , importControls model
        , selectedFileStatus model
        , Shared.Components.Console.view model.console
        , div [ class "mb-4" ] []
        ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view _ _ _ model =
    { title = "Імпорт csv"
    , body =
        [ div [ class "w-4/5 mx-auto" ]
            [ div [ class "flex flex-col" ]
                [ div [ class "w-full" ]
                    [ contentBlock model ]
                ]
            ]
        ]
    }
