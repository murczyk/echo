from typing import cast

import numpy as np
import pandas as pd
import pyarrow as pa
from datasets import Dataset


def to_pandas_df(dataset: Dataset | pa.Table) -> pd.DataFrame:
    if isinstance(dataset, pa.Table):
        arrow_table = cast(pa.Table, dataset)
    else:
        arrow_table = cast(pa.Table, dataset.with_format("arrow")[:])  # pyright: ignore

    return arrow_table.to_pandas(types_mapper=pd.ArrowDtype)


def to_numpy_matrix(s: pd.Series, zero_copy_only=True) -> np.ndarray:
    array = pa.array(s)
    if isinstance(array, pa.ChunkedArray):
        array = array.combine_chunks()

    pa_flat = array.flatten()
    n_rows = len(s)
    n_cols = len(pa_flat) // n_rows

    np_flat = pa_flat.to_numpy(zero_copy_only=zero_copy_only)
    copy = not zero_copy_only
    return np_flat.reshape(n_rows, n_cols, copy=copy)


def to_pandas_series(pa_array: pa.Array, **kwargs) -> pd.Series:
    return pd.Series(pd.arrays.ArrowExtensionArray(pa_array), **kwargs)
