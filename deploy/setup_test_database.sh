#!/usr/bin/env bash
set -euo pipefail

# Script to set up a branch-specific test database for CI
# Usage: ./setup_test_database.sh [branch_name]
# Options:
#   --cleanup: Drop all test databases matching pattern wd_test_*
#   --help: Show this help message

# Handle command line options
if [ $# -eq 1 ] && [ "$1" = "--cleanup" ]; then
    echo "Cleaning up all test databases..."
    PG_HOST="${PG_HOST:-localhost}"
    PG_PORT="${PG_PORT:-5432}"
    PG_USER="${PG_USER:-wd}"
    PG_PASSWORD="${PG_PASSWORD:-fee_-_-_-FnoeKFBeebu87bf}"
    export PGPASSWORD="$PG_PASSWORD"

    # Find and drop all test databases
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -t -c "SELECT datname FROM pg_database WHERE datname LIKE 'wd_test_%';" | while read -r db; do
        db=$(echo "$db" | xargs)  # trim whitespace
        if [ -n "$db" ]; then
            echo "Dropping database: $db"
            dropdb -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" "$db" || true
        fi
    done
    echo "Cleanup complete!"
    exit 0
fi

if [ $# -eq 1 ] && [ "$1" = "--help" ]; then
    echo "Usage: $0 [branch_name] [--cleanup] [--help]"
    echo "  branch_name: Name of the branch (optional, will auto-detect if not provided)"
    echo "  --cleanup: Remove all test databases matching pattern wd_test_*"
    echo "  --help: Show this help message"
    exit 0
fi

# Get the branch name - from argument, GitHub env, or git
if [ $# -eq 1 ]; then
    BRANCH_NAME="$1"
elif [ -n "${GITHUB_REF_NAME:-}" ]; then
    BRANCH_NAME="$GITHUB_REF_NAME"
else
    BRANCH_NAME=$(git rev-parse --abbrev-ref HEAD)
fi

# Sanitize branch name to be a valid database name
# Replace invalid characters with underscores and remove consecutive underscores
DB_NAME=$(echo "wd_test_${BRANCH_NAME}" | sed 's/[^a-zA-Z0-9_]/_/g' | sed 's/__*/_/g' | sed 's/_$//')

# Truncate to PostgreSQL identifier limit (63 characters)
if [ ${#DB_NAME} -gt 63 ]; then
    # Take first 59 chars and add a hash of the full name for uniqueness
    HASH=$(echo "$DB_NAME" | shasum -a 256 | cut -c1-4)
    DB_NAME="${DB_NAME:0:59}_$HASH"
fi

echo "Setting up test database: $DB_NAME"
echo "Branch: $BRANCH_NAME"

# Database connection parameters
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-wd}"
PG_PASSWORD="${PG_PASSWORD:-fee_-_-_-FnoeKFBeebu87bf}"

# Path to the base dump file
DUMP_FILE="$(dirname "$0")/wd_test-2025-08-17-07-43.pgrestore"

if [ ! -f "$DUMP_FILE" ]; then
    echo "Error: Dump file not found at $DUMP_FILE"
    exit 1
fi

# Set PGPASSWORD for non-interactive operations
export PGPASSWORD="$PG_PASSWORD"

echo "Checking if database $DB_NAME already exists..."
if psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -lqt | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
    echo "Database $DB_NAME already exists, dropping it..."
    dropdb -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" "$DB_NAME" || {
        echo "Warning: Failed to drop existing database $DB_NAME"
        exit 1
    }
fi

echo "Creating database $DB_NAME..."
createdb -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" "$DB_NAME"

echo "Restoring database from dump..."
pg_restore -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$DB_NAME" --verbose --clean --if-exists "$DUMP_FILE" || {
    echo "Error: Failed to restore database from dump"
    echo "Cleaning up failed database..."
    dropdb -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" "$DB_NAME" || true
    exit 1
}

echo "Database setup complete!"

# Export the database name for sourcing scripts
export DB_NAME

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    # Script is being executed directly, not sourced
    echo "Set TEST_DB_NAME environment variable to: $DB_NAME"
    echo ""
    echo "To use this database in tests, run:"
    echo "export TEST_DB_NAME=$DB_NAME"
    echo ""
    echo "Or in CI:"
    echo "TEST_DB_NAME=$DB_NAME cargo test"
fi
