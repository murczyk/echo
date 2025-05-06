module Stubs exposing (..)

import Dict


callsignA =
    { callsign = "кабан"
    , comment = "нічого сказати"
    , id = 1
    , position = "солдат"
    , unit1 = ""
    , unit2 = ""
    , unitId = Just 1
    }


callsignB =
    { callsign = "абхаз"
    , comment = ""
    , id = 2
    , position = "солдат"
    , unit1 = ""
    , unit2 = ""
    , unitId = Just 22
    }


callsignC =
    { callsign = "чапля"
    , comment = "щось важливе"
    , id = 3
    , position = "сержант"
    , unit1 = ""
    , unit2 = ""
    , unitId = Just 3
    }


gdocCallsigns =
    Dict.fromList
        [ ( "кабан"
          , Just
                [ callsignA
                ]
          )
        , ( "нахун", Just [] )
        , ( "абхаз", Just [ callsignB ] )
        , ( "чапля", Just [ callsignC, { callsignC | unitId = Just 999, id = 999 } ] )
        ]


unitA =
    { active = True
    , army = ""
    , battalion = "БАТ1"
    , comment = ""
    , company = "РОТА1"
    , createdAt = 1712829002117
    , createdBy = "hiro"
    , division = ""
    , id = 1
    , name = "РОТА1 БАТ1 ПОЛК1"
    , regiment = "ПОЛК1"
    }


unitCConnectedToA =
    { active = True
    , army = ""
    , battalion = "БАТ1"
    , comment = ""
    , company = "РОТА1"
    , createdAt = 1712829002117
    , createdBy = "hiro"
    , division = ""
    , id = 3
    , name = "РОТА1 БАТ1 ПОЛК1"
    , regiment = "ПОЛК1"
    }


masterUnits =
    Dict.fromList
        [ ( 1
          , unitA
          )
        , ( 3, unitCConnectedToA )
        ]


networkA =
    { comment = ""
    , createdAt = 1711972701350
    , freq = "100.2000"
    , id = 1
    , kind = "УКХ"
    , location = "локація"
    , name = "назва"
    , unitIds = [ 1 ]
    }


networkB =
    { comment = ""
    , createdAt = 1711972701350
    , freq = "200.22"
    , id = 2
    , kind = "УКХ"
    , location = "локація 2"
    , name = "назва 2"
    , unitIds = [ 2 ]
    }


networks =
    Dict.fromList
        [ ( 1
          , Just
                networkA
          )
        ]
