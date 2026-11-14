module ToastTests exposing (tests)

import Expect
import Shared.Components.Toast as Toast
import Test exposing (Test, describe, test)
import Time
import Utils.EnumeratedList as EL


tests : Test
tests =
    describe "#4184 background update error toasts close themselves"
        [ test "closing one transient toast keeps the other toasts" <|
            \_ ->
                let
                    toasts =
                        Toast.init
                            |> addError Nothing "sticky"
                            |> addError (Just 10000) "transient"
                            |> addError (Just 10000) "transient 2"
                in
                case idOf "transient" toasts of
                    Just id ->
                        toasts
                            |> dismiss id
                            |> titles
                            |> Expect.equal [ "sticky", "transient 2" ]

                    Nothing ->
                        Expect.fail "transient toast was not added"
        , test "a timer firing after the user closed all toasts closes nothing new" <|
            \_ ->
                Toast.init
                    |> addError (Just 10000) "transient"
                    |> Toast.update Toast.CloseAll
                    |> Tuple.first
                    |> addError Nothing "later"
                    |> dismiss 0
                    |> titles
                    |> Expect.equal [ "later" ]
        ]


addError : Maybe Float -> String -> Toast.Model -> Toast.Model
addError dismissAfterMs title toasts =
    Toast.update
        (Toast.AddToastV2GotTime
            { level = Toast.Error
            , title = title
            , content = "Помилка мережі. Перевірте підключення до мережі"
            , dismissAfterMs = dismissAfterMs
            }
            (Time.millisToPosix 0)
        )
        toasts
        |> Tuple.first


dismiss : Int -> Toast.Model -> Toast.Model
dismiss id toasts =
    Toast.update (Toast.Dismiss id) toasts |> Tuple.first


titles : Toast.Model -> List String
titles toasts =
    toasts.toastsV2 |> EL.toList |> List.map .title


idOf : String -> Toast.Model -> Maybe Int
idOf title toasts =
    toasts.toastsV2
        |> EL.toList
        |> List.filter (\toast -> toast.title == title)
        |> List.map .id
        |> List.head
