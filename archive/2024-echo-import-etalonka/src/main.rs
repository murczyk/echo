use clap::Parser;
use sqlx::postgres::PgPoolOptions;
use tiberius::QueryItem;
use tokio::net::TcpStream;
use tokio_stream::StreamExt;
use tokio_util::compat::Compat;
use tokio_util::compat::TokioAsyncWriteCompatExt;

#[derive(clap::Parser, Debug)]
pub struct Ps {
    /// localhost
    #[arg(long, value_enum)]
    pub mssql_host: String,
    /// sa
    #[arg(long, value_enum)]
    pub mssql_user: String,
    #[arg(long, value_enum)]
    pub mssql_password: String,
    /// 1401
    #[arg(long, value_enum)]
    pub mssql_port: u16,

    #[arg(long, value_enum)]
    pub pg_host: String,
    #[arg(long, value_enum)]
    pub pg_user: String,
    #[arg(long, value_enum)]
    pub pg_password: String,
    #[arg(long, value_enum)]
    pub pg_port: u16,
    #[arg(long, value_enum)]
    pub pg_db: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let ps = Ps::parse();

    let mut config = tiberius::Config::new();
    config.host(ps.mssql_host);
    config.port(ps.mssql_port);
    config.authentication(tiberius::AuthMethod::sql_server(
        ps.mssql_user,
        ps.mssql_password,
    ));
    config.trust_cert();
    config.database("NetworksDb");
    let tcp = TcpStream::connect(config.get_addr()).await?;
    tcp.set_nodelay(true)?;
    let mut client = tiberius::Client::connect(config, tcp.compat_write()).await?;

    let pg = PgPoolOptions::new()
        .max_connections(5)
        .connect(&format!(
            "postgres://{}:{}@{}:{}/{}",
            ps.pg_user, ps.pg_password, ps.pg_host, ps.pg_port, ps.pg_db
        ))
        .await?;

    println!("> Printing metadata for MS SQL");

    // print_metadata(&mut client, "Networks").await?;
    // print_metadata(&mut client, "Groups").await?;
    // print_metadata(&mut client, "GroupNetwork").await?;
    // print_metadata(&mut client, "Frequencies").await?;
    // print_metadata(&mut client, "Correspondents").await?;
    // print_metadata(&mut client, "Attachments").await?;
    // print_metadata(&mut client, "Templates").await?;

    println!("> Doing data cleanup...");
    sqlx::query("delete from etalonka_group_network")
        .execute(&pg)
        .await?;
    sqlx::query("delete from etalonka_group")
        .execute(&pg)
        .await?;
    sqlx::query("delete from etalonka_frequency")
        .execute(&pg)
        .await?;
    sqlx::query("delete from etalonka_correspondent")
        .execute(&pg)
        .await?;
    sqlx::query("delete from etalonka_attachment")
        .execute(&pg)
        .await?;
    sqlx::query("delete from etalonka_template")
        .execute(&pg)
        .await?;
    sqlx::query("delete from etalonka_network")
        .execute(&pg)
        .await?;
    println!("> Done data cleanup");
    println!("> Reading MS SQL into PostgreSQL now");

