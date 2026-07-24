use super::DeviceActor;

pub(in crate::devices) fn device_actor(
    login: &str,
    roles: &[&str],
) -> DeviceActor {
    let roles = roles
        .iter()
        .map(|role| (*role).to_string())
        .collect::<Vec<_>>();
    DeviceActor::from_roles(login.to_string(), &roles)
}
