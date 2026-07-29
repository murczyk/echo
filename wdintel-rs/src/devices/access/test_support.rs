use super::DeviceActor;

pub(in crate::devices) fn device_actor(
    login: &str,
    organism_id: i64,
    roles: &[&str],
) -> DeviceActor {
    let roles = roles
        .iter()
        .map(|role| (*role).to_string())
        .collect::<Vec<_>>();
    DeviceActor::from_roles(login.to_string(), organism_id, &roles)
}
