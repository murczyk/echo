module Shared.Components.Pager exposing
    ( Model
    , Msg(..)
    , update
    , view
    , getPageData, initWithPageSize, updateForNewTotalItems
    )

{-| A reusable pagination component for tables and lists.


# Model

@docs Model


# Messages

@docs Msg


# Initialization


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


{-| Initialize pagination with custom page size
-}
initWithPageSize : Int -> Model
initWithPageSize pageSize =
    { currentPage = 1
    , pageSize = pageSize
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
                , currentPage = 1 -- Reset to first page when changing page size
            }


{-| Get the current page data slice
-}
getPageData : Model -> List a -> List a
getPageData model data =
    let
        startIndex =
            (model.currentPage - 1) * model.pageSize
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
    if model.totalItems == 0 then
        text ""

    else
        let
            info =
                getPaginationInfo model

            pageNumbers =
                getPageNumbers model.currentPage info.totalPages
        in
        div [ Attr.class "pager-container" ]
            [ div [ Attr.class "pager-nav" ]
                [ div []
                    [ p [ Attr.class "pager-info" ]
                        [ text "Показано "
                        , span [ Attr.class "pager-info-highlight" ] [ text (String.fromInt info.startItem) ]
                        , text " до "
                        , span [ Attr.class "pager-info-highlight" ] [ text (String.fromInt info.endItem) ]
                        , text " з "
                        , span [ Attr.class "pager-info-highlight" ] [ text (String.fromInt model.totalItems) ]
                        , text " результатів"
                        ]
                    ]
                , div []
                    [ nav [ Attr.class "pager-nav-controls" ]
                        [ -- Previous button
                          button
                            [ Attr.class "pager-nav-button pager-nav-button-prev"
                            , onClick PreviousPage
                            , Attr.disabled (not info.hasPrevious)
                            ]
                            [ i [ Attr.class "bi bi-chevron-left" ] [] ]
                        , -- Page numbers
                          div [] (List.map viewPageNumber pageNumbers)
                        , -- Next button
                          button
                            [ Attr.class "pager-nav-button pager-nav-button-next"
                            , onClick NextPage
                            , Attr.disabled (not info.hasNext)
                            ]
                            [ i [ Attr.class "bi bi-chevron-right" ] [] ]
                        ]
                    ]
                ]
            ]


{-| View a single page number button
-}
viewPageNumber : { page : Int, isCurrent : Bool, isEllipsis : Bool } -> Html Msg
viewPageNumber { page, isCurrent, isEllipsis } =
    if isEllipsis then
        span [ Attr.class "pager-ellipsis" ]
            [ text "..." ]

    else
        button
            [ Attr.class <|
                "pager-page-button "
                    ++ (if isCurrent then
                            "pager-page-button-active"

                        else
                            "pager-page-button-default"
                       )
            , onClick (GoToPage page)
            ]
            [ text (String.fromInt page) ]


{-| Update pagination when total items count changes
This function recalculates totalItems and adjusts currentPage if needed
-}
updateForNewTotalItems : Int -> Model -> Model
updateForNewTotalItems newTotalItems model =
    let
        totalItems =
            newTotalItems

        maxPage =
            Basics.max 1 (ceiling (toFloat totalItems / toFloat model.pageSize))

        newCurrentPage =
            Basics.min model.currentPage maxPage
    in
    { model | totalItems = totalItems, currentPage = newCurrentPage }


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
