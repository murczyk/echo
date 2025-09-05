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
    file_path = 'wdintel-rs/src/entities/sigint_unit.rs'
    # Open the file to be patched
    with open(file_path, 'r') as file:
        data = file.read()
    # Remove the attribute line that mentions "tsvector"
    data = re.sub(r'^.*tsvector.*\n?', '', data, flags=re.MULTILINE)

    # Remove the struct field line for `search_tsv`
    data = re.sub(r'^.*search_tsv.*\n?', '', data, flags=re.MULTILINE)
    # Write the modified content back to the file
    with open(file_path, 'w') as file:
        file.write(data)  

    print(f"Patched: {file_path}")

if __name__ == '__main__':
    patch_seaorm_01()
    patch_seaorm_02()
