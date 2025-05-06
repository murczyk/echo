module ReviewConfig exposing (config)

{-| Do not rename the ReviewConfig module or the config function, because
`elm-review` will look for these.

To add packages that contain rules, add them to this review project using

    `elm install author/packagename`

when inside the directory containing this file.

-}

import Docs.ReviewAtDocs
import NoConfusingPrefixOperator
import NoDebug.Log
import NoDebug.TodoOrToString
import NoExposingEverything
import NoImportingEverything
import NoInconsistentAliases
import NoMissingTypeAnnotation
import NoMissingTypeAnnotationInLetIn
import NoMissingTypeExpose
import NoModuleOnExposedNames
import NoPrematureLetComputation
import NoSimpleLetBody
import NoUnoptimizedRecursion
import NoUnused.CustomTypeConstructorArgs
import NoUnused.CustomTypeConstructors
import NoUnused.Dependencies
import NoUnused.Exports
import NoUnused.Parameters
import NoUnused.Patterns
import NoUnused.Variables
import Review.Rule as Rule exposing (Rule)
import Simplify


config : List Rule
config =
    [ Docs.ReviewAtDocs.rule
    , NoConfusingPrefixOperator.rule
    , NoDebug.Log.rule
    , NoDebug.TodoOrToString.rule
        |> Rule.ignoreErrorsForDirectories [ "tests/" ]
    , NoExposingEverything.rule
        |> Rule.ignoreErrorsForFiles [ "src/Api.elm" ]
    , NoImportingEverything.rule []
    , NoMissingTypeAnnotation.rule

    --, NoMissingTypeAnnotationInLetIn.rule
    , NoMissingTypeExpose.rule
    , NoSimpleLetBody.rule
    , NoPrematureLetComputation.rule
    , NoUnused.CustomTypeConstructors.rule []
    , NoUnused.CustomTypeConstructorArgs.rule

    -- , NoUnused.Dependencies.rule
    , NoUnused.Exports.rule
        |> Rule.ignoreErrorsForFiles [ "src/Effect.elm", "src/EnumeratedList.elm" ]
    , NoUnused.Parameters.rule
    , NoUnused.Patterns.rule
    , NoUnused.Variables.rule
    , Simplify.rule Simplify.defaults
    , NoInconsistentAliases.config
        [ ( "Html.Attributes", "Attr" )
        , ( "Html.Events", "Events" )
        , ( "Html.Extra", "HtmlX" )
        , ( "Json.Decode", "Decode" )
        , ( "Json.Decode.Ancillary", "DecodeA" )
        , ( "Json.Decode.Extra", "DecodeX" )
        , ( "Json.Encode", "Encode" )
        , ( "Json.Encode.Extra", "EncodeX" )
        , ( "List.Extra", "ListX" )
        , ( "List.Nonempty", "NE" )
        , ( "List.Nonempty.Ancillary", "NEA" )
        , ( "Maybe.Extra", "MaybeX" )
        , ( "Random.Extra", "RandomX" )
        , ( "Result.Extra", "ResultX" )
        , ( "Svg.Attributes", "SvgAttr" )
        ]
        |> NoInconsistentAliases.noMissingAliases
        |> NoInconsistentAliases.rule
        |> Rule.ignoreErrorsForFiles [ "src/Shared.elm" ]
    , NoModuleOnExposedNames.rule
    , NoUnoptimizedRecursion.optOutWithComment "IGNORE TCO"
        |> NoUnoptimizedRecursion.rule
    ]
        |> List.map (Rule.ignoreErrorsForFiles [ "src/Bindings.elm" ])
        |> List.map (Rule.ignoreErrorsForDirectories [ "tests/", ".elm-land/" ])
