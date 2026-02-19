from dataclasses import dataclass
from typing import List

import numpy as np


@dataclass
class TextDetections:
    polys: List[np.ndarray]
    texts: List[str]
    scores: List[float]
    raw_texts: List[str] | None = None
