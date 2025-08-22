module Le.Block.Unit exposing (boldMasterUnit, isSameOrChildUnit, unitName)

import Bindings as B
import Dict exposing (Dict)
import Html exposing (..)
import Html.Attributes exposing (class)
import Le.Utils as Utils


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
        True  -- Точний збіг
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


{-| Рекурсивно перевіряє чи є childLevels дитячими для parentLevels
    Дитячі рівні мають співпадати з батьківськими заповненими рівнями
-}
isChildUnitByLevels : List String -> List String -> Bool
isChildUnitByLevels parentLevels childLevels =
    case ( parentLevels, childLevels ) of
        ( [], [] ) ->
            False

        ( p :: ps, c :: cs ) ->
            if String.isEmpty p then
                -- Батьківський рівень порожній, дитячий може бути будь-яким
                isChildUnitByLevels ps cs
            else if p == c then
                -- Співпадають, перевіряємо наступний рівень
                isChildUnitByLevels ps cs
            else
                -- Не співпадають
                False

        ( [], _ ) ->
            -- Батьківські рівні закінчилися, дитячі можуть мати додаткові
            True

        ( _, [] ) ->
            -- Дитячі рівні закінчилися, але батьківські ще є
            False


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
