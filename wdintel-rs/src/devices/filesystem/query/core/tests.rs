use super::*;

#[derive(Debug, PartialEq, Eq)]
struct Row(u8);

#[test]
fn page_finalizer_uses_returned_boundary_only_when_more_rows_exist() {
    let page = finalize_page(vec![Row(1), Row(2), Row(3)], 2, |row| row.0);
    assert_eq!(page.entries, vec![Row(1), Row(2)]);
    assert_eq!(page.next, Some(2));

    let page = finalize_page(vec![Row(1), Row(2)], 2, |row| row.0);
    assert_eq!(page.entries, vec![Row(1), Row(2)]);
    assert_eq!(page.next, None);
}
