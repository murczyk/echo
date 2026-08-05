.partitiontable.partitions[]?
| select(.node == $storage)
| [.start, .size, .type]
| @tsv
