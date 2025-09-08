module Core.Unit exposing (boldMasterUnit, isSameOrChildUnit, unitName)

import Bindings as B
import Dict exposing (Dict)
import Html exposing (..)
import Html.Attributes exposing (class)
import Utils.Utils as Utils


unitName : Dict Int B.Unit -> Int -> String
unitName masterUnits unitId =
    case Dict.get unitId masterUnits of
        Just unit ->
            unit.name

        Nothing ->
            "Невідомий підрозділ (id=" ++ String.fromInt unitId ++ ")"


{-| Перевіряє чи є unit1 та unit2 пов'язаними (той самий або один є дитячим для іншого)
Функція симетрична - порядок параметрів не має значення

    Приклади:
    - unit1: армія="1-ша", дивізія="", полк="", батальйон="", рота=""
    - unit2: армія="1-ша", дивізія="2-га", полк="", батальйон="", рота=""
    Результат: TRUE (unit2 є дитячим для unit1)

    - unit1: армія="1-ша", дивізія="2-га", полк="", батальйон="", рота=""
    - unit2: армія="1-ша", дивізія="2-га", полк="3-й", батальйон="", рота=""
    Результат: TRUE (unit2 є дитячим для unit1)

    - unit1: армія="1-ша", дивізія="2-га", полк="", батальйон="", рота=""
    - unit2: армія="1-ша", дивізія="3-тя", полк="", батальйон="", рота=""
    Результат: FALSE (різні дивізії)

-}
isSameOrChildUnit : B.Unit -> B.Unit -> Bool
isSameOrChildUnit unit1 unit2 =
    if unit1.id == unit2.id then
        True
        -- Точний збіг

    else
        -- Перевіряємо обидва напрямки - чи є unit2 дитячим для unit1 або unit1 дитячим для unit2
        isChildOf unit1 unit2 || isChildOf unit2 unit1


{-| Перевіряє чи є childUnit дитячим для parentUnit
Дитячий підрозділ має ті ж заповнені вищі рівні + додатково заповнені нижчі
-}
isChildOf : B.Unit -> B.Unit -> Bool
isChildOf parentUnit childUnit =
    let
        parentLevels =
            [ parentUnit.army
            , parentUnit.division
            , parentUnit.regiment
            , parentUnit.battalion
            , parentUnit.company
            ]

        childLevels =
            [ childUnit.army
            , childUnit.division
            , childUnit.regiment
            , childUnit.battalion
            , childUnit.company
            ]
    in
    isChildUnitByLevels parentLevels childLevels


{-| Перевіряє чи є childLevels дитячими для parentLevels
Простий алгоритм: дитина має починатися так само як батько + мати додаткову інформацію
-}
isChildUnitByLevels : List String -> List String -> Bool
isChildUnitByLevels parentLevels childLevels =
    let
        -- Збираємо пари (індекс, значення) для заповнених рівнів
        getFilledLevels levels =
            levels
                |> List.indexedMap (\i level -> ( i, level ))
                |> List.filter (\( _, level ) -> not (String.isEmpty level))

        parentFilled =
            getFilledLevels parentLevels

        childFilled =
            getFilledLevels childLevels

        -- Батько не може бути порожнім
        parentNotEmpty =
            not (List.isEmpty parentFilled)

        -- Дитина має мати більше заповнених рівнів
        childMoreSpecific =
            List.length childFilled > List.length parentFilled

        -- Всі заповнені рівні батька мають точно співпадати з початком дитини
        parentMatchesChildPrefix =
            let
                parentLength =
                    List.length parentFilled

                childPrefix =
                    List.take parentLength childFilled
            in
            parentFilled == childPrefix
    in
    parentNotEmpty && childMoreSpecific && parentMatchesChildPrefix


{-| Застаріла функція - замінена на isSameOrChildUnit
Залишена для зворотної сумісності, але помічена як deprecated
-}
sameRegiment : B.Unit -> B.Unit -> Bool
sameRegiment unit1 unit2 =
    if not (String.isEmpty unit1.regiment) && not (String.isEmpty unit2.regiment) then
        unit1.regiment == unit2.regiment && unit1.army == unit2.army && unit1.division == unit2.division

    else
        unit1.id == unit2.id


boldMasterUnit : Dict Int B.Unit -> B.Network -> Html msg
boldMasterUnit masterUnits network =
    div [ class "fw-semibold" ]
        [ div []
            [ -- text <| Utils.networkKindVHFMapping network.kind
              text " р/м "
            , text network.name
            , text " "
            , text <|
                String.join ", "
                    (List.map (unitName masterUnits)
                        (Maybe.withDefault [] network.unitIds)
                    )
            , text <|
                if network.location /= "" then
                    " (" ++ String.toUpper network.location ++ ")"

                else
                    ""
            ]
        ]
