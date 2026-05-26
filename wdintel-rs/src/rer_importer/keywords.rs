use std::collections::BTreeSet;

use crate::organism::keyword_sets::default_words::default_keyword_words_set;

/// Legacy import/highlight path; canonical list lives in `organism_default_keyword_words.txt`.
pub fn get_keywords() -> BTreeSet<String> {
    default_keyword_words_set()
}
