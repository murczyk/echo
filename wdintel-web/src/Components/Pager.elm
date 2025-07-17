module Components.Pager exposing (Model, Msg(..), getPageData, init, update, view)

{-| A reusable pagination component for tables and lists.

# Model
@docs Model

# Messages
@docs Msg

# Initialization
@docs init

# Update
@docs update

# View
@docs view

-}

import Html exposing (..)
import Html.Attributes as Attr
import Html.Events exposing (..)


{-| Pagination model state
-}
type alias Model =
    { currentPage : Int
    , pageSize : Int
    , totalItems : Int
    }


{-| Pagination messages
-}
type Msg
    = GoToPage Int
    | NextPage
    | PreviousPage
    | ChangePageSize Int


{-| Initialize pagination with default values
-}
init : Model
init =
    { currentPage = 1
    , pageSize = 10
    , totalItems = 0
    }


{-| Update pagination state
-}
update : Msg -> Model -> Model
update msg model =
    case msg of
        GoToPage page ->
            { model | currentPage = max 1 page }

        NextPage ->
            let
                maxPage =
                    ceiling (toFloat model.totalItems / toFloat model.pageSize)
            in
            if model.currentPage < maxPage then
                { model | currentPage = model.currentPage + 1 }
            else
                model

        PreviousPage ->
            if model.currentPage > 1 then
                { model | currentPage = model.currentPage - 1 }
            else
                model

        ChangePageSize newSize ->
            { model 
            | pageSize = max 1 newSize
            , currentPage = 1  -- Reset to first page when changing page size
            }


{-| Get the current page data slice
-}
getPageData : Model -> List a -> List a
getPageData model data =
    let
        startIndex =
            (model.currentPage - 1) * model.pageSize

        endIndex =
            startIndex + model.pageSize
    in
    List.drop startIndex data
        |> List.take model.pageSize


{-| Get pagination info
-}
getPaginationInfo : Model -> { totalPages : Int, startItem : Int, endItem : Int, hasNext : Bool, hasPrevious : Bool }
getPaginationInfo model =
    let
        totalPages =
            ceiling (toFloat model.totalItems / toFloat model.pageSize)

        startItem =
            (model.currentPage - 1) * model.pageSize + 1

        endItem =
            min (model.currentPage * model.pageSize) model.totalItems

        hasNext =
            model.currentPage < totalPages

        hasPrevious =
            model.currentPage > 1
    in
    { totalPages = totalPages
    , startItem = startItem
    , endItem = endItem
    , hasNext = hasNext
    , hasPrevious = hasPrevious
    }


{-| Render the pagination component
-}
view : Model -> Html Msg
view model =
    let
        info =
            getPaginationInfo model

        pageNumbers =
            getPageNumbers model.currentPage info.totalPages
    in
    div [ Attr.class "flex items-center justify-between px-4 py-3 bg-white border-t border-gray-200 sm:px-6" ]
        [ div [ Attr.class "flex flex-1 justify-between sm:hidden" ]
            [ button
                [ Attr.class "relative inline-flex items-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                , onClick PreviousPage
                , Attr.disabled (not info.hasPrevious)
                ]
                [ text "Попередня" ]
            , button
                [ Attr.class "relative inline-flex items-center px-4 py-2 ml-3 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                , onClick NextPage
                , Attr.disabled (not info.hasNext)
                ]
                [ text "Наступна" ]
            ]
        , div [ Attr.class "hidden sm:flex sm:flex-1 sm:items-center sm:justify-between" ]
            [ div []
                [ p [ Attr.class "text-sm text-gray-700" ]
                    [ text "Показано "
                    , span [ Attr.class "font-medium" ] [ text (String.fromInt info.startItem) ]
                    , text " до "
                    , span [ Attr.class "font-medium" ] [ text (String.fromInt info.endItem) ]
                    , text " з "
                    , span [ Attr.class "font-medium" ] [ text (String.fromInt model.totalItems) ]
                    , text " результатів"
                    ]
                ]
            , div []
                [ nav [ Attr.class "isolate inline-flex -space-x-px rounded-md shadow-sm" ]
                    [ -- Previous button
                      button
                        [ Attr.class "relative inline-flex items-center rounded-l-md px-2 py-2 text-gray-400 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-20 focus:outline-offset-0 disabled:opacity-50 disabled:cursor-not-allowed"
                        , onClick PreviousPage
                        , Attr.disabled (not info.hasPrevious)
                        ]
                        [ span [ Attr.class "sr-only" ] [ text "Попередня" ]
                        , i [ Attr.class "bi bi-chevron-left" ] []
                        ]
                    , -- Page numbers
                      div [] (List.map viewPageNumber pageNumbers)
                    , -- Next button
                      button
                        [ Attr.class "relative inline-flex items-center rounded-r-md px-2 py-2 text-gray-400 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-20 focus:outline-offset-0 disabled:opacity-50 disabled:cursor-not-allowed"
                        , onClick NextPage
                        , Attr.disabled (not info.hasNext)
                        ]
                        [ span [ Attr.class "sr-only" ] [ text "Наступна" ]
                        , i [ Attr.class "bi bi-chevron-right" ] []
                        ]
                    ]
                ]
            ]
        ]


{-| View a single page number button
-}
viewPageNumber : { page : Int, isCurrent : Bool, isEllipsis : Bool } -> Html Msg
viewPageNumber { page, isCurrent, isEllipsis } =
    if isEllipsis then
        span [ Attr.class "relative inline-flex items-center px-4 py-2 text-sm font-semibold text-gray-700 ring-1 ring-inset ring-gray-300 focus:outline-offset-0" ]
            [ text "..." ]
    else
        button
            [ Attr.class <|
                "relative inline-flex items-center px-4 py-2 text-sm font-semibold focus:z-20 focus:outline-offset-0 "
                    ++ (if isCurrent then
                            "z-10 bg-[var(--color-secondary-light-active)] text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-secondary-light-active)]"
                        else
                            "text-gray-900 ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
                       )
            , onClick (GoToPage page)
            ]
            [ text (String.fromInt page) ]


{-| Get page numbers to display with ellipsis
-}
getPageNumbers : Int -> Int -> List { page : Int, isCurrent : Bool, isEllipsis : Bool }
getPageNumbers currentPage totalPages =
    if totalPages <= 7 then
        -- Show all pages if 7 or fewer
        List.range 1 totalPages
            |> List.map (\page -> { page = page, isCurrent = page == currentPage, isEllipsis = False })
    else
        -- Show current page with context and ellipsis
        let
            startPage =
                max 1 (currentPage - 2)

            endPage =
                min totalPages (currentPage + 2)

            pages =
                List.range startPage endPage
                    |> List.map (\page -> { page = page, isCurrent = page == currentPage, isEllipsis = False })

            withStartEllipsis =
                if startPage > 1 then
                    { page = 1, isCurrent = False, isEllipsis = False }
                        :: { page = 0, isCurrent = False, isEllipsis = True }
                        :: pages
                else
                    pages

            withEndEllipsis =
                if endPage < totalPages then
                    withStartEllipsis
                        ++ [ { page = 0, isCurrent = False, isEllipsis = True }
                           , { page = totalPages, isCurrent = False, isEllipsis = False }
                           ]
                else
                    withStartEllipsis
        in
        withEndEllipsis 