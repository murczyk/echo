use sea_orm::ConnectionTrait;

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
    pub(in crate::devices) fn new(connection: &'db C) -> Self {
        Self { connection }
    }

    pub(in crate::devices) fn connection(&self) -> &C {
        self.connection
    }
}
