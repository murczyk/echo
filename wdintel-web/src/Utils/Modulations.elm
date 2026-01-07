module Utils.Modulations exposing (displayModulationName)


displayModulationName : String -> String
displayModulationName name =
    case name of
        "HYTERA" ->
            "DMR (HYTERA)"

        "HYTERA (256 bit)" ->
            "DMR (HYTERA 256 bit)"

        "TYT" ->
            "DMR (TYT)"

        "TYT (16 bit)" ->
            "DMR (TYT 16 bit)"

        "TYT (128 bit)" ->
            "DMR (TYT 128 bit)"

        _ ->
            name
