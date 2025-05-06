use fxhash::FxBuildHasher;
use levenshtein::levenshtein;
use std::collections::HashMap;

type FxHashMap<K, V> = HashMap<K, V, FxBuildHasher>;

#[derive(Default, Debug)]
struct TrieNode {
    is_end_of_word: bool,
    children: FxHashMap<char, TrieNode>,
}

#[derive(Default, Debug)]
pub struct Trie {
    root: TrieNode,
}

#[derive(Debug, Clone)]
pub struct Result {
    pub query: String,
    pub data: Vec<String>,
    pub distance: usize,
}

impl Trie {
    pub fn new() -> Self {
        Trie {
            root: TrieNode::default(),
        }
    }

    pub fn insert(&mut self, word: &str) {
        let mut current_node = &mut self.root;

        for c in word.chars() {
            current_node = current_node.children.entry(c).or_default();
        }
        current_node.is_end_of_word = true;
    }

    // max_distance arg is Levenshtein distance, if 0 - performs exact search
    pub fn find_matches(
        &self,
        word: &String,
        max_distance: Option<usize>,
    ) -> Result {
        let query = word.clone();
        let mut word = word.clone();
        let max_distance = max_distance.unwrap_or(0);
        let mut result = Result {
            distance: max_distance,
            query,
            data: vec![],
        };
        let not_found = result.clone();
        Self::try_find_match(
            &self.root,
            &mut word,
            &mut String::from(""),
            &mut String::from(""),
            &mut result,
        );
        if result.distance > max_distance {
            not_found
        } else {
            result
        }
    }

    fn try_find_match(
        current_node: &TrieNode,
        word: &mut String,
        prefix: &mut String,
        collector: &String,
        result: &mut Result,
    ) {
        let current_distance = levenshtein(&collector, &result.query);
        if !word.is_empty() {
            let c = word.remove(0);
            prefix.push(c);
        }
        if current_node.is_end_of_word {
            if current_distance < result.distance {
                result.data = vec![];
                result.distance = current_distance
            }
            if current_distance == result.distance {
                result.data.push(String::from(collector));
            }
        }

        for (symbol, node) in &current_node.children {
            let mut collector = collector.clone();
            collector.push(*symbol);
            Self::try_find_match(
                node,
                &mut word.clone(),
                &mut prefix.clone(),
                &collector,
                result,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    pub fn test1() {
        let dist = levenshtein("Zapo", "Kera");
        assert_eq!(4, dist);
    }

    #[test]
    pub fn test2() {
        let dist = levenshtein("Zapo", "Zapo");
        assert_eq!(0, dist);
    }

    #[test]
    pub fn test3() {
        let dist = levenshtein("Zapo", "Zara");
        assert_eq!(2, dist);
    }

    #[test]
    pub fn test1_cyr() {
        let dist = levenshtein("Запо", "Кера");
        assert_eq!(4, dist);
    }

    #[test]
    pub fn test3_cyr() {
        let dist = levenshtein("Запо", "Зара");
        assert_eq!(2, dist);
    }

    #[test]
    pub fn test_cities_iter() {
        assert_eq!(1, levenshtein("Запоріжя", "Запоріжжя"));
    }

    #[test]
    pub fn test_trie() {
        let dist1 = levenshtein("Запоріжя", "Заорілля");
        let dist2 = levenshtein("Запоріжя", "Запоріжжя");
        assert!(dist1 > dist2);

        let mut trie = Trie::new();

        trie.insert("Заорілля");
        trie.insert("Запоріжжя");

        let result = trie.find_matches(&String::from("Запоріжя"), None);
        assert_eq!(0, result.distance);
        assert!(result.data.is_empty());

        let result = trie.find_matches(&String::from("Запоріжя"), Some(1));
        assert_eq!(1, result.distance);
        assert_eq!(vec!["Запоріжжя"], result.data);

        let result = trie.find_matches(&String::from("Запоріжя"), Some(20));
        assert_eq!(1, result.distance);
        assert_eq!(vec!["Запоріжжя"], result.data);

        let result = trie.find_matches(&String::from("Запоріжя"), Some(0));
        assert!(result.data.is_empty());
    }

    #[test]
    pub fn test_trie2() {
        let mut trie = Trie::new();

        trie.insert("Степ");
        trie.insert("Степне");
        trie.insert("Степове");

        let result = trie.find_matches(&String::from("Стипне"), None);
        assert!(result.data.is_empty());

        let result = trie.find_matches(&String::from("Стипне"), Some(1));
        assert_eq!(1, result.distance);
        assert_eq!(vec!["Степне"], result.data);

        let result = trie.find_matches(&String::from("Степове"), None);
        assert_eq!(0, result.distance);
        assert_eq!(vec!["Степове"], result.data);
    }

    #[test]
    pub fn test_trie3() {
        let mut trie = Trie::new();
        trie.insert("БОР");
        trie.insert("ГОРІЛЕ");
        trie.insert("ЗОРІ");
        trie.insert("ЗОРЯ");
        trie.insert("ПОДІЛ");
        trie.insert("ПОДИ");
        trie.insert("ПОДОЛ");
        trie.insert("ХОРОЛ");
        let result = trie.find_matches(&String::from("ПОРТЛЕНД"), Some(2));
        assert_eq!(Vec::<String>::new(), result.data);
    }

    #[test]
    pub fn test_trie4() {
        let mut trie = Trie::new();
        trie.insert("Роботине");
        let result = trie.find_matches(&String::from("Робоботине"), Some(2));
        assert_eq!(vec!["Роботине"], result.data);
        let result = trie.find_matches(&String::from("Робоботине"), Some(0));
        assert!(result.data.is_empty());
        let result = trie.find_matches(&String::from("Робоботине"), None);
        assert!(result.data.is_empty());
    }
}
