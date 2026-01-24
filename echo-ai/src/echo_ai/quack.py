from duckdb import DuckDBPyConnection, DuckDBPyRelation

from echo_ai import arrow


def define_rel_view(rel: DuckDBPyRelation, view_name: str):
    rel.to_view(view_name, replace=False)
    return view_name


def define_sql_view(con: DuckDBPyConnection, view_name: str, sql: str):
    rel = con.query(sql)
    rel.to_view(view_name, replace=False)
    return view_name


def to_df_arrow(rel: DuckDBPyRelation):
    table = rel.fetch_arrow_table()
    return arrow.to_pandas_df(table)
