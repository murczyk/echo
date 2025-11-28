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

def patch_seaorm_03():
    file_path = 'wdintel-rs/src/entities/palitra.rs'

    # 1. Read the file content
    try:
        with open(file_path, 'r') as file:
            lines = file.readlines()
    except FileNotFoundError:
        print(f"Error: File not found at {file_path}")
        return

    # 2. Prepare the new content
    new_lines = []
    i = 0
    # The string we are looking for
    target_string = '"custom(\\"geometry\\")"'

    while i < len(lines):
        current_line = lines[i]

        # Check if the current line contains the target string
        if target_string in current_line:
            # Comment out the current line
            new_lines.append('// ' + current_line)
            print(f"Commented line {i+1}: {current_line.strip()}")

            # Move to the next line and comment it out as well
            i += 1
            if i < len(lines):
                next_line = lines[i]
                new_lines.append('// ' + next_line)
                print(f"Commented line {i+1}: {next_line.strip()}")

        else:
            # Keep the line as is
            new_lines.append(current_line)

        # Move to the next line in the original file (if not already moved by the 'if' block)
        i += 1

    # 3. Write the modified content back to the file
    try:
        with open(file_path, 'w') as file:
            file.writelines(new_lines)
        print(f"Patched: {file_path}")
    except Exception as e:
        print(f"Error writing to file: {e}")

if __name__ == '__main__':
    patch_seaorm_01()
    patch_seaorm_02()
    patch_seaorm_03()
