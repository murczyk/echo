use sea_orm::ConnectionTrait;

#[allow(dead_code)]
pub(in crate::devices) struct MainDb<'db, C>
where
    C: ConnectionTrait,
{
    connection: &'db C,
}

impl<'db, C> MainDb<'db, C>
where
    C: ConnectionTrait,
{
    #[allow(dead_code)]
    pub(in crate::devices) fn new(connection: &'db C) -> Self {
        Self { connection }
    }

    #[allow(dead_code)]
    pub(in crate::devices) fn connection(&self) -> &C {
        self.connection
    }
}
