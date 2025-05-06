#!/usr/bin/env python

# patch wdintel-rs/src/entities/sigint_inbox_item.rs replacing SignalMessage, with "SignalMessage," + contents of wdintel-rs/data/entities_patch_01.txt

import os
import sys
import re

def patch_seaorm_01():
    # Open the file to be patched
    with open('wdintel-rs/src/entities/sigint_inbox_item.rs', 'r') as file:
        data = file.read()
    # Open the patch file
    with open('wdintel-rs/data/entities_patch_01.txt', 'r') as file:
        patch = file.read()
    # Replace the string
    data = re.sub(r'SignalMessage,', 'SignalMessage,' + patch, data)
    # Write the file
    with open('wdintel-rs/src/entities/sigint_inbox_item.rs', 'w') as file:
        file.write(data)

def patch_seaorm_02():
    # Open the file to be patched
    with open('wdintel-rs/src/entities/signal_message.rs', 'r') as file:
        data = file.read()
    # Open the patch file
    with open('wdintel-rs/data/entities_patch_02.txt', 'r') as file:
        patch = file.read()
    # Replace the string
    data = re.sub(r'SigintInboxItem,', 'SigintInboxItem,' + patch, data)
    # Write the file
    with open('wdintel-rs/src/entities/signal_message.rs', 'w') as file:
        file.write(data)

if __name__ == '__main__':
    patch_seaorm_01()
    patch_seaorm_02()
