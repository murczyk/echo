module Stubs exposing (..)

import Dict


callsignA : { callsign : String, comment : String, id : number, position : String, unit1 : String, unit2 : String, unitId : Maybe number }
callsignA =
    { callsign = "кабан"
    , comment = "нічого сказати"
    , id = 1
    , position = "солдат"
    , unit1 = ""
    , unit2 = ""
    , unitId = Just 1
    }


callsignB : { callsign : String, comment : String, id : number, position : String, unit1 : String, unit2 : String, unitId : Maybe number }
callsignB =
    { callsign = "абхаз"
    , comment = ""
    , id = 2
    , position = "солдат"
    , unit1 = ""
    , unit2 = ""
    , unitId = Just 22
    }


callsignC : { callsign : String, comment : String, id : number, position : String, unit1 : String, unit2 : String, unitId : Maybe number }
callsignC =
    { callsign = "чапля"
    , comment = "щось важливе"
    , id = 3
    , position = "сержант"
    , unit1 = ""
    , unit2 = ""
    , unitId = Just 3
    }


gdocCallsigns : Dict.Dict String (Maybe (List { callsign : String, comment : String, id : number, position : String, unit1 : String, unit2 : String, unitId : Maybe number }))
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


unitA : { active : Bool, army : String, battalion : String, comment : String, company : String, createdAt : number, createdBy : String, division : String, id : number, name : String, regiment : String }
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


unitCConnectedToA : { active : Bool, army : String, battalion : String, comment : String, company : String, createdAt : number, createdBy : String, division : String, id : number, name : String, regiment : String }
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


masterUnits : Dict.Dict number { active : Bool, army : String, battalion : String, comment : String, company : String, createdAt : number, createdBy : String, division : String, id : number, name : String, regiment : String }
masterUnits =
    Dict.fromList
        [ ( 1
          , unitA
          )
        , ( 3, unitCConnectedToA )
        ]


networkA : { comment : String, createdAt : number, freq : String, id : number, kind : String, location : String, name : String, unitIds : List number }
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


networkB : { comment : String, createdAt : number, freq : String, id : number, kind : String, location : String, name : String, unitIds : List number }
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


networks : Dict.Dict number (Maybe { comment : String, createdAt : number, freq : String, id : number, kind : String, location : String, name : String, unitIds : List number })
networks =
    Dict.fromList
        [ ( 1
          , Just
                networkA
          )
        ]
