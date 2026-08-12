# Migrations

Initial PostgreSQL script to create the tables.

**MS SQL**:

```
-- Networks
Metadata (0): ResultMetadata { columns:
  [ Column { name: "Id", column_type: Int4 }
  , Column { name: "Name", column_type: NVarchar }
  , Column { name: "Description", column_type: NVarchar }
  , Column { name: "SortId", column_type: Int4 }
  , Column { name: "CreatedAt", column_type: Datetime2 }
  , Column { name: "CreatedBy", column_type: NVarchar }
  , Column { name: "UpdatedAt", column_type: Datetime2 }
  , Column { name: "UpdatedBy", column_type: NVarchar }
  , Column { name: "Credibility", column_type: Int4 }], result_index: 0 }

-- Groups
ResultMetadata {
    columns: [
        Column {
            name: "Id",
            column_type: Int4,
        },
        Column {
            name: "Mark",
            column_type: NVarchar,
        },
        Column {
            name: "SortId",
            column_type: Int4,
        },
    ],
    result_index: 0,
}

-- GroupNetwork
ResultMetadata {
    columns: [
        Column {
            name: "GroupsId",
            column_type: Int4,
        },
        Column {
            name: "NetworksId",
            column_type: Int4,
        },
    ],
    result_index: 0,
}

-- Frequencies
ResultMetadata {
    columns: [
        Column {
            name: "Id",
            column_type: Int4,
        },
        Column {
            name: "Value",
            column_type: Float8,
        },
        Column {
            name: "NetworkId",
            column_type: Int4,
        },
    ],
    result_index: 0,
}

-- Correspondents
ResultMetadata {
    columns: [
        Column {
            name: "Id",
            column_type: Int4,
        },
        Column {
            name: "CallSign",
            column_type: NVarchar,
        },
        Column {
            name: "Affiliation",
            column_type: NVarchar,
        },
        Column {
            name: "DetectionDate",
            column_type: Datetime2,
        },
        Column {
            name: "ConfirmationDate",
            column_type: Datetime2,
        },
        Column {
            name: "Description",
            column_type: NVarchar,
        },
        Column {
            name: "NetworkId",
            column_type: Int4,
        },
        Column {
            name: "ColorCode",
            column_type: NVarchar,
        },
        Column {
            name: "Credibility",
            column_type: Int4,
        },
    ],
    result_index: 0,
}

-- Attachments
ResultMetadata {
    columns: [
        Column {
            name: "Id",
            column_type: Int4,
        },
        Column {
            name: "FileName",
            column_type: NVarchar,
        },
        Column {
            name: "NetworkId",
            column_type: Int4,
        },
        Column {
            name: "Content",
            column_type: BigVarBin,
        },
    ],
    result_index: 0,
}

-- Templates
ResultMetadata {
    columns: [
        Column {
            name: "TableName",
            column_type: NVarchar,
        },
        Column {
            name: "ColumnName",
            column_type: NVarchar,
        },
        Column {
            name: "Value",
            column_type: NVarchar,
        },
    ],
    result_index: 0,
}
```

**PostgreSQL**:

```sql
create table etalonka_network (
  id serial primary key,
  name varchar(255) ,
  description text,
  sort_id int,
  created_at timestamp default now(),
  created_by varchar(255),
  updated_at timestamp default now(),
  updated_by varchar(255),
  credibility int
);

create table etalonka_group (
  id serial primary key,
  mark varchar(255),
  sort_id int
);

create table etalonka_group_network (
  groups_id int references etalonka_group(id),
  networks_id int references etalonka_network(id),
  primary key (groups_id, networks_id)
);

create table etalonka_frequency (
  id serial primary key,
  value float,
  network_id int references etalonka_network(id)
);

create table etalonka_correspondent (
  id serial primary key,
  call_sign varchar(255),
  affiliation varchar(255),
  detection_date timestamp,
  confirmation_date timestamp,
  description text,
  network_id int references etalonka_network(id),
  color_code varchar(255),
  credibility int
);

create table etalonka_attachment (
  id serial primary key,
  file_name varchar(255),
  network_id int references etalonka_network(id),
  content bytea
);

create table etalonka_template (
  table_name varchar(255),
  column_name varchar(255),
  value varchar(255)
);
```
