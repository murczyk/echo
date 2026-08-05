.configs.devices.nic_bridged.keys
| any(.[]; has($key))
