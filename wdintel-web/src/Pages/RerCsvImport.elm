module Pages.RerCsvImport exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Shared.Components.Button as Button
import Shared.Components.Console
import Shared.Components.Spinner
import Core.Types exposing (ApiError)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import File exposing (File)
import File.Select
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Layouts
import Page exposing (Page)
import Process
import Route exposing (Route)
import Shared
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
    { formErrors : Dict String String
    , console : Shared.Components.Console.Model
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , console = Shared.Components.Console.init
      }
    , E.none
    )


type Msg
    = UploadFileToConvert
    | UploadFileToConvertSelected File
    | UploadFileToConvertDone File (Result ApiError Int)
    | ConsoleMsg (Shared.Components.Console.Msg Msg)


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        UploadFileToConvert ->
            ( model
            , E.sendCmd <|
                File.Select.file
                    []
                    UploadFileToConvertSelected
            )

        UploadFileToConvertSelected file ->
            let
                m2 =
                    model
            in
            ( m2
            , E.sendCmd <|
                Api.rer_csv_import (UploadFileToConvertDone file) file
            )

        UploadFileToConvertDone _ (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "CSV Import Error" e )

        UploadFileToConvertDone _ (Ok taskId) ->
            ( model
            , E.sendCmd <| Task.perform (always (ConsoleMsg (Shared.Components.Console.TaskLaunched taskId))) (Process.sleep 0)
            )

        ConsoleMsg imsg ->
            Shared.Components.Console.update
                { msg = imsg
                , model = model.console
                , toModel = \console -> { model | console = console }
                , toMsg = ConsoleMsg
                , finalizer = E.none
                }


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


contentBlock : Model -> Html Msg
contentBlock model =
    div [ class "mt-2" ]
        [ h3 []
            [ text "Приймає CSV-файл з єдиною колонкою, що містить перехоплення виду:" ]
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
        , div [ class "text-center" ]
            [ Button.new { label = " додати csv", onClick = UploadFileToConvert }
                |> Button.withIcon
                    [ if not (Shared.Components.Console.isInProgress model.console) then
                        i [ class "bi bi-file-zip" ] []

                      else
                        Shared.Components.Spinner.loadingSpinnerSm
                    ]
                |> Button.view
            ]
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