    // Networks
    println!("> Importing the Networks table");
    let select = tiberius::Query::new("SELECT * FROM Networks");
    {
        let mut count = 0;
        let mut stream = select.query(&mut client).await?;
        while let Some(item) = stream.try_next().await? {
            match item {
                QueryItem::Metadata(_meta) => {
                    // println!("Metadata ({}): {:?}", meta.result_index(), meta);
                }
                QueryItem::Row(row) => {
                    count += 1;
                    // println!("Row ({}): {:?}", row.result_index(), row);

                    sqlx::query(
                    "INSERT INTO etalonka_network (id, name, description, sort_id, created_at, created_by, updated_at, updated_by, credibility) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                )
                .bind(row.get::<i32, _>("Id"))
                .bind(row.get::<&str, _>("Name").as_deref())
                .bind(row.get::<&str, _>("Description").as_deref())
                .bind(row.get::<i32, _>("SortId"))
                .bind(row.get::<chrono::NaiveDateTime, _>("CreatedAt"))
                .bind(row.get::<&str, _>("CreatedBy").as_deref())
                .bind(row.get::<chrono::NaiveDateTime, _>("UpdatedAt"))
                .bind(row.get::<&str, _>("UpdatedBy").as_deref())
                .bind(row.get::<i32, _>("Credibility"))
                .execute(&pg)
                .await?;
                }
            }
        }
        println!("> Imported {} rows", count);
    }

    // Groups
    println!("> Importing the Groups table");
    let select = tiberius::Query::new("SELECT * FROM Groups");
    {
        let mut count = 0;
        let mut stream = select.query(&mut client).await?;
        while let Some(item) = stream.try_next().await? {
            match item {
                QueryItem::Metadata(_meta) => {
                    // println!("Metadata ({}): {:?}", meta.result_index(), meta);
                }
                QueryItem::Row(row) => {
                    count += 1;
                    // println!("Row ({}): {:?}", row.result_index(), row);

                    sqlx::query(
                        "INSERT INTO etalonka_group (id, mark, sort_id) VALUES ($1, $2, $3)",
                    )
                    .bind(row.get::<i32, _>("Id"))
                    .bind(row.get::<&str, _>("Mark").as_deref())
                    .bind(row.get::<i32, _>("SortId"))
                    .execute(&pg)
                    .await?;
                }
            }
        }
        println!("> Imported {} rows", count);
    }

    // GroupNetwork
    println!("> Importing the GroupNetwork table");
    let select = tiberius::Query::new("SELECT * FROM GroupNetwork");
    {
        let mut count = 0;
        let mut stream = select.query(&mut client).await?;
        while let Some(item) = stream.try_next().await? {
            match item {
                QueryItem::Metadata(_meta) => {
                    // println!("Metadata ({}): {:?}", meta.result_index(), meta);
                }
                QueryItem::Row(row) => {
                    count += 1;
                    // println!("Row ({}): {:?}", row.result_index(), row);

                    sqlx::query(
                    "INSERT INTO etalonka_group_network (groups_id, networks_id) VALUES ($1, $2)",
                )
                .bind(row.get::<i32, _>("GroupsId"))
                .bind(row.get::<i32, _>("NetworksId"))
                .execute(&pg)
                .await?;
                }
            }
        }
        println!("> Imported {} rows", count);
    }

    // Frequencies
    println!("> Importing the Frequencies table");
    let select = tiberius::Query::new("SELECT * FROM Frequencies");
    {
        let mut count = 0;
        let mut stream = select.query(&mut client).await?;
        while let Some(item) = stream.try_next().await? {
            match item {
                QueryItem::Metadata(_meta) => {
                    // println!("Metadata ({}): {:?}", meta.result_index(), meta);
                }
                QueryItem::Row(row) => {
                    count += 1;
                    // println!("Row ({}): {:?}", row.result_index(), row);

                    sqlx::query(
                    "INSERT INTO etalonka_frequency (id, value, network_id) VALUES ($1, $2, $3)",
                )
                .bind(row.get::<i32, _>("Id"))
                .bind(row.get::<f64, _>("Value"))
                .bind(row.get::<i32, _>("NetworkId"))
                .execute(&pg)
                .await?;
                }
            }
        }
        println!("> Imported {} rows", count);
    }

    // Correspondents
    println!("> Importing the Correspondents table");
    let select = tiberius::Query::new("SELECT * FROM Correspondents");
    {
        let mut count = 0;
        let mut stream = select.query(&mut client).await?;
        while let Some(item) = stream.try_next().await? {
            match item {
                QueryItem::Metadata(_meta) => {
                    // println!("Metadata ({}): {:?}", meta.result_index(), meta);
                }
                QueryItem::Row(row) => {
                    count += 1;
                    // println!("Row ({}): {:?}", row.result_index(), row);

                    sqlx::query(
                    "INSERT INTO etalonka_correspondent (id, call_sign, affiliation, detection_date, confirmation_date, description, network_id, color_code, credibility) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                )
                .bind(row.get::<i32, _>("Id"))
                .bind(row.get::<&str, _>("CallSign").as_deref())
                .bind(row.get::<&str, _>("Affiliation").as_deref())
                .bind(row.get::<chrono::NaiveDateTime, _>("DetectionDate"))
                .bind(row.get::<chrono::NaiveDateTime, _>("ConfirmationDate"))
                .bind(row.get::<&str, _>("Description").as_deref())
                .bind(row.get::<i32, _>("NetworkId"))
                .bind(row.get::<&str, _>("ColorCode").as_deref())
                .bind(row.get::<i32, _>("Credibility"))
                .execute(&pg)
                .await?;
                }
            }
        }
        println!("> Imported {} rows", count);
    }

    // Attachments
    println!("> Importing the Attachments table");
    let select = tiberius::Query::new("SELECT * FROM Attachments");
    {
        let mut count = 0;
        let mut stream = select.query(&mut client).await?;
        while let Some(item) = stream.try_next().await? {
            match item {
                QueryItem::Metadata(_meta) => {
                    // println!("Metadata ({}): {:?}", meta.result_index(), meta);
                }
                QueryItem::Row(row) => {
                    count += 1;
                    // println!("Row ({}): {:?}", row.result_index(), row);

                    sqlx::query(
                    "INSERT INTO etalonka_attachment (id, file_name, network_id, content) VALUES ($1, $2, $3, $4)",
                )
                .bind(row.get::<i32, _>("Id"))
                .bind(row.get::<&str, _>("FileName").as_deref())
                .bind(row.get::<i32, _>("NetworkId"))
                .bind(row.get::<&[u8], _>("Content"))
                .execute(&pg)
                .await?;
                }
            }
        }
        println!("> Imported {} rows", count);
    }

    // Templates
    println!("> Importing the Templates table");
    let select = tiberius::Query::new("SELECT * FROM Templates");
    {
        let mut count = 0;
        let mut stream = select.query(&mut client).await?;
        while let Some(item) = stream.try_next().await? {
            match item {
                QueryItem::Metadata(_meta) => {
                    // println!("Metadata ({}): {:?}", meta.result_index(), meta);
                }
                QueryItem::Row(row) => {
                    count += 1;
                    // println!("Row ({}): {:?}", row.result_index(), row);

                    sqlx::query(
                    "INSERT INTO etalonka_template (table_name, column_name, value) VALUES ($1, $2, $3)",
                )
                .bind(row.get::<&str, _>("TableName").as_deref())
                .bind(row.get::<&str, _>("ColumnName").as_deref())
                .bind(row.get::<&str, _>("Value").as_deref())
                .execute(&pg)
                .await?;
                }
            }
        }
        println!("> Imported {} rows", count);
    }

    Ok(())
}

pub async fn print_metadata(
    client: &mut tiberius::Client<Compat<TcpStream>>,
    name: &str,
) -> anyhow::Result<()> {
    let q = format!("SELECT * FROM {}", name);
    let query = tiberius::Query::new(&q);
    let mut stream = query.query(client).await?;
    while let Some(item) = stream.try_next().await? {
        match item {
            QueryItem::Metadata(meta) => {
                println!("Metadata for table {name}:\n{meta:#?}\n");
            }
            QueryItem::Row(_row) => {
                // println!("Row ({}): {:?}", row.result_index(), row);
            }
        }
    }
    Ok(())
}
