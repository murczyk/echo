#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "Usage: $0 instance_name" >&2
  exit 1
fi

instance_name="$1"
xlsx_files="$(ssh "$instance_name" 'ls /etc/goi/data/xlsx')"

if [[ "$xlsx_files" == *readon* ]]; then
  echo "Skipping ${instance_name}: readonly XLSX files already exist."
  exit 0
fi

for file in frequencies.xlsx knowledge.xlsx; do
  if [[ ! -f "$file" ]]; then
    echo "Missing ${file} in the current directory." >&2
    exit 1
  fi
done

scp frequencies.xlsx "${instance_name}:/var/tmp/goi-frequencies.xlsx"
scp knowledge.xlsx "${instance_name}:/var/tmp/goi-knowledge.xlsx"

trap 'ssh "$instance_name" "sudo systemctl restart goi goi-echo-worker"' EXIT
ssh "$instance_name" 'sudo systemctl stop goi goi-echo-worker'
ssh "$instance_name" 'cd /etc/goi/data/xlsx && sudo cp -p frequencies.xlsx frequencies-readonly.xlsx && sudo cp -p knowledge.xlsx knowledge-readonly.xlsx'
ssh "$instance_name" 'sudo mv /var/tmp/goi-frequencies.xlsx /etc/goi/data/xlsx/frequencies.xlsx && sudo mv /var/tmp/goi-knowledge.xlsx /etc/goi/data/xlsx/knowledge.xlsx && sudo chown echo:echo /etc/goi/data/xlsx/frequencies.xlsx /etc/goi/data/xlsx/knowledge.xlsx'
trap - EXIT
ssh "$instance_name" 'sudo systemctl restart goi goi-echo-worker'
